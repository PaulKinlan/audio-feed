// audio-feed-3xq part 3: the admin page's CSS lives in src/assets/admin.css and is linked, not inlined
// into the template string. Two things this guards.
//
// 1. The 151-line CSS block is back in a template literal. That is the whole shape problem: it is
//    invisible to `deno check`/lint as CSS, it inflates a single render function past 1,400 lines, and
//    it makes the admin console unreviewable as presentation.
// 2. The link is emitted AFTER the inline <style>. Admin rules used to be appended at the end of that
//    same style element, so they came last and won equal-specificity ties. Move the link above the
//    style block and the page still renders, still passes a screenshot, and quietly loses a handful of
//    cascades — the kind of regression that only shows up as computed-style drift.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { assetUrl, handleAsset } from "../src/routes/assets.ts";

const html = renderAdminPage({
  nonce: "test-nonce",
  publicBaseUrl: "https://example.com",
  adminConfigured: true,
  viewer: { displayName: "Paul", email: "paul@example.com", isAdmin: true },
});

Deno.test("admin page links its stylesheet instead of inlining 151 lines of CSS", () => {
  const url = assetUrl("admin.css");
  assertStringIncludes(html, `<link rel="stylesheet" href="${url}">`);
  // Assert on a rule that belongs to admin alone. A first draft of this test checked for
  // `box-sizing: border-box` instead, and failed for the right reason: that rule is also in SHELL_CSS
  // (shell.ts:71), so it is legitimately inline on every shell page and proves nothing about where the
  // admin block lives. Markers must be exclusive to the thing being moved.
  for (const marker of [".admin-page {", ".signin-card a.primary {", "#setupLinkBox"]) {
    assertEquals(
      html.includes(marker),
      false,
      `${marker} must come from admin.css, not a template string`,
    );
  }
});

Deno.test("the stylesheet link comes after the inline style so the cascade is unchanged", () => {
  const styleEnd = html.indexOf("</style>");
  const linkStart = html.indexOf(`<link rel="stylesheet" href="${assetUrl("admin.css")}">`);
  assert(styleEnd !== -1 && linkStart !== -1, "both the inline style and the link must be present");
  assert(
    linkStart > styleEnd,
    "link must follow the inline <style>; before it, admin rules lose ties they used to win",
  );
});

Deno.test("utility CSS is emitted after the linked stylesheets so it keeps the inline-style precedence", () => {
  // audio-feed-syhu review finding: the u-* classes replaced inline style="..." attributes, which
  // beat same-specificity rules from any author sheet. admin.css sets margin-block on .card, so a
  // utility emitted before the link would silently lose that tie.
  const linkStart = html.indexOf(`<link rel="stylesheet" href="${assetUrl("admin.css")}">`);
  const utilityStart = html.indexOf(".u-mb-4 {");
  assert(
    linkStart !== -1 && utilityStart !== -1,
    "the stylesheet link and the utility block must both be present",
  );
  assert(
    utilityStart > linkStart,
    "utilities must come after the linked sheets; before them, external rules win ties the inline styles won",
  );
});

Deno.test("the admin asset is served with the hash the page actually references", async () => {
  const url = assetUrl("admin.css");
  const segments = url.slice("/assets/".length);
  const res = handleAsset({ params: { name: segments } } as never);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/css; charset=utf-8");
  assertEquals(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const body = await res.text();
  assert(body.includes(".admin-page"), "the served bytes are the admin stylesheet");
  assert(body.length > 3000, `expected the full stylesheet, got ${body.length} bytes`);
});

Deno.test("a stale admin hash is a 404, not fresh bytes under an immutable header", () => {
  // immutable is only honest because the URL names the bytes. Serve current content for any hash and a
  // cached client silently keeps the wrong stylesheet for a year.
  const res = handleAsset({ params: { name: "00000000.admin.css" } } as never);
  assertEquals(res.status, 404);
});

// ---------------------------------------------------------------------------
// audio-feed-3xq part 4a: the console's client JS made the same move the CSS did.
// ~980 lines of browser code left admin.ts's template string for src/assets/admin.js,
// served content-addressed; the page carries one JSON island (#admin-data) instead of
// interpolated constants.
// ---------------------------------------------------------------------------

Deno.test("admin page links its client module instead of inlining ~980 lines of JS", () => {
  const url = assetUrl("admin.js");
  assertStringIncludes(html, `<script type="module" src="${url}"></script>`);
  // Markers exclusive to the console's client code — the markup has ids like
  // "rotateManageToken", but only the module ever CALLS these functions.
  for (const marker of ["loadManageSources", "messageOf(error)", "function askConfirm"]) {
    assertEquals(
      html.includes(marker),
      false,
      `${marker} must come from admin.js, not a template string`,
    );
  }
});

Deno.test("the page hands the client its data as one JSON island, not interpolated constants", () => {
  const match =
    /<script\b[^>]*type="application\/json"[^>]*id="admin-data"[^>]*>([\s\S]*?)<\/script>/.exec(
      html,
    );
  assert(match, "the page must carry an #admin-data document");
  const data = JSON.parse(match![1]!);
  assertEquals(data.origin, "https://example.com");
  assertEquals(data.signedIn, true);
  // The old shape interpolated the origin into a JS string constant; the island is the
  // only place server state enters the client now.
  assertEquals(html.includes(`const ORIGIN = "https://example.com"`), false);
});

Deno.test("the admin.js asset is served with the hash the page actually references", async () => {
  const url = assetUrl("admin.js");
  const segments = url.slice("/assets/".length);
  const res = handleAsset({ params: { name: segments } } as never);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assertEquals(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const body = await res.text();
  assert(body.includes("// @ts-check"), "the served client is the checked module");
  assert(body.includes("rotateManageToken"), "the served bytes are the console client");
  assert(body.length > 30000, `expected the full client, got ${body.length} bytes`);
});

Deno.test("a stale admin.js hash is a 404, not fresh bytes under an immutable header", () => {
  const res = handleAsset({ params: { name: "00000000.admin.js" } } as never);
  assertEquals(res.status, 404);
});
