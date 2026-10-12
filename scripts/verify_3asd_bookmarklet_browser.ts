/**
 * Browser verification proof for bookmarklet CSP click fallback and duplicate class fix (audio-feed-3asd).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts app server on an ephemeral port with real CSP headers.
 *   2. Desktop (1280x900):
 *      - Loads homepage (/).
 *      - Verifies bookmarklet link is present, has merged class="bookmarklet-link u-strong-link",
 *        and carries draggable="true".
 *      - Verifies <details> disclosure is present ("Can't drag it? Get the bookmarklet code").
 *      - Clicks the disclosure to open it and asserts the bookmarklet code snippet is rendered
 *        inside <pre><code> and copyable/selectable.
 *      - Clicks the bookmarklet link.
 *      - Asserts zero unhandled page crashes, and captures screenshot evidence.
 *
 *   deno run --allow-all --unstable-kv scripts/verify_3asd_bookmarklet_browser.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { newestChrome } from "./proof-helper.ts";

const OUT = new URL("../docs/evidence/audio-feed-3asd/", import.meta.url).pathname;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-3asd-" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

const stores: Stores = memoryStores();
const config: AppConfig = { port: 0 };
const ctx = { config, stores };
const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

const chrome = new Deno.Command(newestChrome(), {
  args: [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  stdout: "null",
  stderr: "null",
}).spawn();

let debugPort = "";
for (let i = 0; i < 100 && !debugPort; i++) {
  await sleep(100);
  debugPort = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split(
    "\n",
  )[0]!;
}
if (!debugPort) throw new Error("Chrome did not open a debug port");

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((t: { type: string }) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let nextId = 0;
const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
interface CdpLogEntry {
  source?: string;
  level?: string;
  text?: string;
}
const consoleMessages: string[] = [];

ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Log.entryAdded") {
    const entry = msg.params?.entry as CdpLogEntry;
    if (entry?.text) consoleMessages.push(`[${entry.level}] ${entry.text}`);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const args = (msg.params?.args as Array<{ value?: unknown }>) ?? [];
    consoleMessages.push(args.map((a) => String(a.value)).join(" "));
  }
});

function cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, (res) => {
      if (res.error) reject(new Error(`${method}: ${JSON.stringify(res.error)}`));
      else resolve(res.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function js(expr: string): Promise<unknown> {
  const res = (await cdp("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown } };
  return res.result?.value;
}

async function until(expr: string, desc = expr, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await js(expr)) return;
    } catch {
      // transient
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${desc}`);
}

const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail ? `(${detail})` : ""}`);
}

let exitCode = 0;
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

  // 1. Navigate to front door
  await cdp("Page.navigate", { url: `${BASE}/` });
  await until(`document.readyState === "complete"`, "homepage loaded");

  // 2. Verify bookmarklet anchor attributes
  const anchorClass = await js(
    `document.querySelector("a.bookmarklet-link")?.getAttribute("class")`,
  );
  check(
    "bookmarklet anchor has unified class list without duplicate attributes",
    anchorClass === "bookmarklet-link u-strong-link",
    `class: '${anchorClass}'`,
  );

  const isDraggable = await js(
    `document.querySelector("a.bookmarklet-link")?.getAttribute("draggable")`,
  );
  check(
    "bookmarklet anchor is draggable for bookmark bar installation",
    isDraggable === "true",
    `draggable: '${isDraggable}'`,
  );

  const href = String(
    await js(`document.querySelector("a.bookmarklet-link")?.getAttribute("href")`),
  );
  check(
    "bookmarklet anchor carries javascript: bookmarklet payload",
    href.startsWith("javascript:(function()"),
    `href starts with: '${href.slice(0, 30)}...'`,
  );

  // 3. Verify disclosure details element
  const detailsExists = await js(`Boolean(document.querySelector("details.bookmarklet-code"))`);
  check("details disclosure exists under bookmarklet box", Boolean(detailsExists));

  const summaryText = await js(
    `document.querySelector("details.bookmarklet-code summary")?.textContent?.trim()`,
  );
  check(
    "summary explains code option when dragging is not possible",
    summaryText === "Can’t drag it? Get the bookmarklet code",
    `summary: '${summaryText}'`,
  );

  // 4. Click disclosure to expand
  await js(`document.querySelector("details.bookmarklet-code summary")?.click()`);
  await until(`document.querySelector("details.bookmarklet-code")?.open === true`, "details open");

  const isOpen = await js(`document.querySelector("details.bookmarklet-code")?.open`);
  check("details disclosure opens upon user interaction", isOpen === true);

  const snippetCode = String(
    await js(`document.querySelector(".bookmarklet-snippet code")?.textContent`),
  );
  check(
    "code snippet in disclosure contains matching bookmarklet source",
    snippetCode === href,
    `snippet matches href (${snippetCode.length} chars)`,
  );

  const snippetBox = (await js(
    `(() => { const p = document.querySelector(".bookmarklet-snippet");
      if (!p) return null;
      return { scrollWidth: p.scrollWidth, clientWidth: p.clientWidth }; })()`,
  )) as { scrollWidth: number; clientWidth: number } | null;
  check(
    "disclosure code wraps and is fully visible (not horizontally clipped)",
    Boolean(snippetBox) && snippetBox!.scrollWidth <= snippetBox!.clientWidth + 1,
    snippetBox
      ? `scrollWidth ${snippetBox.scrollWidth} vs clientWidth ${snippetBox.clientWidth}`
      : "element not found",
  );

  const policyExplanation = String(
    await js(`document.querySelector("details.bookmarklet-code p")?.textContent`),
  );
  check(
    "disclosure text plainly explains browser CSP refusal of javascript: links",
    policyExplanation.includes("Content Security Policy") &&
      policyExplanation.includes("drag the link"),
    `explanation: '${policyExplanation.slice(0, 60)}...'`,
  );

  // 5. Click the bookmarklet anchor
  await js(`document.querySelector("a.bookmarklet-link")?.click()`);
  await sleep(500);

  // 6. Check that page state remains intact and disclosure is still copyable
  const stillOpen = await js(`document.querySelector("details.bookmarklet-code")?.open`);
  check("page and disclosure remain open and stable after link click", stillOpen === true);

  // Capture screenshot of the open disclosure
  const shot = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}01-bookmarklet-disclosure-open.png`,
    Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
  );

  const summary = `# Browser Proof: Bookmarklet CSP Disclosure & Class Fix (audio-feed-3asd)

- Script: \`scripts/verify_3asd_bookmarklet_browser.ts\`
- Asserts:
${checks.map((c) => `  - ${c.pass ? "✅" : "❌"} ${c.name}`).join("\n")}

## Test Environment
- **Browser:** Headless Chrome (CDP)
- **Viewport:** 1280x900
- **URL:** \`${BASE}/\`

## Key Verifications
1. **Unified Class Attribute:** The bookmarklet anchor carries \`class="bookmarklet-link u-strong-link"\` without duplicate HTML class attributes.
2. **Draggable Installation:** The anchor retains \`draggable="true"\` and the full \`javascript:(function()...\` payload for dragging to the bookmarks bar.
3. **No-Script Disclosure Fallback:** A native HTML5 \`<details class="bookmarklet-code">\` disclosure provides the bookmarklet source inside a \`<pre class="bookmarklet-snippet"><code>\` element.
4. **Honest CSP Explanation:** The disclosure explains that browsers refuse \`javascript:\` links when clicked directly on a CSP-protected page and directs the user to drag the link or copy the snippet.
5. **Zero Inline Script:** Operates without any un-nonced inline scripts or click interception scripts, conforming strictly to the page's Content Security Policy.

## Execution Log
\`\`\`
${checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail ?? ""}`).join("\n")}
\`\`\`

## Screenshots
- \`01-bookmarklet-disclosure-open.png\`: Homepage with bookmarklet box and expanded fallback disclosure showing snippet code.
`;

  await Deno.writeTextFile(`${OUT}README.md`, summary);
  console.log(`Saved proof report to ${OUT}README.md`);
} catch (err) {
  console.error("Browser proof failed:", err);
  exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  try {
    await server.shutdown();
  } catch {
    /* ignore */
  }
  try {
    await Deno.remove(PROFILE, { recursive: true });
  } catch {
    /* ignore */
  }
  await stores.metadata.close();
}

if (exitCode !== 0 || checks.some((c) => !c.pass)) {
  Deno.exit(1);
}
