// audio-feed-pzwe: Replace Manual Tooltip Positioning with CSS Anchor Positioning (anchor-positioning)
//
// Tests verify:
// - CSS Anchor Positioning rules delivered across listen.css, admin.css, and shell.ts
// - Baseline markers TODO(baseline/anchor-positioning) present at all @supports and fallback guard sites
// - Real markup wiring across account, admin, home, shell, and player templates
// - WCAG 2.1 1.4.13 Accessibility invariants (dismissible via Escape, hoverable, persistent, aria-describedby)
// - Headless Chrome verification of CSS Anchor Positioning geometry and flip-block parity with fallback
// - audio-feed-tyu77: top-layer promotion via popover="manual" so the tooltip paints ABOVE a modal
//   <dialog> (the share dialog's Copy button tooltip was invisible as a body-level fixed div —
//   z-index cannot cross the top-layer boundary), verified in headless Chrome with showModal()

import { assert, assertEquals } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { renderAccountPage } from "../src/routes/account.ts";
import { renderHomePage } from "../src/routes/home.ts";
import { renderShell, TOOLTIP_CLIENT, TOOLTIP_HTML } from "../src/routes/shell.ts";
import { assetUrl, handleAsset } from "../src/routes/assets.ts";
import { DESIGN_TOKENS } from "../src/routes/tokens.ts";
import type { RouteContext } from "../src/router.ts";
import { shippedCss } from "./admin_css.ts";
import { withChrome } from "../scripts/proof-helper.ts";
import { connectCdp } from "../scripts/proof-cdp.ts";

/**
 * A stylesheet read by the NAME a row makes a claim about, with the source it came from (audio-feed-97mfn).
 *
 * Why the identity assertion: `shippedCss(renderAdminPage(...))` returns the admin page's inline
 * SHELL_CSS *plus* every linked asset, so a row titled "admin stylesheet" was satisfied by the shell's
 * copy of the same rules. Deleting both position-try-fallbacks declarations from src/assets/admin.css
 * left every row green - the claim lived in the row's name, not in its assertion. A row that names a
 * stylesheet now reads that stylesheet: the bytes the server serves for `name` must END WITH that
 * file's own bytes on disk (equality for the verbatim assets; the documented DESIGN_TOKENS prefix for
 * listen.css), so the CSS under test cannot be another stylesheet that happens to carry the same text.
 * The page-level claim - what the browser actually gets - stays its own row.
 */
async function namedStylesheet(
  name: string,
): Promise<{ name: string; source: string; css: string }> {
  const url = assetUrl(name);
  const fileName = url.replace("/assets/", "");
  const res = handleAsset(
    { params: { name: fileName } } as unknown as RouteContext<unknown>,
  );
  const css = await res.text();
  // The URL is /assets/<hash>.<name>; the file on disk is src/assets/<name>, without the hash.
  const source = `src/assets/${name}`;
  const onDisk = await Deno.readTextFile(source);
  assertEquals(
    css.slice(css.length - onDisk.length),
    onDisk,
    `${name}: the CSS under test must be ${source}'s own bytes - a row that names a stylesheet cannot be satisfied by a different stylesheet's copy of the same rules`,
  );
  return { name, source, css };
}

async function getListenCss(): Promise<string> {
  return (await namedStylesheet("listen.css")).css;
}

Deno.test("anchor-positioning: player stylesheet delivers anchor-positioning rules (audio-feed-pzwe)", async () => {
  const css = await getListenCss();
  assert(css.includes(".tooltip"));
  assert(css.includes(".tooltip.visible"));
  assert(css.includes("pointer-events: auto"));
  assert(css.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(css.includes("anchor-name: --tooltip-anchor"));
  assert(css.includes("position-anchor: --tooltip-anchor"));
  assert(css.includes("position-area: bottom span-right"));
  assert(css.includes("top: anchor(bottom)"));
  assert(css.includes("left: anchor(left)"));
  assert(css.includes("position-try-fallbacks: flip-block"));
  assert(css.includes("flip-inline"));
});

Deno.test("anchor-positioning: admin stylesheet delivers anchor-positioning rules (audio-feed-pzwe)", async () => {
  // src/assets/admin.css, not the admin PAGE: the two are different claims and need different rows
  // (audio-feed-97mfn). shippedCss() answers "what reaches the browser" and the shell's inline copy
  // answers it even when admin.css has lost the rules, which is how this row stayed green through
  // the deletion of both position-try-fallbacks declarations.
  const { css: adminCss } = await namedStylesheet("admin.css");
  assert(adminCss.includes(".tooltip"));
  assert(adminCss.includes(".tooltip.visible"));
  assert(adminCss.includes("pointer-events: auto"));
  assert(adminCss.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(adminCss.includes("position-anchor: --tooltip-anchor"));
  assert(adminCss.includes("position-area: bottom span-right"));
  assert(adminCss.includes("top: anchor(bottom)"));
  assert(adminCss.includes("position-try-fallbacks: flip-block"));
  assert(adminCss.includes("flip-inline"));
});

Deno.test("anchor-positioning: the admin page delivers anchor-positioning rules to the browser from among its stylesheets (audio-feed-97mfn)", () => {
  // The PAGE-level claim audio-feed-3xq part 3 asked for, kept as its own row so it cannot stand in
  // for a per-stylesheet one: it says the admin console's page ships these rules SOMEWHERE, which the
  // inline SHELL_CSS copy alone satisfies. It deliberately does not say which stylesheet carries them -
  // that is the row above, reading src/assets/admin.css.
  const adminHtml = renderAdminPage({
    nonce: "test-nonce",
    publicBaseUrl: "https://example.com",
    adminConfigured: true,
  });
  const delivered = shippedCss(adminHtml);
  assert(delivered.includes(".tooltip"));
  assert(delivered.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(delivered.includes("position-anchor: --tooltip-anchor"));
  assert(delivered.includes("position-area: bottom span-right"));
  assert(delivered.includes("position-try-fallbacks: flip-block"));
  assert(delivered.includes("flip-inline"));
});

Deno.test("anchor-positioning: shell stylesheet delivers anchor-positioning rules (audio-feed-pzwe)", () => {
  const shellHtml = renderShell({ nonce: "test-nonce", title: "Shell", viewer: null, main: "" });
  assert(shellHtml.includes(".tooltip"));
  assert(shellHtml.includes(".tooltip.visible"));
  assert(shellHtml.includes("pointer-events: auto"));
  assert(shellHtml.includes("@supports (anchor-name: --tooltip-anchor)"));
  assert(shellHtml.includes("position-anchor: --tooltip-anchor"));
  assert(shellHtml.includes("position-area: bottom span-right"));
  assert(shellHtml.includes("top: anchor(bottom)"));
  assert(shellHtml.includes("position-try-fallbacks: flip-block"));
  assert(shellHtml.includes("flip-inline"));
});

Deno.test("anchor-positioning: conservative position-try-fallbacks declaration precedes the full list in every CSS home (audio-feed-anc2)", async () => {
  // Why the ORDER is the assertion: `position-try-fallbacks: flip-block, flip-inline,
  // flip-block flip-inline` is ONE declaration, and in CSS a single unrecognised keyword
  // invalidates the whole declaration. An engine that supports flip-block but not flip-inline
  // would drop the full list entirely and lose even the block flip — unless a conservative
  // valid declaration comes first, which that engine keeps while current engines take the
  // later, richer declaration (last valid declaration wins). This is a declaration-order pin,
  // not a presence check: reordering the two declarations silently removes the fallback.
  const conservative = "position-try-fallbacks: flip-block;";
  const full = "position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;";
  const homes: Record<string, string> = {
    "listen.css": (await namedStylesheet("listen.css")).css,
    // The stylesheet, not the rendered page: the page's inline SHELL_CSS carries the same two
    // declarations, so reading the page could not tell these homes apart (audio-feed-97mfn).
    "admin.css": (await namedStylesheet("admin.css")).css,
    "shell.ts": renderShell({ nonce: "test-nonce", title: "Shell", viewer: null, main: "" }),
  };
  for (const [home, css] of Object.entries(homes)) {
    const first = css.indexOf(conservative);
    const second = css.indexOf(full);
    assert(first !== -1, `${home} lost the conservative ${conservative}`);
    assert(second !== -1, `${home} lost the full ${full}`);
    assert(
      first < second,
      `${home}: ${conservative} must precede the full list — an engine rejecting flip-inline drops the whole richer declaration, and the conservative one is its only fallback`,
    );
  }
});

Deno.test("anchor-positioning: the tooltip is a manual popover in every markup, CSS, and JS home (audio-feed-tyu77)", async () => {
  // The premise: a body-level position:fixed div paints BELOW a modal <dialog>'s top
  // layer at ANY z-index, so the share dialog's own Copy button tooltip was invisible.
  // popover="manual" is the platform's top-layer promotion; the contract below fails by
  // name if any of the six homes (2 markup, 3 CSS, 1 shared JS pair) loses it.
  assert(
    TOOLTIP_HTML.includes('popover="manual"'),
    'shell TOOLTIP_HTML must carry popover="manual"',
  );

  const listenTs = await Deno.readTextFile("src/routes/listen.ts");
  assert(
    /id="appTooltip"[^>]*popover="manual"/.test(listenTs),
    'the player page\'s tooltip container must carry popover="manual"',
  );

  const listenJs = await Deno.readTextFile("src/assets/listen.js");
  const tooltipClientJs = await Deno.readTextFile("src/assets/tooltip-client.js");
  for (
    const [name, src] of [
      ["listen.js", listenJs],
      ["tooltip-client.js", tooltipClientJs],
    ] as const
  ) {
    assert(
      src.includes('setAttribute("popover", "manual")'),
      `${name} must ensure the popover attribute on the tooltip element`,
    );
    assert(
      src.includes("showPopover"),
      `${name} must promote the tooltip via showPopover()`,
    );
    assert(
      src.includes("hidePopover"),
      `${name} must demote the tooltip via hidePopover()`,
    );
    assert(
      src.includes("TODO(baseline/popover)"),
      `${name} must mark the pre-popover fallback with TODO(baseline/popover)`,
    );
  }

  const listenCss = await Deno.readTextFile("src/assets/listen.css");
  const adminCss = await Deno.readTextFile("src/assets/admin.css");
  const shellTs = await Deno.readTextFile("src/routes/shell.ts");
  for (
    const [name, css] of [
      ["listen.css", listenCss],
      ["admin.css", adminCss],
      ["shell.ts SHELL_CSS", shellTs],
    ] as const
  ) {
    assert(
      css.includes(":popover-open"),
      `${name} must style the platform's open state`,
    );
    assert(
      css.includes("@starting-style"),
      `${name} must keep the opacity fade across the display:none boundary`,
    );
    assert(
      css.includes("display 0.15s allow-discrete") &&
        css.includes("overlay 0.15s allow-discrete"),
      `${name} must keep the closing popover painted in the top layer during its fade`,
    );
  }
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
    // A PROFILE PER LAUNCH (audio-feed-e4udd). Without --user-data-dir Chrome opens the machine's DEFAULT
    // profile, which only one process can hold at a time, so this suite collided with any other Chrome in
    // the run - the one place in the repo that ignored the isolation scripts/proof-helper.ts documents
    // ("Profile collisions: allocates unique isolated Chrome user-data-dir via Deno.makeTempDir").
    const profileDir = await Deno.makeTempDir({ prefix: "anchor-positioning-chrome-" });
    await Deno.writeTextFile(tempHtmlFile, testHtml);

    try {
      const command = new Deno.Command("google-chrome-stable", {
        args: [
          "--headless=new",
          "--disable-gpu",
          `--user-data-dir=${profileDir}`,
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
      await Deno.remove(profileDir, { recursive: true }).catch(() => {});
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
    #mid   { position: absolute; top: 200px;  left: 220px; width: 120px; height: 36px; }
    #edge  { position: absolute; top: 860px; left: 220px; width: 120px; height: 36px; }
    #right { position: absolute; top: 200px; left: 880px; width: 100px; height: 36px; }
    ${listenCss}
  </style>
</head>
<body>
  <button id="mid" data-tooltip="Download episode">mid</button>
  <button id="edge" data-tooltip="Near bottom edge">edge</button>
  <button id="right" data-tooltip="Revoke old URL and generate new feed token">right</button>
  <div id="results"></div>
  ${TOOLTIP_HTML}

  <script>
    ${TOOLTIP_CLIENT}

    const midBtn = document.getElementById("mid");
    const edgeBtn = document.getElementById("edge");
    const rightBtn = document.getElementById("right");
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

    // 3. Measure CSS Anchor Positioning path on right-edge button (flip-inline)
    rightBtn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const rightRect = rightBtn.getBoundingClientRect();
    const rightTipRect = tip.getBoundingClientRect();
    const cssRightX = Math.round(rightTipRect.left);
    const cssRightR = Math.round(rightTipRect.right);
    const cssRightOverflows = cssRightR > window.innerWidth;

    // 4. Fallback calculation for parity check
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
      targetEdgeTop: Math.round(edgeRect.top),
      cssRightX,
      cssRightR,
      cssRightOverflows
    });
  </script>
</body>
</html>`;

    const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" });
    // A PROFILE PER LAUNCH (audio-feed-e4udd). Without --user-data-dir Chrome opens the machine's DEFAULT
    // profile, which only one process can hold at a time, so this suite collided with any other Chrome in
    // the run - the one place in the repo that ignored the isolation scripts/proof-helper.ts documents
    // ("Profile collisions: allocates unique isolated Chrome user-data-dir via Deno.makeTempDir").
    const profileDir = await Deno.makeTempDir({ prefix: "anchor-positioning-chrome-" });
    await Deno.writeTextFile(tempHtmlFile, testHtml);

    try {
      const command = new Deno.Command("google-chrome-stable", {
        args: [
          "--headless=new",
          "--disable-gpu",
          `--user-data-dir=${profileDir}`,
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

      // Right-viewport coordinates: flip-inline prevents right-edge overflow
      assertEquals(
        res.cssRightOverflows,
        false,
        "CSS position-try-fallbacks: flip-inline must prevent tooltip from overflowing right viewport edge",
      );
    } finally {
      await Deno.remove(tempHtmlFile).catch(() => {});
      await Deno.remove(profileDir, { recursive: true }).catch(() => {});
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
    #mid   { position: absolute; top: 200px;  left: 220px; width: 120px; height: 36px; }
    #edge  { position: absolute; top: 860px; left: 220px; width: 120px; height: 36px; }
    #right { position: absolute; top: 200px; left: 880px; width: 100px; height: 36px; }
    ${listenCss}
  </style>
</head>
<body>
  <button id="mid" data-tooltip="Download episode">mid</button>
  <button id="edge" data-tooltip="Near bottom edge">edge</button>
  <button id="right" data-tooltip="Revoke old URL and generate new feed token">right</button>
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
    const rightBtn = document.getElementById("right");
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

    rightBtn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const rightRect = rightBtn.getBoundingClientRect();
    const rightStyleLeft = tip.style.left;
    const rightTipRenderedRight = tip.getBoundingClientRect().right;
    const rightOverflows = rightTipRenderedRight > window.innerWidth;

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
      edgeFlips,
      rightStyleLeft,
      rightTipRenderedRight,
      rightOverflows
    });
  </script>
</body>
</html>`;

    const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" });
    // A PROFILE PER LAUNCH (audio-feed-e4udd). Without --user-data-dir Chrome opens the machine's DEFAULT
    // profile, which only one process can hold at a time, so this suite collided with any other Chrome in
    // the run - the one place in the repo that ignored the isolation scripts/proof-helper.ts documents
    // ("Profile collisions: allocates unique isolated Chrome user-data-dir via Deno.makeTempDir").
    const profileDir = await Deno.makeTempDir({ prefix: "anchor-positioning-chrome-" });
    await Deno.writeTextFile(tempHtmlFile, testHtml);

    try {
      const command = new Deno.Command("google-chrome-stable", {
        args: [
          "--headless=new",
          "--disable-gpu",
          `--user-data-dir=${profileDir}`,
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
      assertEquals(res.rightOverflows, false, "the JS fallback must not overflow the right edge");
    } finally {
      await Deno.remove(tempHtmlFile).catch(() => {});
      await Deno.remove(profileDir, { recursive: true }).catch(() => {});
    }
  },
});

/**
 * The fade row's wait bound, DERIVED rather than picked (audio-feed-ev6wj).
 *
 * The page's own timeline is short and fixed (see the inline script in the row below): a 30ms
 * pre-paint sleep, two requestAnimationFrame hops so the promoted popover creates its opacity
 * transition, then six samples. The 0/75/150ms marks cost no wall clock - `sample()` calls
 * pause() and seeks `currentTime`, so each mark is a few synchronous style recalcs, not a
 * 150ms wait. Nominal page work is therefore ~30 + 2x17 + 6x2 = ~76ms, which is why an 8s
 * default looked generous.
 *
 * The page is not what bounds this wait. `until` polls over a CDP round-trip, and on a loaded
 * host the navigation, the first evaluate and every later poll are scheduled behind other
 * work. This repo has already MEASURED how far that stretches a poll: under eight-way CPU
 * saturation a bare `document.readyState === "complete"` wait legitimately exceeded 8s, which
 * is why verify_main_l7m1_e2e.ts's copy of `until` runs with 120s (audio-feed-6gst1). This row
 * was observed on a gate host at 3m35s wall for launch + wait + teardown while its 8s default
 * fired with the page healthy, so the WAIT reddened the row and every assertion below it never
 * ran - a slow host was reported as a broken page.
 *
 * 120s = 15x that measured starved-poll floor, and ~1600x this page's own 76ms timeline. It is
 * a HANG bound, not a latency bound: a page that never writes #results still fails, in two
 * minutes rather than eight seconds, with the message naming what it waited for and how long.
 */
const MEASURED_STARVED_POLL_MS = 8_000;
const FADE_SAMPLES_WAIT_MS = 15 * MEASURED_STARVED_POLL_MS;

Deno.test({
  name: "anchor-positioning: native popover tooltip fades in and out over 150ms (audio-feed-lvyit)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const listenCss = await getListenCss();
    const testHtml = `<!doctype html><html><head><style>
      :root { --space-1: .25rem; --space-2: .5rem; --surface-3: #e3e0ee;
        --text: #111; --border: #999; --radius-sm: 6px; --ease: linear; }
      ${listenCss}
    </style></head><body>
      <button id="trigger" data-tooltip="Copy link">Copy</button>
      ${TOOLTIP_HTML}
      <div id="results"></div>
      <script>${TOOLTIP_CLIENT}
        const tip = document.getElementById("appTooltip");
        const trigger = document.getElementById("trigger");
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // Headless Chrome may throttle frames between wall-clock timers. Scrub the
        // browser's actual CSS transition timeline rather than trusting timer jitter.
        const sample = (ms) => {
          // Flush the popover state before enumerating its transitions.
          getComputedStyle(tip).opacity;
          const fade = tip.getAnimations().find((a) => a.transitionProperty === "opacity");
          if (fade) { fade.pause(); fade.currentTime = ms; }
          return { opacity: Number(getComputedStyle(tip).opacity),
            display: getComputedStyle(tip).display, open: tip.matches(":popover-open"),
            hasFade: Boolean(fade) };
        };
        (async () => {
          // Give the hidden popover a paint before promotion, then sample both edges.
          await sleep(30);
          trigger.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const enterStart = sample(0);
          const enterMid = sample(75);
          const enterEnd = sample(150);
          tip.getAnimations().forEach((a) => a.finish());
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          const exitStart = sample(0);
          const exitMid = sample(75);
          const exitEnd = sample(150);
          tip.getAnimations().forEach((a) => a.finish());
          const exitClosed = sample(150);
          document.getElementById("results").textContent = JSON.stringify({
            enterStart, enterMid, enterEnd, exitStart, exitMid, exitEnd, exitClosed
          });
        })();
      </script></body></html>`;
    const file = await Deno.makeTempFile({ suffix: ".html" });
    try {
      await Deno.writeTextFile(file, testHtml);
      const { s, reduced } = await withChrome(async (chrome) => {
        const { cdp, js, until, close } = await connectCdp(chrome.port);
        try {
          await cdp("Page.enable");
          const measure = async () => {
            await cdp("Page.navigate", { url: `file://${file}` });
            await until(
              `document.getElementById("results")?.textContent.length > 0`,
              "the fade row's #results JSON (enter/exit opacity samples at 0/75/150ms)",
              FADE_SAMPLES_WAIT_MS,
            );
            return JSON.parse(await js(`document.getElementById("results").textContent`));
          };
          const s = await measure();
          await cdp("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value: "reduce" }],
          });
          return { s, reduced: await measure() };
        } finally {
          close();
        }
      });
      console.log("popover opacity samples (0 / 75 / 150ms):", JSON.stringify(s));
      console.log("reduced motion opacity samples:", JSON.stringify(reduced));
      assertEquals(s.enterStart.open, true);
      assert(s.enterStart.hasFade, "popover promotion must create an opacity transition");
      assert(s.enterStart.opacity < 0.2, "entry should begin transparent");
      assert(s.enterMid.opacity > 0.01 && s.enterMid.opacity < 0.99, "entry must interpolate");
      assertEquals(s.enterEnd.opacity, 1);
      assert(s.exitStart.hasFade, "popover demotion must create an opacity transition");
      assert(s.exitStart.opacity > 0.8, "exit should begin opaque");
      assert(s.exitMid.opacity > 0.01 && s.exitMid.opacity < 0.99, "exit must interpolate");
      assertEquals(s.exitMid.display !== "none", true, "popover must paint during exit");
      assertEquals(s.exitEnd.opacity, 0);
      assertEquals(s.exitClosed.display, "none", "closed popover must stop painting");
      assertEquals(reduced.enterStart.hasFade, false, "reduced motion disables entry fade");
      assertEquals(reduced.enterStart.opacity, 1);
      assertEquals(reduced.exitStart.hasFade, false, "reduced motion disables exit fade");
      assertEquals(reduced.exitStart.display, "none");
    } finally {
      await Deno.remove(file).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "anchor-positioning: tooltip promotes to the top layer above a modal dialog (audio-feed-tyu77)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const listenCss = await getListenCss();

    // The bug being fixed: #shareCopyBtn sits INSIDE the modal <dialog id="shareDialog">
    // (src/routes/listen.ts), so its tooltip - a body-level fixed div at z-index 1000 -
    // was painted below the dialog's top layer and never visible. The fix is popover=
    // "manual": showPopover() puts #appTooltip in the top layer AFTER the dialog, so it
    // paints above it. This test opens a real modal dialog, triggers the button's
    // tooltip, and proves (a) the platform open state, (b) anchor-positioned geometry
    // against a target inside the dialog, and (c) that it is actually displayed
    // (not the UA display:none of a closed popover). Paint order CANNOT be proven by
    // elementFromPoint here: a modal dialog confines hit-testing to its own subtree by
    // platform rule (measured on this VM's Chrome: elementsFromPoint over an open
    // body-level popover above a modal returns [dialog, HTML] - the tooltip is
    // deliberately unhittable while the modal is up), so hit-testing cannot observe
    // the top layer. Paint above the dialog is guaranteed by top-layer insertion order
    // (showPopover() after showModal()) and evidenced by the screenshot in
    // docs/evidence/audio-feed-tyu77/, regenerated by
    // scripts/tooltip-top-layer-browser-proof.ts on the REAL player page.
    const testHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root { --space-1: .25rem; --space-2: .5rem; --surface-3: #e3e0ee; --text: #111; --border: #999; --radius-sm: 6px; --ease: ease; }
    body { margin: 0; height: 900px; font: 14px system-ui; }
    dialog { padding: 24px; }
    dialog::backdrop { background: rgba(0,0,0,0.4); }
    ${listenCss}
  </style>
</head>
<body>
  <dialog id="dlg">
    <button id="dlgBtn" data-tooltip="Copy link to clipboard">Copy</button>
  </dialog>
  <div id="results"></div>
  ${TOOLTIP_HTML}

  <script>
    ${TOOLTIP_CLIENT}

    const dlg = document.getElementById("dlg");
    const btn = document.getElementById("dlgBtn");
    const tip = document.getElementById("appTooltip");
    const out = document.getElementById("results");

    dlg.showModal();
    const dialogOpen = dlg.open;

    btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));

    const popoverOpen = tip.matches(":popover-open");
    const btnRect = btn.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const anchoredX = Math.round(tipRect.left) === Math.round(btnRect.left);
    const anchoredY = Math.round(tipRect.top) === Math.round(btnRect.bottom + 8);
    const displayed = getComputedStyle(tip).display !== "none";

    out.textContent = JSON.stringify({
      dialogOpen,
      popoverOpen,
      anchoredX,
      anchoredY,
      tipTop: Math.round(tipRect.top),
      expectedTop: Math.round(btnRect.bottom + 8),
      displayed
    });
  </script>
</body>
</html>`;

    const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" });
    // A PROFILE PER LAUNCH (audio-feed-e4udd), as in the other headless tests in this file.
    const profileDir = await Deno.makeTempDir({ prefix: "anchor-positioning-chrome-" });
    await Deno.writeTextFile(tempHtmlFile, testHtml);

    try {
      const command = new Deno.Command("google-chrome-stable", {
        args: [
          "--headless=new",
          "--disable-gpu",
          `--user-data-dir=${profileDir}`,
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

      assertEquals(res.dialogOpen, true, "the dialog must be open modally");
      assertEquals(
        res.popoverOpen,
        true,
        "the tooltip must be in the top layer (:popover-open) while the modal dialog is open",
      );
      assertEquals(
        res.anchoredX,
        true,
        "the tooltip must remain anchor-positioned to the button inside the dialog (left)",
      );
      assertEquals(
        res.anchoredY,
        true,
        `the tooltip must sit 8px below the dialog button (got top=${res.tipTop}, expected ${res.expectedTop})`,
      );
      assertEquals(
        res.displayed,
        true,
        "the tooltip must be displayed (not the UA display:none of a closed popover) while the modal dialog is open",
      );
    } finally {
      await Deno.remove(tempHtmlFile).catch(() => {});
      await Deno.remove(profileDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "anchor-positioning: tooltip is positioned adjacent to its trigger and stays on-screen at viewport edges (audio-feed-1pv50)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const rawListenCss = await getListenCss();

    const makeTestHtml = (forceFallback = false) => {
      const listenCss = forceFallback
        ? rawListenCss.replace(/@supports\s*\(anchor-name:[^{]+\{[\s\S]*?\}\s*\}/g, "")
        : rawListenCss;
      return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root { --space-1: .25rem; --space-2: .5rem; --surface-3: #e3e0ee; --text: #111; --border: #999; --radius-sm: 6px; --ease: ease; }
    body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; font: 14px system-ui; }
    .btn { position: absolute; width: 100px; height: 36px; }
    #mid { top: 200px; left: 220px; }
    #top { top: 10px; left: 220px; }
    #bottom { top: 780px; left: 220px; }
    #left { top: 200px; left: 10px; }
    #right { top: 200px; left: 880px; }
    #corner { top: 780px; left: 880px; }
    ${listenCss}
  </style>
</head>
<body>
  <button id="mid" class="btn" data-tooltip="Middle Action">mid</button>
  <button id="top" class="btn" data-tooltip="Top Edge Action">top</button>
  <button id="bottom" class="btn" data-tooltip="Bottom Edge Action">bottom</button>
  <button id="left" class="btn" data-tooltip="Left Edge Action">left</button>
  <button id="right" class="btn" data-tooltip="Revoke old URL and generate new feed token">right</button>
  <button id="corner" class="btn" data-tooltip="Revoke old URL and generate new feed token">corner</button>
  <div id="results"></div>
  ${TOOLTIP_HTML}

  ${forceFallback ? `<script>CSS.supports = () => false;</script>` : ""}
  <script>
    ${TOOLTIP_CLIENT}

    const tip = document.getElementById("appTooltip");
    const out = document.getElementById("results");
    const ids = ["mid", "top", "bottom", "left", "right", "corner"];
    const records = {};

    for (const id of ids) {
      const btn = document.getElementById(id);
      btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      const tr = tip.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      records[id] = {
        tip: { top: tr.top, bottom: tr.bottom, left: tr.left, right: tr.right, width: tr.width, height: tr.height },
        btn: { top: br.top, bottom: br.bottom, left: br.left, right: br.right, width: br.width, height: br.height },
        adjacentBelow: Math.abs(tr.top - (br.bottom + 8)) <= 1,
        adjacentAbove: Math.abs(tr.bottom - (br.top - 8)) <= 1,
        alignedStart: Math.abs(tr.left - br.left) <= 1,
        alignedEnd: Math.abs(tr.right - br.right) <= 1,
        onScreen: tr.top >= 0 && tr.left >= 0 && tr.bottom <= window.innerHeight && tr.right <= window.innerWidth
      };
      btn.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    }
    out.textContent = JSON.stringify(records);
  </script>
</body>
</html>`;
    };

    for (const forceFallback of [false, true]) {
      const label = forceFallback ? "JS fallback" : "CSS Anchor Positioning";
      const tempHtmlFile = await Deno.makeTempFile({ suffix: ".html" });
      const profileDir = await Deno.makeTempDir({ prefix: "anchor-positioning-chrome-" });
      await Deno.writeTextFile(tempHtmlFile, makeTestHtml(forceFallback));

      try {
        const command = new Deno.Command("google-chrome-stable", {
          args: [
            "--headless=new",
            "--disable-gpu",
            `--user-data-dir=${profileDir}`,
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
        assert(match && match[1], `results container must be present for ${label}`);
        const res = JSON.parse(match[1].replace(/&quot;/g, '"'));

        // Assertions verify the geometric relationship against the trigger, not constant pixel values:
        // 1. Mid-viewport: adjacent below trigger, aligned to start, fully on-screen
        assertEquals(
          res.mid.adjacentBelow,
          true,
          `${label}: mid tooltip must sit directly adjacent below trigger with 8px margin`,
        );
        assertEquals(
          res.mid.alignedStart,
          true,
          `${label}: mid tooltip must align with trigger start (left)`,
        );
        assertEquals(res.mid.onScreen, true, `${label}: mid tooltip must stay on-screen`);

        // 2. Top-viewport: adjacent below trigger, aligned to start, fully on-screen
        assertEquals(
          res.top.adjacentBelow,
          true,
          `${label}: top-edge tooltip must sit directly adjacent below trigger`,
        );
        assertEquals(
          res.top.alignedStart,
          true,
          `${label}: top-edge tooltip must align with trigger start`,
        );
        assertEquals(res.top.onScreen, true, `${label}: top-edge tooltip must stay on-screen`);

        // 3. Bottom-viewport: flips above trigger (flip-block), adjacent above trigger, aligned to start, stays on-screen
        assertEquals(
          res.bottom.adjacentAbove,
          true,
          `${label}: bottom-edge tooltip must flip above trigger with 8px margin`,
        );
        assertEquals(
          res.bottom.alignedStart,
          true,
          `${label}: bottom-edge tooltip must align with trigger start`,
        );
        assertEquals(
          res.bottom.onScreen,
          true,
          `${label}: bottom-edge tooltip must stay on-screen without clipping at bottom edge`,
        );

        // 4. Left-viewport: adjacent below trigger, aligned to start, fully on-screen
        assertEquals(
          res.left.adjacentBelow,
          true,
          `${label}: left-edge tooltip must sit directly adjacent below trigger`,
        );
        assertEquals(
          res.left.alignedStart,
          true,
          `${label}: left-edge tooltip must align with trigger start`,
        );
        assertEquals(
          res.left.onScreen,
          true,
          `${label}: left-edge tooltip must stay on-screen without clipping at left edge`,
        );

        // 5. Right-viewport: adjacent below trigger, flips inline (flip-inline) to align end with trigger, stays on-screen
        assertEquals(
          res.right.adjacentBelow,
          true,
          `${label}: right-edge tooltip must sit directly adjacent below trigger`,
        );
        assertEquals(
          res.right.alignedEnd,
          true,
          `${label}: right-edge tooltip must flip inline to align with trigger end (right)`,
        );
        assertEquals(
          res.right.onScreen,
          true,
          `${label}: right-edge tooltip must stay on-screen without clipping at right edge`,
        );

        // 6. Corner (bottom-right): flips both block (above) and inline (end-aligned), stays on-screen at both boundaries
        assertEquals(
          res.corner.adjacentAbove,
          true,
          `${label}: corner tooltip must flip above trigger`,
        );
        assertEquals(
          res.corner.alignedEnd,
          true,
          `${label}: corner tooltip must flip inline to align with trigger end`,
        );
        assertEquals(
          res.corner.onScreen,
          true,
          `${label}: corner tooltip must stay on-screen at both viewport boundaries`,
        );
      } finally {
        await Deno.remove(tempHtmlFile).catch(() => {});
        await Deno.remove(profileDir, { recursive: true }).catch(() => {});
      }
    }
  },
});

/**
 * Dump a harness page's #results JSON from a throwaway headless Chrome (audio-feed-97mfn).
 *
 * The two rows below each run the SAME page twice - as shipped, and with the flip tactics removed -
 * so they share one launcher instead of a fifth and sixth copy of the launch/teardown boilerplate.
 * A profile per launch, as everywhere in this file (audio-feed-e4udd).
 */
async function resultsOf<T>(html: string, windowSize = "1000,900"): Promise<T> {
  const file = await Deno.makeTempFile({ suffix: ".html" });
  const profileDir = await Deno.makeTempDir({ prefix: "anchor-positioning-chrome-" });
  await Deno.writeTextFile(file, html);
  try {
    const output = await new Deno.Command("google-chrome-stable", {
      args: [
        "--headless=new",
        "--disable-gpu",
        `--user-data-dir=${profileDir}`,
        "--allow-file-access-from-files",
        `--window-size=${windowSize}`,
        "--dump-dom",
        `file://${file}`,
      ],
    }).output();
    assertEquals(output.code, 0);
    const dom = new TextDecoder().decode(output.stdout);
    const match = dom.match(/<div id="results">(.*?)<\/div>/);
    assert(match && match[1], "#results must be present");
    return JSON.parse(match[1].replace(/&quot;/g, '"')) as T;
  } finally {
    await Deno.remove(file).catch(() => {});
    await Deno.remove(profileDir, { recursive: true }).catch(() => {});
  }
}

interface PlacementReading {
  tipTop: number;
  tipBottom: number;
  tipLeft: number;
  tipRight: number;
  below: boolean;
  above: boolean;
  alignStart: boolean;
  alignEnd: boolean;
  onScreen: boolean;
  overflowRight: boolean;
  overflowBottom: boolean;
}

interface FlipReading {
  vw: number;
  vh: number;
  supports: boolean;
  rec: { bottom: PlacementReading; corner: PlacementReading };
}

/**
 * A page whose ONLY stylesheet is the one under test, plus the design tokens the shell supplies
 * (audio-feed-97mfn). admin.css is served verbatim and resolves against the shell's tokens, so the
 * tokens come along; no other stylesheet does, which is the point - a page-level concat could not tell
 * these rows which rules came from where.
 *
 * The two triggers sit AT the viewport edges by measurement, not by guesswork: `#bottom` at
 * 100vh - 33px and `#corner` at 100vw - 120px, so whatever the window size the tooltip has no room
 * below and (for the corner) none to the right.
 */
const flipHarness = (css: string) =>
  `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; font: 14px system-ui; }
  .btn { position: absolute; width: 100px; height: 36px; }
  #bottom { top: calc(100vh - 33px); left: 220px; }
  #corner { top: calc(100vh - 33px); left: calc(100vw - 120px); }
  ${DESIGN_TOKENS}
  ${css}
</style></head><body>
  <button id="bottom" class="btn" data-tooltip="Bottom edge action">bottom</button>
  <button id="corner" class="btn" data-tooltip="Revoke old URL and generate new feed token">corner</button>
  <div id="results"></div>
  ${TOOLTIP_HTML}
  <script>
    ${TOOLTIP_CLIENT}
    const tip = document.getElementById("appTooltip");
    const out = document.getElementById("results");
    const rec = {};
    for (const id of ["bottom", "corner"]) {
      const btn = document.getElementById(id);
      btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      const tr = tip.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      rec[id] = {
        tipTop: tr.top, tipBottom: tr.bottom, tipLeft: tr.left, tipRight: tr.right,
        below: Math.abs(tr.top - (br.bottom + 8)) <= 1,
        above: Math.abs(tr.bottom - (br.top - 8)) <= 1,
        alignStart: Math.abs(tr.left - br.left) <= 1,
        alignEnd: Math.abs(tr.right - br.right) <= 1,
        onScreen: tr.top >= 0 && tr.left >= 0 &&
          tr.bottom <= window.innerHeight && tr.right <= window.innerWidth,
        overflowRight: tr.right > window.innerWidth,
        overflowBottom: tr.bottom > window.innerHeight
      };
      btn.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    }
    out.textContent = JSON.stringify({
      vw: window.innerWidth, vh: window.innerHeight,
      supports: CSS.supports("anchor-name", "--a"), rec
    });
  </script></body></html>`;

Deno.test({
  name:
    "anchor-positioning: the flip tactics in admin.css are what keep a bottom-right tooltip on-screen (audio-feed-97mfn)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    // GEOMETRY, not the declaration's text (audio-feed-97mfn). position-try-fallbacks is only worth
    // its bytes because of where it puts the tooltip, so this row measures where the tooltip lands:
    // a bottom-right trigger has no room below or to the right, so with the tactics shipped the
    // tooltip must flip above its trigger, end-align, and stay inside the viewport.
    //
    // The second pass is the sensitivity check the first pass needs: the SAME file bytes with every
    // position-try-fallbacks declaration deleted must lose that placement and leave the viewport.
    // Without it, "the tooltip is on-screen" could be green for a reason other than the tactics -
    // exactly the failure this row exists to close. Delete the declarations from src/assets/admin.css
    // and the shipped pass measures the stripped pass: it clips, and this row reds.
    const { css, source } = await namedStylesheet("admin.css");
    const withoutTactics = css.replace(
      /^[ \t]*position-try-fallbacks:[^;]*;[ \t]*$/gm,
      "",
    );

    const shipped = await resultsOf<FlipReading>(flipHarness(css));
    const stripped = await resultsOf<FlipReading>(flipHarness(withoutTactics));

    assertEquals(shipped.supports, true, "this row needs an engine with anchor positioning");
    assertEquals(
      shipped.rec.corner.above,
      true,
      `${source}: the corner tooltip must flip ABOVE its trigger - it stayed below (top=${shipped.rec.corner.tipTop}, viewport ${shipped.vw}x${shipped.vh})`,
    );
    assertEquals(
      shipped.rec.corner.alignEnd,
      true,
      `${source}: the corner tooltip must flip inline to end-align with its trigger - it ran past the right edge (right=${shipped.rec.corner.tipRight})`,
    );
    assert(
      shipped.rec.corner.onScreen,
      `${source}: the corner tooltip must stay inside the viewport (top=${shipped.rec.corner.tipTop}, right=${shipped.rec.corner.tipRight}, viewport ${shipped.vw}x${shipped.vh})`,
    );
    assertEquals(
      shipped.rec.bottom.above,
      true,
      `${source}: the bottom-edge tooltip must flip above its trigger`,
    );
    assert(
      shipped.rec.bottom.onScreen,
      `${source}: the bottom-edge tooltip must stay inside the viewport`,
    );

    // The removed-tactics pass: same bytes, no fallbacks, off the relation AND off the screen.
    assert(
      withoutTactics !== css,
      `${source} carries no position-try-fallbacks declaration to remove, so the second pass here would re-measure the first and prove nothing`,
    );
    assertEquals(
      stripped.rec.corner.overflowRight || stripped.rec.corner.overflowBottom,
      true,
      `${source}: with the flip tactics removed the corner tooltip is expected to leave the viewport - if it does not, this row no longer pins what the declarations do`,
    );
    assertEquals(
      stripped.rec.corner.onScreen,
      false,
      `${source}: with the flip tactics removed the corner tooltip is expected to clip`,
    );
  },
});

interface GuardReading {
  inlineLeft: string;
  inlineTop: string;
  below: boolean;
  alignStart: boolean;
}

/**
 * The shared shell client on a page that lies about engine support (audio-feed-97mfn).
 *
 * `CSS.supports` is read once, at load, so the stub is installed in its own script BEFORE the client.
 */
const guardHarness = (supports: boolean, css: string) =>
  `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 14px system-ui; }
  #mid { position: absolute; top: 200px; left: 220px; width: 120px; height: 36px; }
  ${DESIGN_TOKENS}
  ${css}
</style></head><body>
  <button id="mid" data-tooltip="Download episode">mid</button>
  <div id="results"></div>
  ${TOOLTIP_HTML}
  <script>CSS.supports = () => ${supports};</script>
  <script>
    ${TOOLTIP_CLIENT}
    const tip = document.getElementById("appTooltip");
    const btn = document.getElementById("mid");
    btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const tr = tip.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    document.getElementById("results").textContent = JSON.stringify({
      inlineLeft: tip.style.left,
      inlineTop: tip.style.top,
      below: Math.abs(tr.top - (br.bottom + 8)) <= 1,
      alignStart: Math.abs(tr.left - br.left) <= 1
    });
  </script></body></html>`;

Deno.test({
  name:
    "anchor-positioning: on an engine that reports anchor positioning the tooltip client writes no inline left/top (audio-feed-97mfn)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    // The guard's PRESENCE in source text was all that was pinned before this row: replacing
    // `if (!supportsAnchorPositioning)` with `if (true)` left every row green, even though it makes
    // the getBoundingClientRect fallback overwrite the anchor rules on every engine (audio-feed-97mfn).
    // So this row observes the guard's EFFECT - whether the fallback ran - by reading the inline
    // styles it is the only thing that writes, on the same page with the engine reporting either way.
    const { css } = await namedStylesheet("admin.css");

    const fallback = await resultsOf<GuardReading>(guardHarness(false, css));
    const anchor = await resultsOf<GuardReading>(guardHarness(true, css));

    // The negative control comes first: unless the stub reaches the client, the assertion below
    // would pass because nothing ran at all - a row green for the wrong reason.
    assert(
      fallback.inlineLeft !== "" && fallback.inlineTop !== "",
      `forcing CSS.supports to false must make the client write inline left/top; it wrote left="${fallback.inlineLeft}" top="${fallback.inlineTop}", so this harness never reached the fallback`,
    );

    assertEquals(
      anchor.inlineLeft,
      "",
      `an engine reporting anchor positioning must not take the fallback path, but the client wrote inline left="${anchor.inlineLeft}" - the fallback guard no longer governs the fallback`,
    );
    assertEquals(
      anchor.inlineTop,
      "",
      `an engine reporting anchor positioning must not take the fallback path, but the client wrote inline top="${anchor.inlineTop}"`,
    );
    // "No inline style" must not be "no tooltip": the anchor rules still have to place it.
    assertEquals(
      anchor.below,
      true,
      "on the anchor path the tooltip must sit 8px below its trigger",
    );
    assertEquals(
      anchor.alignStart,
      true,
      "on the anchor path the tooltip must align with its trigger's start edge",
    );
  },
});
