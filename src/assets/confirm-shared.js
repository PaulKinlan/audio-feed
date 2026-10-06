/**
 * The confirm-dialog client — the single canonical copy (audio-feed-0r0s), lifted out of
 * src/assets/admin.js into its own file by audio-feed-3xq part 4c.
 *
 * The closedby light-dismiss shim + askConfirm. src/routes/assets.ts composes this file in
 * front of src/assets/admin.js when serving the console module, and src/routes/shell.ts embeds
 * the marked region inline on the classic-script pages (account), so every surface runs these
 * same bytes and there is no second copy to drift.
 *
 * `// @ts-check` here covers the region in every place it is checked from: standalone, at the
 * top of the composed admin.js the server hands out, and through the shell's text import.
 *
 * Constraints the region must keep: plain script (no import/export — it ships inside a classic
 * <script> on the account page), self-contained (only DOM globals), bracketed by the two
 * #confirm-shared marker lines as whole lines (shell.ts slices between them at module load and
 * throws if they are broken).
 */
// @ts-check
/// <reference lib="dom" />

// #confirm-shared-begin
const confirmDialog = /** @type {HTMLDialogElement | null} */ (
  document.getElementById("confirmDialog")
);
if (
  confirmDialog && typeof HTMLDialogElement !== "undefined" &&
  !("closedBy" in HTMLDialogElement.prototype)
) {
  // TODO(baseline/dialog-closedby): remove this click shim; keep closedby="any" on the dialog.
  // Light-dismiss fallback for browsers without native closedby support (Modern Web Guidance)
  confirmDialog.addEventListener("click", (event) => {
    if (event.target !== confirmDialog) return;
    const rect = confirmDialog.getBoundingClientRect();
    const isInside = rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!isInside) confirmDialog.close("cancel");
  });
}

/**
 * The options askConfirm accepts.
 * @typedef {object} ConfirmOptions
 * @property {string} [title]
 * @property {string} [confirmText]
 * @property {string} [cancelText]
 * @property {boolean} [danger]
 */

/**
 * @param {string} message
 * @param {ConfirmOptions} [options]
 * @returns {Promise<boolean>}
 */
function askConfirm(message, options) {
  /** @type {ConfirmOptions} */
  const opts = options || {};
  if (!confirmDialog || typeof confirmDialog.showModal !== "function") {
    return Promise.resolve(confirm(message));
  }
  const titleEl = document.getElementById("confirmTitle");
  const msgEl = document.getElementById("confirmMessage");
  const okEl = document.getElementById("confirmOkBtn");
  const cancelEl = document.getElementById("confirmCancelBtn");
  if (titleEl) titleEl.textContent = opts.title || "Confirm Action";
  if (msgEl) msgEl.textContent = message;
  if (okEl) {
    okEl.textContent = opts.confirmText || "Confirm";
    if (opts.danger === false) {
      okEl.className = "btn primary";
    } else {
      okEl.className = "btn danger";
    }
  }
  if (cancelEl) cancelEl.textContent = opts.cancelText || "Cancel";
  return new Promise((resolve) => {
    const onClose = () => {
      confirmDialog.removeEventListener("close", onClose);
      resolve(confirmDialog.returnValue === "confirm");
    };
    confirmDialog.addEventListener("close", onClose);
    confirmDialog.showModal();
  });
}

// Publish for code composed AFTER this region (audio-feed-3xq part 4c): inside a classic
// <script> the function declaration above is already a global; inside the composed console
// module it is module-scoped, and src/assets/admin.js binds to it through globalThis.
/** @type {any} */ (globalThis).askConfirm = askConfirm;
// #confirm-shared-end
