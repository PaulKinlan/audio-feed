/**
 * Browser proof for audio-feed-3xq part 4c: the listen landing and the shell tooltip client.
 *
 * 1. /listen fetches /assets/<hash>.listen-landing.{css,js} with 200, immutable cache headers,
 *    and the right content types.
 * 2. The restore path runs: a stored audio-feed-token redirects straight to the player.
 * 3. The form path runs: pasting a full feed URL, submitting, lands on /listen/<token> — the
 *    client's tokenFrom() extraction, which only the module can do.
 * 4. The tooltip client (src/assets/tooltip-client.js, shipped inline on shell pages) works on
 *    the homepage: pointerover on a [data-tooltip] element shows #appTooltip with the right
 *    text and wires aria-describedby; pointerout hides it.
 * 5. Zero console errors/warnings/exceptions at 1280x900 and 390x844.
 *
 *   deno run --allow-all --unstable-kv scripts/landing-tooltip-browser-proof.ts
 *
 * Not part of the gate (it launches Chrome).
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { makeUser } from "../tests/fixtures.ts";

const OUT = new URL("../docs/evidence/audio-feed-3xq/", import.meta.url).pathname;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-3xq-4c-" });
const TOKEN = "tok-landing";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

function newestChrome(): string {
  const home = Deno.env.get("HOME")!;
  const root = `${home}/.cache/puppeteer/chrome`;
  const dirs = [...Deno.readDirSync(root)].filter((d) => d.isDirectory).map((d) => d.name).sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );
  return `${root}/${dirs.at(-1)}/chrome-linux64/chrome`;
}

const stores: Stores = memoryStores();
const config: AppConfig = { port: 0 };
const ctx = { config, stores };
await stores.metadata.putUser(
  makeUser({ id: "user-1", displayName: "Paul", status: "approved", feedToken: TOKEN }),
);
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
interface CdpEvent {
  method: string;
  params: {
    response?: { url?: string; status?: number; headers?: Record<string, string> };
    type?: string;
    entry?: { level?: string };
  };
}
const events: CdpEvent[] = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push({ method: msg.method, params: msg.params });
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
  const res = await cdp("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }) as { result?: { value?: unknown } };
  return res.result?.value;
}

async function until(expr: string, desc = expr, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // During a navigation the execution context is destroyed mid-poll; that is progress, not
    // failure — swallow and keep asking.
    try {
      if (await js(`Boolean(${expr})`)) return;
    } catch { /* context destroyed mid-navigation */ }
    await sleep(50);
  }
  throw new Error(`Timeout waiting for: ${desc}`);
}

async function navigate(url: string) {
  events.length = 0;
  await cdp("Page.navigate", { url });
  await until(`document.readyState === "complete"`, `loaded ${url}`);
}

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

const consoleBad = () =>
  events.filter((e) =>
    (e.method === "Runtime.consoleAPICalled" &&
      ["error", "warning"].includes(e.params.type ?? "")) ||
    e.method === "Runtime.exceptionThrown" ||
    (e.method === "Log.entryAdded" && e.params.entry?.level === "error")
  );

async function screenshot(name: string) {
  const shot = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}${name}.png`,
    Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
  );
}

let exitCode = 0;
try {
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Log.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // --- landing, fresh (no stored token): assets + form flow -----------------
  await navigate(`${BASE}/listen`);
  const assetResponse = (suffix: string) =>
    events.find(
      (e) =>
        e.method === "Network.responseReceived" &&
        new RegExp(`/assets/[0-9a-f]+\\.${suffix}$`).test(e.params.response?.url ?? ""),
    )?.params.response;
  const cssRes = assetResponse("listen-landing\\.css");
  check(
    "listen-landing.css fetched content-addressed, immutable, text/css",
    cssRes?.status === 200 &&
      cssRes.headers?.["content-type"]?.startsWith("text/css") === true &&
      cssRes.headers?.["cache-control"] === "public, max-age=31536000, immutable",
    cssRes ? `${cssRes.url} ${cssRes.status}` : "no response seen",
  );
  const jsRes = assetResponse("listen-landing\\.js");
  check(
    "listen-landing.js fetched content-addressed, immutable, text/javascript",
    jsRes?.status === 200 &&
      jsRes.headers?.["content-type"]?.startsWith("text/javascript") === true &&
      jsRes.headers?.["cache-control"] === "public, max-age=31536000, immutable",
    jsRes ? `${jsRes.url} ${jsRes.status}` : "no response seen",
  );
  check(
    "no console errors on the fresh landing",
    consoleBad().length === 0,
    consoleBad().slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 160)).join(" | ") ||
      "clean",
  );
  await screenshot("part4c-listen-landing-1280x900");

  // form path: paste a full feed URL, submit -> tokenFrom() extracts -> /listen/<token>
  await js(`
    (() => {
      const u = document.getElementById("feedUrl");
      u.value = ${JSON.stringify(`${BASE}/feed/${TOKEN}/master.xml`)};
      document.getElementById("restore").requestSubmit();
    })()
  `);
  await until(`location.pathname === "/listen/${TOKEN}"`, "form submit navigated to the player");
  await until(`document.getElementById("episodeCount") !== null`, "player rendered");
  check(
    "form submit turns a pasted feed URL into the player for that token",
    await js(`location.pathname`) === `/listen/${TOKEN}`,
    `pathname=${await js(`location.pathname`)}`,
  );

  // restore path: a stored token redirects without any interaction
  await js(`localStorage.setItem("audio-feed-token", ${JSON.stringify(TOKEN)})`);
  await navigate(`${BASE}/listen`);
  await until(`location.pathname === "/listen/${TOKEN}"`, "stored token redirected to the player");
  check(
    "a stored token redirects straight to the player",
    await js(`location.pathname`) === `/listen/${TOKEN}`,
    `pathname=${await js(`location.pathname`)}`,
  );
  check(
    "no console errors on the restore run",
    consoleBad().length === 0,
    consoleBad().slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 160)).join(" | ") ||
      "clean",
  );

  // --- shell tooltip client on the homepage ----------------------------------
  await js(`localStorage.removeItem("audio-feed-token")`);
  await navigate(BASE);
  await until(`document.querySelector("[data-tooltip]") !== null`, "tooltip target present");
  const shown = await js(`
    (() => {
      const t = document.querySelector("[data-tooltip]");
      // Bring the target (and the tooltip that anchors to it) into the viewport so the
      // screenshot is evidence of the visible state, not just the DOM state (4c review P2).
      t.scrollIntoView({ block: "center" });
      t.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      const tip = document.getElementById("appTooltip");
      return {
        visible: tip.classList.contains("visible"),
        text: tip.textContent,
        expected: t.getAttribute("data-tooltip"),
        describedby: t.getAttribute("aria-describedby"),
      };
    })()
  `) as { visible: boolean; text: string; expected: string; describedby: string | null };
  await sleep(150);
  check(
    "pointerover shows #appTooltip with the target's text and aria-describedby",
    shown?.visible === true && shown.text === shown.expected && shown.describedby === "appTooltip",
    JSON.stringify(shown),
  );
  await screenshot("part4c-home-tooltip-visible-1280x900");
  const hidden = await js(`
    (() => {
      const t = document.querySelector("[data-tooltip]");
      t.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
      return new Promise((resolve) =>
        setTimeout(() => resolve(!document.getElementById("appTooltip").classList.contains("visible")), 200)
      );
    })()
  `);
  check("pointerout hides the tooltip again", hidden === true, `hidden=${hidden}`);
  check(
    "no console errors on the homepage with the extracted tooltip client",
    consoleBad().length === 0,
    consoleBad().slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 160)).join(" | ") ||
      "clean",
  );

  // --- 390x844 ----------------------------------------------------------------
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await navigate(`${BASE}/listen`);
  await until(`document.getElementById("feedUrl") !== null`, "landing form at 390x844");
  check(
    "no console errors at 390x844",
    consoleBad().length === 0,
    consoleBad().slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 160)).join(" | ") ||
      "clean",
  );
  await screenshot("part4c-listen-landing-390x844");

  console.log(`Screenshots in ${OUT}`);
} catch (err) {
  exitCode = 1;
  console.error("PROOF CRASHED:", err);
} finally {
  try {
    ws.close();
  } catch { /* already closed */ }
  try {
    chrome.kill("SIGKILL");
  } catch { /* already dead */ }
  await server.shutdown();
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) exitCode = 1;
Deno.exit(exitCode);
