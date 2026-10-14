/**
 * Synthesis segments: the per-segment reservation that stops a retried episode paying twice.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import type { SynthesisSegmentRecord } from "../../types.ts";
import { isClaimExpired } from "../../types.ts";
import { type MetadataStore } from "../mod.ts";
import type { SynthesisSegmentRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";
import { scoped, slotKeyFor } from "./state.ts";

export function createSegmentsRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): SynthesisSegmentRepository {
  return {
    reserveSynthesisSegment(
      userId: string,
      episodeId: string,
      record: SynthesisSegmentRecord,
      nowMs: number,
      leaseMs: number,
    ): Promise<"reserved" | "finalized" | "no-claim"> {
      const episode = state.episodes.get(scoped(userId, episodeId));
      // Spend guard: only the live claimant reserves. A superseded worker's reserve is
      // refused here, not at finalize, so it never reaches the paid call.
      if (
        !episode || episode.status !== "synthesizing" || episode.claimedBy !== record.owner ||
        isClaimExpired(episode, nowMs, leaseMs)
      ) {
        return Promise.resolve("no-claim");
      }
      const key = scoped(userId, episodeId);
      let slots = state.segments.get(key);
      if (!slots) {
        slots = new Map();
        state.segments.set(key, slots);
      }
      const slotKey = slotKeyFor(record);
      const current = slots.get(slotKey);
      if (current?.finalized) return Promise.resolve("finalized");
      // A reservation by anyone other than the live claimant is by definition left by a
      // claim that has since moved on: stealable, like an expired episode lease.
      slots.set(slotKey, structuredClone(record));
      return Promise.resolve("reserved");
    },
    finalizeSynthesisSegment(
      userId: string,
      episodeId: string,
      slot: { textHash: string; promptVersion: string; voice: string },
      audio: { audioKey: string; byteLength: number },
      owner: string,
      nowMs: number,
      leaseMs: number,
    ): Promise<boolean> {
      const episode = state.episodes.get(scoped(userId, episodeId));
      if (
        !episode || episode.status !== "synthesizing" || episode.claimedBy !== owner ||
        isClaimExpired(episode, nowMs, leaseMs)
      ) {
        return Promise.resolve(false);
      }
      const slots = state.segments.get(scoped(userId, episodeId));
      const current = slots?.get(slotKeyFor(slot));
      if (!current || current.finalized || current.owner !== owner) return Promise.resolve(false);
      slots!.set(slotKeyFor(slot), {
        ...structuredClone(current),
        audioKey: audio.audioKey,
        byteLength: audio.byteLength,
        finalized: true,
      });
      // audio-feed-sp38: Durable progress resets attempts to 0 on segment finalization,
      // ensuring an isolate killed or lease expired on a later segment gets fresh attempts.
      episode.attempts = 0;
      return Promise.resolve(true);
    },
    listSynthesisSegments(userId: string, episodeId: string): Promise<SynthesisSegmentRecord[]> {
      const slots = state.segments.get(scoped(userId, episodeId));
      return Promise.resolve([...(slots?.values() ?? [])].map((r) => structuredClone(r)));
    },
    clearSynthesisSegments(userId: string, episodeId: string): Promise<void> {
      state.segments.delete(scoped(userId, episodeId));
      return Promise.resolve();
    },
  };
}
