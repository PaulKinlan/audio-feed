/**
 * Browser proof for the live lease-expiry view on `/admin/observability` (audio-feed-exww).
 *
 * Paul's ask was a status page he can read from inside the app, showing job state and errors without
 * asking anyone, with the LIVE CLAIM-LEASE EXPIRIES as the primary content. The design constraint is
 * the whole point of the view: the page must read DURABLE state, not go through the worker machinery
 * whose failures it exists to report.
 *
 * So this proof drives two conditions against one locally-served app:
 *
 *   A. the healthy case - a real claim in `uploading_audio`, an already-expired claim nobody
 *      finished, and a real failure produced by the REAL synthesis worker against a provider that
 *      answers HTTP 500. The page must render all three.
 *   B. the broken case - the same page with the log store and the run history UNAVAILABLE, which is
 *      what a dead worker leaves behind. The live lease rows must still render, with their exact
 *      recorded expiries, because they are read from the episode store the claim transitions write.
 *
 * Every check below is driven in real headless Chrome over CDP against a real HTTP server, and each
 * one can fail: the expiries asserted are computed from the very claim instants this script wrote
 * through the storage transitions, so a page that guessed a lease, hard-coded one, or read the
 * process' own clock instead of the claim's fails the assertion.
 *
 *   deno run --allow-all --unstable-kv scripts/exww-live-claims-browser-proof.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { makeArticle, makeEpisode, makeSource } from "../tests/fixtures.ts";
import { runSynthesisBatch, type Synthesizer } from "../src/worker/synthesis.ts";
import { GeminiTtsClient } from "../src/tts/gemini.ts";
import { recordRun } from "../src/stats.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { runProof, withChrome, writeEvidenceReadme } from "./proof-helper.ts";
import { EVIDENCE_PNG_BUDGET_BYTES } from "./evidence-compress.ts";

/**
 * PNG pixel height, read from the IHDR chunk. Used to prove what a committed capture COVERS rather
 * than to trust that it was taken tall enough (audio-feed-u3m1): the width is bytes 16..19 and the
 * height 20..23 of a PNG, both big-endian.
 */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  return {
    width: (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!,
    height: (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!,
  };
}

/**
 * Contrast range (maxima minus minima in greyscale) of a captured crop, read out of the PNG
 * itself (audio-feed-7yom, audio-feed-l11d).
 *
 * A blank clip measures 0: a flat single-colour clip has maxima == minima.
 * A faded clip at opacity 0.35 scales the contrast range proportionally down to 0.312 (and
 * opacity 0.15 down to 0.137). Standard deviation scaled down too slowly (measuring ~0.067
 * at opacity 0.35 against a 0.01 floor), passing washed-out captures that satisfied presence
 * but failed legibility. Contrast range scales proportionally with opacity, so a floor of 0.5
 * cleanly separates legible captures (0.880) from washed-out captures (0.312, 0.137).
 *
 * Cropped to the rectangle the caller names rather than to the whole clip: the clip deliberately
 * includes 8px of the PREVIOUS section above it, and those pixels are not the section's.
 */
async function pixelContrast(
  path: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const out = await new Deno.Command("convert", {
    args: [
      path,
      "-crop",
      `${Math.max(1, Math.round(rect.width))}x${Math.max(1, Math.round(rect.height))}+${
        Math.max(0, Math.round(rect.x))
      }+${Math.max(0, Math.round(rect.y))}`,
      "+repage",
      "-colorspace",
      "gray",
      "-format",
      "%[fx:maxima-minima]",
      "info:",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`convert could not measure ${path}: ${new TextDecoder().decode(out.stderr)}`);
  }
  const contrast = Number(new TextDecoder().decode(out.stdout).trim());
  if (!Number.isFinite(contrast)) {
    throw new Error(
      `convert returned ${JSON.stringify(out.stdout)} as the pixel contrast of ${path}`,
    );
  }
  return contrast;
}

/**
 * The minimum contrast a capture must have to show what the README claims (audio-feed-l11d).
 *
 * MEASURED, not chosen to make a failure stop: the four committed clean captures' own rows all
 * measure 0.880 (specifically 0.880095 in greyscale range: dark text ink against #f7f7f7 card background).
 * Washed-out sections faded to opacity 0.35 measure 0.312 and opacity 0.15 measure 0.137.
 * Flat single-colour clips (opacity 0 or blank background) measure 0.
 *
 * A floor of 0.5 separates clean captures (0.880) from washed-out captures (0.312 and 0.137)
 * with a wide margin on both sides (0.188 above 0.35, 0.380 below clean). Any opacity below ~0.57
 * fails (e.g. 0.5 measures ~0.445 and fails; 0.7 measures ~0.622 and passes).
 */
const MIN_SECTION_CONTRAST = 0.5;

/**
 * Predicate stating that a section crop exhibits sufficient contrast to show what the README claims.
 */
function sectionShowsReadmeClaim(contrast: number): boolean {
  return contrast >= MIN_SECTION_CONTRAST;
}

/**
 * The viewport the proof drives Chrome at, and the width every clip is bounded by.
 */
const VIEWPORT_WIDTH = 1280;

/**
 * The scale the committed artefacts are documented at (docs/evidence/audio-feed-exww/README.md shows
 * 1280-wide, full-scale captures). The clip asks for THIS scale and the image is required to match it,
 * so a capture at any other scale fails rather than quietly passing at a size nothing documents -
 * and every pixel-space crop is derived from the clip's scale rather than assuming 1 (audio-feed-9zgi).
 */
const EVIDENCE_SCALE = 1;

/**
 * A document-space rectangle expressed in the image's own pixels.
 */
function inImagePixels(
  rect: { x: number; y: number; width: number; height: number },
  scale: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * The minimum contrast the claim text's OWN box shows (audio-feed-9zgi, audio-feed-l11d).
 *
 * MEASURED, not chosen to make a failure stop: the four committed clean captures' claim boxes
 * all measure 0.880 contrast range, while a faded claim text at opacity 0.35 measures 0.312,
 * and a background-coloured claim (text styled with background color) measures 0.00000000.
 * A floor of 0.5 ensures the claim text itself is legibly rendered with ink, not washed out.
 */
const MIN_CLAIM_INK_CONTRAST = 0.5;

/**
 * Compress a written capture in place, with the repository's own recipe (scripts/evidence-compress.ts:
 * `convert -strip -colors 256 PNG8:`).
 *
 * WHY THE PROOF COMPRESSES RATHER THAN LEAVING IT TO A DOCUMENTED STEP (audio-feed-vvo7): the
 * committed PNGs were compressed but a REPLAY of the documented command was not, so anyone who ran
 * the proof produced three over-budget files and reddened tests/evidence_size_test.ts. A documented
 * command has to be safe to run as written, so the proof makes its own output compliant and the
 * budget assertion below fails the run if it cannot.
 */
async function compressInPlace(path: string): Promise<number> {
  const tmp = `${path}.png8.tmp`;
  const out = await new Deno.Command("convert", {
    args: [path, "-strip", "-colors", "256", `PNG8:${tmp}`],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    await Deno.remove(tmp).catch(() => {});
    throw new Error(`convert failed for ${path}: ${new TextDecoder().decode(out.stderr)}`);
  }
  const before = (await Deno.stat(path)).size;
  const after = (await Deno.stat(tmp)).size;
  if (after < before) await Deno.rename(tmp, path);
  else await Deno.remove(tmp);
  return (await Deno.stat(path)).size;
}

const OUT = new URL("../docs/evidence/audio-feed-exww/", import.meta.url).pathname;
await Deno.mkdir(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await runProof("audio-feed-exww", async (checker) => {
  const stores: Stores = memoryStores();
  const config: AppConfig = {
    port: 0,
    adminToken: "harness-admin",
    defaultDailyEpisodeBudget: 10,
  };

  const rawUser = await createUser(stores.metadata, {
    email: "paul@example.com",
    displayName: "Paul Kinlan",
    isAdmin: true,
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const sessionSecret = await createSession(stores.metadata, user.id);
  await stores.metadata.putSource(makeSource({ id: "src-1", userId: user.id }));
  await stores.metadata.putArticle(
    makeArticle({
      id: "art-failing",
      userId: user.id,
      sourceId: "src-1",
      title: "An Article That Fails",
      content: "First paragraph. Second paragraph.",
      excerpt: "A short summary.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-failing",
      userId: user.id,
      sourceId: "src-1",
      articleId: "art-failing",
      title: "An Article That Fails",
      status: "pending",
      audioKey: undefined,
      mode: "direct",
    }),
  );

  // (1) A REAL failure, through the REAL worker: the provider answers HTTP 500, which the worker
  // classifies as a provider verdict and records on the episode and in the log store. This is the
  // "real error" half of the acceptance - not a hand-written log line.
  const failingSynthesizer: Synthesizer = () => {
    const client = new GeminiTtsClient({
      apiKey: "proof-key",
      fetchFn: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "quota" } }), { status: 500 }),
        )) as typeof fetch,
      retryOn: "none",
      retryBaseDelayMs: 1,
    });
    return client.synthesizeNarration({ title: "An Article That Fails", body: "hello" });
  };
  await recordRun(
    { config, stores },
    "synthesis",
    "cron",
    () => runSynthesisBatch({ config, stores }, failingSynthesizer, { maxAttempts: 1 }),
    (result) => ({
      ready: result.ready.length,
      failed: result.failed.length,
      deferred: result.deferred.length,
      errors: result.failed.map((f) => `Episode ${f.episodeId}: ${f.error}`),
    }),
  );
  const failedEpisode = await stores.metadata.getEpisode(user.id, "ep-failing");
  checker.check(
    "the worker recorded a REAL provider failure for ep-failing",
    failedEpisode?.status === "failed" &&
      (failedEpisode.error ?? "").includes("provider status 500"),
    `status=${failedEpisode?.status} error=${failedEpisode?.error}`,
  );

  // (2) Two live claims, written through the REAL storage transitions (claimEpisode writes the
  // claim, touchEpisodeClaim writes the phase). Neither worker is running: these are exactly the
  // rows the page has to show while nobody is.
  const liveClaimedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const leaseMs = 15 * 60_000;
  const expiredClaimedAt = new Date(Date.now() - 20 * 60_000).toISOString();

  const liveClaim = async (episodeId: string, claimedAt: string, phase: string) => {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: episodeId,
        userId: user.id,
        sourceId: "src-1",
        articleId: "art-failing",
        title: `Held ${episodeId}`,
        status: "pending",
        audioKey: undefined,
        mode: "direct",
        createdAt: claimedAt,
      }),
    );
    const claimed = await stores.metadata.claimEpisode(user.id, episodeId, {
      owner: `worker-${episodeId}`,
      now: claimedAt,
      leaseMs,
      maxClaims: 3,
    });
    if (!claimed) throw new Error(`the proof could not take the claim for ${episodeId}`);
    await stores.metadata.touchEpisodeClaim(user.id, episodeId, `worker-${episodeId}`, {
      phase,
      now: claimedAt,
    });
  };

  await liveClaim("ep-uploading", liveClaimedAt, "uploading_audio");
  await liveClaim("ep-expired", expiredClaimedAt, "uploading_audio");

  const liveExpiryIso = new Date(Date.parse(liveClaimedAt) + leaseMs).toISOString();
  const liveExpiryDisplay = `${liveExpiryIso.replace("T", " ").slice(0, 19)}Z`;
  const expiredExpiryIso = new Date(Date.parse(expiredClaimedAt) + leaseMs).toISOString();

  // (3) The store proxy that lets ONE server answer all three conditions. The unhealthy-worker
  // conditions are not different apps: they are the same app with the reads a dead worker breaks
  // failing, so the checks are about the page's real dependencies rather than about a second build
  // of it.
  //
  // WHAT "THE WORKER PATH IS UNHEALTHY" MEANS HERE, precisely, because a check like this is easy to
  // write so that it passes while nothing was broken:
  //
  //   - no synthesis worker is running at all (this proof never starts the loop, so nothing claims
  //     the queue and nothing reports progress);
  //   - the worker's durable TRACES are unavailable: \`listLogs\`/\`logBounds\` reject, which is what
  //     a worker that never came back to write leaves behind;
  //   - the run history still READS, and its last synthesis run made no progress while work is
  //     queued, so the page's own drain verdict is a measured "queued work is NOT being processed"
  //     rather than an unavailable output.
  //
  // The EPISODE STORE is deliberately left healthy in that phase, because the property the design
  // rests on is exactly this distinction: a worker being unhealthy is not the store being
  // unreachable. Phase C breaks the store instead, and the page must then say UNREADABLE rather than
  // render an empty lease set. Each condition is asserted to be distinct, so a page that treated
  // "I could not look" as "nobody is holding anything" fails here.
  type FailureMode = "healthy" | "worker-unhealthy" | "store-unreachable";
  let failureMode: FailureMode = "healthy";
  const workerTraceReads = new Set(["listLogs", "logBounds"]);
  const metadata = new Proxy(stores.metadata, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const name = String(property);
      if (failureMode === "worker-unhealthy" && workerTraceReads.has(name)) {
        return () =>
          Promise.reject(
            new Error(`${name} unavailable: the synthesis worker left no readable trace`),
          );
      }
      if (failureMode === "store-unreachable" && name === "listSynthesizingEpisodes") {
        return () => Promise.reject(new Error(`${name} unavailable: the episode store is down`));
      }
      return value.bind(target);
    },
  });
  const ctx = { config, stores: { ...stores, metadata } };
  const handlers = createHandlers(ctx);
  const { fetch: appFetch } = createApp(ctx, handlers);

  const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
  const PORT = (server.addr as Deno.NetAddr).port;
  const BASE = `http://localhost:${PORT}`;
  config.port = PORT;
  config.publicBaseUrl = BASE;

  try {
    await withChrome(async (chrome) => {
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
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

      await cdp("Page.enable");
      await cdp("Network.enable");
      await cdp("Network.setCookie", {
        name: "__Host-af_session",
        value: sessionSecret,
        url: BASE,
        secure: true,
      });
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 1400,
        deviceScaleFactor: 1,
        mobile: false,
      });

      /** The rendered text of the live-claims row for one episode, or null when it is not there. */
      const claimRow = async (episodeId: string): Promise<string | null> => {
        const text = await js(`(() => {
          const rows = [...document.querySelectorAll("table tbody tr")];
          const row = rows.find((r) => r.textContent.includes(${JSON.stringify(episodeId)}));
          return row ? row.textContent.replace(/\\s+/g, " ").trim() : null;
        })()`);
        return typeof text === "string" ? text : null;
      };

      const load = async () => {
        await cdp("Page.navigate", { url: `${BASE}/admin/observability` });
        await until(`document.readyState === "complete"`, "observability page loaded");
        await until(
          `document.body.textContent.includes("Live claims")`,
          "the live-claims section rendered",
        );
      };

      /** The rendered text of the live-claims SECTION alone, so a claim about it cannot be satisfied
       * by text in another card. */
      const claimSectionText = async (): Promise<string> =>
        String(
          await js(
            `(document.querySelector('[aria-labelledby="liveclaims-h"]')?.textContent ?? "")
               .replace(/\\s+/g, " ")`,
          ),
        );

      /** The rendered text of the FAILURES section, for the same reason (audio-feed-u3m1: the failure
       * assertion used to read the whole body, so it could pass on a DOM state no capture recorded). */
      const failuresSectionText = async (): Promise<string> =>
        String(
          await js(
            `(document.querySelector('[aria-labelledby="failures-h"]')?.textContent ?? "")
               .replace(/\\s+/g, " ")`,
          ),
        );

      /** The rendered geometry of one section, in document space. */
      const sectionBounds = async (
        ariaLabelledby: string,
      ): Promise<{ top: number; bottom: number; left: number; right: number }> =>
        JSON.parse(
          String(
            await js(`JSON.stringify((() => {
              const el = document.querySelector('[aria-labelledby="${ariaLabelledby}"]');
              if (!el) return { top: -1, bottom: -1, left: -1, right: -1 };
              const r = el.getBoundingClientRect();
              return {
                top: r.top + window.scrollY,
                bottom: r.bottom + window.scrollY,
                left: r.left,
                right: r.right,
              };
            })())`),
          ),
        );

      /**
       * Is `text` inside the section AND actually painted? (audio-feed-7yom)
       *
       * The deepest element whose text contains `text` is found and required to be inside the section
       * the capture is about; then every element from it up to and including the section must be
       * visibly rendered - no `display: none`, no `visibility: hidden`, no `opacity: 0`, and no empty
       * box. No geometry assertion can see any of that: rev-27 hid the failures section with
       * `style.opacity = "0"`, which leaves textContent and layout intact, and every coverage check
       * passed while the committed PNG was blank. This ties the claim to something the browser paints.
       *
       * NOT COVERED, stated so the next reviewer does not have to find it: text painted in the
       * background colour, and content covered by an overlapping element. The ink check below is the
       * artefact-side complement - it fails when the section's own pixels carry nothing.
       */
      const claimVisibility = async (
        ariaLabelledby: string,
        text: string,
      ): Promise<
        {
          found: boolean;
          visible: boolean;
          reason: string;
          rect: { top: number; bottom: number; left: number; right: number } | null;
        }
      > =>
        JSON.parse(
          String(
            await js(`JSON.stringify((() => {
              const section = document.querySelector('[aria-labelledby="${ariaLabelledby}"]');
              if (!section) return { found: false, visible: false, reason: "the section is not rendered", rect: null };
              const wanted = ${JSON.stringify(text)};
              const matches = [...section.querySelectorAll("*")].filter((el) =>
                (el.textContent ?? "").includes(wanted));
              if (matches.length === 0) {
                return { found: false, visible: false, reason: "the text is not inside the section", rect: null };
              }
              const el = matches.find((node) =>
                ![...node.children].some((child) => (child.textContent ?? "").includes(wanted))
              ) ?? matches[matches.length - 1];
              for (let node = el; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.display === "none") {
                  return { found: true, visible: false, reason: node.tagName.toLowerCase() + " has display:none", rect: null };
                }
                if (style.visibility === "hidden") {
                  return { found: true, visible: false, reason: node.tagName.toLowerCase() + " has visibility:hidden", rect: null };
                }
                if (style.opacity === "0") {
                  return { found: true, visible: false, reason: node.tagName.toLowerCase() + " has opacity:0", rect: null };
                }
                const r = node.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) {
                  return { found: true, visible: false, reason: node.tagName.toLowerCase() + " has an empty box", rect: null };
                }
                if (node === section) break;
              }
              const rect = el.getBoundingClientRect();
              return {
                found: true,
                visible: true,
                reason: "painted inside the section",
                rect: {
                  top: rect.top + window.scrollY,
                  bottom: rect.bottom + window.scrollY,
                  left: rect.left,
                  right: rect.right,
                },
              };
            })())`),
          ),
        );

      /**
       * Capture ONE SECTION and assert what the written file covers (audio-feed-u3m1, vvo7).
       *
       * Three things are asserted about the ARTEFACT rather than about the DOM that produced it: the
       * clip starts at or above the section's rendered top, the image is tall enough to reach its
       * rendered bottom (the height is read back out of the PNG's IHDR), and the compressed file is
       * within the repository's budget. So a capture that stops short of the section its README entry
       * describes FAILS the run, and a replay writes files the budget test accepts.
       *
       * The clip is deliberate rather than whole-page: a whole 1280x2989 page is ~200KB even
       * palette-quantised, so one shot covering everything cannot be both complete and under budget.
       * Capturing the section each claim is about is what lets the claim and the artefact match.
       */
      const captureSection = async (
        name: string,
        ariaLabelledby: string,
        coversLabel: string,
        claimText: string,
      ): Promise<void> => {
        const bounds = await sectionBounds(ariaLabelledby);
        if (bounds.top < 0) throw new Error(`${name}: section ${ariaLabelledby} is not rendered`);
        // ONE object, used both for the request and for the assertions about it (audio-feed-g86r):
        // while the clip was a literal in the capture call, every assertion described what we MEANT to
        // capture, so a clip moved to another part of the page still passed every check.
        //
        // BOTH AXES, AND THE SCALE, COME FROM THE SECTION'S BOX (audio-feed-9zgi): the first version
        // took y and the height from the box and hard-coded x=0 and the full page width, so a capture
        // shifted HORIZONTALLY - the section's own rows, someone else's columns - satisfied every
        // check, and a capture of the right box at the wrong SCALE satisfied them too because the
        // assertions compared document coordinates against each other and never against the image.
        const clip = {
          x: Math.max(0, Math.floor(bounds.left) - 8),
          y: Math.max(0, Math.floor(bounds.top) - 8),
          width: 0,
          height: 0,
          scale: EVIDENCE_SCALE,
        };
        clip.width = Math.max(1, Math.min(VIEWPORT_WIDTH, Math.ceil(bounds.right) + 8) - clip.x);
        clip.height = Math.ceil(bounds.bottom) + 8 - clip.y;
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: VIEWPORT_WIDTH,
          height: Math.max(1400, Math.ceil(bounds.bottom) + 40),
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(120);
        const shot = (await cdp("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip,
        })) as { data: string };
        const path = `${OUT}${name}`;
        await Deno.writeFile(path, Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)));
        const bytes = await compressInPlace(path);
        const image = pngSize(await Deno.readFile(path));
        checker.check(
          `${name} is within the ${
            (EVIDENCE_PNG_BUDGET_BYTES / 1024).toFixed(0)
          }KB budget after a replay`,
          bytes <= EVIDENCE_PNG_BUDGET_BYTES,
          `${(bytes / 1024).toFixed(0)}KB`,
        );
        // The image's own dimensions must be the clip's dimensions AT THE CLIP'S SCALE, which is the
        // assertion that makes a wrong-scale capture fail rather than silently pass: the document-space
        // checks below are all expressed in the section's coordinates and cannot see a rescaled image.
        const expectedWidth = Math.round(clip.width * EVIDENCE_SCALE);
        const expectedHeight = Math.round(clip.height * EVIDENCE_SCALE);
        checker.check(
          `${name} covers ${coversLabel}`,
          image.width === expectedWidth && image.height === expectedHeight,
          `image is ${image.width}x${image.height} for a clip of ${clip.width}x${clip.height} ` +
            `at scale ${clip.scale}, so it should be ${expectedWidth}x${expectedHeight}`,
        );
        // BINDING THE IMAGE TO THE SECTION. The checks above are all satisfied by a capture of SOME
        // nonflat region of the right size. So the region we ASKED FOR is compared against the
        // section's own box, re-read after the capture - `clip` above, not a variable computed from it.
        const live = await sectionBounds(ariaLabelledby);
        const slack = 16;
        checker.check(
          `${name} captured the section's own box, not another region of the page`,
          Math.abs(live.left - clip.x) <= slack &&
            Math.abs(live.right - (clip.x + clip.width)) <= slack &&
            Math.abs(live.top - clip.y) <= slack &&
            Math.abs(live.bottom - (clip.y + clip.height)) <= slack,
          `clip was x=${clip.x}..${clip.x + clip.width} y=${clip.y}..${
            clip.y + clip.height
          } and the ` +
            `section is x=${Math.round(live.left)}..${Math.round(live.right)} y=${
              Math.round(live.top)
            }..${Math.round(live.bottom)} (${slack}px of deliberate padding around it)`,
        );
        // ...and the section's own rectangle must lie INSIDE the clip, or the pixel measurements below
        // would be measuring someone else's pixels and reporting them as this section's content.
        const sectionRect = {
          x: Math.floor(bounds.left) - clip.x,
          y: Math.floor(bounds.top) - clip.y,
          width: Math.ceil(bounds.right) - Math.floor(bounds.left),
          height: Math.ceil(bounds.bottom) - Math.floor(bounds.top),
        };
        const sectionInClip = sectionRect.x >= 0 && sectionRect.y >= 0 &&
          sectionRect.x + sectionRect.width <= clip.width &&
          sectionRect.y + sectionRect.height <= clip.height;
        const contrast = sectionInClip
          ? await pixelContrast(path, inImagePixels(sectionRect, clip.scale))
          : Number.NaN;
        checker.check(
          `${name} shows what the README claims`,
          sectionInClip && sectionShowsReadmeClaim(contrast),
          sectionInClip
            ? `pixel contrast range ${
              contrast.toFixed(8)
            } over the section's own rows and columns (a clip whose section renders nothing is ` +
              `flat and measures 0; faded captures at opacity 0.35/0.15 measure 0.312/0.137; ` +
              `the committed clean captures measure 0.880; floor is ${MIN_SECTION_CONTRAST})`
            : `the section's box x=${sectionRect.x}..${sectionRect.x + sectionRect.width} ` +
              `y=${sectionRect.y}..${
                sectionRect.y + sectionRect.height
              } is not inside the captured clip ${clip.width}x${clip.height}, so this image ` +
              `cannot be the section`,
        );
        // The claim text itself must be in a PAINTED element inside that section - the half the pixel
        // check cannot see, because a section can still render a heading around a hidden card.
        const claim = await claimVisibility(ariaLabelledby, claimText);
        checker.check(
          `${name} shows ${
            JSON.stringify(claimText)
          } actually rendered, not just present in the DOM`,
          claim.found && claim.visible,
          claim.reason,
        );
        // ...that painted text must be inside the captured pixels ON BOTH AXES. Without this the claim
        // was satisfied by text painted anywhere in the section while the image could show anything at
        // all - the two ends of the check were never tied together (audio-feed-g86r, audio-feed-9zgi).
        const inImage = claim.rect !== null &&
          claim.rect.left >= clip.x && claim.rect.right <= clip.x + clip.width &&
          claim.rect.top >= clip.y && claim.rect.bottom <= clip.y + clip.height;
        checker.check(
          `${name} has ${
            JSON.stringify(claimText)
          } inside the captured pixels, not merely painted somewhere on the page`,
          inImage,
          claim.rect === null
            ? `the text has no rendered box (${claim.reason})`
            : `the text is at x=${Math.round(claim.rect.left)}..${Math.round(claim.rect.right)} y=${
              Math.round(claim.rect.top)
            }..${Math.round(claim.rect.bottom)} and the image covers ` +
              `x=${clip.x}..${clip.x + clip.width} y=${clip.y}..${clip.y + clip.height}`,
        );
        // ...and the claim's OWN pixels must carry ink (audio-feed-9zgi). The visibility check above
        // reads computed style, so a claim painted in the background's own colour - or under an opaque
        // overlay - is "visible" to it and blank in the image; this is the one measurement that says
        // the text the claim names is what the pixels actually show.
        const claimRect = claim.rect === null ? null : {
          x: claim.rect.left - clip.x,
          y: claim.rect.top - clip.y,
          width: claim.rect.right - claim.rect.left,
          height: claim.rect.bottom - claim.rect.top,
        };
        const claimInClip = claimRect !== null && claimRect.x >= 0 && claimRect.y >= 0 &&
          claimRect.width > 0 && claimRect.height > 0 &&
          claimRect.x + claimRect.width <= clip.width &&
          claimRect.y + claimRect.height <= clip.height;
        const claimContrast = claimInClip
          ? await pixelContrast(path, inImagePixels(claimRect, clip.scale))
          : Number.NaN;
        checker.check(
          `${name} shows ink where ${
            JSON.stringify(claimText)
          } is painted, not a background-coloured claim`,
          Number.isFinite(claimContrast) && claimContrast >= MIN_CLAIM_INK_CONTRAST,
          claimInClip
            ? `pixel contrast range ${
              claimContrast.toFixed(8)
            } over the claim's own text box at x=${Math.round(claimRect.x)},y=${
              Math.round(claimRect.y)
            } ${Math.round(claimRect.width)}x${
              Math.round(claimRect.height)
            } (rendered text varies; a box painted in one colour measures 0; floor is ${MIN_CLAIM_INK_CONTRAST})`
            : `the claim's box is not inside the captured pixels (${claim.reason})`,
        );
      };

      /** Matches the rendered "expired N min ago" / "expired N s ago" remaining cell. */
      const timedExpired = (row: string | null): boolean =>
        row !== null && /expired \d+ (min|s) ago/.test(row);

      // ---------------------------------------------------------------------
      // A. The healthy path: real claim, real expiry, real expired claim, real error.
      // ---------------------------------------------------------------------
      await load();

      checker.check(
        "the page serves 200 to the admin session",
        String(await js(`document.title`)) === "Observability — Audio Feed",
        `title=${await js(`document.title`)}`,
      );
      checker.check(
        "the live lease row for the held upload is rendered with its phase",
        (await claimRow("ep-uploading"))?.includes("uploading_audio") === true,
        `row=${await claimRow("ep-uploading")}`,
      );
      checker.check(
        "the lease expiry shown is claimedAt + the claim's own lease",
        (await claimRow("ep-uploading"))?.includes(liveExpiryDisplay) === true,
        `expected ${liveExpiryDisplay}; row=${await claimRow("ep-uploading")}`,
      );
      checker.check(
        "the exact lease instant is in the row's machine-readable datetime",
        String(
          await js(
            `(() => {
              const time = [...document.querySelectorAll('table tbody tr time')]
                .map((t) => t.getAttribute("datetime"));
              return time.includes(${JSON.stringify(liveExpiryIso)});
            })()`,
          ),
        ) === "true",
        `expected ${liveExpiryIso}`,
      );
      // BOTH HALVES ARE ASSERTED, AND THE TIME IS ASSERTED AS A TIME (audio-feed-exww, review):
      // the old second clause was `includes("expired")`, which the marker string already contains -
      // a term satisfied by construction, so removing the time from the cell did not redden it. The
      // clause below matches the rendered duration, so a row that says only the word now fails.
      const expiredRowA = await claimRow("ep-expired");
      checker.check(
        "a lease that has run out with no terminal write is called out, and timed",
        expiredRowA?.includes("LEASE EXPIRED with no terminal write") === true &&
          timedExpired(expiredRowA),
        `row=${expiredRowA}`,
      );
      checker.check(
        "the expired claim's own expiry instant matches its claim time + lease",
        String(
          await js(
            `(() => {
              const time = [...document.querySelectorAll('table tbody tr time')]
                .map((t) => t.getAttribute("datetime"));
              return time.includes(${JSON.stringify(expiredExpiryIso)});
            })()`,
          ),
        ) === "true",
        `expected ${expiredExpiryIso}`,
      );
      // SCOPED TO THE FAILURES SECTION, not to the whole body (audio-feed-u3m1): asserting against
      // document.body could pass on a DOM state the committed capture never recorded. The section
      // the text was read from is then required to be INSIDE the image, via its own geometry.
      const failuresText = await failuresSectionText();
      const failuresBounds = await sectionBounds("failures-h");
      checker.check(
        "the REAL provider failure produced by the worker is in the failures section",
        failuresText.includes("provider status 500") && failuresBounds.bottom > 0,
        `failures section spans y=${Math.round(failuresBounds.top)}..${
          Math.round(failuresBounds.bottom)
        }`,
      );
      // The distinguishability requirement: an expired lease must not read like a healthy one. Both
      // halves are asserted, so a page that marked EVERY row expired fails the first and a page that
      // marked none fails the second.
      checker.check(
        "the row whose lease is still live is NOT rendered as expired",
        (await claimRow("ep-uploading"))?.includes("expired") === false &&
          timedExpired(await claimRow("ep-uploading")) === false,
        `row=${await claimRow("ep-uploading")}`,
      );
      checker.check(
        "the page names the instant the claim state was read, so the arithmetic is retraceable",
        (await claimSectionText()).includes("Claim state read at") === true,
        "the section prints the render instant",
      );
      checker.check(
        "with the worker healthy the lease section reports no failed read",
        (await claimSectionText()).includes("could not be read") === false,
        "no unavailable notice in the live-claims section",
      );

      await captureSection(
        "01-live-lease-expiries-worker-healthy.png",
        "liveclaims-h",
        "the live-claims section with a live and an expired claim",
        "LEASE EXPIRED with no terminal write",
      );
      // The failure has its OWN artifact, so the README never points at a picture of something else
      // while describing this one (audio-feed-u3m1): the image below is the failures section itself.
      await captureSection(
        "04-recent-failures-real-provider-error.png",
        "failures-h",
        "the Recent failures section carrying the provider error",
        "provider status 500",
      );

      // ---------------------------------------------------------------------
      // B. The worker path is unhealthy; the EPISODE STORE is not. The page reads the store
      // directly, so the lease rows must still render - and it must still SAY the worker is not
      // draining, rather than quietly looking healthy.
      // ---------------------------------------------------------------------
      failureMode = "worker-unhealthy";
      await load();
      const bodyB = String(await js(`document.body.textContent`));
      const sectionB = await claimSectionText();

      checker.check(
        "the page says the worker left no readable trace rather than swallowing it",
        bodyB.includes("the synthesis worker left no readable trace"),
        "the unavailable log read is named on the page",
      );
      checker.check(
        "the page's own verdict is that queued work is not being processed",
        bodyB.includes("queued work is NOT being processed"),
        "the drain verdict is a measurement of the unhealthy worker, not an unavailable output",
      );
      checker.check(
        "the live lease row still renders with the worker path unhealthy",
        (await claimRow("ep-uploading"))?.includes("uploading_audio") === true,
        `row=${await claimRow("ep-uploading")}`,
      );
      checker.check(
        "the exact lease expiry still renders with the worker path unhealthy",
        (await claimRow("ep-uploading"))?.includes(liveExpiryDisplay) === true,
        `expected ${liveExpiryDisplay}; row=${await claimRow("ep-uploading")}`,
      );
      // The label is asserted, not merely rendered: with the claim record unavailable the expiry is
      // derived from the deployment lease, and a fallback computed and then formatted away is
      // indistinguishable from no fallback (audio-feed-exww, review).
      checker.check(
        "a default-derived expiry SAYS it is the deployment default, in the cell",
        (await claimRow("ep-uploading"))?.includes("computed from the deployment lease") === true,
        `row=${await claimRow("ep-uploading")}`,
      );
      checker.check(
        "the expired upload is still called out with the worker path unhealthy",
        (await claimRow("ep-expired"))?.includes("LEASE EXPIRED with no terminal write") === true,
        `row=${await claimRow("ep-expired")}`,
      );
      checker.check(
        "WORKER UNHEALTHY IS NOT STORE UNREACHABLE: the lease section reports no failed read",
        sectionB.includes("could not be read") === false,
        `section=${sectionB.slice(0, 200)}`,
      );
      checker.check(
        "the page never claims no worker holds a claim while the worker is unhealthy",
        bodyB.includes("No worker holds a claim right now") === false,
        "an unhealthy worker must not render as an empty lease set",
      );

      await captureSection(
        "02-live-lease-expiries-worker-unavailable.png",
        "liveclaims-h",
        "the live-claims section with the worker path unavailable and the default-lease label",
        "computed from the deployment lease",
      );

      // ---------------------------------------------------------------------
      // C. The OTHER condition: the episode store itself is unreachable. Now the page cannot know
      // who holds what, and it must say so - an empty listing would be "nobody is holding anything",
      // which is a different statement and the dangerous one.
      // ---------------------------------------------------------------------
      failureMode = "store-unreachable";
      await load();
      const bodyC = String(await js(`document.body.textContent`));

      checker.check(
        "an unreachable episode store is reported as UNREADABLE, not as an empty lease set",
        bodyC.includes('This is NOT "no worker holds a claim"') &&
          bodyC.includes("the episode store is down"),
        "the store failure is named and disclaimed",
      );
      checker.check(
        "no lease row is rendered when the store could not be read",
        (await claimRow("ep-uploading")) === null &&
          bodyC.includes("No worker holds a claim right now") === false,
        `row=${await claimRow("ep-uploading")}`,
      );

      await captureSection(
        "03-live-lease-expiries-store-unreachable.png",
        "liveclaims-h",
        "the live-claims section reporting UNREADABLE",
        "Unavailable — the episode store could not be read",
      );

      await writeEvidenceReadme({
        dir: OUT,
        title: "Live claim-lease expiries on /admin/observability (audio-feed-exww)",
        script: "scripts/exww-live-claims-browser-proof.ts",
        asserts: [
          "the worker recorded a REAL provider failure for ep-failing",
          "the page serves 200 to the admin session",
          "the live lease row for the held upload is rendered with its phase",
          "the lease expiry shown is claimedAt + the claim's own lease",
          "the exact lease instant is in the row's machine-readable datetime",
          "a lease that has run out with no terminal write is called out, and timed",
          "the expired claim's own expiry instant matches its claim time + lease",
          "the REAL provider failure produced by the worker is in the failures section",
          "the row whose lease is still live is NOT rendered as expired",
          "the page names the instant the claim state was read, so the arithmetic is retraceable",
          "with the worker healthy the lease section reports no failed read",
          "a default-derived expiry SAYS it is the deployment default, in the cell",
          "the page says the worker left no readable trace rather than swallowing it",
          "the page's own verdict is that queued work is not being processed",
          "the live lease row still renders with the worker path unhealthy",
          "the exact lease expiry still renders with the worker path unhealthy",
          "the expired upload is still called out with the worker path unhealthy",
          "WORKER UNHEALTHY IS NOT STORE UNREACHABLE: the lease section reports no failed read",
          "the page never claims no worker holds a claim while the worker is unhealthy",
          "an unreachable episode store is reported as UNREADABLE, not as an empty lease set",
          "no lease row is rendered when the store could not be read",
          "01-live-lease-expiries-worker-healthy.png is within the 150KB budget after a replay",
          "01-live-lease-expiries-worker-healthy.png covers the live-claims section with a live and an expired claim",
          "01-live-lease-expiries-worker-healthy.png captured the section's own box, not another region of the page",
          '01-live-lease-expiries-worker-healthy.png has "LEASE EXPIRED with no terminal write" inside the captured pixels, not merely painted somewhere on the page',
          '01-live-lease-expiries-worker-healthy.png shows ink where "LEASE EXPIRED with no terminal write" is painted, not a background-coloured claim',
          "02-live-lease-expiries-worker-unavailable.png is within the 150KB budget after a replay",
          "02-live-lease-expiries-worker-unavailable.png covers the live-claims section with the worker path unavailable and the default-lease label",
          "02-live-lease-expiries-worker-unavailable.png captured the section's own box, not another region of the page",
          '02-live-lease-expiries-worker-unavailable.png has "computed from the deployment lease" inside the captured pixels, not merely painted somewhere on the page',
          '02-live-lease-expiries-worker-unavailable.png shows ink where "computed from the deployment lease" is painted, not a background-coloured claim',
          "03-live-lease-expiries-store-unreachable.png is within the 150KB budget after a replay",
          "03-live-lease-expiries-store-unreachable.png covers the live-claims section reporting UNREADABLE",
          "03-live-lease-expiries-store-unreachable.png captured the section's own box, not another region of the page",
          '03-live-lease-expiries-store-unreachable.png has "Unavailable — the episode store could not be read" inside the captured pixels, not merely painted somewhere on the page',
          '03-live-lease-expiries-store-unreachable.png shows ink where "Unavailable — the episode store could not be read" is painted, not a background-coloured claim',
          "04-recent-failures-real-provider-error.png is within the 150KB budget after a replay",
          "04-recent-failures-real-provider-error.png covers the Recent failures section carrying the provider error",
          "04-recent-failures-real-provider-error.png captured the section's own box, not another region of the page",
          '04-recent-failures-real-provider-error.png has "provider status 500" inside the captured pixels, not merely painted somewhere on the page',
          '04-recent-failures-real-provider-error.png shows ink where "provider status 500" is painted, not a background-coloured claim',
          "01-live-lease-expiries-worker-healthy.png shows what the README claims",
          "02-live-lease-expiries-worker-unavailable.png shows what the README claims",
          "03-live-lease-expiries-store-unreachable.png shows what the README claims",
          "04-recent-failures-real-provider-error.png shows what the README claims",
          '01-live-lease-expiries-worker-healthy.png shows "LEASE EXPIRED with no terminal write" actually rendered, not just present in the DOM',
          '02-live-lease-expiries-worker-unavailable.png shows "computed from the deployment lease" actually rendered, not just present in the DOM',
          '03-live-lease-expiries-store-unreachable.png shows "Unavailable — the episode store could not be read" actually rendered, not just present in the DOM',
          '04-recent-failures-real-provider-error.png shows "provider status 500" actually rendered, not just present in the DOM',
        ],
        sections: [
          {
            heading: "How the state was produced",
            body:
              `- The **failure** is real, not hand-written: \`scripts/exww-live-claims-browser-proof.ts\` runs the actual
  \`runSynthesisBatch\` against a \`GeminiTtsClient\` whose transport answers HTTP 500, and records the run
  through the real \`recordRun\`. The page then renders the provider failure the worker wrote.
- The **live claims** are written by the REAL storage transitions (\`claimEpisode\` then
  \`touchEpisodeClaim\` with \`phase: "uploading_audio"\`). One claim is inside its 15-minute lease and
  one expired 5 minutes ago, so the page has to distinguish "still held" from "nobody finished it".
- \`ep-failing\` is a separate episode, failed by the worker BEFORE the two live claims are taken, so the
  synthetic run cannot consume the claims this view is about.`,
          },
          {
            heading: 'Where "now" comes from, and why an expired row cannot read as live',
            body:
              `The expiry is \`claimedAt + leaseMs\`. \`claimedAt\` and the phase are the episode record's own
fields; \`leaseMs\` is the claim's recorded lease from its \`claim.lifecycle\` start record, and when
that record is not readable the page uses the deployment lease and SAYS SO in the cell - phase B of
this proof shows that label, because the failing \`listLogs\` is what makes the claim record
unavailable.

"Expired" and "time left" are NOT decided in the browser: \`buildObservabilityReport(stores, nowMs)\`
takes one explicit \`nowMs\`, and every row carries \`leaseExpired: boolean | null\` and \`remainingMs\`
computed from it, so all rows share one clock and the render only formats them. The page prints the
instant it read ("Claim state read at ..."), derived from that same \`nowMs\`, so every figure can be
retraced: \`remaining = (claimedAt + leaseMs) - readAt\`.

The arithmetic is pinned at a FIXED now by the report-level case
\`audio-feed-exww: the claim's OWN lease is used, and a default-derived expiry is labelled\`: halfway
through a 60-second lease it asserts \`remainingMs === 30000\` and \`leaseExpired === false\`, and
thirty seconds after it expires it asserts \`remainingMs === -30000\` and \`leaseExpired === true\`.
The browser assertions here read the RENDERED values: the \`<time datetime>\` of the expired row
equals its claim instant plus the lease, and the live row for the same page does not carry the
expired marker.

Commands used here, so the numbers can be retraced: the proof is
\`deno run --allow-all --unstable-kv scripts/exww-live-claims-browser-proof.ts\`; the report-level
cases are \`deno test --allow-net --allow-env --allow-read --allow-write --allow-run --unstable-kv tests/admin_observability_test.ts --filter audio-feed-exww\`; and the adapter-side cases are
\`deno test --allow-net --allow-env --allow-read --allow-write --allow-run --unstable-kv tests/storage_test.ts --filter listSynthesizingEpisodes\`.`,
          },
          {
            heading: "How the worker path is made unhealthy",
            body:
              `Stated plainly, because a check like this is easy to write so that it passes while nothing was
broken:

- **No synthesis worker is running** in this proof at all: the loop is never started, so nothing
  claims the queue and nothing reports progress.
- **The worker's durable traces are unavailable**: \`listLogs\` and \`logBounds\` reject with
  "the synthesis worker left no readable trace", which is what a worker that never came back to write
  leaves behind. The failure is explicit and visible - the page names it, and the check asserts the
  page says it rather than swallowing it.
- **The worker's progress is measured, not unavailable**: the run history still reads and its last
  synthesis run made no progress while work is queued, so the page's own drain verdict is "queued work
  is NOT being processed".
- **The episode store is deliberately left healthy in that phase**, because the distinction the design
  rests on is exactly this: a worker being unhealthy is not the store being unreachable. The check
  asserts the live-claims SECTION contains no "could not be read" text, so a page that fetched its
  lease rows through the worker would fail it.

Phase C breaks the other thing - the episode store - and asserts the page then says UNREADABLE rather
than rendering an empty lease set, so "I could not look" and "nobody is holding anything" cannot be
confused in either direction.`,
          },
          {
            heading: "Screenshots, and what each one is proved to cover",
            body:
              `Every capture is clipped to the section its README entry describes (\`captureBeyondViewport\` plus a
clip) and then has SEVEN assertions, and the first three bind the image to the section rather than
describing the intention: (0) the captured region is compared against the section's own box on BOTH
AXES, re-read after the capture, so a clip moved anywhere else on the page FAILS (audio-feed-g86r for
the vertical axis, audio-feed-9zgi for the horizontal one) - the clip is one object used both for the
request and for the assertions about it, because while it was a literal in the capture call every check
described what the proof MEANT to capture; (1) the image's own IHDR width and height match the clip's
dimensions at the full scale the artefacts are documented at, so a capture of the right box at the
WRONG SCALE FAILS rather than passing at a size no README entry describes, and the height reaches the
section's rendered bottom so a capture that stops short also FAILS (audio-feed-u3m1, audio-feed-9zgi);
(2) the file is within the repository's 150KB budget, and the proof
compresses its own output with the repository's own recipe (\`convert -strip -colors 256 PNG8:\`) so a
replay does not write over-budget PNGs (audio-feed-vvo7); (3) the section shows what the README claims -
the CONTRAST RANGE (maxima minus minima in greyscale) over the section's OWN rows is measured back out
of the PNG and must exceed 0.5, which separates the committed clean captures (0.880) from washed-out
captures (opacity 0.35 measures 0.312; opacity 0.15 measures 0.137) and flat clips (which measure zero),
because fading scales contrast range proportionally while standard deviation allowed washed-out captures
to pass (audio-feed-l11d); and (4) the text each
claim names is in a PAINTED element inside that section - no \`display:none\`, \`visibility:hidden\`,
\`opacity:0\` or empty box on that element or any ancestor up to the section - because hiding a section
leaves textContent and layout intact while the image records background; (5) that painted text lies
INSIDE THE CAPTURED PIXELS ON BOTH AXES, so text painted in the right section while the image shows
something else FAILS; (6) the claim's OWN box is measured back out of the PNG and must carry ink
(CONTRAST RANGE over the text's own element: 0.880 in the committed clean captures, about 0 when that
text is painted in the page's own background colour, and < 0.5 when washed out; threshold 0.5)
(audio-feed-9zgi, audio-feed-l11d); and the pixel measurements (3)
and (6) are refused outright when the section's or the claim's box is not inside the captured clip,
rather than reporting someone else's pixels as this section's content. Not covered, and stated here
rather than left to be discovered: content covered by an overlapping element.

- \`01-live-lease-expiries-worker-healthy.png\`: the lease table with a held upload and an expired
  upload (called out AND timed).
- \`04-recent-failures-real-provider-error.png\`: the Recent failures section itself, carrying the
  error the real worker recorded for a provider 500 - its own artifact, so the README never points at
  a picture of one thing while describing another.
- \`02-live-lease-expiries-worker-unavailable.png\`: the same lease rows with the worker's durable
  traces unavailable, the queue reported as not being processed, and the default-derived lease expiry
  label asserted in the cell.
- \`03-live-lease-expiries-store-unreachable.png\`: the lease section reporting UNREADABLE, never an
  empty lease set.`,
          },
        ],
      });
      console.log(`Saved report to ${OUT}README.md`);
      ws.close();
    }, { prefix: "audiofeed-proof-exww-" });
  } finally {
    await server.shutdown().catch(() => {});
  }
});
