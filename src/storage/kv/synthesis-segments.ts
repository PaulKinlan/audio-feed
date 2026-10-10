/**
 * Synthesis segments: the per-segment reservation that stops a retried episode paying twice.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { Episode } from "../../types.ts";
import type { MetadataStore, SynthesisSegmentRepository } from "../mod.ts";
import type { KvCore } from "./core.ts";
import { isClaimExpired, SynthesisSegmentRecord } from "../../types.ts";

export function createSegmentsRepository(
  core: KvCore,
  _host: () => MetadataStore,
): SynthesisSegmentRepository {
  return {
    /**
     * Segment reservation with TWO versionstamp checks (audio-feed-wr1u): the episode entry
     * (the claim this worker read must still be its claim) and the segment slot (nobody
     * reserved or finalized it since we looked). A failed commit means the world moved under
     * us — re-read once to classify, because "finalized" is a reuse answer, not a retry.
     */
    async reserveSynthesisSegment(
      userId: string,
      episodeId: string,
      record: SynthesisSegmentRecord,
      nowMs: number,
      leaseMs: number,
    ): Promise<"reserved" | "finalized" | "no-claim"> {
      const episodeKey: Deno.KvKey = ["episode", userId, episodeId];
      const segmentKey: Deno.KvKey = [
        "synthesis-segment",
        userId,
        episodeId,
        record.textHash,
        record.promptVersion,
        record.voice,
      ];
      const [episodeEntry, segmentEntry] = await Promise.all([
        core.kv.get<Episode>(episodeKey),
        core.kv.get<SynthesisSegmentRecord>(segmentKey),
      ]);
      const episode = episodeEntry.value;
      if (
        !episode || episode.status !== "synthesizing" || episode.claimedBy !== record.owner ||
        isClaimExpired(episode, nowMs, leaseMs)
      ) {
        return "no-claim";
      }
      if (segmentEntry.value?.finalized) return "finalized";
      const ok = await core.kv.atomic()
        .check(episodeEntry)
        .check(segmentEntry)
        .set(segmentKey, record)
        .commit();
      if (ok) return "reserved";
      // Lost the race: classify against the current world. A finalized slot is reusable
      // audio; anything else means this worker no longer owns the spend.
      const nowSegment = await core.kv.get<SynthesisSegmentRecord>(segmentKey);
      return nowSegment.value?.finalized ? "finalized" : "no-claim";
    },
    async finalizeSynthesisSegment(
      userId: string,
      episodeId: string,
      slot: { textHash: string; promptVersion: string; voice: string },
      audio: { audioKey: string; byteLength: number },
      owner: string,
      nowMs: number,
      leaseMs: number,
    ): Promise<boolean> {
      const episodeKey: Deno.KvKey = ["episode", userId, episodeId];
      const segmentKey: Deno.KvKey = [
        "synthesis-segment",
        userId,
        episodeId,
        slot.textHash,
        slot.promptVersion,
        slot.voice,
      ];
      const [episodeEntry, segmentEntry] = await Promise.all([
        core.kv.get<Episode>(episodeKey),
        core.kv.get<SynthesisSegmentRecord>(segmentKey),
      ]);
      const episode = episodeEntry.value;
      const current = segmentEntry.value;
      if (
        !episode || episode.status !== "synthesizing" || episode.claimedBy !== owner ||
        isClaimExpired(episode, nowMs, leaseMs)
      ) {
        return false;
      }
      if (!current || current.finalized || current.owner !== owner) return false;
      const finalized: SynthesisSegmentRecord = {
        ...current,
        audioKey: audio.audioKey,
        byteLength: audio.byteLength,
        finalized: true,
      };
      const committed = await core.kv.atomic()
        .check(episodeEntry)
        .check(segmentEntry)
        .set(segmentKey, finalized)
        .commit();
      return committed.ok;
    },
    async listSynthesisSegments(
      userId: string,
      episodeId: string,
    ): Promise<SynthesisSegmentRecord[]> {
      const records: SynthesisSegmentRecord[] = [];
      for await (
        const entry of core.kv.list<SynthesisSegmentRecord>({
          prefix: ["synthesis-segment", userId, episodeId],
        })
      ) {
        if (entry.value) records.push(entry.value);
      }
      return records;
    },
    async clearSynthesisSegments(userId: string, episodeId: string): Promise<void> {
      // Best-effort sweep after the stitched audio is committed; a record left behind is
      // inert (text-hash keyed, prompt-version and voice gated) and its blob is deleted by
      // the caller, which records orphans on failure.
      const deletes: Deno.KvKey[] = [];
      for await (
        const entry of core.kv.list<SynthesisSegmentRecord>({
          prefix: ["synthesis-segment", userId, episodeId],
        })
      ) {
        deletes.push(entry.key);
      }
      for (const key of deletes) await core.kv.delete(key);
    },
  };
}
