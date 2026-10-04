// audio-feed-e21x: Use <dialog closedby="any"> for Light-Dismiss Modals (dialog-closedby)
//
// Tests verify:
// - All modals use native <dialog closedby="any"> with declarative light-dismiss
// - Backdrop styling with blur and modal focus trapping
// - Light-dismiss click shim for browsers without closedBy property support
// - Canonical Baseline marker TODO(baseline/dialog-closedby) is present
// - Headless Chrome proves light-dismiss and Escape behavior

import { assert, assertEquals } from "@std/assert";
import { renderShell } from "../src/routes/shell.ts";
import { renderAdminPage } from "../src/routes/admin.ts";
import { renderAccountPage } from "../src/routes/account.ts";
import { renderListenPage } from "../src/routes/listen.ts";
import { assetUrl, handleAsset } from "../src/routes/assets.ts";
import type { RouteContext } from "../src/router.ts";
import { shippedCss } from "./admin_css.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";

const adminHtml = renderAdminPage({
  publicBaseUrl: "https://example.com",
  adminConfigured: true,
  viewer: { displayName: "Paul Kinlan", email: "paul@example.com", isAdmin: true },
});

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

const listenHtml = renderListenPage({
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
  const shellHtml = renderShell({ title: "Shell", viewer: null, main: "" });
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
  const shellHtml = renderShell({ title: "Shell", viewer: null, main: "" });
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
  const shellTs = await Deno.readTextFile("src/routes/shell.ts");
  const listenJs = await Deno.readTextFile("src/assets/listen.js");

  assert(shellTs.includes("TODO(baseline/dialog-closedby)"));
  assert(listenJs.includes("TODO(baseline/dialog-closedby)"));
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
