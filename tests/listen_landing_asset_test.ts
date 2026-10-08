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
  const config: AppConfig = { port: 0 };
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
