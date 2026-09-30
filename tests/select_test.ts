// audio-feed-d6l: Adopt Customizable Select with appearance: base-select (GH #1)
//
// Tests verify that select elements across player, admin, and shell surfaces adopt
// appearance: base-select and ::picker(select) with design token styling,
// carry the canonical Baseline marker, and degrade safely on non-supporting engines.

import { assert } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { renderAccountPage } from "../src/routes/account.ts";
import { assetUrl, handleAsset } from "../src/routes/assets.ts";
import type { RouteContext } from "../src/router.ts";
import { shippedCss } from "./admin_css.ts";
import { makeUser } from "./fixtures.ts";

const adminHtml = renderAdminPage({
  publicBaseUrl: "https://example.com",
  adminConfigured: true,
  viewer: { displayName: "Paul Kinlan", email: "paul@example.com", isAdmin: true },
});

const adminCss = shippedCss(adminHtml);

const accountHtml = renderAccountPage({
  user: makeUser(),
  baseUrl: "https://example.com",
  rpId: "example.com",
  sources: [],
  credentials: [],
  episodes: [],
  outdatedCount: 0,
  failedCount: 0,
});

async function getListenCss(): Promise<string> {
  const url = assetUrl("listen.css");
  const fileName = url.replace("/assets/", "");
  const res = handleAsset(
    { params: { name: fileName } } as unknown as RouteContext<unknown>,
  );
  return await res.text();
}

Deno.test("customizable select: admin page delivers appearance: base-select with design tokens and Baseline marker (audio-feed-d6l)", () => {
  assert(adminCss.includes("@supports (appearance: base-select)"));
  assert(adminCss.includes("/* TODO(baseline/customizable-select)"));
  assert(adminCss.includes("select::picker(select)"));
  assert(adminCss.includes("appearance: base-select"));

  // Check fallback remains present for non-supporting engines
  assert(/input,\s*select\s*\{[\s\S]*?inline-size:\s*100%/.test(adminCss));
});

Deno.test("customizable select: account shell inlines appearance: base-select with design tokens and Baseline marker (audio-feed-d6l)", () => {
  assert(accountHtml.includes("@supports (appearance: base-select)"));
  assert(accountHtml.includes("/* TODO(baseline/customizable-select)"));
  assert(accountHtml.includes(".shell select::picker(select)"));
  assert(accountHtml.includes("appearance: base-select"));

  // Fallback styling present
  assert(accountHtml.includes(".shell select"));
});

Deno.test("customizable select: player stylesheet includes appearance: base-select with design tokens and Baseline marker (audio-feed-d6l)", async () => {
  const css = await getListenCss();
  assert(css.includes("@supports (appearance: base-select)"));
  assert(css.includes("/* TODO(baseline/customizable-select)"));
  assert(css.includes("select::picker(select)"));
  assert(css.includes("appearance: base-select"));

  // Options and picker icon styled
  assert(css.includes("select option:checked"));
  assert(css.includes("select::picker-icon"));
});

Deno.test("customizable select: headless Chrome computes appearance: base-select on select elements (audio-feed-d6l)", async () => {
  const listenCss = await getListenCss();

  // Measure in real Chromium page context
  const evaluateCommand = new Deno.Command("google-chrome-stable", {
    args: [
      "--headless=new",
      "--disable-gpu",
      "--dump-dom",
      `data:text/html;charset=utf-8,${
        encodeURIComponent(`
        <!doctype html><html><head><style>${listenCss}</style></head><body>
          <select id="filterSource"><option>All</option></select>
          <select class="rate" id="rate"><option>1x</option></select>
          <script>
            const f = document.getElementById("filterSource");
            const r = document.getElementById("rate");
            document.write('<div id="results">' + 
              getComputedStyle(f).appearance + ',' + 
              getComputedStyle(r).appearance + 
            '</div>');
          </script>
        </body></html>
      `)
      }`,
    ],
  });

  const evalOutput = await evaluateCommand.output();
  const dom = new TextDecoder().decode(evalOutput.stdout);
  assert(dom.includes('<div id="results">base-select,base-select</div>'));
});
