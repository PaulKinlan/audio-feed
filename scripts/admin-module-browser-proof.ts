/**
 * Browser proof for audio-feed-3xq part 4a: the admin console's client is a
 * content-addressed MODULE, and the page still works.
 *
 * The gate proves the bytes are typed; only a real browser proves they RUN. This
 * drives the shipped page end to end:
 *
 * 1. The module is fetched at /assets/<hash>.admin.js — 200, text/javascript,
 *    immutable — and the #admin-data island is what the server rendered.
 * 2. Zero console errors/warnings/exceptions during load and interaction.
 * 3. The module executes the console: users auto-load into #usersBody (the
 *    markup ships that tbody EMPTY, so rows can only come from the module),
 *    stats populate, the manage pane opens and lists the subscriber's feeds.
 * 4. The confirm-dialog client (askConfirm, now living inside the module)
 *    really guards destructive actions in the browser: Remove raises the native
 *    dialog, Cancel sends NO request, Confirm sends exactly one DELETE.
 * 5. The same pass at 390x844 as at 1280x900, with screenshots.
 *
 *   deno run --allow-all --unstable-kv scripts/admin-module-browser-proof.ts
 *
 * Not part of the gate (it launches Chrome); run it after touching the admin
 * client, the asset route, or the shell's script plumbing.
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const OUT = new URL("../docs/evidence/audio-feed-3xq/", import.meta.url).pathname;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-3xq-" });
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

// -- in-process app, seeded ---------------------------------------------------
const stores: Stores = memoryStores();
const config: AppConfig = { port: 0, adminToken: "harness-admin" };
const ctx = { config, stores };

const rawAdmin = await createUser(stores.metadata, {
  email: "admin@example.com",
  displayName: "Admin",
  isAdmin: true,
});
const admin = await approveUser(stores.metadata, rawAdmin.id, "admin");
const sessionSecret = await createSession(stores.metadata, admin.id);

const rawSub = await createUser(stores.metadata, {
  email: "sub@example.com",
  displayName: "Sub Scriber",
});
const sub = await approveUser(stores.metadata, rawSub.id, "sub@example.com/feed");

await stores.metadata.putSource({
  id: "src-strat",
  userId: sub.id,
  title: "Stratechery",
  feedUrl: "https://stratechery.com/feed",
  modes: ["direct"],
  voices: {},
  createdAt: new Date().toISOString(),
});

// A little run history so the stats panel has rows to render.
const now = Date.now();
for (let i = 0; i < 3; i++) {
  await stores.metadata.recordRun({
    id: `p${i}`,
    kind: "feed-poll",
    trigger: "cron",
    startedAt: new Date(now - (i + 1) * 900_000).toISOString(),
    durationMs: 1200 + i,
    polled: 1,
    queued: 0,
    failed: 0,
  });
}

const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

// -- chrome + CDP --------------------------------------------------------------
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
// CDP events, collected rather than dropped: the network and console checks below
// read what the browser actually saw. Typed to the few fields this proof reads.
interface CdpEvent {
  method: string;
  params: {
    response?: { url?: string; status?: number; headers?: Record<string, string> };
    request?: { method?: string; url?: string };
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
    if (await js(`Boolean(${expr})`)) return;
    await sleep(50);
  }
  throw new Error(`Timeout waiting for: ${desc}`);
}

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

let exitCode = 0;
try {
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Log.enable");
  await cdp("Runtime.enable");

  await cdp("Network.setCookie", {
    name: "__Host-af_session",
    value: sessionSecret,
    url: BASE,
    secure: true,
  });

  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp("Page.navigate", { url: `${BASE}/admin` });
  await until(`document.readyState === "complete"`, "admin page loaded");
  await until(`document.getElementById("usersBody")?.children?.length > 0`, "users auto-loaded");

  // 1. The module was fetched, content-addressed, with the caching headers it promises.
  const moduleResponses = events.filter(
    (e) =>
      e.method === "Network.responseReceived" &&
      /\/assets\/[0-9a-f]+\.admin\.js$/.test(e.params.response?.url ?? ""),
  );
  const moduleRes = moduleResponses[0]?.params.response;
  check(
    "module fetched at /assets/<hash>.admin.js",
    moduleResponses.length === 1 && moduleRes?.status === 200,
    moduleRes ? `${moduleRes.url} -> ${moduleRes.status}` : "no module response seen",
  );
  check(
    "module served as immutable text/javascript",
    moduleRes?.headers?.["content-type"]?.startsWith("text/javascript") === true &&
      moduleRes?.headers?.["cache-control"] === "public, max-age=31536000, immutable",
    `content-type: ${moduleRes?.headers?.["content-type"]}, cache-control: ${moduleRes?.headers?.["cache-control"]}`,
  );

  // 2. The island the server rendered is the island the client read.
  const island = await js(
    `JSON.parse(document.getElementById("admin-data").textContent)`,
  ) as { origin?: string; signedIn?: boolean };
  check(
    "#admin-data island carries the server's origin and session state",
    island?.origin === BASE && island?.signedIn === true,
    JSON.stringify(island),
  );

  // 3. The module ran the console: rows in a tbody that ships empty, stats filled.
  //    Both seeded accounts appear (the admin is a user too); the subscriber's row is the
  //    one the manage-pane checks below drive.
  const rowEmails = await js(
    `[...document.querySelectorAll("#usersBody td:first-child")].map((td) => td.textContent)`,
  ) as string[];
  check(
    "module rendered both subscriber rows",
    Array.isArray(rowEmails) && rowEmails.includes("sub@example.com") &&
      rowEmails.includes("admin@example.com"),
    `cells: ${JSON.stringify(rowEmails)}`,
  );
  const runsRows = Number(await js(`document.getElementById("runsBody")?.children?.length ?? -1`));
  check("stats panel rendered seeded runs", runsRows >= 3, `runs rows: ${runsRows}`);

  // 4. The manage pane opens ON THE SUBSCRIBER's row (not the admin's own, which has no
  //    feeds) and lists their sources.
  await js(`
    [...document.querySelectorAll("#usersBody tr")]
      .find((tr) => tr.textContent.includes("sub@example.com"))
      .querySelector('button[aria-label^="Manage "]').click()
  `);
  await until(`!document.getElementById("manageSection")?.hidden`, "manage pane open");
  await until(
    `document.getElementById("manageSourcesBody")?.children?.length > 0`,
    "manage sources loaded",
  );
  const sourceTitle = String(
    await js(`document.querySelector("#manageSourcesBody td")?.textContent`),
  );
  check("manage pane lists the subscriber's feed", sourceTitle === "Stratechery", `got: ${sourceTitle}`);

  // 5. askConfirm (now inside the module) guards the destructive action for real.
  const deletesBefore = events.filter(
    (e) => e.method === "Network.requestWillBeSent" && e.params.request?.method === "DELETE",
  ).length;
  await js(
    `[...document.querySelectorAll("#manageSourcesBody button")].find((b) => b.textContent === "Remove").click()`,
  );
  await until(`document.getElementById("confirmDialog")?.open`, "confirm dialog open");
  const dialogMessage = String(await js(`document.getElementById("confirmMessage")?.textContent`));
  check("Remove raises the native confirm dialog", dialogMessage.includes("Stratechery"), dialogMessage);
  await js(`document.getElementById("confirmCancelBtn").click()`);
  await until(`!document.getElementById("confirmDialog")?.open`, "dialog closed");
  await sleep(250);
  const deletesAfterCancel = events.filter(
    (e) => e.method === "Network.requestWillBeSent" && e.params.request?.method === "DELETE",
  ).length;
  check(
    "Cancel sends no DELETE",
    deletesAfterCancel === deletesBefore,
    `DELETE requests: ${deletesBefore} -> ${deletesAfterCancel}`,
  );

  await js(
    `[...document.querySelectorAll("#manageSourcesBody button")].find((b) => b.textContent === "Remove").click()`,
  );
  await until(`document.getElementById("confirmDialog")?.open`, "confirm dialog open again");
  await js(`document.getElementById("confirmOkBtn").click()`);
  await sleep(500);
  const deleteReqs = events.filter(
    (e) => e.method === "Network.requestWillBeSent" && e.params.request?.method === "DELETE",
  );
  check(
    "Confirm sends exactly one DELETE for that source",
    deleteReqs.length === deletesBefore + 1 &&
      (deleteReqs.at(-1)?.params.request?.url ?? "").includes(`/sources/src-strat`),
    `DELETE count: ${deleteReqs.length}, last: ${deleteReqs.at(-1)?.params.request?.url}`,
  );

  // 6. Zero console errors or exceptions across everything above.
  const consoleErrors = events.filter((e) =>
    (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) ||
    e.method === "Runtime.exceptionThrown" ||
    (e.method === "Log.entryAdded" && e.params.entry?.level === "error")
  );
  check(
    "no console errors/warnings/exceptions at 1280x900",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).map((e) => JSON.stringify(e.params).slice(0, 200)).join(" | ") ||
      "clean",
  );

  const shot1 = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}part4a-admin-1280x900.png`,
    Uint8Array.from(atob(shot1.data), (c) => c.charCodeAt(0)),
  );

  // 7. The same page at phone width: module cached-or-refetched, still clean, still working.
  events.length = 0;
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp("Page.navigate", { url: `${BASE}/admin` });
  await until(`document.readyState === "complete"`, "admin page reloaded at 390x844");
  await until(`document.getElementById("usersBody")?.children?.length > 0`, "users loaded at 390x844");
  const phoneErrors = events.filter((e) =>
    (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) ||
    e.method === "Runtime.exceptionThrown" ||
    (e.method === "Log.entryAdded" && e.params.entry?.level === "error")
  );
  check(
    "no console errors/warnings/exceptions at 390x844",
    phoneErrors.length === 0,
    phoneErrors.slice(0, 3).map((e) => JSON.stringify(e.params).slice(0, 200)).join(" | ") ||
      "clean",
  );
  const shot2 = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}part4a-admin-390x844.png`,
    Uint8Array.from(atob(shot2.data), (c) => c.charCodeAt(0)),
  );

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
