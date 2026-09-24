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
import { subscribeToFeed } from "./ingest/feed.ts";
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
  suspendUser,
  UnknownUserError,
} from "./auth/users.ts";
import { INBOX_SOURCE_ID, isAudioMode, type User } from "./types.ts";
import { resolveOrigin } from "./origin.ts";
import type { AppContext, AppHandlers } from "./app.ts";
import { newArticleId, newEpisodeId } from "./ids.ts";
import type { Article, AudioMode } from "./types.ts";

export { IllegalTransitionError, NotAuthorizedError, UnknownUserError };

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
          const sourceTitle = episode.sourceId ? titles.get(episode.sourceId) : undefined;
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
    const modes = Array.isArray(body.modes)
      ? body.modes.filter((mode): mode is AudioMode =>
        typeof mode === "string" && isAudioMode(mode)
      )
      : undefined;

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
export function createCreateUserHandler(ctx: AppContext): AppHandlers["createUser"] {
  return async ({ req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    let body: { email?: unknown; displayName?: unknown; voice?: unknown } = {};
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
      return Response.json(
        {
          id: approved.id,
          email: approved.email,
          displayName: approved.displayName,
          status: approved.status,
          // The one deliberate exposure of a capability: the admin is the issuer.
          feedToken: approved.feedToken,
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
    createUser: createCreateUserHandler(ctx),
    suspendUser: createSuspendUserHandler(ctx),
  };
}
