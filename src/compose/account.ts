/**
 * compose/account — user-scoped services shared by the account page and the admin console.
 *
 * Deleting a subscription, regenerating a user's outdated episodes and counting them are all
 * "act on THIS user's episodes" operations: the account routes call them for the signed-in
 * user, the admin routes call them for a named user. Moved out of compose.ts by audio-feed-bd0.
 */
import { isSynthesisAuthorized, type User } from "../types.ts";
import { isOutdated } from "../tts/prompt_version.ts";
import type { MetadataStore } from "../storage/mod.ts";
import { forbidden, notFound } from "./shared.ts";
import { countEpisodeScan, episodeScan } from "./ingest.ts";
import type { AppContext } from "../app.ts";
import { type AudioMode } from "../types.ts";

/**
 * audio-feed-wr1u: reclaim an episode's persisted synthesis segments before its row goes.
 *
 * The episode row is the only path back to these records; EVERY delete path (cascade and
 * plain) must sweep them, or their blobs leak with no orphan record and no future sweep
 * that could ever find them. A delete that throws is recorded as an orphan — and
 * parseAudioBlobKey understands audio-segments/ keys, so the batch sweeper reclaims it.
 */
async function sweepEpisodeSegments(
  ctx: AppContext,
  userId: string,
  episodeId: string,
  deletedBlobKeys: Set<string>,
  failedBlobKeys: Set<string>,
): Promise<void> {
  for (const record of await ctx.stores.metadata.listSynthesisSegments(userId, episodeId)) {
    if (!record.audioKey || deletedBlobKeys.has(record.audioKey)) continue;
    try {
      await ctx.stores.blobs.delete(record.audioKey);
      deletedBlobKeys.add(record.audioKey);
      failedBlobKeys.delete(record.audioKey);
    } catch {
      failedBlobKeys.add(record.audioKey);
      await ctx.stores.metadata.recordOrphanBlob(record.audioKey).catch(() => {});
    }
  }
  await ctx.stores.metadata.clearSynthesisSegments(userId, episodeId);
}

/**
 * Remove one of `userId`'s sources: the admin console's delete and the account
 * page's (audio-feed-8fc) share this, so the drain guards below exist once.
 * Scoped by `userId`, so another user's source id is simply "Unknown source".
 */

export async function deleteUserSource(
  ctx: AppContext,
  req: Request,
  userId: string,
  sourceId: string,
): Promise<Response> {
  {
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
          await sweepEpisodeSegments(ctx, userId, episode.id, deletedBlobKeys, failedBlobKeys);
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
            // A regenerating episode is published on its old audio: cancel the
            // regeneration and retain it, rather than deleting a playable episode
            // and orphaning its blob (audio-feed-8oz).
            if (
              episode.regenerating &&
              await ctx.stores.metadata.cancelRegeneration(userId, episode.id)
            ) {
              continue;
            }
            // audio-feed-wr1u review: the non-cascade delete is the DEFAULT path, and a
            // pending episode can carry finalized segment records (a failed-then-retried
            // run). Once the row is gone nothing can ever list them again, so the sweep
            // belongs here exactly as much as in the cascade.
            await sweepEpisodeSegments(ctx, userId, episode.id, deletedBlobKeys, failedBlobKeys);
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
  }
}
export async function regenerableUser(
  ctx: AppContext,
  userId: string,
): Promise<{ user: User } | { denied: Response }> {
  const user = await ctx.stores.metadata.getUser(userId);
  if (!user) return { denied: notFound("Unknown user") };
  if (!isSynthesisAuthorized(user)) {
    return { denied: forbidden(`Regeneration unavailable (status: ${user.status})`) };
  }
  return { user };
}
/**
 * Requeue a user's published or failed episodes: every one, only those made by other
 * prompts, or failed ones. Shared by the admin console and the account page (audio-feed-ktn, audio-feed-6y9).
 * Callers own the approval gate. Resolves the number queued.
 */
export async function regenerateUserEpisodes(
  metadata: MetadataStore,
  userId: string,
  scope: "outdated" | "all" | "failed",
  filter: { sourceId?: string; mode?: AudioMode } = {},
): Promise<number> {
  // Collect first, then requeue/retry: state changes move an episode out of the
  // scan being paged, which would shift the scan under its own cursor.
  let queued = 0;

  // 1. Ready episodes (for "outdated" and "all")
  if (scope === "outdated" || scope === "all") {
    const readyIds: string[] = [];
    for await (const batch of episodeScan(metadata, { userId, ...filter, status: "ready" })) {
      for (const e of batch) if (scope === "all" || isOutdated(e)) readyIds.push(e.id);
    }
    for (const id of readyIds) {
      if (await metadata.requeueEpisode(userId, id)) queued++;
    }
  }

  // 2. Failed episodes (for "failed" and "all", audio-feed-6y9)
  if (scope === "failed" || scope === "all") {
    const failedIds: string[] = [];
    for await (const batch of episodeScan(metadata, { userId, ...filter, status: "failed" })) {
      for (const e of batch) failedIds.push(e.id);
    }
    for (const id of failedIds) {
      if (await metadata.retryEpisode(userId, id)) queued++;
    }
  }

  return queued;
}
/** How many of a user's published episodes were made by other prompts. */
export async function countOutdatedEpisodes(
  metadata: MetadataStore,
  userId: string,
): Promise<number> {
  let outdated = 0;
  for await (const batch of episodeScan(metadata, { userId, status: "ready" })) {
    outdated += batch.filter((e) => isOutdated(e)).length;
  }
  return outdated;
}
