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
import { CWV_RATE_LIMIT, limitBodyStream, MAX_CWV_BODY_BYTES } from "../src/routes/cwv.ts";
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
  // A socket address, so the per-client bound applies: an unaddressed client
  // deliberately gets a deployment-sized quota instead (audio-feed-0t8el).
  const client = { remoteAddr: { hostname: "203.0.113.60" } };
  // One over the limit, so the boundary is exercised rather than assumed.
  for (let i = 0; i <= CWV_RATE_LIMIT.maxRequests; i++) {
    const res = await fetch(beacon({ metric: "lcp", value: 1000, page: "home" }), client);
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

Deno.test("the byte cap bounds the READ, not the decoded string (audio-feed-6q9g)", async () => {
  const { fetch, stores } = app();
  // Multibyte: the character count stays under the cap while the bytes are several times it, which
  // is exactly the body a `text.length` check waves through.
  const multibyte = "é".repeat(MAX_CWV_BODY_BYTES);
  assert(multibyte.length <= MAX_CWV_BODY_BYTES, "the fixture is under the cap by characters");
  assert(
    new TextEncoder().encode(multibyte).byteLength > MAX_CWV_BODY_BYTES,
    "and over it by bytes",
  );
  const big = await fetch(beacon({ metric: "lcp", value: 1, pad: multibyte }));
  assertEquals(big.status, 413);
  assertEquals((await big.json()).error, "payload_too_large");

  // Streamed: a chunked body declares no content-length, so the declared check has nothing to see.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"metric":"lcp","value":1,"pad":"'));
      controller.enqueue(new TextEncoder().encode("x".repeat(MAX_CWV_BODY_BYTES * 2)));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  const chunked = await fetch(
    new Request(`${BASE}/api/cwv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit),
  );
  assertEquals(chunked.status, 413, "a streamed body with no declared size is still bounded");

  // And neither of them was stored.
  assertEquals((await stores.metadata.listLogs()).filter((r) => r.type === "cwv.report").length, 0);
});

Deno.test("a pathological queue wait is an error, not invisible info (audio-feed-cbzg)", () => {
  // An hour of waiting is the diagnosis this span exists to provide, and `info` is filtered out of
  // the default poller's view.
  const stuck = spanSeverity({ queueWaitMs: 3_600_000, synthesisMs: 1_000, writeMs: 10 });
  assertEquals(stuck.severity, "error");
  assertStringIncludes(stuck.reason ?? "", "waited");
  assertStringIncludes(stuck.reason ?? "", "worker");

  const slow = spanSeverity({ queueWaitMs: 600_000, synthesisMs: 1_000, writeMs: 10 });
  assertEquals(slow.severity, "warn");

  // And the queue is checked before the phases it explains, so a long wait does not get reported as
  // a slow synthesis and point the reader at the wrong component.
  const both = spanSeverity({ queueWaitMs: 3_600_000, synthesisMs: 400_000, writeMs: 10 });
  assertEquals(both.severity, "error");
  assertStringIncludes(both.reason ?? "", "worker");
});

Deno.test("the read is bounded by construction, not by checking afterwards (audio-feed-6q9g)", async () => {
  const cap = 1024;

  // The reviewer's case: the whole body in ONE chunk, far larger than the cap. Reading the raw body
  // and comparing a running total would have handed this chunk to the handler before any check ran.
  const big = new Uint8Array(8 * 1024 * 1024).fill(65);
  const limited = limitBodyStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    }),
    cap,
  );

  const reader = limited.getReader();
  const chunks: Uint8Array[] = [];
  let emitted = 0;
  let failed = false;
  while (true) {
    try {
      const { value, done } = await reader.read();
      if (done) break;
      emitted += value.byteLength;
      chunks.push(value);
    } catch {
      failed = true;
      break;
    }
  }

  // MAX BYTES CONSUMED is the assertion, not merely the status: the stream may not emit more than
  // cap + 1 bytes no matter how the source is chunked, and it must fail rather than quietly truncate.
  assertEquals(emitted, cap + 1, "at most cap + 1 bytes ever leave the stream");
  assert(failed, "exceeding the cap is an error, not a silent truncation");
  assertEquals(chunks.length, 1, "the oversized chunk was truncated, not accumulated");

  // Many small chunks over the cap behave the same way.
  const many = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 100; i++) controller.enqueue(new Uint8Array(100).fill(65));
      controller.close();
    },
  });
  const manyReader = limitBodyStream(many, cap).getReader();
  let seen = 0;
  let over = false;
  try {
    while (true) {
      const { value, done } = await manyReader.read();
      if (done) break;
      seen += value.byteLength;
    }
  } catch {
    over = true;
  }
  assertEquals(seen, cap + 1, "the same bound holds for many small chunks");
  assert(over, "and it still fails rather than truncating silently");

  // A body exactly at the cap is NOT an error: cap + 1 is the sentinel, not the limit.
  const exact = await limitBodyStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(cap).fill(65));
        controller.close();
      },
    }),
    cap,
  ).getReader().read();
  assertEquals(exact.value?.byteLength, cap);
  assertEquals(exact.done, false);
});
