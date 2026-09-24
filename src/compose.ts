/**
 * Composition root — the module that makes the product reachable.
 *
 * audio-feed-agl: every lane landed and was tested in isolation, but nothing
 * imported them, so on the real server `POST /api/ingest`, both feed routes and
 * `POST /api/admin/users/:id/approve` all answered 501. 173 unit tests passed
 * while not one feature was reachable over HTTP: the "it serves ≠ it works" trap.
 *
 * This module is the only place that knows about the lanes at once. It builds
 * the `AppHandlers` map and is called by `src/server.ts`.
 *
 * ─── Auth coupling ────────────────────────────────────────────────────────────
 * This file holds NO auth policy of its own. It calls `src/auth/users.ts`, which
 * is policy over the `MetadataStore` interface (audio-feed-ruw). The three local
 * adapters that used to live here — `loadUserByFeedToken`, `authorizeForSynthesis`
 * and `approveUserRecord` — were a deliberate bridge while the canonical `User`
 * was mid-flight, and have been collapsed onto `getUserByFeedToken`,
 * `assertAuthorizedForAudio` and `approveUser`.
 *
 * The storage→feed episode mapping is the `b0a` bead's subject; it lives here for
 * now because the RSS generator needs `pubDate` and `audioUrl` and the storage
 * record has `createdAt` and `audioKey`. This file does not claim b0a.
 */
import {
  articleUrl,
  createUrlIngestHandler,
  type ExtractedArticle,
  IngestError,
} from "./ingest/url.ts";
import {
  type FeedPollOptions,
  type PollDependencies,
  runFeedPollBatch,
  subscribeToFeed,
} from "./ingest/feed.ts";
import {
  createGeminiSynthesizer,
  runSynthesisBatch,
  type SynthesisWorkerOptions,
  type Synthesizer,
} from "./worker/synthesis.ts";
import { buildFeed, masterFeedUrl, sourceFeedUrl } from "./feed/rss.ts";
import type { ChannelMeta, Episode as FeedEpisode } from "./feed/types.ts";
import { toFeedEpisode } from "./feed/adapter.ts";
import {
  approveUser,
  assertAuthorizedForAudio,
  createUser,
  getUserByFeedToken,
  IllegalTransitionError,
  listUsers,
  NotAuthorizedError,
  requireAdminToken,
  rotateFeedToken,
  suspendUser,
  UnknownUserError,
} from "./auth/users.ts";
import { INBOX_SOURCE_ID, isAudioMode, type User } from "./types.ts";
import type { EpisodeQuery, MetadataStore } from "./storage/mod.ts";
import type { Episode } from "./types.ts";
import { resolveOrigin } from "./origin.ts";
import type { AppContext, AppHandlers } from "./app.ts";
import { newArticleId, newEpisodeId } from "./ids.ts";
import type { Article, AudioMode } from "./types.ts";

export { IllegalTransitionError, NotAuthorizedError, UnknownUserError };

/**
 * Walk a whole-catalogue episode scan one batch at a time (audio-feed-att).
 *
 * `listEpisodes` with an uncapped limit materialised every matching Episode into
 * one array — measured at ~0.33 KB/episode, so a 50k-episode source cost ~16 MB
 * per call and a single admin request made up to four of them. Reinstating a cap
 * is NOT the fix: audio-feed-c9q showed rows past a cap are silently skipped and
 * then orphaned unrecoverably. This pages the same scan and discards each batch,
 * so the peak working set is one batch while coverage stays complete.
 */
const EPISODE_SCAN_BATCH = 100;

async function* episodeScan(
  metadata: MetadataStore,
  query: Omit<EpisodeQuery, "limit">,
): AsyncGenerator<Episode[]> {
  let cursor: string | undefined;
  for (;;) {
    const page = await metadata.listEpisodePage({
      ...query,
      limit: EPISODE_SCAN_BATCH,
      cursor,
    });
    yield page.episodes;
    // A cursor that stops advancing means the scan is done. Without this a
    // misbehaving adapter spins here forever, and a hang is the worst refusal.
    if (!page.cursor || page.cursor === cursor) return;
    cursor = page.cursor;
  }
}

/** Count a scan without holding it: the counting sites never need the objects. */
async function countEpisodeScan(
  metadata: MetadataStore,
  query: Omit<EpisodeQuery, "limit">,
): Promise<number> {
  let total = 0;
  for await (const batch of episodeScan(metadata, query)) total += batch.length;
  return total;
}

/** Extraction of the capability token a podcast client can actually send. */
const TOKEN_HEADERS = ["x-feed-token", "x-user-token"] as const;

function presentedToken(request: Request): string | null {
  for (const header of TOKEN_HEADERS) {
    const value = request.headers.get(header)?.trim();
    if (value) return value;
  }
  const auth = request.headers.get("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return null;
}

/**
 * Resolve a feed token to its user.
 *
 * The user id is NOT accepted here, and that removal is the point.
 *
 * While the canonical `User` had no `feedToken`, this fell back to
 * `getUser(token)` so the id doubled as the feed capability. That was a
 * reasonable bridge and a real hole: user ids are not secret. They appear in
 * `/api/episodes?userId=`, in `/api/admin/users/:id/approve`, and in the 202
 * body this file returns from an ingest. Anyone who learned an id could read
 * that user's entire feed. Driven through the real dispatcher before the fix:
 *
 *   GET /feed/<feedToken>/master.xml -> 200
 *   GET /feed/<user id>/master.xml   -> 200   <- the bypass
 *
 * Now it is a single indexed lookup on the capability itself. That is also why
 * there is no constant-time compare any more: nothing is compared here. The
 * previous shape scanned every user per request, which made feed polling O(n)
 * and leaked user count through response time.
 */
function loadUserByFeedToken(ctx: AppContext, token: string): Promise<User | null> {
  return getUserByFeedToken(ctx.stores.metadata, token);
}

// ---------------------------------------------------------------------------
// storage → feed projection
// ---------------------------------------------------------------------------

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

const notFound = (message: string) =>
  Response.json({ error: message }, { status: 404, headers: { "cache-control": "no-store" } });
const forbidden = (message: string) =>
  Response.json({ error: message }, { status: 403, headers: { "cache-control": "no-store" } });

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

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

export interface ComposeDeps {
  /** Test seam: lets the acceptance check queue an article without real network. */
  fetchArticle?: (url: string, signal?: AbortSignal) => Promise<ExtractedArticle>;
  /** Test seam: fetches a feed document without real network (audio-feed-2e5). */
  feedTransport?: (url: URL, signal: AbortSignal) => Promise<Response>;
  /** Test seam: synthesizer for synthesis queue processing (audio-feed-dsn). */
  synthesizer?: Synthesizer;
  /** Test seam: feed poll options / dependencies (audio-feed-dsn). */
  feedPollOptions?: PollDependencies & FeedPollOptions;
  /** Test seam: synthesis worker options (audio-feed-dsn). */
  synthesisOptions?: SynthesisWorkerOptions;
}

/**
 * Resolve the caller's feed token to an APPROVED user, or return the response to
 * send. Shared by every user-scoped API route so the spend gate cannot be
 * forgotten on a new one.
 */
async function approvedUserFor(
  ctx: AppContext,
  req: Request,
): Promise<{ user: User } | { denied: Response }> {
  const token = presentedToken(req);
  if (!token) return { denied: forbidden("A feed token is required (x-feed-token).") };
  const user = await loadUserByFeedToken(ctx, token);
  if (!user) return { denied: forbidden("Unknown feed token.") };
  try {
    await assertAuthorizedForAudio(ctx.stores.metadata, user.id);
  } catch (error) {
    if (error instanceof NotAuthorizedError) {
      return { denied: forbidden("An approved user is required.") };
    }
    throw error;
  }
  return { user };
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

    let body: { feedUrl?: unknown; title?: unknown; modes?: unknown } = {};
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

    try {
      const { source, poll } = await subscribeToFeed(
        ctx,
        {
          userId: resolved.user.id,
          feedUrl,
          title: typeof body.title === "string" ? body.title : undefined,
          modes,
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

/** `POST /api/ingest` — queue an arbitrary article for synthesis. */
export function createIngestHandler(
  ctx: AppContext,
  deps: ComposeDeps = {},
): AppHandlers["ingest"] {
  const handler = createUrlIngestHandler({
    fetchArticle: deps.fetchArticle,
    // Identity is the feed token, the same capability the feed routes use.
    authorize: async (request) => {
      const token = presentedToken(request);
      if (!token) return forbidden("A feed token is required (x-feed-token).");
      const user = await loadUserByFeedToken(ctx, token);
      if (!user) return forbidden("Unknown feed token.");
      try {
        // Throwing gate first, so a forgotten boolean check cannot fail open.
        return await assertAuthorizedForAudio(ctx.stores.metadata, user.id);
      } catch (error) {
        if (error instanceof NotAuthorizedError) {
          return forbidden("An approved user is required.");
        }
        throw error;
      }
    },
    enqueue: async ({ article, mode, user }) => {
      // 202 means QUEUED, not synthesized: no worker exists yet, so this records
      // a pending job rather than pretending an episode is ready.
      const articleId = newArticleId();
      const episodeId = newEpisodeId();
      const now = new Date().toISOString();
      const record: Article = {
        id: articleId,
        userId: user.id,
        sourceId: INBOX_SOURCE_ID,
        url: article.url,
        title: article.title,
        author: article.author ?? undefined,
        publishedAt: article.publishedAt ?? undefined,
        content: article.body,
        excerpt: article.lead,
        ingestedAt: now,
      };
      await ctx.stores.metadata.putArticle(record);
      await ctx.stores.metadata.putEpisode({
        id: episodeId,
        userId: user.id,
        sourceId: INBOX_SOURCE_ID,
        sourceTitle: "Inbox",
        articleId,
        mode,
        status: "pending",
        title: article.title,
        description: article.lead,
        createdAt: now,
      });
      // Seed the inbox source on first use so the per-source feed route has a
      // source to resolve rather than 404ing on an empty inbox.
      if (!(await ctx.stores.metadata.getSource(user.id, INBOX_SOURCE_ID))) {
        await ctx.stores.metadata.putSource({
          id: INBOX_SOURCE_ID,
          userId: user.id,
          title: "Send to Audio",
          modes: ["direct", "deepdive"],
          voices: { direct: "Charon", deepdive: ["Kore", "Puck"] },
          createdAt: now,
        });
      }
      return { articleId, episodeId };
    },
  });
  // The ingest seam is a Router handler; the lane factory is a Request handler.
  return ({ req }) => handler(req);
}

/**
 * The admin gate for every `/api/admin/*` route.
 *
 * Returns a Response to send back when the caller may not proceed, or null when
 * they may. One helper rather than four copies, so a new admin route cannot be
 * added without the token check by accident — the failure mode this whole surface
 * exists to prevent (audio-feed-z2s).
 */
async function adminGate(ctx: AppContext, req: Request): Promise<Response | null> {
  const expected = ctx.config.adminToken;
  if (!expected) {
    // Fail closed and say why: an unconfigured server must not have open admin
    // endpoints at all.
    return forbidden("ADMIN_TOKEN is not configured on this server.");
  }
  const bearer = req.headers.get("authorization")?.toLowerCase().startsWith("bearer ")
    ? req.headers.get("authorization")!.slice(7).trim()
    : null;
  try {
    await requireAdminToken(req.headers.get("x-admin-token") ?? bearer, expected);
    return null;
  } catch {
    return Response.json({ error: "Unauthorized: admin token required" }, {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
}

/** `GET /api/admin/users` — the subscriber list for the console. */
export function createListUsersHandler(ctx: AppContext): AppHandlers["listUsers"] {
  return async ({ req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;
    const users = await listUsers(ctx.stores.metadata);
    return Response.json(
      {
        // No feedToken here: the list is rendered into a page, and a capability
        // that is not needed to render a row should not travel in its response.
        // The create response returns it once, because that is the moment the
        // admin has to hand it to the subscriber.
        users: users.map((user) => ({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          status: user.status,
          isAdmin: user.isAdmin,
          createdAt: user.createdAt,
          decidedAt: user.decidedAt,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  };
}

/**
 * `POST /api/admin/users` — create a subscriber, already approved.
 *
 * Creation and approval are one action on purpose: an admin typing a subscriber's
 * details has already decided to admit them, and requiring a second click for it
 * is how accounts end up created-but-unusable. The token is returned exactly here,
 * once, because this is the moment the admin has to pass it on.
 */
export function createCreateUserHandler(
  ctx: AppContext,
  deps: ComposeDeps = {},
): AppHandlers["createUser"] {
  return async ({ req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    let body: {
      email?: unknown;
      displayName?: unknown;
      voice?: unknown;
      feedUrl?: unknown;
    } = {};
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      body = await req.json().catch(() => ({}));
    }
    if (typeof body.email !== "string" || body.email.trim() === "") {
      return Response.json({ error: "An email address is required." }, {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }

    try {
      const created = await createUser(ctx.stores.metadata, {
        email: body.email,
        displayName: typeof body.displayName === "string" && body.displayName.trim()
          ? body.displayName.trim()
          : undefined,
        voice: typeof body.voice === "string" ? body.voice : undefined,
      });
      const approved = await approveUser(ctx.stores.metadata, created.id, "admin");

      let initialSource: {
        id: string;
        title: string;
        feedUrl: string;
        queued: number;
      } | undefined;

      if (typeof body.feedUrl === "string" && body.feedUrl.trim() !== "") {
        const validatedUrl = articleUrl(body.feedUrl.trim()).href;
        const { source, poll } = await subscribeToFeed(
          ctx,
          {
            userId: approved.id,
            feedUrl: validatedUrl,
          },
          { transport: deps.feedTransport, fetchArticle: deps.fetchArticle, maxItems: 5 },
        );
        initialSource = {
          id: source.id,
          title: source.title,
          feedUrl: source.feedUrl ?? validatedUrl,
          queued: poll.queued,
        };
      }

      return Response.json(
        {
          id: approved.id,
          email: approved.email,
          displayName: approved.displayName,
          status: approved.status,
          // The one deliberate exposure of a capability: the admin is the issuer.
          feedToken: approved.feedToken,
          initialSource,
        },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      // A duplicate email is the common case and deserves 409, not 500.
      const conflict = /already registered|taken/i.test(message);
      return Response.json({ error: message }, {
        status: conflict ? 409 : 400,
        headers: { "cache-control": "no-store" },
      });
    }
  };
}

/** `POST /api/admin/users/:id/suspend` — stop a subscriber's synthesis and feed. */
export function createSuspendUserHandler(ctx: AppContext): AppHandlers["suspendUser"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;
    try {
      const updated = await suspendUser(ctx.stores.metadata, params.id ?? "", "admin");
      return Response.json(
        { id: updated.id, status: updated.status, decidedAt: updated.decidedAt },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof UnknownUserError) return notFound(error.message);
      if (error instanceof IllegalTransitionError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
  };
}

/** `POST /api/admin/users/:id/approve` — admin queue, token-gated. */
export function createApproveUserHandler(ctx: AppContext): AppHandlers["approveUser"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    try {
      // Writes the status change and its ledger entry in one atomic commit, so
      // the audit trail cannot drift from the record it describes.
      const updated = await approveUser(ctx.stores.metadata, params.id ?? "", "admin");
      // Never echo a capability: the feed URL already carries the token, and a
      // `PublicUser` could not carry it even if this grew into a fuller body.
      return Response.json(
        { id: updated.id, status: updated.status, decidedAt: updated.decidedAt },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof UnknownUserError) return notFound(error.message);
      if (error instanceof IllegalTransitionError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
  };
}

/** `GET /api/admin/users/:id/sources` — list feeds for a subscriber. */
export function createAdminListUserSourcesHandler(
  ctx: AppContext,
): AppHandlers["adminListSources"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    const userId = params.id ?? "";
    const user = await ctx.stores.metadata.getUser(userId);
    if (!user) return notFound("Unknown user");

    const sources = await ctx.stores.metadata.listSources(userId);
    return Response.json(
      {
        feedToken: user.feedToken,
        sources: sources.map((source) => ({
          id: source.id,
          title: source.title,
          feedUrl: source.feedUrl,
          siteUrl: source.siteUrl,
          modes: source.modes,
          lastPolledAt: source.lastPolledAt,
          feedPaths: source.feedUrl
            ? source.modes.map((mode) => `/feed/${user.feedToken}/${source.id}/${mode}.xml`)
            : [],
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  };
}

/** `POST /api/admin/users/:id/sources` — subscribe a user to a feed as admin. */
export function createAdminCreateUserSourceHandler(
  ctx: AppContext,
  deps: ComposeDeps = {},
): AppHandlers["adminCreateSource"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    const userId = params.id ?? "";
    const user = await ctx.stores.metadata.getUser(userId);
    if (!user) return notFound("Unknown user");

    let body: { feedUrl?: unknown; title?: unknown; modes?: unknown } = {};
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

    try {
      const { source, poll } = await subscribeToFeed(
        ctx,
        {
          userId: user.id,
          feedUrl,
          title: typeof body.title === "string" ? body.title : undefined,
          modes,
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
          },
          poll,
          feedPaths: source.modes.map((mode) => `/feed/${user.feedToken}/${source.id}/${mode}.xml`),
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

/** `DELETE /api/admin/users/:id/sources/:sourceId` — remove a feed from a user. */
export function createAdminDeleteUserSourceHandler(
  ctx: AppContext,
): AppHandlers["adminDeleteSource"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    const userId = params.id ?? "";
    const sourceId = params.sourceId ?? "";
    const user = await ctx.stores.metadata.getUser(userId);
    if (!user) return notFound("Unknown user");

    const source = await ctx.stores.metadata.getSource(userId, sourceId);
    if (!source) return notFound("Unknown source");

    const url = new URL(req.url);
    const cascade = url.searchParams.get("cascade") === "true";

    const deletedEpisodeIds = new Set<string>();
    const cancelledPendingIds = new Set<string>();
    const deletedBlobKeys = new Set<string>();
    const failedBlobKeys = new Set<string>();
    let abortedEarly = false;

    if (cascade) {
      // Drain all episodes in batches until none remain (audio-feed-7ve, audio-feed-des)
      //
      // These two loops deliberately RE-READ from the start of the scan instead of
      // paging with a cursor, and that is not an oversight for whoever converts the
      // rest of this handler (audio-feed-att). The re-read is the incomplete-delete
      // guard: a failed `deleteEpisode` leaves the same batch in place, the
      // fingerprint repeats, and after two stalls the request answers 500
      // `incomplete` without deleting the source. A cursor advances past rows that
      // were never removed, so the scan simply ends and the handler reports success
      // over a source it has orphaned.
      //
      // Measured, not reasoned - and measured on each loop separately, because they
      // fail in different ways. Cursor-paging the NON-cascade loop reddens:
      //   audio-feed-des   progress guard      (answers 200 where it must answer 500)
      //   audio-feed-4qj   transient drain     (abandons rows after a transient failure)
      //   audio-feed-mf5   incomplete counting (reports no remaining episodes to count)
      // Cursor-paging the CASCADE loop fails differently depending on whether the
      // stall guard survives the conversion, and the two outcomes are bad in
      // opposite directions:
      //   guard RETAINED -> audio-feed-m04 answers 500 `incomplete` for a source it
      //     could fully drain. The cursor re-presents deleted rows, the fingerprint
      //     repeats, and the guard fires on real work. Reproduced by both
      //     audiofeed-astra and audiofeed-opus.
      //   guard DROPPED  -> audio-feed-37p and the audio-feed-mf5 distinct-blob-retry
      //     count: rows are visited twice, so blob accounting goes wrong. Measured by
      //     audiofeed-opus; audiofeed-astra saw these alongside the m04 refusal.
      // The trap is that "page this loop" reads as though the guard belongs to the
      // cursor, and dropping it fixes nothing - it trades a refusal for a false
      // success over orphaned episodes. `mf5` names two different tests, so claims are
      // listed per loop and stay checkable by mutating one loop. Two earlier forms were
      // wrong in different ways: one named only audio-feed-des, and the next called the
      // two runs unreconciled after review had in fact explained the difference - a
      // stale claim of its own, which is the class audio-feed-dzv exists to clear.
      // `listEpisodes` keeps its limit-bounds-matches meaning (audio-feed-m04) so this
      // re-read stays correct against a per-user index.
      let prevFingerprint: string | undefined = undefined;
      let consecutiveStalls = 0;

      while (true) {
        const batch = await ctx.stores.metadata.listEpisodes({
          userId,
          sourceId,
          limit: 100,
        });
        if (batch.length === 0) break;

        const fingerprint = batch.map((e) => e.id).join(",");
        if (fingerprint === prevFingerprint) {
          consecutiveStalls++;
          if (consecutiveStalls >= 2) {
            abortedEarly = true;
            break;
          }
        } else {
          consecutiveStalls = 0;
        }
        prevFingerprint = fingerprint;

        for (const episode of batch) {
          if (episode.audioKey && !deletedBlobKeys.has(episode.audioKey)) {
            try {
              await ctx.stores.blobs.delete(episode.audioKey);
              deletedBlobKeys.add(episode.audioKey);
              failedBlobKeys.delete(episode.audioKey);
            } catch {
              failedBlobKeys.add(episode.audioKey);
            }
          }
          const removed = await ctx.stores.metadata.deleteEpisode(userId, episode.id);
          if (removed) {
            deletedEpisodeIds.add(episode.id);
          }
        }
      }
    } else {
      // Drain all pending and synthesizing episodes in batches so no spend occurs (audio-feed-7ve, audio-feed-des)
      for (const status of ["pending", "synthesizing"] as const) {
        let prevFingerprint: string | undefined = undefined;
        let consecutiveStalls = 0;

        while (true) {
          const batch = await ctx.stores.metadata.listEpisodes({
            userId,
            sourceId,
            status,
            limit: 100,
          });
          if (batch.length === 0) break;

          const fingerprint = batch.map((e) => e.id).join(",");
          if (fingerprint === prevFingerprint) {
            consecutiveStalls++;
            if (consecutiveStalls >= 2) {
              abortedEarly = true;
              break;
            }
          } else {
            consecutiveStalls = 0;
          }
          prevFingerprint = fingerprint;

          for (const episode of batch) {
            const removed = await ctx.stores.metadata.deleteEpisode(userId, episode.id);
            if (removed) {
              cancelledPendingIds.add(episode.id);
            }
          }
        }
      }
    }

    if (abortedEarly) {
      const remainingEpisodes = cascade
        ? await countEpisodeScan(ctx.stores.metadata, { userId, sourceId })
        : await countEpisodeScan(ctx.stores.metadata, { userId, sourceId, status: "pending" }) +
          await countEpisodeScan(ctx.stores.metadata, {
            userId,
            sourceId,
            status: "synthesizing",
          });

      if (remainingEpisodes > 0) {
        return Response.json(
          {
            ok: false,
            error: "Source deletion incomplete: could not remove all episodes",
            incomplete: true,
            sourceId,
            remainingEpisodes,
            deletedEpisodes: deletedEpisodeIds.size,
            cancelledPending: cancelledPendingIds.size,
          },
          { status: 500, headers: { "cache-control": "no-store" } },
        );
      }
    }

    let retainedEpisodes = 0;
    if (!cascade) {
      // Backfill sourceTitle with CAS for legacy episodes being retained (audio-feed-rkf, audio-feed-hvn, audio-feed-c9q)
      for await (
        const batch of episodeScan(ctx.stores.metadata, {
          userId,
          sourceId,
          status: "ready",
        })
      ) {
        for (const episode of batch) {
          retainedEpisodes++;
          if (episode.sourceTitle) continue;
          const ok = await ctx.stores.metadata.backfillEpisodeSourceTitle(
            userId,
            episode.id,
            source.title,
          );
          if (!ok) {
            const current = await ctx.stores.metadata.getEpisode(userId, episode.id);
            if (current && !current.sourceTitle) {
              return Response.json(
                {
                  ok: false,
                  error:
                    "Source deletion incomplete: could not backfill sourceTitle on retained episode",
                  incomplete: true,
                  sourceId,
                },
                { status: 500, headers: { "cache-control": "no-store" } },
              );
            }
          }
        }
      }
    }

    await ctx.stores.metadata.deleteSource(userId, sourceId);
    return Response.json(
      cascade
        ? {
          ok: true,
          deleted: sourceId,
          cascaded: true,
          deletedEpisodes: deletedEpisodeIds.size,
          deletedBlobs: deletedBlobKeys.size,
          failedBlobs: failedBlobKeys.size,
        }
        : {
          ok: true,
          deleted: sourceId,
          cascaded: false,
          retainedEpisodes,
          cancelledPending: cancelledPendingIds.size,
        },
      { headers: { "cache-control": "no-store" } },
    );
  };
}

/** `POST /api/admin/users/:id/rotate-token` — rotate a user's feed token. */
export function createAdminRotateUserTokenHandler(
  ctx: AppContext,
): AppHandlers["adminRotateToken"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    const userId = params.id ?? "";
    try {
      const updated = await rotateFeedToken(ctx.stores.metadata, userId);
      return Response.json(
        {
          id: updated.id,
          feedToken: updated.feedToken,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof UnknownUserError) return notFound(error.message);
      throw error;
    }
  };
}

/** `POST /api/admin/poll-now` — trigger an immediate feed poll batch (audio-feed-dsn). */
export function createAdminPollNowHandler(
  ctx: AppContext,
  deps: ComposeDeps = {},
): AppHandlers["adminPollNow"] {
  return async ({ req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    const result = await runFeedPollBatch(ctx, {
      ...deps.feedPollOptions,
      transport: deps.feedTransport,
      fetchArticle: deps.fetchArticle,
    });

    return Response.json(
      {
        ok: true,
        polled: result.polled,
        queued: result.queued,
        failed: result.failed,
      },
      { headers: { "cache-control": "no-store" } },
    );
  };
}

/** `POST /api/admin/synthesize-now` — trigger an immediate synthesis batch (audio-feed-dsn). */
export function createAdminSynthesizeNowHandler(
  ctx: AppContext,
  deps: ComposeDeps = {},
): AppHandlers["adminSynthesizeNow"] {
  return async ({ req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    const synthesizer = deps.synthesizer ??
      (ctx.config.geminiApiKey ? createGeminiSynthesizer(ctx) : null);

    if (!synthesizer) {
      return Response.json(
        {
          ok: false,
          error: "Synthesis unavailable: GEMINI_API_KEY is not configured.",
          ready: 0,
          failed: 0,
          deferred: 0,
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }

    const result = await runSynthesisBatch(ctx, synthesizer, deps.synthesisOptions);
    return Response.json(
      {
        ok: true,
        ready: result.ready.length,
        failed: result.failed.length,
        deferred: result.deferred.length,
        skipped: result.skipped.length,
        superseded: result.superseded.length,
        considered: result.considered,
      },
      { headers: { "cache-control": "no-store" } },
    );
  };
}

/** Build every lane seam for a real server. Called by src/server.ts. */
export function createHandlers(ctx: AppContext, deps: ComposeDeps = {}): AppHandlers {
  return {
    masterFeed: createMasterFeedHandler(ctx),
    sourceFeed: createSourceFeedHandler(ctx),
    ingest: createIngestHandler(ctx, deps),
    approveUser: createApproveUserHandler(ctx),
    listSources: createListSourcesHandler(ctx),
    createSource: createCreateSourceHandler(ctx, deps),
    listUsers: createListUsersHandler(ctx),
    createUser: createCreateUserHandler(ctx, deps),
    suspendUser: createSuspendUserHandler(ctx),
    adminListSources: createAdminListUserSourcesHandler(ctx),
    adminCreateSource: createAdminCreateUserSourceHandler(ctx, deps),
    adminDeleteSource: createAdminDeleteUserSourceHandler(ctx),
    adminRotateToken: createAdminRotateUserTokenHandler(ctx),
    adminPollNow: createAdminPollNowHandler(ctx, deps),
    adminSynthesizeNow: createAdminSynthesizeNowHandler(ctx, deps),
  };
}
