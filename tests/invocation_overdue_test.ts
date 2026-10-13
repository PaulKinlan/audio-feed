import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores, openStores, type Stores } from "../src/config.ts";
import {
  detectOverdueInvocations,
  INVOCATION_SCAN_LIMIT,
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
