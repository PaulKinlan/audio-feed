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

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  CONFIRM_DIALOG_CLIENT,
  CONFIRM_DIALOG_HTML,
  confirmClientFromSource,
  renderShell,
} from "../src/routes/shell.ts";
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
    nonce: "test-nonce",
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
    nonce: "test-nonce",
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

Deno.test("confirm client has ONE source: confirm-shared.js, composed into admin.js and sliced into the shell (audio-feed-0r0s, part 4c)", () => {
  // There is no second copy to keep in sync: the canonical client is src/assets/confirm-shared.js
  // in full. Two surfaces, one source: the admin console SERVES it composed in front of
  // src/assets/admin.js (assets.ts), and the classic-script pages (account) EMBED the file's
  // marked region sliced at import time (shell.ts CONFIRM_DIALOG_CLIENT). This test pins both
  // derivations: exactly one marker pair in the shared file and in the composed admin bytes, the
  // composition is exactly shared + "\n" + console file, the slice equals the shell export byte
  // for byte, the on-disk console file no longer carries any copy or marker, and the console
  // binds to the composed-provided client through globalThis. What CAN still break is the
  // slicing or the composition order — and that fails here instead of at deploy.
  const sharedFile = Deno.readTextFileSync("src/assets/confirm-shared.js");
  const consoleFile = Deno.readTextFileSync("src/assets/admin.js");
  const source = assetBody("admin.js") ?? "";
  const beginMarker = "// #confirm-shared-begin";
  const endMarker = "// #confirm-shared-end";
  // whole-line occurrences only — prose that mentions a marker must not count as one
  const countLines = (text: string, line: string) =>
    text.split("\n").filter((l) => l === line).length;
  assertEquals(
    countLines(sharedFile, beginMarker),
    1,
    "confirm-shared.js must carry exactly one confirm-shared-begin marker line",
  );
  assertEquals(
    countLines(sharedFile, endMarker),
    1,
    "confirm-shared.js must carry exactly one confirm-shared-end marker line",
  );
  assertEquals(
    countLines(consoleFile, beginMarker),
    0,
    "the on-disk console file must not carry a copy of the shared client",
  );
  assertEquals(
    countLines(consoleFile, endMarker),
    0,
    "the on-disk console file must not carry a copy of the shared client",
  );
  assertEquals(
    source,
    `${sharedFile}\n${consoleFile}`,
    "served admin.js must be exactly confirm-shared.js + console file (composition contract)",
  );
  assertStringIncludes(
    consoleFile,
    "(globalThis).askConfirm",
    "the console file must bind to the composed-provided client through globalThis",
  );
  assertEquals(
    countLines(source, beginMarker),
    1,
    "composed admin.js must carry exactly one confirm-shared-begin marker line",
  );
  assertEquals(
    countLines(source, endMarker),
    1,
    "composed admin.js must carry exactly one confirm-shared-end marker line",
  );
  const beginLine = source.split("\n").indexOf(beginMarker);
  const endLine = source.split("\n").indexOf(endMarker);
  const region = source.split("\n").slice(beginLine + 1, endLine).join("\n");
  assertEquals(CONFIRM_DIALOG_CLIENT, `\n${region}`, "shell export must BE the marked region");
  // behavioural skeleton of the single source (was the two-copy sync list)
  for (
    const marker of [
      `!("closedBy" in HTMLDialogElement.prototype)`,
      `confirmDialog.close("cancel")`,
      `typeof confirmDialog.showModal !== "function"`,
      `Promise.resolve(confirm(message))`,
      `opts.danger === false`,
      `okEl.className = "btn primary"`,
      `okEl.className = "btn danger"`,
      `resolve(confirmDialog.returnValue === "confirm")`,
      `confirmDialog.showModal();`,
    ]
  ) {
    assertStringIncludes(CONFIRM_DIALOG_CLIENT, marker, `confirm client lost: ${marker}`);
  }
  // the account page ships the single source inline
  const html = renderAccountPage({
    nonce: "test-nonce",
    user: makeUser({ id: "user-1", email: "test@example.com" }),
    baseUrl: "https://audio.example.com",
    rpId: "audio.example.com",
    sources: [],
    credentials: [],
    episodes: [],
    outdatedCount: 0,
    failedCount: 0,
    prefill: null,
  });
  assertStringIncludes(html, "function askConfirm(");
  assert(
    !html.includes("!confirm("),
    "account page script must use askConfirm instead of blocking window.confirm",
  );
});

Deno.test("renderAdminPage: includes native accessible <dialog> and client script (audio-feed-ytl)", () => {
  const html = renderAdminPage({
    nonce: "test-nonce",
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
  // audio-feed-qz3x (-zpud): the reset that keeps Escape honest must be in the EMITTED client and must
  // run BEFORE showModal(). showModal() does not clear returnValue and an Escape close carries no
  // result, so without this the next dialog inherits the previous "confirm" and a dismissed action is
  // read as approval. Asserted as an ORDER rather than a bare substring: a reset placed after
  // showModal() would leave the browser's stale value in place and satisfy a substring check.
  assertStringIncludes(CONFIRM_DIALOG_CLIENT, 'confirmDialog.returnValue = ""');
  assert(
    CONFIRM_DIALOG_CLIENT.indexOf('confirmDialog.returnValue = ""') <
      CONFIRM_DIALOG_CLIENT.indexOf("confirmDialog.showModal()"),
    "the returnValue reset must be emitted BEFORE confirmDialog.showModal()",
  );

  // Functional simulation of askConfirm logic
  type Listener = (e: { target?: unknown }) => void;
  const listeners: Record<string, Listener[]> = {};
  const dialog = {
    returnValue: "",
    open: false,
    showModal() {
      // audio-feed-qz3x (-zpud): mirror src/assets/confirm-shared.js, which clears returnValue
      // immediately before showModal(). Without this line the shim models the BUG: an Escape close
      // carries no result, so the previous "confirm" survives and the next dialog resolves true.
      dialog.returnValue = "";
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

  // Test 3 (audio-feed-qz3x, audio-feed-zpud): an APPROVED dialog must not arm the NEXT one. Escape and
  // light-dismiss close with NO result, so without the reset showModal() leaves the previous "confirm"
  // in place and this row resolves TRUE - the destructive action the user just cancelled. This is the
  // gate-runnable twin of the browser proof's hazard row (scripts/verify_qz3x_confirm_dismiss_browser.ts),
  // which cannot run here because it launches Chrome; the ORDER assertion above is what guards the real
  // emitted client, and this row is what makes the shim behave like it.
  const approved = testAskConfirm("First: the user approves this one");
  dialog.close("confirm");
  assertEquals(await approved, true);
  assertEquals(
    dialog.returnValue,
    "confirm",
    "the approved dialog leaves the value the next dialog would inherit",
  );

  const second = testAskConfirm("Second: the user presses Escape on THIS one");
  assertEquals(dialog.returnValue, "", "the reset must clear the stale value before showModal()");
  dialog.close();
  assertEquals(
    await second,
    false,
    "a dialog dismissed after an APPROVED one must resolve false, not inherit its approval",
  );
});

Deno.test("confirmClientFromSource rejects malformed sources loudly (audio-feed-0r0s review nit)", () => {
  const wrap = (body: string) => `// #confirm-shared-begin\n${body}\n// #confirm-shared-end\n`;
  // happy path: a minimal well-formed region derives cleanly
  const good = wrap("function askConfirm(message, options) {\n  confirmDialog.showModal();\n}");
  assertEquals(
    confirmClientFromSource(good),
    "\nfunction askConfirm(message, options) {\n  confirmDialog.showModal();\n}",
  );
  // marker mentions inside prose must NOT count as markers (whole-line matching)
  assertThrows(
    () => confirmClientFromSource("prose mentions // #confirm-shared-begin but has no real marker"),
    Error,
    "bracket",
  );
  // reversed or missing markers
  assertThrows(
    () =>
      confirmClientFromSource(
        "// #confirm-shared-end\n// #confirm-shared-begin\nfunction askConfirm(){}",
      ),
    Error,
    "bracket",
  );
  // a region without askConfirm is not the confirm client
  assertThrows(
    () => confirmClientFromSource(wrap("function somethingElse() {}")),
    Error,
    "askConfirm",
  );
  // module syntax would kill the classic inline script on the account page
  assertThrows(
    () => confirmClientFromSource(wrap(`import { x } from "y";\nfunction askConfirm(){}`)),
    Error,
    "import/export",
  );
  assertThrows(
    () => confirmClientFromSource(wrap(`export function askConfirm(){}`)),
    Error,
    "import/export",
  );
});
