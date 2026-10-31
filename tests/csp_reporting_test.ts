import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { esc, jsonForScript } from "../src/routes/html.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = {
  port: 8000,
  publicBaseUrl: BASE,
  adminToken: "admin-secret",
};

async function setupApp() {
  const stores: Stores = memoryStores();
  await Promise.resolve();
  const ctx = { config, stores };
  const handlers = createHandlers(ctx);
  const app = createApp(ctx, handlers);
  return { app, stores, ctx };
}

Deno.test("CSP reporting headers: HTML responses carry report-to, report-uri, Reporting-Endpoints, Report-To, and NEL", async () => {
  const { app } = await setupApp();

  const res = await app.fetch(new Request(`${BASE}/`));
  assertEquals(res.status, 200);

  // (1) CSP header carries BOTH report-to csp-endpoint AND report-uri https://<host>/api/reports/csp
  const csp = res.headers.get("content-security-policy");
  assert(csp, "response must have Content-Security-Policy");
  assertStringIncludes(csp, "report-to csp-endpoint", "CSP must include report-to csp-endpoint");
  assertStringIncludes(
    csp,
    `report-uri ${BASE}/api/reports/csp`,
    "CSP must include report-uri https://<host>/api/reports/csp",
  );

  // (2) Header Reporting-Endpoints: csp-endpoint="https://<host>/api/reports/csp"
  const reportingEndpoints = res.headers.get("reporting-endpoints");
  assert(reportingEndpoints, "response must have Reporting-Endpoints");
  assertStringIncludes(
    reportingEndpoints,
    `csp-endpoint="${BASE}/api/reports/csp"`,
    "Reporting-Endpoints must point to /api/reports/csp",
  );

  // (4) NEL needs the LEGACY Report-To header with an endpoint group (max_age, endpoints)
  const reportTo = res.headers.get("report-to");
  assert(reportTo, "response must have Report-To header for legacy reporting");
  assertStringIncludes(reportTo, '"group":"csp-endpoint"');
  assertStringIncludes(reportTo, '"max_age":');
  assertStringIncludes(reportTo, `{"url":"${BASE}/api/reports/csp"}`);
  assertStringIncludes(reportTo, '"group":"network-errors"');

  const nel = res.headers.get("nel");
  assert(nel, "response must have NEL header");
  assertStringIncludes(nel, '"report_to":"network-errors"');
  assertStringIncludes(nel, '"max_age":2592000');
});

Deno.test("CSP reporting endpoint: accepts application/reports+json array and flushes with 204", async () => {
  const { app, stores } = await setupApp();

  const reportsPayload = [
    {
      age: 10,
      type: "csp-violation",
      url: `${BASE}/listen`,
      user_agent: "Mozilla/5.0 TestBrowser",
      body: {
        documentURL: `${BASE}/listen`,
        effectiveDirective: "script-src-elem",
        blockedURL: "https://evil.example.com/xss.js",
        disposition: "enforce",
        statusCode: 200,
      },
    },
  ];

  const res = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: {
        "content-type": "application/reports+json",
        "origin": BASE,
      },
      body: JSON.stringify(reportsPayload),
    }),
  );

  assertEquals(res.status, 204, "endpoint must respond with 204 so browser flushes");

  const logs = await stores.metadata.listLogs();
  assertEquals(logs.length, 1, "exactly one report log record stored");
  const record = logs[0]!;
  assertEquals(record.type, "report.csp-violation");
  assertEquals(record.severity, "warn");
  assertEquals(record.route, "/api/reports/csp");
  assertEquals(record.process, "app");
  assertStringIncludes(record.message, "script-src-elem blocked https://evil.example.com/xss.js");
  assertEquals(record.context?.reportType, "csp-violation");
  assertEquals(record.context?.url, `${BASE}/listen`);
  assertEquals(record.context?.userAgent, "Mozilla/5.0 TestBrowser");
  assertEquals(record.context?.age, 10);
});

Deno.test("CSP reporting endpoint: accepts application/csp-report legacy object and flushes with 204", async () => {
  const { app, stores } = await setupApp();

  const legacyPayload = {
    "csp-report": {
      "document-uri": `${BASE}/account`,
      "referrer": `${BASE}/login`,
      "violated-directive": "style-src",
      "effective-directive": "style-src",
      "original-policy": "default-src 'self'",
      "disposition": "enforce",
      "blocked-uri": "https://malicious.example.com/bad.css",
      "line-number": 42,
      "column-number": 7,
      "source-file": `${BASE}/account`,
      "status-code": 200,
      "script-sample": "",
    },
  };

  const res = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: {
        "content-type": "application/csp-report",
        "user-agent": "LegacyBrowser/1.0",
        "origin": BASE,
      },
      body: JSON.stringify(legacyPayload),
    }),
  );

  assertEquals(res.status, 204, "legacy endpoint must respond with 204");

  const logs = await stores.metadata.listLogs();
  assertEquals(logs.length, 1);
  const record = logs[0]!;
  assertEquals(record.type, "report.csp-violation");
  assertEquals(record.severity, "warn");
  assertStringIncludes(record.message, "style-src blocked https://malicious.example.com/bad.css");
  assertEquals(record.context?.reportType, "csp-violation");
  assertEquals(record.context?.url, `${BASE}/account`);
  assertEquals(record.context?.userAgent, "LegacyBrowser/1.0");
});

Deno.test("CSP reporting endpoint: routes all required report types correctly with proper severities", async () => {
  const { app, stores } = await setupApp();

  const reports = [
    {
      type: "csp-violation",
      url: `${BASE}/page1`,
      body: { effectiveDirective: "img-src", blockedURL: "http://insecure.example.com/pic.png" },
    },
    {
      type: "deprecation",
      url: `${BASE}/page2`,
      body: { id: "WebAssemblyCompileStreaming", message: "Deprecated feature" },
    },
    {
      type: "intervention",
      url: `${BASE}/page3`,
      body: { id: "HeavyAdIntervention", message: "Resource intensive ad removed" },
    },
    {
      type: "crash",
      url: `${BASE}/page4`,
      body: { reason: "oom" },
    },
    {
      type: "coep",
      url: `${BASE}/page5`,
      body: { blockedURL: "https://cross-origin.example.com/subresource" },
    },
    {
      type: "permissions-policy-violation",
      url: `${BASE}/page6`,
      body: { featureId: "geolocation", disposition: "enforce" },
    },
    {
      type: "network-error",
      url: `${BASE}/page7`,
      body: { type: "dns.name_not_resolved", phase: "dns", status_code: 0 },
    },
  ];

  const res = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: { "content-type": "application/reports+json", "origin": BASE },
      body: JSON.stringify(reports),
    }),
  );
  assertEquals(res.status, 204);

  const logs = await stores.metadata.listLogs();
  assertEquals(logs.length, 7, "all 7 report types routed and stored");

  const byType = new Map(logs.map((l) => [l.type, l]));

  // 1. csp-violation -> warn
  const cspRec = byType.get("report.csp-violation");
  assert(cspRec);
  assertEquals(cspRec.severity, "warn");
  assertStringIncludes(cspRec.message, "img-src blocked http://insecure.example.com/pic.png");

  // 2. deprecation -> info
  const depRec = byType.get("report.deprecation");
  assert(depRec);
  assertEquals(depRec.severity, "info");
  assertStringIncludes(depRec.message, "WebAssemblyCompileStreaming");

  // 3. intervention -> warn
  const intRec = byType.get("report.intervention");
  assert(intRec);
  assertEquals(intRec.severity, "warn");
  assertStringIncludes(intRec.message, "HeavyAdIntervention");

  // 4. crash -> error (server endpoint only, invisible to client JS)
  const crashRec = byType.get("report.crash");
  assert(crashRec);
  assertEquals(crashRec.severity, "error");
  assertStringIncludes(crashRec.message, "reason=oom");

  // 5. coep -> warn
  const coepRec = byType.get("report.coep");
  assert(coepRec);
  assertEquals(coepRec.severity, "warn");
  assertStringIncludes(coepRec.message, "blocked https://cross-origin.example.com/subresource");

  // 6. permissions-policy-violation -> warn
  const permRec = byType.get("report.permissions-policy-violation");
  assert(permRec);
  assertEquals(permRec.severity, "warn");
  assertStringIncludes(permRec.message, "feature=geolocation");

  // 7. network-error -> warn
  const nelRec = byType.get("report.network-error");
  assert(nelRec);
  assertEquals(nelRec.severity, "warn");
  assertStringIncludes(nelRec.message, "type=dns.name_not_resolved phase=dns");
});

Deno.test("SECURITY: attacker-controlled report fields are sanitized and never rendered unescaped", async () => {
  const { app, stores } = await setupApp();

  const attackPayload = [
    {
      type: "csp-violation\x00\x1b[31m",
      url: `https://example.com/page?q=<script>alert('xss_url')</script>\x00`,
      user_agent: `Mozilla/5.0 <script>alert('xss_ua')</script>\u0000`,
      body: {
        __proto__: { polluted: true },
        "effectiveDirective": "script-src\x1b[32m",
        "blockedURL": "javascript:/*<script>alert('xss_blocked')</script>*/",
        "script-sample": "<img src=x onerror=alert('xss_sample')>\x00",
        "nested": {
          "token": "super-secret-token",
          "innocent": "safe-text",
        },
      },
    },
  ];

  const res = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: { "content-type": "application/reports+json", "origin": BASE },
      body: JSON.stringify(attackPayload),
    }),
  );
  assertEquals(res.status, 204);

  // Verify prototype pollution was rejected
  assertEquals(({} as Record<string, unknown>).polluted, undefined);

  const logs = await stores.metadata.listLogs();
  assertEquals(logs.length, 1);
  const log = logs[0]!;

  // 1. Control characters stripped
  assert(!log.type.includes("\x00"), "control chars stripped from type");
  assert(!log.type.includes("\x1b"), "escape sequences stripped from type");
  assert(!log.message.includes("\x00"), "control chars stripped from message");
  assert(!log.message.includes("\x1b"), "escape sequences stripped from message");

  // 2. Sensitive fields in body are redacted
  const body = log.context?.body as Record<string, unknown>;
  assert(body);
  const nested = body.nested as Record<string, unknown>;
  assert(nested);
  assertEquals(nested.token, "[redacted]");
  assertEquals(nested.innocent, "safe-text");

  // 3. Test that rendering any of these report fields into an HTML template MUST escape tags
  const renderedHtml = `<tr>
    <td>${esc(log.type)}</td>
    <td>${esc(log.message)}</td>
    <td>${esc(String(log.context?.url))}</td>
    <td>${esc(String(log.context?.userAgent))}</td>
    <td><pre>${esc(JSON.stringify(log.context?.body))}</pre></td>
  </tr>`;

  // Assert no raw executable tags exist in the output markup
  assert(!renderedHtml.includes("<script>"), "HTML output must not contain raw <script> tags");
  assert(!renderedHtml.includes("<img src=x"), "HTML output must not contain raw <img tags");
  assertStringIncludes(renderedHtml, "&lt;script&gt;alert('xss_url')&lt;/script&gt;");

  // 4. Test script block embedding helper
  const scriptJson = jsonForScript(log);
  assert(
    !scriptJson.includes("</script>"),
    "JSON embedded in script tags must escape closing tags",
  );
  assert(!scriptJson.includes("<script>"), "JSON embedded in script tags must escape opening tags");
});

Deno.test("CSP reporting endpoint: handles CORS preflight OPTIONS request", async () => {
  const { app } = await setupApp();

  const res = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "OPTIONS",
    }),
  );

  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertStringIncludes(res.headers.get("access-control-allow-methods") ?? "", "POST");
});

Deno.test("CSP reporting endpoint: rejects non-POST and oversized payloads safely", async () => {
  const { app } = await setupApp();

  // GET is not allowed
  const getRes = await app.fetch(new Request(`${BASE}/api/reports/csp`, { method: "GET" }));
  assertEquals(getRes.status, 405);

  // Oversized payload (>64KB)
  const hugePayload = JSON.stringify([{
    type: "csp-violation",
    body: { blockedURL: "A".repeat(70 * 1024) },
  }]);
  const hugeRes = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: hugePayload,
    }),
  );
  assertEquals(hugeRes.status, 413, "payload over 64KB must be rejected with 413");
});

Deno.test("audio-feed-19db: chunked oversized upload rejects with 413 without buffering full stream", async () => {
  const { app } = await setupApp();

  let emittedChunks = 0;
  const chunkBytes = new Uint8Array(8192).fill(32);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emittedChunks >= 128) {
        controller.close();
        return;
      }
      emittedChunks++;
      controller.enqueue(chunkBytes);
    },
  });

  const res = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: stream,
      // @ts-ignore: duplex is required in RequestInit for streaming bodies in fetch
      duplex: "half",
    }),
  );

  assertEquals(res.status, 413, "must reject oversized stream with 413");
  // Stream should stop pulling as soon as limit is exceeded (at ~9 chunks = 73,728 bytes)
  assert(
    emittedChunks <= 16,
    `stream must not buffer full 128 chunks (emitted: ${emittedChunks})`,
  );
});

Deno.test("audio-feed-jbpz: repeated anonymous report batches are rate-limited and capped per window", async () => {
  const { app, stores } = await setupApp();

  // Send repeated batches of reports from the same client IP (a socket
  // address, so the per-client bound applies — audio-feed-0t8el)
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await app.fetch(
      new Request(`${BASE}/api/reports/csp`, {
        method: "POST",
        headers: {
          "content-type": "application/reports+json",
          "x-forwarded-for": "203.0.113.195",
          "origin": BASE,
        },
        body: JSON.stringify(
          Array.from({ length: 10 }, (_, n) => ({
            type: "crash",
            body: { reason: `flood-${i}-${n}` },
          })),
        ),
      }),
      { remoteAddr: { hostname: "203.0.113.195" } },
    );
    statuses.push(res.status);
  }

  // The first batches are admitted; subsequent batches must be rejected with 429
  assert(statuses.includes(429), "repeated batches must hit 429 rate limit");
  const rejectedIndex = statuses.indexOf(429);
  assert(rejectedIndex >= 1, "first batch should be allowed, later limited");

  // Log store must NOT be flooded with all 60 reports
  const logs = await stores.metadata.listLogs();
  assert(
    logs.length <= 25,
    `log store must be protected from unbounded flood (stored: ${logs.length})`,
  );
});

Deno.test("audio-feed-r49r: uncommitted budget CAS write fails closed with 429 and stores NO rows", async () => {
  const { app, stores } = await setupApp();

  const originalAtomicUpdate = stores.metadata.atomicUpdate.bind(stores.metadata);
  // Inject CAS failure on reports:budget:*
  stores.metadata.atomicUpdate = async <T>(
    key: string,
    mutate: (current: T | null) => T | null,
    ttlMs?: number,
  ) => {
    if (key.startsWith("reports:budget:")) {
      // Simulate CAS failure / retry exhaustion: mutation was evaluated but write did not commit
      mutate(null);
      return { value: null, committed: false };
    }
    return await originalAtomicUpdate(key, mutate, ttlMs);
  };

  const payload = Array.from({ length: 5 }, (_, n) => ({
    type: "crash",
    body: { reason: `cas-fail-${n}` },
  }));

  const res = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: { "content-type": "application/reports+json", "origin": BASE },
      body: JSON.stringify(payload),
    }),
  );

  assertEquals(res.status, 429, "uncommitted CAS must fail closed with 429");
  assertEquals(res.headers.get("retry-after"), "60");

  const logs = await stores.metadata.listLogs();
  const reportLogs = logs.filter((l) => l.type.startsWith("report."));
  assertEquals(
    reportLogs.length,
    0,
    "no report logs must be stored when budget write did not commit",
  );
});

Deno.test("audio-feed-u58d: benign client-side NEL reports (abandoned, dns.address_changed, /api/reports/csp status=0) log at info severity", async () => {
  const { app, stores } = await setupApp();

  const reports = [
    {
      type: "network-error",
      url: `${BASE}/`,
      body: { type: "abandoned", phase: "application", status_code: 0 },
    },
    {
      type: "network-error",
      url: `${BASE}/api/reports/csp`,
      body: { type: "dns.address_changed", phase: "dns", status_code: 0 },
    },
    {
      type: "network-error",
      url: `${BASE}/api/reports/csp`,
      body: { type: "dns.name_not_resolved", phase: "dns", status_code: 0 },
    },
  ];

  const res = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: { "content-type": "application/reports+json", "origin": BASE },
      body: JSON.stringify(reports),
    }),
  );
  assertEquals(res.status, 204);

  const logs = (await stores.metadata.listLogs()).filter((l) => l.type === "report.network-error");
  assertEquals(logs.length, 3);
  for (const log of logs) {
    assertEquals(log.severity, "info");
  }
});

Deno.test("SECURITY (audio-feed-cspreports): untrusted/absent Origin reports do not consume visitor write budget, while real same-origin reports record and count", async () => {
  const { app, stores } = await setupApp();
  const victimIp = "203.0.113.88";
  const budgetKey = `reports:budget:${victimIp}`;

  // Helper to read the current write budget counter without mutating it
  const readBudget = async (): Promise<number[] | null> => {
    const res = await stores.metadata.atomicUpdate<number[]>(budgetKey, () => null);
    return res.value;
  };

  assertEquals(await readBudget(), null, "initial victim budget is empty");

  // Row (x.1): Report from untrusted Origin (e.g. cross-origin page attacking visitor)
  const untrustedPayload = [
    {
      type: "csp-violation",
      url: "https://evil.example.com/exploit",
      body: { blockedURL: "https://evil.example.com/evil.js" },
    },
  ];

  const untrustedRes = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: {
        "content-type": "application/reports+json",
        "origin": "https://evil.example.com",
        "x-forwarded-for": victimIp,
      },
      body: JSON.stringify(untrustedPayload),
    }),
    { remoteAddr: { hostname: victimIp } },
  );

  assertEquals(untrustedRes.status, 204, "untrusted origin body is accepted with 204");
  assertEquals(
    await readBudget(),
    null,
    "row (x): untrusted Origin must NOT consume victim budget (counter remains unchanged)",
  );

  // Row (x.2): Report with absent Origin header
  const absentRes = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: {
        "content-type": "application/reports+json",
        "x-forwarded-for": victimIp,
      },
      body: JSON.stringify(untrustedPayload),
    }),
    { remoteAddr: { hostname: victimIp } },
  );

  assertEquals(absentRes.status, 204, "absent origin body is accepted with 204");
  assertEquals(
    await readBudget(),
    null,
    "row (x): absent Origin must NOT consume victim budget (counter remains unchanged)",
  );

  const logsBeforeSameOrigin = await stores.metadata.listLogs();
  assertEquals(
    logsBeforeSameOrigin.filter((r) => r.type === "report.csp-violation").length,
    0,
    "untrusted/absent Origin reports are never stored - no report content record exists",
  );
  // The DROP of each untrusted/absent report is narrated as its own operational record
  // (review delta, coord ruling 2026-10-29): visibility is required, content storage is not.
  assertEquals(
    logsBeforeSameOrigin.filter((r) => r.type === "csp_report.origin_untrusted_dropped").length,
    2,
    "each dropped submission is narrated with its origin reason",
  );

  // Row (y): Real same-origin report
  const sameOriginPayload = [
    {
      type: "csp-violation",
      url: `${BASE}/listen`,
      body: { blockedURL: "https://unapproved.example.com/bad.js" },
    },
  ];

  const sameOriginRes = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: {
        "content-type": "application/reports+json",
        "origin": BASE,
        "x-forwarded-for": victimIp,
      },
      body: JSON.stringify(sameOriginPayload),
    }),
    { remoteAddr: { hostname: victimIp } },
  );

  assertEquals(sameOriginRes.status, 204, "same-origin report flushes with 204");

  const budgetAfterSameOrigin = await readBudget();
  assert(budgetAfterSameOrigin !== null, "row (y): same-origin report consumes budget");
  assertEquals(
    budgetAfterSameOrigin.length,
    1,
    "row (y): exactly 1 report counted in victim write budget",
  );

  const logsAfterSameOrigin = await stores.metadata.listLogs();
  assertEquals(
    logsAfterSameOrigin.filter((r) => r.type === "report.csp-violation").length,
    1,
    "row (y): real same-origin report is recorded in the log store",
  );
  assertEquals(
    logsAfterSameOrigin.find((r) => r.type === "report.csp-violation")!.severity,
    "warn",
  );
});

// Review delta (audio-feed-cspreports, coord ruling 2026-10-29): the untrusted/absent-Origin
// drop must be VISIBLE, narrated through the one logger seam (src/log.ts) rather than a
// console call. The drop record lands in the log store, so these rows assert it there - that
// IS the recording-sink assertion: the record exists, its type is the drop's, and its reason
// carries the origin value or the literal "(absent)" - so a refactor that deletes the log
// reds by name, and the row cannot pass by grepping unrelated output.
Deno.test(
  "SECURITY (audio-feed-cspreports review delta): the origin-policy drop is LOGGED, for absent and untrusted Origin alike",
  async () => {
    const { app, stores } = await setupApp();
    const payload = [
      {
        type: "csp-violation",
        url: `${BASE}/listen`,
        body: { blockedURL: "https://evil.example.com/evil.js" },
      },
    ];

    const dropRecords = async () =>
      (await stores.metadata.listLogs()).filter((r) =>
        r.type === "csp_report.origin_untrusted_dropped"
      );

    // The drop write is deliberately UNAWAITED in the route (void createLogger(...).event(...),
    // so the 204 is never delayed), so the record commits a tick after the response. Poll bounded:
    // settle to `want` records within 2s, else return short and let the assertion red - a deleted
    // narration times out to a short array and fails on the missing log, never passes on absence.
    const settleDrops = async (want: number) => {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const rows = await dropRecords();
        if (rows.length >= want) return rows;
        if (Date.now() >= deadline) return rows;
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    // Row 1: absent Origin header - the reason must carry the literal "(absent)", so an
    // operator can tell header-absence from an untrusted value.
    const absentRes = await app.fetch(
      new Request(`${BASE}/api/reports/csp`, {
        method: "POST",
        headers: { "content-type": "application/reports+json" },
        body: JSON.stringify(payload),
      }),
    );
    assertEquals(
      absentRes.status,
      204,
      "the drop is still accepted with 204 so the browser flushes",
    );
    const absentDrops = await settleDrops(1);
    assertEquals(absentDrops.length, 1, "exactly one drop record for the absent-Origin submission");
    assertEquals(
      absentDrops[0]!.reason,
      "(absent)",
      "a missing Origin header must be logged as the literal (absent)",
    );

    // Row 2: untrusted Origin - the reason must carry the VALUE that was judged untrusted.
    const untrustedRes = await app.fetch(
      new Request(`${BASE}/api/reports/csp`, {
        method: "POST",
        headers: {
          "content-type": "application/reports+json",
          "origin": "https://evil.example.com",
        },
        body: JSON.stringify(payload),
      }),
    );
    assertEquals(
      untrustedRes.status,
      204,
      "the drop is still accepted with 204 so the browser flushes",
    );
    const untrustedDrops = await settleDrops(2);
    assertEquals(untrustedDrops.length, 2, "the second drop appends its own record");
    assertEquals(
      untrustedDrops[1]!.reason,
      "https://evil.example.com",
      "an untrusted VALUE must be logged as the value, not as absent",
    );

    // The policy itself is unchanged by the visibility: no report CONTENT is stored either way.
    const reportRecords = (await stores.metadata.listLogs()).filter((r) =>
      r.type === "report.csp-violation"
    );
    assertEquals(reportRecords.length, 0, "dropped reports are never stored");
  },
);

// The loopback exemption belongs to the ARRIVAL, not to the Origin header.
// `Origin` is text any non-browser can write, so a report that ARRIVES on the
// deployed host while CLAIMING a loopback origin must be dropped like any other
// untrusted origin — while a request that really did arrive on loopback
// (`deno task dev`, this harness) keeps its exemption. The predicate's own rows
// live in tests/origin_test.ts; this row drives the route, so the visitor
// budget the predicate protects is asserted where it is actually spent.
Deno.test("SECURITY: a forged loopback Origin on a deployed arrival spends no visitor budget, while a real loopback arrival still records", async () => {
  const { app, stores } = await setupApp();
  const payload = [
    {
      type: "csp-violation",
      url: `${BASE}/listen`,
      body: { blockedURL: "https://evil.example.com/evil.js" },
    },
  ];
  const readBudget = async (ip: string): Promise<number[] | null> => {
    const res = await stores.metadata.atomicUpdate<number[]>(`reports:budget:${ip}`, () => null);
    return res.value;
  };
  const reportRecords = async () =>
    (await stores.metadata.listLogs()).filter((r) => r.type === "report.csp-violation");
  const dropRecords = async () =>
    (await stores.metadata.listLogs()).filter((r) =>
      r.type === "csp_report.origin_untrusted_dropped"
    );
  const settleDrops = async (want: number) => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const rows = await dropRecords();
      if (rows.length >= want) return rows;
      if (Date.now() >= deadline) return rows;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  // Row (ii): the forged case. The request arrives on the deployed host and the
  // Origin header says localhost — before the fix that header alone earned trust.
  const forgedIp = "203.0.113.41";
  const forgedRes = await app.fetch(
    new Request(`${BASE}/api/reports/csp`, {
      method: "POST",
      headers: {
        "content-type": "application/reports+json",
        "origin": "http://localhost:3000",
        "x-forwarded-for": forgedIp,
      },
      body: JSON.stringify(payload),
    }),
    { remoteAddr: { hostname: forgedIp } },
  );
  assertEquals(forgedRes.status, 204, "the drop is still a 204 so the browser flushes");
  assertEquals(
    await readBudget(forgedIp),
    null,
    "row (ii): a loopback Origin on a deployed arrival must NOT consume visitor write budget",
  );
  assertEquals(
    (await reportRecords()).length,
    0,
    "row (ii): the forged report content is never stored",
  );
  const drops = await settleDrops(1);
  assertEquals(
    drops[0]?.reason,
    "http://localhost:3000",
    "row (ii): the drop names the value that was judged untrusted, so an operator can see it",
  );

  // Row (i): the same claim from a request that genuinely arrived on loopback is
  // trusted, so local development is not broken by the production rule.
  const devIp = "203.0.113.42";
  const devRes = await app.fetch(
    new Request(`http://localhost:8000/api/reports/csp`, {
      method: "POST",
      headers: {
        "content-type": "application/reports+json",
        "origin": "http://localhost:8000",
        "x-forwarded-for": devIp,
      },
      body: JSON.stringify(payload),
    }),
    { remoteAddr: { hostname: devIp } },
  );
  assertEquals(devRes.status, 204, "the dev report flushes with 204");
  assert(
    (await readBudget(devIp)) !== null,
    "row (i): a real loopback arrival still spends the budget, so dev/test behaves as before",
  );
  assertEquals(
    (await reportRecords()).length,
    1,
    "row (i): the loopback-arrival report is recorded in the log store",
  );
  assertEquals((await settleDrops(2)).length, 1, "row (i) produced no second drop record");
});
