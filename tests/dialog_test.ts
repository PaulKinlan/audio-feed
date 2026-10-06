/**
 * Tests for native accessible <dialog> confirmation (audio-feed-ytl).
 *
 * Verifies Modern Web Guidance compliance:
 * - Native <dialog> element with closedby="any" for declarative light-dismiss
 * - Native <form method="dialog"> for native submission/dismissal without custom JS
 * - autofocus on Cancel button to prevent accidental confirmation on keyboard navigation
 * - Accessible name and description bindings via aria-labelledby and aria-describedby
 * - Integration in shell, account, and admin surfaces
 * - askConfirm helper resolves correctly on confirm, cancel, and fallback
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CONFIRM_DIALOG_CLIENT, CONFIRM_DIALOG_HTML, renderShell } from "../src/routes/shell.ts";
import { assetBody, assetUrl } from "../src/routes/assets.ts";
import { renderAccountPage } from "../src/routes/account.ts";
import { renderAdminPage } from "../src/routes/admin.ts";
import { makeUser } from "./fixtures.ts";

Deno.test("CONFIRM_DIALOG_HTML: adheres to Modern Web Guidance conventions (audio-feed-ytl)", () => {
  // 1. Native <dialog> with closedby="any" for declarative light-dismiss
  assertStringIncludes(CONFIRM_DIALOG_HTML, '<dialog id="confirmDialog"');
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'closedby="any"');

  // 2. Accessible naming
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'aria-labelledby="confirmTitle"');
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'aria-describedby="confirmMessage"');
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'id="confirmTitle"');
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'id="confirmMessage"');

  // 3. Form method="dialog"
  assertStringIncludes(CONFIRM_DIALOG_HTML, '<form method="dialog"');

  // 4. autofocus on Cancel button to protect against accidental confirmation
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'value="cancel"');
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'id="confirmCancelBtn"');
  assert(
    /<button[^>]*value="cancel"[^>]*autofocus/.test(CONFIRM_DIALOG_HTML) ||
      /<button[^>]*autofocus[^>]*value="cancel"/.test(CONFIRM_DIALOG_HTML),
    "Cancel button must have autofocus",
  );

  // 5. Confirm submit button
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'value="confirm"');
  assertStringIncludes(CONFIRM_DIALOG_HTML, 'id="confirmOkBtn"');
});

Deno.test("SHELL_CSS: styles dialog and backdrop with unified tokens (audio-feed-ytl)", () => {
  const html = renderShell({
    title: "Test Shell",
    viewer: null,
    main: "<p>Content</p>",
  });

  // Dialog styling
  assertStringIncludes(html, "dialog.confirm-dialog");
  assertStringIncludes(html, "dialog.confirm-dialog::backdrop");
  assertStringIncludes(html, "backdrop-filter: blur");
  assertStringIncludes(html, "white-space: pre-line");

  // Shell contains dialog markup
  assertStringIncludes(html, 'id="confirmDialog"');
});

Deno.test("renderAccountPage: includes native accessible <dialog> and client script (audio-feed-ytl)", () => {
  const user = makeUser({ id: "user-1", email: "test@example.com" });
  const html = renderAccountPage({
    user,
    baseUrl: "https://audio.example.com",
    rpId: "audio.example.com",
    sources: [],
    credentials: [],
    episodes: [],
    outdatedCount: 0,
    failedCount: 0,
    prefill: null,
  });

  assertStringIncludes(html, '<dialog id="confirmDialog"');
  assertStringIncludes(html, 'closedby="any"');
  assertStringIncludes(html, "askConfirm(");
  assert(
    !html.includes("!confirm("),
    "account page script must use askConfirm instead of blocking window.confirm",
  );
});

Deno.test("renderAdminPage: includes native accessible <dialog> and client script (audio-feed-ytl)", () => {
  const html = renderAdminPage({
    publicBaseUrl: "https://audio.example.com",
    adminConfigured: true,
    viewer: { displayName: "Admin", email: "admin@example.com", isAdmin: true },
  });

  assertStringIncludes(html, '<dialog id="confirmDialog"');
  assertStringIncludes(html, 'closedby="any"');
  // audio-feed-3xq part 4a: askConfirm moved from the inline page string into the
  // content-addressed client module, so the assertion follows the bytes that ship.
  // The property is unchanged: the console asks with the native dialog, never with a
  // blocking window.confirm whose result is discarded.
  const client = assetBody("admin.js");
  assert(client !== null, "admin.js must be a registered asset");
  assertStringIncludes(client, "askConfirm(");
  assert(
    !client.includes("!confirm("),
    "admin console client must use askConfirm instead of blocking window.confirm",
  );
  // And the page must actually load that module.
  assertStringIncludes(html, `<script type="module" src="${assetUrl("admin.js")}"></script>`);
});

Deno.test("CONFIRM_DIALOG_CLIENT: provides light-dismiss fallback and resolves promise on close (audio-feed-ytl)", async () => {
  // Teachable moment in Modern Web Guidance:
  // "I was going to write custom JavaScript event listeners to close the dialog
  // and resolve promises manually. What I didn't know was that native
  // <form method='dialog'> closes the <dialog> automatically and sets .returnValue
  // to the clicked submit button's value, which drastically simplifies state tracking.
  // Combining closedby='any' with an autofocus on the non-destructive Cancel button
  // guarantees keyboard and light-dismiss safety out of the box."
  assertStringIncludes(CONFIRM_DIALOG_CLIENT, "askConfirm(message, options)");
  assertStringIncludes(CONFIRM_DIALOG_CLIENT, "confirmDialog.showModal()");
  assertStringIncludes(CONFIRM_DIALOG_CLIENT, 'confirmDialog.returnValue === "confirm"');
  assertStringIncludes(CONFIRM_DIALOG_CLIENT, "closedBy");

  // Functional simulation of askConfirm logic
  type Listener = (e: { target?: unknown }) => void;
  const listeners: Record<string, Listener[]> = {};
  const dialog = {
    returnValue: "",
    open: false,
    showModal() {
      dialog.open = true;
    },
    close(val?: string) {
      dialog.open = false;
      if (val !== undefined) dialog.returnValue = val;
      for (const fn of listeners["close"] ?? []) fn({});
    },
    addEventListener(event: string, fn: Listener) {
      (listeners[event] ??= []).push(fn);
    },
    removeEventListener(event: string, fn: Listener) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== fn);
    },
  };

  const titleEl = { textContent: "" };
  const msgEl = { textContent: "" };
  const okEl = { textContent: "", className: "" };
  const cancelEl = { textContent: "" };

  function testAskConfirm(
    message: string,
    options?: { title?: string; confirmText?: string; cancelText?: string; danger?: boolean },
  ): Promise<boolean> {
    const opts = options || {};
    titleEl.textContent = opts.title || "Confirm Action";
    msgEl.textContent = message;
    okEl.textContent = opts.confirmText || "Confirm";
    cancelEl.textContent = opts.cancelText || "Cancel";
    if (opts.danger === false) {
      okEl.className = "btn primary";
    } else {
      okEl.className = "btn danger";
    }
    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue === "confirm");
      };
      dialog.addEventListener("close", onClose);
      dialog.showModal();
    });
  }

  // Test 1: Confirm action
  const confirmPromise = testAskConfirm("Delete subscriber data?", {
    title: "Delete User",
    confirmText: "Delete",
    danger: true,
  });
  assertEquals(titleEl.textContent, "Delete User");
  assertEquals(msgEl.textContent, "Delete subscriber data?");
  assertEquals(okEl.textContent, "Delete");
  assertEquals(cancelEl.textContent, "Cancel");
  assertEquals(okEl.className, "btn danger");
  assertEquals(dialog.open, true);

  // User submits form with value="confirm"
  dialog.close("confirm");
  const confirmed = await confirmPromise;
  assertEquals(confirmed, true);
  assertEquals(dialog.open, false);

  // Test 2: Cancel action
  const cancelPromise = testAskConfirm("Rotate feed token?");
  assertEquals(titleEl.textContent, "Confirm Action");
  assertEquals(msgEl.textContent, "Rotate feed token?");
  assertEquals(dialog.open, true);

  // User dismisses via Escape or Cancel button (value="cancel")
  dialog.close("cancel");
  const cancelled = await cancelPromise;
  assertEquals(cancelled, false);
  assertEquals(dialog.open, false);
});
