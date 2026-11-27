/**
 * Structured log store repository for Cloudflare D1.
 */

import type {
  LogBounds,
  LogQuery,
  LogRecord,
  LogRepository,
  LogSummary,
  MetadataStore,
} from "../mod.ts";
import {
  LOG_READ_LIMIT,
  logRecordFits,
  refuseLogRecord,
  sanitizeLogRecord,
  summarizeRecords,
} from "../log_shape.ts";
import type { D1Core } from "./core.ts";
import type { D1PreparedStatementLike } from "./types.ts";

const APPEND_ATTEMPTS = 12;

function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt, 64);
  return base + Math.floor(Math.random() * base);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createD1LogsRepository(
  core: D1Core,
  _host: () => MetadataStore,
): LogRepository {
  let tail: Promise<unknown> = Promise.resolve();

  const writeOnce = async (input: Omit<LogRecord, "seq">): Promise<LogRecord | null> => {
    const safe = sanitizeLogRecord(input);
    if (!logRecordFits(safe)) return refuseLogRecord("record exceeds the store's ceiling", safe);

    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
      try {
        const meta = await core.db.prepare(`SELECT newest_seq FROM log_meta WHERE id = 1`)
          .first<{ newest_seq: number }>();
        const newest = meta ? Number(meta.newest_seq) : 0;
        const seq = newest + 1;
        const record: LogRecord = { ...safe, seq };
        const detectorKey = record.type === "synthesis.invocation.overdue" &&
            typeof record.context?.detectorKey === "string"
          ? record.context.detectorKey
          : null;

        const results = await core.db.batch([
          core.db.prepare(
            `UPDATE log_meta SET newest_seq = ? WHERE id = 1 AND newest_seq = ?`,
          ).bind(seq, newest),
          core.db.prepare(
            `INSERT INTO logs (seq, time, detector_key, data)
             SELECT ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM log_meta WHERE id = 1 AND newest_seq = ?)`,
          ).bind(seq, record.time, detectorKey, JSON.stringify(record), seq),
        ]);
        if ((results[0]?.meta.changes ?? 0) === 1) return record;
      } catch {
        // Retry on transient contention; callers expect null rather than throw.
      }
      await delay(backoffMs(attempt));
    }
    return refuseLogRecord("sequence counter did not settle", safe);
  };

  return {
    appendLog(input: Omit<LogRecord, "seq">): Promise<LogRecord | null> {
      const run = () => writeOnce(input);
      const result = tail.then(run, run);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },

    async appendLogOnce(input, key, expectedNewestSeq) {
      if (!/^[\w:.-]{1,220}$/.test(key)) return "unavailable";
      const safe = sanitizeLogRecord({
        ...input,
        context: { ...input.context, detectorKey: key },
      });
      if (!logRecordFits(safe)) return "unavailable";

      try {
        const [meta, marker] = await Promise.all([
          core.db.prepare(`SELECT newest_seq FROM log_meta WHERE id = 1`)
            .first<{ newest_seq: number }>(),
          core.db.prepare(`SELECT seq FROM log_once_markers WHERE key = ?`)
            .bind(key)
            .first<{ seq: number }>(),
        ]);
        if (marker) return "duplicate";
        const newest = meta ? Number(meta.newest_seq) : 0;
        if (newest !== expectedNewestSeq) return "changed";

        const seq = newest + 1;
        const record: LogRecord = { ...safe, seq };

        const results = await core.db.batch([
          core.db.prepare(
            `UPDATE log_meta SET newest_seq = ?
             WHERE id = 1 AND newest_seq = ?
               AND NOT EXISTS (SELECT 1 FROM log_once_markers WHERE key = ?)`,
          ).bind(seq, expectedNewestSeq, key),
          core.db.prepare(
            `INSERT OR IGNORE INTO log_once_markers (key, seq)
             SELECT ?, ?
             WHERE EXISTS (SELECT 1 FROM log_meta WHERE id = 1 AND newest_seq = ?)`,
          ).bind(key, seq, seq),
          core.db.prepare(
            `INSERT OR IGNORE INTO logs (seq, time, detector_key, data)
             SELECT ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM log_meta WHERE id = 1 AND newest_seq = ?)
               AND EXISTS (SELECT 1 FROM log_once_markers WHERE key = ? AND seq = ?)`,
          ).bind(seq, record.time, key, JSON.stringify(record), seq, key, seq),
        ]);

        if ((results[0]?.meta.changes ?? 0) === 1) return "written";
        const after = await core.db.prepare(`SELECT seq FROM log_once_markers WHERE key = ?`)
          .bind(key)
          .first<{ seq: number }>();
        return after ? "duplicate" : "changed";
      } catch {
        return "unavailable";
      }
    },

    async listLogs(query: LogQuery = {}): Promise<LogRecord[]> {
      const since = query.sinceSeq ?? 0;
      const until = query.untilSeq;
      const limit = query.limit ?? LOG_READ_LIMIT;

      const res = until === undefined
        ? await core.db.prepare(
          `SELECT data FROM logs WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        ).bind(since, limit).all<{ data: string }>()
        : await core.db.prepare(
          `SELECT data FROM logs WHERE seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
        ).bind(since, until, limit).all<{ data: string }>();

      return res.results.map((r) => JSON.parse(r.data) as LogRecord);
    },

    async logBounds(): Promise<LogBounds> {
      const meta = await core.db.prepare(`SELECT newest_seq, watermark FROM log_meta WHERE id = 1`)
        .first<{ newest_seq: number; watermark: number }>();
      const newestSeq = meta ? Number(meta.newest_seq) : 0;
      const pruned = meta ? Number(meta.watermark) : 0;
      return { oldestSeq: pruned + 1, newestSeq };
    },

    async summarizeLogs(query: LogQuery = {}): Promise<LogSummary> {
      const records = await this.listLogs({ ...query, limit: query.limit ?? LOG_READ_LIMIT });
      const bounds = await this.logBounds();
      const countedThroughSeq = records.length > 0
        ? records[records.length - 1]!.seq
        : (query.sinceSeq ?? 0);
      return {
        ...summarizeRecords(records),
        countedThroughSeq,
        truncated: records.length > 0 && countedThroughSeq < bounds.newestSeq,
      };
    },

    async pruneLogs(before: Date): Promise<number> {
      const cutoff = before.getTime();
      const bounds = await this.logBounds();
      const watermark = bounds.oldestSeq - 1;

      const res = await core.db.prepare(
        `SELECT seq, time, detector_key FROM logs WHERE seq > ? ORDER BY seq ASC`,
      ).bind(watermark).all<{ seq: number; time: string; detector_key: string | null }>();

      const doomed: { seq: number; detectorKey?: string }[] = [];
      for (const row of res.results) {
        if (Date.parse(row.time) >= cutoff) break;
        doomed.push({
          seq: Number(row.seq),
          ...(row.detector_key ? { detectorKey: row.detector_key } : {}),
        });
      }
      if (doomed.length === 0) return 0;

      // Delete in bounded batches so we stay well within D1's batch/param limits,
      // advancing the watermark only alongside the rows actually deleted.
      let deleted = 0;
      const BATCH_SIZE = 50;
      for (let i = 0; i < doomed.length; i += BATCH_SIZE) {
        const batch = doomed.slice(i, i + BATCH_SIZE);
        const firstSeq = batch[0]!.seq;
        const lastSeq = batch[batch.length - 1]!.seq;
        const stmts: D1PreparedStatementLike[] = [
          core.db.prepare(`DELETE FROM logs WHERE seq >= ? AND seq <= ?`).bind(firstSeq, lastSeq),
        ];
        const markerKeys = batch
          .map((item) => item.detectorKey)
          .filter((k): k is string => typeof k === "string");
        if (markerKeys.length > 0) {
          const placeholders = markerKeys.map(() => "?").join(", ");
          stmts.push(
            core.db.prepare(`DELETE FROM log_once_markers WHERE key IN (${placeholders})`)
              .bind(...markerKeys),
          );
        }
        stmts.push(
          core.db.prepare(
            `UPDATE log_meta SET watermark = MAX(watermark, ?) WHERE id = 1`,
          ).bind(lastSeq),
        );
        await core.db.batch(stmts);
        deleted += batch.length;
      }
      return deleted;
    },
  };
}
