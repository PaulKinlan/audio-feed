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
 *
 * audio-feed-bd0 split the handlers by area: `compose/shared.ts` (request identity and the
 * response helpers), `compose/feeds.ts`, `compose/ingest.ts`, `compose/account.ts` and
 * `compose/admin.ts`. This file is the seam: it still exports `createHandlers` and re-exports
 * every symbol it exported before the split, so existing importers of `./compose.ts` are
 * untouched.
 */

import { createAccountHandlers } from "./routes/account_api.ts";
import type { ComposeDeps } from "./compose/shared.ts";
import { createIngestHandler } from "./compose/ingest.ts";
import {
  createCreateSourceHandler,
  createListSourcesHandler,
  createMasterFeedHandler,
  createSourceFeedHandler,
} from "./compose/feeds.ts";
import { deleteUserSource, regenerateUserEpisodes } from "./compose/account.ts";
import {
  createAdminCreateUserSourceHandler,
  createAdminDeleteUserSourceHandler,
  createAdminListUserEpisodesHandler,
  createAdminListUserSourcesHandler,
  createAdminPollNowHandler,
  createAdminRegenerateEpisodeHandler,
  createAdminRegenerateFeedHandler,
  createAdminRotateUserTokenHandler,
  createAdminSetRoleHandler,
  createAdminSetupLinkHandler,
  createAdminStatsHandler,
  createAdminSynthesizeNowHandler,
  createApproveUserHandler,
  createCreateUserHandler,
  createListUsersHandler,
  createSuspendUserHandler,
} from "./compose/admin.ts";
import type { AppContext, AppHandlers } from "./app.ts";

// THE SURFACE ./compose.ts HAS ALWAYS EXPORTED (audio-feed-bd0). Callers keep importing this
// module; the code lives in the area modules above. `countOutdatedEpisodes` is re-exported
// because src/routes/account.ts imports it from here.
export { IllegalTransitionError, NotAuthorizedError, UnknownUserError } from "./auth/users.ts";
export type { ComposeDeps } from "./compose/shared.ts";
export {
  countOutdatedEpisodes,
  deleteUserSource,
  regenerateUserEpisodes,
} from "./compose/account.ts";
export {
  createCreateSourceHandler,
  createListSourcesHandler,
  createMasterFeedHandler,
  createSourceFeedHandler,
} from "./compose/feeds.ts";
export { createIngestHandler } from "./compose/ingest.ts";
export {
  createAdminCreateUserSourceHandler,
  createAdminDeleteUserSourceHandler,
  createAdminListUserEpisodesHandler,
  createAdminListUserSourcesHandler,
  createAdminPollNowHandler,
  createAdminRegenerateEpisodeHandler,
  createAdminRegenerateFeedHandler,
  createAdminRotateUserTokenHandler,
  createAdminSetRoleHandler,
  createAdminSetupLinkHandler,
  createAdminStatsHandler,
  createAdminSynthesizeNowHandler,
  createApproveUserHandler,
  createCreateUserHandler,
  createListUsersHandler,
  createSuspendUserHandler,
} from "./compose/admin.ts";

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
    adminStats: createAdminStatsHandler(ctx),
    adminSynthesizeNow: createAdminSynthesizeNowHandler(ctx, deps),
    adminSetRole: createAdminSetRoleHandler(ctx),
    adminSetupLink: createAdminSetupLinkHandler(ctx),
    account: createAccountHandlers(ctx, {
      feedTransport: deps.feedTransport,
      fetchArticle: deps.fetchArticle,
      deleteUserSource: (req, userId, sourceId) => deleteUserSource(ctx, req, userId, sourceId),
      regenerateOutdated: (userId) =>
        regenerateUserEpisodes(ctx.stores.metadata, userId, "outdated"),
    }),
    adminListEpisodes: createAdminListUserEpisodesHandler(ctx),
    adminRegenerateEpisode: createAdminRegenerateEpisodeHandler(ctx),
    adminRegenerateFeed: createAdminRegenerateFeedHandler(ctx),
  };
}
