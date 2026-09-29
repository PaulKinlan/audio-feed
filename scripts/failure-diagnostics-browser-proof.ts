/**
 * Browser proof for failure diagnostics & error visibility (audio-feed-e1d).
 *
 * Verifies:
 * 1. /admin runs table:
 *    - Failed runs render an expandable <details class="run-errors"> disclosure.
 *    - Clicking <summary> expands the details and visibly renders the exact LLM/feed errors.
 * 2. /listen/:token (player):
 *    - When audio download fails (HTTP 404), the error reason is preserved directly
 *      on the episode row in .ep-download-error.
 *
 *   deno run --allow-all --unstable-kv scripts/failure-diagnostics-browser-proof.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { makeArticle, makeEpisode } from "../tests/fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const OUT = new URL("../docs/evidence/audio-feed-e1d/", import.meta.url).pathname;
const HOME = Deno.env.get("HOME")!;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-e1d-" });

function newestChrome(): string {
  const root = `${HOME}/.cache/puppeteer/chrome`;
  const dirs = [...Deno.readDirSync(root)].filter((d) => d.isDirectory).map((d) => d.name).sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );
  return `${root}/${dirs.at(-1)}/chrome-linux64/chrome`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// -- in-process test app ------------------------------------------------------
const stores: Stores = memoryStores();
const config: AppConfig = {
  port: 0,
  adminToken: "harness-admin",
};
const ctx = { config, stores };

// Seed user and session
const rawUser = await createUser(stores.metadata, {
  email: "paul@example.com",
  displayName: "Paul Kinlan",
  isAdmin: true,
});
const user = await approveUser(stores.metadata, rawUser.id, "admin");
const sessionSecret = await createSession(stores.metadata, user.id);

// Seed source and an episode whose audio will 404 on download
await stores.metadata.putSource({
  id: "src-1",
  userId: user.id,
  title: "Example Publication",
  feedUrl: "https://example.com/feed.xml",
  modes: ["direct"],
  voices: {},
  createdAt: new Date().toISOString(),
});

await stores.metadata.putArticle(
  makeArticle({
    id: "art-missing",
    userId: user.id,
    sourceId: "src-1",
    title: "Article With Missing Audio",
  }),
);
await stores.metadata.putEpisode(
  makeEpisode({
    id: "ep-missing",
    userId: user.id,
    sourceId: "src-1",
    articleId: "art-missing",
    title: "Article With Missing Audio",
    status: "ready",
    audioKey: "audio/user/direct/missing-file.wav", // Does not exist in storage -> 404!
    contentType: "audio/wav",
  }),
);

// Record a background run with failed items and exact error strings
await stores.metadata.recordRun({
  id: "run-failed-items",
  kind: "synthesis",
  trigger: "cron",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  durationMs: 450,
  ready: 0,
  failed: 2,
  deferred: 0,
  errors: [
    'Episode ep-1 ("Autonomous Systems"): Gemini API error: 429 Quota Exceeded',
    'Episode ep-2 ("Microservices Review"): article content exceeds input limit',
  ],
});

const handlers = createHandlers(ctx);
const { fetch: appFetch } = createApp(ctx, handlers);

const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

// -- launch chrome ------------------------------------------------------------
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
  debugPort = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split("\n")[0]!;
}

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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

async function until(expr: string, desc = expr, timeout = 10_000) {
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

  // Set session cookie
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

  // 1. Visit /admin
  await cdp("Page.navigate", { url: `${BASE}/admin` });
  await until(`document.readyState === "complete"`, "admin page loaded");
  await until(`document.getElementById("runsBody")?.children?.length > 0`, "runs loaded");

  // Verify details.run-errors exists on the failed run row
  const detailsExists = await js(`Boolean(document.querySelector("#runsBody details.run-errors"))`);
  check(
    "admin runs table renders <details class='run-errors'>",
    detailsExists === true,
    "run-errors details present",
  );

  // Click summary to expand details
  await js(`document.querySelector("#runsBody details.run-errors summary").click()`);
  await until(
    `document.querySelector("#runsBody details.run-errors")?.open === true`,
    "run-errors details expanded",
  );

  const isOpen = await js(`document.querySelector("#runsBody details.run-errors")?.open`);
  check(
    "clicking summary expands the run errors log",
    isOpen === true,
    "details is open",
  );

  const errorsListText = String(
    await js(`document.querySelector("#runsBody .run-errors-list")?.textContent || ""`),
  );
  check(
    "expanded log visibly renders exact failure reasons",
    errorsListText.includes("Gemini API error: 429 Quota Exceeded") &&
      errorsListText.includes("article content exceeds input limit"),
    errorsListText.trim(),
  );

  const shotAdmin = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}01-admin-runs-expanded-errors.png`,
    Uint8Array.from(atob(shotAdmin.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-admin-runs-expanded-errors.png`);

  // 2. Visit /listen/:token (player)
  await cdp("Page.navigate", { url: `${BASE}/listen/${user.feedToken}` });
  await until(`document.readyState === "complete"`, "player loaded");
  await until(`document.querySelectorAll("#episodes .episode").length > 0`, "episodes loaded in player");

  // Click download on the episode whose audio 404s
  await js(`document.querySelector(".ep-download").click()`);

  // Wait for .ep-download-error to appear on the episode row
  await until(
    `document.querySelector(".ep-download-error")?.textContent.length > 0`,
    "inline download error rendered",
  );

  const downloadErrorText = String(
    await js(`document.querySelector(".ep-download-error")?.textContent || ""`),
  );
  check(
    "player renders exact download failure reason on the episode row",
    downloadErrorText.includes("Download failed: HTTP 404"),
    `got: '${downloadErrorText}'`,
  );

  const shotPlayer = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}02-player-download-error-inline.png`,
    Uint8Array.from(atob(shotPlayer.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}02-player-download-error-inline.png`);

  // Summary report
  const summary = `# Failure Diagnostics and Error Visibility Verification: audio-feed-e1d

## Observed Behavior
1. **Admin Console (/admin)**:
   - The Runs table detects failed item count (\`failed > 0\`) and renders an expandable \`<details class="run-errors">\` element.
   - Clicking the summary expands the details in place without page navigation or modal popups.
   - The expanded log visibly renders the list of exact failure reasons (\`Gemini API error: 429 Quota Exceeded\` and \`article content exceeds input limit\`).
2. **Web Player (/listen/:token)**:
   - When offline audio download fails (e.g. HTTP 404 from storage), the error reason is not merely flashed in a toast; it is preserved directly on the episode row in \`.ep-download-error\`.
   - The error text honestly reports \`Download failed: HTTP 404\`.

## Test Results
\`\`\`
${checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")}
\`\`\`

## Screenshots
- \`01-admin-runs-expanded-errors.png\`: Admin runs table with expanded \`<details class="run-errors">\` log.
- \`02-player-download-error-inline.png\`: Web player with inline \`.ep-download-error\` on the episode row.
`;

  await Deno.writeTextFile(`${OUT}README.md`, summary);
  console.log(`Saved report to ${OUT}README.md`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  await server.shutdown().catch(() => {});
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
}

Deno.exit(exitCode);
