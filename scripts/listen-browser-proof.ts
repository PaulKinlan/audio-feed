/**
 * Browser proof for the listen harness and episode listing (audio-feed-py5).
 *
 * Starts scripts/listen-harness.ts on port 8135, drives real headless Chrome
 * over raw CDP, and asserts:
 *   1. /listen/harness-token renders 5 episode rows in the playlist (not 0).
 *   2. #episodeCount displays "5 episodes" and #empty is hidden.
 *   3. Clicking an episode row / play button loads a real audio URL into #audio.
 *   4. The audio URL fetches 200 audio/wav bytes from the blob store.
 *   5. Saves screenshot to docs/evidence/audio-feed-py5/01-listen-harness-5-episodes.png.
 *
 *   deno run --allow-all --unstable-kv scripts/listen-browser-proof.ts
 */

import {
  createTempChromeProfile,
  newestChrome,
  spawnHarness,
} from "./proof-helper.ts";

const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-listen-");
const harness = await spawnHarness("scripts/listen-harness.ts");
const BASE = harness.base;
const TOKEN = "harness-token";
const OUT = new URL("../docs/evidence/audio-feed-py5/", import.meta.url).pathname;

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
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Verify harness printed "episodes: 5"
  const stdout = harness.getLogs().stdout;
  check(
    "listen harness output confirms 5 episodes",
    stdout.includes("episodes: 5"),
    stdout.trim(),
  );

  // Navigate to player
  await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
  await until(`document.readyState === "complete"`, "load page");
  await until(`document.querySelectorAll("#episodes .episode").length === 5`, "5 episode rows rendered");

  const rowCount = await js(`document.querySelectorAll("#episodes .episode").length`);
  check("rendered episode row count is 5", rowCount === 5, `found ${rowCount} rows`);

  const countText = await js(`document.getElementById("episodeCount")?.textContent`);
  check("header count text displays '5 episodes'", countText === "5 episodes", `got '${countText}'`);

  const emptyHidden = await js(`document.getElementById("empty")?.classList.contains("hidden")`);
  check("empty state is hidden", emptyHidden === true, `empty hidden: ${emptyHidden}`);

  // Click the first episode's play button
  await js(`document.querySelector("#episodes .episode button[data-action='play']")?.click()`);
  await until(`!!document.getElementById("audio")?.src`, "audio src loaded");

  const audioSrc = await js(`document.getElementById("audio")?.src`);
  check(
    "play button loads audio URL into #audio element",
    typeof audioSrc === "string" && audioSrc.includes("/audio/"),
    `audio src is ${audioSrc}`,
  );

  // Fetch the audio URL to verify it resolves with real wav bytes
  const audioRes = await fetch(audioSrc);
  check(
    "enclosure audio URL returns 200 audio/wav bytes",
    audioRes.status === 200 && audioRes.headers.get("content-type")?.includes("audio/wav") === true,
    `status ${audioRes.status}, content-type: ${audioRes.headers.get("content-type")}`,
  );

  // Take screenshot
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}01-listen-harness-5-episodes.png`,
    Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-listen-harness-5-episodes.png`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  harness.kill();
  await cleanup();
}

Deno.exit(exitCode);
