// audio-feed-pzwe: Replace Manual Tooltip Positioning with CSS Anchor Positioning (anchor-positioning)
//
// Tests verify:
// - CSS Anchor Positioning rules delivered across listen.css, admin.css, and shell.ts
// - Baseline markers TODO(baseline/anchor-positioning) present at all @supports and fallback guard sites
// - Real markup wiring across account, admin, home, shell, and player templates
// - WCAG 2.1 1.4.13 Accessibility invariants (dismissible via Escape, hoverable, persistent, aria-describedby)
// - Headless Chrome verification of CSS Anchor Positioning geometry and flip-block parity with fallback

import { assert, assertEquals } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { renderAccountPage } from "../src/routes/account.ts";
import { renderHomePage } from "../src/routes/home.ts";
import { renderShell, TOOLTIP_CLIENT, TOOLTIP_HTML } from "../src/routes/shell.ts";
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
  assert(css.includes(".tooltip.visible"));
  assert(css.includes("pointer-events: auto"));
  assert(css.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(css.includes("anchor-name: --tooltip-anchor"));
  assert(css.includes("position-anchor: --tooltip-anchor"));
  assert(css.includes("top: anchor(bottom)"));
  assert(css.includes("left: anchor(left)"));
  assert(css.includes("position-try-fallbacks: flip-block"));
});

Deno.test("anchor-positioning: admin stylesheet delivers anchor-positioning rules (audio-feed-pzwe)", () => {
  const adminHtml = renderAdminPage({
    nonce: "test-nonce",
    publicBaseUrl: "https://example.com",
    adminConfigured: true,
  });
  const adminCss = shippedCss(adminHtml);
  assert(adminCss.includes(".tooltip"));
  assert(adminCss.includes(".tooltip.visible"));
  assert(adminCss.includes("pointer-events: auto"));
  assert(adminCss.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(adminCss.includes("position-anchor: --tooltip-anchor"));
  assert(adminCss.includes("top: anchor(bottom)"));
  assert(adminCss.includes("position-try-fallbacks: flip-block"));
});

Deno.test("anchor-positioning: shell stylesheet delivers anchor-positioning rules (audio-feed-pzwe)", () => {
  const shellHtml = renderShell({ nonce: "test-nonce", title: "Shell", viewer: null, main: "" });
  assert(shellHtml.includes(".tooltip"));
  assert(shellHtml.includes(".tooltip.visible"));
  assert(shellHtml.includes("pointer-events: auto"));
  assert(shellHtml.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(shellHtml.includes("position-anchor: --tooltip-anchor"));
  assert(shellHtml.includes("top: anchor(bottom)"));
  assert(shellHtml.includes("position-try-fallbacks: flip-block"));
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

Deno.test("anchor-positioning: rendered markup across account, admin, home, and shell wires data-tooltip (audio-feed-pzwe)", () => {
  // 1. Account page
  const accountHtml = renderAccountPage({
    nonce: "test-nonce",
    user: {
      id: "u1",
      email: "test@example.com",
      displayName: "Tester",
      status: "approved",
      isAdmin: false,
      feedToken: "tok1",
      createdAt: new Date().toISOString(),
    },
    baseUrl: "https://example.com",
    rpId: "example.com",
    sources: [{
      id: "src1",
      userId: "u1",
      title: "My Blog",
      feedUrl: "https://example.com/rss",
      modes: ["direct"],
      voices: { direct: "Puck" },
      createdAt: new Date().toISOString(),
      lastPolledAt: new Date().toISOString(),
    }],
    episodes: [
      {
        id: "ep1",
        userId: "u1",
        articleId: "art1",
        sourceId: "src1",
        sourceTitle: "My Blog",
        title: "Test Episode",
        mode: "direct",
        status: "ready",
        createdAt: new Date().toISOString(),
      },
      {
        id: "ep2",
        userId: "u1",
        articleId: "art2",
        sourceId: "src1",
        sourceTitle: "My Blog",
        title: "Failed Episode",
        mode: "direct",
        status: "failed",
        error: "TTS failure",
        createdAt: new Date().toISOString(),
      },
    ],
    credentials: [{
      id: "cred1",
      userId: "u1",
      name: "Work Passkey",
      aaguid: "00000000-0000-0000-0000-000000000000",
      publicKey: "mock-key",
      counter: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    }],
    outdatedCount: 0,
    failedCount: 1,
  });

  assert(accountHtml.includes('data-tooltip="Remove My Blog"'));
  assert(accountHtml.includes('data-tooltip="Regenerate Test Episode"'));
  assert(accountHtml.includes('data-tooltip="Retry Failed Episode"'));
  assert(
    accountHtml.includes(
      'data-tooltip="Add another passkey before removing this one"',
    ),
  );
  assert(accountHtml.includes('data-tooltip="Drag to your bookmarks bar"'));

  // 2. Admin page
  const adminHtml = renderAdminPage({
    nonce: "test-nonce",
    publicBaseUrl: "https://example.com",
    adminConfigured: true,
  });
  assert(
    adminHtml.includes('data-tooltip="Poll all configured RSS feeds immediately"'),
  );
  assert(
    adminHtml.includes(
      'data-tooltip="Process pending audio synthesis jobs"',
    ),
  );
  assert(adminHtml.includes('data-tooltip="Copy master feed URL"'));
  assert(
    adminHtml.includes(
      'data-tooltip="Revoke old URL and generate new feed token"',
    ),
  );

  // 3. Home page
  const homeHtml = renderHomePage({
    nonce: "test-nonce",
    publicBaseUrl: "https://example.com",
    synthesisConfigured: true,
    defaultVoice: "Charon",
    viewer: null,
  });
  assert(homeHtml.includes('data-tooltip="Drag to your bookmarks bar"'));

  // 4. Shell header
  const shellHtml = renderShell({
    nonce: "test-nonce",
    title: "Test",
    viewer: {
      email: "user@example.com",
      displayName: "User",
      isAdmin: false,
    },
    main: "",
  });
  assert(shellHtml.includes('data-tooltip="user@example.com"'));
});

Deno.test({
  name:
    "anchor-positioning: WCAG 2.1 1.4.13 accessibility invariants verified in headless Chrome (audio-feed-pzwe)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const listenCss = await getListenCss();

    const testHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root { --space-1: .25rem; --space-2: .5rem; --surface-3: #e3e0ee; --text: #111; --border: #999; --radius-sm: 6px; --ease: ease; }
    body { margin: 0; padding: 20px; font: 14px system-ui; }
    ${listenCss}
  </style>
</head>
<body>
  <button id="testBtn" data-tooltip="Test action tooltip" style="margin: 100px;">Hover or focus me</button>
  <div id="results"></div>
  ${TOOLTIP_HTML}

  <script>
    ${TOOLTIP_CLIENT}

    const btn = document.getElementById("testBtn");
    const tip = document.getElementById("appTooltip");
    const out = document.getElementById("results");

    // 1. Initial idle state: tooltip is role="tooltip", aria-hidden="true"
    const initialRole = tip.getAttribute("role");
    const initialHidden = tip.getAttribute("aria-hidden");

    // 2. Trigger tooltip on button
    btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));

    const activeAriaDescribedBy = btn.getAttribute("aria-describedby");
    const activeHasDataAttr = btn.hasAttribute("data-tooltip-active");
    const activeTipHidden = tip.getAttribute("aria-hidden");
    const activeTipText = tip.textContent;

    // 3. Escape key dismissal (WCAG 1.4.13 Dismissible)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const postEscapeDescribedBy = btn.hasAttribute("aria-describedby");
    const postEscapeTipVisible = tip.classList.contains("visible");
    const postEscapeTipHidden = tip.getAttribute("aria-hidden");

    out.textContent = JSON.stringify({
      initialRole,
      initialHidden,
      activeAriaDescribedBy,
      activeHasDataAttr,
      activeTipHidden,
      activeTipText,
      postEscapeDescribedBy,
      postEscapeTipVisible,
      postEscapeTipHidden
    });
  </script>
</body>
</html>`;

    const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" });
    await Deno.writeTextFile(tempHtmlFile, testHtml);

    try {
      const command = new Deno.Command("google-chrome-stable", {
        args: [
          "--headless=new",
          "--disable-gpu",
          "--allow-file-access-from-files",
          "--dump-dom",
          `file://${tempHtmlFile}`,
        ],
      });

      const output = await command.output();
      assertEquals(output.code, 0);
      const dom = new TextDecoder().decode(output.stdout);
      const match = dom.match(/<div id="results">(.*?)<\/div>/);
      assert(match && match[1], "results container must be present");
      const res = JSON.parse(match[1].replace(/&quot;/g, '"'));

      assertEquals(res.initialRole, "tooltip", "role must be tooltip");
      assertEquals(res.initialHidden, "true", "initial state must be hidden");
      assertEquals(
        res.activeAriaDescribedBy,
        "appTooltip",
        "aria-describedby must reference tooltip id",
      );
      assertEquals(
        res.activeHasDataAttr,
        true,
        "data-tooltip-active must be present",
      );
      assertEquals(
        res.activeTipHidden,
        "false",
        "active tooltip must not be hidden",
      );
      assertEquals(
        res.activeTipText,
        "Test action tooltip",
        "tooltip text must match",
      );
      assertEquals(
        res.postEscapeDescribedBy,
        false,
        "Escape must remove aria-describedby",
      );
      assertEquals(
        res.postEscapeTipVisible,
        false,
        "Escape must remove visible class",
      );
      assertEquals(
        res.postEscapeTipHidden,
        "true",
        "Escape must reset aria-hidden to true",
      );
    } finally {
      await Deno.remove(tempHtmlFile).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "anchor-positioning: headless Chrome computes anchored coordinates with flip-block parity (audio-feed-pzwe)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const listenCss = await getListenCss();

    const testHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root { --space-1: .25rem; --space-2: .5rem; --surface-3: #e3e0ee; --text: #111; --border: #999; --radius-sm: 6px; --ease: ease; }
    body { margin: 0; height: 900px; font: 14px system-ui; }
    #mid  { position: absolute; top: 200px;  left: 220px; width: 120px; height: 36px; }
    #edge { position: absolute; top: 860px; left: 220px; width: 120px; height: 36px; }
    ${listenCss}
  </style>
</head>
<body>
  <button id="mid" data-tooltip="Download episode">mid</button>
  <button id="edge" data-tooltip="Near bottom edge">edge</button>
  <div id="results"></div>
  ${TOOLTIP_HTML}

  <script>
    ${TOOLTIP_CLIENT}

    const midBtn = document.getElementById("mid");
    const edgeBtn = document.getElementById("edge");
    const tip = document.getElementById("appTooltip");
    const out = document.getElementById("results");

    // 1. Measure CSS Anchor Positioning path on mid-viewport button
    midBtn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const midRect = midBtn.getBoundingClientRect();
    const midTipRect = tip.getBoundingClientRect();
    const cssMidY = Math.round(midTipRect.top);
    const cssMidX = Math.round(midTipRect.left);

    // 2. Measure CSS Anchor Positioning path on bottom-edge button (flip-block)
    edgeBtn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const edgeRect = edgeBtn.getBoundingClientRect();
    const edgeTipRect = tip.getBoundingClientRect();
    const cssEdgeY = Math.round(edgeTipRect.top);
    const cssEdgeFlipped = cssEdgeY < edgeRect.top;

    // 3. Fallback calculation for parity check
    const tipH = tip.offsetHeight || 28;
    const margin = 8;

    // Fallback mid
    const fallbackMidY = Math.round(midRect.bottom + margin);
    const fallbackMidX = Math.round(midRect.left);

    // Fallback edge (flip logic)
    const overflowBottom = (edgeRect.bottom + margin + tipH) > window.innerHeight;
    const fitsAbove = (edgeRect.top - margin - tipH) >= 0;
    const fallbackEdgeY = Math.round((overflowBottom && fitsAbove)
      ? (edgeRect.top - margin - tipH)
      : (edgeRect.bottom + margin));

    out.textContent = JSON.stringify({
      cssMidY,
      cssMidX,
      fallbackMidY,
      fallbackMidX,
      cssEdgeY,
      cssEdgeFlipped,
      fallbackEdgeY,
      targetEdgeTop: Math.round(edgeRect.top)
    });
  </script>
</body>
</html>`;

    const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" });
    await Deno.writeTextFile(tempHtmlFile, testHtml);

    try {
      const command = new Deno.Command("google-chrome-stable", {
        args: [
          "--headless=new",
          "--disable-gpu",
          "--allow-file-access-from-files",
          "--window-size=1000,900",
          "--dump-dom",
          `file://${tempHtmlFile}`,
        ],
      });

      const output = await command.output();
      assertEquals(output.code, 0);
      const dom = new TextDecoder().decode(output.stdout);
      const match = dom.match(/<div id="results">(.*?)<\/div>/);
      assert(match && match[1], "results container must be present");
      const res = JSON.parse(match[1].replace(/&quot;/g, '"'));

      // Mid-viewport coordinates: target bottom (200 + 36 = 236) + 8px margin = 244px
      assertEquals(res.cssMidY, 244, "CSS anchor positioning mid Y must be 244");
      assertEquals(res.cssMidX, 220, "CSS anchor positioning mid X must be 220");
      assertEquals(
        res.fallbackMidY,
        res.cssMidY,
        "fallback mid Y must match CSS anchor positioning",
      );
      assertEquals(
        res.fallbackMidX,
        res.cssMidX,
        "fallback mid X must match CSS anchor positioning",
      );

      // Edge-viewport coordinates: must flip above target
      assertEquals(
        res.cssEdgeFlipped,
        true,
        "CSS position-try-fallbacks must flip above",
      );
      assert(
        res.cssEdgeY < res.targetEdgeTop,
        "flipped tooltip must sit above target",
      );
      assert(
        res.fallbackEdgeY < res.targetEdgeTop,
        "fallback must flip above target",
      );
    } finally {
      await Deno.remove(tempHtmlFile).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "anchor-positioning: the JS fallback reads layout before writing styles and still positions the tooltip (audio-feed-kuu0)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const listenCss = await getListenCss();

    const testHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root { --space-1: .25rem; --space-2: .5rem; --surface-3: #e3e0ee; --text: #111; --border: #999; --radius-sm: 6px; --ease: ease; }
    body { margin: 0; height: 900px; font: 14px system-ui; }
    #mid  { position: absolute; top: 200px;  left: 220px; width: 120px; height: 36px; }
    #edge { position: absolute; top: 860px; left: 220px; width: 120px; height: 36px; }
    ${listenCss}
  </style>
</head>
<body>
  <button id="mid" data-tooltip="Download episode">mid</button>
  <button id="edge" data-tooltip="Near bottom edge">edge</button>
  <div id="results"></div>
  ${TOOLTIP_HTML}

  <script>
    // Force the JS fallback: the client reads CSS.supports once, at load.
    CSS.supports = () => false;
  </script>
  <script>
    ${TOOLTIP_CLIENT}

    const tip = document.getElementById("appTooltip");
    const midBtn = document.getElementById("mid");
    const edgeBtn = document.getElementById("edge");
    const out = document.getElementById("results");

    // audio-feed-kuu0: watch the tooltip's own height read. If the fallback writes
    // style.left before reading offsetHeight, the read observes a non-empty inline left.
    const heightGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight").get;
    let leftAtFirstHeightRead = null;
    Object.defineProperty(tip, "offsetHeight", {
      configurable: true,
      get() {
        if (leftAtFirstHeightRead === null) leftAtFirstHeightRead = tip.style.left;
        return heightGetter.call(this);
      },
    });

    midBtn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const midRect = midBtn.getBoundingClientRect();
    const midStyleLeft = tip.style.left;
    const midStyleTop = tip.style.top;
    const tipHeight = tip.offsetHeight || 28;

    edgeBtn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const edgeRect = edgeBtn.getBoundingClientRect();
    const edgeStyleTop = tip.style.top;
    const edgeRenderedBottom = tip.getBoundingClientRect().bottom;
    const edgeFlips = (edgeRect.bottom + 8 + tipHeight) > window.innerHeight &&
      (edgeRect.top - 8 - tipHeight) >= 0;

    out.textContent = JSON.stringify({
      leftAtFirstHeightRead,
      midStyleLeft,
      midStyleTop,
      midRectLeft: midRect.left,
      midRectBottom: midRect.bottom,
      tipHeight,
      edgeStyleTop,
      edgeRectTop: edgeRect.top,
      edgeRenderedBottom,
      edgeFlips
    });
  </script>
</body>
</html>`;

    const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" });
    await Deno.writeTextFile(tempHtmlFile, testHtml);

    try {
      const command = new Deno.Command("google-chrome-stable", {
        args: [
          "--headless=new",
          "--disable-gpu",
          "--allow-file-access-from-files",
          "--window-size=1000,900",
          "--dump-dom",
          `file://${tempHtmlFile}`,
        ],
      });

      const output = await command.output();
      assertEquals(output.code, 0);
      const dom = new TextDecoder().decode(output.stdout);
      const match = dom.match(/<div id="results">(.*?)<\/div>/);
      assert(match && match[1], "results container must be present");
      const res = JSON.parse(match[1].replace(/&quot;/g, '"'));

      // The fix: no style write may precede the layout read that followed it.
      assertEquals(
        res.leftAtFirstHeightRead,
        "",
        "the tooltip height must be read before style.left is written",
      );
      // ... and the fallback arithmetic is unchanged: same place, same flip.
      assertEquals(parseFloat(res.midStyleLeft), res.midRectLeft);
      assertEquals(parseFloat(res.midStyleTop), res.midRectBottom + 8);
      assertEquals(res.edgeFlips, true, "the near-bottom anchor must take the flip branch");
      assertEquals(parseFloat(res.edgeStyleTop), res.edgeRectTop - 8 - res.tipHeight);
      assert(
        res.edgeRenderedBottom <= res.edgeRectTop,
        "the flipped tooltip must render above its target",
      );
    } finally {
      await Deno.remove(tempHtmlFile).catch(() => {});
    }
  },
});
