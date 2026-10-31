/**
 * Browser proof for audio-feed-tyu77: the tooltip promotes to the top layer above a
 * modal dialog on the REAL player page.
 *
 * The bug: #shareCopyBtn sits INSIDE the modal <dialog id="shareDialog">, and #appTooltip
 * was a body-level position:fixed div at z-index 1000. A modal dialog is in the top layer
 * and no z-index crosses that boundary, so hovering the Copy button showed a tooltip that
 * was painted UNDER the dialog - invisible. The fix is popover="manual" + showPopover():
 * the tooltip enters the top layer after the dialog and paints above it.
 *
 * Drives real headless Chrome over raw CDP against scripts/listen-harness.ts and asserts:
 *   1. Clicking an episode's share button opens #shareDialog modally (navigator.share is
 *      stubbed out so the in-page dialog path is the one under test).
 *   2. pointerover on #shareCopyBtn (inside the modal) puts #appTooltip in the top layer
 *      (:popover-open) with the visible class and the button's tooltip text.
 *   3. The tooltip is anchor-positioned to the Copy button: same left edge, top edge at
 *      button bottom + 8px margin - and it is painted (computed display is not none).
 *   4. Saves a screenshot of the open dialog WITH the visible tooltip above it to
 *      docs/evidence/audio-feed-tyu77/ - the paint-order evidence elementFromPoint cannot
 *      give (a modal dialog confines hit-testing to its own subtree by platform rule).
 *
 *   deno run --allow-all --unstable-kv scripts/tooltip-top-layer-browser-proof.ts
 *
 * Not part of the gate (it launches Chrome); the gate-level regression coverage is the
 * headless modal-dialog test in tests/anchor_positioning_test.ts.
 */

import {
  killChromeAndWait,
  runProof,
  spawnHarness,
  withChrome,
  writeEvidenceReadme,
} from "./proof-helper.ts";
import { connectCdp } from "./proof-cdp.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";

/**
 * Wait bound for every `until` in this proof, DERIVED rather than left at the 8s default
 * (same class of fix as fleet/anchor-wait's fade row, audio-feed-ev6wj).
 *
 * What the three waits actually wait for, and how long that can legitimately take:
 * - `document.readyState === "complete"`: the harness-served player page finishing its HTML
 *   parse plus the listen.js module load, all on localhost - tens of ms nominal.
 * - episode rows rendered: boot()'s async prefix (a CacheStorage open + key scan, no
 *   network) before a synchronous render() of the server-seeded episodes - a few ms.
 * - share dialog open: the click handler reaches showModal() SYNCHRONOUSLY once
 *   navigator.share is stubbed out (this proof stubs it), so ~0ms once the click task runs.
 * The page was never what could take 8s; nominal page work is tens of milliseconds in total.
 *
 * What CAN take 8s is the poll itself: `until` evaluates over a CDP round-trip, and on a
 * loaded host the navigation, the first evaluate and every later poll queue behind other
 * work. This repo has MEASURED that stretch: under eight-way CPU saturation a bare
 * `document.readyState === "complete"` poll legitimately exceeded 8s (audio-feed-6gst1),
 * which is why verify_main_l7m1_e2e.ts's copy of `until` runs with 120s.
 *
 * 120s = 15x that measured starved-poll floor, and >1000x this page's tens-of-ms timeline.
 * It is a HANG bound, not a latency bound: a page that never opens the dialog still fails,
 * in two minutes instead of eight seconds.
 */
const MEASURED_STARVED_POLL_MS = 8_000;
const LOAD_AND_RENDER_WAIT_MS = 15 * MEASURED_STARVED_POLL_MS;

const OUT = new URL("../docs/evidence/audio-feed-tyu77/", import.meta.url).pathname;

await Deno.mkdir(OUT, { recursive: true });

await runProof("audio-feed-tyu77", async (checker) => {
  const harness = await spawnHarness("scripts/listen-harness.ts");
  const BASE = harness.base;
  const TOKEN = "harness-token";
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail = "") => {
    checks.push({ name, pass, detail });
    checker.check(name, pass, detail);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  try {
    await withChrome(async (chrome) => {
      const { cdp, js, until, ws } = await connectCdp(chrome.port);

      try {
        await cdp("Page.enable");
        await cdp("Runtime.enable");
        await cdp("Log.enable");

        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
        await until(
          `document.readyState === "complete"`,
          "load player page",
          LOAD_AND_RENDER_WAIT_MS,
        );
        await until(
          `document.querySelectorAll("#episodes .episode").length > 0`,
          "episode rows rendered",
          LOAD_AND_RENDER_WAIT_MS,
        );

        // Force the in-page dialog path: the share button prefers navigator.share when
        // the platform offers it, and the dialog fallback is the path under test.
        await js(
          `Object.defineProperty(navigator, "share", { value: undefined, configurable: true })`,
        );
        await js(
          `document.querySelector("#episodes .episode button[data-action='share']")?.click()`,
        );
        await until(
          `document.getElementById("shareDialog")?.open === true`,
          "share dialog open",
          LOAD_AND_RENDER_WAIT_MS,
        );
        check(
          "clicking an episode's share button opens #shareDialog modally",
          await js(
            `document.getElementById("shareDialog")?.matches(":modal")`,
          ) === true,
          "",
        );

        // Hover the Copy button INSIDE the modal dialog.
        await js(
          `document.getElementById("shareCopyBtn").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))`,
        );
        await sleep(300); // let the opacity fade reach the painted end state

        const state = await js(`
          (() => {
            const btn = document.getElementById("shareCopyBtn");
            const tip = document.getElementById("appTooltip");
            const b = btn.getBoundingClientRect();
            const t = tip.getBoundingClientRect();
            return {
              popoverOpen: tip.matches(":popover-open"),
              visible: tip.classList.contains("visible"),
              text: tip.textContent,
              describedby: btn.getAttribute("aria-describedby"),
              displayed: getComputedStyle(tip).display !== "none",
              anchoredX: Math.round(t.left) === Math.round(b.left),
              anchoredY: Math.round(t.top) === Math.round(b.bottom + 8),
              tipTop: Math.round(t.top),
              expectedTop: Math.round(b.bottom + 8),
            };
          })()
        `) as Record<string, unknown>;

        check(
          "tooltip is in the top layer (:popover-open) while the modal dialog is open",
          state.popoverOpen === true,
          JSON.stringify(state),
        );
        check(
          "tooltip carries the Copy button's text, the visible class, and aria-describedby wiring",
          state.visible === true && state.text === "Copy link to clipboard" &&
            state.describedby === "appTooltip",
          `text=${state.text} describedby=${state.describedby}`,
        );
        check(
          "tooltip is displayed and anchor-positioned to the button inside the dialog",
          state.displayed === true && state.anchoredX === true && state.anchoredY === true,
          `top=${state.tipTop} expected=${state.expectedTop}`,
        );

        const shot = await cdp("Page.captureScreenshot", { format: "png" });
        const raw = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
        await Deno.writeFile(`${OUT}share-dialog-tooltip-top-layer-1280x900.png`, raw);
        await quantiseEvidencePng(`${OUT}share-dialog-tooltip-top-layer-1280x900.png`);
        console.log(`Saved screenshot to ${OUT}share-dialog-tooltip-top-layer-1280x900.png`);

        await writeEvidenceReadme({
          dir: OUT,
          title: "Browser Acceptance Proof: audio-feed-tyu77",
          script: "scripts/tooltip-top-layer-browser-proof.ts",
          asserts: checks.map((c) => c.name),
          sections: [
            {
              heading: "Problem & Solution",
              body:
                '#shareCopyBtn lives INSIDE the modal <dialog id="shareDialog">, and #appTooltip was a body-level position:fixed div at z-index 1000. A modal dialog is in the top layer and no z-index crosses that boundary, so the Copy button\'s tooltip was painted under the dialog and invisible. The fix: #appTooltip is now popover="manual"; showPopover() puts it in the top layer after the dialog, so it paints above. The popover UA defaults (inset:0, margin:auto) are neutralised in .tooltip so the anchor rules keep sole control of placement, and @starting-style keeps the opacity fade across the display:none boundary.',
            },
            {
              heading: "What this does NOT prove",
              body:
                "Paint order cannot be asserted by elementFromPoint: a modal dialog confines hit-testing to its own subtree by platform rule (measured: elementsFromPoint over an open body-level popover above a modal returns [dialog, HTML]). The screenshot below is the paint-order evidence; the gate-level regression coverage is the headless modal-dialog test in tests/anchor_positioning_test.ts.",
            },
            {
              heading: "Execution Log",
              body: `\`\`\`\n${
                checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")
              }\n\`\`\``,
            },
            {
              heading: "Evidence Artifacts",
              body:
                "- share-dialog-tooltip-top-layer-1280x900.png: the open share dialog on the real player page with the Copy button's tooltip visible ABOVE the dialog surface.",
            },
          ],
        });
        console.log(`Saved report to ${OUT}README.md`);
      } finally {
        try {
          ws.close();
        } catch { /* ignore */ }
      }
    });
  } finally {
    await killChromeAndWait(harness.process);
  }
});
