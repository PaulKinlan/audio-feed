/**
 * The structured log store, Deno KV adapter (audio-feed-wzv9).
 *
 * A log record and the sequence counter that numbers it move in ONE commit. That is the
 * whole design: the cursor the errors API (obs-1) walks is a `seq`, and a cursor is only
 * useful if it cannot skip a record or hand out the same number twice. A read-then-write
 * counter would do both after a crash, which is exactly the situation this store exists
 * for — it is asked to explain processes that died mid-work.
 *
 * The counter is therefore mutated under `.check()`, the same compare-and-swap the episode
 * claim uses (audio-feed-vfs). Losing the race is normal and just retries.
 */

import type {
  LogBounds,
  LogQuery,
  LogRecord,
  LogRepository,
  LogSummary,
  MetadataStore,
} from "../mod.ts";
import type { KvCore } from "./core.ts";
import {
  LOG_READ_LIMIT,
  logRecordFits,
  refuseLogRecord,
  sanitizeLogRecord,
  summarizeRecords,
} from "../log_shape.ts";

/** The newest assigned sequence number. The store's high-water mark. */
const SEQ_KEY: Deno.KvKey = ["log_seq"];

/**
 * The newest sequence number that has been PRUNED, contiguously from the start.
 *
 * Kept as "the last one deleted" rather than "the oldest retained" so that the two can be
 * told apart: with nothing pruned the value is 0 and the oldest retained record is 1. A
 * prune that cannot delete a leading record for some reason simply does not advance this,
 * so `bounds()` can never claim a record is gone while it is still readable.
 */
const WATERMARK_KEY: Deno.KvKey = ["log_watermark"];

/** How many times to re-read the counter when another writer commits first. */
const APPEND_ATTEMPTS = 5;

export function createLogsRepository(core: KvCore, _host: () => MetadataStore): LogRepository {
  return {
    /**
     * Append one record, numbering it.
     *
     * Resolves to `null` when the write could not be made — after every retry — rather than
     * throwing. Callers are lifecycle paths: a claim, an abandonment, a finished synthesis. A
     * request or a job must not fail because its log line could not be written; the caller
     * decides what a missing record means, and `docs/evidence/audio-feed-wzv9` records that
     * decision. Never silently: the fallback is one plain line on stderr.
     */
    async appendLog(input: Omit<LogRecord, "seq">): Promise<LogRecord | null> {
      // Bounded before it is stored, in the one place every append goes through.
      const safe = sanitizeLogRecord(input);
      if (!logRecordFits(safe)) return refuseLogRecord("record exceeds the store's ceiling", safe);
      for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
        const entry = await core.kv.get<number>(SEQ_KEY);
        const newest = typeof entry.value === "number" ? entry.value : 0;
        const seq = newest + 1;
        const record: LogRecord = { ...safe, seq };
        const res = await core.kv.atomic()
          // The check is the point: if another writer numbered a record after we read, this
          // commit fails and we try again with a fresh number, so no two records share a seq.
          .check(entry)
          .set(SEQ_KEY, seq)
          .set(["log", seq], record)
          .commit();
        if (res.ok) return record;
      }
      return refuseLogRecord("sequence counter did not settle", safe);
    },

    /**
     * Records in sequence order, oldest first.
     *
     * `sinceSeq` is EXCLUSIVE — the caller passes the last seq it has already seen, which is
     * what makes a poll resume exactly where it stopped with nothing repeated and nothing
     * skipped. `limit` defaults to a bound rather than "everything", because an unbounded
     * read of a log is the failure mode this store is designed against (audio-feed-att).
     */
    async listLogs(query: LogQuery = {}): Promise<LogRecord[]> {
      const since = query.sinceSeq ?? 0;
      const until = query.untilSeq;
      const limit = query.limit ?? LOG_READ_LIMIT;
      const out: LogRecord[] = [];
      // Named and annotated rather than inline: a conditional of key literals widens to
      // (string|number)[], which the KV selector type rejects.
      const start: Deno.KvKey = ["log", since + 1];
      // An open-ended range has to be spelled as one: Deno KV's selector needs start AND end
      // together, so "to the newest" is the largest seq a record can carry.
      const end: Deno.KvKey = until === undefined
        ? ["log", Number.MAX_SAFE_INTEGER]
        : ["log", until + 1];
      for await (const entry of core.kv.list<LogRecord>({ start, end })) {
        out.push(entry.value);
        if (out.length >= limit) break;
      }
      return out;
    },

    async logBounds(): Promise<LogBounds> {
      const [seqEntry, watermarkEntry] = await Promise.all([
        core.kv.get<number>(SEQ_KEY),
        core.kv.get<number>(WATERMARK_KEY),
      ]);
      const newestSeq = typeof seqEntry.value === "number" ? seqEntry.value : 0;
      const pruned = typeof watermarkEntry.value === "number" ? watermarkEntry.value : 0;
      return { oldestSeq: pruned + 1, newestSeq };
    },

    /**
     * Counts over a window, for the summary endpoint (obs-1).
     *
     * Derived by reading the window rather than from counters kept alongside the writes. A
     * maintained counter is a second copy of the truth that can drift; the retention window
     * bounds how much this read can cost, and a poller asking for a summary is asking for
     * correctness, not for a microsecond.
     */
    async summarizeLogs(query: LogQuery = {}): Promise<LogSummary> {
      return summarizeRecords(
        await this.listLogs({ ...query, limit: query.limit ?? LOG_READ_LIMIT }),
      );
    },

    /**
     * Drop records older than `before`, and advance the watermark over them.
     *
     * Only a CONTIGUOUS leading run is deleted, and the watermark advances only as far as
     * what was actually deleted. Records are appended in time order but not exclusively so
     * (two writers can interleave), so stopping at the first record at or after `before`
     * keeps the watermark honest: everything below it really is gone, and everything above it
     * really is still there for the caller to read.
     */
    async pruneLogs(before: Date): Promise<number> {
      const cutoff = before.getTime();
      const bounds = await this.logBounds();
      let watermark = bounds.oldestSeq - 1;
      const doomed: { key: Deno.KvKey; seq: number }[] = [];
      const from: Deno.KvKey = ["log", watermark + 1];
      const to: Deno.KvKey = ["log", Number.MAX_SAFE_INTEGER];
      for await (const entry of core.kv.list<LogRecord>({ start: from, end: to })) {
        // Stop at the first record still inside the window. Records are appended in time order
        // but not exclusively so, so only a CONTIGUOUS leading run may be dropped: that is what
        // lets `bounds()` advance honestly and keeps "oldestSeq" a value a cursor can trust.
        if (Date.parse(entry.value.time) >= cutoff) break;
        doomed.push({ key: entry.key, seq: entry.value.seq });
      }
      if (doomed.length === 0) return 0;

      // Deletions and the watermark commit together, in batches, so the two can never
      // disagree: a crash between batches leaves the watermark at the last batch that
      // committed, and every record below it really is gone. Doing it the other way round —
      // advancing first, deleting after — would let `bounds()` report "cursor too old" for
      // records a caller could still have read, which is the one direction that loses data.
      const BATCH = 8; // Deno KV bounds an atomic operation to 10 mutations; leave room for the set.
      let deleted = 0;
      for (let i = 0; i < doomed.length; i += BATCH) {
        const batch = doomed.slice(i, i + BATCH);
        const last = batch[batch.length - 1]!;
        const tx = core.kv.atomic();
        for (const item of batch) tx.delete(item.key);
        tx.set(WATERMARK_KEY, last.seq);
        const res = await tx.commit();
        if (!res.ok) break; // Keep the watermark where it is; the caller can prune again.
        watermark = last.seq;
        deleted += batch.length;
      }
      return deleted;
    },
  };
}
