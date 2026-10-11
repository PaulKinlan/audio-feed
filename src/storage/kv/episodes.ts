/**
 * Episodes: the queue, the claim that bounds paid work, completion, failure and regeneration.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { Episode } from "../../types.ts";
import type {
  EpisodeClaim,
  EpisodePage,
  EpisodePageResult,
  EpisodeQuery,
  EpisodeRepository,
  ListPendingOptions,
  ListPendingResult,
  MetadataStore,
} from "../mod.ts";
import type { KvCore } from "./core.ts";
import {
  DEFAULT_CLAIM_LEASE_MS,
  isClaimExpired,
  isPublishable,
  unsynthesized,
} from "../../types.ts";
import { descendingKey, EPISODE_READ_BATCH } from "./core.ts";

/**
 * `putEpisode`'s write set, guarded by the versionstamp the caller read.
 * Keeps the feed indexes in step with the record in one commit.
 */
async function atomicPutEpisode(
  core: KvCore,
  episode: Episode,
  guard: Deno.KvEntryMaybe<Episode>,
): Promise<boolean> {
  const sortKey = descendingKey(episode.createdAt, episode.id);
  const tx = core.kv.atomic()
    .check(guard)
    .set(["episode", episode.userId, episode.id], episode)
    .set(["episode_by_user", episode.userId, sortKey], episode.id)
    .set(
      ["episode_by_source", episode.userId, episode.sourceId, episode.mode, sortKey],
      episode.id,
    );

  core.writeQueueIndexes(tx, episode);

  const result = await tx.commit();
  return result.ok;
}
/**
 * Only two prefixes are time-ordered end-to-end:
 *   - `episode_by_user/<user>`                    → newest across everything
 *   - `episode_by_source/<user>/<source>/<mode>`  → newest within one feed
 *
 * A `sourceId` without a `mode` must NOT scan `episode_by_source/<user>/<source>`:
 * the next key segment is `mode`, so that scan orders by mode first and only
 * then by time, i.e. every `deepdive` episode ahead of every `direct` one.
 * Fall back to the user index and filter — correct order beats a tighter scan.
 */
function indexPrefix(_core: KvCore, query: EpisodeQuery): Deno.KvKey {
  if (query.sourceId && query.mode) {
    return ["episode_by_source", query.userId, query.sourceId, query.mode];
  }
  return ["episode_by_user", query.userId];
}
export function createEpisodesRepository(
  core: KvCore,
  host: () => MetadataStore,
): EpisodeRepository {
  return {
    async putEpisode(episode: Episode): Promise<void> {
      const tx = core.kv.atomic();
      core.writeEpisode(tx, episode);
      const result = await tx.commit();
      if (!result.ok) throw new Error(`putEpisode failed for ${episode.id}`);
    },
    async getEpisode(userId: string, id: string): Promise<Episode | null> {
      return (await core.kv.get<Episode>(["episode", userId, id])).value;
    },
    async deleteEpisode(userId: string, id: string): Promise<boolean> {
      const key: Deno.KvKey = ["episode", userId, id];
      const entry = await core.kv.get<Episode>(key);
      if (!entry.value) return false;
      const ep = entry.value;
      const sortKey = descendingKey(ep.createdAt, ep.id);
      const result = await core.kv.atomic()
        .check(entry)
        .delete(key)
        .delete(["episode_by_user", userId, sortKey])
        .delete(["episode_by_source", userId, ep.sourceId, ep.mode, sortKey])
        .delete(["pending_episodes", "0", ep.createdAt, ep.id])
        .delete(["pending_episodes", "1", ep.createdAt, ep.id])
        .delete(["synthesizing_episodes", ep.createdAt, ep.id])
        .commit();
      if (result.ok) return true;

      const retry = await core.kv.get<Episode>(key);
      if (!retry.value) return false;
      const retrySortKey = descendingKey(retry.value.createdAt, retry.value.id);
      const retryResult = await core.kv.atomic()
        .check(retry)
        .delete(key)
        .delete(["episode_by_user", userId, retrySortKey])
        .delete([
          "episode_by_source",
          userId,
          retry.value.sourceId,
          retry.value.mode,
          retrySortKey,
        ])
        .delete(["pending_episodes", "0", retry.value.createdAt, retry.value.id])
        .delete(["pending_episodes", "1", retry.value.createdAt, retry.value.id])
        .delete(["synthesizing_episodes", retry.value.createdAt, retry.value.id])
        .commit();
      return retryResult.ok;
    },
    async backfillEpisodeSourceTitle(
      userId: string,
      id: string,
      sourceTitle: string,
    ): Promise<boolean> {
      const key: Deno.KvKey = ["episode", userId, id];
      const entry = await core.kv.get<Episode>(key);
      if (!entry.value) return false;
      if (entry.value.sourceTitle) return true;
      const updated: Episode = { ...entry.value, sourceTitle };
      const res = await core.kv.atomic()
        .check(entry)
        .set(key, updated)
        .commit();
      if (res.ok) return true;

      // Retry once if atomic check collided
      const retry = await core.kv.get<Episode>(key);
      if (!retry.value) return false;
      if (retry.value.sourceTitle) return true;
      const retryUpdated: Episode = { ...retry.value, sourceTitle };
      const retryRes = await core.kv.atomic()
        .check(retry)
        .set(key, retryUpdated)
        .commit();
      return retryRes.ok;
    },
    async updateEpisodeAudioKeyIfCurrent(
      userId: string,
      id: string,
      expectedKey: string,
      newKey: string,
    ): Promise<boolean> {
      const key: Deno.KvKey = ["episode", userId, id];
      const entry = await core.kv.get<Episode>(key);
      if (!entry.value) return false;
      if (entry.value.audioKey !== expectedKey) return false;
      const updated: Episode = { ...entry.value, audioKey: newKey };
      const res = await core.kv.atomic()
        .check(entry)
        .set(key, updated)
        .commit();
      if (res.ok) return true;

      // Retry once if atomic check collided
      const retry = await core.kv.get<Episode>(key);
      if (!retry.value) return false;
      if (retry.value.audioKey !== expectedKey) return false;
      const retryUpdated: Episode = { ...retry.value, audioKey: newKey };
      const retryRes = await core.kv.atomic()
        .check(retry)
        .set(key, retryUpdated)
        .commit();
      return retryRes.ok;
    },
    async listEpisodes(query: EpisodeQuery): Promise<Episode[]> {
      // `limit` bounds MATCHES here, not entries examined. A filtered query's
      // matches can sit arbitrarily deep in a newest-first index scan, so one
      // page of `listEpisodePage` (whose limit bounds the underlying scan) is not
      // equivalent to what this method has always returned. The two drain loops in
      // createAdminDeleteSourceHandler stop on `batch.length === 0`, so returning
      // short here silently abandons episodes for a feed that is being deleted
      // (audio-feed-m04, the audio-feed-4qj shape arriving through a changed seam).
      const limit = query.limit ?? 50;
      if (!Number.isFinite(limit)) return (await host().listEpisodePage(query)).episodes;

      const out: Episode[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await host().listEpisodePage({ ...query, limit, cursor });
        out.push(...page.episodes);
        if (out.length >= limit || !page.cursor || page.cursor === cursor) break;
        cursor = page.cursor;
      }
      return out.slice(0, limit);
    },
    async listEpisodePage(query: EpisodePage): Promise<EpisodePageResult> {
      const limit = query.limit ?? 50;
      const prefix = indexPrefix(core, query);

      const iter = core.kv.list<string>({ prefix }, {
        cursor: query.cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      // Keys are stored newest-first, so a plain ascending scan is already ordered.
      //
      // BATCHED reads (audio-feed-3jb): drain the (limit-bounded) index first, then fetch the
      // episodes in `getMany` chunks. Draining before fetching keeps the cursor semantics exactly
      // as they were — the cursor names the position after the last index entry this page
      // considered — while a page of N entries costs ceil(N / EPISODE_READ_BATCH) remote reads
      // instead of N serial `getEpisode` awaits.
      const ids: string[] = [];
      for await (const entry of iter) ids.push(entry.value);
      const cursor = iter.cursor && iter.cursor !== "" ? iter.cursor : undefined;

      const episodes: Episode[] = [];
      for (let start = 0; start < ids.length; start += EPISODE_READ_BATCH) {
        const chunk = ids.slice(start, start + EPISODE_READ_BATCH);
        const keys: Deno.KvKey[] = chunk.map((id) => ["episode", query.userId, id]);
        const rows = (await core.kv.getMany(keys)) as Deno.KvEntryMaybe<Episode>[];
        for (const row of rows) {
          const episode = row.value;
          if (!episode) continue;
          if (query.sourceId && episode.sourceId !== query.sourceId) continue;
          if (query.mode && episode.mode !== query.mode) continue;
          if (query.status && episode.status !== query.status) continue;
          episodes.push(episode);
          if (episodes.length >= limit) break;
        }
        if (episodes.length >= limit) break;
      }

      return { episodes, cursor };
    },
    async listPendingEpisodes(
      opts: ListPendingOptions = {},
    ): Promise<ListPendingResult> {
      const limit = opts.limit ?? 50;
      const nowMs = opts.nowMs ?? Date.now();
      const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;

      const episodes: Episode[] = [];

      // Native Deno KV iterator with cursor and limit — zero skip overhead (audio-feed-bbb, xxn)
      const iter = core.kv.list<{ userId: string; id: string }>(
        { prefix: ["pending_episodes"] },
        {
          cursor: opts.cursor,
          limit: Number.isFinite(limit) ? limit : undefined,
        },
      );

      for await (const entry of iter) {
        const { userId, id } = entry.value;
        const episode = await host().getEpisode(userId, id);
        if (episode && episode.status === "pending") {
          episodes.push(episode);
        }
      }

      const nextCursor = iter.cursor && iter.cursor !== "" ? iter.cursor : undefined;

      // Check synthesizing episodes with expired claims only on initial scan (cursor undefined)
      let mergedExpired = false;
      if (!opts.cursor && (!Number.isFinite(limit) || episodes.length < limit)) {
        for await (
          const entry of core.kv.list<{ userId: string; id: string }>({
            prefix: ["synthesizing_episodes"],
          })
        ) {
          const { userId, id } = entry.value;
          const episode = await host().getEpisode(userId, id);
          if (
            episode &&
            episode.status === "synthesizing" &&
            isClaimExpired(episode, nowMs, leaseMs)
          ) {
            episodes.push(episode);
            mergedExpired = true;
          }
        }
        // Re-sort ONLY when something was merged. The queue scan is already in priority order, and
        // this sort used to run unconditionally - which silently undid audio-feed-15e, because a
        // requeued episode's createdAt is old BY DESIGN, so sorting the whole result by date put
        // every regeneration back in front of the new article the queue key had just moved ahead.
        // When a merge is needed the order must be the queue's order: priority, then FIFO.
        if (mergedExpired) {
          episodes.sort((a, b) => {
            const ap = a.regenerating ? 1 : 0;
            const bp = b.regenerating ? 1 : 0;
            if (ap !== bp) return ap - bp;
            const timeDiff = a.createdAt.localeCompare(b.createdAt);
            return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
          });
        }
      }

      return {
        episodes: Number.isFinite(limit) ? episodes.slice(0, limit) : episodes,
        cursor: nextCursor,
      };
    },
    /**
     * Compare-and-swap claim. The `.check(entry)` is the entire point.
     *
     * A read-then-write lets two isolates both observe `pending`, both write
     * `synthesizing`, and both call a paid API for one episode — the second write
     * wins silently and the first synthesis is billed and thrown away
     * (audio-feed-vfs). The check makes the loser's commit fail against the
     * versionstamp it read, so exactly one worker proceeds.
     */
    async claimEpisode(
      userId: string,
      episodeId: string,
      claim: EpisodeClaim,
    ): Promise<Episode | null> {
      const key: Deno.KvKey = ["episode", userId, episodeId];
      const entry = await core.kv.get<Episode>(key);
      const found = entry.value;
      if (!found) return null;

      const nowMs = Date.parse(claim.now);
      const claimable = found.status === "pending" ||
        (found.status === "synthesizing" && isClaimExpired(found, nowMs, claim.leaseMs));
      if (!claimable) return null;

      const attempts = (found.attempts ?? 0) + 1;
      if (attempts > claim.maxClaims) {
        // Abandon rather than re-bill. Still checked, so this cannot clobber a
        // worker that legitimately claimed between our read and this write.
        // A regeneration goes back to ready on its old audio instead (audio-feed-8oz).
        //
        // audio-feed-bp6r: preserve the last recorded cause. Nine live episodes
        // showed only "abandoned after 3 attempts" because this write overwrote
        // whatever the last failing claim had recorded. When nothing was ever
        // recorded, say so plainly — that itself is the diagnostic (every claim
        // died before its terminal write).
        const prior = typeof found.error === "string" && found.error.length > 0
          ? found.error
          : null;
        const provenance = found.claimedAt
          ? `last claim by ${found.claimedBy ?? "unknown"} at ${found.claimedAt}`
          : "no claim details";
        const abandoned: Episode = {
          ...unsynthesized(
            found,
            prior
              ? `abandoned after ${claim.maxClaims} attempts; last recorded error: ${prior}`
              : `abandoned after ${claim.maxClaims} attempts; no claim recorded a cause (${provenance}) — ` +
                "each claim ended before its terminal write, so the worker died or its isolate was stopped mid-synthesis",
          ),
          claimedAt: undefined,
          claimedBy: undefined,
        };
        await atomicPutEpisode(core, abandoned, entry);
        return null;
      }

      const claimed: Episode = {
        ...found,
        status: "synthesizing",
        claimedAt: claim.now,
        claimedBy: claim.owner,
        attempts,
      };
      const ok = await atomicPutEpisode(core, claimed, entry);
      // A failed check means another worker won the race — the normal answer, not
      // an error. The caller moves on to the next job.
      return ok ? claimed : null;
    },
    async completeEpisode(episode: Episode, owner: string): Promise<boolean> {
      const key: Deno.KvKey = ["episode", episode.userId, episode.id];
      const entry = await core.kv.get<Episode>(key);
      const current = entry.value;
      // Superseded: the lease expired and another worker already finished this.
      // Writing anyway would overwrite the winner's audio with ours, silently.
      if (!current || current.status !== "synthesizing" || current.claimedBy !== owner) {
        return false;
      }
      return await atomicPutEpisode(core, episode, entry);
    },
    async retryEpisode(userId: string, id: string): Promise<Episode | null> {
      const entry = await core.kv.get<Episode>(["episode", userId, id]);
      const found = entry.value;
      // `failed` only, and the versionstamp check makes a concurrent claim or requeue win
      // rather than interleave.
      if (!found || found.status !== "failed") return null;
      const queued: Episode = {
        ...found,
        status: "pending",
        attempts: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
        error: undefined,
        // regenerating is NOT set: a failed render has no audio worth playing while it retries,
        // and setting it would put those bytes back into the subscriber's feed.
        regenerating: undefined,
      };
      return (await atomicPutEpisode(core, queued, entry)) ? queued : null;
    },
    /** Versionstamp-checked, so it cannot clobber a claim taken between read and write. */
    async requeueEpisode(userId: string, id: string): Promise<Episode | null> {
      const entry = await core.kv.get<Episode>(["episode", userId, id]);
      const found = entry.value;
      if (!found || found.status !== "ready" || !isPublishable(found)) return null;
      const queued: Episode = {
        ...found,
        status: "pending",
        regenerating: true,
        attempts: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
        error: undefined,
      };
      return (await atomicPutEpisode(core, queued, entry)) ? queued : null;
    },
    async cancelRegeneration(userId: string, id: string): Promise<boolean> {
      const entry = await core.kv.get<Episode>(["episode", userId, id]);
      const found = entry.value;
      if (
        !found?.regenerating || (found.status !== "pending" && found.status !== "synthesizing")
      ) {
        return false;
      }
      return await atomicPutEpisode(core, {
        ...found,
        status: "ready",
        regenerating: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
      }, entry);
    },
  };
}
