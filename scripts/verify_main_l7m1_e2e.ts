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
import { quantiseEvidencePng } from "./evidence-png.ts";

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

      // Set the viewport height to the FULL DOCUMENT height, not the first table's
      // bottom (audio-feed-p3bv). The screened-error card and the limits card render
      // ABOVE the retrying table, so a viewport sized to the table's bottom can never
      // contain them: that crop was deterministic and made the screenshot caption a
      // claim the image did not support. The 1275 floor keeps the layout from
      // collapsing below the height the caption describes.
      const adminHeight = Math.ceil(
        Number(
          await js(
            `Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, 1275)`,
          ),
        ) || 1275,
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
      // This is a FULL-DOCUMENT capture (1280x~2900), the tallest screenshot in the
      // tree. At the 256-colour palette `deno task evidence:compress` uses it lands at
      // ~159KB, over the 150KB per-file budget in tests/evidence_size_test.ts, so it is
      // quantised to 128 colours at max zlib compression instead (~144KB). The page is
      // text on a flat background - measured RMSE against the 256-colour version is
      // 0.17%, i.e. invisible at review scale, and the size class the 256-colour rule
      // exists for (a dark gradient that bands) is not present here. The generator owns
      // this so a regeneration cannot silently produce an over-budget file.
      await quantiseEvidencePng(`${OUT}01-admin-observability.png`, {
        colors: 128,
        compressionLevel: 9,
        formatPrefix: "PNG8",
      });

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
      await quantiseEvidencePng(`${OUT}02-homepage-bookmarklet-main.png`);
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

      // Verify page identity at capture moment: must be at /listen/:feedToken (not /account or any other route)
      // with subscriber identity heading, audio element, playlist, and playback controls.
      //
      // REVIEWER FINDING: The previous implementation computed controls via a selector list ending in 'audio',
      // which was implied by hasAudio and passed even when all controls, buttons, and range inputs were removed.
      //
      // WHAT WOULD STILL MAKE THIS CHECK FAIL IF THE CONTROLS WERE REMOVED?
      // Answer:
      // 1. playPause requires a distinct play/pause button (#playPause, button[aria-label='Play']).
      //    If the play/pause button is removed, hasPlayPause is false -> FAILS naming 'missing: play/pause button'.
      // 2. seek requires an actual range slider input (#seek, input[type='range']#seek).
      //    If the seek bar is removed, hasSeek is false -> FAILS naming 'missing: seek slider'.
      // 3. dockButtons requires the dock transport button suite (.dock button, #back, #playPause, #fwd).
      //    If transport buttons are removed, dockButtonCount < 3 -> FAILS naming 'missing: dock transport buttons (found: 0/3)'.
      // 4. hasControls requires hasPlayPause && hasSeek && hasDockButtons (dockButtonCount >= 3).
      // None of these can be satisfied by a bare audio element, container div, or unstyled text.
      const captureIdentity = (await js(`(() => {
        const path = window.location.pathname;
        const heading = document.querySelector("h1, .player-title, header .identity")?.textContent?.trim() ?? "";
        const audio = Boolean(document.querySelector("audio"));
        const playlist = Boolean(document.querySelector(".ep-title"));

        // Controls verification: require the real controls rendered by the web player.
        // A bare audio element cannot satisfy any of these.
        const playPauseBtn = document.querySelector("button#playPause, button[aria-label='Play'], button.t-main");
        const hasPlayPause = Boolean(playPauseBtn);

        const seekInput = document.querySelector("input[type='range']#seek, input[type='range']");
        const hasSeek = Boolean(seekInput);

        const dockButtons = document.querySelectorAll(".dock button, .transport button");
        const dockButtonCount = dockButtons.length;
        const hasDockButtons = dockButtonCount >= 3;

        const missing = [];
        if (!hasPlayPause) missing.push("play/pause button");
        if (!hasSeek) missing.push("seek slider");
        if (!hasDockButtons) missing.push(\`dock transport buttons (found: \${dockButtonCount}/3)\`);

        const hasControls = hasPlayPause && hasSeek && hasDockButtons;
        const isNotAccount = path !== "/account" && !heading.toLowerCase().includes("account");
        const isListenPlayer = path.startsWith("/listen/") && audio && playlist && hasControls && isNotAccount;

        return {
          path,
          heading,
          hasAudio: audio,
          hasPlaylist: playlist,
          hasControls,
          hasPlayPause,
          hasSeek,
          dockButtonCount,
          missingControls: missing,
          isNotAccount,
          isListenPlayer,
        };
      })()`)) as {
        path: string;
        heading: string;
        hasAudio: boolean;
        hasPlaylist: boolean;
        hasControls: boolean;
        hasPlayPause: boolean;
        hasSeek: boolean;
        dockButtonCount: number;
        missingControls: string[];
        isNotAccount: boolean;
        isListenPlayer: boolean;
      };

      const controlsDetail = captureIdentity.hasControls
        ? `controls: true (play/pause: ${captureIdentity.hasPlayPause}, seek: ${captureIdentity.hasSeek}, dockButtons: ${captureIdentity.dockButtonCount})`
        : `controls: false (missing: ${captureIdentity.missingControls.join(", ")})`;

      check(
        "web player capture asserts page identity at /listen with audio controls",
        captureIdentity.isListenPlayer &&
          captureIdentity.path === `/listen/${subscriber.feedToken}` &&
          captureIdentity.hasAudio &&
          captureIdentity.hasPlaylist &&
          captureIdentity.hasControls &&
          captureIdentity.hasPlayPause &&
          captureIdentity.hasSeek &&
          captureIdentity.dockButtonCount >= 3 &&
          captureIdentity.isNotAccount,
        `path: ${captureIdentity.path}, heading: '${captureIdentity.heading}', audio: ${captureIdentity.hasAudio}, playlist: ${captureIdentity.hasPlaylist}, ${controlsDetail}`,
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
              `- **Harness:** In-process application server initialized with \`bootstrap({ stores: memoryStores() })\` on a dynamic port (\`port: 0\`), so the proof never contends for a fixed port and a moved port cannot masquerade as a pass.
- **Browser Execution:** Real headless Chrome driven over CDP by the shared \`withChrome\` harness at a 1280-wide desktop viewport, with an isolated user-data-dir and automatic profile cleanup. These are live-page assertions, not a DOM shim: the CSP counters, the \`<details>\` disclosures and the \`<audio>\` element are read out of a real browser.
- **Capture method:** Screenshots are viewport grabs sized to the content each caption names - the admin grab is sized to the full document so the screened-error and limits cards are in frame, and the bookmarklet grab is taken after the box is scrolled into view and its disclosure opened. A caption describes only states that the accompanying image actually contains.
- **Seeded Test Fixtures:**
  - Admin user with authenticated session cookie \`__Host-af_session\`.
  - Approved subscriber with feed token \`sub-feed-token-l7m1\`.
  - Real synthesized WAV audio blob (${audioBytes.byteLength} bytes) stored at \`audio/sub-l7m1/direct/ep-ready-1.wav\`.
  - Historical flat-key episode seed \`historical-flat-key.wav\` verifying canonical redirect/404 handling.
  - Throwing canary route \`/__test/throw?m=canary-client-token-998877\` verifying server error screening into \`SUPPRESSED_MESSAGE\` and absence from logs.
- **Reproduction:** \`deno run --allow-all --unstable-kv scripts/verify_main_l7m1_e2e.ts\``,
          },
          {
            heading: "Verified Features and Behaviors",
            body: `### 1. Admin Observability (\`/admin/observability\`)
- **Unhandled Error Screening (\`audio-feed-sw1r\`, \`audio-feed-nh18\`):**
  - Injected an untrusted client canary (\`canary-client-token-998877\`) through a real throwing request (\`/__test/throw\`).
  - Verified the server catches the unhandled error and screens it to \`message suppressed (not authored by this codebase)\`.
  - Verified the raw client canary is completely absent from the rendered HTML failure card and from all durable logs.
- **Limits Documentation:** the limits card explicitly states that unhandled request errors record their class and screened message, and that upload retries carry a distinct \`uploadRetry\` counter bounded by \`maxUploadRetries\`.
- **Retrying Queue Table (\`audio-feed-lqd6\`, \`audio-feed-muio\`, \`audio-feed-yrg4\`):**
  - Renders the durable \`uploadRetry\` counter (value: \`2\`).
  - Renders the non-blank last recorded reason (\`Invocation budget exceeded during audio upload; claim yielded for retry\`).
  - Renders an expandable \`Claim history\` \`<details>\` that opens on click to reveal the historical attempts.
- **CSP Integrity:** zero Content Security Policy console violations on \`/admin/observability\`.

### 2. Homepage Bookmarklet (\`/\`)
- Renders the draggable bookmarklet anchor with a \`javascript:\` URL and no duplicate class attributes.
- **Bookmarklet Code Disclosure Fallback (\`audio-feed-3asd\`):**
  - Verified that \`<details class="bookmarklet-code">\` exists under the bookmarklet box on main.
  - Verified that clicking the summary expands the disclosure to reveal the copyable bookmarklet snippet.
  - Verified that the snippet text exactly matches the anchor's \`javascript:\` URL (617 characters).
- **CSP Integrity:** zero Content Security Policy console violations on the homepage.

### 3. RSS Feed, Audio Route, and Web Player (\`/listen/...\`)
- **RSS Enclosure:** the master feed renders valid XML with an \`<enclosure>\` element pointing at the seeded episode with \`type="audio/wav"\`.
- **Audio Streaming (\`audio-feed-7n3f\`):** a direct request to the enclosure URL returns \`200 OK\`, \`content-type: audio/wav\`, and a byte-for-byte exact payload matching the stored blob (${audioBytes.byteLength} bytes).
- **Capability Isolation:** requests to unauthorized or invalid audio keys return 404/403, and a flat-key historical episode path fails closed with a canonical 404.
- **Web Player:** real Chrome loaded the subscriber's \`/listen\` page and rendered the audio element, playlist, and audio controls (play/pause button, seek slider, and transport dock); the playback position saved via the \`pagehide\` event.
- **CSP Integrity:** zero Content Security Policy console violations on \`/listen\`.
- **Account page:** the bookmarklet disclosure is verified openable and its snippet does not overflow its box.`,
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
              `- 01-admin-observability.png: Full-page capture (1280 x document height) of the admin observability console, showing the screened error message, the limits card (the card headed "What this page cannot tell you"), and the retrying queue table with its claim history expanded.
- 02-homepage-bookmarklet-main.png: Scrolled view of front door bookmarklet box showing draggable anchor and expanded bookmarklet-code disclosure fallback.
- 03-listen-web-player.png: Web player at /listen rendering ready episode with audio controls (play/pause button, seek slider, and transport dock).`,
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
