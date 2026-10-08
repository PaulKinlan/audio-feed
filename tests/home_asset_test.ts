// audio-feed-3xq part 4b: the homepage's CSS and client JS made the same move the admin page's
// did in parts 3 and 4a. The 204-line <style> block lives in src/assets/home.css and the 376-line
// inline <script> in src/assets/home.js, both served content-addressed; the page carries one
// #home-data JSON island ({base}) and a module link.
//
// Two things this guards, mirroring tests/admin_asset_test.ts:
// 1. The presentation and client stay OUT of the template string — that is the whole point of
//    the bead: a string is invisible to deno check/lint and unreviewable at this size.
// 2. The stylesheet link is emitted AFTER the inline <style>. Home rules used to be appended at
//    the end of that same style element, so they came last and won equal-specificity ties; a
//    link placed before it would render fine and quietly lose cascades.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderHomePage } from "../src/routes/home.ts";
import { assetUrl, handleAsset } from "../src/routes/assets.ts";

const html = renderHomePage({
  nonce: "test-nonce",
  publicBaseUrl: "https://example.com",
  synthesisConfigured: true,
  defaultVoice: "Charon",
});

Deno.test("home page links its stylesheet instead of inlining 204 lines of CSS", () => {
  const url = assetUrl("home.css");
  assertStringIncludes(html, `<link rel="stylesheet" href="${url}">`);
  // Markers exclusive to home's own block; the shell's inline <style> must not carry them.
  for (const marker of [".card .voices {", "#result .detail,"]) {
    assertEquals(
      html.includes(marker),
      false,
      `${marker} must come from home.css, not a template string`,
    );
  }
});

Deno.test("the home stylesheet link comes after the inline style so the cascade is unchanged", () => {
  const styleEnd = html.indexOf("</style>");
  const linkStart = html.indexOf(`<link rel="stylesheet" href="${assetUrl("home.css")}">`);
  assert(styleEnd !== -1 && linkStart !== -1, "both the inline style and the link must be present");
  assert(
    linkStart > styleEnd,
    "link must follow the inline <style>; before it, home rules lose ties they used to win",
  );
});

Deno.test("home page links its client module and carries the data island", () => {
  assertStringIncludes(html, `<script type="module" src="${assetUrl("home.js")}"></script>`);
  const match =
    /<script\b[^>]*type="application\/json"[^>]*id="home-data"[^>]*>([\s\S]*?)<\/script>/.exec(
      html,
    );
  assert(match, "the page must carry a #home-data document");
  const data = JSON.parse(match![1]!);
  assertEquals(data.base, "https://example.com");
  // Markers exclusive to the client code. (The bare header NAME appears in the page's
  // noscript curl example on purpose, so the marker must be client-shaped.)
  for (const marker of ["encodeURIComponent(token.value.trim())", "Open in Web Player"]) {
    assertEquals(html.includes(marker), false, `${marker} must come from home.js`);
  }
});

Deno.test("the home assets are served with the hashes the page actually references", async () => {
  for (
    const [name, marker] of [["home.css", ".card .voices"], ["home.js", "x-feed-token"]] as const
  ) {
    const url = assetUrl(name);
    const segments = url.slice("/assets/".length);
    const res = handleAsset({ params: { name: segments } } as never);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const body = await res.text();
    assert(body.includes(marker), `the served bytes are ${name}`);
    assertEquals(
      res.headers.get("content-type"),
      name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
    );
  }
});

Deno.test("stale home asset hashes are 404s, not fresh bytes under immutable headers", () => {
  for (const name of ["home.css", "home.js"]) {
    const res = handleAsset({ params: { name: `00000000.${name}` } } as never);
    assertEquals(res.status, 404);
  }
});
