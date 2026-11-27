/**
 * Operational counters repository (downloads & synthesis spend) for Cloudflare D1.
 */

import type { SynthesisCounts } from "../../types.ts";
import { utcDayKey } from "../../types.ts";
import type { DownloadCounts, MetadataStore, UsageRepository } from "../mod.ts";
import type { D1Core } from "./core.ts";

export const DOWNLOAD_TOTAL_KEY = "download_total";
export const DOWNLOAD_USER_PREFIX = "download_by_user:";
export const SYNTHESIS_TOTAL_KEY = "synthesis_total";
export const SYNTHESIS_TOTAL_BYTES_KEY = "synthesis_total_bytes";
export const SYNTHESIS_USER_PREFIX = "synthesis_by_user:";
export const SYNTHESIS_USER_BYTES_PREFIX = "synthesis_bytes_by_user:";
export const SYNTHESIS_DAILY_PREFIX = "synthesis_daily:";
export const SYNTHESIS_DAILY_ALL_PREFIX = "synthesis_daily_all:";

export function synthesisDailyUserKey(userId: string, day: string): string {
  return `${SYNTHESIS_DAILY_PREFIX}${userId}:${day}`;
}

export function synthesisDailyAllKey(day: string): string {
  return `${SYNTHESIS_DAILY_ALL_PREFIX}${day}`;
}

export function createD1UsageRepository(
  core: D1Core,
  _host: () => MetadataStore,
): UsageRepository {
  return {
    async recordDownload(userId: string | null): Promise<void> {
      try {
        const stmts = [
          core.db.prepare(
            `INSERT INTO usage_counters (key, value) VALUES (?, 1)
             ON CONFLICT(key) DO UPDATE SET value = value + 1`,
          ).bind(DOWNLOAD_TOTAL_KEY),
        ];
        if (userId) {
          stmts.push(
            core.db.prepare(
              `INSERT INTO usage_counters (key, value) VALUES (?, 1)
               ON CONFLICT(key) DO UPDATE SET value = value + 1`,
            ).bind(`${DOWNLOAD_USER_PREFIX}${userId}`),
          );
        }
        await core.db.batch(stmts);
      } catch {
        // Telemetry must never fail an audio download.
      }
    },

    async getDownloadCounts(): Promise<DownloadCounts> {
      const [totalRow, userRows] = await Promise.all([
        core.db.prepare(`SELECT value FROM usage_counters WHERE key = ?`)
          .bind(DOWNLOAD_TOTAL_KEY)
          .first<{ value: number }>(),
        core.db.prepare(
          `SELECT key, value FROM usage_counters WHERE key >= ? AND key < ?`,
        ).bind(DOWNLOAD_USER_PREFIX, `${DOWNLOAD_USER_PREFIX}\uffff`)
          .all<{ key: string; value: number }>(),
      ]);

      const perUser = userRows.results.map((r) => ({
        userId: r.key.slice(DOWNLOAD_USER_PREFIX.length),
        count: Number(r.value),
      }));
      perUser.sort((a, b) => b.count - a.count);
      return {
        total: Number(totalRow?.value ?? 0),
        perUser,
      };
    },

    async recordSynthesis(userId: string, bytes: number, at = new Date()): Promise<void> {
      if (!Number.isFinite(bytes) || !Number.isInteger(bytes) || bytes < 0) {
        throw new TypeError(
          `recordSynthesis requires a non-negative integer byte count (got ${bytes}) (audio-feed-do6b)`,
        );
      }
      const day = utcDayKey(at);
      const upsert = (key: string, delta: number) =>
        core.db.prepare(
          `INSERT INTO usage_counters (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
        ).bind(key, delta);

      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await core.db.batch([
            upsert(SYNTHESIS_TOTAL_KEY, 1),
            upsert(SYNTHESIS_TOTAL_BYTES_KEY, bytes),
            upsert(`${SYNTHESIS_USER_PREFIX}${userId}`, 1),
            upsert(`${SYNTHESIS_USER_BYTES_PREFIX}${userId}`, bytes),
            upsert(synthesisDailyUserKey(userId, day), 1),
            upsert(synthesisDailyAllKey(day), 1),
          ]);
          return;
        } catch (err) {
          lastError = err;
        }
      }
      console.error(
        `[audio-feed] recordSynthesis failed for user ${userId} (${bytes} bytes):`,
        lastError,
      );
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },

    async getSynthesisCounts(today = utcDayKey()): Promise<SynthesisCounts> {
      const [totalRow, totalBytesRow, userCounts, userBytes, userDaily] = await Promise.all([
        core.db.prepare(`SELECT value FROM usage_counters WHERE key = ?`)
          .bind(SYNTHESIS_TOTAL_KEY)
          .first<{ value: number }>(),
        core.db.prepare(`SELECT value FROM usage_counters WHERE key = ?`)
          .bind(SYNTHESIS_TOTAL_BYTES_KEY)
          .first<{ value: number }>(),
        core.db.prepare(`SELECT key, value FROM usage_counters WHERE key >= ? AND key < ?`)
          .bind(SYNTHESIS_USER_PREFIX, `${SYNTHESIS_USER_PREFIX}\uffff`)
          .all<{ key: string; value: number }>(),
        core.db.prepare(`SELECT key, value FROM usage_counters WHERE key >= ? AND key < ?`)
          .bind(SYNTHESIS_USER_BYTES_PREFIX, `${SYNTHESIS_USER_BYTES_PREFIX}\uffff`)
          .all<{ key: string; value: number }>(),
        core.db.prepare(`SELECT key, value FROM usage_counters WHERE key >= ? AND key < ?`)
          .bind(SYNTHESIS_DAILY_PREFIX, `${SYNTHESIS_DAILY_PREFIX}\uffff`)
          .all<{ key: string; value: number }>(),
      ]);

      const bytesByUser = new Map<string, number>();
      for (const r of userBytes.results) {
        bytesByUser.set(r.key.slice(SYNTHESIS_USER_BYTES_PREFIX.length), Number(r.value));
      }
      const todaySuffix = `:${today}`;
      const todayByUser = new Map<string, number>();
      for (const r of userDaily.results) {
        if (r.key.endsWith(todaySuffix)) {
          const uid = r.key.slice(SYNTHESIS_DAILY_PREFIX.length, -todaySuffix.length);
          todayByUser.set(uid, Number(r.value));
        }
      }

      const perUser = userCounts.results.map((r) => {
        const userId = r.key.slice(SYNTHESIS_USER_PREFIX.length);
        return {
          userId,
          count: Number(r.value),
          bytes: bytesByUser.get(userId) ?? 0,
          todayCount: todayByUser.get(userId) ?? 0,
        };
      });
      perUser.sort((a, b) => b.count - a.count);

      return {
        total: Number(totalRow?.value ?? 0),
        totalBytes: Number(totalBytesRow?.value ?? 0),
        perUser,
      };
    },

    async getDailySynthesisCount(day: string): Promise<number> {
      const row = await core.db.prepare(`SELECT value FROM usage_counters WHERE key = ?`)
        .bind(synthesisDailyAllKey(day))
        .first<{ value: number }>();
      return Number(row?.value ?? 0);
    },

    async getUserDailySynthesisCount(userId: string, day: string): Promise<number> {
      const row = await core.db.prepare(`SELECT value FROM usage_counters WHERE key = ?`)
        .bind(synthesisDailyUserKey(userId, day))
        .first<{ value: number }>();
      return Number(row?.value ?? 0);
    },
  };
}
