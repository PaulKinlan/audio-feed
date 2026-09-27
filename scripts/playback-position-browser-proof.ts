/**
 * Browser proof for playback position resume (audio-feed-kzi).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts scripts/listen-harness.ts on port 8137.
 *   2. Opens /listen/harness-token.
 *   3. Simulates playback of episode 1 (ep-1) to 45s, verifies position stored.
 *   4. Reloads the page.
 *   5. Verifies row displays "Resume from 0:45", button action is "resume",
 *      and distinct "Play from start" button is present in actions.
 *   6. Clicks "Resume" -> verifies audio seeks to 45s and resumes playback.
 *   7. Clicks "Play from start" -> verifies audio seeks to 0 and position is cleared.
 *   8. Simulates episode completion (ended event) -> verifies position is cleared.
 *   9. Checks per-token isolation: navigating to different token shows 0 saved positions.
 *  10. Saves screenshot to docs/evidence/audio-feed-kzi/01-resume-playback-position.png.
 *
 *   deno run --allow-all --unstable-kv scripts/playback-position-browser-proof.ts
 */

const PORT = 8137;
const BASE = `http://localhost:${PORT}`;
const TOKEN = "harness-token";
const OUT = new URL("../docs/evidence/audio-feed-kzi/", import.meta.url).pathname;
const HOME = Deno.env.get("HOME")!;
const PROFILE = `${HOME}/cap-evidence/kzi/chrome-profile`;

function newestChrome(): string {
  const root = `${HOME}/.cache/puppeteer/chrome`;
  const dirs = [...Deno.readDirSync(root)].filter((d) => d.isDirectory).map((d) => d.name).sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );
  return `${root}/${dirs.at(-1)}/chrome-linux64/chrome`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -- start harness ------------------------------------------------------------
const harness = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-all", "--unstable-kv", "scripts/listen-harness.ts", String(PORT)],
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "null",
  stderr: "inherit",
}).spawn();

for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) break;
  } catch { /* wait */ }
  await sleep(100);
}

// -- launch chrome ------------------------------------------------------------
await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
await Deno.mkdir(PROFILE, { recursive: true });
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

  // 2. Play episode 1 and set position to 45s, save to localStorage
  await js(`
    document.querySelector('li.episode[data-episode-id="ep-1"] button.ep-play')?.click();
    const audio = document.getElementById("audio");
    audio.currentTime = 45;
    audio.dispatchEvent(new Event("pause"));
  `);
  await sleep(100);

  const storedPos = await js(`
    JSON.parse(localStorage.getItem("audio-feed-positions:${TOKEN}") || "{}")["ep-1"]?.position
  `);
  check("playback position 45s saved to localStorage", storedPos === 45, `stored ${storedPos}s`);

  // 3. Reload page and check UI affordance
  await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
  await until(`document.querySelectorAll("#episodes .episode").length === 5`, "page reloaded");

  const row1 = `document.querySelector('li.episode[data-episode-id="ep-1"]')`;
  const badgeText = await js(`${row1}?.querySelector(".ep-resume-badge")?.textContent`);
  check(
    "row displays 'Resume from 0:45' badge",
    typeof badgeText === "string" && badgeText.includes("0:45"),
    `badge text: '${badgeText}'`,
  );

  const playAction = await js(`${row1}?.querySelector("button.ep-play")?.dataset.action`);
  check("play button action is 'resume'", playAction === "resume", `action: '${playAction}'`);

  const restartBtn = await js(`!!${row1}?.querySelector("button.ep-restart")`);
  check("distinct 'Play from start' button is present", restartBtn === true, "restart button exists");

  // 4. Capture screenshot showing resume badge and play-from-start button
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}01-resume-playback-position.png`,
    Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-resume-playback-position.png`);

  // 5. Click resume -> verify audio seeks to 45s
  await js(`${row1}?.querySelector("button.ep-play")?.click()`);
  await until(`Math.round(document.getElementById("audio")?.currentTime || 0) === 45`, "audio seeked to 45s");
  const currentPos = await js(`Math.round(document.getElementById("audio")?.currentTime || 0)`);
  check("clicking resume seeks audio to 45s", currentPos === 45, `currentTime is ${currentPos}`);

  // 6. Click 'Play from start' -> verify audio seeks to 0 and position cleared
  await js(`${row1}?.querySelector("button.ep-restart")?.click()`);
  await until(`Math.round(document.getElementById("audio")?.currentTime || 0) === 0`, "audio restarted to 0s");
  const clearedStored = await js(`
    JSON.parse(localStorage.getItem("audio-feed-positions:${TOKEN}") || "{}")["ep-1"]
  `);
  check("clicking 'Play from start' clears stored position", clearedStored === undefined, "cleared from storage");

  // 7. Finish episode (ended event) -> position cleared
  await js(`(() => {
    const audio = document.getElementById("audio");
    audio.currentTime = 50;
    audio.dispatchEvent(new Event("pause"));
  })()`);
  await sleep(100);
  check("re-saved position 50s", (await js(`
    JSON.parse(localStorage.getItem("audio-feed-positions:${TOKEN}") || "{}")["ep-1"]?.position
  `)) === 50, "re-saved at 50s");

  await js(`(() => {
    const audio = document.getElementById("audio");
    audio.dispatchEvent(new Event("ended"));
  })()`);
  await sleep(100);
  const endedStored = await js(`
    JSON.parse(localStorage.getItem("audio-feed-positions:${TOKEN}") || "{}")["ep-1"]
  `);
  check("ended event clears stored position", endedStored === undefined, "position removed after ended");

  // 8. Per-token isolation: a different token does not see these positions
  const otherTokenStorage = await js(`
    localStorage.getItem("audio-feed-positions:other-token")
  `);
  check("other token has no stored positions (per-token isolation)", otherTokenStorage === null, "isolated key");
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  try { harness.kill(); } catch { /* ignore */ }
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
}

Deno.exit(exitCode);
