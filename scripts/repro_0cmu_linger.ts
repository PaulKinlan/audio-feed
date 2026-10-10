/**
 * Repro and regression harness for audio-feed-0cmu — the fired `AbortSignal.any` composite that
 * re-refs the caller's lease timer and keeps a finished one-shot process alive.
 *
 * Run: timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_0cmu_linger.ts
 *
 * WHY IT DOES NOT CALL Deno.exit ON THE HAPPY PATH
 * The property under test IS that the process ends by itself once the work is done, so an early
 * exit would hide exactly the regression this exists to catch. A watchdog (unref'd, so it cannot
 * hold the loop open itself) fails the run if something else still is.
 *
 * WHAT IT MEASURES
 * 1. mechanism — live `deno eval` children. A bare `AbortSignal.timeout` lets the process exit
 *    immediately; the same timer inside an `AbortSignal.any` composite that aborts does not. That
 *    difference is the whole defect, so it is measured here rather than quoted from memory.
 * 2. cases — the three call sites that used the composite (TTS request, worker batch, script
 *    stage), each with a caller signal ten minutes away and a per-attempt deadline that fires.
 */
import { memoryStores } from "../src/config.ts";
import type { AppConfig } from "../src/config.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { GeminiTtsClient, GeminiTtsError } from "../src/tts/gemini.ts";
import { createGroundedScriptGenerator, GroundedScriptError } from "../src/worker/script.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";

const OUT = new URL("../docs/evidence/audio-feed-0cmu/repro.json", import.meta.url);
/** The worker's real lease is minutes away, which is what made the re-ref'd timer so visible. */
const LEASE_MS = 10 * 60_000;

/** The production shape of a stalled response: the response arrives, its body never does. */
const hanging = (status: number, statusText: string): typeof fetch =>
  ((_input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const signal = init?.signal;
            if (signal?.aborted) {
              controller.error(signal.reason);
              return;
            }
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        }),
        { status, statusText },
      ),
    )) as typeof fetch;

/** Runs a `deno eval` child under a bound and reports whether it exited on its own. */
async function childProbe(code: string, boundMs: number): Promise<Record<string, unknown>> {
  const job = new Deno.Command(Deno.execPath(), {
    args: ["eval", code],
    stdout: "piped",
    stderr: "piped",
  })
    .spawn();
  const kill = setTimeout(() => job.kill("SIGKILL"), boundMs);
  const started = performance.now();
  const { code: exitCode } = await job.output();
  clearTimeout(kill);
  const elapsedMs = Math.round(performance.now() - started);
  return { code, elapsedMs, exitCode, exitedOnItsOwn: elapsedMs < boundMs - 500 };
}

// A regression leaves the process alive; fail loudly instead of hanging a lane for the lease.
const watchdog = setTimeout(() => {
  console.error(
    "[0cmu] FAIL: still alive 30s after the work finished — something outlives the request again",
  );
  Deno.exit(1);
}, 30_000);
Deno.unrefTimer(watchdog);

console.error("[0cmu] measuring the runtime mechanism (fresh children, 5s bound each)…");
const mechanism = {
  observation:
    "A bare AbortSignal.timeout does not hold the loop open; the same timer does once the " +
    "AbortSignal.any composite around it has aborted. Recorded, not asserted: it is Deno's " +
    "behaviour, not this repo's, and a future runtime may change it.",
  unfiredTimeoutAlone: await childProbe(
    'AbortSignal.timeout(600_000); console.log("created");',
    5_000,
  ),
  compositeNeverAborted: await childProbe(
    'AbortSignal.any([AbortSignal.timeout(600_000)]); console.log("created");',
    5_000,
  ),
  compositeAfterAbort: await childProbe(
    "const any = AbortSignal.any([AbortSignal.timeout(600_000), AbortSignal.timeout(100)]);" +
      ' any.addEventListener("abort", () => console.log("aborted"));' +
      ' await new Promise((r) => setTimeout(r, 300)); console.log("work done");',
    5_000,
  ),
};

// Case A — the TTS request, as the worker calls it: a live lease signal and a fired deadline.
const lease = AbortSignal.timeout(LEASE_MS);
const tts = new GeminiTtsClient({
  apiKey: "unused",
  fetchFn: hanging(503, "Service Unavailable"),
  timeoutMs: 200,
  retryOn: "none",
});
let ttsMessage = "";
let ttsWasGeminiError = false;
try {
  await tts.sendRequest({
    contents: [{ parts: [{ text: "hi" }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
    },
  }, { signal: lease });
} catch (error) {
  ttsMessage = error instanceof Error ? error.message : String(error);
  ttsWasGeminiError = error instanceof GeminiTtsError;
}
const caseTtsRequest = {
  callerSignalFiresInMs: LEASE_MS,
  deadlineMs: 200,
  isGeminiTtsError: ttsWasGeminiError,
  namesTheDeadline: /timed out after 200ms/.test(ttsMessage),
  message: ttsMessage,
};

// Case B — the whole worker batch, with the claim lease a real episode gets.
const config: AppConfig = { port: 8000, publicBaseUrl: "https://audio.example.com" };
const stores = memoryStores();
await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
await stores.metadata.putArticle(
  makeArticle({ id: "article-1", userId: "user-1", sourceId: "inbox" }),
);
await stores.metadata.putEpisode(
  makeEpisode({
    id: "episode-1",
    userId: "user-1",
    sourceId: "inbox",
    articleId: "article-1",
    status: "pending",
    mode: "direct",
    audioKey: undefined,
  }),
);
const synthesizer = createGeminiSynthesizer({ config, stores }, {
  client: tts,
  scriptGenerator: null,
});
const batch = await runSynthesisBatch({ config, stores }, synthesizer, {
  leaseMs: 15 * 60_000,
  retryBaseDelayMs: 1,
});
const episode = await stores.metadata.getEpisode("user-1", "episode-1");
const caseWorkerBatch = {
  leaseMs: 15 * 60_000,
  considered: batch.considered,
  failed: batch.failed.length,
  episodeStatus: episode?.status,
  persistedError: episode?.error ?? null,
  namesTheDeadline: /timed out after 200ms/.test(String(episode?.error ?? "")),
};

// Case C — the script stage: the caller's stage bound is minutes, the per-turn deadline is not.
let scriptMessage = "";
let scriptWasGroundedError = false;
try {
  const generator = createGroundedScriptGenerator({
    apiKey: "unused",
    timeoutMs: 200,
    // The real shape of a stall: fetch never settles, and only the abort ends it. (Its body-read
    // paths swallow an abort of their own — a separate defect, filed as its own bead.)
    fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
        } else {signal.addEventListener("abort", () =>
            reject(signal.reason), { once: true });}
      })) as typeof fetch,
  });
  await generator({
    article: { title: "t", body: "b" },
    speakers: [
      { name: "Alex", role: "expert", voice: "Charon" },
      { name: "Sam", role: "curious_foil", voice: "Puck" },
    ],
  }, { signal: lease });
} catch (error) {
  scriptMessage = error instanceof Error ? error.message : String(error);
  scriptWasGroundedError = error instanceof GroundedScriptError;
}
const caseScriptStage = {
  callerStageBoundMs: LEASE_MS,
  deadlineMs: 200,
  isGroundedScriptError: scriptWasGroundedError,
  namesTheDeadline: /timed out after 200ms/.test(scriptMessage),
  message: scriptMessage,
};

const report = {
  bead: "audio-feed-0cmu",
  ranAt: new Date().toISOString(),
  runtime: `deno ${Deno.version.deno}`,
  property:
    "After a timed-out attempt the process must end on its own: the caller's lease timer must " +
    "not be re-ref'd by an aborted AbortSignal.any composite.",
  exitIsMeasuredByTheCaller:
    "This script cannot time its own exit. tests/tts_hardening_test.ts runs the same shape as a " +
    "child and fails if it has not exited within 15s; on the pre-fix code that child was killed " +
    "at 20s (measured).",
  mechanism,
  cases: { caseTtsRequest, caseWorkerBatch, caseScriptStage },
  finishedAtMs: Math.round(performance.now()),
};
await Deno.mkdir(new URL(".", OUT), { recursive: true });
await Deno.writeTextFile(OUT, JSON.stringify(report, null, 2) + "\n");
console.error(`[0cmu] wrote ${OUT.pathname}`);

const ok = caseTtsRequest.namesTheDeadline && caseTtsRequest.isGeminiTtsError &&
  caseWorkerBatch.namesTheDeadline && caseWorkerBatch.failed === 1 &&
  caseScriptStage.namesTheDeadline && caseScriptStage.isGroundedScriptError;
console.error(ok ? "[0cmu] PASS" : "[0cmu] FAIL");
if (!ok) Deno.exit(1);
