// audio-feed-e21x: Use <dialog closedby="any"> for Light-Dismiss Modals (dialog-closedby)
//
// Tests verify:
// - All modals use native <dialog closedby="any"> with declarative light-dismiss
// - Backdrop styling with blur and modal focus trapping
// - Light-dismiss click shim for browsers without closedBy property support
// - Canonical Baseline marker TODO(baseline/dialog-closedby) is present
// - Headless Chrome proves light-dismiss and Escape behavior

import { assert, assertEquals } from "@std/assert";
import { withChrome } from "../scripts/proof-helper.ts";
import { connectCdp } from "../scripts/proof-cdp.ts";
import { renderShell } from "../src/routes/shell.ts";
import { CONFIRM_DIALOG_CLIENT } from "../src/routes/shell.ts";
import { renderAdminPage } from "../src/routes/admin.ts";
import { renderAccountPage } from "../src/routes/account.ts";
import { renderListenPage } from "../src/routes/listen.ts";
import { assetUrl, handleAsset } from "../src/routes/assets.ts";
import type { RouteContext } from "../src/router.ts";
import { shippedCss } from "./admin_css.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";

const adminHtml = renderAdminPage({
  nonce: "test-nonce",
  publicBaseUrl: "https://example.com",
  adminConfigured: true,
  viewer: { displayName: "Paul Kinlan", email: "paul@example.com", isAdmin: true },
});

const accountHtml = renderAccountPage({
  nonce: "test-nonce",
  user: makeUser(),
  baseUrl: "https://example.com",
  rpId: "example.com",
  sources: [],
  credentials: [],
  episodes: [],
  outdatedCount: 0,
  failedCount: 0,
});

const listenHtml = renderListenPage({
  nonce: "test-nonce",
  userId: "user-1",
  token: "test-token",
  subscriber: "Listener",
  feedUrl: "https://example.com/feed/test-token",
  episodes: [{
    ...makeEpisode({ id: "ep-1", title: "Test Episode" }),
    audioUrl: "https://example.com/audio/ep-1.wav",
  }],
  offlineEnabled: true,
});

async function getListenCss(): Promise<string> {
  const url = assetUrl("listen.css");
  const fileName = url.replace("/assets/", "");
  const res = handleAsset(
    { params: { name: fileName } } as unknown as RouteContext<unknown>,
  );
  return await res.text();
}

Deno.test("closedby: all dialogs declare closedby='any' (audio-feed-e21x)", () => {
  // 1. Shell confirmDialog
  const shellHtml = renderShell({ nonce: "test-nonce", title: "Shell", viewer: null, main: "" });
  assert(shellHtml.includes('<dialog id="confirmDialog" class="confirm-dialog" closedby="any"'));

  // 2. Admin confirmDialog
  assert(adminHtml.includes('<dialog id="confirmDialog" class="confirm-dialog" closedby="any"'));

  // 3. Account confirmDialog
  assert(accountHtml.includes('<dialog id="confirmDialog" class="confirm-dialog" closedby="any"'));

  // 4. Listen shareDialog
  assert(
    listenHtml.includes(
      '<dialog id="shareDialog" class="confirm-dialog share-dialog" closedby="any"',
    ),
  );
});

Deno.test("closedby: dialog and backdrop CSS delivered across stylesheets (audio-feed-e21x)", async () => {
  // 1. Shell CSS
  const shellHtml = renderShell({ nonce: "test-nonce", title: "Shell", viewer: null, main: "" });
  assert(shellHtml.includes("dialog.confirm-dialog"));
  assert(shellHtml.includes("dialog.confirm-dialog::backdrop"));

  // 2. Admin CSS
  const adminCss = shippedCss(adminHtml);
  assert(adminCss.includes("dialog.confirm-dialog"));
  assert(adminCss.includes("dialog.confirm-dialog::backdrop"));

  // 3. Listen CSS
  const listenCss = await getListenCss();
  assert(listenCss.includes("dialog.confirm-dialog"));
  assert(listenCss.includes("dialog.confirm-dialog::backdrop"));
});

Deno.test("closedby: Baseline markers are present (audio-feed-e21x)", async () => {
  // audio-feed-0r0s: the shim's single source is the marked region, embedded by derivation, so
  // the file-level assert follows the source and the runtime assert follows the export the
  // account page actually ships. audio-feed-3xq part 4c: the source file is
  // src/assets/confirm-shared.js (composed into the served admin.js by assets.ts).
  const confirmShared = await Deno.readTextFile("src/assets/confirm-shared.js");
  const listenJs = await Deno.readTextFile("src/assets/listen.js");

  assert(confirmShared.includes("TODO(baseline/dialog-closedby)"));
  assert(listenJs.includes("TODO(baseline/dialog-closedby)"));
  assert(CONFIRM_DIALOG_CLIENT.includes("TODO(baseline/dialog-closedby)"));
});

Deno.test("closedby: headless Chrome reflects closedBy property and attribute (audio-feed-e21x)", async () => {
  const testHtml = `<!doctype html>
<html>
<body>
  <dialog id="testDialog" class="confirm-dialog" closedby="any">
    <p>Modal Content</p>
  </dialog>
  <script>
    const dialog = document.getElementById("testDialog");
    const hasProperty = "closedBy" in HTMLDialogElement.prototype;
    const closedByVal = dialog.closedBy;
    const attrVal = dialog.getAttribute("closedby");

    const res = document.createElement("p");
    res.id = "output";
    res.textContent = hasProperty + "," + closedByVal + "," + attrVal;
    document.body.appendChild(res);
  </script>
</body>
</html>`;

  // A PROFILE THIS RUN OWNS (audio-feed-e4udd): without --user-data-dir Chrome opens the machine's DEFAULT
  // profile, which only one process can hold at a time - so this suite collided with any other Chrome in the
  // run. scripts/proof-helper.ts isolates its own launches for the same reason; this module did not.
  const profileDir = await Deno.makeTempDir({ prefix: "dialog-closedby-chrome-" });
  const command = new Deno.Command("google-chrome-stable", {
    args: [
      "--headless=new",
      "--disable-gpu",
      `--user-data-dir=${profileDir}`,
      "--dump-dom",
      `data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`,
    ],
  });

  let output: Deno.CommandOutput;
  try {
    output = await command.output();
  } finally {
    await Deno.remove(profileDir, { recursive: true }).catch(() => {});
  }
  assertEquals(output.code, 0);
  const dom = new TextDecoder().decode(output.stdout);
  assert(dom.includes('<p id="output">true,any,any</p>'));
});

Deno.test("closedby: light-dismiss fallback shim closes dialog on outside click (audio-feed-e21x)", () => {
  let closedWith: string | null = null;
  const dialog = {
    open: true,
    close(val = "") {
      dialog.open = false;
      closedWith = val;
    },
    getBoundingClientRect() {
      return { top: 100, bottom: 200, left: 100, right: 300, width: 200, height: 100 };
    },
  };

  const shim = (event: { target: unknown; clientX: number; clientY: number }) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const isInside = rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!isInside) dialog.close("cancel");
  };

  // 1. Click inside dialog content -> stays open
  shim({ target: dialog, clientX: 150, clientY: 150 });
  assertEquals(dialog.open, true);

  // 2. Click outside dialog content (backdrop) -> closes
  shim({ target: dialog, clientX: 50, clientY: 50 });
  assertEquals(dialog.open, false);
  assertEquals(closedWith, "cancel");
});

Deno.test("closedby: behavioural browser proof over CDP (audio-feed-lkmuq)", async () => {
  // Drive the REAL shipped page: render the shell via the app's own renderer (renderShell),
  // serve it through the real asset route (handleAsset), load the real confirm-shared.js asset,
  // prove byte-for-byte identity against disk, and drive the shipped #confirmDialog over CDP.
  const shellHtml = renderShell({
    nonce: "test-nonce",
    title: "Confirm Dialog CDP Proof",
    viewer: null,
    main: `<div class="card"><p id="status">Ready</p></div>`,
    scriptModule: assetUrl("confirm-shared.js"),
  });

  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/assets/")) {
      const assetName = url.pathname.slice("/assets/".length);
      return handleAsset({ params: { name: assetName } } as never);
    }
    return new Response(shellHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'self'; style-src 'self' 'nonce-test-nonce'; script-src 'self' 'nonce-test-nonce'",
      },
    });
  });
  const BASE = `http://127.0.0.1:${server.addr.port}`;

  try {
    // 1. Prove identity: assert loaded asset bytes equal disk bytes for confirm-shared.js
    const diskBytes = await Deno.readTextFile("src/assets/confirm-shared.js");
    const assetUrlPath = assetUrl("confirm-shared.js");
    const assetRes = await fetch(`${BASE}${assetUrlPath}`);
    assertEquals(assetRes.status, 200, "asset route must serve 200 for confirm-shared.js");
    assertEquals(
      assetRes.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    const servedBytes = await assetRes.text();
    assertEquals(
      servedBytes,
      diskBytes,
      "loaded asset bytes must equal disk bytes for confirm-shared.js (identity proof)",
    );

    // 2. Drive the real page in headless Chrome over CDP
    await withChrome(async (chrome) => {
      const { cdp, js, until, close } = await connectCdp(chrome.port);
      try {
        await cdp("Page.enable");
        await cdp("Page.navigate", { url: BASE });
        await until("document.readyState === 'complete'", "real shell page loaded", 5000);

        // Prove identity from the browser's view: script loaded matches disk bytes
        const browserLoadedBytes = await js(
          "fetch(document.querySelector('script[type=module]').src).then(r => r.text())",
        );
        assertEquals(
          browserLoadedBytes,
          diskBytes,
          "browser-fetched script bytes must equal disk bytes for confirm-shared.js",
        );

        // Row (a): click outside closes the shipped #confirmDialog via native closedby="any"
        await js("document.getElementById('confirmDialog').showModal()");
        await until(
          "document.getElementById('confirmDialog').open === true",
          "confirmDialog open for outside click",
          5000,
        );
        // (5, 5) hits the top-left backdrop outside the centered dialog
        await cdp("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 5,
          y: 5,
          button: "left",
          clickCount: 1,
        });
        await cdp("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 5,
          y: 5,
          button: "left",
          clickCount: 1,
        });
        await until(
          "!document.getElementById('confirmDialog').open",
          "dialog closed by native outside click",
          5000,
        );
        assertEquals(await js("document.getElementById('confirmDialog').open"), false);

        // Row (b): Escape closes the shipped #confirmDialog
        await js("document.getElementById('confirmDialog').showModal()");
        await until(
          "document.getElementById('confirmDialog').open === true",
          "confirmDialog open for escape",
          5000,
        );
        for (const type of ["keyDown", "keyUp"]) {
          await cdp("Input.dispatchKeyEvent", {
            type,
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
            nativeVirtualKeyCode: 27,
          });
        }
        await until(
          "!document.getElementById('confirmDialog').open",
          "dialog closed by escape",
          5000,
        );
        assertEquals(await js("document.getElementById('confirmDialog').open"), false);

        // Row (c): click INSIDE the shipped #confirmDialog does not close it
        await js("document.getElementById('confirmDialog').showModal()");
        await until(
          "document.getElementById('confirmDialog').open === true",
          "confirmDialog open for inside click",
          5000,
        );
        const rect = await js(
          "(() => { const r = document.getElementById('confirmDialog').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()",
        );
        const insideX = Math.round(rect.left + rect.width / 2);
        const insideY = Math.round(rect.top + rect.height / 2);
        await cdp("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: insideX,
          y: insideY,
          button: "left",
          clickCount: 1,
        });
        await cdp("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: insideX,
          y: insideY,
          button: "left",
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 200));
        assertEquals(await js("document.getElementById('confirmDialog').open"), true);
        await js("document.getElementById('confirmDialog').close()");

        // Row (d): fallback path — drive the REAL confirm-shared.js asset against shipped #confirmDialog
        // when closedBy is unsupported by the platform.
        // We evaluate on new document to delete closedBy and strip closedby attr before any page scripts run,
        // so the real confirm-shared.js executes its fallback branch and registers its click listener.
        await cdp("Page.addScriptToEvaluateOnNewDocument", {
          source:
            "delete HTMLDialogElement.prototype.closedBy; document.addEventListener('DOMContentLoaded', () => document.getElementById('confirmDialog')?.removeAttribute('closedby'));",
        });
        await cdp("Page.navigate", { url: BASE });
        await until("document.readyState === 'complete'", "real fallback page loaded", 5000);

        assertEquals(await js("'closedBy' in HTMLDialogElement.prototype"), false);
        assertEquals(
          await js("document.getElementById('confirmDialog').hasAttribute('closedby')"),
          false,
        );

        await js("document.getElementById('confirmDialog').showModal()");
        await until(
          "document.getElementById('confirmDialog').open === true",
          "confirmDialog open for fallback outside click",
          5000,
        );
        await cdp("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 5,
          y: 5,
          button: "left",
          clickCount: 1,
        });
        await cdp("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 5,
          y: 5,
          button: "left",
          clickCount: 1,
        });
        await until(
          "!document.getElementById('confirmDialog').open",
          "confirmDialog closed by fallback shim",
          5000,
        );
        assertEquals(await js("document.getElementById('confirmDialog').open"), false);
        assertEquals(await js("document.getElementById('confirmDialog').returnValue"), "cancel");
      } finally {
        close();
      }
    });
  } finally {
    await server.shutdown();
  }
});
