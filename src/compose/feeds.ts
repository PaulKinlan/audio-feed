/**
 * compose/feeds — the feed routes and the storage → feed projection.
 *
 * The projection itself lives in `../feed/adapter.ts`; these handlers add the IO it
 * deliberately does not do (asking the blob store for a size the record predates).
 * audio-feed-bd0 moved this out of compose.ts with no behaviour change.
 */
import { articleUrl, IngestError } from "../ingest/url.ts";
import { subscribeToFeed } from "../ingest/feed.ts";
import { buildFeed, masterFeedUrl, sourceFeedUrl } from "../feed/rss.ts";
import type { ChannelMeta, Episode as FeedEpisode } from "../feed/types.ts";
import { toFeedEpisode } from "../feed/adapter.ts";
import { isAudioMode, isPublishable } from "../types.ts";
import { resolveOrigin } from "../origin.ts";
import { isSafeBlobKey } from "../storage/blob_key.ts";
import { screenErrorForLogging } from "../observability/error_screen.ts";
import { problem, readCappedJson } from "../http.ts";
import { approvedUserFor, forbidden, loadUserByFeedToken, notFound } from "./shared.ts";
import type { AppContext, AppHandlers } from "../app.ts";
import type { ComposeDeps } from "./shared.ts";
import { type AudioMode, type CodeHandling, DEFAULT_CODE_HANDLING } from "../types.ts";
import { extractClientIp, SlidingWindowRateLimiter } from "../auth/rate_limit.ts";

/**
 * Query the user's episodes and project them for the generator.
 *
 * The projection itself lives in `src/feed/adapter.ts` (audio-feed-b0a) because
 * that is the seam between two unrelated Episode types; this function only adds
 * the IO the projection deliberately does not do — asking the blob store how big
 * a file is when the record predates synthesis recording its size.
 */
/**
 * The RSS cap: at most this many PUBLISHABLE episodes per feed. Industry-standard practice is to
 * bound a feed so a client's first sync stays finite; audio-feed-2w8 is the reminder that the bound
 * has to count items the subscriber can actually play, not items listed on the way to filtering.
 */
/**
 * Rate limit per capability token for the unauthenticated feed routes (audio-feed-oxyp1).
 * Keyed on the token, not the IP: a capability URL is a bearer credential, so keying on
 * the token bounds one subscriber's aggregates across any podcast clients and aggregator IPs.
 * 60 requests per 5 minutes gives 1 request every 5 seconds on average — plenty of headroom
 * for podcast apps polling every 15-60 minutes and manual refresh bursts.
 */
export const FEED_TOKEN_RATE = { maxRequests: 60, windowMs: 5 * 60 * 1000 } as const;

/**
 * Rate limit per client IP for feed routes (audio-feed-oxyp1).
 * Bounds enumeration and spray attacks across capability tokens from one address before
 * any store lookup.
 */
export const FEED_IP_RATE = { maxRequests: 120, windowMs: 5 * 60 * 1000 } as const;

export const FEED_RATE_LIMIT = FEED_TOKEN_RATE;

export const FEED_TOKEN_WINDOW = "feed_token";
export const FEED_IP_WINDOW = "feed_ip";

/**
 * The RSS cap: at most this many PUBLISHABLE episodes per feed. Industry-standard practice is to
 * bound a feed so a client's first sync stays finite; audio-feed-2w8 is the reminder that the bound
 * has to count items the subscriber can actually play, not items listed on the way to filtering.
 */
export const FEED_EPISODE_CAP = 200;

/**
 * Upper bound on the number of `listEpisodePage` pages scanned per feed request (audio-feed-oxyp1).
 * Page size is `FEED_EPISODE_CAP` (200). With `FEED_MAX_PAGES = 3`, up to 600 scanned records are
 * examined to find up to 200 publishable episodes (allowing up to 400 non-publishable records intermingled).
 * An account with thousands of pending/failed episodes stops after 3 pages instead of paging indefinitely.
 */
export const FEED_MAX_PAGES = 3;

/**
 * Upper bound on outbound blob `head()` calls per feed request (audio-feed-oxyp1).
 * Synthesis writes `byteLength` on completion, so only legacy/un-backfilled records lack it.
 * Capped to 30: normal accounts (e.g. 30 legacy episodes) can have their sizes fully resolved,
 * while preventing outbound blob request amplification on accounts with unpopulated sizes.
 * Furthermore, `head()` is only called for publishable episodes, never for pending/failed ones.
 */
export const FEED_MAX_HEAD_CALLS = 30;

/**
 * Apply the feed rate limits, returning a 429 response or null if admitted.
 * Checked BEFORE any store work (no `loadUserByFeedToken` or episode traversal).
 */
export async function refuseFeedRead(
  ctx: AppContext,
  token: string,
  req: Request,
  remoteAddr?: string,
): Promise<Response | null> {
  const clientIp = extractClientIp(req, Boolean(ctx.config.trustProxyHeaders), remoteAddr);

  // 1. IP check: bounds enumeration across tokens from one address before any tenant read.
  const ipLimit = await new SlidingWindowRateLimiter(
    FEED_IP_RATE,
    ctx.stores.metadata,
    FEED_IP_WINDOW,
  ).check(clientIp);
  if (!ipLimit.allowed) {
    const refused = problem({
      status: 429,
      title: "too_many_requests",
      detail: "Too many feed requests from this client; retry later.",
    });
    refused.headers.set("retry-after", String(Math.max(1, Math.ceil(ipLimit.resetMs / 1000))));
    return refused;
  }

  // 2. Token check: bounds one subscriber's aggregate across apps/IPs before any tenant read.
  if (token) {
    const tokenLimit = await new SlidingWindowRateLimiter(
      FEED_TOKEN_RATE,
      ctx.stores.metadata,
      FEED_TOKEN_WINDOW,
    ).check(token);
    if (!tokenLimit.allowed) {
      const refused = problem({
        status: 429,
        title: "too_many_requests",
        detail: "Too many feed requests for this token; retry later.",
      });
      refused.headers.set("retry-after", String(Math.max(1, Math.ceil(tokenLimit.resetMs / 1000))));
      return refused;
    }
  }

  return null;
}

async function publishableEpisodes(
  ctx: AppContext,
  userId: string,
  // The origin is resolved per request (audio-feed-0k3), so it is passed in
  // rather than read from config. Enclosure URLs built from a stale guess are
  // audio a podcast client cannot fetch.
  baseUrl: string,
  filter: { sourceId?: string; mode?: AudioMode } = {},
): Promise<FeedEpisode[]> {
  // Page until `FEED_EPISODE_CAP` PUBLISHABLE episodes are found or `FEED_MAX_PAGES` is reached.
  // audio-feed-oxyp1 bounds the work per request:
  // 1. At most `FEED_MAX_PAGES` pages are scanned so an account with many pending/failed episodes
  //    cannot cause unbounded KV paging.
  // 2. Only publishable episodes are considered — pending/failed items never trigger blob head() calls.
  // 3. Blob head() calls for legacy records lacking byteLength are capped at `FEED_MAX_HEAD_CALLS`.
  //
  // `listEpisodePage`'s limit bounds the SCAN, not the matches, so a short page is not the end —
  // the loop continues while a cursor advances. The cursor guard is not decoration: a store that
  // hands back the same cursor would otherwise spin here forever.
  const publishable: FeedEpisode[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let headCalls = 0;

  do {
    pages++;
    const page = await ctx.stores.metadata.listEpisodePage({
      userId,
      sourceId: filter.sourceId,
      mode: filter.mode,
      limit: FEED_EPISODE_CAP,
      cursor,
    });
    for (const episode of page.episodes) {
      if (publishable.length >= FEED_EPISODE_CAP) break;
      // Drop unpublishable episodes immediately (audio-feed-oxyp1): unpublishable items
      // (pending/failed/synthesizing) must never trigger blob head() calls or count toward caps.
      if (!isPublishable(episode)) continue;

      const needsSize = (!episode.byteLength || episode.byteLength <= 0) &&
        headCalls < FEED_MAX_HEAD_CALLS;
      let byteLength: number | undefined;
      // A LEGACY metadata row can carry a key the store boundary refuses (a dot or empty segment —
      // the blobkeys guard made head() throw InvalidBlobKeyError before any network call). One
      // such row must not abort the whole feed: guard on the shared predicate, so a refused key
      // degrades to "size omitted" (length="0") exactly as it behaved before the guard existed,
      // while a genuine transport failure (`S3 head failed (status)`) still surfaces. This is
      // deliberately NOT a blanket catch — storage outages must stay loud.
      if (needsSize && episode.audioKey && isSafeBlobKey(episode.audioKey)) {
        headCalls++;
        const info = await ctx.stores.blobs.head(episode.audioKey);
        byteLength = info?.size;
      }
      const mapped = toFeedEpisode(episode, {
        publicBaseUrl: baseUrl,
        byteLength,
      });
      if (mapped) publishable.push(mapped);
    }
    cursor = page.cursor === cursor ? undefined : page.cursor;
  } while (cursor && publishable.length < FEED_EPISODE_CAP && pages < FEED_MAX_PAGES);

  return publishable;
}
function feedResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      // Feeds are per-user capabilities: never let a shared cache hold one.
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}
/**
 * `GET /feed/:token/master.xml` — every ready episode for the token's user.
 *
 * Capped to the newest `FEED_EPISODE_CAP` playable episodes (industry standard RSS practice to avoid
 * multi-megabyte XML payloads and client timeouts). Unfiltered across sources;
 * query parameters (such as ?sourceId= or client tracking/cache-busters) are
 * deliberately ignored rather than rejected with 400 to preserve compatibility
 * with podcast aggregators and apps that append query parameters.
 *
 * Non-approved users get 403 even though the gate is about synthesis cost: their
 * feed would otherwise keep serving audio generated before a suspension.
 */
export function createMasterFeedHandler(ctx: AppContext): AppHandlers["masterFeed"] {
  return async ({ params, req, remoteAddr }) => {
    const token = params.token ?? "";
    const refused = await refuseFeedRead(ctx, token, req, remoteAddr);
    if (refused) return refused;

    const user = await loadUserByFeedToken(ctx, token);
    if (!user) return notFound("Unknown feed");
    if (user.status !== "approved") return forbidden(`Feed unavailable (status: ${user.status})`);

    // Per request, not per process: an unconfigured deployment used to emit
    // localhost enclosures that no podcast client could fetch (audio-feed-0k3).
    const { baseUrl } = resolveOrigin(ctx.config, req);

    const episodes = await publishableEpisodes(ctx, user.id, baseUrl);
    const sources = await ctx.stores.metadata.listSources(user.id);
    const titles = new Map(sources.map((source) => [source.id, source.title]));

    // The channel carries the URL the router actually serves. Deriving it here
    // (rather than from rss.ts's origin-only helper) is what stopped the feed
    // advertising a 404 — the tww contract mismatch.
    const channel: ChannelMeta = {
      title: `${user.displayName} — Audio Feed`,
      selfUrl: baseUrl + masterFeedUrl(token),
      link: baseUrl,
      description: "All subscribed audio-feed episodes: direct reads and deep dives.",
      author: user.displayName,
      ownerEmail: user.email,
      language: "en",
      categories: ["News", "Technology"],
    };

    return feedResponse(
      buildFeed(channel, episodes, {
        titleFor: (episode: FeedEpisode) => {
          const sourceTitle = (episode.sourceId ? titles.get(episode.sourceId) : undefined) ??
            episode.sourceTitle;
          return sourceTitle ? `${sourceTitle}: ${episode.title}` : episode.title;
        },
      }),
    );
  };
}
/** `GET /feed/:token/:sourceId/:mode.xml` — one source, one presentation mode. */
export function createSourceFeedHandler(ctx: AppContext): AppHandlers["sourceFeed"] {
  return async ({ params, req, remoteAddr }) => {
    const token = params.token ?? "";
    const refused = await refuseFeedRead(ctx, token, req, remoteAddr);
    if (refused) return refused;

    const user = await loadUserByFeedToken(ctx, token);
    if (!user) return notFound("Unknown feed");
    if (user.status !== "approved") return forbidden(`Feed unavailable (status: ${user.status})`);

    const sourceId = params.sourceId ?? "";
    const mode: AudioMode = params.mode === "deepdive" ? "deepdive" : "direct";
    const source = await ctx.stores.metadata.getSource(user.id, sourceId);
    if (!source) return notFound(`Unknown source: ${sourceId}`);

    const { baseUrl } = resolveOrigin(ctx.config, req);

    const episodes = await publishableEpisodes(ctx, user.id, baseUrl, { sourceId, mode });
    const modeLabel = mode === "deepdive" ? "Deep Dive" : "Direct Read";
    const channel: ChannelMeta = {
      title: `${source.title} — ${modeLabel}`,
      selfUrl: baseUrl + sourceFeedUrl(token, sourceId, mode),
      link: source.siteUrl ?? baseUrl,
      description: `${modeLabel} audio of ${source.title} articles.`,
      author: source.title,
      ownerEmail: user.email,
      language: "en",
      categories: ["News", "Technology"],
    };

    return feedResponse(buildFeed(channel, episodes));
  };
}
/** `GET /api/sources` — the caller's subscribed feeds. */
export function createListSourcesHandler(ctx: AppContext): AppHandlers["listSources"] {
  return async ({ req }) => {
    const resolved = await approvedUserFor(ctx, req);
    if ("denied" in resolved) return resolved.denied;
    const sources = await ctx.stores.metadata.listSources(resolved.user.id);
    return Response.json(
      {
        sources: sources.map((source) => ({
          id: source.id,
          title: source.title,
          feedUrl: source.feedUrl,
          siteUrl: source.siteUrl,
          modes: source.modes,
          codeHandling: source.codeHandling ?? DEFAULT_CODE_HANDLING,
          lastPolledAt: source.lastPolledAt,
          // The per-source feed paths a subscriber would actually poll.
          feedPaths: source.feedUrl
            ? source.modes.map((mode) =>
              `/feed/${resolved.user.feedToken}/${source.id}/${mode}.xml`
            )
            : [],
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  };
}
/**
 * `POST /api/sources` — subscribe to an RSS/Atom feed.
 *
 * The initial poll runs inside this request so the user sees episodes appear
 * immediately rather than waiting for the next tick; it is capped (5 items) for
 * exactly that reason, and the interval poller picks up the rest.
 */
export function createCreateSourceHandler(
  ctx: AppContext,
  deps: ComposeDeps = {},
): AppHandlers["createSource"] {
  return async ({ req }) => {
    const resolved = await approvedUserFor(ctx, req);
    if ("denied" in resolved) return resolved.denied;

    const body = (await readCappedJson(req)) as {
      feedUrl?: unknown;
      title?: unknown;
      modes?: unknown;
      codeHandling?: unknown;
    };
    if (typeof body.feedUrl !== "string" || body.feedUrl.trim() === "") {
      return Response.json({ error: "A feed URL is required." }, {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    let feedUrl: string;
    try {
      feedUrl = articleUrl(body.feedUrl).href;
    } catch (error) {
      const status = error instanceof IngestError ? error.status : 400;
      return Response.json(
        { error: "That does not look like a fetchable feed URL." },
        { status, headers: { "cache-control": "no-store" } },
      );
    }
    let modes: AudioMode[] | undefined;
    if (Array.isArray(body.modes)) {
      modes = body.modes.filter((mode): mode is AudioMode =>
        typeof mode === "string" && isAudioMode(mode)
      );
      if (modes.length === 0) {
        return Response.json(
          { error: "At least one valid audio mode is required (direct or deepdive)." },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
    }

    const codeHandling: CodeHandling = body.codeHandling === "explain" ? "explain" : "skip";

    try {
      const { source, poll } = await subscribeToFeed(
        ctx,
        {
          userId: resolved.user.id,
          feedUrl,
          title: typeof body.title === "string" ? body.title : undefined,
          modes,
          codeHandling,
        },
        { transport: deps.feedTransport, fetchArticle: deps.fetchArticle, maxItems: 5 },
      );
      return Response.json(
        {
          source: {
            id: source.id,
            title: source.title,
            feedUrl: source.feedUrl,
            modes: source.modes,
            codeHandling: source.codeHandling ?? DEFAULT_CODE_HANDLING,
          },
          poll,
          // What the user subscribes to next.
          feedPaths: source.modes.map((mode) =>
            `/feed/${resolved.user.feedToken}/${source.id}/${mode}.xml`
          ),
        },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      // audio-feed-yj8cq: this response is read by the subscriber, so its message must be one
      // this codebase wrote. An IngestError detail is authored for the user ("That URL is not
      // an RSS or Atom feed.") and is shown as-is, exactly as src/routes/account_api.ts does.
      // Anything else is a store, provider or transport failure whose text can carry a store
      // key, a bucket path or a provider message, so it is screened into the log seam (the
      // same screen src/server.ts applies to an unhandled error) and answered with a fixed
      // detail instead of the throw.
      if (error instanceof IngestError) {
        return Response.json(
          { error: error.message },
          { status: error.status ?? 422, headers: { "cache-control": "no-store" } },
        );
      }
      const screened = screenErrorForLogging(error);
      console.warn(
        `[audio-feed] subscribe failed for user ${resolved.user.id}: ${screened.message}`,
      );
      return Response.json(
        { error: "Could not subscribe to that feed." },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
