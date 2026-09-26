/**
 * compose/admin — the admin console's API, and the gate every admin handler goes through.
 *
 * `adminGate` refuses with the environment's own words (no token configured, cross-origin, not an
 * admin), so no handler repeats the check. The regenerate/stats/poll/synthesize handlers are the
 * console's controls. Moved out of compose.ts by audio-feed-bd0 with no behaviour change.
 */
import { articleUrl, IngestError } from "../ingest/url.ts";
import { runFeedPollBatch, subscribeToFeed } from "../ingest/feed.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../worker/synthesis.ts";
import { recordRun } from "../stats.ts";
import {
  approveUser,
  createUser,
  IllegalTransitionError,
  listUsers,
  requireAdminToken,
  rotateFeedToken,
  suspendUser,
  UnknownUserError,
} from "../auth/users.ts";
import { isAudioMode } from "../types.ts";
import { isActiveAdmin, issueSetupLink, sameOrigin, sessionUser } from "../auth/sessions.ts";
import { isOutdated, PROMPT_VERSION } from "../tts/prompt_version.ts";
import { resolveOrigin } from "../origin.ts";
import { badRequest, type ComposeDeps, forbidden, notFound } from "./shared.ts";
import { episodeScan } from "./ingest.ts";
import { deleteUserSource, regenerableUser, regenerateUserEpisodes } from "./account.ts";
import type { AppContext, AppHandlers } from "../app.ts";
import { type AudioMode, type CodeHandling, DEFAULT_CODE_HANDLING } from "../types.ts";

/**
 * The admin gate for every `/api/admin/*` route.
 *
 * Returns a Response to send back when the caller may not proceed, or null when
 * they may. One helper rather than four copies, so a new admin route cannot be
 * added without the token check by accident — the failure mode this whole surface
 * exists to prevent (audio-feed-z2s).
 */
async function adminGate(ctx: AppContext, req: Request): Promise<Response | null> {
  const bearer = req.headers.get("authorization")?.toLowerCase().startsWith("bearer ")
    ? req.headers.get("authorization")!.slice(7).trim()
    : null;
  const presented = req.headers.get("x-admin-token") ?? bearer;

  // audio-feed-8fc: an admin SESSION is the normal way in. A presented token wins
  // when there is one, so the break-glass path behaves exactly as before.
  if (!presented) {
    const user = await sessionUser(ctx.stores.metadata, req);
    if (user) {
      if (!isActiveAdmin(user)) return forbidden("Admin access required.");
      const safe = req.method === "GET" || req.method === "HEAD";
      if (!safe && !sameOrigin(req, resolveOrigin(ctx.config, req).baseUrl)) {
        return forbidden("Cross-origin request refused.");
      }
      return null;
    }
  }

  const expected = ctx.config.adminToken;
  if (!expected) {
    // Fail closed and say why: an unconfigured server must not have open admin
    // endpoints at all.
    return forbidden("ADMIN_TOKEN is not configured on this server.");
  }
  try {
    await requireAdminToken(presented, expected);
    return null;
  } catch {
    return Response.json({ error: "Unauthorized: admin token required" }, {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
}

/**
 * `POST /api/admin/users/:id/role` — grant or revoke admin (audio-feed-8fc).
 * Refuses to demote the signed-in caller, and (in the store, atomically) any
 * change that would leave no approved admin — the token path included. Every
 * change lands in the approval ledger as a `role` record: who, when, from, to.
 */
export function createAdminSetRoleHandler(ctx: AppContext): AppHandlers["adminSetRole"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;
    const body = await req.json().catch(() => ({})) as { isAdmin?: unknown };
    if (typeof body.isAdmin !== "boolean") {
      return Response.json({ error: "isAdmin must be true or false." }, { status: 400 });
    }
    const target = await ctx.stores.metadata.getUser(params.id ?? "");
    if (!target) return notFound("Unknown user");
    const caller = await sessionUser(ctx.stores.metadata, req);
    if (!body.isAdmin && caller?.id === target.id) {
      return Response.json({ error: "You cannot remove your own admin access." }, {
        status: 409,
        headers: { "cache-control": "no-store" },
      });
    }
    const outcome = await ctx.stores.metadata.setAdminRole(target.id, body.isAdmin, {
      adminId: caller && isActiveAdmin(caller) ? caller.id : "admin-token",
      at: new Date().toISOString(),
    });
    if (outcome === "missing") return notFound("Unknown user");
    if (outcome === "last-admin") {
      return Response.json(
        { error: "That would leave no admins. Make someone else an admin first." },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json({ id: target.id, isAdmin: body.isAdmin }, {
      headers: { "cache-control": "no-store" },
    });
  };
}

/**
 * `POST /api/admin/users/:id/setup-link` — a one-time enrolment or recovery link
 * (audio-feed-8fc). The secret is in the URL fragment and in this no-store body,
 * nowhere else: not a Location header, not a log line, not the store.
 */
export function createAdminSetupLinkHandler(ctx: AppContext): AppHandlers["adminSetupLink"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;
    const target = await ctx.stores.metadata.getUser(params.id ?? "");
    if (!target) return notFound("Unknown user");
    const caller = await sessionUser(ctx.stores.metadata, req);
    const { token, expiresAt } = await issueSetupLink(
      ctx.stores.metadata,
      target.id,
      caller && isActiveAdmin(caller) ? caller.id : "admin-token",
    );
    const base = resolveOrigin(ctx.config, req).baseUrl;
    return Response.json(
      { userId: target.id, url: `${base}/login#setup=${token}`, expiresAt },
      { status: 201, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
    );
  };
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
      isAdmin?: unknown;
      codeHandling?: unknown;
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
        isAdmin: body.isAdmin === true,
      });
      const approved = await approveUser(ctx.stores.metadata, created.id, "admin");

      let initialSource: {
        id: string;
        title: string;
        feedUrl: string;
        codeHandling?: CodeHandling;
        queued: number;
      } | undefined;

      if (typeof body.feedUrl === "string" && body.feedUrl.trim() !== "") {
        const validatedUrl = articleUrl(body.feedUrl.trim()).href;
        const codeHandling: CodeHandling = body.codeHandling === "explain" ? "explain" : "skip";
        const { source, poll } = await subscribeToFeed(
          ctx,
          {
            userId: approved.id,
            feedUrl: validatedUrl,
            codeHandling,
          },
          { transport: deps.feedTransport, fetchArticle: deps.fetchArticle, maxItems: 5 },
        );
        initialSource = {
          id: source.id,
          title: source.title,
          feedUrl: source.feedUrl ?? validatedUrl,
          codeHandling: source.codeHandling ?? DEFAULT_CODE_HANDLING,
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
          codeHandling: source.codeHandling ?? DEFAULT_CODE_HANDLING,
          lastPolledAt: source.lastPolledAt,
          lastPollError: source.lastPollError,
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
          userId: user.id,
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
    return await deleteUserSource(ctx, req, params.id ?? "", params.sourceId ?? "");
  };
}

// ---------------------------------------------------------------------------
// regenerate (audio-feed-8oz)
// ---------------------------------------------------------------------------

/**
 * The user to regenerate for, or the response to send. Regenerating is TTS spend,
 * so an unapproved user is refused here as well as deferred by the worker.
 */

/** How many rows the console shows; the counts cover the whole catalogue. */
const ADMIN_EPISODE_ROWS = 50;

/** `GET /api/admin/users/:id/episodes` — newest episodes and the regenerate counts. */
export function createAdminListUserEpisodesHandler(
  ctx: AppContext,
): AppHandlers["adminListEpisodes"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;
    const userId = params.id ?? "";
    if (!await ctx.stores.metadata.getUser(userId)) return notFound("Unknown user");

    const counts = { outdated: 0, all: 0 };
    for await (
      const batch of episodeScan(ctx.stores.metadata, { userId, status: "ready" })
    ) {
      counts.all += batch.length;
      counts.outdated += batch.filter((e) => isOutdated(e)).length;
    }
    const episodes = await ctx.stores.metadata.listEpisodes({
      userId,
      limit: ADMIN_EPISODE_ROWS,
    });
    return Response.json(
      {
        promptVersion: PROMPT_VERSION,
        counts,
        episodes: episodes.map((e) => ({
          id: e.id,
          title: e.title,
          sourceId: e.sourceId,
          mode: e.mode,
          status: e.status,
          regenerating: !!e.regenerating,
          promptVersion: e.promptVersion ?? null,
          outdated: isOutdated(e),
          audioKey: e.audioKey ?? null,
          error: e.error ?? null,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  };
}

/** `POST /api/admin/users/:id/episodes/:episodeId/regenerate` — one episode. */
export function createAdminRegenerateEpisodeHandler(
  ctx: AppContext,
): AppHandlers["adminRegenerateEpisode"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;
    const resolved = await regenerableUser(ctx, params.id ?? "");
    if ("denied" in resolved) return resolved.denied;
    const episodeId = params.episodeId ?? "";
    if (!await ctx.stores.metadata.getEpisode(resolved.user.id, episodeId)) {
      return notFound("Unknown episode");
    }
    // Idempotent: an episode already queued (or not yet published) queues nothing.
    const queued = await ctx.stores.metadata.requeueEpisode(resolved.user.id, episodeId);
    return Response.json(
      { ok: true, queued: queued ? 1 : 0 },
      { headers: { "cache-control": "no-store" } },
    );
  };
}

/**
 * `POST /api/admin/users/:id/regenerate` — a subscriber's feed.
 * Body: `{ scope?: "outdated" | "all", sourceId?: string, mode?: AudioMode }`.
 */
export function createAdminRegenerateFeedHandler(
  ctx: AppContext,
): AppHandlers["adminRegenerateFeed"] {
  return async ({ params, req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    const body: { scope?: unknown; sourceId?: unknown; mode?: unknown } = await req.json()
      .catch(() => ({}));
    const scope = body.scope ?? "outdated";
    if (scope !== "outdated" && scope !== "all") {
      return badRequest('scope must be "outdated" or "all".');
    }
    if (body.sourceId !== undefined && typeof body.sourceId !== "string") {
      return badRequest("sourceId must be a string.");
    }
    if (body.mode !== undefined && !isAudioMode(body.mode)) {
      return badRequest('mode must be "direct" or "deepdive".');
    }

    const resolved = await regenerableUser(ctx, params.id ?? "");
    if ("denied" in resolved) return resolved.denied;
    const userId = resolved.user.id;

    const queued = await regenerateUserEpisodes(ctx.stores.metadata, userId, scope, {
      sourceId: body.sourceId,
      mode: body.mode,
    });
    return Response.json(
      { ok: true, scope, queued },
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

/**
 * `GET /api/admin/stats` — operational metrics for the dashboard (audio-feed-ndc).
 *
 * Every number here is bounded by construction: each job's run history is
 * capped at write, and the per-user download list only contains users who have
 * had a request. No unbounded scan, which is the audio-feed-att failure.
 */
export function createAdminStatsHandler(ctx: AppContext): AppHandlers["adminStats"] {
  return async ({ req }) => {
    const denied = await adminGate(ctx, req);
    if (denied) return denied;

    const [downloads, runs, users] = await Promise.all([
      ctx.stores.metadata.getDownloadCounts(),
      ctx.stores.metadata.listRuns(),
      ctx.stores.metadata.listUsers(),
    ]);

    // Resolve ids to emails so the dashboard shows a person, not a ULID.
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    // Feed processing times come from the poll runs we recorded, not from a
    // separate timer: one source of truth means the dashboard cannot disagree
    // with the history it is displaying. `runs` holds each job's own history,
    // so the synthesis cron's ticks cannot crowd the polls out (audio-feed-ct1).
    const pollRuns = runs.filter((r) => r.kind === "feed-poll");
    const lastPoll = pollRuns[0];
    const recent = pollRuns.slice(0, 10);
    const averagePollMs = recent.length
      ? Math.round(recent.reduce((sum, r) => sum + r.durationMs, 0) / recent.length)
      : null;

    return Response.json(
      {
        ok: true,
        downloads: {
          total: downloads.total,
          perUser: downloads.perUser.map((d) => ({
            ...d,
            email: emailById.get(d.userId) ?? null,
          })),
        },
        feedProcessing: {
          lastPolledAt: lastPoll?.startedAt ?? null,
          lastDurationMs: lastPoll?.durationMs ?? null,
          averageDurationMs: averagePollMs,
          sampleSize: recent.length,
        },
        runs,
      },
      { headers: { "cache-control": "no-store" } },
    );
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

    // Recorded in the same history as the cron runs, tagged `manual`, so the
    // dashboard can show who started what (audio-feed-ndc).
    const result = await recordRun(
      ctx,
      "feed-poll",
      "manual",
      () =>
        runFeedPollBatch(ctx, {
          ...deps.feedPollOptions,
          transport: deps.feedTransport,
          fetchArticle: deps.fetchArticle,
        }),
      (r) => ({ polled: r.polled, queued: r.queued, failed: r.failed }),
    );

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

    const result = await recordRun(
      ctx,
      "synthesis",
      "manual",
      () => runSynthesisBatch(ctx, synthesizer, deps.synthesisOptions),
      (r) => ({
        ready: r.ready.length,
        failed: r.failed.length,
        deferred: r.deferred.length,
      }),
    );
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
