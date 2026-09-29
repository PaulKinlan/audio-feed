/**
 * Browser proof for player source and text filtering (audio-feed-3h1).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts scripts/listen-harness.ts on port 8138.
 *   2. Desktop (1280x900):
 *      - Verifies initial 5 episodes and "5 episodes" count.
 *      - Filters by source ("The Verge") -> asserts 2 rows and "2 of 5 episodes".
 *      - Filters by text ("Marco") -> asserts 1 row and "1 of 5 episodes".
 *      - Filters by non-matching query -> asserts honest #filterEmpty ("No episodes match..."), #empty hidden.
 *      - Clicks #clearFilterBtn -> asserts 5 rows and "5 episodes" restored.
 *      - Persists filter across reload -> asserts filter restored on reload.
 *      - Asserts per-token isolation (different token has no saved filter).
 *      - Extracts a11y tree for filter controls.
 *   3. Mobile (390x844):
 *      - Verifies zero horizontal overflow (scrollWidth <= clientWidth).
 *   4. Screenshots saved to docs/evidence/audio-feed-3h1/.
 *
 *   deno run --allow-all --unstable-kv scripts/listen-filter-browser-proof.ts
 */

import {
  createTempChromeProfile,
  newestChrome,
  spawnHarness,
} from "./proof-helper.ts";

const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-listen-filter-");
const harness = await spawnHarness("scripts/listen-harness.ts");
const BASE = harness.base;
const TOKEN = "harness-token";
const OUT = new URL("../docs/evidence/audio-feed-3h1/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -- launch chrome ------------------------------------------------------------
await Deno.mkdir(OUT, { recursive: true });

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

let port = "";
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  port = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split("\n")[0]!;
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t: { type: string }) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let nextId = 0;
const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});

// deno-lint-ignore no-explicit-any
async function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  const msg = await new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r));
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

// deno-lint-ignore no-explicit-any
async function js(expression: string): Promise<any> {
  const r = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value;
}

function check(name: string, pass: boolean, detail = "") {
  const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}  ${detail}`);
  if (!pass) throw new Error(`step failed: ${name}`);
}

async function until(expr: string, desc: string, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(expr)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}

let exitCode = 0;
try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Accessibility.enable");

  // 1. Desktop test
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
  await until(`document.querySelectorAll("#episodes .episode").length === 5`, "page load 5 rows");

  check(
    "initial load shows 5 rows and '5 episodes'",
    (await js(`document.getElementById("episodeCount")?.textContent`)) === "5 episodes",
    "5 episodes uninhibited",
  );

  // 2. Filter by source: The Verge
  await js(`(() => {
    const sel = document.getElementById("filterSource");
    sel.value = "The Verge";
    sel.dispatchEvent(new Event("change"));
  })()`);
  await until(`document.querySelectorAll("#episodes .episode").length === 2`, "filtered to 2 Verge rows");

  const vergeCount = await js(`document.getElementById("episodeCount")?.textContent`);
  check(
    "source filter updates count to '2 of 5 episodes'",
    vergeCount === "2 of 5 episodes",
    `count text: '${vergeCount}'`,
  );

  const sources = await js(`
    [...document.querySelectorAll("#episodes .episode .ep-source")].map(el => el.textContent)
  `);
  check(
    "visible rows belong exclusively to 'The Verge'",
    sources.every((s: string) => s === "The Verge") && sources.length === 2,
    JSON.stringify(sources),
  );

  // 3. Text filter: "Marco"
  await js(`(() => {
    const inp = document.getElementById("filterText");
    inp.value = "Marco";
    inp.dispatchEvent(new Event("input"));
  })()`);
  await until(`document.querySelectorAll("#episodes .episode").length === 1`, "filtered to 1 Marco row");

  const marcoCount = await js(`document.getElementById("episodeCount")?.textContent`);
  check(
    "text filter updates count to '1 of 5 episodes'",
    marcoCount === "1 of 5 episodes",
    `count text: '${marcoCount}'`,
  );

  // 4. Non-matching query: honest empty state
  await js(`(() => {
    const inp = document.getElementById("filterText");
    inp.value = "NonExistentTerm";
    inp.dispatchEvent(new Event("input"));
  })()`);
  await until(`!document.getElementById("filterEmpty")?.classList.contains("hidden")`, "filterEmpty shown");

  const filterEmptyMsg = await js(`document.getElementById("filterEmptyMessage")?.textContent`);
  check(
    "empty state names the active filters honestly",
    typeof filterEmptyMsg === "string" && filterEmptyMsg.includes("NonExistentTerm") && filterEmptyMsg.includes("The Verge"),
    `message: '${filterEmptyMsg}'`,
  );

  const genericEmptyHidden = await js(`document.getElementById("empty")?.classList.contains("hidden")`);
  check(
    "generic 'No episodes yet' empty state is hidden while filter is active",
    genericEmptyHidden === true,
    "generic empty remains hidden",
  );

  // 5. Clear filter button resets view
  await js(`document.getElementById("clearFilterBtn")?.click()`);
  await until(`document.querySelectorAll("#episodes .episode").length === 5`, "reset to 5 rows");

  const resetCount = await js(`document.getElementById("episodeCount")?.textContent`);
  check(
    "clearing filters restores '5 episodes'",
    resetCount === "5 episodes",
    `count text: '${resetCount}'`,
  );

  // 6. Persistence across reload
  await js(`(() => {
    const sel = document.getElementById("filterSource");
    sel.value = "Stratechery";
    sel.dispatchEvent(new Event("change"));
  })()`);
  await until(`document.querySelectorAll("#episodes .episode").length === 3`, "filtered to 3 Stratechery rows");

  // Reload page
  await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
  await until(`document.querySelectorAll("#episodes .episode").length === 3`, "reload restores 3 rows");

  const reloadedSource = await js(`document.getElementById("filterSource")?.value`);
  const reloadedCount = await js(`document.getElementById("episodeCount")?.textContent`);
  check(
    "filters survive reload on the same token",
    reloadedSource === "Stratechery" && reloadedCount === "3 of 5 episodes",
    `source: '${reloadedSource}', count: '${reloadedCount}'`,
  );

  // 7. Per-token isolation
  const savedFilter = await js(`localStorage.getItem("audio-feed-filter:${TOKEN}")`);
  const otherTokenFilter = await js(`localStorage.getItem("audio-feed-filter:other-token")`);
  check(
    "filter state is scoped per-token",
    savedFilter !== null && otherTokenFilter === null,
    `saved: ${savedFilter}, other: ${otherTokenFilter}`,
  );

  // 8. Capture desktop screenshot & dump a11y tree
  const shotDesktop = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}01-listen-filter-desktop.png`,
    Uint8Array.from(atob(shotDesktop.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-listen-filter-desktop.png`);

  const axNodes = await cdp("Accessibility.getFullAXTree");
  const searchSection = axNodes.nodes?.find((n: { role?: { value: string } }) => n.role?.value === "search");
  check(
    "a11y tree includes search role landmark",
    Boolean(searchSection),
    `found search landmark in AX tree: id=${searchSection?.nodeId}`,
  );

  // 9. Mobile test (390x844)
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });

  await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
  await until(`document.querySelectorAll("#episodes .episode").length === 3`, "mobile load");

  const overflow = await js(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
  check("mobile layout has zero horizontal overflow at 390px", overflow === false, "no horizontal scroll");

  const shotMobile = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}02-listen-filter-mobile-390.png`,
    Uint8Array.from(atob(shotMobile.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}02-listen-filter-mobile-390.png`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  harness.kill();
  await cleanup();
}

Deno.exit(exitCode);
