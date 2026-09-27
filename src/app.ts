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
 *   GET  /api/admin/stats                     operational metrics         [ndc]
 *   GET  /login, /account                     passkey sign-in, account    [8fc]
 *   POST /api/auth/*, /api/account/*          sessions and account API    [8fc]
 *   POST /api/account/regenerate, .../episodes/:episodeId/regenerate  own [ktn]
 *   GET  /api/admin/users/:id/episodes        episodes + regenerate counts [8oz]
 *   POST /api/admin/users/:id/regenerate      regenerate a feed           [8oz]
 *   POST /api/admin/users/:id/episodes/:episodeId/regenerate  one episode [8oz]
 *
 * Owned by: audio-feed-0h8.
 */

import { type Handler, Router } from "./router.ts";
import { json, notFound } from "./http.ts";
import { handleAudio, notImplemented } from "./routes/audio.ts";
import { handleHome } from "./routes/home.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleLogin } from "./routes/login.ts";
import { handleAccount } from "./routes/account.ts";
import {
  handleListen,
  handleListenRetry,
  handleListenStatus,
  renderListenLanding,
} from "./routes/listen.ts";
import { handleAsset } from "./routes/assets.ts";
import { handleIcon, handleManifest, handleServiceWorker } from "./routes/pwa.ts";
import type { AppConfig, Stores } from "./config.ts";
import { isAudioMode } from "./types.ts";
import { resolveOrigin } from "./origin.ts";
import type { AccountHandlers } from "./routes/account_api.ts";

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
  /** audio-feed-ndc — operational metrics for the admin dashboard. */
  adminStats?: Handler<AppContext>;
  /** audio-feed-8fc — admin roles and one-time passkey setup links. */
  adminSetRole?: Handler<AppContext>;
  adminSetupLink?: Handler<AppContext>;
  /** audio-feed-8fc — passkey sign-in, sessions and the account page's API. */
  account?: AccountHandlers;
  /** audio-feed-8oz — regenerate after the TTS prompts change. */
  adminListEpisodes?: Handler<AppContext>;
  adminRegenerateEpisode?: Handler<AppContext>;
  adminRegenerateFeed?: Handler<AppContext>;
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
  // audio-feed-8fc: passkey sign-in and the signed-in subscriber's own page.
  router.get("/login", handleLogin);
  router.get("/account", handleAccount);
  // The listener app (audio-feed-4xb): token-fronted, so a subscriber needs no
  // account — the feed token they already hold is the whole credential.
  router.get(
    "/listen",
    ({ ctx, req }) =>
      new Response(renderListenLanding(resolveOrigin(ctx.config, req).baseUrl), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      }),
  );
  // audio-feed-3xq: content-addressed static assets (see src/routes/assets.ts).
  router.get("/assets/:name", handleAsset);
  router.get("/listen/:token", handleListen);
  // audio-feed-7s2: the activity panel's poll, and the subscriber's retry. Same capability as
  // the page itself — the token in the path is the credential.
  router.get("/listen/:token/status", handleListenStatus);
  router.post("/listen/:token/episodes/:episodeId/retry", handleListenRetry);
  // PWA surface, served as routes because this app has no static file pipeline.
  router.get("/sw.js", handleServiceWorker);
  router.get("/manifest.json", handleManifest);
  router.get("/icon.svg", handleIcon);

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
  router.get(
    "/api/admin/stats",
    handlers.adminStats ?? (() => notImplemented("Admin stats")),
  );

  router.post(
    "/api/admin/users/:id/role",
    handlers.adminSetRole ?? (() => notImplemented("Admin role")),
  );
  router.post(
    "/api/admin/users/:id/setup-link",
    handlers.adminSetupLink ?? (() => notImplemented("Admin setup link")),
  );

  // -- accounts (audio-feed-8fc) ----------------------------------------------
  const account = (name: keyof AccountHandlers): Handler<AppContext> =>
    handlers.account?.[name] ?? (() => notImplemented("Accounts"));
  router.post("/api/auth/login/options", account("loginOptions"));
  router.post("/api/auth/login/verify", account("loginVerify"));
  router.post("/api/auth/register/options", account("registerOptions"));
  router.post("/api/auth/register/verify", account("registerVerify"));
  router.post("/api/auth/logout", account("logout"));
  router.post("/api/account/profile", account("profile"));
  router.post("/api/account/rotate-token", account("rotateToken"));
  router.post("/api/account/sources", account("addSource"));
  router.delete("/api/account/sources/:sourceId", account("deleteSource"));
  router.delete("/api/account/passkeys/:id", account("deletePasskey"));
  router.post("/api/account/episodes/:episodeId/regenerate", account("regenerateEpisode"));
  router.post("/api/account/regenerate", account("regenerateOutdated"));

  router.get(
    "/api/admin/users/:id/episodes",
    handlers.adminListEpisodes ?? (() => notImplemented("Admin list episodes")),
  );
  router.post(
    "/api/admin/users/:id/episodes/:episodeId/regenerate",
    handlers.adminRegenerateEpisode ?? (() => notImplemented("Admin regenerate episode")),
  );
  router.post(
    "/api/admin/users/:id/regenerate",
    handlers.adminRegenerateFeed ?? (() => notImplemented("Admin regenerate feed")),
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
