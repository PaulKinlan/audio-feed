/**
 * Cross-device playback state repository for Cloudflare D1.
 */

import type { PlaybackState } from "../../types.ts";
import {
  mergePlaybackStates,
  type PlaybackStatePatch,
  sanitizePlaybackState,
} from "../../playback_state.ts";
import type { MetadataStore, PlaybackStateRepository } from "../mod.ts";
import type { D1Core } from "./core.ts";

interface PlaybackStateRow {
  updated_at: string;
  data: string;
}

function safeParseState(raw: string): PlaybackState | null {
  try {
    const parsed = JSON.parse(raw) as PlaybackState;
    if (!parsed || typeof parsed !== "object") return null;
    return sanitizePlaybackState(parsed);
  } catch {
    return null;
  }
}

function isoFromEpoch(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : Date.now();
  return new Date(safe).toISOString();
}

export function createD1PlaybackStateRepository(
  core: D1Core,
  _host: () => MetadataStore,
): PlaybackStateRepository {
  return {
    async getPlaybackState(userId: string): Promise<PlaybackState | null> {
      const row = await core.db
        .prepare(`SELECT updated_at, data FROM playback_state WHERE user_id = ?`)
        .bind(userId)
        .first<PlaybackStateRow>();
      if (!row) return null;
      return safeParseState(row.data);
    },

    async putPlaybackState(userId: string, state: PlaybackState): Promise<void> {
      const sanitized = sanitizePlaybackState(state);
      const updatedAtIso = isoFromEpoch(sanitized.updatedAt);
      const serialized = JSON.stringify(sanitized);
      await core.db
        .prepare(
          `INSERT INTO playback_state (user_id, updated_at, data)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             data = excluded.data`,
        )
        .bind(userId, updatedAtIso, serialized)
        .run();
    },

    async mergePlaybackState(
      userId: string,
      incoming: PlaybackStatePatch,
    ): Promise<PlaybackState> {
      for (let attempt = 0; attempt < 16; attempt++) {
        const row = await core.db
          .prepare(`SELECT updated_at, data FROM playback_state WHERE user_id = ?`)
          .bind(userId)
          .first<PlaybackStateRow>();

        const existing = row ? safeParseState(row.data) : null;
        const merged = mergePlaybackStates(existing, incoming);
        const nextJson = JSON.stringify(merged);
        const nextUpdatedAt = isoFromEpoch(merged.updatedAt);

        if (row && row.data === nextJson && row.updated_at === nextUpdatedAt) {
          return merged;
        }

        const res = !row
          ? await core.db
            .prepare(
              `INSERT OR IGNORE INTO playback_state (user_id, updated_at, data)
               VALUES (?, ?, ?)`,
            )
            .bind(userId, nextUpdatedAt, nextJson)
            .run()
          : await core.db
            .prepare(
              `UPDATE playback_state
               SET updated_at = ?, data = ?
               WHERE user_id = ? AND updated_at = ? AND data = ?`,
            )
            .bind(nextUpdatedAt, nextJson, userId, row.updated_at, row.data)
            .run();

        if ((res.meta.changes ?? 0) === 1) {
          return merged;
        }

        if (attempt >= 2) {
          await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
        }
      }

      // Final fallback after repeated concurrent races: re-read, merge, and upsert.
      const latestRow = await core.db
        .prepare(`SELECT updated_at, data FROM playback_state WHERE user_id = ?`)
        .bind(userId)
        .first<PlaybackStateRow>();
      const existing = latestRow ? safeParseState(latestRow.data) : null;
      const merged = mergePlaybackStates(existing, incoming);
      await core.db
        .prepare(
          `INSERT INTO playback_state (user_id, updated_at, data)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             data = excluded.data`,
        )
        .bind(userId, isoFromEpoch(merged.updatedAt), JSON.stringify(merged))
        .run();
      return merged;
    },
  };
}
