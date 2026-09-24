/**
 * Public origin resolution (audio-feed-0k3).
 *
 * The bug these exist to prevent shipped to production: `PUBLIC_BASE_URL` was
 * unset on Deno Deploy, the config guessed `http://localhost:<port>`, and the
 * live site told visitors to subscribe to `http://localhost:8000/feed/...`.
 * Feed `selfUrl` and enclosure `audioUrl` came from the same value, so a
 * generated feed advertised audio no podcast client could fetch.
 *
 * NO EXISTING TEST COULD HAVE CAUGHT IT: every test and the smoke harness
 * passes an explicit `publicBaseUrl`, so the fallback branch was never
 * exercised. The important cases below are therefore the ones where NOTHING is
 * configured — that is the deployment that matters.
 *
 * The second half is about not replacing a wrong URL with a dangerous one. The
 * resolved origin is printed into a page that tells people where to send a feed
 * token, and a feed token is a bearer credential.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import {
  isUnusableOrigin,
  originCacheControl,
  requestOrigin,
  resolveOrigin,
} from "../src/origin.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const DEPLOYED = "https://audio-feed.paulkinlan-ea.deno.net";
const TOKEN = "feed-token-1";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

// ---------------------------------------------------------------------------
// resolveOrigin
// ---------------------------------------------------------------------------

Deno.test("an explicitly configured origin always wins", () => {
  const resolved = resolveOrigin(
    { publicBaseUrl: "https://canonical.example" },
    req("https://somewhere-else.test/"),
  );

  assertEquals(resolved.baseUrl, "https://canonical.example");
  assertEquals(resolved.explicit, true, "configuration is not a guess");
});

Deno.test("a configured origin keeps its trailing slash off", () => {
  const resolved = resolveOrigin({ publicBaseUrl: "https://x.test///" }, req("https://y.test/"));
  assertEquals(resolved.baseUrl, "https://x.test", "concatenation must not produce //feed");
});

Deno.test("THE PRODUCTION BUG: with nothing configured, the request supplies the origin", () => {
  // This is the exact deployment shape that shipped: no PUBLIC_BASE_URL at all.
  const resolved = resolveOrigin({}, req(`${DEPLOYED}/`));

  assertEquals(resolved.baseUrl, DEPLOYED);
  assertEquals(resolved.explicit, false, "a derived origin must be marked derived");
  assert(!resolved.baseUrl.includes("localhost"), "localhost must never be advertised publicly");
});

Deno.test("a configured localhost origin is treated as unconfigured", () => {
  // Someone setting PUBLIC_BASE_URL=http://localhost:8000 on a public
  // deployment has the same problem as setting nothing. Honouring it literally
  // would reintroduce the bug by hand.
  for (
    const loopback of [
      "http://localhost:8000",
      "http://127.0.0.1:8000",
      "http://0.0.0.0:8000",
      "http://[::1]:8000",
    ]
  ) {
    const resolved = resolveOrigin({ publicBaseUrl: loopback }, req(`${DEPLOYED}/`));
    assertEquals(resolved.baseUrl, DEPLOYED, `${loopback} must not be advertised publicly`);
    assertEquals(resolved.explicit, false);
  }
});

Deno.test("locally, deriving returns the loopback origin anyway", () => {
  // The loopback rule must not break local development: the request origin IS
  // loopback there, so the derived answer is the one you want.
  const resolved = resolveOrigin({}, req("http://localhost:8000/"));
  assertEquals(resolved.baseUrl, "http://localhost:8000");
});

Deno.test("a malformed configured origin is not trusted", () => {
  for (const junk of ["not-a-url", "ftp://x.test", "", "   "]) {
    const resolved = resolveOrigin({ publicBaseUrl: junk }, req(`${DEPLOYED}/`));
    assertEquals(resolved.baseUrl, DEPLOYED, `${JSON.stringify(junk)} must not be used`);
  }
});

// ---------------------------------------------------------------------------
// x-forwarded-*: the part that must NOT be trusted by default
// ---------------------------------------------------------------------------

Deno.test("x-forwarded-host is IGNORED unless a proxy is explicitly trusted", () => {
  // Measured against a real Deno.serve handler: `x-forwarded-host: evil.example`
  // arrives verbatim, because these are hop-by-hop headers any client can set.
  // Trusting them by default lets the request body choose the origin the server
  // advertises — and that origin is printed next to a credential field.
  const resolved = resolveOrigin(
    {},
    req(`${DEPLOYED}/`, {
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    }),
  );

  assertEquals(resolved.baseUrl, DEPLOYED, "a client-supplied host must not become the origin");
});

Deno.test("x-forwarded-host is honoured only behind an explicit opt-in", () => {
  // Real proxy deployments need this. It is a deliberate statement that
  // something upstream overwrites client-supplied values.
  const resolved = resolveOrigin(
    { trustProxyHeaders: true },
    req("http://internal:8000/", {
      "x-forwarded-host": "audio.example.com",
      "x-forwarded-proto": "https",
    }),
  );

  assertEquals(resolved.baseUrl, "https://audio.example.com");
  assertEquals(resolved.explicit, false, "a forwarded origin is still derived, not configured");
});

Deno.test("a forwarded header list takes the first hop, and defaults to https", () => {
  const chained = resolveOrigin(
    { trustProxyHeaders: true },
    req("http://internal:8000/", {
      "x-forwarded-host": "audio.example.com, inner.internal",
      "x-forwarded-proto": "https, http",
    }),
  );
  assertEquals(chained.baseUrl, "https://audio.example.com");

  // A host with no proto must not silently become http on a public deployment.
  const noProto = resolveOrigin(
    { trustProxyHeaders: true },
    req("http://internal:8000/", { "x-forwarded-host": "audio.example.com" }),
  );
  assertEquals(noProto.baseUrl, "https://audio.example.com");
});

Deno.test("a malformed forwarded header falls back rather than emitting nonsense", () => {
  const resolved = resolveOrigin(
    { trustProxyHeaders: true },
    req(`${DEPLOYED}/`, { "x-forwarded-host": "not a host at all" }),
  );
  assertEquals(resolved.baseUrl, DEPLOYED, "a broken header must not produce a broken URL");
});

// ---------------------------------------------------------------------------
// Cache safety
// ---------------------------------------------------------------------------

Deno.test("a derived origin makes the response private, a configured one public", () => {
  // The difference between "this page is wrong" and "this page is wrong for
  // everyone who asks after the attacker".
  assertEquals(
    originCacheControl({ baseUrl: "https://x.test", explicit: true }, 300),
    "public, max-age=300",
  );
  assertEquals(
    originCacheControl({ baseUrl: "https://x.test", explicit: false }, 300),
    "private, max-age=300",
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

Deno.test("isUnusableOrigin recognises what must not be advertised", () => {
  for (
    const bad of [
      undefined,
      "",
      "localhost",
      "http://localhost",
      "http://localhost:8000",
      "http://127.0.0.1",
      "http://[::1]:8000",
      "http://0.0.0.0:8000",
      "http://app.localhost",
      "ftp://x.test",
      "nonsense",
    ]
  ) {
    assertEquals(isUnusableOrigin(bad), true, `${JSON.stringify(bad)} should be unusable`);
  }

  for (const good of ["https://x.test", "http://x.test:8080", DEPLOYED]) {
    assertEquals(isUnusableOrigin(good), false, `${good} should be usable`);
  }
});

Deno.test("requestOrigin drops the path, query and fragment", () => {
  assertEquals(
    requestOrigin(req(`${DEPLOYED}/feed/tok/master.xml?x=1`)),
    DEPLOYED,
    "only the origin, never the rest of the URL",
  );
});

// ---------------------------------------------------------------------------
// End to end: the deployed shape, with nothing configured
// ---------------------------------------------------------------------------

/** An app configured EXACTLY as the broken deployment was: no origin at all. */
async function unconfiguredApp(overrides: Partial<AppConfig> = {}) {
  const config: AppConfig = { port: 8000, ...overrides };
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", feedToken: TOKEN, status: "approved" }),
  );
  await stores.metadata.putSource(makeSource({ id: "stratechery", userId: "user-1" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "stratechery",
      status: "ready",
      audioKey: "episode-1.mp3",
      byteLength: 10,
      contentType: "audio/mpeg",
      createdAt: "2026-09-01T00:00:00.000Z",
      readyAt: "2026-09-01T00:05:00.000Z",
    }),
  );
  await stores.blobs.put("episode-1.mp3", new Uint8Array(10), { contentType: "audio/mpeg" });
  const { fetch } = createApp({ config, stores }, createHandlers({ config, stores }));
  return fetch;
}

Deno.test("PRODUCTION REGRESSION: the homepage advertises the host it was asked on", async () => {
  const fetch = await unconfiguredApp();
  const res = await fetch(req(`${DEPLOYED}/`));
  const html = await res.text();

  assertStringIncludes(html, `${DEPLOYED}/feed/`);
  assert(
    !html.includes("localhost"),
    "the deployed homepage must not tell anyone to subscribe to localhost",
  );
});

Deno.test("PRODUCTION REGRESSION: feed self-links and enclosures use the real host", async () => {
  const fetch = await unconfiguredApp();

  const xml = await (await fetch(req(`${DEPLOYED}/feed/${TOKEN}/master.xml`))).text();

  const self = xml.match(/<atom:link href="([^"]+)" rel="self"/)?.[1];
  assertEquals(self, `${DEPLOYED}/feed/${TOKEN}/master.xml`);

  const enclosure = xml.match(/<enclosure url="([^"]+)"/)?.[1];
  assert(enclosure, "the feed must advertise an enclosure");
  assertStringIncludes(enclosure, DEPLOYED);
  assert(
    !enclosure.includes("localhost"),
    "an enclosure pointing at localhost is audio no client can fetch",
  );

  // And the advertised URL must actually resolve, as a podcast client would try.
  assertEquals((await fetch(req(self!))).status, 200);
});

Deno.test("PRODUCTION REGRESSION: the per-source feed too", async () => {
  const fetch = await unconfiguredApp();
  const xml = await (await fetch(req(`${DEPLOYED}/feed/${TOKEN}/stratechery/direct.xml`))).text();

  assertEquals(
    xml.match(/<atom:link href="([^"]+)" rel="self"/)?.[1],
    `${DEPLOYED}/feed/${TOKEN}/stratechery/direct.xml`,
  );
  assert(!xml.includes("localhost"), "no localhost anywhere in a served feed");
});

Deno.test("the homepage is not publicly cacheable when the origin was derived", async () => {
  // A document whose content depends on the request host must not sit in a
  // shared cache: one spoofed request would poison every later visitor.
  const derived = await (await unconfiguredApp())(req(`${DEPLOYED}/`));
  await derived.body?.cancel();
  assertStringIncludes(derived.headers.get("cache-control") ?? "", "private");
  assertEquals(derived.headers.get("vary"), "Host");

  // With an explicit origin the content is host-independent, so it may be shared.
  const configured = await (await unconfiguredApp({ publicBaseUrl: DEPLOYED }))(
    req(`${DEPLOYED}/`),
  );
  await configured.body?.cancel();
  assertStringIncludes(configured.headers.get("cache-control") ?? "", "public");
});

Deno.test("a spoofed host cannot redirect a subscriber to an attacker's origin", async () => {
  // The whole reason x-forwarded-* is opt-in. Without this, an attacker sets a
  // header, a shared cache stores the response, and every later visitor is told
  // to send their feed token to evil.example.
  const fetch = await unconfiguredApp();
  const html = await (await fetch(
    req(`${DEPLOYED}/`, { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }),
  )).text();

  assert(!html.includes("evil.example"), "a client-supplied host must never reach the page");
  assertStringIncludes(html, `${DEPLOYED}/feed/`);
});

Deno.test("a spoofed host cannot poison a feed's enclosure URLs either", async () => {
  const fetch = await unconfiguredApp();
  const xml = await (await fetch(
    req(`${DEPLOYED}/feed/${TOKEN}/master.xml`, { "x-forwarded-host": "evil.example" }),
  )).text();

  assert(!xml.includes("evil.example"), "enclosures must not point at a client-supplied host");
  assertStringIncludes(xml, DEPLOYED);
});
