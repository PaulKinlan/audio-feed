/**
 * Episodes: the queue, the claim that bounds paid work, completion, failure and regeneration.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import type { Episode } from "../../types.ts";
import type { ListPendingOptions, ListPendingResult } from "../mod.ts";
import type { EpisodePage, EpisodePageResult } from "../mod.ts";
import {
  DEFAULT_CLAIM_LEASE_MS,
  isClaimExpired,
  isPublishable,
  unsynthesized,
} from "../../types.ts";
import { type EpisodeClaim, type EpisodeQuery, type MetadataStore } from "../mod.ts";
import type { EpisodeRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";
import {
  binarySearchIndex,
  byNewestFirst,
  byOldestFirst,
  insertSortedIndex,
  removePendingPointer,
  removeSortedIndex,
  scoped,
  writeEpisode,
} from "./state.ts";

export function createEpisodesRepository(
  state: MemoryState,
  host: () => MetadataStore,
): EpisodeRepository {
  return {
    putEpisode(episode: Episode): Promise<void> {
      writeEpisode(state, episode);
      return Promise.resolve();
    },
    getEpisode(userId: string, id: string): Promise<Episode | null> {
      const found = state.episodes.get(scoped(userId, id));
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    deleteEpisode(userId: string, id: string): Promise<boolean> {
      const key = scoped(userId, id);
      const ep = state.episodes.get(key);
      if (!ep) return Promise.resolve(false);
      removePendingPointer(state, ep);
      removeSortedIndex(state.synthesizingIndex, `${ep.createdAt}\u0000${ep.id}`);
      state.episodes.delete(key);
      return Promise.resolve(true);
    },
    backfillEpisodeSourceTitle(
      userId: string,
      id: string,
      sourceTitle: string,
    ): Promise<boolean> {
      const key = scoped(userId, id);
      const ep = state.episodes.get(key);
      if (!ep) return Promise.resolve(false);
      if (!ep.sourceTitle) ep.sourceTitle = sourceTitle;
      return Promise.resolve(true);
    },
    updateEpisodeAudioKeyIfCurrent(
      userId: string,
      id: string,
      expectedKey: string,
      newKey: string,
    ): Promise<boolean> {
      const key = scoped(userId, id);
      const ep = state.episodes.get(key);
      if (!ep) return Promise.resolve(false);
      if (ep.audioKey !== expectedKey) return Promise.resolve(false);
      ep.audioKey = newKey;
      return Promise.resolve(true);
    },
    listEpisodes(query: EpisodeQuery): Promise<Episode[]> {
      return host().listEpisodePage(query).then((page) => page.episodes);
    },
    listEpisodePage(query: EpisodePage): Promise<EpisodePageResult> {
      const limit = query.limit ?? 50;
      const matches = [...state.episodes.values()]
        .filter((e) => e.userId === query.userId)
        .filter((e) => !query.sourceId || e.sourceId === query.sourceId)
        .filter((e) => !query.mode || e.mode === query.mode)
        .filter((e) => !query.status || e.status === query.status)
        .sort(byNewestFirst);
      // Cursor is the last returned episode's position in the total order, NOT an
      // array index: the array is rebuilt per call, so a concurrent delete behind
      // an index cursor shifts it and silently skips an episode — the exact
      // unrecoverable-skip class audio-feed-c9q was filed for, which this paging
      // exists to remove. (listPendingEpisodes still uses an index cursor; that is
      // audio-feed-7li's scope, and its worker caller tolerates a revisit.)
      let from = 0;
      if (query.cursor) {
        const at = query.cursor.lastIndexOf("|");
        const createdAt = at < 0 ? "" : query.cursor.slice(0, at);
        const id = at < 0 ? "" : query.cursor.slice(at + 1);
        const anchor = { createdAt, id };
        // First episode that sorts strictly AFTER the anchor (newest-first order).
        from = matches.findIndex((e) => byNewestFirst(anchor, e) < 0);
        if (from === -1) from = matches.length;
      }
      const end = Number.isFinite(limit) ? from + limit : matches.length;
      const episodes = matches.slice(from, end).map((e) => structuredClone(e));
      const last = episodes.at(-1);
      return Promise.resolve({
        episodes,
        cursor: end < matches.length && last ? `${last.createdAt}|${last.id}` : undefined,
      });
    },
    async listPendingEpisodes(
      opts: ListPendingOptions = {},
    ): Promise<ListPendingResult> {
      const limit = opts.limit ?? 50;
      const nowMs = opts.nowMs ?? Date.now();
      const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;

      let startIndex = 0;
      if (opts.cursor) {
        if (/^\d+$/.test(opts.cursor)) {
          startIndex = parseInt(opts.cursor, 10);
        } else {
          const idx = binarySearchIndex(state.pendingIndex, opts.cursor);
          startIndex = idx >= 0 ? idx + 1 : ~idx;
        }
      }

      const episodes: Episode[] = [];
      let currentIndex = startIndex;

      while (currentIndex < state.pendingIndex.length) {
        if (Number.isFinite(limit) && episodes.length >= limit) break;
        const entry = state.pendingIndex[currentIndex];
        currentIndex++;
        if (!entry) break;
        const ep = await host().getEpisode(entry.userId, entry.id);
        if (ep && ep.status === "pending") {
          episodes.push(ep);
        }
      }

      const last = state.pendingIndex[currentIndex - 1];
      const nextCursor = currentIndex < state.pendingIndex.length && last && episodes.length > 0
        ? last.sortKey
        : undefined;

      // Check synthesizing episodes with expired claims only on initial scan (cursor undefined),
      // matching KvMetadataStore behaviour
      if (!opts.cursor && (!Number.isFinite(limit) || episodes.length < limit)) {
        let addedExpired = false;
        for (const entry of state.synthesizingIndex) {
          if (Number.isFinite(limit) && episodes.length >= limit) break;
          const ep = await host().getEpisode(entry.userId, entry.id);
          if (
            ep &&
            ep.status === "synthesizing" &&
            isClaimExpired(ep, nowMs, leaseMs)
          ) {
            episodes.push(ep);
            addedExpired = true;
          }
        }
        if (addedExpired) {
          episodes.sort(byOldestFirst);
        }
      }

      return { episodes, cursor: nextCursor };
    },
    /**
     * Single-threaded JS makes this trivially atomic: nothing can interleave
     * between the read and the write because there is no `await` between them.
     *
     * That is precisely why it must be written carefully rather than casually —
     * a memory adapter that grants a claim the KV adapter would refuse lets the
     * conformance suite pass while production double-spends, which is the exact
     * failure the suite exists to prevent.
     */
    claimEpisode(userId: string, episodeId: string, claim: EpisodeClaim): Promise<Episode | null> {
      const key = scoped(userId, episodeId);
      const found = state.episodes.get(key);
      if (!found) return Promise.resolve(null);

      const nowMs = Date.parse(claim.now);
      const claimable = found.status === "pending" ||
        (found.status === "synthesizing" && isClaimExpired(found, nowMs, claim.leaseMs));
      if (!claimable) return Promise.resolve(null);

      const oldSortKey = `${found.createdAt}\u0000${found.id}`;
      const attempts = (found.attempts ?? 0) + 1;
      if (attempts > claim.maxClaims) {
        // Abandon rather than re-bill: an input that keeps killing its host would
        // otherwise be re-claimed forever on lease expiry.
        // audio-feed-bp6r: preserve the last recorded cause rather than overwriting
        // it with the bare attempt count (see kv.ts claimEpisode for the full note).
        const prior = typeof found.error === "string" && found.error.length > 0
          ? found.error
          : null;
        const provenance = found.claimedAt
          ? `last claim by ${found.claimedBy ?? "unknown"} at ${found.claimedAt}`
          : "no claim details";
        removePendingPointer(state, found);
        removeSortedIndex(state.synthesizingIndex, oldSortKey);
        state.episodes.set(key, {
          ...unsynthesized(
            structuredClone(found),
            prior
              ? `abandoned after ${claim.maxClaims} attempts; last recorded error: ${prior}`
              : `abandoned after ${claim.maxClaims} attempts; no claim recorded a cause (${provenance}) — ` +
                "each claim ended before its terminal write, so the worker died or its isolate was stopped mid-synthesis",
          ),
          claimedAt: undefined,
          claimedBy: undefined,
        });
        return Promise.resolve(null);
      }

      const claimed: Episode = {
        ...structuredClone(found),
        status: "synthesizing",
        claimedAt: claim.now,
        claimedBy: claim.owner,
        attempts,
      };
      removePendingPointer(state, found);
      insertSortedIndex(state.synthesizingIndex, {
        sortKey: oldSortKey,
        userId,
        id: episodeId,
      });
      state.episodes.set(key, claimed);
      return Promise.resolve(structuredClone(claimed));
    },
    completeEpisode(episode: Episode, owner: string): Promise<boolean> {
      const key = scoped(episode.userId, episode.id);
      const current = state.episodes.get(key);
      // Superseded: another worker reclaimed the expired lease and finished first.
      if (!current || current.status !== "synthesizing" || current.claimedBy !== owner) {
        return Promise.resolve(false);
      }
      const sortKey = `${current.createdAt}\u0000${current.id}`;
      removeSortedIndex(state.synthesizingIndex, sortKey);
      removePendingPointer(state, current);
      state.episodes.set(key, structuredClone(episode));
      return Promise.resolve(true);
    },
    retryEpisode(userId: string, id: string): Promise<Episode | null> {
      const key = scoped(userId, id);
      const found = state.episodes.get(key);
      if (!found || found.status !== "failed") return Promise.resolve(null);
      const queued: Episode = {
        ...structuredClone(found),
        status: "pending",
        attempts: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
        error: undefined,
        regenerating: undefined,
      };
      // No await between the read and the write, so this is as single-stepped as the KV
      // versionstamp check it is matching (see the note above #writeEpisode).
      writeEpisode(state, queued);
      return Promise.resolve(structuredClone(queued));
    },
    requeueEpisode(userId: string, id: string): Promise<Episode | null> {
      const found = state.episodes.get(scoped(userId, id));
      if (!found || found.status !== "ready" || !isPublishable(found)) {
        return Promise.resolve(null);
      }
      const queued: Episode = {
        ...structuredClone(found),
        status: "pending",
        regenerating: true,
        attempts: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
        error: undefined,
      };
      writeEpisode(state, queued);
      return Promise.resolve(structuredClone(queued));
    },
    cancelRegeneration(userId: string, id: string): Promise<boolean> {
      const found = state.episodes.get(scoped(userId, id));
      if (
        !found?.regenerating || (found.status !== "pending" && found.status !== "synthesizing")
      ) {
        return Promise.resolve(false);
      }
      writeEpisode(state, {
        ...found,
        status: "ready",
        regenerating: undefined,
        claimedAt: undefined,
        claimedBy: undefined,
      });
      return Promise.resolve(true);
    },
  };
}
