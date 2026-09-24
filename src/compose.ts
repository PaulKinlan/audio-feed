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
 * ─── Where the adapters live ──────────────────────────────────────────────────
 * Three functions below (`loadUserByFeedToken`, `authorizeForSynthesis`,
 * `applyAdminDecision`) are the ONLY auth coupling in this file, deliberately
 * concentrated so audio-feed-ruw (which moves `src/auth/users.ts` onto the
 * `MetadataStore` interface and adds `getUserByFeedToken`) can be adopted by
 * rewriting them and nothing else.
 *
 * The storage→feed episode mapping is the `b0a` bead's subject; it lives here for
 * now because the RSS generator needs `pubDate` and `audioUrl` and the storage
 * record has `createdAt` and `audioKey`. This file does not claim b0a.
 */
import { createUrlIngestHandler, type ExtractedArticle } from "./ingest/url.ts";
import { buildFeed } from "./feed/rss.ts";
import type { ChannelMeta, Episode as FeedEpisode } from "./feed/types.ts";
import { requireAdminToken, tokensMatch } from "./auth/users.ts";
import { INBOX_SOURCE_ID, isPublishable, isSynthesisAuthorized, type User } from "./types.ts";
import type { AppContext, AppHandlers } from "./app.ts";
import { newArticleId, newEpisodeId } from "./ids.ts";
import type { Article, AudioMode, Episode } from "./types.ts";

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
 * Two shapes, because the canonical User is mid-flight (audio-feed-ruw adds
 * `feedToken` plus a `getUserByFeedToken` index): today the unguessable user id
 * IS the capability the feed path carries, and once `feedToken` exists this
 * prefers it. Either way the token is compared in constant time.
 */
async function loadUserByFeedToken(ctx: AppContext, token: string): Promise<User | null> {
  if (!token) return null;
  const direct = await ctx.stores.metadata.getUser(token);
  if (direct) return direct;
  for (const user of await ctx.stores.metadata.listUsers()) {
    const candidate = (user as { feedToken?: string }).feedToken;
    if (typeof candidate === "string" && candidate.length > 0) {
      if (await tokensMatch(token, candidate)) return user;
    }
  }
  return null;
}

/**
 * The paid-synthesis gate.
 *
 * Fails closed and throws rather than returning a boolean, so a caller that
 * forgets the `!` still cannot spend money. (audio-feed-ruw will supply
 * `assertAuthorizedForAudio(store, userId)`; this is the same decision.)
 */
async function authorizeForSynthesis(ctx: AppContext, userId: string): Promise<User> {
  const user = await ctx.stores.metadata.getUser(userId);
  if (!user || !isSynthesisAuthorized(user)) {
    throw new NotApprovedError(userId, user?.status ?? "unknown");
  }
  return user;
}

export class NotApprovedError extends Error {
  constructor(readonly userId: string, readonly status: string) {
    super(`Audio generation is not authorized for user ${userId} (status: ${status})`);
    this.name = "NotApprovedError";
  }
}

/** Display name across model generations: `name` today, `displayName` once ruw lands. */
function displayNameOf(user: User): string {
  const named = user as { name?: string; displayName?: string };
  return named.displayName ?? named.name ?? user.email;
}

/**
 * Apply an admin approval.
 *
 * The route only ever approves, and today's storage model has three states with
 * no `rejected`, so the legal precedents are `pending` and `suspended` (a
 * suspended user may be re-admitted). audio-feed-ruw brings the four-state union
 * and a ledger; this is the one place to extend.
 */
async function approveUserRecord(
  ctx: AppContext,
  userId: string,
  adminId: string,
): Promise<User> {
  const user = await ctx.stores.metadata.getUser(userId);
  if (!user) throw new UnknownUserError(userId);
  if (user.status === "approved") return user; // idempotent
  if (user.status !== "pending" && user.status !== "suspended") {
    throw new IllegalTransitionError(userId, user.status, "approved");
  }
  const now = new Date().toISOString();
  const updated: User = {
    ...user,
    status: "approved",
    approvedAt: now,
    approvedBy: adminId,
  };
  await ctx.stores.metadata.putUser(updated);
  return updated;
}

export class UnknownUserError extends Error {
  constructor(readonly userId: string) {
    super(`Unknown user: ${userId}`);
    this.name = "UnknownUserError";
  }
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly userId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Cannot move user ${userId} from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
  }
}

// ---------------------------------------------------------------------------
// storage → feed mapping (see the header note: this is b0a's subject)
// ---------------------------------------------------------------------------

function feedUrlFor(ctx: AppContext, token: string, path: string): string {
  // The router serves /feed/:token/…, so the emitted self-link must carry the
  // token too — otherwise the feed advertises a 404 (the tww contract mismatch).
  return `${ctx.config.publicBaseUrl}/feed/${encodeURIComponent(token)}/${path}`;
}

/** Publishable means it has playable audio; a missing enclosure is a broken player. */
function toFeedEpisode(episode: Episode, ctx: AppContext): FeedEpisode | null {
  if (!isPublishable(episode)) return null;
  return {
    guid: episode.id,
    title: episode.title,
    // readyAt is when audio existed; createdAt is when the job was queued. Podcast
    // clients sort by pubDate, so a minutes-long synthesis gap would show up as a
    // stale ordering (audio-feed-opus, review note).
    pubDate: episode.readyAt ?? episode.createdAt,
    audioUrl: `${ctx.config.publicBaseUrl}/audio/${episode.audioKey}`,
    description: episode.description,
    kind: episode.mode,
    sourceId: episode.sourceId,
    byteLength: episode.byteLength,
    mimeType: episode.contentType,
    durationSeconds: episode.durationSeconds,
  };
}

async function publishableEpisodes(
  ctx: AppContext,
  userId: string,
  filter: { sourceId?: string; mode?: AudioMode } = {},
): Promise<FeedEpisode[]> {
  const episodes = await ctx.stores.metadata.listEpisodes({
    userId,
    sourceId: filter.sourceId,
    mode: filter.mode,
    limit: 200,
  });
  return episodes
    .map((episode) => toFeedEpisode(episode, ctx))
    .filter((episode): episode is FeedEpisode => episode !== null);
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
  return async ({ params }) => {
    const token = params.token ?? "";
    const user = await loadUserByFeedToken(ctx, token);
    if (!user) return notFound("Unknown feed");
    if (user.status !== "approved") return forbidden(`Feed unavailable (status: ${user.status})`);

    const episodes = await publishableEpisodes(ctx, user.id);
    const sources = await ctx.stores.metadata.listSources(user.id);
    const titles = new Map(sources.map((source) => [source.id, source.title]));

    // The channel carries the URL the router actually serves. Deriving it here
    // (rather than from rss.ts's origin-only helper) is what stopped the feed
    // advertising a 404 — the tww contract mismatch.
    const channel: ChannelMeta = {
      title: `${displayNameOf(user)} — Audio Feed`,
      selfUrl: feedUrlFor(ctx, token, "master.xml"),
      link: ctx.config.publicBaseUrl,
      description: "All subscribed audio-feed episodes: direct reads and deep dives.",
      author: displayNameOf(user),
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
  return async ({ params }) => {
    const token = params.token ?? "";
    const user = await loadUserByFeedToken(ctx, token);
    if (!user) return notFound("Unknown feed");
    if (user.status !== "approved") return forbidden(`Feed unavailable (status: ${user.status})`);

    const sourceId = params.sourceId ?? "";
    const mode: AudioMode = params.mode === "deepdive" ? "deepdive" : "direct";
    const source = await ctx.stores.metadata.getSource(user.id, sourceId);
    if (!source) return notFound(`Unknown source: ${sourceId}`);

    const episodes = await publishableEpisodes(ctx, user.id, { sourceId, mode });
    const modeLabel = mode === "deepdive" ? "Deep Dive" : "Direct Read";
    const channel: ChannelMeta = {
      title: `${source.title} — ${modeLabel}`,
      selfUrl: feedUrlFor(ctx, token, `${sourceId}/${mode}.xml`),
      link: source.siteUrl ?? ctx.config.publicBaseUrl,
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
  fetchArticle?: (url: string, signal: AbortSignal) => Promise<ExtractedArticle>;
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
        return await authorizeForSynthesis(ctx, user.id);
      } catch (error) {
        if (error instanceof NotApprovedError) {
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

/** `POST /api/admin/users/:id/approve` — admin queue, token-gated. */
export function createApproveUserHandler(ctx: AppContext): AppHandlers["approveUser"] {
  return async ({ params, req }) => {
    const expected = ctx.config.adminToken;
    if (!expected) {
      // Fail closed and say why: an unconfigured server must not have an open
      // approval endpoint.
      return forbidden("ADMIN_TOKEN is not configured on this server.");
    }
    const bearer = req.headers.get("authorization")?.toLowerCase().startsWith("bearer ")
      ? req.headers.get("authorization")!.slice(7).trim()
      : null;
    try {
      await requireAdminToken(req.headers.get("x-admin-token") ?? bearer, expected);
    } catch {
      return Response.json({ error: "Unauthorized: admin token required" }, {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }

    try {
      const updated = await approveUserRecord(ctx, params.id ?? "", "admin");
      // Never echo a capability: the feed URL already carries the token.
      return Response.json(
        { id: updated.id, status: updated.status, approvedAt: updated.approvedAt },
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
  };
}
