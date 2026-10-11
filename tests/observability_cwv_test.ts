/**
 * Real-user CWV ingest and job spans (audio-feed-i7vi / obs-4).
 *
 * The beacon is a public write endpoint fed by a stranger's browser, so most of this file is about
 * what it does with nonsense: numbers only, allow-lists, bounded size, a rate limit, and a typed
 * record that never becomes a request field.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores, type Stores } from "../src/config.ts";
import { CWV_RATE_LIMIT, MAX_CWV_BODY_BYTES } from "../src/routes/cwv.ts";
import { cwvRecord, cwvSeverity, parseCwvReport } from "../src/observability/cwv.ts";
import { spanSeverity, SYNTHESIS_SPAN_EVENT, synthesisSpan } from "../src/observability/spans.ts";

const BASE = "https://audio.example";
/** A capability-looking string: nothing about it may survive ingest. */
const CANARY = "qV7z52CapSECRETfd39Nd";

function app(stores: Stores = memoryStores()) {
  const config = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const ctx = { config, stores };
  return { fetch: createApp(ctx, createHandlers(ctx)).fetch, stores };
}

const beacon = (body: unknown, init: RequestInit = {}) =>
  new Request(`${BASE}/api/cwv`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

Deno.test("a report becomes a typed cwv.report record, and never a request field", async () => {
  const { fetch, stores } = app();
  const res = await fetch(beacon({ metric: "lcp", value: 2500, page: "listen" }));
  assertEquals(res.status, 204);
  assertEquals(await res.text(), "", "the beacon is never echoed back");

  const records = await stores.metadata.listLogs();
  assertEquals(records.length, 1);
  const record = records[0]!;
  assertEquals(record.type, "cwv.report");
  assertEquals(record.context?.metric, "lcp");
  assertEquals(record.context?.value, 2500);
  assertEquals(record.context?.page, "listen");
  assertStringIncludes(record.message, "LCP");
});

Deno.test("the standard bands decide severity, so a bad metric is an error event", async () => {
  // These are the published web-vitals bands, not thresholds invented here.
  assertEquals(cwvSeverity("lcp", 2000), "info");
  assertEquals(cwvSeverity("lcp", 3000), "warn");
  assertEquals(cwvSeverity("lcp", 5000), "error");
  assertEquals(cwvSeverity("inp", 150), "info");
  assertEquals(cwvSeverity("inp", 300), "warn");
  assertEquals(cwvSeverity("inp", 900), "error");
  assertEquals(cwvSeverity("cls", 0.05), "info");
  assertEquals(cwvSeverity("cls", 0.2), "warn");
  assertEquals(cwvSeverity("cls", 0.5), "error");

  // And the record carries it, which is what puts a bad LCP in the errors feed beside a slow
  // synthesis rather than in a dashboard nobody reads.
  const { fetch, stores } = app();
  await fetch(beacon({ metric: "cls", value: 0.9, page: "home" }));
  const record = (await stores.metadata.listLogs())[0]!;
  assertEquals(record.severity, "error");
});

Deno.test("only numbers in a plausible range are accepted; everything else is refused", () => {
  const rejected: [unknown, string][] = [
    [null, "body must be a JSON object"],
    [[], "body must be a JSON object"],
    ["lcp", "body must be a JSON object"],
    [{ metric: "fcp", value: 1 }, "metric must be one of"],
    [{ metric: "lcp" }, "value must be a non-negative finite number"],
    [{ metric: "lcp", value: "2500" }, "value must be a non-negative finite number"],
    [{ metric: "lcp", value: Number.NaN }, "value must be a non-negative finite number"],
    [
      { metric: "lcp", value: Number.POSITIVE_INFINITY },
      "value must be a non-negative finite number",
    ],
    [{ metric: "lcp", value: -1 }, "value must be a non-negative finite number"],
    [{ metric: "lcp", value: 3_600_001 }, "beyond the plausible range"],
    [{ metric: "cls", value: 11 }, "beyond the plausible range"],
  ];
  for (const [payload, expected] of rejected) {
    const result = parseCwvReport(payload);
    assertEquals(result.ok, false, JSON.stringify(payload));
    if (!result.ok) assertStringIncludes(result.reason, expected);
  }
});

Deno.test("a string cannot survive ingest at all: the fields are numbers and allow-lists", () => {
  const raw = { metric: "lcp", value: 1234, page: CANARY, extra: CANARY, note: { deep: CANARY } };
  const result = parseCwvReport(raw);
  assert(result.ok, "the valid parts are still usable");
  if (result.ok) {
    assertEquals(result.report.page, "unknown", "an unusable page label is not trusted");
    const record = cwvRecord(result.report);
    const serialised = JSON.stringify(record);
    assert(!serialised.includes(CANARY), `no part of the payload survives: ${serialised}`);
  }
});

Deno.test("the beacon rejects what it cannot use, without echoing it", async () => {
  const { fetch, stores } = app();
  const bad = await fetch(beacon({ metric: "lcp", value: "not-a-number" }));
  assertEquals(bad.status, 400);
  const body = await bad.json();
  assertEquals(body.error, "invalid_report");
  assert(!JSON.stringify(body).includes("not-a-number"), "the refused value is not echoed");

  const notJson = await fetch(
    new Request(`${BASE}/api/cwv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"metric":"lcp","value":${CANARY}}`,
    }),
  );
  assertEquals(notJson.status, 400);
  assert(!JSON.stringify(await notJson.json()).includes(CANARY));

  assertEquals((await fetch(new Request(`${BASE}/api/cwv`, { method: "POST" }))).status, 415);
  assertEquals(
    (await fetch(beacon({ metric: "lcp", value: 1 }, {
      headers: { "content-type": "text/plain" },
    }))).status,
    415,
  );
  const huge = await fetch(
    beacon({ metric: "lcp", value: 1, pad: "x".repeat(MAX_CWV_BODY_BYTES) }),
  );
  assert(huge.status === 413 || huge.status === 400, `oversized body: ${huge.status}`);

  // A refused beacon is a request worth recording; an accepted one is not.
  const recorded = await stores.metadata.listLogs();
  assertEquals(recorded.filter((r) => r.type === "cwv.report").length, 0);
});

Deno.test("the beacon is rate limited per client", async () => {
  const { fetch } = app();
  let refused = 0;
  // One over the limit, so the boundary is exercised rather than assumed.
  for (let i = 0; i <= CWV_RATE_LIMIT.maxRequests; i++) {
    const res = await fetch(beacon({ metric: "lcp", value: 1000, page: "home" }));
    if (res.status === 429) {
      refused++;
      assert(res.headers.get("retry-after"), "a refused client is told when to come back");
    }
  }
  assertEquals(refused, 1);
});

Deno.test("a job span carries the phases and they sum to the total", () => {
  const record = synthesisSpan({ id: "epi-1", userId: "user-1", attempts: 2 }, {
    queueWaitMs: 12_000.4,
    synthesisMs: 45_000.6,
    writeMs: 300.2,
  });
  assertEquals(record.type, SYNTHESIS_SPAN_EVENT);
  assertEquals(record.process, "worker");
  assertEquals(record.correlationId, "epi-1");
  assertEquals(record.episodeId, "epi-1");
  assertEquals(record.attempt, 2);
  assertEquals(record.context, { queueWaitMs: 12_000, synthesisMs: 45_001, writeMs: 300 });
  // The total is the sum of the parts, so a reader can check the arithmetic rather than trust it.
  assertEquals(record.durationMs, 12_000 + 45_001 + 300);
  // A span that simply happened is not a finding.
  assertEquals(record.severity, "info");
  assertEquals(record.reason, undefined);
});

Deno.test("a span that took too long says so, at a severity the errors feed serves", () => {
  const slow = spanSeverity({ queueWaitMs: 0, synthesisMs: 400_000, writeMs: 10 });
  assertEquals(slow.severity, "warn");
  assertStringIncludes(slow.reason ?? "", "over the");

  const slowWrite = spanSeverity({ queueWaitMs: 0, synthesisMs: 1000, writeMs: 9000 });
  assertEquals(slowWrite.severity, "warn");
  assertStringIncludes(slowWrite.reason ?? "", "write");

  const fine = spanSeverity({ queueWaitMs: 0, synthesisMs: 1000, writeMs: 10 });
  assertEquals(fine.severity, "info");
  assertEquals(fine.reason, undefined);

  // And the severity reaches the record, which is what makes it visible to a poller.
  const record = synthesisSpan({ id: "epi-2", userId: "user-1" }, {
    queueWaitMs: 0,
    synthesisMs: 400_000,
    writeMs: 10,
  }, spanSeverity({ queueWaitMs: 0, synthesisMs: 400_000, writeMs: 10 }));
  assertEquals(record.severity, "warn");
  assert(record.reason, "a flagged span explains itself");
});

Deno.test("negative or absurd timings cannot produce an absurd span", () => {
  const record = synthesisSpan({ id: "epi-3", userId: "user-1" }, {
    queueWaitMs: -500,
    synthesisMs: Number.NaN,
    writeMs: 1.6,
  });
  // A clock that stepped backwards is not a negative duration, and not a NaN either.
  assertEquals(record.context, { queueWaitMs: 0, synthesisMs: 0, writeMs: 2 });
  assertEquals(record.durationMs, 2);
});
