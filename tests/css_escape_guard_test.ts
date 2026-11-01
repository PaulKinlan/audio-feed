/**
 * The inert-at-rule typo class, guarded at the source (audio-feed-h7rhb).
 *
 * THE DEFECT: listen.css carried `\u0040media` twice — a JS-style unicode escape that CSS does not
 * have (CSS escapes are `\` + 1-6 hex digits, so `\u0040` parses as garbage) — and a CSS parser
 * drops an invalid at-rule PRELUDE along with its whole block, silently. No error anywhere: the
 * narrow layout and the reduced-motion clamp just stopped applying, and the page looked fine in a
 * wide desktop viewport, which is where everyone looks first. lvyit fixed one instance of the same
 * class; this file had two more. The static scan below makes the CLASS a gate failure instead of a
 * someone-noticed-it-later bug, and the browser row proves the narrow block genuinely applies now.
 */

import { assert } from "@std/assert";
import { HANG_BOUND_MS } from "../scripts/proof-cdp.ts";
import { type ChromeHandle, launchChrome } from "../scripts/proof-helper.ts";

const ASSETS = new URL("../src/assets/", import.meta.url);
const LISTEN_CSS = new URL("../src/assets/listen.css", import.meta.url);

Deno.test("audio-feed-h7rhb: no CSS asset carries a JS-style \\u escape — at-rules cannot be spelled that way", async () => {
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(ASSETS)) {
    if (!entry.name.endsWith(".css")) continue;
    // readDir + a computed name stays a DYNAMIC read (no hint, no relation) - deliberately: a
    // literal two-arg URL whose last segment is the bare file name ("listen.css") leaves an
    // authored hint the report cannot resolve, and one unresolved hint disables the inert class
    // for EVERY change (the lm4d guard - this exact mistake reded the first gate run).
    const text = await Deno.readTextFile(new URL(entry.name, ASSETS));
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      // CSS has no `\uXXXX` escape: `\` + hex digits only. Any `\u` spelling is inert-at-rule
      // garbage (or worse, a mangled selector), so the whole construct it sits in is dropped.
      if (/\\u[0-9a-fA-F]{2,6}/.test(line)) {
        offenders.push(`${entry.name}:${i + 1}`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `CSS does not have \\u escapes - these lines are silently dropped by the parser, spell them as ` +
      `literal characters or \\+hex: ${offenders.join(", ")}`,
  );
});

Deno.test("audio-feed-h7rhb: the narrow listen layout genuinely applies - the computed grid changes under 30rem in a real browser", async () => {
  // The static scan pins the spelling; this row pins the BEHAVIOUR the typo killed: the
  // max-width: 30rem block narrows li.episode to two tracks. Computed styles, real parser,
  // real viewport - the same evidence a phone would produce.
  const css = await Deno.readTextFile(LISTEN_CSS);
  const page = `<!doctype html><html><head><style>${css}</style></head><body><ul>` +
    `<li class="episode"><span>t</span><span>m</span><span>a</span></li></ul></body></html>`;
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const { root, restore } = await scratchRootForProfiles();
  // Launch through the shared launcher instead of hand-rolling Deno.Command + a fixed 50x100ms
  // port-file wait: that bare count reddened a HEALTHY launch on the loaded gate host (union
  // gate at loadavg 5-10, 74 minutes in, while the same tree passed this row in 32s in
  // isolation) - a fixed window under load is a coin flip, and a red at the END of a long gate
  // is the least trustworthy kind. launchChrome polls DevToolsActivePort event-by-event and
  // separates the two owners a boot failure can have: "exited prematurely with code N" means
  // the browser NEVER STARTED (launch flags/binary defect), while "Timed out after <waited>ms
  // waiting for DevToolsActivePort" reports the WAIT and means it STARTED SLOWLY (host
  // starvation) - different owners, no more bare timeout. The bound is the fleet-wide
  // derivation, not a widened constant: HANG_BOUND_MS = 15 x the 8s measured starved-poll
  // floor (scripts/proof-cdp.ts, audio-feed-6gst1), the same derivation the until()/js()
  // sweeps applied; nothing here asserts launch latency, so the figure is a ceiling only.
  let chrome: ChromeHandle | undefined;
  try {
    chrome = await launchChrome({
      prefix: "audiofeed-h7rhb-",
      profileRoot: root,
      portTimeoutMs: HANG_BOUND_MS,
    });
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`))
      .json() as Array<{
        type: string;
        webSocketDebuggerUrl: string;
      }>;
    const pageWs = targets.find((t) => t.type === "page");
    assert(pageWs, "a page target must exist");
    const ws = new WebSocket(pageWs.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let nextId = 0;
    // deno-lint-ignore no-explicit-any
    const pending = new Map<number, (v: any) => void>();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse((e as MessageEvent).data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });
    const cdp = (method: string, params: Record<string, unknown> = {}) => {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      // deno-lint-ignore no-explicit-any
      return new Promise<any>((resolve) => pending.set(id, resolve));
    };
    await cdp("Page.enable");
    const gridAt = async (width: number): Promise<string> => {
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp("Page.navigate", { url: dataUrl });
      // The navigation replaces the execution context; poll until the document is live and the
      // style is readable (bounded - then the assertion reds on the empty read). NOTE:
      // getComputedStyle returns USED pixel tracks ("7.1px 352.9px"), not the minmax() spelling.
      //
      // The bound is the fleet-wide HANG_BOUND_MS, not a fixed 20x100ms count (audio-feed
      // boot-bound sweep, same family as the css_escape_guard boot wait in 2b4e8bab). This is a
      // NAVIGATION SETTLE rather than a browser boot, so it takes the page-side bound instead of
      // the boot waiver: it polls an observation the page produces (readyState complete plus a
      // readable used-value grid), so the figure is a ceiling that never delays, and the
      // assertion below still owns the verdict on "". A 2s ceiling assumed navigate -> parse ->
      // first layout always completes in ~2s; this host has MEASURED a bare readyState evaluate
      // legitimately exceeding the 8s starved-poll floor (scripts/proof-cdp.ts, and the same
      // observation in anchor_positioning_test.ts), which is why until()/js() bound a page-side
      // observation at 15 x that floor. The 100ms poll interval is unchanged - it is the
      // CEILING that was an assumption, not the cadence.
      const navDeadline = Date.now() + HANG_BOUND_MS;
      while (Date.now() < navDeadline) {
        await sleep(100);
        const res = await cdp("Runtime.evaluate", {
          expression: `document.readyState === "complete" && document.querySelector("li.episode")
              ? getComputedStyle(document.querySelector("li.episode")).gridTemplateColumns
              : ""`,
          returnByValue: true,
        });
        const value = String(res.result?.result?.value ?? res.result?.value ?? "").trim();
        if (value) return value;
      }
      return "";
    };
    const narrow = await gridAt(400);
    const wide = await gridAt(720);
    // Used-value tracks: two at phone width (the repaired narrow block), three at desktop width
    // (the base rule). If the narrow rule goes inert again, narrow is the three-track value.
    assert(
      narrow.trim().split(/\s+/).length === 2,
      `the narrow grid must resolve to two tracks at 400px, got "${narrow}" - ` +
        `three tracks means the max-width: 30rem rule is inert again`,
    );
    assert(
      wide.trim().split(/\s+/).length === 3,
      `the wide grid must resolve to three tracks, got "${wide}"`,
    );
    ws.close();
  } finally {
    await chrome?.close();
    await restore();
  }
});

/** Copied from tests/sticky_scroll_state_test.ts (audio-feed-w5f1): the HOME must be outside what
 * the profile cleanup deletes, so the sandbox outlives the profile. */
async function scratchRootForProfiles(): Promise<{ root: string; restore: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "h7rhb-scratch-" });
  return {
    root,
    restore: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}
