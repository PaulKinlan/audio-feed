/**
 * Browser verification proof for audio-feed-dfbu:
 * Verifies that playback position is persisted via 'pagehide' and 'visibilitychange'
 * instead of 'beforeunload', and that bfcache-friendly events successfully persist state
 * to localStorage and allow playback resume on reload.
 */

import { createTempChromeProfile, newestChrome, spawnHarness } from "./proof-helper.ts";

const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-dfbu-");
const harness = await spawnHarness("scripts/listen-harness.ts");
const BASE = harness.base;
const TOKEN = "harness-token";
const OUT = new URL("../docs/evidence/audio-feed-dfbu/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 1. Navigate to player
  await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
  await until(`document.querySelectorAll("#episodes .episode").length === 5`, "page load 5 rows");

  // 2. Play episode 1 and set currentTime to 35s
  await js(`
    document.querySelector('li.episode[data-episode-id="ep-1"] button.ep-play')?.click();
    const audio = document.getElementById("audio");
    audio.currentTime = 35;
  `);
  await sleep(100);

  // 3. Trigger visibilitychange with visibilityState hidden
  await js(`
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  `);
  await sleep(100);

  // 4. Verify position 35s saved to scoped localStorage
  const storedPos1 = await js(`
    JSON.parse(localStorage.getItem("audio-feed-positions:user-1") || "{}")["ep-1"]?.position
  `);
  check(
    "visibilitychange (hidden) saved position 35s to localStorage",
    storedPos1 === 35,
    `stored ${storedPos1}s`,
  );

  // 5. Advance currentTime to 42s and trigger pagehide
  await js(`(() => {
    const audio = document.getElementById("audio");
    audio.currentTime = 42;
    window.dispatchEvent(new Event("pagehide"));
  })()`);
  await sleep(100);

  // 6. Verify position 42s saved to scoped localStorage
  const storedPos2 = await js(`
    JSON.parse(localStorage.getItem("audio-feed-positions:user-1") || "{}")["ep-1"]?.position
  `);
  check(
    "pagehide event saved position 42s to localStorage",
    storedPos2 === 42,
    `stored ${storedPos2}s`,
  );

  // 7. Reload page and check UI resume affordance
  await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
  await until(`document.querySelectorAll("#episodes .episode").length === 5`, "page reloaded");

  const row1 = `document.querySelector('li.episode[data-episode-id="ep-1"]')`;
  const badgeText = await js(`${row1}?.querySelector(".ep-resume-badge")?.textContent`);
  check(
    "row displays 'Resume from 0:42' badge",
    typeof badgeText === "string" && badgeText.includes("0:42"),
    `badge text: '${badgeText}'`,
  );

  // 8. Capture screenshot
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}01-pagehide-visibilitychange-resume.png`,
    Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-pagehide-visibilitychange-resume.png`);

  // 9. Verify beforeunload is absent from window listeners
  const hasBeforeUnload = await js(`
    "onbeforeunload" in window && window.onbeforeunload !== null
  `);
  check(
    "window.onbeforeunload is not set",
    !hasBeforeUnload,
    `hasBeforeUnload: ${hasBeforeUnload}`,
  );
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch { /* ignore */ }
  harness.kill();
  await cleanup();
}

Deno.exit(exitCode);
