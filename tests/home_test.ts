/**
 * Homepage tests (audio-feed-f2a).
 *
 * Driven through the real dispatch function, so these assert on what a browser
 * would actually receive.
 *
 * The security assertions are the important ones. The form collects a feed
 * token, and a feed token is a bearer credential: anyone holding it can read
 * that user's whole feed. So the page must never be able to put one in a URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { memoryStores } from "../src/config.ts";
import { renderHomePage } from "../src/routes/home.ts";
import { assetBody } from "../src/routes/assets.ts";
import { shippedCss } from "./admin_css.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { makeUser } from "./fixtures.ts";
import type { AppConfig } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE };

function app(overrides: Partial<AppConfig> = {}) {
  const stores = memoryStores();
  const { fetch } = createApp({ config: { ...config, ...overrides }, stores });
  return fetch;
}

function appWithStores(overrides: Partial<AppConfig> = {}) {
  const stores = memoryStores();
  const { fetch } = createApp({ config: { ...config, ...overrides }, stores });
  return { fetch, stores };
}

const get = (path: string, init?: RequestInit) => new Request(`${BASE}${path}`, init);

// ---------------------------------------------------------------------------
// The regression: the origin used to 404
// ---------------------------------------------------------------------------

Deno.test("GET / serves a page instead of a 404", async () => {
  // Paul hit the deployed origin and got
  // {"error":"not_found","detail":"No route for GET /"} — every route was
  // machine-facing, so a person had no entry point at all.
  const res = await app()(get("/"));

  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, "<!doctype html>");
  assert(!html.includes("not_found"), "the homepage must not be an error document");
});

Deno.test("the page explains what the service is and how it sounds", async () => {
  const html = await (await app()(get("/"))).text();

  assertStringIncludes(html, "Audio Feed");
  assertStringIncludes(html, "Gemini");
  // Both modes, named as a listener would recognise them.
  assertStringIncludes(html, "Direct read");
  assertStringIncludes(html, "Deep dive");
  // And the voices actually configured by default.
  assertStringIncludes(html, "Charon");
  assertStringIncludes(html, "Kore");
});

Deno.test("the feed URLs shown are the routes the router actually serves", async () => {
  const html = await (await app()(get("/"))).text();

  // These must match src/app.ts. A homepage that advertises a URL shape the
  // router does not serve is the tww bug with better typography.
  assertStringIncludes(html, `${BASE}/feed/`);
  assertStringIncludes(html, "master.xml");
  assertStringIncludes(html, "direct.xml");
  assertStringIncludes(html, "deepdive.xml");
});

Deno.test("the page is built from the configured origin, not a hardcoded host", async () => {
  // audio-feed-7lsy: the gate now accepts the configured host and refuses others, so a test that
  // configures a different origin must request it. Previously any host was served, which is the
  // inert behaviour Paul rejected.
  const html = await (await app({ publicBaseUrl: "https://elsewhere.test" })(
    new Request("https://elsewhere.test/"),
  )).text();

  assertStringIncludes(html, "https://elsewhere.test/feed/");
  assert(!html.includes(BASE), "no other origin may leak into the page");
});

// ---------------------------------------------------------------------------
// The feed token is a credential
// ---------------------------------------------------------------------------

Deno.test("the form posts, so a token can never land in the URL bar", async () => {
  const html = await (await app()(get("/"))).text();

  // If scripting fails, the browser submits natively. A GET form would write
  // the token into the address bar, browser history, and any proxy log.
  assertStringIncludes(html, 'method="post"');
  assert(
    !/<form[^>]+method=["']get["']/i.test(html),
    "no form on this page may submit with GET",
  );
});

Deno.test("the logged-out homepage does not render token password inputs (audio-feed-irgu)", async () => {
  const html = await (await app()(get("/"))).text();

  assert(!html.includes('id="token"'), "homepage does not render token input");
  assert(!html.includes('type="password"'), "homepage has no password inputs");
});

Deno.test("the front door's client carries no capability handling at all (audio-feed-ewpxz)", async () => {
  const html = await (await app()(get("/"))).text();

  // audio-feed-ewpxz: the send flow lives on /account, so the front door's client has no token
  // handling left. This used to assert home.js sent x-feed-token as a header - an assert that had
  // been passing vacuously against the dead ingest wiring ever since 0bf07a7e moved the form off
  // this page. The capability must not reappear here.
  assert(
    !assetBody("home.js")?.includes("x-feed-token"),
    "the front door's client must not carry the capability",
  );
  // A token in a query string is logged by every hop it passes through.
  assert(!/[?&](token|feedToken|feed_token)=/.test(html), "no token may appear in a URL");
});

Deno.test("interpolated config is escaped", () => {
  // publicBaseUrl is operator-controlled rather than user-controlled, so this is
  // defence in depth — but an unescaped interpolation into a template is the
  // kind of thing that stops being harmless the moment the source changes.
  const html = renderHomePage({
    nonce: "test-nonce",
    publicBaseUrl: `https://x.test/"><script>alert(1)</script>`,
    synthesisConfigured: true,
    defaultVoice: "Charon",
  });

  assert(!html.includes("<script>alert(1)</script>"), "interpolated config must be escaped");
  assertStringIncludes(html, "&lt;script&gt;");
});

// ---------------------------------------------------------------------------
// Accessibility basics
// ---------------------------------------------------------------------------

Deno.test("the document declares a language and scales on mobile", async () => {
  const html = await (await app()(get("/"))).text();

  assertStringIncludes(html, '<html lang="en">');
  assertStringIncludes(html, 'name="viewport"');
  assertStringIncludes(html, "width=device-width");
  // Pinch-zoom must never be disabled.
  assert(!/user-scalable\s*=\s*no/i.test(html), "zoom must not be disabled");
  assert(!/maximum-scale\s*=\s*1/i.test(html), "zoom must not be capped");
});

Deno.test("every input has a label and an error message it points at", async () => {
  const html = await (await app()(get("/"))).text();

  assertStringIncludes(html, '<label for="request-email">');
  assertStringIncludes(html, 'aria-errormessage="request-email-error"');
  // The referenced element must exist, or the ARIA reference is a dead link.
  assertStringIncludes(html, 'id="request-email-error"');
  assertStringIncludes(html, '<label for="request-name">');
});

Deno.test("the result region announces itself to assistive technology", async () => {
  const html = await (await app()(get("/"))).text();

  assertStringIncludes(html, 'role="status"');
  assertStringIncludes(html, 'aria-live="polite"');
});

Deno.test("errors are not signalled by colour alone", async () => {
  const html = await (await app()(get("/"))).text();

  // Each error carries a glyph and text, not just a red border.
  assertStringIncludes(html, 'aria-hidden="true">⚠');
  assertStringIncludes(html, "Enter a valid email address.");
});

Deno.test("validation styling waits for interaction rather than firing on load", async () => {
  const html = await (await app()(get("/"))).text();

  // `:user-invalid` is the difference between "you got this wrong" and
  // "everything is wrong before you have typed anything".
  // audio-feed-3xq part 4b: the rule lives in the linked home.css, so resolve the page's
  // full shipped CSS (inline + every linked asset) rather than reading the page string.
  const css = shippedCss(html);
  assertStringIncludes(css, ":user-invalid");
  assert(!/input:invalid\s*{/.test(css), "do not style :invalid — it fires on page load");
});

// audio-feed-ewpxz: the "a successful submit resets the form rather than emptying one field" row is
// gone with the form it protected. It pinned the ingest form's post-success UX (form.reset() plus
// keptToken/keptMode) - wiring that lived behind the #ingest lookup guard and was unreachable since
// 0bf07a7e moved the send flow to /account. The account page's submit UX is that route's own
// concern; no carrier of this property remains on the front door.

// ---------------------------------------------------------------------------
// Behaviour without JavaScript
// ---------------------------------------------------------------------------

Deno.test("a no-JS visitor is told what to do instead of failing silently", async () => {
  const html = await (await app()(get("/"))).text();

  assertStringIncludes(html, "<noscript>");
  assertStringIncludes(html, "curl -X POST");
  assertStringIncludes(html, "x-feed-token");
});

// ---------------------------------------------------------------------------
// Deployment honesty
// ---------------------------------------------------------------------------

Deno.test("the page says so when synthesis is not configured", async () => {
  const withoutKey = await (await app()(get("/"))).text();
  assertStringIncludes(withoutKey, "no Gemini API key configured");

  const withKey = await (await app({ geminiApiKey: "set" })(get("/"))).text();
  assert(
    !withKey.includes("no Gemini API key configured"),
    "a configured deployment must not warn about a missing key",
  );
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

Deno.test("HEAD / works and sends no body", async () => {
  // Over a REAL socket, not in-process. Body stripping for HEAD happens during
  // HTTP serialization, so `fetch(new Request(...))` still hands back the full
  // body and an in-process assertion here would be asserting nothing. Same
  // reason tests/http_test.ts exists: a HEAD bug already shipped past a green
  // in-process suite once on this project (audio-feed-0h8).
  const stores = memoryStores();
  const { fetch: handler } = createApp({ config, stores });
  const controller = new AbortController();
  const server = Deno.serve({ port: 0, signal: controller.signal, onListen: () => {} }, handler);

  try {
    const res = await fetch(`http://localhost:${server.addr.port}/`, { method: "HEAD" });
    assertEquals(res.status, 200);
    assertEquals((await res.arrayBuffer()).byteLength, 0, "HEAD must send no body");
    // The size must still be advertised: a HEAD that reports zero tells a
    // client there is nothing to fetch, which is the 0h8 bug in miniature.
    assert(
      Number(res.headers.get("content-length")) > 0,
      `HEAD must report a real content-length, got ${res.headers.get("content-length")}`,
    );
  } finally {
    controller.abort();
    await server.finished;
    await stores.metadata.close();
  }
});

Deno.test("POST / is 405, not 404", async () => {
  const res = await app()(get("/", { method: "POST" }));
  assertEquals(res.status, 405);
  assertStringIncludes((await res.json()).detail, "GET");
});

Deno.test("the homepage does not render redundant token-based forms (audio-feed-irgu)", () => {
  const html = renderHomePage({
    nonce: "test-nonce",
    publicBaseUrl: "https://audio.example.com",
    synthesisConfigured: true,
    defaultVoice: "Charon",
  });

  // Redundant token forms belong on /account, not the explainer landing page.
  assert(!html.includes('id="subscribe-source"'), "no subscribe-source form on /");
  assert(!html.includes('id="ingest"'), "no ingest form on /");
  assert(!html.includes("?token="));
  assert(!html.includes("?feedToken="));
});

Deno.test("the front door links to the web player and login without leaking capabilities (audio-feed-ytg, audio-feed-irgu)", () => {
  const html = renderHomePage({
    nonce: "test-nonce",
    publicBaseUrl: "https://audio.example.com",
    synthesisConfigured: true,
    defaultVoice: "Charon",
  });

  // Link in header nav and body
  assertStringIncludes(html, '<a href="/listen">Web Player</a>');
  assertStringIncludes(html, '<a href="/login">Sign in</a>');
  // Redundant returning subscriber banner removed from public explainer
  assert(!html.includes('id="returningSubscriber"'), "no returningSubscriber banner on /");

  // No capability leaks: no token is baked into the rendered HTML
  assertEquals(html.includes("/listen/token-"), false, "never bake tokens into public links");
  assertEquals(html.includes("feedToken"), false, "never bake feedToken in public homepage");
});

Deno.test("GET / redirects signed-in users to /account with 303 (audio-feed-irgu)", async () => {
  const { fetch, stores } = appWithStores();
  const user = makeUser({ id: "user-test", email: "user@example.com" });
  await stores.metadata.putUser(user);
  const token = await createSession(stores.metadata, user.id);

  const res = await fetch(
    new Request(`${BASE}/`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
  );
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/account");
  assertEquals(res.headers.get("cache-control"), "private, no-store");
  assertStringIncludes(res.headers.get("vary") ?? "", "Cookie");
});

Deno.test("the front door keeps its player links in markup; the client builds none (audio-feed-ewpxz)", () => {
  const html = renderHomePage({
    nonce: "test-nonce",
    publicBaseUrl: "https://audio.example.com",
    synthesisConfigured: true,
    defaultVoice: "Charon",
  });

  // The player LINKS live in markup so they work without JavaScript. audio-feed-ewpxz removed the
  // client-side builders ("Open in Web Player →" inside the dead #ingest and #subscribe-source
  // guards), and the acceptance for that bead is that no "Open in Web Player" remains anywhere in
  // src/ - so this row pins the client side of that, not just the grep of the day.
  assertStringIncludes(html, 'href="/listen"');
  const client = assetBody("home.js") ?? "";
  assert(
    !client.includes("Open in Web Player"),
    "the client builds no player links; the markup owns them",
  );
  assert(!client.includes('"/listen/" +'), "the client builds no per-token listen URLs");
});

Deno.test("the homepage renders the request access form with accessible labels, hints, and secure action (audio-feed-r97)", () => {
  const html = renderHomePage({
    nonce: "test-nonce",
    publicBaseUrl: "https://audio.example.com",
    synthesisConfigured: true,
    defaultVoice: "Charon",
  });

  assertStringIncludes(html, 'id="request-access"');
  // The tag itself is asserted in pieces rather than as one string: adding attributes to a form is
  // not a change to its identity (audio-feed-dc2y added three), and an exact match would have made
  // every future attribute a test failure instead of a decision.
  assertStringIncludes(html, 'id="request-access-form"');
  assertStringIncludes(html, 'action="/api/request-access"');
  assertStringIncludes(html, 'method="post"');
  // …and the agent annotations are pinned, so they cannot silently disappear.
  assertStringIncludes(html, 'toolname="request_access"');
  assertStringIncludes(html, 'tooldescription="Submit an email address');
  assertStringIncludes(html, 'toolparamdescription="Email address that should be invited');
  assertStringIncludes(html, 'id="request-email"');
  assertStringIncludes(html, 'name="email"');
  assertStringIncludes(html, 'type="email"');
  assertStringIncludes(html, 'aria-describedby="request-email-hint"');
  assertStringIncludes(html, 'aria-errormessage="request-email-error"');
  assertStringIncludes(html, 'id="request-name"');
  assertStringIncludes(html, 'name="displayName"');
  assertStringIncludes(html, 'id="request-submit"');
  assertStringIncludes(html, 'id="request-result"');
  // audio-feed-3xq part 4b: the fetch wiring is client code now.
  assertStringIncludes(assetBody("home.js") ?? "", 'fetch("/api/request-access"');
  assertStringIncludes(html, '<a href="#request-access">Request access</a>');
});

Deno.test("adding the homepage did not shadow another route", async () => {
  const fetch = app();

  // `/` is an exact pattern; these must still reach their own handlers.
  assertEquals((await fetch(get("/health"))).status, 200);
  assertEquals((await fetch(get("/feed/tok/master.xml"))).status, 501);
  assertEquals((await fetch(get("/audio/missing.mp3"))).status, 404);

  const unknown = await fetch(get("/nope"));
  assertEquals(unknown.status, 404, "an unknown path must still 404, not serve the homepage");
  assertStringIncludes(unknown.headers.get("content-type") ?? "", "application/json");
});

Deno.test("the front door renders the bookmarklet disclosure without duplicate classes or inline script (audio-feed-3asd)", async () => {
  const html = await (await app()(get("/"))).text();

  // Single class attribute on the anchor (fixes duplicate class bug)
  const anchorMatch = html.match(/<a[^>]+class="bookmarklet-link[^>]+>/i)?.[0];
  assert(anchorMatch, "bookmarklet anchor must exist");
  assertStringIncludes(anchorMatch, 'class="bookmarklet-link u-strong-link"');
  assertEquals(
    anchorMatch.split("class=").length - 1,
    1,
    "anchor must not carry duplicate class attributes",
  );
  assertStringIncludes(anchorMatch, 'draggable="true"');

  // Disclosure details and fallback text
  assertStringIncludes(html, '<details class="bookmarklet-code u-mt-2">');
  assertStringIncludes(html, "<summary>Can’t drag it? Get the bookmarklet code</summary>");
  assertStringIncludes(html, "Content Security Policy");
  assertStringIncludes(
    html,
    '<pre class="bookmarklet-snippet u-break-all u-fs-xs"><code>javascript:(function()',
  );
});
