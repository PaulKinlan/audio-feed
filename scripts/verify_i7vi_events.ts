/**
 * End-to-end verification of the observability event families (audio-feed-i7vi / obs-4).
 *
 * Drives the REAL server (`bootstrap`), so this covers what the unit tests cannot: that the beacon
 * route is registered, that a report survives the whole path and lands as a typed record, that its
 * severity follows the published bands, and that nothing about the payload reaches the request log.
 *
 * Exits non-zero on any failed check.
 */

import { openStores } from "../src/config.ts";
import { bootstrap } from "../src/server.ts";
import { spanSeverity, synthesisSpan } from "../src/observability/spans.ts";

const BASE = "http://localhost";
const CANARY = "qV7z52CapSECRETfd39Nd";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const stores = await openStores({ kvPath: ":memory:" });
const server = await bootstrap({
  port: 0,
  stores,
  isDeploy: true,
  synthesizer: null,
  inventory: false,
});

const beacon = (body: unknown) =>
  server.fetch(
    new Request(`${BASE}/api/cwv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

try {
  // A real page's sequence: a good LCP, a poor CLS, an INP in the middle band.
  const sent: [unknown, number][] = [
    [{ metric: "lcp", value: 1_800, page: "listen" }, 204],
    [{ metric: "cls", value: 0.42, page: "home" }, 204],
    [{ metric: "inp", value: 320, page: "account" }, 204],
    // And a report that is not a measurement.
    [{ metric: "lcp", value: CANARY, page: CANARY }, 400],
  ];
  for (const [body, expected] of sent) {
    const res = await beacon(body);
    check(
      `beacon ${JSON.stringify(body).slice(0, 44)} -> ${expected}`,
      res.status === expected,
      `got ${res.status}`,
    );
  }

  const records = await stores.metadata.listLogs();
  const cwv = records.filter((r) => r.type === "cwv.report");
  check("three valid reports became three typed records", cwv.length === 3, `${cwv.length}`);
  for (const record of cwv) {
    console.log(
      `  ${record.severity.padEnd(5)} ${record.message}  context=${JSON.stringify(record.context)}`,
    );
  }
  // The bands: 1800ms LCP is good, 320ms INP needs improvement, 0.42 CLS is poor. The band is a
  // RATING on the record's context, not a severity — every CWV record is written at severity
  // "info" (a report is an observation, not an error), and the band lives in context.rating
  // (src/observability/cwv.ts).
  check(
    "the web-vitals band rides as context.rating at severity info, so a poor CLS is a poor rating, not an error event",
    cwv.find((r) => r.context?.metric === "lcp")?.severity === "info" &&
      cwv.find((r) => r.context?.metric === "lcp")?.context?.rating === "good" &&
      cwv.find((r) => r.context?.metric === "inp")?.severity === "info" &&
      cwv.find((r) => r.context?.metric === "inp")?.context?.rating === "needs-improvement" &&
      cwv.find((r) => r.context?.metric === "cls")?.severity === "info" &&
      cwv.find((r) => r.context?.metric === "cls")?.context?.rating === "poor",
  );
  // A refused beacon IS recorded — a caller being turned away is a finding — while a successful one is
  // not, because a page sends it and a record per report would be an event inside the store being
  // measured. So the count is exactly the one refusal, and its content still must not be in the log.
  const requests = records.filter((r) => r.type === "http.request");
  check(
    "only the refused beacon is recorded as a request, not the three that succeeded",
    requests.length === 1,
    `${requests.length} request record(s)`,
  );
  check(
    "and that request record carries no part of the payload",
    !JSON.stringify(requests).includes(CANARY) && !JSON.stringify(requests).includes("qV7z52"),
  );
  check(
    "the refused value and the canary page label are nowhere in the store",
    !JSON.stringify(records).includes(CANARY),
  );

  // The job span: the worker's own emission is covered by the worker test suite (which drives the
  // real synthesis path); this shows the shape and the arithmetic it records.
  const phases = { queueWaitMs: 4_200, synthesisMs: 61_500, writeMs: 380 };
  const span = synthesisSpan({ id: "epi-demo", userId: "user-demo", attempts: 1 }, phases);
  await stores.metadata.appendLog(span);
  const stored = (await stores.metadata.listLogs()).find((r) => r.type === "synthesis.span");
  check("a span is stored and joins to its episode", stored?.correlationId === "epi-demo");
  check(
    "the phases sum to the recorded total",
    stored?.durationMs === phases.queueWaitMs + phases.synthesisMs + phases.writeMs,
    `${stored?.durationMs}`,
  );
  check(
    "a slow synthesis is a warn with a reason, so it surfaces beside the errors",
    spanSeverity({ ...phases, synthesisMs: 400_000 }).severity === "warn" &&
      Boolean(spanSeverity({ ...phases, synthesisMs: 400_000 }).reason),
  );
  console.log(`  span: ${stored?.message}`);

  // Both families live in ONE store, which is what lets obs-1 serve errors, traces and vitals
  // together rather than making an operator correlate two systems.
  const types = [...new Set((await stores.metadata.listLogs()).map((r) => r.type))].sort();
  check(
    "errors, traces and vitals are all records in ONE store, so one API can serve them together",
    types.join(",") === "cwv.report,http.request,synthesis.span",
    types.join(", "),
  );
} finally {
  await server.shutdown();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED`);
Deno.exit(failures === 0 ? 0 : 1);
