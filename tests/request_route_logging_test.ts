/**
 * What a request record names (audio-feed-wzv9, audio-feed-pwu4).
 *
 * The store must never hold user-controlled strings, and a request path is the one place this app
 * carries capabilities with no field name attached. Two attempts at sanitising the path leaked, so
 * the path is not sanitised any more: the record names the PATTERN the URL matches, a constant from
 * the route table, or a fixed marker when nothing matches.
 *
 * Each case states the pattern it EXPECTS, not merely "something safe": a lookup that quietly
 * returned the marker for every request would pass a "no token" assertion while making the field
 * useless, which is exactly what happened to the first version of this fix.
 */

import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores, type Stores } from "../src/config.ts";
import { UNMATCHED_ROUTE } from "../src/request_route.ts";
import { isHighVolumeRoute } from "../src/log.ts";

const BASE = "https://audio.example";
const TOKEN = "kR7fQ2mZ8pLx4Vn1Tb6Ys3Wd";

function app(): {
  fetch: (r: Request) => Promise<Response>;
  routeFor: (url: URL) => string;
  stores: Stores;
} {
  const config = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores = memoryStores();
  const ctx = { config, stores };
  const created = createApp(ctx, createHandlers(ctx));
  return {
    fetch: created.fetch,
    routeFor: (url) => created.router.routePatternFor(url),
    stores,
  };
}

Deno.test("a request record names a registered pattern or a marker, never a path (audio-feed-pwu4)", async () => {
  const { fetch, routeFor, stores } = app();

  const cases: [path: string, expected: string][] = [
    // Canonical shapes name their own pattern, which is more useful than a path anyway.
    [`/feed/${TOKEN}/master.xml`, "/feed/:token/master.xml"],
    [`/listen/${TOKEN}`, "/listen/:token"],
    [`/audio/${TOKEN}/x/y`, "/audio/:key+"],
    ["/account", "/account"],
    ["/", "/"],
    // The finding's own case: an extra segment matches no pattern, so it records the marker rather
    // than the tail of the path that the first version copied through.
    [`/feed/${TOKEN}/master.xml/${TOKEN}`, UNMATCHED_ROUTE],
    [`/listen/${TOKEN}/extra`, UNMATCHED_ROUTE],
    // A SHORT token behind a mixed-case prefix — the shape that defeated the fail-closed sanitiser,
    // because an uppercase prefix dodged the prefix rule and `abc` then looked like a route word.
    ["/AUDIO/abc", UNMATCHED_ROUTE],
    ["/Listen/abc/master.xml", UNMATCHED_ROUTE],
    [`/${TOKEN}/anything`, UNMATCHED_ROUTE],
    // Encoded separators: the pattern matches the raw pathname, so these match nothing and the
    // record says so.
    [`/feed/${TOKEN}%2Fmore`, UNMATCHED_ROUTE],
    [`/feed/${TOKEN}%252Fmore`, UNMATCHED_ROUTE],
    // A query string is not part of a pathname, so the route is still the plain pattern.
    [`/feed/${TOKEN}/master.xml?token=${TOKEN}`, "/feed/:token/master.xml"],
    [`/account?token=${TOKEN}`, "/account"],
  ];

  for (const [path, expected] of cases) {
    const url = new URL(`${BASE}${path}`);
    const req = new Request(url);
    await fetch(req);
    const route = routeFor(url);
    assertEquals(route, expected, `route for ${path}`);
    // The properties, asserted directly rather than inferred from the expectation above.
    assert(!route.includes(TOKEN), `${path} must not put the token in the route`);
    assert(!route.includes("abc"), `${path} must not put path content in the route`);
    assert(
      route === UNMATCHED_ROUTE || route.startsWith("/"),
      `${path}: a route is a registered pattern or the marker`,
    );
  }

  // The assertion the finding asked for: the FULL serialised store, built the way src/server.ts
  // builds it, including the message, which is where the leaked token also appeared.
  for (const [path, expected] of cases) {
    const url = new URL(`${BASE}${path}`);
    const res = await fetch(new Request(url));
    await stores.metadata.appendLog({
      time: new Date().toISOString(),
      severity: "warn",
      type: "http.request",
      message: `GET ${routeFor(url)} -> ${res.status}`,
      process: "app",
      correlationId: "corr-1",
      route: routeFor(url),
      context: { method: "GET", status: res.status },
    });
    void expected;
  }
  const serialised = JSON.stringify(await stores.metadata.listLogs());
  assert(!serialised.includes(TOKEN), "no stored record may contain the capability");
  assert(!serialised.includes(encodeURIComponent(TOKEN)), "nor its encoded form");
});

Deno.test("an unmatched request names the marker rather than its path (audio-feed-pwu4)", async () => {
  const { fetch, routeFor } = app();
  const url = new URL(`${BASE}/no/such/route/at/all`);
  const res = await fetch(new Request(url));
  assertEquals(res.status, 404);
  assertEquals(routeFor(url), UNMATCHED_ROUTE);
});

Deno.test("high-volume routes are named by pattern, so the list stays a constant (audio-feed-wzv9)", () => {
  // The enclosure and asset routes are excluded from success records by pattern. A pattern that is
  // NOT listed is recorded, so this list's failure mode is extra noise rather than lost diagnostics.
  assertEquals(isHighVolumeRoute("/audio/:key+"), true);
  assertEquals(isHighVolumeRoute("/assets/:name"), true);
  assertEquals(isHighVolumeRoute("/icon.svg"), true);
  assertEquals(isHighVolumeRoute("/account"), false);
  assertEquals(isHighVolumeRoute(UNMATCHED_ROUTE), false);
  assertEquals(isHighVolumeRoute("/something/added/later"), false);
});
