/**
 * The CSP report URL is derived from CONFIGURATION, never from the request (audio-feed-s2esl).
 *
 * The exposure this pins: `applySecurityHeaders` built `report-uri` / `Reporting-Endpoints` /
 * `Report-To` from `req.headers.get("host")` whenever `PUBLIC_BASE_URL` was unset. The host gate in
 * `src/app.ts` inspects `new URL(req.url)`, NOT the `Host` header — and locally `deno serve` derives
 * `request.url` from the SOCKET, so the two are different inputs. A request whose URL is an allowed
 * host but whose `Host` header says `evil.example` therefore passed the gate and had `evil.example`
 * written into three security-reporting response headers. Safety depended on an ORDERING (gate first,
 * derivation second) that only helped while both read the same input.
 *
 * These are FUNCTION tests driven through `createApp().fetch`: `deno serve` makes the request URL from
 * the socket, so only a hand-built `Request` can express "allowed URL, spoofed Host header", which is
 * the whole point.
 *
 * Every assertion below fails if the request host is allowed back into the derivation.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { cspReportOrigin } from "../src/origin.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const DEPLOYED = "https://audio.example.com";
const EVIL = "evil.example";

function app(config: AppConfig, stores?: Stores) {
  const s = stores ?? memoryStores();
  const ctx = { config, stores: s };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores: s };
}

/** No response header may carry the client's chosen host. */
function assertNoHeaderEchoes(res: Response, host: string) {
  for (const [name, value] of res.headers) {
    assert(
      !value.includes(host),
      `header ${name} must not echo the client's host (${host}): ${value}`,
    );
  }
}

/** The three reporting headers must all name the same, configured origin. */
function assertReportsTo(res: Response, origin: string) {
  const expected = `${origin}/api/reports/csp`;

  const csp = res.headers.get("content-security-policy");
  assert(csp, "an HTML response must carry Content-Security-Policy");
  assertStringIncludes(csp, `report-uri ${expected}`);
  assertStringIncludes(csp, "report-to csp-endpoint");

  assertEquals(
    res.headers.get("reporting-endpoints"),
    `csp-endpoint="${expected}"`,
    "Reporting-Endpoints must name the configured report origin",
  );

  const reportTo = res.headers.get("report-to");
  assert(reportTo, "an HTML response must carry Report-To for legacy/NEL reporting");
  assertStringIncludes(reportTo, `{"url":"${expected}"}`);
}

// ---------------------------------------------------------------------------
// The exposure: allowed URL, spoofed Host header
// ---------------------------------------------------------------------------

Deno.test("audio-feed-s2esl: a spoofed Host header is never written into the CSP report headers", async () => {
  const { fetch } = app({ port: 8000, allowedHosts: ["audio.example.com"], adminToken: "x" });

  // The gate passes (it checks the request URL host) and the Host header is the attacker's.
  const res = await fetch(
    new Request(`${DEPLOYED}/`, { headers: { host: EVIL } }),
  );
  assertEquals(res.status, 200, "an allowed request URL host still serves the page");

  assertNoHeaderEchoes(res, EVIL);
  assertReportsTo(res, DEPLOYED);
});

Deno.test("audio-feed-s2esl: the honest request reports to the same configured origin", async () => {
  const { fetch } = app({ port: 8000, allowedHosts: ["audio.example.com"], adminToken: "x" });

  // Same deployment, correct Host: the report origin must not depend on which of the two arrived.
  const res = await fetch(
    new Request(`${DEPLOYED}/`, { headers: { host: "audio.example.com" } }),
  );
  assertEquals(res.status, 200);
  assertReportsTo(res, DEPLOYED);
});

// ---------------------------------------------------------------------------
// Nothing configured: a safe loopback default, still not the client's host
// ---------------------------------------------------------------------------

Deno.test("audio-feed-s2esl: with nothing configured a spoofed Host falls back to loopback", async () => {
  const { fetch } = app({ port: 8000, adminToken: "x" });

  // Nothing configured still serves exact loopback (the host gate's own exemption), which is the
  // local-dev path. The Host header is the client's, and must not be used for anything.
  const res = await fetch(
    new Request("http://localhost:8000/", { headers: { host: EVIL } }),
  );
  assertEquals(res.status, 200, "loopback is exempt from the host gate");

  assertNoHeaderEchoes(res, EVIL);
  assertReportsTo(res, "http://localhost:8000");
});

// ---------------------------------------------------------------------------
// A refused host must still get no reporting headers at all
// ---------------------------------------------------------------------------

Deno.test("audio-feed-s2esl: a refused host gets no request-derived reporting headers", async () => {
  const { fetch } = app({ port: 8000, allowedHosts: ["audio.example.com"], adminToken: "x" });

  const res = await fetch(new Request(`https://${EVIL}/`, { headers: { host: EVIL } }));
  assertEquals(res.status, 421, "an unlisted host is still refused before any route runs");
  assertEquals(res.headers.get("reporting-endpoints"), null);
  assertEquals(res.headers.get("report-to"), null);
  assertNoHeaderEchoes(res, EVIL);
});

// ---------------------------------------------------------------------------
// The unit: configuration in, origin out — the request host cannot reach it
// ---------------------------------------------------------------------------

Deno.test("audio-feed-s2esl: cspReportOrigin derives from configuration only", () => {
  // Configured canonical origin wins.
  assertEquals(
    cspReportOrigin({ publicBaseUrl: "https://audio.example.com/" }, {
      url: "https://evil.example/some/page",
      https: true,
    }),
    "https://audio.example.com",
  );

  // No canonical origin: the configured allow-list is the trusted source, and the port a
  // configured host states is kept (a bare host takes the request's scheme).
  assertEquals(
    cspReportOrigin({ allowedHosts: ["audio.example.com"] }, {
      url: "https://evil.example/",
      https: true,
    }),
    "https://audio.example.com",
  );
  assertEquals(
    cspReportOrigin({ allowedHosts: ["http://localhost:8000"] }, {
      url: "https://evil.example/",
      https: true,
    }),
    "http://localhost:8000",
  );

  // Nothing configured and a non-loopback request: the obviously-wrong loopback default, never the
  // client's host.
  assertEquals(
    cspReportOrigin({}, { url: "https://evil.example/", https: true }),
    "https://localhost",
  );

  // Nothing configured, exact loopback: local dev keeps a usable report target.
  assertEquals(
    cspReportOrigin({}, { url: "http://localhost:8000/", https: false }),
    "http://localhost:8000",
  );
});
