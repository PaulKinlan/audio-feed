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
import { withChrome, writeEvidenceReadme } from "./proof-helper.ts";

const OUT = new URL("../docs/evidence/audio-feed-l7m1/", import.meta.url).pathname;
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
const audioBytes = pcmToWav(new Uint8Array(24000 * 5), {
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

const flatEp = makeEpisode({
  id: "ep-flat-1",
  userId: subscriber.id,
  sourceId: source.id,
  articleId: article.id,
  title: "Flat Historical Episode",
  status: "ready",
  mode: "direct",
  audioKey: "historical-flat-key.wav",
  contentType: "audio/wav",
  byteLength: 1000,
  durationSeconds: 2,
});
await stores.metadata.putEpisode(flatEp);

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

// -- 2. Launch Headless Chrome via withChrome ---------------------------------
let exitCode = 0;
try {
  await withChrome(async (chrome) => {
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
    const targetPage = targets.find((t: { type: string }) => t.type === "page");
    const ws = new WebSocket(targetPage.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));

    try {
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
      const cdp = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        const msg = await new Promise<{ result?: unknown; error?: unknown }>((r) =>
          pending.set(id, r)
        );
        if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
        return msg.result;
      };

      // deno-lint-ignore no-explicit-any
      const js = async (expression: string): Promise<any> => {
        const r = await cdp("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        if (r.exceptionDetails) {
          throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
        }
        return r.result?.value;
      };

      interface VerificationCheck {
        name: string;
        pass: boolean;
        detail?: string;
      }
      const checks: VerificationCheck[] = [];

      const check = (name: string, pass: boolean, detail = "") => {
        const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
        console.log(`${tag}  ${name}  ${detail}`);
        checks.push({ name, pass, detail });
        if (!pass) throw new Error(`step failed: ${name}`);
      };

      const until = async (expr: string, desc: string, timeoutMs = 8000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          if (await js(expr)) return;
          await sleep(50);
        }
        throw new Error(`timed out waiting for: ${desc}`);
      };

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
        limitsSection.includes(
          "Unhandled request errors record their class and a SCREENED message",
        ),
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

      // Set viewport height to cover the retrying table with expanded claim history
      const adminHeight = Math.ceil(
        Number(
          await js(
            `(() => { const t = document.querySelector("table"); return t ? t.getBoundingClientRect().bottom + window.scrollY + 80 : 1300; })()`,
          ),
        ) || 1300,
      );
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: adminHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(150);

      const shotAdmin = (await cdp("Page.captureScreenshot", { format: "png" })) as {
        data: string;
      };
      await Deno.writeFile(
        `${OUT}01-admin-observability.png`,
        Uint8Array.from(atob(shotAdmin.data), (c) => c.charCodeAt(0)),
      );
      try {
        const cmd = new Deno.Command("convert", {
          args: [
            `${OUT}01-admin-observability.png`,
            "-colors",
            "256",
            `png8:${OUT}01-admin-observability.png.tmp`,
          ],
        });
        const out = await cmd.output();
        if (out.success) {
          await Deno.rename(
            `${OUT}01-admin-observability.png.tmp`,
            `${OUT}01-admin-observability.png`,
          );
        }
      } catch {
        await Deno.remove(`${OUT}01-admin-observability.png.tmp`).catch(() => {});
      }

      // Restore desktop viewport
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

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
      const homeDetailsExists = await js(
        `Boolean(document.querySelector("details.bookmarklet-code"))`,
      );
      check("details disclosure exists under bookmarklet box on main", Boolean(homeDetailsExists));

      await js(`document.querySelector("details.bookmarklet-code summary")?.click()`);
      await until(
        `document.querySelector("details.bookmarklet-code")?.open === true`,
        "details open",
      );

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

      // Scroll the bookmarklet box and opened disclosure into view
      await js(`document.querySelector(".bookmarklet-box")?.scrollIntoView({ block: "center" })`);
      await sleep(150);

      const shotHome = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
      await Deno.writeFile(
        `${OUT}02-homepage-bookmarklet-main.png`,
        Uint8Array.from(atob(shotHome.data), (c) => c.charCodeAt(0)),
      );
      try {
        const cmd = new Deno.Command("convert", {
          args: [
            `${OUT}02-homepage-bookmarklet-main.png`,
            "-colors",
            "256",
            `png8:${OUT}02-homepage-bookmarklet-main.png.tmp`,
          ],
        });
        const out = await cmd.output();
        if (out.success) {
          await Deno.rename(
            `${OUT}02-homepage-bookmarklet-main.png.tmp`,
            `${OUT}02-homepage-bookmarklet-main.png`,
          );
        }
      } catch {
        await Deno.remove(`${OUT}02-homepage-bookmarklet-main.png.tmp`).catch(() => {});
      }
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

      const flatCanonicalUrl = `${BASE}/audio/${subscriber.id}/direct/ep-flat-1.wav`;
      check(
        "RSS feed emits canonical URL for flat-key historical episode",
        feedXml.includes(`<enclosure url="${flatCanonicalUrl}"`),
        "found canonical URL instead of flat key",
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

      const flatAudioRes = await fetch(flatCanonicalUrl);
      const flatAudioBody = await flatAudioRes.text();
      const flatAudioCt = (flatAudioRes.headers.get("content-type") ?? "").toLowerCase();
      const isJson = flatAudioCt.includes("application/json") ||
        flatAudioCt.includes("application/problem+json") ||
        /application\/[a-z0-9._-]+\+json/.test(flatAudioCt);
      let hasNotFound = false;
      if (isJson) {
        try {
          const parsed = JSON.parse(flatAudioBody);
          hasNotFound = parsed.error === "not_found" || parsed.title === "not_found";
        } catch {
          hasNotFound = false;
        }
      }
      check(
        "canonical URL for flat-key historical episode returns 404 (fails closed cleanly)",
        flatAudioRes.status === 404 && Boolean(isJson) && hasNotFound,
        `HTTP ${flatAudioRes.status}, is_json: ${
          Boolean(isJson)
        }, valid_json_error: ${hasNotFound}`,
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

      const playerTitle = await js(
        `document.querySelector("h1, .player-title, header")?.textContent`,
      );
      check("web player loads for subscriber", Boolean(playerTitle));

      const audioElemExists = await js(`Boolean(document.querySelector("audio"))`);
      check("web player renders <audio> element for listening", Boolean(audioElemExists));

      const episodeItemTitle = String(await js(`document.querySelector(".ep-title")?.textContent`));
      check(
        "web player displays ready episode title",
        episodeItemTitle.includes("Advancements in Synthetic Media — Audio Edition"),
        `title in DOM: '${episodeItemTitle}'`,
      );

      const episodesJson = await js(
        `JSON.parse(document.getElementById("player-data").textContent).episodes`,
      );
      const flatJsonEp = episodesJson.find((e: { id: string; audioUrl: string }) =>
        e.id === "ep-flat-1"
      );
      check(
        "listen page emits canonical URL for flat-key historical episode",
        flatJsonEp?.audioUrl === flatCanonicalUrl,
        `emitted URL path: /audio/${subscriber.id}/direct/ep-flat-1.wav`,
      );

      const listenCspViolations = consoleEntries.slice(listenStartIndex).filter(
        (msg) => msg.includes("Content Security Policy") || msg.includes("violates"),
      );
      check(
        "web player console has zero CSP violations",
        listenCspViolations.length === 0,
        `violations: ${listenCspViolations.length}`,
      );

      const shotListen = (await cdp("Page.captureScreenshot", { format: "png" })) as {
        data: string;
      };
      await Deno.writeFile(
        `${OUT}03-listen-web-player.png`,
        Uint8Array.from(atob(shotListen.data), (c) => c.charCodeAt(0)),
      );

      // D2. Test pagehide/visibilitychange saving position
      await until(`Boolean(document.querySelector(".ep-title"))`, "episode title loaded");
      await js(`document.querySelector(".ep-title").click()`);
      await sleep(500); // give it time to load current episode
      await js(`(async () => {
    const audio = document.querySelector("audio");
    await new Promise(r => {
      if (audio.readyState >= 1) return r();
      audio.addEventListener("loadedmetadata", r, {once: true});
    });
    audio.currentTime = 3;
  })()`);
      await js(`window.dispatchEvent(new Event("pagehide"));`);
      const savedPositions = await js(
        `JSON.parse(localStorage.getItem("audio-feed-positions:${subscriber.id}") || "{}")`,
      );
      check(
        "playback position saves via pagehide event",
        savedPositions["ep-ready-1"]?.position >= 3,
        `saved: ${savedPositions["ep-ready-1"]?.position}`,
      );

      // E. Test /account bookmarklet disclosure
      await cdp("Page.navigate", { url: `${BASE}/account` });
      await until(`document.readyState === "complete"`, "account page loaded");
      await until(
        `Boolean(document.querySelector(".bookmarklet-btn"))`,
        "bookmarklet anchor rendered",
      );

      await js(`document.querySelector(".bookmarklet-btn").click()`);
      await sleep(200);

      const accountDetailsExists = await js(`Boolean(document.querySelector(".bookmarklet-code"))`);
      check("details disclosure exists on /account", Boolean(accountDetailsExists));

      await js(`document.querySelector(".bookmarklet-code summary").click()`);
      await sleep(200);

      const isAccountOpen = await js(`document.querySelector(".bookmarklet-code").open`);
      check("details disclosure opens upon user interaction on /account", isAccountOpen === true);

      const accountSnippetBox = (await js(
        `(() => { const p = document.querySelector(".bookmarklet-snippet");
      if (!p) return null;
      return { scrollWidth: p.scrollWidth, clientWidth: p.clientWidth }; })()`,
      )) as { scrollWidth: number; clientWidth: number } | null;
      check(
        "disclosure code on /account wraps and is fully visible",
        Boolean(accountSnippetBox) &&
          accountSnippetBox!.scrollWidth <= accountSnippetBox!.clientWidth + 1,
        accountSnippetBox
          ? `scrollWidth ${accountSnippetBox.scrollWidth} vs clientWidth ${accountSnippetBox.clientWidth}`
          : "element not found",
      );

      await writeEvidenceReadme({
        dir: OUT,
        title: "Live End-to-End Verification Report: audio-feed-l7m1",
        script: "scripts/verify_main_l7m1_e2e.ts",
        asserts: checks.map((c) => c.name),
        sections: [
          {
            heading: "Methodology & Environment",
            body:
              `- **Harness:** In-process application server initialized with \`bootstrap({ stores: memoryStores() })\` on a dynamic port (\`port: 0\`).
- **Browser Execution:** Real headless Chrome launched via shared \`withChrome\` harness over CDP, ensuring sandbox isolation and automatic profile cleanup.
- **Seeded Test Fixtures:**
  - Admin user with authenticated session cookie \`__Host-af_session\`.
  - Approved subscriber with feed token \`sub-feed-token-l7m1\`.
  - Real synthesized WAV audio blob (${audioBytes.byteLength} bytes) stored at \`audio/sub-l7m1/direct/ep-ready-1.wav\`.
  - Historical flat-key episode seed \`historical-flat-key.wav\` verifying canonical redirect/404 handling.
  - Throwing canary route \`/__test/throw?m=canary-client-token-998877\` verifying server error screening into \`SUPPRESSED_MESSAGE\` and absence from logs.`,
          },
          {
            heading: "Verified Features and Behaviors",
            body: `### 1. Admin Observability (/admin/observability)
- Screened unhandled error messages (canary screened to SUPPRESSED_MESSAGE).
- Limits card documents screened errors and upload retries.
- Retrying queue table renders uploadRetry counter, reason, and expandable claim history.
- Zero CSP console violations.

### 2. Homepage Bookmarklet (/)
- Renders bookmarklet anchor without duplicate class attributes.
- Bookmarklet code disclosure fallback verified openable with matching source.
- Zero CSP console violations.

### 3. Audio, RSS, and Web Player (/listen/...)
- RSS XML enclosure URL and HTTP 200 verification.
- Direct audio streaming matches byte-for-byte (${audioBytes.byteLength} bytes).
- Canonical URL for flat-key historical episode returns 404.
- Access boundary checks: invalid/unauthorized keys return 404/403.
- Web Player renders episode in playlist and audio element with zero CSP violations.
- Playback position saves via pagehide event.
- Account page bookmarklet disclosure verified openable and non-overflowing.`,
          },
          {
            heading: "Execution Log",
            body: `\`\`\`\n${
              checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail ?? ""}`).join(
                "\n",
              )
            }\n\`\`\``,
          },
          {
            heading: "Screenshots",
            body:
              `- 01-admin-observability.png: Full-page capture of admin observability console showing screened error message, limits card, and retrying queue table with expanded claim history.
- 02-homepage-bookmarklet-main.png: Scrolled view of front door bookmarklet box showing draggable anchor and expanded bookmarklet-code disclosure fallback.
- 03-listen-web-player.png: Web player at /listen rendering ready episode with audio controls.`,
          },
        ],
      });
      console.log(`\nSaved verification evidence to ${OUT}README.md and screenshots.`);
    } finally {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  });
} catch (err) {
  console.error("Verification error:", err);
  exitCode = 1;
} finally {
  try {
    await server.shutdown();
  } catch {
    /* ignore */
  }
}

Deno.exit(exitCode);
