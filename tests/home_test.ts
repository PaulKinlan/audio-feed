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
import type { AppConfig } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE };

function app(overrides: Partial<AppConfig> = {}) {
  const stores = memoryStores();
  const { fetch } = createApp({ config: { ...config, ...overrides }, stores });
  return fetch;
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
  const html = await (await app({ publicBaseUrl: "https://elsewhere.test" })(get("/"))).text();

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

Deno.test("the token field is masked and excluded from autofill", async () => {
  const html = await (await app()(get("/"))).text();

  assertStringIncludes(html, 'type="password"');
  assertStringIncludes(html, 'autocomplete="off"');
});

Deno.test("the token travels as a header, never as a query parameter", async () => {
  const html = await (await app()(get("/"))).text();

  assertStringIncludes(html, '"x-feed-token"');
  // A token in a query string is logged by every hop it passes through.
  assert(!/[?&](token|feedToken|feed_token)=/.test(html), "no token may appear in a URL");
});

Deno.test("interpolated config is escaped", () => {
  // publicBaseUrl is operator-controlled rather than user-controlled, so this is
  // defence in depth — but an unescaped interpolation into a template is the
  // kind of thing that stops being harmless the moment the source changes.
  const html = renderHomePage({
    publicBaseUrl: `https://x.test/"><script>alert(1)</script>`,
    synthesisConfigured: true,
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

  for (const id of ["url", "token"]) {
    assertStringIncludes(html, `<label for="${id}">`);
    assertStringIncludes(html, `aria-errormessage="${id}-error"`);
    // The referenced element must exist, or the ARIA reference is a dead link.
    assertStringIncludes(html, `id="${id}-error"`);
  }

  // Radios are labelled too, and grouped by a legend rather than a bare div.
  assertStringIncludes(html, '<label for="mode-direct">');
  assertStringIncludes(html, '<label for="mode-deepdive">');
  assertStringIncludes(html, "<legend>");
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
  assertStringIncludes(html, "Enter a full URL");
});

Deno.test("validation styling waits for interaction rather than firing on load", async () => {
  const html = await (await app()(get("/"))).text();

  // `:user-invalid` is the difference between "you got this wrong" and
  // "everything is wrong before you have typed anything".
  assertStringIncludes(html, ":user-invalid");
  assert(!/input:invalid\s*{/.test(html), "do not style :invalid — it fires on page load");
});

Deno.test("a successful submit resets the form rather than emptying one field", async () => {
  // Found by driving the real page in a browser: after a 202 the script cleared
  // `url.value`, which leaves a `required` field empty on an input the user has
  // already interacted with — so `:user-invalid` matched and a red "Enter a
  // full URL" error rendered directly beneath the green success message.
  //
  // `form.reset()` is what clears the browser's interaction state. Asserting on
  // it here because the failure is invisible to any test that only reads the
  // markup: the bug was in what the script does AFTER a successful response.
  const html = await (await app()(get("/"))).text();

  assertStringIncludes(html, "form.reset()");
  // The token and mode must survive the reset, or sending a second article
  // means retyping a credential.
  assertStringIncludes(html, "keptToken");
  assertStringIncludes(html, "keptMode");
  assert(
    !/url\.value\s*=\s*""/.test(html),
    "clearing a single field re-triggers :user-invalid; reset the form instead",
  );
});

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
