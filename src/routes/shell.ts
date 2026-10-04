/**
 * The shared page shell (audio-feed-8fc): design tokens, header, footer.
 *
 * Home, login, account and admin render through this so they read as one
 * product. The palette is the player's (src/routes/listen.ts): the same near-black
 * surfaces and violet accent in dark mode, and a light counterpart on the same
 * hue for people whose system asks for light. The legacy names home/admin were
 * written against (`--text-muted`, `--surface-sunken`, `--accent-text`) are
 * aliases of the new ones, so their component CSS did not need rewriting.
 *
 * The shell adds NO script. The admin console's tests execute "the page's one
 * inline script" (tests/admin_script.ts); a shell script would make that
 * ambiguous. Sign-out is therefore a plain form POST, which also means it works
 * with scripting off. Browsers send Origin on it, so it passes the CSRF wall.
 */

import type { User } from "../types.ts";
import { esc } from "./html.ts";
import { DESIGN_TOKENS } from "./tokens.ts";

/** Who the header says is signed in. `null` for a visitor. */
export interface Viewer {
  displayName: string;
  email: string;
  isAdmin: boolean;
}

export function viewerOf(user: User | null): Viewer | null {
  if (!user) return null;
  return {
    displayName: user.displayName,
    email: user.email,
    isAdmin: user.isAdmin && user.status === "approved",
  };
}

export type ShellSection = "home" | "login" | "account" | "admin" | "player";

/**
 * Speculation Rules API for instant same-origin page navigations (audio-feed-nvj).
 * Per Modern Web Guidance (improve-next-page-load-performance):
 * Uses document rules with moderate eagerness to prefetch same-origin HTML documents
 * on link hover, while strictly excluding API mutations and admin routes.
 */
export const SPECULATION_RULES = `<script type="speculationrules">
{
  "prefetch": [
    {
      "source": "document",
      "where": {
        "and": [
          { "href_matches": "/*" },
          { "not": { "href_matches": "/api/*" } },
          { "not": { "href_matches": "/admin*" } },
          { "not": { "href_matches": "/logout*" } },
          { "not": { "selector_matches": "[data-no-prefetch]" } },
          { "not": { "selector_matches": "[rel~=nofollow]" } }
        ]
      },
      "eagerness": "moderate"
    }
  ]
}
</script>`;

/** Colour, type, spacing and shape unified in src/routes/tokens.ts (audio-feed-vpw). */
export const SHELL_TOKENS = DESIGN_TOKENS;

/** Header, footer and the components the account and login pages share. */
export const SHELL_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html { scrollbar-color: var(--surface-3) var(--bg); }
  ::selection { background: var(--accent); color: var(--accent-ink); }
  body.shell {
    margin: 0;
    min-inline-size: 0;
    min-block-size: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: clamp(1rem, 0.96rem + 0.2vw, 1.0625rem);
    line-height: 1.6;
    -webkit-text-size-adjust: 100%;
  }
  .shell :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .skip {
    position: absolute; inset-inline-start: 0.75rem; inset-block-start: -3rem;
    background: var(--accent); color: var(--accent-ink); padding: 0.5rem 0.9rem;
    border-radius: var(--radius-sm); z-index: 10; text-decoration: none; font-weight: 600;
  }
  .skip:focus { inset-block-start: 0.75rem; }

  .site-header {
    border-block-end: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: saturate(1.4) blur(10px);
    position: sticky; inset-block-start: 0; z-index: 5;
    view-transition-name: app-header;
  }
  .site-header .bar {
    max-inline-size: var(--page); margin-inline: auto;
    padding: 0.7rem 1rem;
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1.25rem;
  }
  .brand {
    display: inline-flex; align-items: center; gap: 0.55rem;
    color: var(--text); text-decoration: none; font-weight: 700; letter-spacing: -0.02em;
    margin-inline-end: auto;
    view-transition-name: app-brand;
  }
  .brand svg { inline-size: 1.6rem; block-size: 1.6rem; flex: none; }
  .site-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
  .site-nav a {
    color: var(--text-2); text-decoration: none; font-size: 0.93rem;
    padding: 0.35rem 0.65rem; border-radius: 999px;
  }
  .site-nav a:hover { color: var(--text); background: var(--surface-2); }
  .site-nav a[aria-current="page"] { color: var(--text); background: var(--surface-2); font-weight: 600; }
  .who { display: flex; align-items: center; gap: 0.6rem; font-size: 0.88rem; color: var(--muted); }
  .who .name { color: var(--text); font-weight: 600; max-inline-size: 14ch;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who form { margin: 0; }
  /* Scoped and fully reset: page CSS such as home's button[type="submit"] must not reach it. */
  .site-header .who .link-button {
    font: inherit; font-size: 0.88rem; font-weight: 500; color: var(--accent); background: none;
    border: 0; border-radius: 0; margin: 0; padding: 0.35rem 0.1rem; min-block-size: 0;
    filter: none; cursor: pointer; text-decoration: underline; text-underline-offset: 3px;
  }
  .site-header .who .sign-in {
    color: var(--accent-ink); background: var(--accent); text-decoration: none; font-weight: 650;
    font-size: 0.88rem; padding: 0.4rem 0.95rem; border-radius: 999px;
  }
  .site-header .who .sign-in:hover { background: var(--accent-2); }
  .site-main { flex: 1; inline-size: 100%; }
  .site-footer {
    border-block-start: 1px solid var(--border);
    color: var(--muted); font-size: 0.85rem;
  }
  .site-footer .bar {
    max-inline-size: var(--page); margin-inline: auto; padding: 1.25rem 1rem;
    display: flex; flex-wrap: wrap; gap: 0.4rem 1.5rem; justify-content: space-between;
  }
  .site-footer a { color: var(--text-2); }

  /* Native Accessible Modal Dialog (audio-feed-ytl) */
  dialog.confirm-dialog {
    padding: 0;
    border: 1px solid var(--border-2);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 20px 40px -15px rgb(0 0 0 / 0.7);
    max-inline-size: min(28rem, calc(100vw - 2rem));
    margin: auto;
  }
  dialog.confirm-dialog::backdrop {
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
  }
  dialog.confirm-dialog .confirm-form {
    padding: 1.5rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  dialog.confirm-dialog .confirm-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text);
  }
  dialog.confirm-dialog .confirm-message {
    margin: 0;
    font-size: 0.95rem;
    color: var(--text-2);
    line-height: 1.5;
    overflow-wrap: anywhere;
    white-space: pre-line;
  }
  dialog.confirm-dialog .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-block-start: 0.5rem;
  }

  /* audio-feed-pzwe: CSS Anchor Positioning for tooltips.
     Tethers tooltips declaratively to the anchor element with flip-block fallback,
     degrading to manual getBoundingClientRect() positioning on non-supporting engines. */
  /* TODO(baseline/anchor-positioning): drop @supports guard when anchor-positioning reaches Baseline */
  .tooltip {
    position: fixed;
    z-index: 1000;
    padding: var(--space-1) var(--space-2);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    font-size: 0.78rem;
    font-weight: 500;
    line-height: 1.2;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s var(--ease);
    white-space: nowrap;
  }

  .tooltip.visible {
    opacity: 1;
    pointer-events: auto;
  }

  @supports (anchor-name: --tooltip-anchor) {
    [data-tooltip-active] {
      anchor-name: --tooltip-anchor;
    }

    .tooltip {
      position: fixed;
      position-anchor: --tooltip-anchor;
      top: anchor(bottom);
      left: anchor(left);
      margin-block-start: 8px;
      position-try-fallbacks: flip-block;
    }
  }
`;

/**
 * Components for the login and account pages only. Home and admin keep their own
 * component CSS; loading this there would collide with their `.field`, `.actions`
 * and `.feedback` classes.
 */
export const SHELL_KIT_CSS = `
  .wrap { max-inline-size: var(--page); margin-inline: auto; padding: 2rem 1rem 3.5rem; }
  .wrap.narrow { max-inline-size: 30rem; }
  .eyebrow { font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--accent); font-weight: 700; margin: 0 0 0.35rem; }
  .wrap h1 { font-size: clamp(1.7rem, 1.3rem + 1.6vw, 2.4rem); line-height: 1.15;
    letter-spacing: -0.03em; margin: 0 0 0.5rem; text-wrap: balance; }
  .wrap h2 { font-size: 1.15rem; letter-spacing: -0.01em; margin: 0 0 0.35rem; }
  .lede { color: var(--text-2); margin: 0 0 1.75rem; max-inline-size: var(--measure); }
  .panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 1.25rem 1.25rem 1.35rem; margin-block-end: 1rem;
  }
  .panel > p:first-of-type { margin-block-start: 0; }
  .panel .sub { color: var(--muted); font-size: 0.92rem; margin: 0 0 1rem; }
  .grid { display: grid; gap: 1rem; }
  @media (min-width: 52rem) {
    .grid.two { grid-template-columns: 1fr 1fr; align-items: start; }
    .grid.two > .panel { margin-block-end: 0; }
  }
  .stack > * + * { margin-block-start: 0.85rem; }
  .field { display: grid; gap: 0.3rem; }
  .field label, .legend { font-weight: 600; font-size: 0.93rem; }
  .hint { color: var(--muted); font-size: 0.85rem; font-weight: 400; }
  .shell input[type="text"], .shell input[type="url"], .shell input[type="email"],
  .shell input[type="password"], .shell select {
    font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border-2); border-radius: var(--radius-sm);
    padding: 0.6rem 0.75rem; inline-size: 100%; min-inline-size: 0;
  }
  .shell input:user-invalid { border-color: var(--danger); }

  /* audio-feed-d6l: adopt customizable select using appearance: base-select and ::picker(select).
     Degrades gracefully on engines without base-select support to the standard OS dropdown. */
  /* TODO(baseline/customizable-select): drop the @supports guard when customizable-select reaches Baseline */
  @supports (appearance: base-select) {
    .shell select,
    .shell select::picker(select) {
      appearance: base-select;
    }

    .shell select::picker(select) {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border-2);
      border-radius: var(--radius-sm);
      padding: var(--space-1);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    }

    .shell select option {
      padding: var(--space-2) var(--space-3);
      border-radius: calc(var(--radius-sm) - 2px);
      color: var(--text);
      cursor: pointer;
    }

    .shell select option:hover,
    .shell select option:focus-visible {
      background: var(--surface-2);
    }

    .shell select option:checked {
      background: var(--accent);
      color: var(--accent-ink);
    }

    .shell select::picker-icon {
      color: var(--muted);
    }

    .shell select:open::picker-icon {
      color: var(--accent);
    }
  }


  .choices { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; }
  .choices label { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 500; }
  .shell input[type="radio"], .shell input[type="checkbox"] { accent-color: var(--accent); inline-size: 1.05rem; block-size: 1.05rem; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
    font: inherit; font-weight: 650; font-size: 0.95rem; cursor: pointer; text-decoration: none;
    color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent);
    border-radius: 999px; padding: 0.6rem 1.15rem; min-block-size: 2.75rem;
    transition: background 160ms var(--ease), transform 160ms var(--ease);
  }
  .btn:hover { background: var(--accent-2); border-color: var(--accent-2); }
  .btn:active { transform: translateY(1px); }
  .btn[disabled] { opacity: 0.55; cursor: not-allowed; }
  .btn.big { inline-size: 100%; min-block-size: 3.25rem; font-size: 1.02rem; }
  .btn.quiet { background: transparent; color: var(--text); border-color: var(--border-2); }
  .btn.quiet:hover { background: var(--surface-2); }
  .btn.danger { background: transparent; color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
  .btn.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .btn.small { min-block-size: 2.25rem; padding: 0.3rem 0.85rem; font-size: 0.86rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .feedback { min-block-size: 1.4em; margin: 0.6rem 0 0; font-size: 0.92rem; }
  .feedback[data-tone="error"] { color: var(--danger); }
  .feedback[data-tone="ok"] { color: var(--ok); }
  .badge {
    display: inline-block; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.03em;
    text-transform: uppercase; padding: 0.15rem 0.55rem; border-radius: 999px;
    background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border);
    vertical-align: middle;
  }
  .badge[data-status="approved"] { color: var(--ok); }
  .badge[data-status="pending"] { color: var(--accent); }
  .badge[data-status="suspended"], .badge[data-status="rejected"] { color: var(--danger); }
  .callout {
    border: 1px solid var(--border-2); border-inline-start: 4px solid var(--accent);
    background: var(--surface-2); border-radius: var(--radius-sm);
    padding: 0.8rem 1rem; margin: 0 0 1rem; color: var(--text-2);
  }
  .copy {
    display: flex; gap: 0.5rem; align-items: stretch; min-inline-size: 0;
  }
  .copy code {
    flex: 1; min-inline-size: 0; overflow-x: auto; white-space: nowrap;
    font-family: var(--mono); font-size: 0.82rem; color: var(--text-2);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 0.55rem 0.7rem;
  }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows > li { border-block-start: 1px solid var(--border); padding-block: 0.8rem; }
  .rows > li:first-child { border-block-start: 0; padding-block-start: 0.2rem; }
  .row-head { display: flex; flex-wrap: wrap; gap: 0.35rem 0.75rem; align-items: baseline; justify-content: space-between; }
  .row-title { font-weight: 600; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .empty { color: var(--muted); font-size: 0.92rem; margin: 0; }
  details.more > summary { cursor: pointer; color: var(--text-2); font-size: 0.92rem; }
  details.more[open] > summary { margin-block-end: 0.6rem; }

  /* CSS Subgrid list alignment (audio-feed-b6z) per Modern Web Guidance */
  @supports (grid-template-columns: subgrid) {
    .rows {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .rows > li {
      display: grid;
      grid-column: 1 / -1;
      grid-template-columns: subgrid;
      row-gap: 0.25rem;
    }
    .rows > li > .row-head {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: subgrid;
      align-items: baseline;
      gap: 0.35rem 0.75rem;
    }
    .rows > li > .row-head > :first-child {
      grid-column: 1;
      min-inline-size: 0;
    }
    .rows > li > .row-head > :nth-child(2) {
      grid-column: 2;
      justify-self: end;
    }
    .rows > li > .meta,
    .rows > li > .feed-paths,
    .rows > li > .actions,
    .rows > li > .error-detail {
      grid-column: 1 / -1;
    }

    /* <=480px: intentional collapse; trailing controls stack */
    @media (max-width: 480px) {
      .rows {
        grid-template-columns: 1fr;
      }
      .rows > li > .row-head {
        display: flex;
        flex-wrap: wrap;
      }
    }
  }
`;

/**
 * Native Accessible Modal Dialog HTML (audio-feed-ytl).
 * Follows Modern Web Guidance:
 * - Uses native <dialog> with closedby="any" for declarative light-dismiss
 * - Form with method="dialog" closes dialog and sets returnValue without custom JS
 * - autofocus on Cancel button prevents accidental confirmation
 * - aria-labelledby and aria-describedby for full screen reader accessibility
 */
export const CONFIRM_DIALOG_HTML = `
<dialog id="confirmDialog" class="confirm-dialog" closedby="any" aria-labelledby="confirmTitle" aria-describedby="confirmMessage">
  <form method="dialog" class="confirm-form">
    <h3 id="confirmTitle" class="confirm-title">Confirm Action</h3>
    <p id="confirmMessage" class="confirm-message"></p>
    <div class="confirm-actions">
      <button type="submit" value="cancel" class="btn secondary" id="confirmCancelBtn" autofocus>Cancel</button>
      <button type="submit" value="confirm" class="btn danger" id="confirmOkBtn">Confirm</button>
    </div>
  </form>
</dialog>`;

/**
 * Client-side confirmation helper using native <dialog> (audio-feed-ytl).
 * Modern Web Guidance teachable moment:
 * "I was going to write custom JavaScript event listeners to close the dialog
 * and resolve promises manually. What I didn't know was that native
 * <form method='dialog'> closes the <dialog> automatically and sets .returnValue
 * to the clicked submit button's value, which drastically simplifies state tracking.
 * Combining closedby='any' with an autofocus on the non-destructive Cancel button
 * guarantees keyboard and light-dismiss safety out of the box."
 */
export const CONFIRM_DIALOG_CLIENT = `
  const confirmDialog = document.getElementById("confirmDialog");
  if (confirmDialog && typeof HTMLDialogElement !== "undefined" && !("closedBy" in HTMLDialogElement.prototype)) {
    // TODO(baseline/dialog-closedby): remove this click shim; keep closedby="any" on the dialog.
    // Light-dismiss fallback for browsers without native closedby support (Modern Web Guidance)
    confirmDialog.addEventListener("click", (event) => {
      if (event.target !== confirmDialog) return;
      const rect = confirmDialog.getBoundingClientRect();
      const isInside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!isInside) confirmDialog.close("cancel");
    });
  }

  function askConfirm(message, options) {
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
`;

/**
 * Accessible Tooltip Container HTML (audio-feed-pzwe).
 * WCAG 2.1 1.4.13:
 * - role="tooltip" for screen readers
 * - aria-hidden="true" when idle
 * - aria-describedby binding on active trigger
 */
export const TOOLTIP_HTML =
  `<div id="appTooltip" class="tooltip" role="tooltip" aria-hidden="true"></div>`;

/**
 * Accessible Tooltip Controller using CSS Anchor Positioning with flip-block fallback (audio-feed-pzwe).
 * WCAG 2.1 1.4.13:
 * - Dismissible: Escape key immediately dismisses tooltip
 * - Hoverable: Pointer hover over tooltip content keeps it visible (.tooltip.visible { pointer-events: auto })
 * - Persistent: Stays visible until pointer/focus moves away or Escape pressed
 * - Screen readers: Dynamically sets aria-describedby="appTooltip" on active target
 */
export const TOOLTIP_CLIENT = `
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    const tooltipEl = document.getElementById("appTooltip");
    if (tooltipEl) {
      const supportsAnchorPositioning = typeof CSS !== "undefined" &&
        typeof CSS.supports === "function" &&
        CSS.supports("anchor-name", "--a");
      let currentTooltipTarget = null;
      let hideTimer = null;

      const showTooltip = (target, text) => {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        if (currentTooltipTarget && currentTooltipTarget !== target) {
          currentTooltipTarget.removeAttribute("data-tooltip-active");
          currentTooltipTarget.removeAttribute("aria-describedby");
        }
        currentTooltipTarget = target;
        target.setAttribute("data-tooltip-active", "");
        target.setAttribute("aria-describedby", "appTooltip");
        tooltipEl.textContent = text;
        tooltipEl.setAttribute("aria-hidden", "false");
        tooltipEl.classList.add("visible");

        if (!supportsAnchorPositioning) {
          // TODO(baseline/anchor-positioning): remove getBoundingClientRect fallback when anchor-positioning reaches Baseline
          const rect = target.getBoundingClientRect();
          tooltipEl.style.left = rect.left + "px";
          const tooltipHeight = tooltipEl.offsetHeight || 28;
          const margin = 8;
          const overflowBottom = (rect.bottom + margin + tooltipHeight) > window.innerHeight;
          const fitsAbove = (rect.top - margin - tooltipHeight) >= 0;
          if (overflowBottom && fitsAbove) {
            tooltipEl.style.top = (rect.top - margin - tooltipHeight) + "px";
          } else {
            tooltipEl.style.top = (rect.bottom + margin) + "px";
          }
        }
      };

      const hideTooltip = (immediate) => {
        const doHide = () => {
          if (currentTooltipTarget) {
            currentTooltipTarget.removeAttribute("data-tooltip-active");
            currentTooltipTarget.removeAttribute("aria-describedby");
            currentTooltipTarget = null;
          }
          tooltipEl.classList.remove("visible");
          tooltipEl.setAttribute("aria-hidden", "true");
          if (!supportsAnchorPositioning) {
            tooltipEl.style.left = "";
            tooltipEl.style.top = "";
          }
        };

        if (immediate) {
          if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
          }
          doHide();
        } else {
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = setTimeout(doHide, 80);
        }
      };

      tooltipEl.addEventListener("pointerenter", () => {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
      });
      tooltipEl.addEventListener("pointerleave", () => {
        hideTooltip(false);
      });

      document.addEventListener("pointerover", (event) => {
        const target = event.target && event.target.closest ? event.target.closest("[data-tooltip]") : null;
        if (target && target instanceof HTMLElement) {
          const text = target.getAttribute("data-tooltip");
          if (text) showTooltip(target, text);
        }
      });

      document.addEventListener("pointerout", (event) => {
        const target = event.target && event.target.closest ? event.target.closest("[data-tooltip]") : null;
        if (target) hideTooltip(false);
      });

      document.addEventListener("focusin", (event) => {
        const target = event.target && event.target.closest ? event.target.closest("[data-tooltip]") : null;
        if (target && target instanceof HTMLElement) {
          const text = target.getAttribute("data-tooltip");
          if (text) showTooltip(target, text);
        }
      });

      document.addEventListener("focusout", (event) => {
        const target = event.target && event.target.closest ? event.target.closest("[data-tooltip]") : null;
        if (target) hideTooltip(true);
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && currentTooltipTarget) {
          hideTooltip(true);
        }
      });
    }
  }
`;

const MARK =
  `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent)"/><g stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round"><path d="M9 13v6"/><path d="M13.5 9v14"/><path d="M18 12v8"/><path d="M22.5 14.5v3"/></g></svg>`;

export function renderHeader(viewer: Viewer | null, current?: ShellSection): string {
  const link = (href: string, label: string, section: ShellSection) =>
    `<a href="${href}"${current === section ? ` aria-current="page"` : ""}>${label}</a>`;
  const nav = [
    link("/", "Home", "home"),
    link("/listen", "Web Player", "player"),
    viewer ? link("/account", "Account", "account") : "",
    viewer?.isAdmin ? link("/admin", "Admin", "admin") : "",
  ].join("");
  const who = viewer
    ? `<div class="who"><span class="name" title="${esc(viewer.email)}" data-tooltip="${
      esc(viewer.email)
    }">${esc(viewer.displayName)}</span>
      <form method="post" action="/api/auth/logout"><button class="link-button" type="submit">Sign out</button></form></div>`
    : `<div class="who">${
      current === "login" ? "" : `<a class="sign-in" href="/login">Sign in</a>`
    }</div>`;
  return `<header class="site-header"><div class="bar">
    <a class="brand" href="/">${MARK}<span>Audio Feed</span></a>
    <nav class="site-nav" aria-label="Main">${nav}</nav>
    ${who}
  </div></header>`;
}

export function renderFooter(): string {
  return `<footer class="site-footer"><div class="bar">
    <span>Articles, read aloud or discussed, in your podcast app.</span>
    <span><a href="/health">Status</a> · <a href="https://github.com/PaulKinlan/audio-feed">Source</a></span>
  </div></footer>`;
}

export interface ShellOptions {
  title: string;
  description?: string;
  viewer: Viewer | null;
  current?: ShellSection;
  /** Page-specific CSS, appended after the shared tokens. */
  css?: string;
  /** Include SHELL_KIT_CSS (login, account). */
  kit?: boolean;
  /** Extra `<head>` markup, e.g. a robots meta. */
  head?: string;
  main: string;
  /** The page's own script, if it has one. The shell never adds another. */
  script?: string;
  /**
   * External stylesheet URLs, emitted AFTER the inline <style> on purpose. Page CSS used to be
   * appended inside that same style element, so it came last and won equal-specificity ties; a link
   * placed before it would silently reverse that cascade (audio-feed-3xq part 3).
   */
  stylesheets?: string[];
}

export function renderShell(o: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description)}">` : ""}
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/icon.svg">
${o.current !== "admin" ? SPECULATION_RULES : ""}${o.head ?? ""}
<style>${SHELL_TOKENS}${SHELL_CSS}${o.kit ? SHELL_KIT_CSS : ""}${o.css ?? ""}</style>
${(o.stylesheets ?? []).map((href) => `<link rel="stylesheet" href="${href}">`).join("\n")}
</head>
<body class="shell">
<a class="skip" href="#main">Skip to content</a>
${renderHeader(o.viewer, o.current)}
<main id="main" class="site-main">
${o.main}
</main>
${renderFooter()}
${CONFIRM_DIALOG_HTML}
${TOOLTIP_HTML}
${
    o.script
      ? `<script>\n${TOOLTIP_CLIENT}\n${o.script}\n</script>`
      : `<script>\n${TOOLTIP_CLIENT}\n</script>`
  }
</body>
</html>
`;
}

/**
 * Client helpers for the WebAuthn ceremonies, shared by the login and account
 * scripts. Native `navigator.credentials` with JSON options; where the static
 * JSON parsers are missing, a small base64url fallback does the same job.
 */
export const PASSKEY_CLIENT = `
  const b64u = {
    decode(s) {
      const b = s.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
    },
    encode(buf) {
      let bin = "";
      for (const byte of new Uint8Array(buf)) bin += String.fromCharCode(byte);
      return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    },
  };
  const passkeysSupported = typeof window.PublicKeyCredential === "function" &&
    !!navigator.credentials;
  function creationOptions(json) {
    if (PublicKeyCredential.parseCreationOptionsFromJSON) {
      return PublicKeyCredential.parseCreationOptionsFromJSON(json);
    }
    return {
      ...json,
      challenge: b64u.decode(json.challenge),
      user: { ...json.user, id: b64u.decode(json.user.id) },
      excludeCredentials: (json.excludeCredentials || []).map((c) => ({ ...c, id: b64u.decode(c.id) })),
    };
  }
  function requestOptions(json) {
    if (PublicKeyCredential.parseRequestOptionsFromJSON) {
      return PublicKeyCredential.parseRequestOptionsFromJSON(json);
    }
    return {
      ...json,
      challenge: b64u.decode(json.challenge),
      allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: b64u.decode(c.id) })),
    };
  }
  function credentialJSON(cred) {
    if (typeof cred.toJSON === "function") return cred.toJSON();
    const r = cred.response;
    const response = { clientDataJSON: b64u.encode(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = b64u.encode(r.attestationObject);
      response.transports = r.getTransports ? r.getTransports() : [];
    } else {
      response.authenticatorData = b64u.encode(r.authenticatorData);
      response.signature = b64u.encode(r.signature);
      if (r.userHandle) response.userHandle = b64u.encode(r.userHandle);
    }
    return {
      id: cred.id, rawId: b64u.encode(cred.rawId), type: cred.type,
      response, clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
    };
  }
  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("Request failed (" + res.status + ")"));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  function ceremonyError(error) {
    if (error && error.name === "NotAllowedError") return "The passkey prompt was closed. Try again when you're ready.";
    if (error && error.name === "InvalidStateError") return "This device already has a passkey for your account.";
    return String((error && error.message) || error);
  }
`;
