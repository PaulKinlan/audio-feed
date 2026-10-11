/**
 * The error log must be readable DURING the incident that is refusing requests (audio-feed-2tbv).
 *
 * The live failure this fixes (audio-feed-du8w): the deployment answered 421 to every request
 * because its allowed-host set was empty, and the operator's question - "how do I read the error
 * logs for the live deployment?" - could not be answered by our own observability API, because the
 * host gate refuses BEFORE any route runs. The tool for reading the incident was refused by the
 * incident. A log reader must not sit behind the switch whose position you are trying to diagnose.
 *
 * These are FUNCTION tests, and they have to be: locally `deno serve` derives `request.url` from the
 * SOCKET, so a `Host` header does not change it (that trap cost this fleet an hour, audio-feed-3k2d).
 * Driving `createApp().fetch` with a Request whose URL carries the attacker's host is the only way
 * to exercise the gate here.
 *
 * Every test below is written to FAIL if the exemption is removed, and the tests that assert the
 * gate still holds are written to fail if the exemption is ever WIDENED to a product route or to a
 * lookalike path.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { HOST_GATE_EXEMPT_PATHS, isHostGateExempt } from "../src/origin.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const DEPLOYED = "https://audio-feed.paulkinlan-ea.deno.net";
const EVIL = "https://evil.example";
const KEY = "observability-key-1";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
const authed = (url: string) =>
  req(url, { authorization: `Bearer ${KEY}`, host: new URL(url).host });

function app(config: AppConfig, stores?: Stores) {
  const s = stores ?? memoryStores();
  const ctx = { config, stores: s };
  const { fetch, router } = createApp(ctx, createHandlers(ctx));
  return { fetch, router, stores: s };
}

// ---------------------------------------------------------------------------
// The incident case: the gate refuses the host, the log reader still answers
// ---------------------------------------------------------------------------

Deno.test("audio-feed-2tbv: the errors API answers on a host the gate refuses", async () => {
  const { fetch } = app({ port: 8000, publicBaseUrl: DEPLOYED, observabilityKey: KEY });

  // The gate is working: a product route on this host is still refused.
  const homepage = await fetch(req(`${EVIL}/`, { host: "evil.example" }));
  assertEquals(homepage.status, 421, "the gate must still refuse an unlisted host");

  // And the log reader answers anyway - authenticated, with real records.
  const feed = await fetch(authed(`${EVIL}/api/observability/errors?since=0`));
  assertEquals(
    feed.status,
    200,
    "the error log must be readable on the host whose refusal is being diagnosed",
  );
  const body = await feed.json();
  assertEquals(
    typeof body.cursor,
    "string",
    "the cursor is the last scanned sequence, as a string",
  );
  assert(Array.isArray(body.events));

  // THE PROPERTY THAT MAKES THE EXEMPTION SAFE: nothing derived from the request in the body...
  const raw = JSON.stringify(body);
  assert(!raw.includes("evil.example"), "no request-derived origin may appear in the feed body");
  // ...and nothing derived from it in ANY header, which is the half that is easy to miss: the CSP
  // report-uri in applySecurityHeaders is built from the request host on the HTML branch only.
  for (const [name, value] of feed.headers) {
    assert(
      !value.includes("evil.example"),
      `header ${name} must not echo the request host: ${value}`,
    );
  }
});

Deno.test("audio-feed-2tbv: the errors API answers when NOTHING is configured, which is the live 421", async () => {
  // audio-feed-du8w's exact shape: empty allowed set, so every host is refused with a 500
  // server_misconfigured. The operator must still be able to read what happened.
  const { fetch } = app({ port: 8000, observabilityKey: KEY });

  const homepage = await fetch(req(`${EVIL}/`, { host: "evil.example" }));
  assertEquals(homepage.status, 500, "nothing configured refuses every host");

  const feed = await fetch(authed(`${EVIL}/api/observability/errors?since=0`));
  assertEquals(feed.status, 200, "the log reader is the one thing that must still work");
  const summary = await fetch(authed(`${EVIL}/api/observability/summary`));
  assertEquals(summary.status, 200, "and its summary, which is how a poller knows it is current");
});

Deno.test("audio-feed-2tbv: the refusal itself says where errors can be read", async () => {
  // An operator reading the refusal must not have to already know the answer. The hint is a PATH,
  // never an origin, so it leaks nothing about the deployment's own host.
  const { fetch } = app({ port: 8000, publicBaseUrl: DEPLOYED, observabilityKey: KEY });
  const misdirected = await (await fetch(req(`${EVIL}/`, { host: "evil.example" }))).text();
  assertStringIncludes(misdirected, "/api/observability/errors");
  assertStringIncludes(misdirected, "not behind this check");
  assert(!misdirected.includes("evil.example"), "the refusal must not echo the client's host");

  const unconfigured = await (app({ port: 8000, observabilityKey: KEY })).fetch(
    req(`${EVIL}/`, { host: "evil.example" }),
  ).then((r) => r.text());
  assertStringIncludes(unconfigured, "/api/observability/errors");
  assertStringIncludes(unconfigured, "PUBLIC_BASE_URL");
});

// ---------------------------------------------------------------------------
// What the exemption must NOT do
// ---------------------------------------------------------------------------

Deno.test("audio-feed-2tbv: the exemption is key-gated, and an unset key explains itself", async () => {
  // Exemption from the HOST check is not exemption from authentication: the shared key stays the
  // only requirement, and it is still required.
  const configured = app({ port: 8000, publicBaseUrl: DEPLOYED, observabilityKey: KEY });
  const anonymous = await configured.fetch(req(`${EVIL}/api/observability/errors`, {
    host: "evil.example",
  }));
  assertEquals(anonymous.status, 401, "an exempt path without the key is still refused");
  const wrong = await configured.fetch(req(`${EVIL}/api/observability/errors`, {
    host: "evil.example",
    authorization: "Bearer not-the-key",
  }));
  assertEquals(wrong.status, 401);

  // Unset key: fail closed with a message that names the variable, on the refused host as well, so
  // the operator learns what to set instead of seeing a generic failure or a misleading 421.
  const unset = app({ port: 8000, publicBaseUrl: DEPLOYED });
  const response = await unset.fetch(authed(`${EVIL}/api/observability/errors`));
  assertEquals(response.status, 503);
  const body = await response.text();
  assertStringIncludes(body, "observability_not_configured");
  assertStringIncludes(body, "AUDIOFEED_OBSERVABILITY_KEY");
});

Deno.test("audio-feed-2tbv: product routes stay behind the gate, including the admin observability page", async () => {
  const { fetch } = app({ port: 8000, publicBaseUrl: DEPLOYED, observabilityKey: KEY });
  for (
    const path of [
      "/",
      "/listen",
      "/admin",
      "/admin/observability",
      "/api/health",
      "/feed/user-1/token",
    ]
  ) {
    const res = await fetch(req(`${EVIL}${path}`, { host: "evil.example" }));
    assertEquals(res.status, 421, `${path} must stay behind the host gate`);
  }
});

Deno.test("audio-feed-2tbv: only the exact paths are exempt, not lookalikes or sub-paths", async () => {
  const { fetch } = app({ port: 8000, publicBaseUrl: DEPLOYED, observabilityKey: KEY });
  for (
    const path of [
      "/api/observability/errors/extra",
      "/api/observability/summary/x",
      "/api/observability/error",
      "/api/observability",
      "/api/observability/errors%2fadmin",
      "/api/observability/errors%2e%2e%2fadmin",
      "//api/observability/errors",
      "/API/observability/errors",
    ]
  ) {
    const res = await fetch(authed(`${EVIL}${path}`));
    assertEquals(
      res.status,
      421,
      `${path} looks like the exempt path but is not it, so the gate still applies`,
    );
  }
  // A query string is part of the same route, so it IS exempt - the exemption is on the path.
  const withQuery = await fetch(authed(`${EVIL}/api/observability/errors?since=0&limit=1`));
  assertEquals(withQuery.status, 200);
  // And a dot segment that NORMALISES to the exempt path resolves to it, by the same URL rules the
  // router dispatches with - both sides read `new URL(req.url).pathname`, so they cannot disagree.
  const normalised = await fetch(authed(`${EVIL}/api/observability/errors/../errors`));
  assertEquals(normalised.status, 200);
});

Deno.test("audio-feed-2tbv: every exempt path is a route the router actually declares", () => {
  // The exemption is a set of strings; a renamed route would silently lose it (or worse, name a path
  // that no longer exists and shield a 404 from the gate). This ties the list to the router.
  const { router } = app({ port: 8000, publicBaseUrl: DEPLOYED, observabilityKey: KEY });
  const declared = new Set(
    router.list().filter((route) => route.method === "GET").map((route) => route.pathname),
  );
  for (const path of HOST_GATE_EXEMPT_PATHS) {
    assert(declared.has(path), `${path} is exempt but is not a declared GET route`);
  }
  // GET only, and the list is what the gate actually consults.
  assertEquals(HOST_GATE_EXEMPT_PATHS.length, 2);
  assertEquals(isHostGateExempt("/api/observability/errors"), true);
  assertEquals(isHostGateExempt("/api/observability/errors/"), false);
});
