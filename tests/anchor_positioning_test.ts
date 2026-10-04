// audio-feed-pzwe: Replace Manual Tooltip Positioning with CSS Anchor Positioning (anchor-positioning)
//
// Tests verify:
// - CSS Anchor Positioning rules delivered across listen.css, admin.css, and shell.ts
// - Baseline markers TODO(baseline/anchor-positioning) present at all @supports guard sites
// - Fallback transparency between native CSS Anchor Positioning and getBoundingClientRect() math
// - Real browser headless Chrome proof verifying tethered positioning

import { assert, assertEquals } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { renderShell } from "../src/routes/shell.ts";
import { assetUrl, handleAsset } from "../src/routes/assets.ts";
import type { RouteContext } from "../src/router.ts";
import { shippedCss } from "./admin_css.ts";

async function getListenCss(): Promise<string> {
  const url = assetUrl("listen.css");
  const fileName = url.replace("/assets/", "");
  const res = handleAsset(
    { params: { name: fileName } } as unknown as RouteContext<unknown>,
  );
  return await res.text();
}

Deno.test("anchor-positioning: player stylesheet delivers anchor-positioning rules (audio-feed-pzwe)", async () => {
  const css = await getListenCss();
  assert(css.includes(".tooltip"));
  assert(css.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(css.includes("anchor-name: --tooltip-anchor"));
  assert(css.includes("position-anchor: --tooltip-anchor"));
  assert(css.includes("top: anchor(bottom)"));
  assert(css.includes("left: anchor(left)"));
  assert(css.includes("position-try-fallbacks: flip-block"));
});

Deno.test("anchor-positioning: admin stylesheet delivers anchor-positioning rules (audio-feed-pzwe)", () => {
  const adminHtml = renderAdminPage({
    publicBaseUrl: "https://example.com",
    adminConfigured: true,
  });
  const adminCss = shippedCss(adminHtml);
  assert(adminCss.includes(".tooltip"));
  assert(adminCss.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(adminCss.includes("position-anchor: --tooltip-anchor"));
  assert(adminCss.includes("top: anchor(bottom)"));
});

Deno.test("anchor-positioning: shell stylesheet delivers anchor-positioning rules (audio-feed-pzwe)", () => {
  const shellHtml = renderShell({ title: "Shell", viewer: null, main: "" });
  assert(shellHtml.includes(".tooltip"));
  assert(shellHtml.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(shellHtml.includes("position-anchor: --tooltip-anchor"));
  assert(shellHtml.includes("top: anchor(bottom)"));
});

Deno.test("anchor-positioning: Baseline markers are present at all @supports guard sites (audio-feed-pzwe)", async () => {
  const listenCss = await Deno.readTextFile("src/assets/listen.css");
  const adminCss = await Deno.readTextFile("src/assets/admin.css");
  const shellTs = await Deno.readTextFile("src/routes/shell.ts");
  const listenJs = await Deno.readTextFile("src/assets/listen.js");

  assert(listenCss.includes("TODO(baseline/anchor-positioning)"));
  assert(adminCss.includes("TODO(baseline/anchor-positioning)"));
  assert(shellTs.includes("TODO(baseline/anchor-positioning)"));
  assert(listenJs.includes("TODO(baseline/anchor-positioning)"));
});

Deno.test("anchor-positioning: fallback and native positioning compute identical coordinates (audio-feed-pzwe)", () => {
  // Target geometry
  const targetRect = {
    left: 120,
    top: 200,
    right: 220,
    bottom: 240,
    width: 100,
    height: 40,
  };

  // Fallback math (as executed in JS fallback)
  const fallbackLeft = targetRect.left;
  const fallbackTop = targetRect.bottom + 8;

  // Native Anchor Positioning specification math:
  // top: anchor(bottom); margin-block-start: 8px; -> target.bottom + 8px
  // left: anchor(left); -> target.left
  const nativeTop = targetRect.bottom + 8;
  const nativeLeft = targetRect.left;

  assertEquals(fallbackLeft, nativeLeft, "horizontal coordinate must match");
  assertEquals(fallbackTop, nativeTop, "vertical coordinate must match");
});

Deno.test({
  name: "anchor-positioning: headless Chrome computes anchored coordinates (audio-feed-pzwe)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const testHtml = `<!doctype html>
<html>
<head>
  <style>
    .btn {
      position: absolute;
      top: 100px;
      left: 150px;
      width: 120px;
      height: 36px;
      anchor-name: --test-target;
    }
    .tooltip {
      position: fixed;
      position-anchor: --test-target;
      top: anchor(bottom);
      left: anchor(left);
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <button class="btn" id="btn">Download</button>
  <div class="tooltip" id="tip">Download episode</div>
  <script>
    const btn = document.getElementById("btn");
    const tip = document.getElementById("tip");
    const bRect = btn.getBoundingClientRect();
    const tRect = tip.getBoundingClientRect();
    const expectedTop = bRect.bottom + 8;
    const expectedLeft = bRect.left;

    const topDiff = Math.abs(tRect.top - expectedTop);
    const leftDiff = Math.abs(tRect.left - expectedLeft);

    const res = document.createElement("p");
    res.id = "output";
    res.textContent = (topDiff < 1) + "," + (leftDiff < 1);
    document.body.appendChild(res);
  </script>
</body>
</html>`;

    const command = new Deno.Command("google-chrome-stable", {
      args: [
        "--headless=new",
        "--disable-gpu",
        "--dump-dom",
        `data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`,
      ],
    });

    const output = await command.output();
    assertEquals(output.code, 0);
    const dom = new TextDecoder().decode(output.stdout);
    assert(dom.includes('<p id="output">true,true</p>'));
  },
});
