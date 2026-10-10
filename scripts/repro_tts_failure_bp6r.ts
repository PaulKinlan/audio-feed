/**
 * Reproduction for audio-feed-bp6r (Paul-reported incident, 2026-10-09):
 * 10 sharptext.net episodes failed; the UI showed either "abandoned after 3
 * attempts" or a bare timeout message, with no provider detail.
 *
 * Three parts:
 *  A. REAL multi-segment synthesis through the production client against the
 *     auth-injecting proxy (gemini.int.exe.xyz), with an instrumented fetchFn
 *     recording every HTTP call: endpoint, status, per-attempt duration, error
 *     body. This is the same client path the Deno.cron worker runs.
 *  B. DETERMINISTIC timeout: the same client with a 1.5s per-attempt deadline,
 *     capturing the exact error chain Paul saw ("The operation was aborted due
 *     to timeout" -> "TTS turn failed; refusing whole-episode retry", status
 *     400) and proving no per-segment retry happens for multi-segment input.
 *  C. LOCAL abandon-overwrite: drive MemoryMetadataStore.claimEpisode through
 *     3 expiring claims and show the 4th claim overwriting the recorded error
 *     with "abandoned after 3 attempts".
 *
 * Run: GEMINI_API_KEY=dummy-via-proxy timeout -k 30 900 deno run -A scripts/repro_tts_failure_bp6r.ts
 */
import { GeminiTtsClient, GeminiTtsError } from "../src/tts/gemini.ts";
import { splitTextUnderByteBudget } from "../src/synthesis/limits.ts";
import { MAX_TTS_INPUT_BYTES } from "../src/tts/gemini.ts";
import { MemoryMetadataStore } from "../src/storage/memory.ts";
import { makeEpisode } from "../tests/fixtures.ts";

const PROXY = "https://gemini.int.exe.xyz/v1beta";

interface HttpObservation {
  seq: number;
  url: string;
  startedAt: string;
  durationMs: number;
  status?: number;
  statusText?: string;
  errorName?: string;
  errorMessage?: string;
  responseErrorBody?: unknown;
}

function instrumentedFetch(log: HttpObservation[]): typeof fetch {
  let seq = 0;
  return async (input, init) => {
    const n = ++seq;
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    try {
      const res = await fetch(input, init);
      const durationMs = Math.round(performance.now() - t0);
      const obs: HttpObservation = {
        seq: n,
        url: String(input),
        startedAt,
        durationMs,
        status: res.status,
        statusText: res.statusText,
      };
      if (!res.ok) {
        // Clone so the client's own res.json() still works.
        obs.responseErrorBody = await res.clone().json().catch(() => "<unparseable body>");
      }
      log.push(obs);
      return res;
    } catch (error) {
      log.push({
        seq: n,
        url: String(input),
        startedAt,
        durationMs: Math.round(performance.now() - t0),
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

const article = await Deno.readTextFile(
  new URL("../docs/evidence/audio-feed-gueb/article.txt", import.meta.url),
);

const report: Record<string, unknown> = {
  bead: "audio-feed-bp6r",
  capturedAt: new Date().toISOString(),
  provider: {
    endpoint: `${PROXY}/models/gemini-3.8-flash-tts:generateContent`,
    note: "gemini.int.exe.xyz injects Paul's real API key; the client sends a dummy key",
    model: "gemini-3.8-flash-tts",
  },
};

// ---------------------------------------------------------------------------
// Part A: real multi-segment synthesis, production defaults (60s per attempt)
// ---------------------------------------------------------------------------
{
  const http: HttpObservation[] = [];
  const client = new GeminiTtsClient({
    apiKey: "dummy-via-proxy",
    baseUrl: PROXY,
    fetchFn: instrumentedFetch(http),
    // Production defaults, stated explicitly so the evidence names them:
    timeoutMs: 60_000,
    maxRetries: 1,
    retryOn: "transient",
  });
  const t0 = performance.now();
  let outcome: Record<string, unknown>;
  try {
    const audio = await client.synthesizeNarration({
      title: "History of the Internet",
      body: article,
      author: "Reproduction",
      publishedAt: "2026-10-09",
      sourceName: "sharptext.net (repro fixture)",
    });
    outcome = {
      result: "success",
      totalMs: Math.round(performance.now() - t0),
      durationSeconds: audio.durationSeconds,
      finishReason: audio.finishReason,
      truncated: audio.truncated,
      bytes: audio.rawBytes.length,
    };
  } catch (error) {
    outcome = {
      result: "failure",
      totalMs: Math.round(performance.now() - t0),
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStatus: error instanceof GeminiTtsError ? error.status : undefined,
      innerError: error instanceof GeminiTtsError && error.details instanceof Error
        ? { name: error.details.name, message: error.details.message }
        : undefined,
    };
  }
  const segments = splitTextUnderByteBudget(article, MAX_TTS_INPUT_BYTES);
  report.partA_realMultiSegment = {
    description:
      "Full 8-segment narration through the production client, production timeout (60s), " +
      "production retry policy (multi-segment forces maxRetries 0 per segment)",
    segmentCount: segments.length,
    segmentBytes: segments.map((s) => new TextEncoder().encode(s).length),
    outcome,
    http,
  };
  console.error(`[repro] part A done: ${JSON.stringify(outcome)}`);
}

// ---------------------------------------------------------------------------
// Part B: deterministic per-attempt timeout (1.5s deadline), same error chain
// ---------------------------------------------------------------------------
{
  const http: HttpObservation[] = [];
  const client = new GeminiTtsClient({
    apiKey: "dummy-via-proxy",
    baseUrl: PROXY,
    fetchFn: instrumentedFetch(http),
    timeoutMs: 1_500,
  });
  let outcome: Record<string, unknown>;
  const t0 = performance.now();
  try {
    await client.synthesizeNarration({ title: "Timeout repro", body: article });
    outcome = { result: "unexpected success" };
  } catch (error) {
    outcome = {
      result: "failure",
      totalMs: Math.round(performance.now() - t0),
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      wrappedStatus: error instanceof GeminiTtsError ? error.status : undefined,
      innerError: error instanceof GeminiTtsError && error.details instanceof Error
        ? {
          name: error.details.name,
          message: error.details.message,
          status: error.details instanceof GeminiTtsError ? error.details.status : undefined,
        }
        : undefined,
    };
  }
  report.partB_forcedTimeout = {
    description:
      "Same client, per-attempt deadline 1.5s so the first segment aborts. Proves: (1) " +
      "multi-segment input gets maxRetries 0 -> exactly one HTTP call, (2) the timeout is " +
      "rethrown (retryOn 'transient' covers only 429/503), (3) the wrapper re-labels it " +
      "status 400, which the worker's isPermanent() treats as terminal on attempt 1.",
    httpCallsMade: http.length,
    outcome,
    http,
  };
  console.error(`[repro] part B done: ${JSON.stringify(outcome)}`);
}

// ---------------------------------------------------------------------------
// Part C: abandon path overwrites the recorded cause (local, no network)
// ---------------------------------------------------------------------------
{
  const store = new MemoryMetadataStore();
  const episode = makeEpisode({
    id: "ep-repro",
    userId: "user-1",
    status: "pending",
    audioKey: undefined,
    byteLength: undefined,
    durationSeconds: undefined,
    contentType: undefined,
  });
  await store.putEpisode(episode);

  const leaseMs = 60_000;
  const maxClaims = 3;
  const owner = "repro-worker";
  let t = Date.parse("2026-10-09T00:00:00Z");
  const claims: unknown[] = [];
  for (let i = 1; i <= 3; i++) {
    const claimed = await store.claimEpisode("user-1", "ep-repro", {
      owner,
      now: new Date(t).toISOString(),
      leaseMs,
      maxClaims,
    });
    // Simulate the production pattern: the claim fails and the LAST thing the
    // worker managed to write (or not) is on the record before the lease expires.
    const recorded = await store.getEpisode("user-1", "ep-repro");
    await store.putEpisode({
      ...recorded!,
      // A real worker failure write lands as status failed; to stay claimable the
      // repro keeps it synthesizing with an expired lease — the shape the nine
      // abandoned episodes were in (no terminal write landed).
      error: i === 3
        ? "TTS turn failed; refusing whole-episode retry: Gemini TTS request timed out after 60000ms"
        : recorded!.error,
    });
    claims.push({ claim: i, attempts: claimed?.attempts, status: claimed?.status });
    t += leaseMs + 1_000; // let the lease expire so the next tick can reclaim
  }
  const before = await store.getEpisode("user-1", "ep-repro");
  const fourth = await store.claimEpisode("user-1", "ep-repro", {
    owner,
    now: new Date(t).toISOString(),
    leaseMs,
    maxClaims,
  });
  const after = await store.getEpisode("user-1", "ep-repro");
  report.partC_abandonOverwrite = {
    description:
      "3 expired claims, the last of which recorded the real timeout cause; the 4th claim " +
      "attempt hits maxClaims and the store abandons the episode.",
    claims,
    fourthClaimReturned: fourth === null ? null : "episode (unexpected)",
    errorBeforeAbandon: before?.error,
    errorAfterAbandon: after?.error,
    statusAfterAbandon: after?.status,
    realCauseSurvives: after?.error?.includes("timed out") ?? false,
  };
  console.error(`[repro] part C done: errorAfter=${after?.error}`);
}

const outPath = new URL("../docs/evidence/audio-feed-bp6r/repro.json", import.meta.url);
await Deno.mkdir(new URL(".", outPath), { recursive: true });
await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
console.log(`wrote ${outPath.pathname}`);
