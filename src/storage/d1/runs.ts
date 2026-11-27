/**
 * Background-job run history repository for Cloudflare D1.
 */

import type { MetadataStore, RunRecord, RunRepository } from "../mod.ts";
import { compareRunsNewestFirst, RUN_HISTORY_LIMIT, RUN_KINDS } from "../mod.ts";
import type { D1Core } from "./core.ts";
import { descendingKey } from "./core.ts";

export function createD1RunsRepository(
  core: D1Core,
  _host: () => MetadataStore,
): RunRepository {
  return {
    async recordRun(record: RunRecord): Promise<void> {
      try {
        const sortKey = descendingKey(record.startedAt, record.id);
        if (record.idle) {
          const newest = await core.db.prepare(
            `SELECT sort_key, started_at, idle FROM runs
             WHERE kind = ?
             ORDER BY sort_key ASC
             LIMIT 1`,
          ).bind(record.kind).first<{ sort_key: string; started_at: string; idle: number }>();

          if (
            newest &&
            newest.idle === 1 &&
            Date.parse(newest.started_at) <= Date.parse(record.startedAt)
          ) {
            await core.db.batch([
              core.db.prepare(`DELETE FROM runs WHERE kind = ? AND sort_key = ?`)
                .bind(record.kind, newest.sort_key),
              core.db.prepare(
                `INSERT OR REPLACE INTO runs (kind, sort_key, id, started_at, idle, data)
                 VALUES (?, ?, ?, ?, 1, ?)`,
              ).bind(record.kind, sortKey, record.id, record.startedAt, JSON.stringify(record)),
            ]);
            return;
          }
        }

        await core.db.batch([
          core.db.prepare(
            `INSERT OR REPLACE INTO runs (kind, sort_key, id, started_at, idle, data)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            record.kind,
            sortKey,
            record.id,
            record.startedAt,
            record.idle ? 1 : 0,
            JSON.stringify(record),
          ),
          core.db.prepare(
            `DELETE FROM runs
             WHERE kind = ?
               AND sort_key NOT IN (
                 SELECT sort_key FROM runs
                 WHERE kind = ?
                 ORDER BY sort_key ASC
                 LIMIT ?
               )`,
          ).bind(record.kind, record.kind, RUN_HISTORY_LIMIT),
        ]);
      } catch {
        // History is diagnostic. Losing a record must not fail the run it describes.
      }
    },

    async listRuns(
      limit = RUN_HISTORY_LIMIT * RUN_KINDS.length,
      kind?: RunRecord["kind"],
    ): Promise<RunRecord[]> {
      if (kind) {
        const res = await core.db.prepare(
          `SELECT data FROM runs WHERE kind = ? ORDER BY sort_key ASC LIMIT ?`,
        ).bind(kind, limit).all<{ data: string }>();
        return res.results.map((r) => JSON.parse(r.data) as RunRecord)
          .sort(compareRunsNewestFirst)
          .slice(0, limit);
      }
      const res = await core.db.prepare(
        `SELECT data FROM runs ORDER BY sort_key ASC`,
      ).all<{ data: string }>();
      return res.results.map((r) => JSON.parse(r.data) as RunRecord)
        .sort(compareRunsNewestFirst)
        .slice(0, limit);
    },
  };
}
