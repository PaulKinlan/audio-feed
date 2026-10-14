import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores, openStores, type Stores } from "../src/config.ts";
import {
  detectOverdueInvocations,
  INVOCATION_SCAN_LIMIT,
  MAX_INVOCATION_ATTEMPTS,
} from "../src/observability/invocation_overdue.ts";

const NOW = Date.parse("2026-10-13T20:00:00.000Z");
const BASE = "https://audio.example";
const KEY = "local-observability-test-key";

async function mark(
  stores: Stores,
  id: string,
  phase: "started" | "terminal",
  timeMs: number,
  budgetMs = 180_000,
) {
  const written = await stores.metadata.appendLog({
    time: new Date(timeMs).toISOString(),
    severity: "info",
    type: "synthesis.invocation",
    process: "worker",
    job: "synthesis",
    correlationId: id,
    phase,
    message: `synthesis invocation ${id} ${phase}`,
    context: { invocationId: id, budgetMs },
  });
  assert(written);
  return written;
}

async function warningRecords(stores: Stores) {
  return (await stores.metadata.listLogs()).filter((event) =>
    event.type === "synthesis.invocation.overdue"
  );
}

function fetchApi(stores: Stores, path: string) {
  const ctx = {
    config: { port: 8000, publicBaseUrl: BASE, adminToken: "test-admin", observabilityKey: KEY },
    stores,
  };
  return createApp(ctx, createHandlers(ctx)).fetch(
    new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${KEY}` } }),
  );
}

Deno.test("a7i0: strict two-times-recorded-180s boundary and completed/delayed controls", async () => {
  const stores = memoryStores();
  await mark(stores, "within-budget", "started", NOW - 360_000);
  await mark(stores, "completed", "started", NOW - 500_000);
  await mark(stores, "completed", "terminal", NOW - 490_000);
  await mark(stores, "delayed-completed", "started", NOW - 600_000);
  await mark(stores, "delayed-completed", "terminal", NOW - 1_000);
  await mark(stores, "overdue", "started", NOW - 360_001);
  const first = await detectOverdueInvocations(stores.metadata, NOW);
  assertEquals(first.warningsWritten, 1, "one millisecond over twice the 180s budget fires");
  const alerts = await warningRecords(stores);
  assertEquals(
    alerts.map((event) => event.correlationId),
    ["overdue"],
    "at the threshold, on-time complete, and late-but-complete do not alert",
  );
  assertEquals(alerts[0]?.severity, "warn");
  assertStringIncludes(alerts[0]!.message, "No terminal mark was observed");
  assertStringIncludes(alerts[0]!.message, "Cause and current state are unknown");
  assert(!/platform kill|was killed|has died/i.test(alerts[0]!.message));
  const again = await detectOverdueInvocations(stores.metadata, NOW);
  assertEquals(again.warningsWritten, 0);
  assertEquals((await warningRecords(stores)).length, 1, "no repeat even after a later scan");
});

Deno.test("a7i0: changing the recorded budget changes the deadline, not current config", async () => {
  const stores = memoryStores();
  await mark(stores, "long-budget", "started", NOW - 400_000, 240_000);
  assertEquals(
    (await detectOverdueInvocations(stores.metadata, NOW)).warningsWritten,
    0,
    "400s is inside twice this invocation's recorded 240s budget",
  );
  assertEquals(
    (await detectOverdueInvocations(stores.metadata, NOW + 80_001)).warningsWritten,
    1,
    "481s is strictly beyond twice the recorded 240s budget",
  );
});

Deno.test("a7i0: two concurrent detector reads emit exactly one durable warning", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const stores = await openStores({ kvPath: `${dir}/overdue.kv` });
    try {
      await mark(stores, "same-invocation", "started", NOW - 360_001);
      const [left, right] = await Promise.all([
        detectOverdueInvocations(stores.metadata, NOW),
        detectOverdueInvocations(stores.metadata, NOW),
      ]);
      assertEquals(
        left.warningsWritten + right.warningsWritten,
        1,
        "both readers actually see a due start; only one may win the CAS",
      );
      assertEquals(
        (await warningRecords(stores)).length,
        1,
        "a durable unique guard prevents a second event with a new cursor",
      );
    } finally {
      await stores.metadata.close();
    }
    const reopened = await openStores({ kvPath: `${dir}/overdue.kv` });
    try {
      assertEquals((await detectOverdueInvocations(reopened.metadata, NOW + 1)).warningsWritten, 0);
      assertEquals((await warningRecords(reopened)).length, 1, "dedupe survives restart");
    } finally {
      await reopened.metadata.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a7i0: the whole request stops at its cap and reports remaining work", async () => {
  const stores = memoryStores();
  for (let i = 0; i < 10; i++) {
    await mark(stores, `capped-${i}`, "started", NOW - 360_001);
  }
  let reads = 0;
  const list = stores.metadata.listLogs.bind(stores.metadata);
  stores.metadata.listLogs = (...args) => {
    reads++;
    return list(...args);
  };
  const first = await detectOverdueInvocations(stores.metadata, NOW);
  assertEquals(first.warningsWritten, 8);
  assertEquals(first.moreDue, true, "the remaining two are visible as unfinished detector work");
  assert(first.inspectedAttempts <= MAX_INVOCATION_ATTEMPTS);
  assert(reads <= MAX_INVOCATION_ATTEMPTS + 1, "whole-request log reads have a bound");
  const second = await detectOverdueInvocations(stores.metadata, NOW);
  assertEquals(second.warningsWritten, 2);
  assertEquals(second.moreDue, false);
  assertEquals(
    (await warningRecords(stores)).length,
    10,
    "repeated polls finish outstanding work but never duplicate earlier warnings",
  );
});

Deno.test("a7i0: a repeatedly polled already-guarded set costs one scan, not a scan per start", async () => {
  const stores = memoryStores();
  for (let i = 0; i < 120; i++) {
    const id = `previous-${i}`;
    await mark(stores, id, "started", NOW - 360_001);
    const bounds = await stores.metadata.logBounds();
    assertEquals(
      await stores.metadata.appendLogOnce(
        {
          time: new Date(NOW).toISOString(),
          severity: "warn",
          type: "synthesis.invocation.overdue",
          message: "previously reported",
          process: "worker",
          correlationId: id,
        },
        `overdue:${id}`,
        bounds.newestSeq,
      ),
      "written",
    );
  }
  let reads = 0;
  const list = stores.metadata.listLogs.bind(stores.metadata);
  stores.metadata.listLogs = (...args) => {
    reads++;
    return list(...args);
  };
  for (let poll = 0; poll < 2; poll++) {
    const result = await detectOverdueInvocations(stores.metadata, NOW + poll);
    assertEquals(result.warningsWritten, 0);
    assertEquals(result.moreDue, false, "the prior guard is recognized within the snapshot");
    assertEquals(
      result.inspectedAttempts,
      0,
      "a known warning does not trigger a redundant CAS or 500-record reread",
    );
  }
  assertEquals(reads, 2, "one bounded scan per poll, not one per previously warned start");
  assertEquals((await warningRecords(stores)).length, 120);
});

Deno.test("a7i0: repeated duplicate replies cannot exhaust the request without an unknown remainder", async () => {
  const stores = memoryStores();
  for (let i = 0; i < 20; i++) await mark(stores, `duplicate-${i}`, "started", NOW - 360_001);
  // An adversarial/out-of-sync guard reports a duplicate without a visible warning.
  // The detector must not loop forever or call this a complete inspection.
  stores.metadata.appendLogOnce = () => Promise.resolve("duplicate");
  let reads = 0;
  const list = stores.metadata.listLogs.bind(stores.metadata);
  stores.metadata.listLogs = (...args) => {
    reads++;
    return list(...args);
  };
  const result = await detectOverdueInvocations(stores.metadata, NOW);
  assertEquals(
    result.inspectedAttempts,
    MAX_INVOCATION_ATTEMPTS,
    "attempts stop at the WHOLE-REQUEST bound even without a new warning",
  );
  assertEquals(
    result.moreDue,
    true,
    "remaining starts are not falsely classified as checked or healthy",
  );
  assertEquals(result.warningsWritten, 0);
  assertEquals(
    reads,
    MAX_INVOCATION_ATTEMPTS + 1,
    "the request makes no extra unbounded snapshot reads",
  );
});

Deno.test("a7i0: pruning warning and guard together preserves retention honesty", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const stores = await openStores({ kvPath: `${dir}/retention.kv` });
    try {
      await mark(stores, "pruned", "started", NOW - 360_001);
      assertEquals((await detectOverdueInvocations(stores.metadata, NOW)).warningsWritten, 1);
      assertEquals(await stores.metadata.pruneLogs(new Date(NOW + 1)), 2);
      const scan = await detectOverdueInvocations(stores.metadata, NOW + 2);
      assertEquals(scan.warningsWritten, 0, "a pruned start must never be re-reported");
      assertEquals(scan.retentionGap, true);
      assertEquals(
        scan.olderStartsUnknown,
        true,
        "pruned history cannot be treated as evidence that no overdue start existed",
      );
      const bounds = await stores.metadata.logBounds();
      assertEquals(
        await stores.metadata.appendLogOnce(
          {
            time: new Date(NOW + 2).toISOString(),
            severity: "warn",
            type: "synthesis.invocation.overdue",
            process: "worker",
            message: "guard probe",
            correlationId: "pruned",
          },
          "overdue:pruned",
          bounds.newestSeq,
        ),
        "written",
        "prune removed the warning's unique guard in the same retained boundary",
      );
    } finally {
      await stores.metadata.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a7i0: terminal appended after a scan but before CAS invalidates the alert", async () => {
  const stores = memoryStores();
  await mark(stores, "late-race", "started", NOW - 360_001);
  const original = stores.metadata.appendLogOnce.bind(stores.metadata);
  let invoked = 0;
  stores.metadata.appendLogOnce = async (...args) => {
    if (invoked++ === 0) await mark(stores, "late-race", "terminal", NOW);
    return original(...args);
  };
  const result = await detectOverdueInvocations(stores.metadata, NOW);
  assertEquals(invoked, 1, "CAS arm fired after the first snapshot");
  assertEquals(result.warningsWritten, 0);
  assertEquals(await warningRecords(stores), [], "late completion, not a false warning");
});

Deno.test("a7i0: summary fires default warn feed; partial history and log failures never claim clean", async () => {
  const stores = memoryStores();
  await mark(stores, "deadline", "started", NOW - 2_000_000);
  // Use current wall time for this request: a fixed historical event is already overdue.
  const summary = await fetchApi(stores, "/api/observability/summary?since=0");
  assertEquals(summary.status, 200);
  const body = await summary.json();
  assertEquals(body.bySeverity.warn, 1, "the summary gate sees the durable alert before idle");
  assertEquals(body.invocationDetection.warningsWritten, 1);
  const page = await fetchApi(stores, "/api/observability/errors?since=0");
  const events = (await page.json()).events;
  assertEquals(events.map((event: { type: string }) => event.type), [
    "synthesis.invocation.overdue",
  ], "default warn filter surfaces exactly one event even though it scans over info marks");
  for (let i = 0; i < INVOCATION_SCAN_LIMIT + 1; i++) {
    const event = await stores.metadata.appendLog({
      time: new Date().toISOString(),
      severity: "info",
      type: "test.filler",
      message: "filler",
      process: "worker",
    });
    assert(event);
  }
  const partial = await (await fetchApi(stores, "/api/observability/summary?since=0")).json();
  assertEquals(
    partial.invocationDetection.olderStartsUnknown,
    true,
    "last 500 records cannot rule out an older starved start",
  );
  assert(partial.invocationDetection.scannedFromSeq > 1);
  stores.metadata.listLogs = () => Promise.reject(new Error("injected log read failure"));
  const refused = await fetchApi(stores, "/api/observability/summary?since=0");
  assertEquals(refused.status, 503, "read failure must not return idle total 0 or cursor");
  const failure = await refused.json();
  assertEquals(failure.error, "invocation_detection_unavailable");
  assertEquals(failure.cursor, undefined);
});

/**
 * The stage mark a running invocation leaves: the real shape, so the detector is reading the record
 * production writes rather than one invented to suit the test (audio-feed-fsd9).
 */
async function stageMark(
  stores: Stores,
  id: string,
  stage: string,
  timeMs: number,
  durationMs: number,
) {
  const written = await stores.metadata.appendLog({
    time: new Date(timeMs).toISOString(),
    severity: "info",
    type: "synthesis.stage",
    process: "worker",
    job: "synthesis",
    correlationId: id,
    phase: stage,
    message: `synthesis stage ${stage} took ${durationMs}ms`,
    durationMs,
    context: { stage, episodeId: "episode-fsd9" },
  });
  assert(written, "the fixture stage mark must be stored");
  return written;
}

/**
 * audio-feed-fsd9, GAP 1 OF 3: the overdue warning could say WHEN the scan happened but nothing about
 * how much of its budget the invocation had actually consumed, so for one and the same record shape
 * `elapsed_at_scan` ranged over hours while the invocation's real life was seconds - "a cap was hit"
 * and "the turn is long" could not be told apart from our own store, which is why the diagnosis was
 * forced to ask the platform for a log it cannot get from inside an isolate.
 *
 * ACCEPTANCE (the expected failure signature, stated in advance rather than discovered afterwards):
 * with the last-observed-activity computation removed - `seen` falling back to the start mark for
 * every candidate - the FIRST assertion to fail is the `observedActiveMs` one, with the message
 * "the 60s this invocation was observed to be active is a measured fact, not a scan-relative
 * elapsed", reported as expected 60000 against an actual 0. The control that still passes in that
 * state is the completion control at the end of this test: a completed invocation is never warned
 * about, which is precisely why a red here proves the new field is load-bearing rather than proving
 * the scan is broken.
 */
Deno.test("fsd9: the overdue warning records what was last SEEN of the invocation", async () => {
  const stores = memoryStores();
  // The passing control: this invocation completes, so it must never be warned about.
  await mark(stores, "fsd9-completed", "started", NOW - 360_000, 60_000);
  await mark(stores, "fsd9-completed", "terminal", NOW - 300_000, 60_000);
  // Quiet: nothing at all was stored after the start mark. This is the killed-before-it-worked shape.
  await mark(stores, "fsd9-quiet", "started", NOW - 360_000, 60_000);
  // Active: sixty seconds of observed work, then silence. This is the consumed-budget shape.
  await mark(stores, "fsd9-active", "started", NOW - 360_000, 60_000);
  const stage = await stageMark(stores, "fsd9-active", "tts", NOW - 300_000, 60_000);
  // A NEWER record belonging to a DIFFERENT invocation must never be read as this one's activity.
  await mark(stores, "fsd9-other", "started", NOW - 1_000, 60_000);

  const scan = await detectOverdueInvocations(stores.metadata, NOW);
  assertEquals(scan.warningsWritten, 2, "the quiet and the active invocation are both overdue");
  const alerts = await warningRecords(stores);
  const active = alerts.find((event) => event.correlationId === "fsd9-active");
  const quiet = alerts.find((event) => event.correlationId === "fsd9-quiet");
  assert(active && quiet, "both overdue invocations carry a warning");

  assertEquals(
    active.context?.observedActiveMs,
    60_000,
    "the 60s this invocation was observed to be active is a measured fact, not a scan-relative elapsed",
  );
  assertEquals(
    quiet.context?.observedActiveMs,
    0,
    "an invocation with nothing after its start was observed active for zero milliseconds",
  );
  assertNotEquals(
    active.context?.observedActiveMs,
    quiet.context?.observedActiveMs,
    "a consumed budget and a long turn must be distinguishable from the store alone",
  );

  assertEquals(
    active.context?.lastSeenType,
    "synthesis.stage",
    "the last thing seen was a stage mark",
  );
  assertEquals(active.context?.lastSeenPhase, "tts", "and the stage it named is recorded");
  assertEquals(active.context?.lastSeenAt, new Date(NOW - 300_000).toISOString());
  assertEquals(
    active.context?.lastSeenSeq,
    stage.seq,
    "the sequence of that observation is recorded too",
  );
  assertEquals(
    active.context?.lastSeenAgoMs,
    300_000,
    "and how long ago it was, clamped rather than negative",
  );
  assertEquals(
    quiet.context?.lastSeenType,
    "synthesis.invocation",
    "quiet falls back to its own start mark",
  );
  assertEquals(quiet.context?.lastSeenPhase, "started");
  assertEquals(quiet.context?.lastSeenAgoMs, 360_000, "silence measured from that start mark");

  // The message carries the same facts, and the same deliberate limits: silence is not a cause.
  assertStringIncludes(active.message, "Its newest stored activity was synthesis.stage (tts)");
  assertStringIncludes(active.message, "60000ms into the invocation");
  assertStringIncludes(active.message, "300000ms before this scan");
  assertStringIncludes(quiet.message, "Nothing was stored for it after its start mark");
  assertStringIncludes(
    quiet.message,
    "whether the isolate is still running cannot be observed from inside it",
  );
  for (const event of [active, quiet]) {
    assertStringIncludes(event.message, "Cause and current state are unknown");
    assert(!/platform kill|was killed|has died|out of memory/i.test(event.message));
  }

  assertEquals(
    alerts.some((event) => event.correlationId === "fsd9-completed"),
    false,
    "CONTROL: a completed invocation is never warned about, in either direction",
  );

  // STORED IS NOT SERVED (audio-feed-scma): the fields have to survive the feed projection, or this
  // change would record evidence in a store no reader can reach. This row fails if the projection
  // drops `context` keys or the field is renamed on the way out.
  const page = await fetchApi(stores, "/api/observability/errors?since=0");
  assertEquals(page.status, 200);
  const served = ((await page.json()).events as Array<{
    correlationId?: string;
    context?: Record<string, unknown>;
  }>).find((event) => event.correlationId === "fsd9-active");
  assert(served, "the overdue warning is served to an authenticated reader");
  assertEquals(
    served.context?.observedActiveMs,
    60_000,
    "observedActiveMs survives the API projection, not merely the store",
  );
  assertEquals(served.context?.lastSeenType, "synthesis.stage", "and so does what was seen last");
});
