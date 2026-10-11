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
import { makeEpisode, makeUser } from "../../fixtures.ts";
import {
  MAX_LOG_CONTEXT_LENGTH,
  MAX_LOG_MESSAGE_LENGTH,
  MAX_LOG_RECORD_BYTES,
  sanitizeLogRecord,
  serialisedLogBytes,
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

/**
 * The lifecycle records (audio-feed-wzv9, for the siv1 defect).
 *
 * These are the acceptance cases for the thing this store was built for: the two failed demos on
 * 2026-10-09 were abandoned with "no claim recorded a cause" because NOTHING durable was written
 * between a claim and its terminal write. Each case below fails if that gap comes back.
 */
export function registerLifecycleLogCases(suite: MetadataHarness) {
  const { test } = suite;

  async function seedEpisode(store: Parameters<Parameters<MetadataHarness["test"]>[1]>[0]) {
    const user = makeUser({
      id: "user-wzv9",
      email: "wzv9@example.com",
      status: "approved",
      feedToken: "token-wzv9",
    });
    await store.putUser(user);
    const episode = makeEpisode({
      id: "epi-wzv9",
      userId: user.id,
      status: "pending",
      title: "A demo that records why it died",
      createdAt: "2026-10-11T09:00:00.000Z",
    });
    await store.putEpisode(episode);
    return { user, episode };
  }

  const claim = {
    now: "2026-10-11T09:05:00.000Z",
    leaseMs: 60_000,
    owner: "worker-abc",
    maxClaims: 3,
  };

  test("a claim is durable before any work starts", async (store) => {
    const { episode } = await seedEpisode(store);
    const claimed = await store.claimEpisode(episode.userId, episode.id, claim);
    assert(claimed, "the claim succeeded");

    const records = await store.listLogs();
    const event = records.find((r) => r.type === "synthesis.claim");
    assert(event, "the claim left a record");
    assertEquals(event.severity, "info");
    // The siv1 triple: which attempt, which phase, and enough identity to join it to everything
    // else about this episode.
    assertEquals(event.attempt, 1);
    assertEquals(event.phase, "claimed");
    assertEquals(event.episodeId, episode.id);
    assertEquals(event.userId, episode.userId);
    assertEquals(event.correlationId, episode.id);
    assertEquals(event.job, "synthesis");
  });

  test("a claim with no terminal record is readable as a death, not a no-op", async (store) => {
    // Exactly the siv1 situation: claim, then the process is gone. Nothing completes the episode.
    const { episode } = await seedEpisode(store);
    await store.claimEpisode(episode.userId, episode.id, claim);

    const records = await store.listLogs();
    assertEquals(records.map((r) => r.type), ["synthesis.claim"]);
    // The episode itself is still "synthesizing" and will look that way until the lease expires —
    // which is precisely why the log has to be the thing that explains it.
    const after = await store.getEpisode(episode.userId, episode.id);
    assertEquals(after?.status, "synthesizing");
  });

  test("a finished synthesis records its outcome and how long it took", async (store) => {
    const { episode } = await seedEpisode(store);
    const claimed = await store.claimEpisode(episode.userId, episode.id, claim);
    assert(claimed);
    await store.completeEpisode(
      { ...claimed, status: "ready", audioKey: "audio/whatever", byteLength: 1234 },
      claim.owner,
    );

    const records = await store.listLogs();
    const terminal = records.find((r) => r.type === "synthesis.ready");
    assert(terminal, "the terminal outcome was recorded");
    assertEquals(terminal.severity, "info");
    assertEquals(terminal.phase, "terminal");
    assert(typeof terminal.durationMs === "number", "a trace duration");
    // Claim and terminal share the correlation id: one episode, one story.
    const claimRecord = records.find((r) => r.type === "synthesis.claim");
    assertEquals(claimRecord?.correlationId, terminal.correlationId);
  });

  test("a failed synthesis records the reason", async (store) => {
    const { episode } = await seedEpisode(store);
    const claimed = await store.claimEpisode(episode.userId, episode.id, claim);
    assert(claimed);
    await store.completeEpisode(
      { ...claimed, status: "failed", error: "TTS provider returned 503 after 3 attempts" },
      claim.owner,
    );

    const terminal = (await store.listLogs()).find((r) => r.type === "synthesis.failed");
    assert(terminal, "the failure was recorded");
    assertEquals(terminal.severity, "error");
    assertEquals(terminal.reason, "TTS provider returned 503 after 3 attempts");
  });

  test("an abandonment records WHY, which is the sentence the old code could not state", async (store) => {
    const { episode } = await seedEpisode(store);
    // Burn the claim budget: each claim ends without a terminal write, exactly as in production.
    // Each retry has to wait for the previous lease to expire, which is what makes a dead claim
    // distinguishable from a live one — and what let three claims die in production unnoticed.
    const base = Date.parse(claim.now);
    for (let i = 1; i <= 3; i++) {
      const claimed = await store.claimEpisode(episode.userId, episode.id, {
        ...claim,
        now: new Date(base + i * 120_000).toISOString(),
      });
      assert(claimed, `claim ${i} succeeded`);
    }
    // The fourth attempt is the one that abandons rather than re-billing.
    assertEquals(
      await store.claimEpisode(episode.userId, episode.id, {
        ...claim,
        now: new Date(base + 4 * 120_000).toISOString(),
      }),
      null,
    );

    const records = await store.listLogs();
    const abandoned = records.find((r) => r.type === "synthesis.abandoned");
    assert(abandoned, "the abandonment was recorded");
    assertEquals(abandoned.severity, "error");
    assertEquals(abandoned.phase, "abandoned");
    assert(abandoned.reason && abandoned.reason.length > 0, "an abandonment must carry a reason");
    // The reason must name the mechanism, because that is the diagnosis: the claims ended before
    // their terminal write rather than failing in the narration.
    assert(
      abandoned.reason!.includes("before its terminal write") ||
        abandoned.reason!.includes("last recorded error"),
      `the reason explains the mechanism: ${abandoned.reason}`,
    );
    // And the three claims are still visible, which is what turns "no cause" into a timeline.
    assertEquals(
      records.filter((r) => r.type === "synthesis.claim").length,
      3,
    );
  });
}

/**
 * The serialised ceiling, measured in real bytes (audio-feed-a0gi).
 *
 * In the shared registrar rather than a top-level test because the ceiling lives in the sanitiser
 * BOTH adapters call, and because the harness is what supplies a store to assert a refusal against.
 */
export function registerLogCeilingCases(suite: MetadataHarness) {
  const { test } = suite;

  test("the ceiling is measured in real UTF-8 bytes, not UTF-16 code units", async (store) => {
    // The finding: the ceiling compared `JSON.stringify(record).length`, which counts UTF-16 code
    // units, so a record of three-byte characters was accepted while measuring 57741 bytes against
    // a 32768 ceiling. The arithmetic of that mismatch is asserted directly, then the refusal.
    const threeByte = "\u4e2d"; // 3 UTF-8 bytes, 1 UTF-16 unit — the ratio that hid the overflow
    const oversized = rec({
      message: threeByte.repeat(MAX_LOG_MESSAGE_LENGTH * 2),
      stack: threeByte.repeat(MAX_LOG_MESSAGE_LENGTH * 8),
      context: { blowup: threeByte.repeat(MAX_LOG_CONTEXT_LENGTH * 2) },
    });

    // Sanitised first, exactly as the store does, so this measures what would have been stored.
    const sanitised = sanitizeLogRecord(oversized);
    const utf16Length = JSON.stringify(sanitised).length;
    const utf8Bytes = serialisedLogBytes(sanitised);
    assert(
      utf8Bytes > MAX_LOG_RECORD_BYTES,
      `the payload must exceed the ceiling in bytes (got ${utf8Bytes})`,
    );
    assert(
      utf16Length <= MAX_LOG_RECORD_BYTES,
      `and must NOT exceed it in UTF-16 units — that mismatch is the bug (got ${utf16Length})`,
    );

    assertEquals(await store.appendLog(oversized), null);
  });

  test("a stored record is inside the ceiling in bytes, not just in code units", async (store) => {
    const threeByte = "\u4e2d";
    const stored = await store.appendLog(
      rec({
        message: threeByte.repeat(MAX_LOG_MESSAGE_LENGTH),
        context: { note: threeByte.repeat(1000) },
      }),
    );
    assert(stored, "a record inside the ceiling is stored");
    assert(
      serialisedLogBytes(stored) <= MAX_LOG_RECORD_BYTES,
      `stored records must fit the ceiling in bytes: ${serialisedLogBytes(stored)}`,
    );
    // It really did keep the multi-byte content rather than mangling it.
    assert(stored.message.includes("\u4e2d"), "multi-byte content survives storage");
  });
}
