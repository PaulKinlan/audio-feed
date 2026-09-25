/**
 * The shared run recorder (audio-feed-ndc).
 *
 * `recordRun` wraps all four background-run call sites — two Deno.cron handlers
 * and two admin manual triggers — so a run looks the same in the history however
 * it was started. Its doc comment makes three claims, and each one is a promise
 * to an operator staring at a dashboard rather than an implementation detail:
 *
 *   1. a run that THROWS is still recorded, with its error;
 *   2. recording does not change the caller's control flow — the exception is
 *      re-thrown, so a failing poll still fails;
 *   3. a recording failure must never be the reason a run reports failure.
 *
 * A doc comment describing behaviour the code does not have is worse than no
 * comment, because it survives review by being agreeable (audio-feed-dzv, and
 * audio-feed-6ey's own fallback comment). So each claim is driven here.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { recordRun } from "../src/stats.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { AppContext } from "../src/app.ts";
import type { RunRecord } from "../src/storage/mod.ts";

const config: AppConfig = { port: 8000, publicBaseUrl: "https://audio.example.com" };

function ctx(stores: Stores = memoryStores()): { ctx: AppContext; stores: Stores } {
  return { ctx: { config, stores } as AppContext, stores };
}

Deno.test("an idle cron tick is kept as one row, the latest (audio-feed-0ob)", async () => {
  // Three scheduled ticks that found nothing, possibly in the same millisecond.
  const { ctx: app, stores } = ctx();
  for (let i = 0; i < 3; i++) {
    await recordRun(
      app,
      "synthesis",
      "cron",
      () => Promise.resolve({ ready: 0 }),
      (r) => ({ ready: r.ready }),
      (r) => r.ready === 0,
    );
  }

  const runs = await stores.metadata.listRuns();
  assertEquals(runs.length, 1, "three idle ticks, one row");
  assertEquals(runs[0]?.idle, true);
});

Deno.test("only a scheduled tick that did nothing is idle (audio-feed-0ob)", async () => {
  const { ctx: app, stores } = ctx();
  const sum = (r: { ready: number }) => ({ ready: r.ready });
  const isIdle = (r: { ready: number }) => r.ready === 0;
  // A manual run is someone asking, so it is kept even when it found nothing.
  for (let i = 0; i < 2; i++) {
    await recordRun(app, "synthesis", "manual", () => Promise.resolve({ ready: 0 }), sum, isIdle);
  }
  // A tick that did work.
  await recordRun(app, "synthesis", "cron", () => Promise.resolve({ ready: 2 }), sum, isIdle);
  // A tick that threw: the predicate never sees it.
  await assertRejects(() =>
    recordRun(
      app,
      "synthesis",
      "cron",
      () => Promise.reject<{ ready: number }>(new Error("boom")),
      sum,
      isIdle,
    )
  );

  const runs = await stores.metadata.listRuns();
  assertEquals(runs.length, 4, "every one of them is kept");
  assertEquals(runs.filter((r) => r.idle).length, 0);
});

Deno.test("a successful run records its summary (audio-feed-ndc)", async () => {
  const { ctx: app, stores } = ctx();

  const result = await recordRun(
    app,
    "feed-poll",
    "cron",
    () => Promise.resolve({ polled: 3, queued: 2, failed: 1 }),
    (r) => ({ polled: r.polled, queued: r.queued, failed: r.failed }),
  );

  assertEquals(result, { polled: 3, queued: 2, failed: 1 }, "the work's value must pass through");

  const [record] = await stores.metadata.listRuns();
  assert(record, "a completed run must be in the history");
  assertEquals(record.kind, "feed-poll");
  assertEquals(record.trigger, "cron");
  assertEquals(record.polled, 3);
  assertEquals(record.queued, 2);
  assertEquals(record.failed, 1);
  assertEquals(record.error, undefined, "a run that did not throw has no error");
  assert(record.id.length > 0, "every run needs an id, or the history cannot be keyed");
});

Deno.test("a run that THROWS is still recorded, with its error (audio-feed-ndc)", async () => {
  // The whole reason the history exists. If failures were skipped the dashboard
  // would be at its least informative exactly when something is wrong — and the
  // obvious implementation (record after the await) has precisely that bug.
  const { ctx: app, stores } = ctx();

  await assertRejects(
    () =>
      recordRun(
        app,
        "feed-poll",
        "cron",
        () => Promise.reject(new Error("feed fetch timed out")),
        () => ({}),
      ),
    Error,
    "feed fetch timed out",
  );

  const [record] = await stores.metadata.listRuns();
  assert(record, "a FAILED run must be in the history");
  assertEquals(record.error, "feed fetch timed out");
  assertEquals(record.kind, "feed-poll");
  assertEquals(record.trigger, "cron");
});

Deno.test("recording does not swallow the failure (audio-feed-ndc)", async () => {
  // Observing must not change control flow. A cron handler that stopped seeing
  // its own exceptions would log success for a run that failed, which is a
  // worse outcome than having no history at all.
  const { ctx: app } = ctx();
  const thrown = await assertRejects(
    () =>
      recordRun(app, "synthesis", "manual", () => Promise.reject(new Error("boom")), () => ({})),
    Error,
  );
  assertEquals(thrown.message, "boom", "the ORIGINAL error must reach the caller");
});

Deno.test("when BOTH the work and the recording fail, the WORK's error wins (audio-feed-ndc)", async () => {
  // The worse half of the same defect, and the one a test is most likely to
  // miss because it needs two things to fail at once. Measured before the fix:
  // the poll threw "kv unavailable" instead of "feed fetch timed out", so an
  // operator investigating a broken feed would have been sent to the database.
  // The diagnostic must never replace the diagnosis.
  const stores = memoryStores();
  const broken: Stores = {
    describe: stores.describe,
    blobs: stores.blobs,
    metadata: new Proxy(stores.metadata, {
      get(target, prop, _receiver) {
        if (prop === "recordRun") return () => Promise.reject(new Error("kv unavailable"));
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const { ctx: app } = ctx(broken);

  const thrown = await assertRejects(
    () =>
      recordRun(
        app,
        "feed-poll",
        "cron",
        () => Promise.reject(new Error("feed fetch timed out")),
        () => ({}),
      ),
    Error,
  );
  assertEquals(
    thrown.message,
    "feed fetch timed out",
    "the caller must learn why the RUN failed, not why the history write failed",
  );
});

Deno.test("a non-Error rejection still produces a readable record (audio-feed-ndc)", async () => {
  // `throw "string"` and `throw { code: 500 }` are legal. `String(err.message)`
  // on those yields "undefined", which would put a useless row on the dashboard.
  const { ctx: app, stores } = ctx();

  await assertRejects(() =>
    recordRun(app, "synthesis", "cron", () => Promise.reject("just a string"), () => ({}))
  );

  const [record] = await stores.metadata.listRuns();
  assertEquals(record?.error, "just a string");
});

Deno.test("the trigger distinguishes cron from a manual click (audio-feed-ndc)", async () => {
  const { ctx: app, stores } = ctx();

  await recordRun(app, "feed-poll", "cron", () => Promise.resolve(null), () => ({}));
  await recordRun(app, "feed-poll", "manual", () => Promise.resolve(null), () => ({}));

  const runs = await stores.metadata.listRuns();
  assertEquals(runs.length, 2);
  assertEquals(new Set(runs.map((r: RunRecord) => r.trigger)), new Set(["cron", "manual"]));
});

Deno.test("startedAt is when the run STARTED, and duration covers the work (audio-feed-ndc)", async () => {
  // Recording after the fact makes it easy to stamp the END time by accident,
  // which would make "last polled 4 minutes ago" mean "finished 4 minutes ago"
  // — a difference that matters on a poll that takes a minute.
  const { ctx: app, stores } = ctx();

  const before = Date.now();
  await recordRun(
    app,
    "feed-poll",
    "cron",
    () => new Promise((resolve) => setTimeout(() => resolve(null), 30)),
    () => ({}),
  );
  const after = Date.now();

  const [record] = await stores.metadata.listRuns();
  assert(record, "recorded");
  const startedAt = Date.parse(record.startedAt);
  assert(Number.isFinite(startedAt), "startedAt must be a parseable ISO timestamp");
  // Stamped at the start: it cannot be later than the moment the work finished.
  assert(
    startedAt >= before - 1000 && startedAt <= after,
    `startedAt ${record.startedAt} must fall inside the run's own window`,
  );
  assert(record.durationMs >= 25, `durationMs ${record.durationMs} must cover the work`);
});

Deno.test("a store that cannot record does not fail the run (audio-feed-ndc)", async () => {
  // The doc comment claims recording failures are swallowed so a diagnostic
  // write can never be the reason a poll reports failure. That is a claim about
  // the ADAPTERS, not about this helper, so it gets driven rather than trusted:
  // both shipped adapters swallow, and this pins the contract they honour.
  const stores = memoryStores();
  // A Proxy, NOT `{ ...stores.metadata, recordRun }`. The adapters are class
  // instances, so their methods live on the prototype and a spread copies none
  // of them — the override would work by accident only while this helper happens
  // to call nothing else, and would break silently the moment it did.
  const broken: Stores = {
    describe: stores.describe,
    blobs: stores.blobs,
    metadata: new Proxy(stores.metadata, {
      get(target, prop, _receiver) {
        if (prop === "recordRun") return () => Promise.reject(new Error("kv unavailable"));
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const { ctx: app } = ctx(broken);

  // If this rejects, a transient storage blip turns a SUCCESSFUL poll into a
  // reported failure — the comment would be describing an intention the code
  // does not have.
  let outcome: string;
  try {
    outcome = await recordRun(
      app,
      "feed-poll",
      "cron",
      () => Promise.resolve("work finished"),
      () => ({}),
    );
  } catch (error) {
    throw new Error(
      "a failed history write must not fail the run it describes, but it did: " +
        String((error as Error).message),
    );
  }
  assertEquals(outcome, "work finished");
});
