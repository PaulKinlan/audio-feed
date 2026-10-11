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
  requestHostAllowed,
  requestOrigin,
  resolveOrigin,
} from "../src/origin.ts";
import { relyingParty } from "../src/auth/passkeys.ts";
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

Deno.test("PRODUCTION REGRESSION: the homepage advertises the host the deployment was configured with", async () => {
  // audio-feed-7lsy: the deployment's own host now configures the gate, so this test configures the
  // deployment the way production does - PUBLIC_BASE_URL - instead of relying on the gate being off.
  // The assertion is unchanged: a visitor is never told to subscribe to localhost.
  const fetch = await unconfiguredApp({ publicBaseUrl: DEPLOYED });
  const res = await fetch(req(`${DEPLOYED}/`));
  const html = await res.text();

  assertEquals(res.status, 200);
  assertStringIncludes(html, `${DEPLOYED}/feed/`);
  assert(
    !html.includes("localhost"),
    "the deployed homepage must not tell anyone to subscribe to localhost",
  );
});

Deno.test("PRODUCTION REGRESSION: a deployment that has not been told its own host refuses a public one", async () => {
  // THE FAILURE MODE THIS BEAD EXISTS TO KILL: the gate used to switch on only when ALLOWED_HOSTS was
  // set, so an app that knew its host nowhere still accepted ANY Host header - correct code, inert,
  // no error. It now fails CLOSED, because a deployment that cannot name its own host must not
  // advertise the one a client sent.
  const fetch = await unconfiguredApp();
  const refused = await fetch(req(`${DEPLOYED}/`));
  await refused.body?.cancel();
  assertEquals(refused.status, 421, "nothing configured means nothing is trusted");

  // Loopback needs no configuration, so local development is untouched.
  const local = await fetch(req("http://localhost:8000/"));
  await local.body?.cancel();
  assertEquals(local.status, 200, "local development must not require configuration");
});

Deno.test("PRODUCTION REGRESSION: feed self-links and enclosures use the real host", async () => {
  const fetch = await unconfiguredApp({ publicBaseUrl: DEPLOYED });

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
  const fetch = await unconfiguredApp({ publicBaseUrl: DEPLOYED });
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
  //
  // audio-feed-7lsy: the derived path is now reached by listing extra hosts WITHOUT pinning the
  // origin - the override case. With a pinned PUBLIC_BASE_URL the origin is explicit and this
  // branch is not taken at all.
  const derived = await (await unconfiguredApp({
    allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"],
  }))(req(`${DEPLOYED}/`));
  await derived.body?.cancel();
  assertEquals(derived.status, 200);
  assertStringIncludes(derived.headers.get("cache-control") ?? "", "private");
  // Host because the origin is derived; Cookie because the header names the
  // signed-in viewer (audio-feed-8fc).
  assertEquals(derived.headers.get("vary"), "Host, Cookie");

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
  const fetch = await unconfiguredApp({ publicBaseUrl: DEPLOYED });
  const html = await (await fetch(
    req(`${DEPLOYED}/`, { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }),
  )).text();

  assert(!html.includes("evil.example"), "a client-supplied host must never reach the page");
  assertStringIncludes(html, `${DEPLOYED}/feed/`);
});

Deno.test("a spoofed host cannot poison a feed's enclosure URLs either", async () => {
  const fetch = await unconfiguredApp({ publicBaseUrl: DEPLOYED });
  const xml = await (await fetch(
    req(`${DEPLOYED}/feed/${TOKEN}/master.xml`, { "x-forwarded-host": "evil.example" }),
  )).text();

  assert(!xml.includes("evil.example"), "enclosures must not point at a client-supplied host");
  assertStringIncludes(xml, DEPLOYED);
});

// ---------------------------------------------------------------------------
// audio-feed-fp4r: ALLOWED_HOSTS — forged Host must never become the
// advertised origin, and with it the WebAuthn RP ID, which derives from the
// advertised origin's hostname.
// ---------------------------------------------------------------------------

Deno.test("fp4r: with an allow-list, a forged Host is pinned out of the advertised origin", () => {
  // The audit's attack: raw socket, `Host: evil.example`, and request.url —
  // and therefore every advertised URL and the passkey scope — becomes the
  // attacker's host.
  const config = { allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"] };
  const resolved = resolveOrigin(config, req("https://evil.example/"));

  assertEquals(resolved.baseUrl, "https://audio-feed.paulkinlan-ea.deno.net");
  assertEquals(resolved.explicit, true, "a pinned origin no longer varies per request");
});

Deno.test("fp4r: the WebAuthn RP ID stays pinned under a forged Host", () => {
  const config = { allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"] };
  const rp = relyingParty(resolveOrigin(config, req("https://evil.example/")).baseUrl);

  assertEquals(rp.rpID, "audio-feed.paulkinlan-ea.deno.net");
});

Deno.test("fp4r: a listed host is still derived per request", () => {
  const config = { allowedHosts: ["audio-feed.paulkinlan-ea.deno.net", "staging.example"] };
  const resolved = resolveOrigin(config, req("https://staging.example/"));

  assertEquals(resolved.baseUrl, "https://staging.example");
  assertEquals(resolved.explicit, false, "allowed hosts may still vary per request");
});

Deno.test("fp4r: host comparison is case-insensitive and ignores the port", () => {
  const config = { allowedHosts: ["Audio-Feed.PaulKinlan-EA.Deno.NET"] };
  assertEquals(
    requestHostAllowed(config, req("https://AUDIO-FEED.PAULKINLAN-EA.DENO.NET:443/")),
    true,
  );
});

Deno.test("fp4r: allow-list entries tolerate origins, ports and trailing dots", () => {
  const config = { allowedHosts: ["https://audio-feed.paulkinlan-ea.deno.net/"] };
  assertEquals(
    requestHostAllowed(config, req("https://audio-feed.paulkinlan-ea.deno.net./")),
    true,
  );
});

Deno.test("fp4r: exact loopback is always allowed so local dev survives setting the list", () => {
  const config = { allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"] };
  assertEquals(requestHostAllowed(config, req("http://localhost:8000/")), true);
  assertEquals(requestHostAllowed(config, req("http://127.0.0.1:8000/")), true);
  assertEquals(requestHostAllowed(config, req("http://[::1]:8000/")), true);
});

Deno.test("fp4r: a *.localhost name is NOT loopback — Host: evil.localhost is refused", () => {
  // The review catch: a suffix arm on the loopback exemption let an
  // attacker-chosen host ending in .localhost straight past the gate.
  const config = { allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"] };
  assertEquals(requestHostAllowed(config, req("http://evil.localhost/")), false);
  const resolved = resolveOrigin(config, req("http://evil.localhost/"));
  assert(!resolved.baseUrl.includes("evil.localhost"));
});

Deno.test("fp4r: a client-supplied forwarded loopback never earns the exemption", () => {
  const config = {
    trustProxyHeaders: true,
    allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"],
  };
  assertEquals(
    requestHostAllowed(config, req("https://evil.example/", { "x-forwarded-host": "localhost" })),
    false,
  );
  assertEquals(
    requestHostAllowed(config, req(`${DEPLOYED}/`, { "x-forwarded-host": "app.localhost" })),
    false,
  );
});

Deno.test("fp4r: IPv6 hosts can be listed and match", () => {
  const config = { allowedHosts: ["[2001:db8::1]"] };
  assertEquals(requestHostAllowed(config, req("http://[2001:db8::1]:8080/")), true);
  assertEquals(requestHostAllowed(config, req("http://[2001:db8::2]/")), false);
});

Deno.test("an empty or unusable allow-list fails closed (audio-feed-7lsy)", () => {
  // fp4r left this path inert: an empty list meant "no gate", so any Host was accepted. That is the
  // failure mode Paul rejected - correct code, no behaviour change, exposure open, no error - so an
  // empty set now refuses every non-loopback host instead of switching the gate off.
  assertEquals(requestHostAllowed({ allowedHosts: [] }, req("https://anything.example/")), false);
  assertEquals(
    requestHostAllowed({ allowedHosts: ["  ", ""] }, req("https://anything.example/")),
    false,
    "entries that do not parse as a host must not silently turn the gate off",
  );
  // And it is still the case that a mis-shaped entry cannot turn the gate ON with a value nothing
  // can match; the loopback exemption is the only thing an empty set permits.
  assertEquals(requestHostAllowed({ allowedHosts: [] }, req("http://localhost:8000/")), true);
});

Deno.test("fp4r: a mis-shaped entry with a path still matches its host", () => {
  // The shape an operator copies out of PUBLIC_BASE_URL.
  const config = { allowedHosts: ["audio-feed.example.com/"] };
  assertEquals(requestHostAllowed(config, req("https://audio-feed.example.com/")), true);
});

Deno.test("fp4r: the publicBaseUrl host is implicitly allowed", () => {
  const config = { publicBaseUrl: DEPLOYED, allowedHosts: ["audio-feed.example.com"] };
  assertEquals(requestHostAllowed(config, req(`${DEPLOYED}/`)), true);
  assertEquals(requestHostAllowed(config, req("https://evil.example/")), false);
});

Deno.test("a listed host is still used as a derived origin (0k3 behaviour, via the override)", () => {
  // audio-feed-7lsy: with nothing configured the request host is no longer trusted, so the 0k3
  // behaviour (audio-feed-0k3: the advertised origin follows the request host when nothing is pinned)
  // is reached by LISTING the host instead - which is the override case, and what a preview URL or a
  // staging host uses. The derived-origin property is unchanged.
  assertEquals(requestHostAllowed({}, req("https://anything.example/")), false);
  const config = { allowedHosts: ["anything.example"] };
  assertEquals(requestHostAllowed(config, req("https://anything.example/")), true);
  const resolved = resolveOrigin(config, req("https://anything.example/"));
  assertEquals(resolved.baseUrl, "https://anything.example");
  assertEquals(resolved.explicit, false);
});

Deno.test("fp4r: a forged forwarded host is checked when the proxy opt-in is on", () => {
  const config = {
    trustProxyHeaders: true,
    allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"],
  };
  assertEquals(
    requestHostAllowed(config, req(`${DEPLOYED}/`, { "x-forwarded-host": "evil.example" })),
    false,
  );
  assertEquals(
    requestHostAllowed(
      config,
      req("http://internal:8000/", { "x-forwarded-host": "audio-feed.paulkinlan-ea.deno.net" }),
    ),
    true,
  );
});

Deno.test("fp4r: the app answers a forged Host 421 before any route runs", async () => {
  const fetch = await unconfiguredApp({ allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"] });

  for (const path of ["/", `/feed/${TOKEN}/master.xml`, "/account", "/login"]) {
    const res = await fetch(req(`https://evil.example${path}`));
    await res.body?.cancel();
    assertEquals(res.status, 421, `${path} must not be served on a spoofed host`);
    // The early return must not be a hole in the response-header contract.
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  }

  // The *.localhost bypass stays closed end to end.
  const sneaky = await fetch(req("http://evil.localhost/"));
  await sneaky.body?.cancel();
  assertEquals(sneaky.status, 421);

  // And the real host is served normally.
  const ok = await fetch(req("https://audio-feed.paulkinlan-ea.deno.net/"));
  await ok.body?.cancel();
  assertEquals(ok.status, 200);
});

Deno.test("fp4r: a forged Host cannot steer the /add redirect", async () => {
  const fetch = await unconfiguredApp({ allowedHosts: ["audio-feed.paulkinlan-ea.deno.net"] });
  const res = await fetch(req("https://evil.example/add?url=https://blog.example/x"));
  await res.body?.cancel();

  assertEquals(res.status, 421, "the redirect must not be built on a spoofed host");
});

Deno.test("the host gate configures itself from PUBLIC_BASE_URL (audio-feed-7lsy)", () => {
  const canonical = "audio-feed.paulkinlan-ea.deno.net";

  // The bug this fixes: a deployment that already knows its own host — the WebAuthn RP ID is derived
  // from this very value — nevertheless accepted ANY Host header, because the gate only switched on
  // when ALLOWED_HOSTS was set. Correct code, inert, no error: indistinguishable from working.
  const config = { publicBaseUrl: `https://${canonical}` };
  assertEquals(
    requestHostAllowed(config, req(`https://${canonical}/feed`)),
    true,
    "the deployment's own host is accepted without any ALLOWED_HOSTS",
  );
  assertEquals(
    requestHostAllowed(config, req("https://evil.example/feed")),
    false,
    "and a host it does not recognise is refused, which is the whole point",
  );
  // Local development must not need configuration: exact loopback is still allowed.
  assertEquals(requestHostAllowed(config, req("http://localhost:8000/")), true);
});

Deno.test("with nothing configured at all the gate fails closed (audio-feed-7lsy)", () => {
  // A deployment that cannot name its own host must not advertise the one a client sent.
  assertEquals(requestHostAllowed({}, req("http://localhost:8000/")), true, "loopback only");
  assertEquals(
    requestHostAllowed({}, req("https://audio-feed.paulkinlan-ea.deno.net/")),
    false,
    "nothing configured means nothing is trusted",
  );
  assertEquals(requestHostAllowed({}, req("https://evil.example/")), false);
});

Deno.test("ALLOWED_HOSTS adds hosts rather than switching the gate on (audio-feed-7lsy)", () => {
  const config = {
    publicBaseUrl: "https://audio-feed.paulkinlan-ea.deno.net",
    allowedHosts: ["staging.example"],
  };
  assertEquals(
    requestHostAllowed(config, req("https://staging.example/")),
    true,
    "the override adds",
  );
  assertEquals(
    requestHostAllowed(config, req("https://audio-feed.paulkinlan-ea.deno.net/")),
    true,
    "and does not replace the host the app already knew",
  );
});

Deno.test("resolveOrigin survives an empty host set (audio-feed-7lsy)", () => {
  // The fail-closed set is empty, so there is no host to pin to and this must fall through to the
  // last-resort branch rather than throwing on an empty list.
  const resolved = resolveOrigin({}, req("https://evil.example/feed"));
  assertEquals(typeof resolved.baseUrl, "string");
});
