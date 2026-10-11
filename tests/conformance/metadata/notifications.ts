/**
 * The outbox for on-demand ingest notifications.
 *
 * Split out of tests/conformance/metadata.ts (audio-feed-fydf). The cases are unchanged: each one
 * was moved here verbatim from the section it already lived in.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { RUN_HISTORY_LIMIT } from "../../../src/storage/mod.ts";
import type { OutboxNotification } from "../../../src/types.ts";
import { isoAt } from "./harness.ts";
import { run } from "./harness.ts";

export function registerNotificationsCases(suite: MetadataHarness) {
  const { test } = suite;

  // -- outbox notifications (audio-feed-np5) --------------------------------

  test("an empty store reports empty outbox (audio-feed-np5)", async (store) => {
    assertEquals(await store.listOutbox(), []);
  });

  test("queueNotification stores entries and ackNotification marks them delivered (audio-feed-np5)", async (store) => {
    const n1: OutboxNotification = {
      id: "n-1",
      userId: "u-1",
      episodeId: "ep-1",
      status: "ready",
      title: "Episode 1",
      playerUrl: "https://audio.example.com/listen/tok",
      createdAt: "2026-09-27T10:00:00.000Z",
    };
    const n2: OutboxNotification = {
      id: "n-2",
      userId: "u-1",
      episodeId: "ep-2",
      status: "failed",
      title: "Episode 2",
      error: "TTS rate limit exceeded",
      playerUrl: "https://audio.example.com/listen/tok",
      createdAt: "2026-09-27T10:01:00.000Z",
    };

    await store.queueNotification(n1);
    await store.queueNotification(n2);

    const outbox = await store.listOutbox();
    assertEquals(outbox.length, 2);
    // listOutbox contract is FIFO (oldest first)
    assertEquals(outbox[0]!.id, "n-1");
    assertEquals(outbox[1]!.id, "n-2");

    // Acking n-1 marks it delivered and removes it from unacknowledged list
    const acked = await store.ackNotification("n-1");
    assertEquals(acked, true);

    // Double acking returns false
    const doubleAcked = await store.ackNotification("n-1");
    assertEquals(doubleAcked, false);

    const remaining = await store.listOutbox();
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0]!.id, "n-2");
  });

  test("queueNotification deduplicates identical episode notifications (audio-feed-np5)", async (store) => {
    const n1: OutboxNotification = {
      id: "n-dup-1",
      userId: "u-1",
      episodeId: "ep-dup-1",
      status: "ready",
      title: "Episode Dup",
      playerUrl: "https://audio.example.com/listen/tok",
      createdAt: "2026-09-27T10:00:00.000Z",
    };
    const n2: OutboxNotification = {
      id: "n-dup-2",
      userId: "u-1",
      episodeId: "ep-dup-1",
      status: "ready",
      title: "Episode Dup Retry",
      playerUrl: "https://audio.example.com/listen/tok",
      createdAt: "2026-09-27T10:00:05.000Z",
    };

    await store.queueNotification(n1);
    await store.queueNotification(n2);

    const list = await store.listOutbox();
    assertEquals(list.length, 1, "only 1 notification queued for same episode and status");
    assertEquals(list[0]!.id, "n-dup-1");
  });

  test("an empty store reports no runs", async (store) => {
    assertEquals(await store.listRuns(), []);
  });

  test("a run round-trips every field", async (store) => {
    const record = run({
      id: "r1",
      kind: "synthesis",
      trigger: "manual",
      ready: 4,
      deferred: 1,
      errors: ["Episode ep-1: Gemini API error: 400 Bad Request"],
    });
    await store.recordRun(record);

    const [stored] = await store.listRuns();
    assert(stored, "the run must be readable back");
    assertEquals(stored, record);
  });

  test("a FAILED run is recorded, not dropped", async (store) => {
    // The whole point of the history: a run that threw is the one an operator
    // needs to see. If failures were skipped the dashboard would be at its least
    // informative exactly when something is wrong.
    await store.recordRun(run({ id: "boom", error: "feed fetch timed out" }));

    const [stored] = await store.listRuns();
    assertEquals(stored?.error, "feed fetch timed out");
  });

  test("runs come back newest first", async (store) => {
    await store.recordRun(run({ id: "old", startedAt: "2026-09-25T09:00:00.000Z" }));
    await store.recordRun(run({ id: "new", startedAt: "2026-09-25T11:00:00.000Z" }));
    await store.recordRun(run({ id: "mid", startedAt: "2026-09-25T10:00:00.000Z" }));

    assertEquals((await store.listRuns()).map((r) => r.id), ["new", "mid", "old"]);
  });

  test("listRuns honours a limit", async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.recordRun(run({ id: `r${i}`, startedAt: `2026-09-25T1${i}:00:00.000Z` }));
    }
    assertEquals((await store.listRuns(2)).map((r) => r.id), ["r4", "r3"]);
  });

  test("listRuns can be scoped to one job kind (audio-feed-506m)", async (store) => {
    // The defect: a global newest-first page, cut to `limit`, let a job that records often crowd
    // out the job being asked about. The observability page asked this way about the SYNTHESIS run
    // and concluded "no run recorded" from a page full of feed polls.
    await store.recordRun(
      run({ id: "syn", kind: "synthesis", startedAt: "2026-09-25T09:00:00.000Z" }),
    );
    for (let i = 0; i < 20; i++) {
      await store.recordRun(
        run({
          id: `poll${i}`,
          kind: "feed-poll",
          startedAt: `2026-09-25T10:${String(i).padStart(2, "0")}:00.000Z`,
        }),
      );
    }

    // The unscoped page no longer contains the synthesis run at all - that is the bug.
    assertEquals(
      (await store.listRuns(20)).some((r) => r.kind === "synthesis"),
      false,
      "an unscoped page is what hid the run",
    );
    // Scoping finds it, whatever else the history holds.
    assertEquals((await store.listRuns(20, "synthesis")).map((r) => r.id), ["syn"]);
    assertEquals((await store.listRuns(5, "feed-poll")).length, 5);
    assertEquals(await store.listRuns(20, "synthesis"), await store.listRuns(20, "synthesis"));
  });

  test("history is bounded ON WRITE, and keeps the newest", async (store) => {
    // Bounded on write rather than on read is the audio-feed-att lesson: an
    // unbounded history reads cheaply today and is a multi-megabyte scan a year
    // in. Writing past the limit and then asking for MORE than the limit is what
    // distinguishes "pruned" from "merely not returned".
    const total = RUN_HISTORY_LIMIT + 10;
    for (let i = 0; i < total; i++) {
      await store.recordRun(
        run({ id: `r${String(i).padStart(3, "0")}`, startedAt: isoAt(i) }),
      );
    }

    const all = await store.listRuns(total);
    assertEquals(all.length, RUN_HISTORY_LIMIT, "anything past the limit must be pruned");
    // The newest survive, not the first written.
    assertEquals(all[0]?.id, `r${String(total - 1).padStart(3, "0")}`);
    assertEquals(all.at(-1)?.id, `r${String(total - RUN_HISTORY_LIMIT).padStart(3, "0")}`);
  });

  test("a busy job cannot evict a quiet one's history (audio-feed-ct1)", async (store) => {
    // The synthesis cron records a run every 2 minutes, idle or not, and the
    // feed poll one every 15. Under one shared cap the busy job pushed the quiet
    // one out entirely, and a poller that had only stopped read as one that
    // never ran. Each job keeps its own newest RUN_HISTORY_LIMIT.
    await store.recordRun(run({ id: "poll", kind: "feed-poll", startedAt: isoAt(0) }));
    const busy = RUN_HISTORY_LIMIT + 10;
    for (let i = 1; i <= busy; i++) {
      await store.recordRun(
        run({ id: `s${String(i).padStart(3, "0")}`, kind: "synthesis", startedAt: isoAt(i) }),
      );
    }

    const all = await store.listRuns(1_000);
    assertEquals(
      all.filter((r) => r.kind === "feed-poll").map((r) => r.id),
      ["poll"],
      "the quiet job keeps its history",
    );
    assertEquals(
      all.filter((r) => r.kind === "synthesis").length,
      RUN_HISTORY_LIMIT,
      "the busy job is still bounded, on its own",
    );
    assertEquals(all[0]?.id, `s${String(busy).padStart(3, "0")}`, "still newest first");
    assertEquals(all.at(-1)?.id, "poll");
    assertEquals(
      (await store.listRuns()).length,
      RUN_HISTORY_LIMIT + 1,
      "the default returns every job's history, not one shared window",
    );
  });

  test("a same-millisecond tie breaks the same way on every adapter (audio-feed-ct1)", async (store) => {
    // Merging two jobs' histories makes a tie reachable: both crons can start in
    // the same millisecond. The two adapters used to break it in opposite
    // directions. The lower id comes first, everywhere.
    const at = "2026-09-25T10:00:00.000Z";
    await store.recordRun(run({ id: "b", kind: "synthesis", startedAt: at }));
    await store.recordRun(run({ id: "a", kind: "feed-poll", startedAt: at }));
    await store.recordRun(run({ id: "c", kind: "synthesis", startedAt: at }));

    assertEquals((await store.listRuns()).map((r) => r.id), ["a", "b", "c"]);
  });

  test("a run of idle ticks is kept as one row, the latest (audio-feed-0ob)", async (store) => {
    // The synthesis cron ticks every 2 minutes and nearly always finds nothing
    // to do. An idle tick replaces its job's newest row when that row is an
    // older idle tick, so the history does not grow and needs no prune.
    const idle = (id: string, i: number) =>
      run({ id, kind: "synthesis", startedAt: isoAt(i), idle: true });
    await store.recordRun(run({ id: "work", kind: "synthesis", startedAt: isoAt(0), ready: 2 }));
    await store.recordRun(idle("i1", 1));
    await store.recordRun(idle("i2", 2));
    await store.recordRun(idle("i3", 3));

    assertEquals((await store.listRuns()).map((r) => r.id), ["i3", "work"]);
  });

  test("an idle tick replaces only an OLDER idle row of the SAME job (audio-feed-0ob)", async (store) => {
    await store.recordRun(
      run({ id: "s-idle", kind: "synthesis", startedAt: isoAt(1), idle: true }),
    );
    // Another job's idle tick is its own row.
    await store.recordRun(
      run({ id: "p-idle", kind: "feed-poll", startedAt: isoAt(2), idle: true }),
    );
    // A tick that did work is always kept, and ends the idle run before it.
    await store.recordRun(run({ id: "s-work", kind: "synthesis", startedAt: isoAt(3), ready: 1 }));
    await store.recordRun(
      run({ id: "s-idle-2", kind: "synthesis", startedAt: isoAt(4), idle: true }),
    );
    // Recorded late: an older idle tick never replaces a newer one.
    await store.recordRun(
      run({ id: "s-late", kind: "synthesis", startedAt: isoAt(0), idle: true }),
    );

    assertEquals(
      (await store.listRuns()).map((r) => r.id),
      ["s-idle-2", "s-work", "p-idle", "s-idle", "s-late"],
    );
  });
}
