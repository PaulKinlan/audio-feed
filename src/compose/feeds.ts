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
import { isAudioMode } from "../types.ts";
import { resolveOrigin } from "../origin.ts";
import { approvedUserFor, forbidden, loadUserByFeedToken, notFound } from "./shared.ts";
import type { AppContext, AppHandlers } from "../app.ts";
import type { ComposeDeps } from "./shared.ts";
import { type AudioMode, type CodeHandling, DEFAULT_CODE_HANDLING } from "../types.ts";

/**
 * Query the user's episodes and project them for the generator.
 *
 * The projection itself lives in `src/feed/adapter.ts` (audio-feed-b0a) because
 * that is the seam between two unrelated Episode types; this function only adds
 * the IO the projection deliberately does not do — asking the blob store how big
 * a file is when the record predates synthesis recording its size.
 */
async function publishableEpisodes(
  ctx: AppContext,
  userId: string,
  // The origin is resolved per request (audio-feed-0k3), so it is passed in
  // rather than read from config. Enclosure URLs built from a stale guess are
  // audio a podcast client cannot fetch.
  baseUrl: string,
  filter: { sourceId?: string; mode?: AudioMode } = {},
): Promise<FeedEpisode[]> {
  const episodes = await ctx.stores.metadata.listEpisodes({
    userId,
    sourceId: filter.sourceId,
    mode: filter.mode,
    limit: 200,
  });

  const publishable: FeedEpisode[] = [];
  for (const episode of episodes) {
    const needsSize = !episode.byteLength || episode.byteLength <= 0;
    const info = needsSize && episode.audioKey
      ? await ctx.stores.blobs.head(episode.audioKey)
      : null;
    const mapped = toFeedEpisode(episode, {
      publicBaseUrl: baseUrl,
      byteLength: info?.size,
    });
    if (mapped) publishable.push(mapped);
  }
  return publishable;
}
function feedResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      // Feeds are per-user capabilities: never let a shared cache hold one.
      "cache-control": "private, no-store",
    },
  });
}
/**
 * `GET /feed/:token/master.xml` — every ready episode for the token's user.
 *
 * Capped to the newest 200 episodes (industry standard RSS practice to avoid
 * multi-megabyte XML payloads and client timeouts). Unfiltered across sources;
 * query parameters (such as ?sourceId= or client tracking/cache-busters) are
 * deliberately ignored rather than rejected with 400 to preserve compatibility
 * with podcast aggregators and apps that append query parameters.
 *
 * Non-approved users get 403 even though the gate is about synthesis cost: their
 * feed would otherwise keep serving audio generated before a suspension.
 */
export function createMasterFeedHandler(ctx: AppContext): AppHandlers["masterFeed"] {
  return async ({ params, req }) => {
    const token = params.token ?? "";
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
  return async ({ params, req }) => {
    const token = params.token ?? "";
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

    let body: { feedUrl?: unknown; title?: unknown; modes?: unknown; codeHandling?: unknown } = {};
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      body = await req.json().catch(() => ({}));
    }
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
      return Response.json(
        { error: String((error as Error)?.message ?? error) },
        { status: 422, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
