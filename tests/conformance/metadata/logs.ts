/**
 * The structured log store (audio-feed-wzv9): the cursor, the window, the summary and retention.
 *
 * In the CONFORMANCE suite because the two adapters get their ordering by completely different
 * means — KV lists a sequenced key space under a compare-and-swap counter, memory scans an array
 * and increments a number — and every property here is a promise the errors API (obs-1) makes to
 * a poller. A memory-only test would pass while the adapter that runs in production diverged.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import {
  MAX_LOG_CONTEXT_LENGTH,
  MAX_LOG_MESSAGE_LENGTH,
  MAX_LOG_RECORD_BYTES,
} from "../../../src/storage/log_shape.ts";

/** A minimal valid record; each case overrides what it is about. */
function rec(overrides: Record<string, unknown> = {}) {
  return {
    time: new Date("2026-10-11T10:00:00.000Z").toISOString(),
    severity: "info" as const,
    type: "test.event",
    message: "something happened",
    process: "app" as const,
    ...overrides,
  };
}

export function registerLogsCases(suite: MetadataHarness) {
  const { test } = suite;

  test("an empty log store reports no records and no retained range", async (store) => {
    assertEquals(await store.listLogs(), []);
    // newestSeq below oldestSeq is how "nothing retained" is expressed: a cursor above
    // newestSeq is simply up to date, while a cursor below oldestSeq is too old.
    assertEquals(await store.logBounds(), { oldestSeq: 1, newestSeq: 0 });
    assertEquals((await store.summarizeLogs()).total, 0);
  });

  test("appendLog assigns consecutive sequence numbers", async (store) => {
    const first = await store.appendLog(rec({ message: "one" }));
    const second = await store.appendLog(rec({ message: "two" }));
    const third = await store.appendLog(rec({ message: "three" }));

    assertEquals([first?.seq, second?.seq, third?.seq], [1, 2, 3]);
    assertEquals((await store.logBounds()).newestSeq, 3);
  });

  test("every seq up to the high-water mark is readable, with no gaps", async (store) => {
    // The property a cursor depends on: the counter and the records cannot drift apart. If an
    // append could hand out a number it never stored, a poller would stop there forever, and if
    // it stored a record without advancing, the record would be unreachable.
    for (let i = 0; i < 12; i++) await store.appendLog(rec({ context: { i } }));

    const all = await store.listLogs();
    assertEquals(all.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assertEquals((await store.logBounds()).newestSeq, 12);
  });

  test("listLogs treats sinceSeq as exclusive and honours a limit", async (store) => {
    for (let i = 0; i < 5; i++) await store.appendLog(rec({ context: { i } }));

    // What a poller does: pass the last seq it saw, get everything after it, nothing repeated.
    const after2 = await store.listLogs({ sinceSeq: 2 });
    assertEquals(after2.map((r) => r.seq), [3, 4, 5]);

    const bounded = await store.listLogs({ sinceSeq: 0, limit: 2 });
    assertEquals(bounded.map((r) => r.seq), [1, 2]);

    const window = await store.listLogs({ sinceSeq: 1, untilSeq: 3 });
    assertEquals(window.map((r) => r.seq), [2, 3]);
  });

  test("summarizeLogs counts by severity and by type over the window", async (store) => {
    await store.appendLog(rec({ severity: "error", type: "synthesis.failed" }));
    await store.appendLog(rec({ severity: "error", type: "synthesis.failed" }));
    await store.appendLog(rec({ severity: "warn", type: "csp.violation" }));
    await store.appendLog(rec({ severity: "info", type: "synthesis.claim" }));

    const summary = await store.summarizeLogs();
    assertEquals(summary.total, 4);
    assertEquals(summary.bySeverity, { debug: 0, info: 1, warn: 1, error: 2 });
    // Descending by count, so a poller's "what is happening" needs no sort of its own.
    assertEquals(summary.byType[0], { type: "synthesis.failed", count: 2 });
  });

  test("pruneLogs drops the leading run and the bounds admit exactly that much", async (store) => {
    await store.appendLog(rec({ time: "2026-10-01T00:00:00.000Z", type: "old.1" }));
    await store.appendLog(rec({ time: "2026-10-02T00:00:00.000Z", type: "old.2" }));
    await store.appendLog(rec({ time: "2026-10-11T00:00:00.000Z", type: "new.1" }));

    const dropped = await store.pruneLogs(new Date("2026-10-05T00:00:00.000Z"));
    assertEquals(dropped, 2);
    assertEquals((await store.listLogs()).map((r) => r.type), ["new.1"]);
    // oldestSeq is the contract the API needs to say "cursor too old" instead of skipping.
    assertEquals(await store.logBounds(), { oldestSeq: 3, newestSeq: 3 });
  });

  test("pruneLogs never drops a record that is not in the leading run", async (store) => {
    // Out-of-order arrival is normal: two writers interleave, and a clock can move backwards.
    // Only a CONTIGUOUS prefix may be dropped, because the watermark is a single number and a
    // record deleted from the middle would make "everything below oldestSeq is gone" a lie.
    await store.appendLog(rec({ time: "2026-10-01T00:00:00.000Z", type: "old" }));
    await store.appendLog(rec({ time: "2026-10-11T00:00:00.000Z", type: "new" }));
    await store.appendLog(rec({ time: "2026-10-02T00:00:00.000Z", type: "late-old" }));

    const dropped = await store.pruneLogs(new Date("2026-10-05T00:00:00.000Z"));
    assertEquals(dropped, 1);
    assertEquals(await store.logBounds(), { oldestSeq: 2, newestSeq: 3 });
    // The out-of-order old record is still readable, so no cursor can be told it expired.
    assertEquals((await store.listLogs()).map((r) => r.type), ["new", "late-old"]);
  });

  test("the store caps and redacts a record on the way in", async (store) => {
    // The CSP endpoint that will feed this store is public and every field in a report is
    // attacker-controlled (obs-5), so the bound has to hold for a caller that is hostile.
    const stored = await store.appendLog(rec({
      message: "x".repeat(MAX_LOG_MESSAGE_LENGTH * 3),
      type: "csp.violation",
      context: {
        token: "capability-token-value",
        authorization: "Bearer secret",
        blockedURL: "y".repeat(MAX_LOG_CONTEXT_LENGTH * 2),
        nested: { apiKey: "nope" },
      },
    }));

    assert(stored);
    assert(stored.message.length <= MAX_LOG_MESSAGE_LENGTH + 40, "message is capped");
    const context = stored.context as Record<string, unknown>;
    assertEquals(context.token, "[redacted]");
    assertEquals(context.authorization, "[redacted]");
    assertEquals((context.nested as Record<string, unknown>).apiKey, "[redacted]");
    assert(JSON.stringify(stored).length <= MAX_LOG_RECORD_BYTES, "the record fits the ceiling");
    // Nothing that reached the store may carry the secret value anywhere.
    assert(!JSON.stringify(stored).includes("capability-token-value"));
    assert(!JSON.stringify(stored).includes("Bearer secret"));
  });

  test("a record with an unusable timestamp is stored rather than rejected", async (store) => {
    // A log line is worth more than the strictness of its clock: losing it would defeat the
    // purpose of recording it.
    const stored = await store.appendLog(rec({ time: "not a date" }));
    assert(stored);
    assert(!Number.isNaN(Date.parse(stored.time)));
  });
}
