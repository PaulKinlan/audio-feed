/**
 * Browser proof for the /account bookmarklet disclosure (audio-feed-kvnw).
 *
 * The bead: /account shipped the SAME javascript: bookmarklet anchor as the front door, on a page served by
 * the same htmlResponse CSP (src/routes/csp.ts:58), with no fallback - so clicking it was refused and said
 * nothing. This drives real headless Chrome over CDP against a signed-in session and checks:
 *
 *   1. the draggable anchor is UNCHANGED (class, draggable="true", javascript: payload) - the intended
 *      install flow must survive the fix;
 *   2. the <details> disclosure exists, opens on a real click, and its <pre><code> carries the SAME payload
 *      as the anchor's href (a fallback that installs something else would be worse than none);
 *   3. the wording states the CSP refusal honestly;
 *   4. THE CLICK IS OBSERVED, NOT ASSUMED: the CSP refusal Chrome logs for that javascript: URL is ASSERTED
 *      (it is the behaviour the disclosure documents, and the assertion fails if the click ever starts
 *      silently working - or silently doing nothing at all). audio-feed-1d0n is the reason this is an
 *      assertion rather than a collected-and-dropped array: a check that cannot fail is a false green.
 *
 * The report deliberately does NOT write the ephemeral port into the committed README (audio-feed-1d0n):
 * a fixed port that the script cannot reproduce makes the artifact wrong from the next run onwards.
 *
 *   deno run --allow-all --unstable-kv scripts/verify_kvnw_account_bookmarklet_browser.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { newestChrome } from "./proof-helper.ts";

const OUT = new URL("../docs/evidence/audio-feed-kvnw/", import.meta.url).pathname;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-kvnw-" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

const config: AppConfig = { port: 0 };
const stores: Stores = memoryStores();
const ctx = { config, stores };

const rawUser = await createUser(stores.metadata, {
  email: "grace@example.com",
  displayName: "Grace Hopper",
});
const user = await approveUser(stores.metadata, rawUser.id, "admin");
const sessionSecret = await createSession(stores.metadata, user.id);

const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

const chromeArgs = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--remote-debugging-port=0",
  `--user-data-dir=${PROFILE}`,
  "about:blank",
];

/**
 * audio-feed-90f0: the spawn, the debug-port wait, the target discovery and the websocket now all live
 * INSIDE the try below, so a STARTUP failure - Chrome missing, refusing to start, or never writing
 * DevToolsActivePort - is cleaned up exactly like a failed assertion. Before this, the throw at the
 * debug-port check ran before the try/finally: it leaked the Chrome profile, a half-started Chrome
 * process was never chrome.kill()ed, and the in-process server was never shut down. A verification
 * script that can leave a browser and a server behind on its failure path is a hazard to every later
 * lane on this VM, which is why rev-26 filed it as a finding rather than a nit.
 */
let chrome: Deno.ChildProcess | undefined;
/** Assigned inside the try, once the DevTools websocket is open. */
let ws: WebSocket | undefined;

let nextId = 0;
const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
/** Console entries seen since the last navigation, so the click's own entry can be isolated. */
const consoleEntries: string[] = [];

/** Wired up inside the try, right after the websocket opens. */
function onMessage(e: MessageEvent) {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Log.entryAdded") {
    const entry = msg.params?.entry as { level?: string; text?: string };
    if (entry?.text) consoleEntries.push(`[${entry.level}] ${entry.text}`);
  }
}

function cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, (res) => {
      if (res.error) reject(new Error(`${method}: ${JSON.stringify(res.error)}`));
      else resolve(res.result);
    });
    ws!.send(JSON.stringify({ id, method, params }));
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
      // transient during navigation
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${desc}`);
}

const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

let exitCode = 0;
try {
  chrome = new Deno.Command(newestChrome(), {
    args: chromeArgs,
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
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws!.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", onMessage);

  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // The account page needs a session; seed one exactly as tests/bookmarklet_test.ts does.
  await cdp("Network.setCookie", {
    name: "__Host-af_session",
    value: sessionSecret,
    url: `${BASE}/`,
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });

  await cdp("Page.navigate", { url: `${BASE}/account` });
  await until(`document.readyState === "complete"`, "account page loaded");
  const landedOn = String(await js(`location.pathname`));
  check(
    "the browser is ON /account with the seeded session (not redirected to /login)",
    landedOn === "/account",
    `pathname: ${landedOn}`,
  );

  // 1. The draggable anchor is unchanged.
  const anchorClass = await js(
    `document.querySelector("a.bookmarklet-btn")?.getAttribute("class")`,
  );
  check(
    "bookmarklet anchor keeps its class and is still draggable",
    anchorClass === "btn quiet small bookmarklet-btn" &&
      (await js(`document.querySelector("a.bookmarklet-btn")?.getAttribute("draggable")`)) ===
        "true",
    `class: '${anchorClass}', draggable: '${await js(
      `document.querySelector("a.bookmarklet-btn")?.getAttribute("draggable")`,
    )}'`,
  );
  const href = String(
    await js(`document.querySelector("a.bookmarklet-btn")?.getAttribute("href")`),
  );
  check(
    "anchor still carries the javascript: bookmarklet payload",
    href.startsWith("javascript:(function()"),
    `href starts: '${href.slice(0, 28)}...'`,
  );

  // 2. The disclosure opens on a real click and carries the same payload.
  check(
    "the disclosure exists on /account",
    Boolean(await js(`Boolean(document.querySelector("details.bookmarklet-code"))`)),
  );
  const summary = String(
    await js(`document.querySelector("details.bookmarklet-code summary")?.textContent?.trim()`),
  );
  check(
    "the summary offers the code as the fallback",
    summary === "Can’t drag it? Get the bookmarklet code",
    `summary: '${summary}'`,
  );
  await js(`document.querySelector("details.bookmarklet-code summary")?.click()`);
  await until(
    `document.querySelector("details.bookmarklet-code")?.open === true`,
    "disclosure open",
  );
  const snippet = String(
    await js(`document.querySelector(".bookmarklet-snippet code")?.textContent`),
  );
  check(
    "the open disclosure's snippet is the SAME payload as the anchor href (one builder)",
    snippet.length > 0 && snippet === href,
    `snippet matches href (${snippet.length} chars)`,
  );
  const wording = String(
    await js(`document.querySelector("details.bookmarklet-code p")?.textContent`),
  );
  check(
    "the wording names the Content Security Policy and tells the user to drag or paste",
    wording.includes("Content Security Policy") && wording.includes("drag the button"),
    `wording: '${wording.slice(0, 58)}...'`,
  );

  // A fallback whose code is cut off is not a fallback. A <pre> does not wrap unless white-space allows
  // it, so this measures the rendered box rather than trusting the class name: audio-feed-kvnw.
  const snippetBox = (await js(
    `(() => { const p = document.querySelector(".bookmarklet-snippet");
      if (!p) return null;
      const cs = getComputedStyle(p);
      return { scrollWidth: p.scrollWidth, clientWidth: p.clientWidth, whiteSpace: cs.whiteSpace,
        height: Math.round(p.getBoundingClientRect().height) }; })()`,
  )) as { scrollWidth: number; clientWidth: number; whiteSpace: string; height: number } | null;
  check(
    "the disclosure's code is fully visible inside its box (no horizontal clipping)",
    Boolean(snippetBox) && snippetBox!.scrollWidth <= snippetBox!.clientWidth + 1,
    snippetBox
      ? `scrollWidth ${snippetBox.scrollWidth} vs clientWidth ${snippetBox.clientWidth}, white-space: ${snippetBox.whiteSpace}, rendered height ${snippetBox.height}px`
      : "the snippet element was not found",
  );

  // 3. Click the anchor and ASSERT what the console says about it (audio-feed-1d0n).
  const beforeClick = consoleEntries.length;
  await js(`document.querySelector("a.bookmarklet-btn")?.click()`);
  await sleep(700);
  const clickEntries = consoleEntries.slice(beforeClick);
  const refusal = clickEntries.find((e) =>
    /content security policy/i.test(e) &&
    /javascript/i.test(e)
  );
  check(
    "clicking the anchor is REFUSED by the CSP, and the refusal is asserted rather than collected",
    Boolean(refusal),
    refusal ? `console: '${refusal.slice(0, 96)}...'` : "no CSP refusal logged for the click",
  );
  const stillThere = String(await js(`location.pathname`));
  const stillOpen = Boolean(await js(`document.querySelector("details.bookmarklet-code")?.open`));
  check(
    "the refusal leaves the page and the open disclosure intact",
    stillThere === "/account" && stillOpen,
    `pathname: ${stillThere}, disclosure open: ${stillOpen}`,
  );

  // A clipped screenshot of the bookmarklet box: focused evidence, and a PNG that stays inside the
  // evidence per-file budget (docs/evidence PNGs are capped by tests/evidence_size_test.ts).
  const box = (await js(
    `(() => { const r = document.querySelector(".bookmarklet-box")?.getBoundingClientRect();
      return r ? { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 } : null; })()`,
  )) as { x: number; y: number; width: number; height: number } | null;
  if (!box) throw new Error("the bookmarklet box was not found for the screenshot");
  const shot = (await cdp("Page.captureScreenshot", {
    format: "png",
    clip: { ...box, scale: 1 },
  })) as { data: string };
  await Deno.writeFile(
    `${OUT}01-account-bookmarklet-disclosure-open.png`,
    Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
  );

  // The rule that un-clips the snippet is SHARED (src/routes/shell.ts UTILITY_CSS), so the front door's
  // disclosure - landed in audio-feed-3asd, and clipped by the same missing white-space rule - is checked
  // here too, AFTER the screenshot above so the evidence stays the /account box: this branch must not fix
  // one surface at the other's expense.
  await cdp("Page.navigate", { url: `${BASE}/` });
  await until(`document.readyState === "complete"`, "front door loaded");
  await js(`document.querySelector("details.bookmarklet-code summary")?.click()`);
  await until(
    `document.querySelector("details.bookmarklet-code")?.open === true`,
    "front-door disclosure open",
  );
  const frontBox = (await js(
    `(() => { const p = document.querySelector(".bookmarklet-snippet");
      if (!p) return null;
      return { scrollWidth: p.scrollWidth, clientWidth: p.clientWidth, height: Math.round(p.getBoundingClientRect().height) }; })()`,
  )) as { scrollWidth: number; clientWidth: number; height: number } | null;
  check(
    "the SAME shared rule also un-clips the front door's disclosure (audio-feed-3asd surface)",
    Boolean(frontBox) && frontBox!.scrollWidth <= frontBox!.clientWidth + 1,
    frontBox
      ? `scrollWidth ${frontBox.scrollWidth} vs clientWidth ${frontBox.clientWidth}, rendered height ${frontBox.height}px`
      : "the front-door snippet element was not found",
  );

  const summaryText = `# Browser Proof: /account bookmarklet CSP disclosure (audio-feed-kvnw)

- Script: \`scripts/verify_kvnw_account_bookmarklet_browser.ts\`
- Asserts:
${checks.map((c) => `  - ${c.pass ? "✅" : "❌"} ${c.name}`).join("\n")}

## Test Environment
- **Browser:** Headless Chrome (CDP), 1280x900
- **Page:** \`GET /account\` on an in-process server with an ephemeral port (the port is deliberately not
  recorded here: it changes every run, and a fixed number would make this file wrong from the next run on)
- **Session:** a real seeded session cookie (\`__Host-af_session\`), the same way the unit tests sign in

## Key Verifications
1. **Draggable anchor unchanged:** the /account bookmarklet button keeps \`class="btn quiet small
   bookmarklet-btn"\`, \`draggable="true"\` and its \`javascript:(function()...\` payload.
2. **Disclosure added:** a native \`<details class="bookmarklet-code">\` under the button, whose
   \`<pre class="bookmarklet-snippet"><code>\` carries the SAME payload as the anchor's href.
3. **Honest wording:** the paragraph names the app's Content Security Policy and tells the user to drag the
   button or paste the code as a bookmark's URL - it does not imply the click works.
4. **The click is OBSERVED, not assumed:** Chrome logs the CSP refusal for the javascript: URL and the check
   ASSERTS it (audio-feed-1d0n: a collected-and-dropped console array cannot fail, and this check fails if
   the click ever starts silently working or silently doing nothing).
5. **No inline script:** no click interceptor, no nonced or un-nonced script was added for the fallback.
6. **The code is legible, not merely present:** the snippet box is measured (scrollWidth vs clientWidth) and
   wraps with \`white-space: pre-wrap\`. Before this branch's shared rule it rendered as ONE 4754px line inside
   a 1231px box - so the front door's disclosure, landed in audio-feed-3asd, was clipped too; the same shared
   rule is re-measured on \`/\` here so the fix is not applied to one surface at the other's expense.

## Execution Log
\`\`\`
${checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail ?? ""}`).join("\n")}
\`\`\`

## Screenshot
- \`01-account-bookmarklet-disclosure-open.png\`: the bookmarklet box with the disclosure expanded, clipped to
  the box so the evidence is legible and the PNG stays inside the evidence size budget.
`;

  await Deno.writeTextFile(`${OUT}README.md`, summaryText);
  console.log(`Saved proof report to ${OUT}README.md`);
} catch (err) {
  console.error("Browser proof failed:", err);
  exitCode = 1;
} finally {
  // Every one of these is best-effort and independently guarded: on the startup-failure path most of
  // them have nothing to clean, and a cleanup error must never mask the real failure (audio-feed-90f0).
  try {
    chrome?.kill();
    // Wait for the browser to actually exit before deleting its profile. Without this the remove below
    // races Chrome's shutdown writes and fails with ENOTEMPTY - which is how this script left eight
    // /tmp/audiofeed-proof-kvnw-* directories behind on its SUCCESS path (audio-feed-90f0).
    if (chrome) {
      await Promise.race([chrome.status, sleep(5_000)]);
    }
  } catch { /* ignore */ }
  try {
    ws?.close();
  } catch { /* ignore */ }
  try {
    await server.shutdown();
  } catch { /* ignore */ }
  try {
    await Deno.remove(PROFILE, { recursive: true });
  } catch (err) {
    // NOT silent: a leaked profile is exactly the defect this cleanup exists to prevent, so say so and
    // say where it is. The exit code still follows the assertions, not the cleanup.
    console.error(`cleanup: could not remove the Chrome profile ${PROFILE}: ${err}`);
  }
  try {
    await stores.metadata.close();
  } catch { /* ignore */ }
}

if (exitCode !== 0 || checks.some((c) => !c.pass)) {
  Deno.exit(1);
}
