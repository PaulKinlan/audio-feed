/**
 * The structured log store, in-memory adapter (audio-feed-wzv9).
 *
 * Deliberately the same algorithm as the KV adapter, including the contiguous leading-run prune
 * and the "one commit" property — here a plain increment and a push, which are atomic because
 * the adapter is single-threaded. The conformance suite runs the same cases against both, so a
 * divergence in cursor or retention behaviour fails there rather than in production.
 */

import type { LogQuery, LogRecord, LogRepository, LogSummary, MetadataStore } from "../mod.ts";
import type { MemoryState } from "./state.ts";
import {
  LOG_READ_LIMIT,
  logRecordFits,
  refuseLogRecord,
  sanitizeLogRecord,
  summarizeRecords,
} from "../log_shape.ts";

export function createLogsRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): LogRepository {
  return {
    appendLog(input: Omit<LogRecord, "seq">): Promise<LogRecord | null> {
      const safe = sanitizeLogRecord(input);
      if (!logRecordFits(safe)) {
        return Promise.resolve(refuseLogRecord("record exceeds the store's ceiling", safe));
      }
      // The record and the counter move together, as in KV: a seq that was handed out but never
      // stored (or a record stored without advancing the counter) would break the cursor.
      const record: LogRecord = { ...safe, seq: ++state.logSeq };
      state.logs.push(record);
      return Promise.resolve(record);
    },

    listLogs(query: LogQuery = {}): Promise<LogRecord[]> {
      const since = query.sinceSeq ?? 0;
      const until = query.untilSeq ?? Number.MAX_SAFE_INTEGER;
      const limit = query.limit ?? LOG_READ_LIMIT;
      const out: LogRecord[] = [];
      for (const record of state.logs) {
        if (record.seq <= since || record.seq > until) continue;
        out.push(record);
        if (out.length >= limit) break;
      }
      return Promise.resolve(out);
    },

    logBounds() {
      return Promise.resolve({
        oldestSeq: state.logWatermark + 1,
        newestSeq: state.logSeq,
      });
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
        // Records exist after the boundary, so the scan is partial and the caller must come back
        // rather than treat this count as the whole window (audio-feed-8d6r).
        truncated: records.length > 0 && countedThroughSeq < bounds.newestSeq,
      };
    },

    pruneLogs(before: Date): Promise<number> {
      const cutoff = before.getTime();
      const doomed: number[] = [];
      for (const record of state.logs) {
        // Contiguous leading run only, exactly as in KV: stop at the first record inside the
        // window so the watermark never claims more was dropped than actually was.
        if (Date.parse(record.time) >= cutoff) break;
        doomed.push(record.seq);
      }
      if (doomed.length === 0) return Promise.resolve(0);
      const dropped = new Set(doomed);
      state.logs = state.logs.filter((record) => !dropped.has(record.seq));
      state.logWatermark = doomed[doomed.length - 1]!;
      return Promise.resolve(doomed.length);
    },
  };
}
