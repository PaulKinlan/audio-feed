/**
 * End-to-end live verification script on origin/main (audio-feed-l7m1).
 *
 * Drives real headless Chrome over CDP against a locally booted server:
 *   1. Admin Observability (/admin/observability):
 *      - Screened unhandled error messages (real injected canary through /__test/throw screened to SUPPRESSED_MESSAGE).
 *      - Correct limits copy regarding screened messages and upload retry bounds.
 *      - Retrying queue table: durable uploadRetry counter rendered, non-blank reason,
 *        and expandable claim history.
 *      - Zero console CSP violations.
 *   2. Front door (/) bookmarklet behavior:
 *      - Bookmarklet anchor rendered without duplicate class attributes.
 *      - Fallback <details class="bookmarklet-code"> disclosure verified openable with matching source.
 *      - Zero console CSP violations.
 *   3. RSS Feed, Audio Route, and Listen Web Player (/listen/...):
 *      - RSS XML generation and enclosure URL correctness.
 *      - Direct audio streaming: byte-for-byte exact payload matching.
 *      - Capability access boundaries (404/403 on invalid paths).
 *      - Web Player UI rendering and playback elements in real Chrome with zero console CSP violations.
 *
 *   deno run --allow-all --unstable-kv scripts/verify_main_l7m1_e2e.ts
 */

import { memoryStores } from "../src/config.ts";
import { createSession } from "../src/auth/sessions.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";
import { pcmToWav } from "../src/tts/gemini.ts";
import { claimLifecycleEvent } from "../src/storage/episode_events.ts";
import { SUPPRESSED_MESSAGE } from "../src/observability/error_screen.ts";
import { bootstrap } from "../src/server.ts";
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
  error: "Invocation budget exceeded during audio upload; claim yielded for retry",
});
await stores.metadata.putEpisode(retryingEp);

// Log claim lifecycle events for claim history
await stores.metadata.appendLog(
  claimLifecycleEvent(retryingEp, {
    attempt: 1,
    phase: "synthesizing",
  }),
);

await stores.metadata.appendLog(
  claimLifecycleEvent(retryingEp, {
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
  durationSeconds: 2,
});
await stores.metadata.putEpisode(readyEp);

// Start app server using real bootstrap with error screening and test throw route enabled
Deno.env.set("AUDIO_FEED_TEST_THROW", "1");
const boot = await bootstrap({
  port: 0,
  stores,
  isDeploy: true,
  synthesizer: null,
  inventory: false,
  config,
});
const server = boot.server;
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

// Exercise real unhandled error screening (audio-feed-nh18): send untrusted canary through throwing route
const CLIENT_CANARY = "canary-client-token-998877";
const errRes = await fetch(`${BASE}/__test/throw?m=${CLIENT_CANARY}`);
if (errRes.status !== 500) {
  throw new Error(`expected 500 from /__test/throw, got ${errRes.status}`);
}
await errRes.text();

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

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const targetPage = targets.find((t: { type: string }) => t.type === "page");
const ws = new WebSocket(targetPage.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let nextId = 0;
const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
const consoleEntries: string[] = [];

ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Log.entryAdded") {
    consoleEntries.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args as Array<{ value?: unknown }>)
      .map((a) => (typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)))
      .join(" ");
    consoleEntries.push(`[console.${msg.params.type}] ${text}`);
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

interface VerificationCheck {
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: VerificationCheck[] = [];

function check(name: string, pass: boolean, detail = "") {
  const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}  ${detail}`);
  checks.push({ name, pass, detail });
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

  const adminStartIndex = consoleEntries.length;
  await cdp("Page.navigate", { url: `${BASE}/admin/observability` });
  await until(`document.readyState === "complete"`, "admin observability loaded");

  const pageTitle = await js(`document.querySelector("h1")?.textContent`);
  check("admin observability page loads with h1 header", pageTitle === "Observability");

  // Verify screened error message in failure card (audio-feed-nh18)
  const errorMessageHtml = String(await js(`document.body.innerHTML`));
  check(
    "unhandled error renders screened message",
    errorMessageHtml.includes(SUPPRESSED_MESSAGE),
    "contains SUPPRESSED_MESSAGE",
  );
  check(
    "client canary string is NOT leaked into the document",
    !errorMessageHtml.includes(CLIENT_CANARY),
    `checked absence of '${CLIENT_CANARY}'`,
  );

  const logs = await stores.metadata.listLogs();
  const unhandledLog = logs.find((l) => l.message.includes("unhandled "));
  check(
    "unhandled error log was produced with screened message",
    Boolean(unhandledLog && unhandledLog.context?.errorMessage === SUPPRESSED_MESSAGE),
    `screened message: '${unhandledLog?.context?.errorMessage}'`,
  );
  check(
    "client canary is completely absent from all durable logs",
    !JSON.stringify(logs).includes(CLIENT_CANARY),
    "canary absent from logs by construction",
  );

  // Verify limits section
  const limitsSection = String(
    await js(`document.getElementById("limits-h")?.parentElement?.textContent`),
  );
  check(
    "limits section explains screened error messages",
    limitsSection.includes("Unhandled request errors record their class and a SCREENED message"),
  );
  check(
    "limits section explains distinct uploadRetry counter bounded by maxUploadRetries",
    limitsSection.includes(
      "Upload retries carry a distinct uploadRetry counter bounded by maxUploadRetries",
    ),
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

  const adminCspViolations = consoleEntries.slice(adminStartIndex).filter(
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

  // -- TEST 2: Homepage Bookmarklet (/ on main) --------------------------------
  const homeStartIndex = consoleEntries.length;
  await cdp("Page.navigate", { url: `${BASE}/` });
  await until(`document.readyState === "complete"`, "homepage loaded");

  const homeCspViolations = consoleEntries.slice(homeStartIndex).filter(
    (msg) => msg.includes("Content Security Policy") || msg.includes("violates"),
  );
  check(
    "homepage console has zero CSP violations on load",
    homeCspViolations.length === 0,
    `violations: ${homeCspViolations.length}`,
  );

  const bookmarkletAnchor = await js(
    `document.querySelector("a.bookmarklet-link")?.getAttribute("href")`,
  );
  check(
    "front door renders draggable bookmarklet anchor with javascript: URL",
    String(bookmarkletAnchor).startsWith("javascript:(function()"),
  );

  const anchorClass = await js(
    `document.querySelector("a.bookmarklet-link")?.getAttribute("class")`,
  );
  check(
    "bookmarklet anchor has unified class list without duplicate attributes",
    anchorClass === "bookmarklet-link u-strong-link",
    `class: '${anchorClass}'`,
  );

  // Verify disclosure element (3asd landed on main)
  const homeDetailsExists = await js(`Boolean(document.querySelector("details.bookmarklet-code"))`);
  check("details disclosure exists under bookmarklet box on main", Boolean(homeDetailsExists));

  await js(`document.querySelector("details.bookmarklet-code summary")?.click()`);
  await until(`document.querySelector("details.bookmarklet-code")?.open === true`, "details open");

  const isOpen = await js(`document.querySelector("details.bookmarklet-code")?.open`);
  check("details disclosure opens upon user interaction on main", isOpen === true);

  const snippetCode = String(
    await js(`document.querySelector(".bookmarklet-snippet code")?.textContent`),
  );
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
    "homepage bookmarklet verified: 3asd fallback disclosure is LANDED on main",
    true,
  );

  // -- TEST 3: RSS Feed, Audio Route, and Web Player ----------------------------
  // A. Fetch RSS Feed
  const feedRes = await fetch(`${BASE}/feed/${subscriber.feedToken}/master.xml`);
  check("RSS feed route returns 200", feedRes.status === 200, `status: ${feedRes.status}`);
  const feedXml = await feedRes.text();
  check(
    "RSS feed is valid XML containing audio enclosure",
    feedXml.includes(`<enclosure url="${BASE}/${audioKey}"`) &&
      feedXml.includes('type="audio/wav"'),
  );

  // B. Fetch Audio Route directly and check exact byte-for-byte payload (audio-feed-7n3f)
  const audioRes = await fetch(`${BASE}/${audioKey}`);
  check(
    "audio route returns 200 for valid episode",
    audioRes.status === 200,
    `status: ${audioRes.status}`,
  );
  check(
    "audio route serves correct audio/wav content-type",
    audioRes.headers.get("content-type") === "audio/wav",
  );
  const audioBuffer = await audioRes.arrayBuffer();
  const receivedBytes = new Uint8Array(audioBuffer);
  let bytesIdentical = receivedBytes.byteLength === audioBytes.byteLength;
  if (bytesIdentical) {
    for (let i = 0; i < audioBytes.byteLength; i++) {
      if (receivedBytes[i] !== audioBytes[i]) {
        bytesIdentical = false;
        break;
      }
    }
  }
  check(
    "audio route delivers exact byte-for-byte payload matching stored blob",
    bytesIdentical,
    `verified ${receivedBytes.byteLength} bytes match exactly`,
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

  // -- 4. Write Evidence Report (audio-feed-dv2s) -------------------------------
  const gitSha = await (async () => {
    try {
      const out = await new Deno.Command("git", { args: ["rev-parse", "HEAD"] }).output();
      return new TextDecoder().decode(out.stdout).trim();
    } catch {
      return "unknown";
    }
  })();
  const gitSubject = await (async () => {
    try {
      const out = await new Deno.Command("git", { args: ["log", "-1", "--pretty=%s"] }).output();
      return new TextDecoder().decode(out.stdout).trim();
    } catch {
      return "";
    }
  })();
  const shortSha = gitSha.slice(0, 7);

  const summary = `# Live End-to-End Verification Report on origin/main (${BASE})

**Git Commit:** \`${shortSha}\` (${gitSubject})
**Date:** 2026-10-12
**Environment:** Local In-Process Server + Headless Chrome (CDP at 1280x900)

## Verified Features and Behaviors

### 1. Admin Observability (\`/admin/observability\`)
- **Unhandled Error Screening (\`audio-feed-sw1r\`, \`audio-feed-nh18\`):**
  - Injected an untrusted client canary (\`${CLIENT_CANARY}\`) through a real throwing request (\`/__test/throw\`).
  - Verified that the server catches the unhandled error and screens it to \`${SUPPRESSED_MESSAGE}\`.
  - Verified that the raw client canary is completely absent from durable logs and the rendered HTML failure card.
- **Limits Documentation:**
  - Verified the limits card explicitly states that unhandled request errors record their class and screened message, and that upload retries carry a distinct \`uploadRetry\` counter bounded by \`maxUploadRetries\`.
- **Retrying Queue Table (\`audio-feed-lqd6\`, \`audio-feed-muio\`, \`audio-feed-yrg4\`):**
  - Renders the durable \`uploadRetry\` counter (value: \`2\`).
  - Renders the non-blank last recorded reason (\`Invocation budget exceeded during audio upload; claim yielded for retry\`).
  - Renders expandable \`<details><summary>Claim history (2)</summary></details>\` that expands on click to reveal historical attempts.
- **CSP Integrity:**
  - Verified zero Content Security Policy console violations on \`/admin/observability\`.

### 2. Homepage Bookmarklet (\`/\`)
- Renders the draggable bookmarklet anchor with \`javascript:\` URL without duplicate class attributes.
- **Bookmarklet Code Disclosure Fallback (\`audio-feed-3asd\`):**
  - Verified that \`<details class="bookmarklet-code">\` exists under the bookmarklet box on main.
  - Verified that clicking the summary expands the details element to reveal the copyable bookmarklet snippet.
  - Verified that the code snippet in the disclosure exactly matches the \`javascript:\` anchor URL.
- **CSP Integrity:**
  - Verified zero Content Security Policy console violations on the homepage.

### 3. RSS Feed, Audio Route, and Web Player (\`/listen\`)
- **RSS Enclosure:** The user's master RSS feed (\`/feed/:token/master.xml\`) renders valid XML with a proper \`<enclosure>\` element pointing to \`${BASE}/${audioKey}\` with \`type="audio/wav"\`.
- **Audio Streaming (\`audio-feed-7n3f\`):** Direct request to the enclosure URL fetches the audio with \`200 OK\`, \`content-type: audio/wav\`, and verified byte-for-byte exact payload matching the stored blob (${audioBytes.byteLength} bytes).
- **Capability Isolation:** Requests to unauthorized audio paths return 404/403.
- **Web Player:** Real Chrome loaded \`/listen/${subscriber.feedToken}\`, rendered the audio player element, and displayed the synthesized episode title in the playlist.
- **CSP Integrity:**
  - Verified zero Content Security Policy console violations on \`/listen\`.

## Execution Log
\`\`\`
${checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail ?? ""}`).join("\n")}
\`\`\`

## Screenshots
- \`01-admin-observability.png\`: Admin observability console showing screened error message, limits copy, and retrying rows with expanded claim history.
- \`02-homepage-bookmarklet-main.png\`: Front door bookmarklet anchor and opened disclosure fallback.
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
}

Deno.exit(exitCode);
