/**
 * compose/episodes — `GET /api/episodes`, the subscriber's own listing.
 *
 * Moved out of app.ts and put behind an ownership check by audio-feed-nx3o. The
 * route used to take `userId` from the query string and return that subscriber's
 * Episode records — title, description, status and audioKey — to anyone. User
 * ids are not secret: they ride in the ingest 202 body and the admin approve
 * path (src/compose/shared.ts). Once an id was known, an unauthenticated caller
 * could enumerate the catalogue and then fetch every `audioKey` from
 * `/audio/<key>`, which answers `access-control-allow-origin: *`. The feed routes
 * were closed in n2ha; this JSON route was the remaining copy of the same hole.
 *
 * Identity now comes from the request — a feed token, or a same-site session
 * cookie (`callerUserFor`). The `userId` parameter is kept for compatibility but
 * can only name the caller: a differing id is refused rather than silently
 * swapped, so a probe learns nothing about whether the id exists.
 */
import { isAudioMode } from "../types.ts";
import { callerUserFor, forbidden, notFound } from "./shared.ts";
import type { AppContext, AppHandlers } from "../app.ts";

export function createListEpisodesHandler(ctx: AppContext): AppHandlers["listEpisodes"] {
  return async ({ url, req }) => {
    const caller = await callerUserFor(ctx, req);
    if ("denied" in caller) return caller.denied;

    // Ownership check, not an identity source. Absent means "mine".
    const requested = url.searchParams.get("userId");
    if (requested !== null && requested !== caller.user.id) {
      return forbidden("That is another subscriber's listing.");
    }

    const modeParam = url.searchParams.get("mode");
    if (modeParam !== null && !isAudioMode(modeParam)) {
      return notFound(`Unknown mode: ${modeParam}`);
    }

    const episodes = await ctx.stores.metadata.listEpisodes({
      userId: caller.user.id,
      sourceId: url.searchParams.get("sourceId") ?? undefined,
      mode: modeParam ?? undefined,
      limit: clampLimit(url.searchParams.get("limit")),
    });

    return Response.json({ episodes }, { headers: { "cache-control": "no-store" } });
  };
}

function clampLimit(raw: string | null): number {
  const parsed = Number(raw ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}
