/**
 * audio-feed-3xq part 4c — the shell's tooltip client as a real file instead of a template
 * string in src/routes/shell.ts. shell.ts imports this file as text and ships it inline in the
 * classic <script> every shell page carries (login and account are classic-script pages; the
 * module pages get the shell script the same way), so: plain script, no import/export, no
 * TypeScript syntax, no build step. `// @ts-check` plus the DOM reference is what makes these
 * ~110 lines of event and geometry code visible to the gate.
 *
 * Keep in sync with the standalone player copy in src/assets/listen.js.
 * WCAG 2.1 1.4.13:
 * - Dismissible: Escape key immediately dismisses tooltip
 * - Hoverable: Pointer hover over tooltip content keeps it visible (.tooltip.visible { pointer-events: auto })
 * - Persistent: Stays visible until pointer/focus moves away or Escape pressed
 * - Screen readers: Dynamically sets aria-describedby="appTooltip" on active target
 */
// deno-lint-ignore-file no-window
// @ts-check
/// <reference lib="dom" />

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  const tooltipEl = document.getElementById("appTooltip");
  if (tooltipEl) {
    const supportsAnchorPositioning = typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("anchor-name", "--a");
    /** @type {HTMLElement | null} */
    let currentTooltipTarget = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let hideTimer = null;

    /**
     * @param {HTMLElement} target
     * @param {string} text
     */
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

    /** @param {boolean} [immediate] */
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
      const target = event.target instanceof Element
        ? event.target.closest("[data-tooltip]")
        : null;
      if (target && target instanceof HTMLElement) {
        const text = target.getAttribute("data-tooltip");
        if (text) showTooltip(target, text);
      }
    });

    document.addEventListener("pointerout", (event) => {
      const target = event.target instanceof Element
        ? event.target.closest("[data-tooltip]")
        : null;
      if (target) hideTooltip(false);
    });

    document.addEventListener("focusin", (event) => {
      const target = event.target instanceof Element
        ? event.target.closest("[data-tooltip]")
        : null;
      if (target && target instanceof HTMLElement) {
        const text = target.getAttribute("data-tooltip");
        if (text) showTooltip(target, text);
      }
    });

    document.addEventListener("focusout", (event) => {
      const target = event.target instanceof Element
        ? event.target.closest("[data-tooltip]")
        : null;
      if (target) hideTooltip(true);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && currentTooltipTarget) {
        hideTooltip(true);
      }
    });
  }
}
