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

/**
 * How many times to re-read the counter when another writer commits first.
 *
 * Generous with a short delay between tries: the appends that contend are usually the same
 * process's requests arriving together, and a dropped log line is a lost event, which is the one
 * thing a store like this must not do (audio-feed-t2x3 — twelve concurrent appends landed five and
 * silently dropped seven).
 */
const APPEND_ATTEMPTS = 12;

/** Bounded backoff between attempts, with jitter so two writers do not retry in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt, 64);
  return base + Math.floor(Math.random() * base);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLogsRepository(core: KvCore, _host: () => MetadataStore): LogRepository {
  /**
   * One append at a time per process (audio-feed-t2x3).
   *
   * The compare-and-swap below already makes concurrent appends CORRECT — no two records share a
   * seq — but correctness is not enough here: an append that loses the race and gives up has
   * dropped an event. Serialising this process's appends removes the contention it causes at the
   * source, and the backoff inside `writeOnce` covers the contention other isolates cause.
   *
   * Chained promises rather than a queue: a failed append must not poison the ones behind it, so
   * the chain continues from a settled (never rejected) promise.
   */
  let tail: Promise<unknown> = Promise.resolve();

  const writeOnce = async (input: Omit<LogRecord, "seq">): Promise<LogRecord | null> => {
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
      await delay(backoffMs(attempt));
    }
    return refuseLogRecord("sequence counter did not settle", safe);
  };

  return {
    /**
     * Append one record, numbering it.
     *
     * Serialised per process, retried with backoff on contention, and bounded/redacted on the way
     * in. Resolves to `null` only when there is genuinely nothing more to try, and says so on
     * stderr when that happens: callers are lifecycle paths and none of them may fail because a
     * log line could not be stored, but a lost event must never be silent either.
     */
    appendLog(input: Omit<LogRecord, "seq">): Promise<LogRecord | null> {
      const run = () => writeOnce(input);
      // Both handlers run the append: a previous failure must not cancel this one.
      const result = tail.then(run, run);
      tail = result.then(() => undefined, () => undefined);
      return result;
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
