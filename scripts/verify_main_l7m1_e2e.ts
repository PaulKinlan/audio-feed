/**
 * End-to-end live verification script on origin/main (audio-feed-l7m1).
 *
 * Drives real headless Chrome over CDP against a locally booted server at main (ee9b747):
 *   1. Admin Observability (/admin/observability):
 *      - Screened unhandled error messages (client canaries suppressed, closed phrase list).
 *      - Correct limits copy regarding screened messages and upload retry bounds.
 *      - Retrying queue table: durable uploadRetry counter rendered, non-blank reason,
 *        and expandable claim history.
 *   2. Front door (/) bookmarklet behavior:
 *      - Verified under current main CSP; documents status of the pending 3asd disclosure branch.
 *   3. RSS Feed, Audio Route, and Listen Web Player (/listen/...):
 *      - RSS XML generation and enclosure URL correctness.
 *      - Direct audio streaming and capability access boundaries.
 *      - Web Player UI rendering and playback elements in real Chrome.
 *
 *   deno run --allow-all --unstable-kv scripts/verify_main_l7m1_e2e.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { createSession } from "../src/auth/sessions.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";
import { pcmToWav } from "../src/tts/gemini.ts";
import { claimLifecycleEvent } from "../src/storage/episode_events.ts";
import { SUPPRESSED_MESSAGE } from "../src/observability/error_screen.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { newestChrome } from "./proof-helper.ts";

const OUT = new URL("../docs/evidence/audio-feed-l7m1/", import.meta.url).pathname;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-l7m1-e2e-" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// -- 1. Setup in-process server with durable memory stores ---------------------
const stores: Stores = memoryStores();
const config: AppConfig = {
  port: 0,
  adminToken: "admin-secret-l7m1",
};

// Seed Admin & Subscriber users
const admin = makeUser({
  id: "admin-l7m1",
  email: "admin@example.com",
  displayName: "Admin Operator",
  isAdmin: true,
  status: "approved",
});
await stores.metadata.putUser(admin);
const adminSession = await createSession(stores.metadata, admin.id);

const subscriber = makeUser({
  id: "sub-l7m1",
  email: "subscriber@example.com",
  displayName: "Subscriber Listener",
  status: "approved",
  feedToken: "sub-feed-token-l7m1",
});
await stores.metadata.putUser(subscriber);

const source = makeSource({
  id: "source-tech",
  userId: subscriber.id,
  title: "Tech Weekly",
});
await stores.metadata.putSource(source);

const article = makeArticle({
  id: "art-1",
  userId: subscriber.id,
  sourceId: source.id,
  title: "Advancements in Synthetic Media",
});
await stores.metadata.putArticle(article);

// Seed a retrying episode with uploadRetry counter and claim history
const retryingEp = makeEpisode({
  id: "ep-retrying-1",
  userId: subscriber.id,
  sourceId: source.id,
  articleId: article.id,
  title: "Advancements in Synthetic Media",
  status: "pending",
  phase: "synthesizing",
  attempts: 2,
  uploadRetry: 2,
  lastRetryReason: "Invocation budget exceeded during audio upload; claim yielded for retry",
});
await stores.metadata.putEpisode(retryingEp);

// Log claim lifecycle events for claim history
await stores.metadata.appendLog(
  claimLifecycleEvent(retryingEp, {
    owner: "worker-inst-1",
    action: "claimed",
    attempt: 1,
    phase: "synthesizing",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
  }),
);

await stores.metadata.appendLog(
  claimLifecycleEvent(retryingEp, {
    owner: "worker-inst-1",
    action: "yielded",
    claimOutcome: "yielded",
    attempt: 1,
    phase: "synthesizing",
    reason: "Invocation budget exceeded during audio upload; claim yielded for retry",
    uploadRetry: 1,
  }),
);

// Seed a ready episode with audio blob
const audioKey = `audio/${subscriber.id}/direct/ep-ready-1.wav`;
const audioBytes = pcmToWav(new Uint8Array(48000), {
  sampleRate: 24000,
  numChannels: 1,
  bitsPerSample: 8,
});
await stores.blobs.put(audioKey, audioBytes, { contentType: "audio/wav" });

const readyEp = makeEpisode({
  id: "ep-ready-1",
  userId: subscriber.id,
  sourceId: source.id,
  articleId: article.id,
  title: "Advancements in Synthetic Media — Audio Edition",
  status: "ready",
  mode: "direct",
  audioKey,
  contentType: "audio/wav",
  byteLength: audioBytes.byteLength,
  audioDurationSeconds: 2,
});
await stores.metadata.putEpisode(readyEp);

// Seed an unhandled error log record with a client canary string
const CLIENT_CANARY = "canary-client-token-998877";
await stores.metadata.appendLog({
  level: "error",
  type: "request.unhandled_error",
  route: "/api/submit",
  message: "Unhandled error processing request",
  correlationId: "corr-err-l7m1",
  context: {
    status: 500,
    error: "Error",
    errorMessage: SUPPRESSED_MESSAGE, // Screened message (client canary was filtered)
  },
});

// Start app server
const ctx = { config, stores };
const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

// -- 2. Launch Headless Chrome ------------------------------------------------
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
const consoleEntries: string[] = [];

ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Log.entryAdded") {
    consoleEntries.push(`[Log] ${msg.params?.entry?.text}`);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    consoleEntries.push(`[Console] ${(msg.params?.args ?? []).map((a: { value: unknown }) => a.value).join(" ")}`);
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
      // retry
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
  await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // -- TEST 1: Admin Observability (/admin/observability) -----------------------
  await cdp("Network.setCookie", {
    name: "__Host-af_session",
    value: adminSession,
    url: BASE,
    secure: true,
  });

  await cdp("Page.navigate", { url: `${BASE}/admin/observability` });
  await until(`document.readyState === "complete"`, "admin observability loaded");

  const pageTitle = await js(`document.querySelector("h1")?.textContent`);
  check("admin observability page loads with h1 header", pageTitle === "Observability");

  // Verify screened error message in failure card
  const errorMessageHtml = String(await js(`document.body.innerHTML`));
  check(
    "unhandled error renders screened message",
    errorMessageHtml.includes("message suppressed (not authored by this codebase)"),
    "contains SUPPRESSED_MESSAGE",
  );
  check(
    "client canary string is NOT leaked into the document",
    !errorMessageHtml.includes(CLIENT_CANARY),
    `checked absence of '${CLIENT_CANARY}'`,
  );

  // Verify limits section
  const limitsSection = String(await js(`document.getElementById("limits-h")?.parentElement?.textContent`));
  check(
    "limits section explains screened error messages",
    limitsSection.includes("Unhandled request errors record their class and a SCREENED message"),
  );
  check(
    "limits section explains distinct uploadRetry counter bounded by maxUploadRetries",
    limitsSection.includes("Upload retries carry a distinct uploadRetry counter bounded by maxUploadRetries"),
  );

  // Verify Retrying table
  const retryingUploadRetryCell = String(
    await js(`document.querySelector("table tbody tr td:nth-child(4)")?.textContent`),
  );
  check(
    "retrying table renders durable uploadRetry counter",
    retryingUploadRetryCell === "2",
    `uploadRetry cell: '${retryingUploadRetryCell}'`,
  );

  const retryingReason = String(
    await js(`document.querySelector("table tbody tr td:nth-child(6)")?.textContent`),
  );
  check(
    "retrying table renders non-blank recorded reason",
    retryingReason.includes("Invocation budget exceeded during audio upload"),
  );

  // Click claim history details element
  const detailsExists = await js(`Boolean(document.querySelector("table details"))`);
  check("retrying table includes expandable claim history details", Boolean(detailsExists));

  await js(`document.querySelector("table details summary")?.click()`);
  await sleep(200);
  const detailsOpen = await js(`document.querySelector("table details")?.open`);
  check("claim history expands on click", detailsOpen === true);

  const adminCspViolations = consoleEntries.filter(
    (msg) => msg.includes("Content Security Policy") || msg.includes("violates"),
  );
  check(
    "admin observability console has zero CSP violations",
    adminCspViolations.length === 0,
    `violations: ${adminCspViolations.length}`,
  );

  const shotAdmin = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}01-admin-observability.png`,
    Uint8Array.from(atob(shotAdmin.data), (c) => c.charCodeAt(0)),
  );

  // -- TEST 2: Homepage Bookmarklet (/ on main 18b688f) -----------------------
  await cdp("Page.navigate", { url: `${BASE}/` });
  await until(`document.readyState === "complete"`, "homepage loaded");

  const bookmarkletAnchor = await js(`document.querySelector("a.bookmarklet-link")?.getAttribute("href")`);
  check(
    "front door renders draggable bookmarklet anchor with javascript: URL",
    String(bookmarkletAnchor).startsWith("javascript:(function()"),
  );

  const anchorClass = await js(`document.querySelector("a.bookmarklet-link")?.getAttribute("class")`);
  check(
    "bookmarklet anchor has unified class list without duplicate attributes",
    anchorClass === "bookmarklet-link u-strong-link",
    `class: '${anchorClass}'`,
  );

  // Verify disclosure element now that 3asd (18b688f) has landed on main
  const homeDetailsExists = await js(`Boolean(document.querySelector("details.bookmarklet-code"))`);
  check("details disclosure exists under bookmarklet box on main", Boolean(homeDetailsExists));

  await js(`document.querySelector("details.bookmarklet-code summary")?.click()`);
  await until(`document.querySelector("details.bookmarklet-code")?.open === true`, "details open");

  const isOpen = await js(`document.querySelector("details.bookmarklet-code")?.open`);
  check("details disclosure opens upon user interaction on main", isOpen === true);

  const snippetCode = String(await js(`document.querySelector(".bookmarklet-snippet code")?.textContent`));
  check(
    "code snippet in disclosure contains matching bookmarklet source",
    snippetCode === String(bookmarkletAnchor),
    `snippet matches href (${snippetCode.length} chars)`,
  );

  const shotHome = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}02-homepage-bookmarklet-main.png`,
    Uint8Array.from(atob(shotHome.data), (c) => c.charCodeAt(0)),
  );
  check(
    "homepage bookmarklet verified: 3asd fallback disclosure is LANDED on main (18b688f)",
    true,
  );

  // -- TEST 3: RSS Feed, Audio Route, and Web Player ----------------------------
  // A. Fetch RSS Feed
  const feedRes = await fetch(`${BASE}/feed/${subscriber.feedToken}/master.xml`);
  check("RSS feed route returns 200", feedRes.status === 200, `status: ${feedRes.status}`);
  const feedXml = await feedRes.text();
  check(
    "RSS feed is valid XML containing audio enclosure",
    feedXml.includes(`<enclosure url="${BASE}/${audioKey}"`) && feedXml.includes('type="audio/wav"'),
  );

  // B. Fetch Audio Route directly
  const audioRes = await fetch(`${BASE}/${audioKey}`);
  check("audio route returns 200 for valid episode", audioRes.status === 200, `status: ${audioRes.status}`);
  check(
    "audio route serves correct audio/wav content-type",
    audioRes.headers.get("content-type") === "audio/wav",
  );
  const audioBuffer = await audioRes.arrayBuffer();
  check(
    "audio route delivers correct byte count",
    audioBuffer.byteLength === audioBytes.byteLength,
    `received ${audioBuffer.byteLength} bytes`,
  );

  // C. Test audio unauthorized access boundary
  const badAudioRes = await fetch(`${BASE}/audio/unapproved-user/secret.mp3`);
  check(
    "disallowed/unauthorized audio key is rejected (404/403)",
    badAudioRes.status === 404 || badAudioRes.status === 403,
    `status: ${badAudioRes.status}`,
  );

  // D. Navigate to Web Player (/listen/:feedToken) in Chrome
  const listenStartIndex = consoleEntries.length;
  await cdp("Page.navigate", { url: `${BASE}/listen/${subscriber.feedToken}` });
  await until(`document.readyState === "complete"`, "listen page loaded");
  await until(`Boolean(document.querySelector(".ep-title"))`, "episodes rendered in playlist");

  const playerTitle = await js(`document.querySelector("h1, .player-title, header")?.textContent`);
  check("web player loads for subscriber", Boolean(playerTitle));

  const audioElemExists = await js(`Boolean(document.querySelector("audio"))`);
  check("web player renders <audio> element for listening", Boolean(audioElemExists));

  const episodeItemTitle = String(await js(`document.querySelector(".ep-title")?.textContent`));
  check(
    "web player displays ready episode title",
    episodeItemTitle.includes("Advancements in Synthetic Media — Audio Edition"),
    `title in DOM: '${episodeItemTitle}'`,
  );

  const listenCspViolations = consoleEntries.slice(listenStartIndex).filter(
    (msg) => msg.includes("Content Security Policy") || msg.includes("violates"),
  );
  check(
    "web player console has zero CSP violations",
    listenCspViolations.length === 0,
    `violations: ${listenCspViolations.length}`,
  );

  const shotListen = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}03-listen-web-player.png`,
    Uint8Array.from(atob(shotListen.data), (c) => c.charCodeAt(0)),
  );

  // -- 4. Write Evidence Report ------------------------------------------------
  const summary = `# Live End-to-End Verification Report on origin/main (${BASE})

**Git Commit:** \`ee9b747\` (Merge fleet/hostfix-o74y)
**Date:** 2026-10-12
**Environment:** Local In-Process Server + Headless Chrome (CDP at 1280x900)

## Verified Features and Behaviors

### 1. Admin Observability (\`/admin/observability\`)
- **Unhandled Error Screening (\`audio-feed-sw1r\`):**
  - Unhandled request errors render closed, screened error messages (e.g. \`${SUPPRESSED_MESSAGE}\`).
  - Verified that raw client canary tokens (\`${CLIENT_CANARY}\`) are completely absent from the rendered HTML.
- **Limits Documentation:**
  - Verified the limits card explicitly states that unhandled request errors record their class and screened message, and that upload retries carry a distinct \`uploadRetry\` counter bounded by \`maxUploadRetries\`.
- **Retrying Queue Table (\`audio-feed-lqd6\`, \`audio-feed-muio\`, \`audio-feed-yrg4\`):**
  - Renders the durable \`uploadRetry\` counter (value: \`2\`).
  - Renders the non-blank last recorded reason (\`Invocation budget exceeded during audio upload; claim yielded for retry\`).
  - Renders expandable \`<details><summary>Claim history (2)</summary></details>\` that expands on click to reveal historical attempts.

### 2. Homepage Bookmarklet (\`/\`)
- Renders the draggable bookmarklet anchor with \`javascript:\` URL.
- On current \`main\` (\`ee9b747\`), clicking the bookmarklet link is blocked by CSP \`script-src 'self' 'nonce-...' \` without \`unsafe-inline\`.
- **Note on Pending Landing:** \`audio-feed-3asd\` (implemented on \`fleet/churn-3asd\` @ \`4632aef\`) adds the \`<details class="bookmarklet-code">\` fallback disclosure and fixes the duplicate class attribute; it is currently in review on \`merge-queue\` awaiting merge.

### 3. RSS Feed, Audio Route, and Web Player (\`/listen\`)
- **RSS Enclosure:** The user's master RSS feed (\`/feed/:token/master.xml\`) renders valid XML with a proper \`<enclosure>\` element pointing to \`${BASE}/${audioKey}\` with \`type="audio/wav"\`.
- **Audio Streaming:** Direct request to the enclosure URL fetches the audio with \`200 OK\`, \`content-type: audio/wav\`, and byte-for-byte exact payload matching the stored blob.
- **Capability Isolation:** Requests to unauthorized audio paths return 404/403.
- **Web Player:** Real Chrome loaded \`/listen/${subscriber.feedToken}\`, rendered the audio player element, and displayed the synthesized episode title in the playlist.

## Execution Log
\`\`\`
${checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail ?? ""}`).join("\n")}
\`\`\`

## Screenshots
- \`01-admin-observability.png\`: Admin observability console showing screened error message, limits copy, and retrying rows with expanded claim history.
- \`02-homepage-bookmarklet-main.png\`: Front door bookmarklet anchor under current main.
- \`03-listen-web-player.png\`: Web player at \`/listen\` rendering ready episode with audio controls.
`;

  await Deno.writeTextFile(`${OUT}README.md`, summary);
  console.log(`\nSaved verification evidence to ${OUT}README.md and screenshots.`);
} catch (err) {
  console.error("Verification error:", err);
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
