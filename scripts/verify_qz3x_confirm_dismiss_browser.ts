// audio-feed-byh4j: HISTORICAL — no suite executes or reads this script, so it is NOT evidence of current behaviour. Wire it into a suite or re-derive it before citing it.
/**
 * Browser proof: the confirm dialog's ESCAPE and light-dismiss RESOLUTION path
 * (audio-feed-qz3x).
 *
 * WHY THIS EXISTS. src/assets/confirm-shared.js resolves the promise from onClose
 * with `confirmDialog.returnValue === "confirm"`, and showModal() does NOT reset
 * returnValue. Nothing else in the suite can see whether that is right:
 *   - scripts/account-browser-proof.ts, scripts/regenerate-browser-proof.ts and
 *     scripts/admin-module-browser-proof.ts all drive this dialog, but every one
 *     of them only ever presses OK (the onOk route);
 *   - tests/dialog_test.ts:218 covers the client's light-dismiss fallback and
 *     tests/dialog_closedby_test.ts:147 covers the shim CLOSING the dialog on an
 *     outside click - neither asserts the RESOLUTION, and neither spans two
 *     dialogs, so a stale returnValue leaking across dialogs is invisible to both.
 *
 * THE HAZARD THIS MEASURES. Because an Escape close carries NO result, the
 * previous returnValue is left untouched, so ANY confirm the user APPROVES arms
 * the NEXT dialog: a later Escape or backdrop-dismiss then resolves TRUE and the
 * caller performs the destructive action the user just cancelled. Row 4 below is
 * that leak, and it is the row that fails on the unfixed tree.
 *
 * Escape and the backdrop are driven as REAL input events, not synthetic clicks:
 * CONFIRM_DIALOG_HTML carries closedby="any" and light-dismiss is native on
 * current headless Chrome, so a synthetic .click() would exercise a different
 * path from the one a user takes.
 *
 *   deno run --allow-all --unstable-kv scripts/verify_qz3x_confirm_dismiss_browser.ts
 *
 * Not part of the gate (it launches Chrome); run it after touching
 * src/assets/confirm-shared.js, its shell slicing, or the dialog markup.
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";
import { runProof, withChrome } from "./proof-helper.ts";
import { connectCdp, MEASURED_STARVED_POLL_MS, withHangBound } from "./proof-cdp.ts";

const OUT = new URL("../docs/evidence/audio-feed-qz3x/", import.meta.url).pathname;

await Deno.mkdir(OUT, { recursive: true });

await runProof("qz3x-confirm-dismiss", async (checker) => {
  // -- in-process app with a real session, the same way the admin proof does it --
  const stores: Stores = memoryStores();
  const config: AppConfig = { port: 0, adminToken: "harness-admin" };
  const ctx = { config, stores };
  const rawUser = await createUser(stores.metadata, {
    email: "qz3x@example.com",
    displayName: "Qz3x",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "qz3x@example.com/feed");
  const sessionSecret = await createSession(stores.metadata, user.id);

  const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req, info) => appFetch(req, info),
  );
  const BASE = `http://localhost:${server.addr.port}`;

  try {
    await withChrome(async (chrome) => {
      /**
       * audio-feed-teflq: this proof no longer carries a private CDP client or a private
       * `until()`. The deleted copy's reply wait was a bare `await new Promise` on its own
       * pending map, so ONE reply that never arrived (an evaluate, a screenshot) parked the
       * proof past its last PASS with no error printed. connectCdp() races every evaluate
       * against the derived HANG_BOUND_MS, and each raw command here keeps the same bound
       * through withHangBound. What each wait waits FOR is untouched: same expression, same
       * description, same explicit budget at every call site. Only the bound's source moved.
       */
      const { cdp: rawCdp, js, until, ws } = await connectCdp({ port: chrome.port });
      // deno-lint-ignore no-explicit-any
      const cdp = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
        withHangBound(method, rawCdp(method, params));

      /** 120s = 15 x the 8s starved-poll floor MEASURED on this host (audio-feed-6gst1). */
      const UNTIL_HANG_BOUND_MS = 15 * MEASURED_STARVED_POLL_MS;

      try {
        await cdp("Page.enable");
        await cdp("Network.enable");
        await cdp("Runtime.enable");
        await cdp("Network.setCookie", {
          name: "__Host-af_session",
          value: sessionSecret,
          url: BASE,
          secure: true,
        });
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        const returnValue = () => js(`document.getElementById("confirmDialog")?.returnValue`);
        /** Arms askConfirm and records its resolution in a window slot. */
        const arm = (slot: string, message: string) =>
          js(
            `(() => { window[${JSON.stringify(slot)}] = "pending";
              askConfirm(${JSON.stringify(message)}).then((v) => { window[${
              JSON.stringify(slot)
            }] = v; });
              return true; })()`,
          );
        /**
         * Waits for the armed dialog's promise to SETTLE. The `close` event is queued
         * after the dialog closes, so reading the slot the moment `open` goes false can
         * beat it and observe "pending" - a race in this proof, not in the product. The
         * OK row never sees it because onOk resolves directly instead of via the event.
         */
        const settled = async (slot: string, timeoutMs = 4000): Promise<unknown> => {
          await until(
            `window[${JSON.stringify(slot)}] !== "pending"`,
            `${slot} to settle`,
            timeoutMs,
          );
          return await js(`window[${JSON.stringify(slot)}]`);
        };

        const pressEscape = async (): Promise<void> => {
          for (const type of ["keyDown", "keyUp"]) {
            await cdp("Input.dispatchKeyEvent", {
              type,
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
              nativeVirtualKeyCode: 27,
            });
          }
        };

        /** A REAL click near the viewport corner, i.e. on the backdrop. */
        const clickBackdrop = async (): Promise<void> => {
          for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp("Input.dispatchMouseEvent", {
              type,
              x: 5,
              y: 5,
              button: "left",
              clickCount: 1,
            });
          }
        };

        /**
         * A real page load is what clears returnValue (it lives on the element), so
         * freshness is established by navigating, never by the proof writing the
         * property itself - doing that would hide the very leak being measured.
         */
        const gotoAccount = async (): Promise<void> => {
          await cdp("Page.navigate", { url: `${BASE}/account` });
          await until(
            `document.readyState === "complete"`,
            "account page loaded",
            UNTIL_HANG_BOUND_MS,
          );
          await until(
            `typeof askConfirm === "function" && !!document.getElementById("confirmDialog")`,
            "the confirm dialog client and markup are present",
            UNTIL_HANG_BOUND_MS,
          );
        };

        await gotoAccount();

        checker.check(
          "the proof is on the real surface: /account exposes askConfirm and #confirmDialog",
          await js(
            `typeof askConfirm === "function" && !!document.getElementById("confirmDialog")`,
          ),
          `pathname=${await js(`location.pathname`)}`,
        );

        // ---- ROW 1: Escape on a freshly loaded page resolves false -------------
        await gotoAccount();
        await arm("__qz3xEscape", "Delete everything?");
        await until(
          `document.getElementById("confirmDialog")?.open === true`,
          "dialog open",
          UNTIL_HANG_BOUND_MS,
        );
        await pressEscape();
        await until(
          `document.getElementById("confirmDialog")?.open !== true`,
          "escape closed it",
          UNTIL_HANG_BOUND_MS,
        );
        const escapeFresh = await settled("__qz3xEscape");
        checker.check(
          "Escape on a fresh dialog CLOSES it and resolves FALSE",
          escapeFresh === false,
          `resolved=${JSON.stringify(escapeFresh)} returnValue=${
            JSON.stringify(await returnValue())
          }`,
        );

        // ---- ROW 2: the OK button, the only route the existing proofs exercise -
        await gotoAccount();
        await arm("__qz3xOk", "Delete everything?");
        await until(
          `document.getElementById("confirmDialog")?.open === true`,
          "dialog open",
          UNTIL_HANG_BOUND_MS,
        );
        await js(`document.getElementById("confirmOkBtn")?.click()`);
        await until(
          `document.getElementById("confirmDialog")?.open !== true`,
          "OK closed it",
          UNTIL_HANG_BOUND_MS,
        );
        const okResolved = await settled("__qz3xOk");
        checker.check(
          "the OK button resolves TRUE",
          okResolved === true,
          `resolved=${JSON.stringify(okResolved)}`,
        );

        // ---- ROW 3: a real backdrop click (native light-dismiss, no result) ----
        await gotoAccount();
        await arm("__qz3xBackdrop", "Delete everything?");
        await until(
          `document.getElementById("confirmDialog")?.open === true`,
          "dialog open",
          UNTIL_HANG_BOUND_MS,
        );
        await clickBackdrop();
        let backdropClosed = true;
        try {
          await until(
            `document.getElementById("confirmDialog")?.open !== true`,
            "backdrop closed it",
            UNTIL_HANG_BOUND_MS,
          );
        } catch {
          backdropClosed = false;
        }
        checker.check(
          "a backdrop click reaches the dialog and CLOSES it (light-dismiss, not a no-op)",
          backdropClosed,
          `closed=${backdropClosed}`,
        );
        const backdropResolved = await settled("__qz3xBackdrop");
        checker.check(
          "light-dismiss resolves FALSE",
          backdropResolved === false,
          `resolved=${JSON.stringify(backdropResolved)}`,
        );

        // ---- ROW 4: THE LEAK - deliberately NO reload between the two dialogs --
        // A reload would clear returnValue and hide the leak, so this row keeps the
        // same page: approve one dialog (returnValue becomes "confirm"), then Escape
        // the next one and require that the user's dismissal is still honoured.
        await arm("__qz3xLeakConfirm", "First: the user approves this one");
        await until(
          `document.getElementById("confirmDialog")?.open === true`,
          "first dialog open",
          UNTIL_HANG_BOUND_MS,
        );
        await js(`document.getElementById("confirmOkBtn")?.click()`);
        await until(
          `document.getElementById("confirmDialog")?.open !== true`,
          "first dialog closed",
          UNTIL_HANG_BOUND_MS,
        );
        const stale = await returnValue();
        checker.check(
          "precondition: the approved dialog leaves returnValue = 'confirm' (the value the next dialog inherits)",
          stale === "confirm",
          `returnValue=${JSON.stringify(stale)}`,
        );

        await arm("__qz3xLeakEscape", "Second: the user presses Escape on THIS one");
        await until(
          `document.getElementById("confirmDialog")?.open === true`,
          "second dialog open",
          UNTIL_HANG_BOUND_MS,
        );
        // Evidence: the second dialog open on the FIXED tree, i.e. after the reset has run, so
        // returnValue is empty here. The image documents the surface this row drives; the STALE state
        // is what the row asserts one check ABOVE, against the first (approved) dialog - not what the
        // capture shows, because the reset has already cleared it by the time the dialog opens.
        const shot = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
        const shotPath = `${OUT}01-second-dialog-open.png`;
        await Deno.writeFile(shotPath, Uint8Array.fromBase64(shot.data));
        await quantiseEvidencePng(shotPath);
        await pressEscape();
        await until(
          `document.getElementById("confirmDialog")?.open !== true`,
          "second dialog closed",
          UNTIL_HANG_BOUND_MS,
        );
        const leaked = await settled("__qz3xLeakEscape");
        checker.check(
          "audio-feed-qz3x HAZARD: after an APPROVED confirm, a later Escape still resolves FALSE",
          leaked === false,
          leaked === false
            ? "the dismissal was honoured"
            : `STALE SUCCESS LEAKED ACROSS DIALOGS: the user pressed Escape and the caller was told TRUE (returnValue=${
              JSON.stringify(await returnValue())
            })`,
        );
      } finally {
        ws.close();
      }
    }, { prefix: "audiofeed-proof-qz3x-" });
  } finally {
    await server.shutdown();
  }
});
