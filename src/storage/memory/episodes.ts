/**
 * Episodes: the queue, the claim that bounds paid work, completion, failure and regeneration.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import {
  abandonedClaimEvent,
  CLAIM_START_PHASE,
  claimLifecycleEvent,
  elapsedSince,
} from "../episode_events.ts";
import type { Episode } from "../../types.ts";
import type { ListPendingOptions, ListPendingResult } from "../mod.ts";
import type { EpisodePage, EpisodePageResult } from "../mod.ts";
import {
  DEFAULT_CLAIM_LEASE_MS,
  isClaimExpired,
  isPublishable,
  unsynthesized,
} from "../../types.ts";
import {
  type EpisodeBilling,
  type EpisodeClaim,
  type EpisodeQuery,
  type MetadataStore,
} from "../mod.ts";
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
      const isExpired = found.status === "synthesizing" &&
        isClaimExpired(found, nowMs, claim.leaseMs);
      const claimable = found.status === "pending" || isExpired;
      if (!claimable) return Promise.resolve(null);

      const oldSortKey = `${found.createdAt}\u0000${found.id}`;
      const attempts = (found.attempts ?? 0) + 1;
      const prior = typeof found.error === "string" && found.error.length > 0 ? found.error : null;

      // audio-feed-siv1 / audio-feed-kd5r: If previous claim expired before its terminal write,
      // record observed facts: expiry, last heartbeat, phase, and attempt count.
      // Never claim "worker died" or "isolate killed" as fact when only lease expiry is known.
      const expiredPhase = found.phase ?? "claimed";
      const expiredHeartbeat = found.lastHeartbeat ?? found.claimedAt ?? "unknown";
      const expiredAttempt = found.attempts ?? 1;
      const expiredProvenance = found.claimedAt
        ? `by ${found.claimedBy ?? "unknown"} at ${found.claimedAt}`
        : "no claim details";
      const expiredMsg =
        `claim ${expiredAttempt} (${expiredProvenance}) lease expired without terminal write in phase "${expiredPhase}" (last heartbeat ${expiredHeartbeat}); worker state unknown (stopped, evicted, or running)`;
      const accumulatedError = isExpired
        ? (prior && prior.includes(expiredMsg)
          ? prior
          : (prior ? `${prior}; ${expiredMsg}` : expiredMsg))
        : prior;

      if (attempts > claim.maxClaims) {
        // Abandon rather than re-bill: an input that keeps killing its host would
        // otherwise be re-claimed forever on lease expiry.
        // audio-feed-siv1 / audio-feed-kd5r / audio-feed-bp6r: persist WHY the episode failed:
        // reason + phase + attempt count + provenance + attempt history.
        const abandonedReason = accumulatedError
          ? `abandoned after ${claim.maxClaims} attempts; reason: claim lease expired without terminal write in phase "${expiredPhase}"; history: [${accumulatedError}]`
          : `abandoned after ${claim.maxClaims} attempts; reason: claim lease expired without terminal write in phase "${expiredPhase}" (${expiredProvenance}); worker state unknown (stopped, evicted, or running)`;

        removePendingPointer(state, found);
        removeSortedIndex(state.synthesizingIndex, oldSortKey);
        const abandoned: Episode = {
          ...unsynthesized(
            structuredClone(found),
            abandonedReason,
          ),
          claimedAt: undefined,
          claimedBy: undefined,
          phase: found.phase,
          lastHeartbeat: found.lastHeartbeat,
        };
        state.episodes.set(key, abandoned);
        return host().appendLog(
          abandonedClaimEvent(abandoned, {
            phase: expiredPhase,
            attempt: expiredAttempt,
            reason: expiredMsg,
            ...(found.claimedAt && !Number.isNaN(Date.parse(found.claimedAt))
              ? { expiredAt: new Date(Date.parse(found.claimedAt) + claim.leaseMs).toISOString() }
              : {}),
            lastHeartbeat: expiredHeartbeat,
            provenance: expiredProvenance,
            maxClaims: claim.maxClaims,
          }),
        ).then(() => null);
      }

      const claimed: Episode = {
        ...structuredClone(found),
        status: "synthesizing",
        claimedAt: claim.now,
        claimedBy: claim.owner,
        lastHeartbeat: claim.now,
        phase: "claimed",
        attempts,
        error: accumulatedError ?? undefined,
      };
      removePendingPointer(state, found);
      insertSortedIndex(state.synthesizingIndex, {
        sortKey: oldSortKey,
        userId,
        id: episodeId,
      });
      state.episodes.set(key, claimed);
      return host()
        .appendLog(claimLifecycleEvent(claimed, {
          phase: CLAIM_START_PHASE,
          attempt: attempts,
          // Same fields the KV adapter writes, for the same reason (audio-feed-n6uu): the owner of
          // a past attempt and the lease it ran under are otherwise not durable anywhere.
          context: { owner: claim.owner, leaseMs: claim.leaseMs, maxClaims: claim.maxClaims },
          // Same instant the episode records as claimedAt, so the lease the page computes and the
          // lease the store enforces cannot disagree (audio-feed-n6uu).
          time: claim.now,
        }))
        .then(() => structuredClone(claimed));
    },
    touchEpisodeClaim(
      userId: string,
      episodeId: string,
      owner: string,
      update: {
        phase?: string;
        now?: string;
        scriptTurns?: Array<{ speaker: string; text: string }>;
      },
    ): Promise<boolean> {
      const key = scoped(userId, episodeId);
      const current = state.episodes.get(key);
      if (!current || current.status !== "synthesizing" || current.claimedBy !== owner) {
        return Promise.resolve(false);
      }
      const previousPhase = current.phase;
      current.lastHeartbeat = update.now ?? new Date().toISOString();
      if (update.phase) current.phase = update.phase;
      if (update.scriptTurns) current.scriptTurns = update.scriptTurns;
      if (update.phase && update.phase !== previousPhase) {
        return host()
          .appendLog(
            claimLifecycleEvent(current, {
              phase: update.phase,
              attempt: current.attempts ?? 1,
              time: current.lastHeartbeat,
            }),
          )
          .then(() => true);
      }
      return Promise.resolve(true);
    },
    yieldEpisodeClaim(
      userId: string,
      episodeId: string,
      owner: string,
      update?: {
        phase?: string;
        now?: string;
        advanceAttempts?: boolean;
        uploadRetry?: number;
        incrementUploadRetry?: boolean;
      },
    ): Promise<boolean> {
      const key = scoped(userId, episodeId);
      const current = state.episodes.get(key);
      if (!current || current.status !== "synthesizing" || current.claimedBy !== owner) {
        return Promise.resolve(false);
      }
      const oldSortKey = `${current.createdAt}\u0000${current.id}`;
      removeSortedIndex(state.synthesizingIndex, oldSortKey);
      const yielded: Episode = {
        ...current,
        status: "pending",
        claimedAt: undefined,
        claimedBy: undefined,
        phase: update?.phase ?? current.phase,
        lastHeartbeat: update?.now ?? new Date().toISOString(),
        attempts: update?.advanceAttempts ? (current.attempts ?? 0) : 0,
        uploadRetry: update?.uploadRetry !== undefined
          ? update.uploadRetry
          : update?.incrementUploadRetry
          ? (current.uploadRetry ?? 0) + 1
          : current.uploadRetry,
      };
      writeEpisode(state, yielded);
      return Promise.resolve(true);
    },
    async completeEpisode(
      episode: Episode,
      owner: string,
      billing?: EpisodeBilling,
    ): Promise<boolean> {
      // Invariant enforcement (audio-feed-9gqs):
      // A transition to "ready" requires a billing payload at the storage boundary.
      // Unsynthesized/failed transitions (which carry episode.error) may omit billing.
      if (
        episode.status === "ready" &&
        !episode.error &&
        (!billing || typeof billing.byteLength !== "number")
      ) {
        throw new TypeError(
          `completeEpisode requires a valid billing payload ({ byteLength: number }) when completing with status "ready" (audio-feed-9gqs)`,
        );
      }
      const key = scoped(episode.userId, episode.id);
      const current = state.episodes.get(key);
      if (!current) return false;
      // Idempotent completion: only if already marked ready with this exact audioKey by THIS owner
      if (
        current.status === "ready" && current.audioKey === episode.audioKey &&
        current.claimedBy === owner
      ) {
        return true;
      }
      // Superseded: another worker reclaimed the expired lease and finished first.
      if (current.status !== "synthesizing" || current.claimedBy !== owner) {
        return false;
      }

      // Atomic terminal billing (audio-feed-thrs, audio-feed-a7i9):
      // Must record synthesis before or atomically with episode state.
      // If billing fails, the completion fails, rethrows, and nothing is marked ready.
      if (billing && episode.status === "ready") {
        await host().recordSynthesis(episode.userId, billing.byteLength, billing.at);
      }

      const sortKey = `${current.createdAt}\u0000${current.id}`;
      removeSortedIndex(state.synthesizingIndex, sortKey);
      removePendingPointer(state, current);
      state.episodes.set(key, structuredClone({ ...episode, claimedBy: owner }));
      return host()
        .appendLog(
          claimLifecycleEvent(episode, {
            phase: episode.phase ?? CLAIM_START_PHASE,
            attempt: episode.attempts ?? 1,
            durationMs: elapsedSince(current.claimedAt),
            // The outcome lives in the reason so the terminal moment does not need its own event
            // type: a clean finish states no reason, a failure states the episode's own error.
            ...(episode.status === "failed"
              ? {
                reason: episode.error ?? "synthesis failed without a recorded error",
                severity: "error" as const,
              }
              : {}),
          }),
        )
        .then(() => true);
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
        phase: undefined,
        lastHeartbeat: undefined,
        scriptTurns: undefined,
        regenerating: undefined,
        uploadRetry: undefined,
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
        phase: undefined,
        lastHeartbeat: undefined,
        scriptTurns: undefined,
        uploadRetry: undefined,
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
        phase: "ready",
        lastHeartbeat: undefined,
        scriptTurns: undefined,
      });
      return Promise.resolve(true);
    },
  };
}
