/**
 * Browser proof: audio actually PLAYS end-to-end under the shipped `media-src`
 * policy when the blob store redirects playback to a CROSS-ORIGIN url (playback-proof).
 *
 * The unit row (tests/security_audit_test.ts) proves the HEADER permits the redirect
 * target. It never proves the thing a listener experiences: a `<audio>` element in a
 * real browser, on a page served with the real policy, taking audio.ts's 302 to a
 * cross-origin presigned URL and reaching a playing state. CSP re-evaluates `media-src`
 * against the redirect target, so a policy that omits the store origin is a dead
 * player even though the shell page loads perfectly.
 *
 * What this row asserts, with a real media element in headless Chrome:
 *   1. Precondition (not the claim): the served /listen page's `media-src` names the
 *      store origin, and a no-cors request to /audio/<key> takes the 302 to that origin.
 *   2. The browser FOLLOWED the redirect: the cross-origin media server received the
 *      element's request (it is a second origin, so only the browser can have sent it).
 *   3. The element ERRORED on nothing: `audio.error === null` and no `error` event.
 *   4. Zero CSP refusals: no `securitypolicyviolation` for media-src, and no security
 *      console entry naming media-src (both are captured and printed on failure).
 *   5. It PLAYS: `currentTime` advances between two samples and readyState >= 2
 *      (HAVE_CURRENT_DATA).
 *
 * Both servers are in-process and ephemeral; Chrome is closed in a finally, both
 * servers shut down in a finally, so nothing is left running.
 *
 *   AUDIOFEED_CHROME_BIN=/usr/bin/google-chrome \
 *     deno run --allow-all --unstable-kv scripts/playback-csp-browser-proof.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { audioBlobKey } from "../src/types.ts";
import { wav } from "./listen-harness.ts";
import { runProof, startInProcessServer, withChrome } from "./proof-helper.ts";
import { connectCdp } from "./proof-cdp.ts";

const TOKEN = "playback-proof-token";
const EPISODE_ID = "ep-1";
/** Six seconds of real PCM: long enough that currentTime must move, short enough to stay fast. */
const AUDIO: Uint8Array<ArrayBuffer> = wav(6) as Uint8Array<ArrayBuffer>;

interface MediaRequest {
  path: string;
  range: string | null;
  status: number;
}

await runProof("playback-proof", async (checker) => {
  const check = (name: string, pass: boolean, detail = "") => checker.check(name, pass, detail);

  // ---- The blob store's OTHER origin. A distinct port is a distinct origin to CSP and
  // to the browser, so this is the real cross-origin redirect shape (R2/S3 in production).
  const mediaRequests: MediaRequest[] = [];
  const mediaServer = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: () => {},
  }, (req) => {
    const url = new URL(req.url);
    const rangeHeader = req.headers.get("range");
    let status = 200;
    let body: Uint8Array<ArrayBuffer> = AUDIO;
    const headers: Record<string, string> = {
      "content-type": "audio/wav",
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    };
    const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim()) : null;
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : AUDIO.byteLength - 1;
      if (start < AUDIO.byteLength) {
        body = AUDIO.slice(start, Math.min(end, AUDIO.byteLength - 1) + 1);
        status = 206;
        headers["content-range"] = `bytes ${start}-${
          start + body.byteLength - 1
        }/${AUDIO.byteLength}`;
      }
    }
    mediaRequests.push({ path: url.pathname, range: rangeHeader, status });
    return new Response(req.method === "HEAD" ? null : body, { status, headers });
  });
  const MEDIA_ORIGIN = `http://127.0.0.1:${(mediaServer.addr as Deno.NetAddr).port}`;

  const stores = memoryStores();
  const config = { port: 0, publicBaseUrl: "", adminToken: "playback-proof-admin" };
  const ctx = { config, stores };
  const now = new Date().toISOString();

  await stores.metadata.putUser({
    id: "user-1",
    email: "paul@example.com",
    displayName: "Paul Kinlan",
    status: "approved",
    isAdmin: false,
    createdAt: now,
    feedToken: TOKEN,
  });
  await stores.metadata.putSource({
    id: "stratechery",
    userId: "user-1",
    title: "Stratechery",
    feedUrl: "https://stratechery.com/feed/",
    siteUrl: "https://stratechery.com/",
    modes: ["direct"],
    voices: {},
    createdAt: now,
  });
  await stores.metadata.putArticle({
    id: "article-ep-1",
    userId: "user-1",
    sourceId: "stratechery",
    url: "https://example.com/ep-1",
    title: "Aggregation theory and the shape the modern platform",
    author: "Ben Thompson",
    publishedAt: now,
    content: "Body text.",
    excerpt: "A short lead.",
    ingestedAt: now,
  });
  const audioKey = audioBlobKey({ userId: "user-1", id: EPISODE_ID, mode: "direct" }, "wav");
  await stores.blobs.put(audioKey, AUDIO, { contentType: "audio/wav" });
  await stores.metadata.putEpisode({
    id: EPISODE_ID,
    userId: "user-1",
    sourceId: "stratechery",
    sourceTitle: "Stratechery",
    articleId: "article-ep-1",
    mode: "direct",
    status: "ready",
    title: "Aggregation theory and the shape the modern platform",
    description: "A short lead.",
    audioKey,
    contentType: "audio/wav",
    durationSeconds: 6,
    byteLength: AUDIO.byteLength,
    createdAt: now,
    readyAt: now,
  });

  // The redirecting-store shape: url() is CROSS-ORIGIN and directUrlOrigin() names it, which
  // is exactly what the player pages now feed into media-src (audio-feed-327mm).
  stores.blobs.url = (key: string) => Promise.resolve(`${MEDIA_ORIGIN}/direct/${key}`);
  stores.blobs.directUrlOrigin = () => MEDIA_ORIGIN;

  const { fetch: appFetch } = createApp(
    ctx,
    createHandlers(ctx, {
      fetchArticle: (url) =>
        Promise.resolve({
          url,
          title: "Sample Article",
          author: "Sample Author",
          publishedAt: now,
          lead: "A test article lead.",
          body: "Article content.",
        }),
    }),
  );
  const app = startInProcessServer((req) => appFetch(req));
  const BASE = app.base;
  config.publicBaseUrl = BASE;

  try {
    // ---- Preconditions. Separated from the claim: these are the shipped header and the
    // route's redirect, both already pinned by the unit row. They must hold, or the
    // browser observation below would be about a shape the app does not ship.
    const pageRes = await appFetch(new Request(`${BASE}/listen/${TOKEN}`));
    const csp = pageRes.headers.get("content-security-policy") ?? "";
    const mediaSrc = /(?:^|;\s*)media-src ([^;]*)/u.exec(csp)?.[1]?.trim() ?? "";
    await pageRes.body?.cancel();
    check(
      "precondition: /listen's media-src names the blob store's cross-origin direct-URL origin",
      pageRes.status === 200 && mediaSrc === `'self' blob: ${MEDIA_ORIGIN}`,
      `status ${pageRes.status}, media-src "${mediaSrc}"`,
    );

    const audioProbe = await appFetch(
      new Request(`${BASE}/audio/${audioKey}`, { headers: { "sec-fetch-mode": "no-cors" } }),
    );
    const location = audioProbe.headers.get("location") ?? "";
    await audioProbe.body?.cancel();
    check(
      "precondition: a no-cors player request for the enclosure 302s to the store origin",
      audioProbe.status === 302 && new URL(location || "http://x.invalid").origin === MEDIA_ORIGIN,
      `status ${audioProbe.status}, location origin ${
        location ? new URL(location).origin : "(none)"
      }`,
    );

    await withChrome(async (chrome) => {
      const { cdp, js, until, ws } = await connectCdp(chrome.port);
      // Console + security log lines, for the failure output.
      const consoleLog: Array<{ level: string; text: string }> = [];
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data as string);
        if (msg.method === "Runtime.consoleAPICalled") {
          const text = (msg.params.args ?? [])
            .map((a: { value?: unknown; description?: string }) => a.value ?? a.description ?? "")
            .join(" ");
          consoleLog.push({ level: msg.params.type ?? "log", text });
        } else if (msg.method === "Log.entryAdded") {
          const entry = msg.params.entry ?? {};
          consoleLog.push({ level: entry.level ?? "log", text: entry.text ?? "" });
        }
      });

      try {
        await cdp("Page.enable");
        await cdp("Runtime.enable");
        await cdp("Log.enable");
        await cdp("Network.enable");
        // Installed before any page script: CSP refusals and media element events are recorded
        // from the document, so a blocked redirect is visible instead of silent.
        await cdp("Page.addScriptToEvaluateOnNewDocument", {
          source: `window.__cspViolations = [];
            document.addEventListener("securitypolicyviolation", (e) => {
              window.__cspViolations.push({
                directive: e.effectiveDirective,
                blockedURI: e.blockedURI,
                disposition: e.disposition,
                sample: e.sample,
              });
            });`,
        });
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
        await until(`document.readyState === "complete"`, "player page loaded", 15_000);
        await until(
          `document.querySelectorAll("#episodes .episode").length === 1`,
          "the seeded episode row rendered",
          15_000,
        );

        // Record element-level events so an error/decode block is named, not inferred.
        await js(`(() => {
          const a = document.getElementById("audio");
          window.__mediaEvents = [];
          for (const t of ["loadstart","loadedmetadata","loadeddata","canplay","playing","waiting","stalled","error","emptied","abort"]) {
            a.addEventListener(t, () => window.__mediaEvents.push({
              type: t, readyState: a.readyState, networkState: a.networkState,
              errorCode: a.error ? a.error.code : null, currentTime: a.currentTime,
            }));
          }
          return true;
        })()`);

        // The user action: press play on the row. Runtime.evaluate carries userGesture, so
        // autoplay policy does not confound the result.
        await js(
          `document.querySelector("#episodes .episode button[data-action='play']")?.click()`,
        );

        // Playback is asynchronous; poll rather than sleep a fixed guess.
        const startTime = Date.now();
        let advanced = false;
        while (Date.now() - startTime < 15_000) {
          advanced = await js(
            `(() => {
              const a = document.getElementById("audio");
              return !!a && (a.currentTime > 0 || a.readyState >= 2);
            })()`,
          );
          if (advanced) break;
          await new Promise((r) => setTimeout(r, 100));
        }

        const first = await js(`(() => {
          const a = document.getElementById("audio");
          return {
            src: a.src, currentTime: a.currentTime, readyState: a.readyState,
            networkState: a.networkState, paused: a.paused,
            errorCode: a.error ? a.error.code : null,
            errorMessage: a.error ? a.error.message : null,
            duration: a.duration,
          };
        })()`);

        // A second sample a moment later: currentTime must MOVE, not merely be non-zero.
        await new Promise((r) => setTimeout(r, 1200));
        const second = await js(`(() => {
          const a = document.getElementById("audio");
          return {
            currentTime: a.currentTime, readyState: a.readyState,
            networkState: a.networkState, paused: a.paused,
            errorCode: a.error ? a.error.code : null,
          };
        })()`);

        const mediaEvents = await js(`JSON.stringify(window.__mediaEvents ?? [])`);
        const violations = await js(`JSON.stringify(window.__cspViolations ?? [])`);
        const cspLogLines = consoleLog.filter((l) =>
          /content security policy|violates the following/iu.test(l.text) &&
          /media-src|media/iu.test(l.text)
        );
        const securityLogLines = consoleLog.filter((l) =>
          /content security policy|refused to load/iu.test(l.text)
        );

        const mediaServed = mediaRequests.filter((r) => r.path.includes(audioKey));
        const currentTimeAdvanced = second.currentTime - first.currentTime > 0.25;
        const elementError = first.errorCode ?? second.errorCode;

        check(
          "the browser followed the 302 to the cross-origin store origin (the media server was asked)",
          mediaServed.length > 0,
          `${mediaServed.length} request(s) to ${MEDIA_ORIGIN}, first=${
            mediaServed[0] ? JSON.stringify(mediaServed[0]) : "(none)"
          }; element src ${String(first.src).replace(`${BASE}`, "")}`,
        );

        check(
          "the media element raised no error (audio.error is null, no error event)",
          elementError === null && !String(mediaEvents).includes('"error"'),
          `error code ${elementError}, element events ${String(mediaEvents).slice(0, 300)}`,
        );

        check(
          "zero CSP refusals for media-src (no securitypolicyviolation, no security console entry)",
          violations === "[]" && cspLogLines.length === 0,
          violations === "[]" && cspLogLines.length === 0
            ? "no violations"
            : `violations ${violations}; console ${
              cspLogLines.map((l) => l.text).join(" | ").slice(0, 400)
            }`,
        );

        check(
          "the audio element reached a PLAYING state: currentTime advanced and readyState >= 2",
          currentTimeAdvanced && second.readyState >= 2,
          `currentTime ${first.currentTime.toFixed(3)}s -> ${second.currentTime.toFixed(3)}s (+${
            (second.currentTime - first.currentTime).toFixed(3)
          }s), readyState ${first.readyState} -> ${second.readyState}, networkState ${second.networkState}, paused ${second.paused}`,
        );

        // Printed unconditionally so the failing mutation run carries the same evidence.
        console.log(
          `EVIDENCE readyState=${first.readyState}->${second.readyState} ` +
            `currentTime=${first.currentTime.toFixed(3)}->${second.currentTime.toFixed(3)} ` +
            `duration=${first.duration} paused=${second.paused} mediaRequests=${
              JSON.stringify(mediaRequests.slice(0, 4))
            } cspViolations=${violations} events=${String(mediaEvents).slice(0, 400)}`,
        );
        if (securityLogLines.length > 0) {
          console.log(
            `EVIDENCE security console entries: ${
              securityLogLines.map((l) => `${l.level}: ${l.text}`).join(" | ").slice(0, 800)
            }`,
          );
        }
      } finally {
        try {
          ws.close();
        } catch { /* ignore */ }
      }
    });
  } finally {
    await app.shutdown();
    try {
      await mediaServer.shutdown();
    } catch { /* ignore */ }
  }
});
