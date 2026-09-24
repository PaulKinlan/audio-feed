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
  /** Anything a lane needs that is not in the map above. Announce it to coord. */
  extra?: (router: Router<AppContext>) => void;
}

export function createRouter(handlers: AppHandlers = {}): Router<AppContext> {
  const router = new Router<AppContext>();

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
  router.get("/api/episodes", handleEpisodes);
  router.post(
    "/api/admin/users/:id/approve",
    handlers.approveUser ?? (() => notImplemented("Admin approval")),
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
