/**
 * Synthesis segments repository for Cloudflare D1.
 */

import type { Episode, SynthesisSegmentRecord } from "../../types.ts";
import { isClaimExpired } from "../../types.ts";
import type { MetadataStore, SynthesisSegmentRepository } from "../mod.ts";
import type { D1Core } from "./core.ts";

interface EpisodeRow {
  data: string;
  version: number;
}

interface SegmentRow {
  data: string;
  version: number;
  finalized: number;
}

export function createD1SegmentsRepository(
  core: D1Core,
  _host: () => MetadataStore,
): SynthesisSegmentRepository {
  return {
    async reserveSynthesisSegment(
      userId: string,
      episodeId: string,
      record: SynthesisSegmentRecord,
      nowMs: number,
      leaseMs: number,
    ): Promise<"reserved" | "finalized" | "no-claim"> {
      const [epRow, segRow] = await Promise.all([
        core.db.prepare(`SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`)
          .bind(userId, episodeId)
          .first<EpisodeRow>(),
        core.db.prepare(
          `SELECT data, version, finalized FROM synthesis_segments
           WHERE user_id = ? AND episode_id = ? AND text_hash = ? AND prompt_version = ? AND voice = ?`,
        ).bind(userId, episodeId, record.textHash, record.promptVersion, record.voice)
          .first<SegmentRow>(),
      ]);

      const episode = epRow ? (JSON.parse(epRow.data) as Episode) : null;
      if (
        !episode || episode.status !== "synthesizing" || episode.claimedBy !== record.owner ||
        isClaimExpired(episode, nowMs, leaseMs)
      ) {
        return "no-claim";
      }
      if (segRow && segRow.finalized === 1) return "finalized";

      const res = segRow
        ? await core.db.prepare(
          `UPDATE synthesis_segments
           SET owner = ?, finalized = 0, version = ?, data = ?
           WHERE user_id = ? AND episode_id = ? AND text_hash = ? AND prompt_version = ? AND voice = ?
             AND version = ? AND finalized = 0
             AND EXISTS (
               SELECT 1 FROM episodes
               WHERE user_id = ? AND id = ? AND version = ?
                 AND status = 'synthesizing' AND claimed_by = ?
             )`,
        ).bind(
          record.owner,
          segRow.version + 1,
          JSON.stringify(record),
          userId,
          episodeId,
          record.textHash,
          record.promptVersion,
          record.voice,
          segRow.version,
          userId,
          episodeId,
          epRow!.version,
          record.owner,
        ).run()
        : await core.db.prepare(
          `INSERT OR IGNORE INTO synthesis_segments
           (user_id, episode_id, text_hash, prompt_version, voice, finalized, owner, version, data)
           SELECT ?, ?, ?, ?, ?, 0, ?, 1, ?
           WHERE EXISTS (
             SELECT 1 FROM episodes
             WHERE user_id = ? AND id = ? AND version = ?
               AND status = 'synthesizing' AND claimed_by = ?
           )`,
        ).bind(
          userId,
          episodeId,
          record.textHash,
          record.promptVersion,
          record.voice,
          record.owner,
          JSON.stringify(record),
          userId,
          episodeId,
          epRow!.version,
          record.owner,
        ).run();

      if ((res.meta.changes ?? 0) === 1) return "reserved";

      const nowSeg = await core.db.prepare(
        `SELECT finalized FROM synthesis_segments
         WHERE user_id = ? AND episode_id = ? AND text_hash = ? AND prompt_version = ? AND voice = ?`,
      ).bind(userId, episodeId, record.textHash, record.promptVersion, record.voice)
        .first<{ finalized: number }>();
      return nowSeg?.finalized === 1 ? "finalized" : "no-claim";
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
      const [epRow, segRow] = await Promise.all([
        core.db.prepare(`SELECT data, version FROM episodes WHERE user_id = ? AND id = ?`)
          .bind(userId, episodeId)
          .first<EpisodeRow>(),
        core.db.prepare(
          `SELECT data, version, finalized FROM synthesis_segments
           WHERE user_id = ? AND episode_id = ? AND text_hash = ? AND prompt_version = ? AND voice = ?`,
        ).bind(userId, episodeId, slot.textHash, slot.promptVersion, slot.voice)
          .first<SegmentRow>(),
      ]);

      const episode = epRow ? (JSON.parse(epRow.data) as Episode) : null;
      const current = segRow ? (JSON.parse(segRow.data) as SynthesisSegmentRecord) : null;
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
      const updatedEpisode: Episode = {
        ...episode,
        attempts: 0,
      };
      const nextSegVersion = segRow!.version + 1;
      const nextEpVersion = epRow!.version + 1;

      const results = await core.db.batch([
        core.db.prepare(
          `UPDATE synthesis_segments
           SET finalized = 1, version = ?, data = ?
           WHERE user_id = ? AND episode_id = ? AND text_hash = ? AND prompt_version = ? AND voice = ?
             AND version = ? AND finalized = 0 AND owner = ?
             AND EXISTS (
               SELECT 1 FROM episodes
               WHERE user_id = ? AND id = ? AND version = ?
                 AND status = 'synthesizing' AND claimed_by = ?
             )`,
        ).bind(
          nextSegVersion,
          JSON.stringify(finalized),
          userId,
          episodeId,
          slot.textHash,
          slot.promptVersion,
          slot.voice,
          segRow!.version,
          owner,
          userId,
          episodeId,
          epRow!.version,
          owner,
        ),
        core.db.prepare(
          `UPDATE episodes
           SET version = ?, data = ?
           WHERE user_id = ? AND id = ? AND version = ?
             AND EXISTS (
               SELECT 1 FROM synthesis_segments
               WHERE user_id = ? AND episode_id = ? AND text_hash = ? AND prompt_version = ? AND voice = ?
                 AND version = ? AND finalized = 1
             )`,
        ).bind(
          nextEpVersion,
          JSON.stringify(updatedEpisode),
          userId,
          episodeId,
          epRow!.version,
          userId,
          episodeId,
          slot.textHash,
          slot.promptVersion,
          slot.voice,
          nextSegVersion,
        ),
      ]);

      return (results[0]?.meta.changes ?? 0) === 1;
    },

    async listSynthesisSegments(
      userId: string,
      episodeId: string,
    ): Promise<SynthesisSegmentRecord[]> {
      const res = await core.db.prepare(
        `SELECT data FROM synthesis_segments
         WHERE user_id = ? AND episode_id = ?
         ORDER BY text_hash ASC, prompt_version ASC, voice ASC`,
      ).bind(userId, episodeId).all<{ data: string }>();
      return res.results.map((r) => JSON.parse(r.data) as SynthesisSegmentRecord);
    },

    async clearSynthesisSegments(userId: string, episodeId: string): Promise<void> {
      await core.db.prepare(
        `DELETE FROM synthesis_segments WHERE user_id = ? AND episode_id = ?`,
      ).bind(userId, episodeId).run();
    },
  };
}
