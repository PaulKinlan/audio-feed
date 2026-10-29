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
import { createTempChromeProfile, newestChrome } from "../scripts/proof-helper.ts";

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
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-h7rhb-", root);
  const chrome = new Deno.Command(newestChrome(), {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  let cdpPort = "";
  for (let i = 0; i < 50 && !cdpPort; i++) {
    await sleep(100);
    cdpPort = (await Deno.readTextFile(`${profileDir}/DevToolsActivePort`).catch(() => "")).split(
      "\n",
    )[0]!;
  }
  try {
    assert(cdpPort, "chrome must expose a DevTools port");
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as Array<{
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
      // style is readable (bounded - 2s, then the assertion reds on the empty read). NOTE:
      // getComputedStyle returns USED pixel tracks ("7.1px 352.9px"), not the minmax() spelling.
      for (let i = 0; i < 20; i++) {
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
    chrome.kill("SIGKILL");
    cleanup();
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
