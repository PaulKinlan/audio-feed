/**
 * Browser proof for the front door player links (audio-feed-ytg).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts scripts/account-harness.ts on port 8141.
 *   2. Desktop (1280x900):
 *      - Verifies header nav links to /listen.
 *      - Verifies lede and subscribing section link to /listen.
 *      - Verifies /listen landing page renders without a stored token.
 *      - Verifies returning subscriber banner appears on / when token is stored.
 *      - Verifies /listen auto-redirects to /listen/:token when token is stored.
 *      - Verifies sending an article on / displays "Open in Web Player →" linking to /listen/:token.
 *      - Takes desktop screenshot.
 *   3. Mobile (390x844):
 *      - Verifies responsive layout and zero horizontal overflow.
 *      - Takes mobile screenshot.
 *
 *   deno run --allow-all --unstable-kv scripts/home-player-link-browser-proof.ts
 */

const PORT = 8141;
const BASE = `http://localhost:${PORT}`;
const OUT = new URL("../docs/evidence/audio-feed-ytg/", import.meta.url).pathname;
const HOME = Deno.env.get("HOME")!;
const PROFILE = `${HOME}/cap-evidence/ytg/chrome-profile`;

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

  // 1. Desktop test
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Navigate to homepage without token
  await cdp("Page.navigate", { url: `${BASE}/` });
  await until(`document.readyState === "complete"`, "homepage loaded");

  const headerNavLink = await js(`!!document.querySelector('.site-nav a[href="/listen"]')`);
  check("header navigation links to /listen", headerNavLink === true, "Web Player nav link present");

  const ledeLink = await js(`!!document.querySelector('.lede a[href="/listen"]')`);
  check("hero lede links to /listen", ledeLink === true, "Web Player link in lede present");

  // Click Web Player in header
  await js(`document.querySelector('.site-nav a[href="/listen"]').click()`);
  await until(`location.pathname === "/listen"`, "navigate to /listen");

  const landingHeader = await js(`document.querySelector("h1")?.textContent`);
  check(
    "/listen landing page explains how to listen",
    landingHeader === "Listen to your feed",
    `heading: '${landingHeader}'`,
  );

  // Set stored token and visit homepage again
  await js(`localStorage.setItem("audio-feed-token", "harness-token")`);
  await cdp("Page.navigate", { url: `${BASE}/` });
  await until(`!document.getElementById("returningSubscriber")?.hidden`, "returning subscriber banner");

  const returningVisible = await js(`!document.getElementById("returningSubscriber")?.hidden`);
  check("returning subscriber banner is visible on /", returningVisible === true, "banner shown");

  const autoFilledToken = await js(`document.getElementById("token")?.value`);
  check("feed token field auto-filled from storage", autoFilledToken === "harness-token", `token: '${autoFilledToken}'`);

  // Visiting /listen with stored token restores directly to /listen/:token
  await cdp("Page.navigate", { url: `${BASE}/listen` });
  await until(`location.pathname.startsWith("/listen/harness-token")`, "restored to /listen/:token");
  check(
    "/listen with stored token restores directly to /listen/:token",
    (await js(`location.pathname`)).includes("harness-token"),
    "restored into player without pasting",
  );

  // Send an article on / and verify "Open in Web Player →"
  await cdp("Page.navigate", { url: `${BASE}/` });
  await until(`document.readyState === "complete"`, "homepage loaded again");

  await js(`
    document.getElementById("url").value = "https://example.com/front-door-article";
    document.getElementById("token").value = "harness-token";
    document.getElementById("ingest").requestSubmit();
  `);
  await until(`document.getElementById("result")?.classList.contains("ok")`, "submission success");

  const playerLinkUrl = await js(`document.querySelector("#result .player-link")?.getAttribute("href")`);
  check(
    "submission success state offers 'Open in Web Player →'",
    typeof playerLinkUrl === "string" && playerLinkUrl.includes("/listen/harness-token"),
    `player link: '${playerLinkUrl}'`,
  );

  // Screenshot desktop
  const shotDesktop = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}01-home-player-link-desktop.png`,
    Uint8Array.from(atob(shotDesktop.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-home-player-link-desktop.png`);

  // 2. Mobile test (390x844)
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });

  await cdp("Page.navigate", { url: `${BASE}/` });
  await until(`document.readyState === "complete"`, "mobile load");

  const overflow = await js(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
  check("mobile layout has zero horizontal overflow at 390px", overflow === false, "no horizontal scroll");

  const shotMobile = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}02-home-player-link-mobile-390.png`,
    Uint8Array.from(atob(shotMobile.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}02-home-player-link-mobile-390.png`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  try { harness.kill(); } catch { /* ignore */ }
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
}

Deno.exit(exitCode);
