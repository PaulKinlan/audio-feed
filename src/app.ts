/**
 * Application wiring — the single place routes are mounted.
 *
 * Lanes do NOT edit the route table by hand-merging into one function body;
 * that is how three lanes produce three conflicting shells. Instead each lane
 * implements a handler module and passes it in through `AppHandlers`. The route
 * paths, the context object, and the dispatch order live here and stay stable.
 *
 * Route map (paths are contract — feed URLs end up in podcast clients and can
 * never be changed once subscribed):
 *
 *   GET  /                                    homepage, human entry point [f2a]
 *   GET  /health                              liveness
 *   GET  /feed/:token/master.xml              master aggregated feed      [7w6]
 *   GET  /feed/:token/:sourceId/:mode.xml     per-source feed             [7w6]
 *   GET  /audio/:key+                         enclosure bytes (Range)     [0h8]
 *   POST /api/ingest                          Send-to-Audio URL ingest    [by7]
 *   GET  /api/episodes                        episode listing             [0h8]
 *   POST /api/admin/users/:id/approve         approval gate               [7wn]
 *
 * Owned by: audio-feed-0h8.
 */

import { type Handler, Router } from "./router.ts";
import { json, notFound } from "./http.ts";
import { handleAudio, notImplemented } from "./routes/audio.ts";
import { handleHome } from "./routes/home.ts";
import { handleAdmin } from "./routes/admin.ts";
import type { AppConfig, Stores } from "./config.ts";
import { isAudioMode } from "./types.ts";

export interface AppContext {
  config: AppConfig;
  stores: Stores;
}

/**
 * Lane seams. Every one is optional: the skeleton boots and serves with none of
 * them, returning 501 for the unwired features. That means no lane blocks
 * another, and `main` is always runnable.
 */
export interface AppHandlers {
  /** audio-feed-7w6 — RSS 2.0 / iTunes feed generation. */
  masterFeed?: Handler<AppContext>;
  sourceFeed?: Handler<AppContext>;
  /** audio-feed-by7 — Send-to-Audio URL ingest. */
  ingest?: Handler<AppContext>;
  /** audio-feed-7wn — multi-user admin approval. */
  approveUser?: Handler<AppContext>;
  /** audio-feed-z2s — the admin console's subscriber list, creation and suspension. */
  listUsers?: Handler<AppContext>;
  createUser?: Handler<AppContext>;
  suspendUser?: Handler<AppContext>;
  /** audio-feed-2e5 — RSS/Atom subscriptions for a subscriber. */
  listSources?: Handler<AppContext>;
  createSource?: Handler<AppContext>;
  /** audio-feed-e3n — admin subscriber management: sources and token rotation. */
  adminListSources?: Handler<AppContext>;
  adminCreateSource?: Handler<AppContext>;
  adminDeleteSource?: Handler<AppContext>;
  adminRotateToken?: Handler<AppContext>;
  /** audio-feed-dsn — manual triggers for background tasks. */
  adminPollNow?: Handler<AppContext>;
  adminSynthesizeNow?: Handler<AppContext>;
  /** Anything a lane needs that is not in the map above. Announce it to coord. */
  extra?: (router: Router<AppContext>) => void;
}

export function createRouter(handlers: AppHandlers = {}): Router<AppContext> {
  const router = new Router<AppContext>();

  // audio-feed-f2a: every other route is machine-facing, so a person arriving
  // at the origin used to get `no route for GET /` and no way to learn what the
  // service was. This is the human entry point.
  router.get("/", handleHome);
  // The admin console shell. Public by design: it carries no subscriber data, and
  // every byte of that data comes from the token-gated /api/admin/users routes
  // (audio-feed-z2s).
  router.get("/admin", handleAdmin);

  router.get("/health", ({ ctx }) =>
    json({
      status: "ok",
      storage: ctx.stores.describe,
      time: new Date().toISOString(),
    }));

  // -- feeds ----------------------------------------------------------------
  // `:token` is the per-user capability: podcast clients cannot authenticate,
  // so the token in the path is the only credential these routes get.
  router.get(
    "/feed/:token/master.xml",
    handlers.masterFeed ?? (() => notImplemented("Master feed")),
  );
  router.get(
    "/feed/:token/:sourceId/:mode.xml",
    handlers.sourceFeed ?? (() => notImplemented("Per-source feed")),
  );

  // -- audio ----------------------------------------------------------------
  router.get("/audio/:key+", handleAudio);

  // -- api ------------------------------------------------------------------
  router.post("/api/ingest", handlers.ingest ?? (() => notImplemented("URL ingest")));
  // Feed subscriptions (audio-feed-2e5). User-scoped: the caller's feed token is
  // the identity, exactly as on /api/ingest.
  router.get("/api/sources", handlers.listSources ?? (() => notImplemented("Source list")));
  router.post(
    "/api/sources",
    handlers.createSource ?? (() => notImplemented("Source subscription")),
  );
  router.get("/api/episodes", handleEpisodes);
  router.post(
    "/api/admin/users/:id/approve",
    handlers.approveUser ?? (() => notImplemented("Admin approval")),
  );
  router.post(
    "/api/admin/users/:id/suspend",
    handlers.suspendUser ?? (() => notImplemented("Admin suspension")),
  );
  router.get(
    "/api/admin/users",
    handlers.listUsers ?? (() => notImplemented("Admin user list")),
  );
  router.post(
    "/api/admin/users",
    handlers.createUser ?? (() => notImplemented("Admin user creation")),
  );
  router.get(
    "/api/admin/users/:id/sources",
    handlers.adminListSources ?? (() => notImplemented("Admin list sources")),
  );
  router.post(
    "/api/admin/users/:id/sources",
    handlers.adminCreateSource ?? (() => notImplemented("Admin create source")),
  );
  router.delete(
    "/api/admin/users/:id/sources/:sourceId",
    handlers.adminDeleteSource ?? (() => notImplemented("Admin delete source")),
  );
  router.post(
    "/api/admin/users/:id/rotate-token",
    handlers.adminRotateToken ?? (() => notImplemented("Admin rotate token")),
  );
  router.post(
    "/api/admin/poll-now",
    handlers.adminPollNow ?? (() => notImplemented("Admin poll now")),
  );
  router.post(
    "/api/admin/synthesize-now",
    handlers.adminSynthesizeNow ?? (() => notImplemented("Admin synthesize now")),
  );

  handlers.extra?.(router);

  return router;
}

/**
 * Episode listing. Read-only and user-scoped; the caller identity comes from
 * `7wn`'s auth once it lands, so for now it requires an explicit `userId` and
 * exposes nothing without one.
 */
const handleEpisodes: Handler<AppContext> = async ({ url, ctx }) => {
  const userId = url.searchParams.get("userId");
  if (!userId) return notFound("Unknown user");

  const user = await ctx.stores.metadata.getUser(userId);
  if (!user) return notFound("Unknown user");

  const modeParam = url.searchParams.get("mode");
  if (modeParam !== null && !isAudioMode(modeParam)) {
    return notFound(`Unknown mode: ${modeParam}`);
  }

  const episodes = await ctx.stores.metadata.listEpisodes({
    userId,
    sourceId: url.searchParams.get("sourceId") ?? undefined,
    mode: modeParam ?? undefined,
    limit: clampLimit(url.searchParams.get("limit")),
  });

  return json({ episodes });
};

function clampLimit(raw: string | null): number {
  const parsed = Number(raw ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

export function createApp(
  ctx: AppContext,
  handlers: AppHandlers = {},
): { router: Router<AppContext>; fetch: (req: Request) => Promise<Response> } {
  const router = createRouter(handlers);
  return { router, fetch: router.fetchHandler(ctx) };
}
