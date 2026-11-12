/**
 * audio-feed-3xq part 4c — the listen landing page ships content-addressed assets.
 *
 * renderListenLanding used to carry its own 40-line <style> (with DESIGN_TOKENS interpolated
 * into the template) and a 31-line inline <script>. Both are assets now: listen-landing.css is
 * composed with the tokens in front (the listen.css idiom), listen-landing.js is served
 * verbatim. These tests pin the page's new shape — what the landing links, what it no longer
 * carries inline, and what the route hands out — mirroring tests/admin_asset_test.ts and
 * tests/home_asset_test.ts.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { assetBody, assetUrl } from "../src/routes/assets.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { renderListenLanding } from "../src/routes/listen.ts";

const BASE = "https://audio.example.com";

function landingApp() {
  const stores: Stores = memoryStores();
  // The request below is on https://audio.example.com, and the gate (audio-feed-7lsy) accepts only
  // the host the app knows - so configure it.
  const config: AppConfig = { port: 0, publicBaseUrl: "https://audio.example.com" };
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return fetch;
}

Deno.test("listen landing links its assets and carries no inline style or script of its own", () => {
  const html = renderListenLanding(BASE, "test-nonce");

  // The page is markup plus links now: no <style> block, no inline client.
  assert(!/<style>/.test(html), "the landing must not carry an inline <style> block anymore");
  assert(
    !html.includes("box-sizing:border-box"),
    "the landing's own rules must not ride in the page's HTML",
  );
  assert(
    !html.includes('location.replace("/listen/"'),
    "the restore client must not ride in the page's HTML",
  );

  assertStringIncludes(
    html,
    `<link rel="stylesheet" href="${assetUrl("listen-landing.css")}">`,
    "the landing must link its stylesheet by content-addressed URL",
  );
  assertStringIncludes(
    html,
    `<script type="module" src="${assetUrl("listen-landing.js")}">`,
    "the landing must link its client as a module by content-addressed URL",
  );

  // The no-JS reading contract survives: the copy that explains the page is markup.
  assertStringIncludes(html, "Open my player");
  assertStringIncludes(html, "remembers it on this device");

  // The restore form is also an agent tool (audio-feed-dc2y). Inert without WebMCP support, pinned
  // here so the annotations cannot be dropped without a test noticing.
  assertStringIncludes(html, 'toolname="open_audio_feed_player"');
  assertStringIncludes(html, 'toolparamdescription="Personal feed URL');
  // The render expectation that steadies the cross-document transition, and the container it names.
  assertStringIncludes(html, '<link rel="expect" href="#main" blocking="render">');
  assertStringIncludes(html, '<main id="main">');
});

Deno.test("listen-landing.css is composed with the design tokens in front of the page rules", () => {
  const css = assetBody("listen-landing.css") ?? "";
  // The landing never used the shell, so its tokens ship in its stylesheet — the listen.css
  // contract. If the composition ever drops the tokens the landing renders unstyled; this is
  // the pin.
  assertStringIncludes(css, "--space-12: 3rem", "tokens must be composed in front");
  assertStringIncludes(css, "--radius: 12px", "tokens must be composed in front");
  assertStringIncludes(css, ".hint {", "the landing's own rules must follow the tokens");
  assertStringIncludes(
    css,
    "@media (prefers-reduced-motion: reduce)",
    "the template's @media escape must ship as a real at-rule",
  );
  assert(
    css.indexOf(":root") < css.indexOf(".hint"),
    "tokens first, page rules after — same cascade order as the old inline block",
  );
});

/**
 * The landing client's `tokenFrom`, taken out of the bytes the browser receives and EVALUATED, the way
 * tests/temporal_test.ts runs listen.js's when(). The alternative — retyping the parsing here — is the
 * copy that stays green while the shipped file drifts, which is the whole reason this row exists.
 */
function servedTokenFrom(source: string): (value: string) => string {
  const start = source.indexOf("const tokenFrom = (");
  assert(start >= 0, "listen-landing.js must still define tokenFrom — the page's only parsing job");
  const arrow = source.indexOf("=>", start);
  assert(arrow > start, "tokenFrom must still be an arrow function, so its body can be evaluated");
  const brace = source.indexOf("{", arrow);
  assert(brace > arrow, "tokenFrom must still have a block body");
  let depth = 0;
  let end = -1;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  assert(end > 0, "tokenFrom's block body must be closed");
  const declaration = source.slice(start, end).replace("const tokenFrom = ", "return ");
  return new Function(`${declaration};`)() as (value: string) => string;
}

Deno.test("listen-landing.js takes the feed token out of a pasted URL, whatever shape it arrives in (audio-feed-lmf8p)", () => {
  // The asset is served verbatim to the landing page and the browser runs it from there, so the only
  // honest way to pin what it does is to read the registered bytes and run the parsing they carry.
  const tokenFrom = servedTokenFrom(assetBody("listen-landing.js") ?? "");

  assertEquals(tokenFrom("https://audio.example.com/feed/tok-123/"), "tok-123", "absolute URL");
  assertEquals(
    tokenFrom("//audio.example.com/feed/tok-123/"),
    "tok-123",
    "a protocol-relative URL is parsed on its feed PATH, not on the presence of a scheme",
  );
  assertEquals(
    tokenFrom("HTTPS://Audio.Example.COM/feed/AbC-9/"),
    "AbC-9",
    "a mixed-case absolute URL still resolves, and the token keeps the case it was pasted in",
  );
  assertEquals(
    tokenFrom("  https://audio.example.com/feed/tok-123/  "),
    "tok-123",
    "the paste is trimmed before it is parsed",
  );
  assertEquals(
    tokenFrom("https://audio.example.com/feed/tok%2Fwith%20space/"),
    "tok/with space",
    "the captured segment is percent-decoded once, so what is re-encoded on the way out is the token",
  );
  assertEquals(tokenFrom("tok-123"), "tok-123", "a bare token is its own token");
  assertEquals(
    tokenFrom("   "),
    "",
    "whitespace alone yields no token, which is what makes the submit handler show its error",
  );
});

Deno.test("the landing assets are served with the immutable contract and stale hashes 404", async () => {
  const fetch = landingApp();

  for (const name of ["listen-landing.css", "listen-landing.js"] as const) {
    const res = await fetch(new Request(`https://audio.example.com${assetUrl(name)}`));
    assertEquals(res.status, 200, `${name} must be served`);
    assertEquals(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const type = name.endsWith(".css") ? "text/css" : "text/javascript";
    assertStringIncludes(res.headers.get("content-type") ?? "", type);
    assertEquals(await res.text(), assetBody(name), "served bytes are the registered bytes");
  }

  const stale = await fetch(
    new Request("https://audio.example.com/assets/deadbeef.listen-landing.js"),
  );
  assertEquals(stale.status, 404, "a hash that is not current must not be served");
});
