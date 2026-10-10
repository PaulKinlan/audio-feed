/**
 * Reproduction for audio-feed-icl4 (P3), found by the audio-feed-bp6r reviewer.
 *
 * The 2xx branch names a deadline-fired response-body read, but the non-2xx branch wrapped its
 * error-body read in a bare `catch {}` that swallowed BOTH the abort and a caller cancel. So a
 * proxy/gateway 5xx with a slowly-streaming error body looked like an ordinary provider 503 with an
 * empty body, and the lease-expiry case was dressed up as a provider error.
 *
 * Two cases, both local (no network, no spend): a scripted fetchFn returns the response.
 *   A. deadline-killed error body: the persisted episode error must name the deadline that fired
 *      AND keep the provider status (classification unchanged: still permanent, still labelled
 *      "provider status 503").
 *   B. caller-aborted error body: the raw abort reason must surface, not a 503.
 *
 * Run: timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_icl4_nonok_body_read.ts
 */
import { memoryStores } from "../src/config.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { GeminiTtsClient, GeminiTtsError } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";
import type { AppConfig } from "../src/config.ts";

const config: AppConfig = { port: 8000, publicBaseUrl: "https://audio.example.com" };
/** Production lease: the worker always passes a live lease signal, which is what made the old
 *  `!options.signal` guard (and this swallow) reachable. */
const LEASE_MS = 15 * 60_000;

/** A 503 whose error body streams forever: only the deadline (or a caller abort) ends the read. */
const hangingErrorBody = () =>
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
        { status: 503, statusText: "Service Unavailable", headers: { "content-type": "text/html" } },
      ),
    )) as typeof fetch;

async function queued() {
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
  return { ctx: { config, stores }, stores };
}

const report: Record<string, unknown> = {
  bead: "audio-feed-icl4",
  capturedAt: new Date().toISOString(),
  capturedAgainst:
    "post-fix; the pre-fix persisted string is quoted from the reviewer's bead evidence",
  preFixPersistedError: "TTS turn failed; refusing whole-episode retry: Gemini API HTTP error 503: " +
    "Service Unavailable [model=gemini-3.8-flash-tts, inputBytes=..., estimatedInputTokens<=..., " +
    "maxOutputTokens=16384] [mode direct; claim 1/3; provider status 503]",
};

// ---------------------------------------------------------------------------
// A: deadline-killed error body, through the REAL worker loop and store
// ---------------------------------------------------------------------------
{
  const { ctx, stores } = await queued();
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: hangingErrorBody(),
    timeoutMs: 200,
    retryOn: "none",
    retryBaseDelayMs: 1,
  });
  const synthesize = createGeminiSynthesizer(ctx, { client, scriptGenerator: null });
  const result = await runSynthesisBatch(ctx, synthesize, {
    leaseMs: LEASE_MS,
    retryBaseDelayMs: 1,
  });
  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  report.caseA_deadlineKilledErrorBody = {
    description:
      "503 + a never-enqueuing error body, per-attempt deadline 200ms, 15-minute lease signal live " +
      "but never fired. Driven through createGeminiSynthesizer + runSynthesisBatch, so the recorded " +
      "string is the one an operator would see.",
    status: episode?.status,
    persistedError: episode?.error,
    failed: result.failed,
    namesTheDeadline: /timed out after 200ms while reading the error response body/.test(
      episode?.error ?? "",
    ),
    keepsProviderStatus: /provider status 503/.test(episode?.error ?? ""),
  };
  console.error(`[icl4] A: ${episode?.error}`);
}

// ---------------------------------------------------------------------------
// B: caller-aborted error body — the lease expiry must not become a 503
// ---------------------------------------------------------------------------
{
  const caller = new AbortController();
  caller.abort(new Error("lease expired"));
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: hangingErrorBody(),
    timeoutMs: 30_000,
    retryOn: "none",
  });
  let outcome: Record<string, unknown>;
  try {
    await client.synthesizeNarration(
      { title: "Title", body: "hello" },
      { signal: caller.signal },
    );
    outcome = { result: "unexpected success" };
  } catch (error) {
    outcome = {
      result: "failure",
      isProviderError: error instanceof GeminiTtsError,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  report.caseB_callerAbortedErrorBody = {
    description:
      "The CALLER's signal aborts while the error body is being read. The lease expiry must surface " +
      "as itself, not be dressed up as provider status 503.",
    ...outcome,
  };
  console.error(`[icl4] B: ${JSON.stringify(outcome)}`);
}

const outPath = new URL("../docs/evidence/audio-feed-icl4/repro.json", import.meta.url);
await Deno.mkdir(new URL(".", outPath), { recursive: true });
await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2) + "\n");
console.error(`[icl4] wrote ${outPath.pathname}`);

// Assert the two behaviours, so this is a re-runnable check and not just a report.
const caseA = report.caseA_deadlineKilledErrorBody as Record<string, unknown>;
const caseB = report.caseB_callerAbortedErrorBody as Record<string, unknown>;
const ok = caseA.namesTheDeadline === true && caseA.keepsProviderStatus === true &&
  caseB.isProviderError === false && /lease expired/.test(String(caseB.message ?? ""));
console.error(ok ? "[icl4] PASS" : "[icl4] FAIL");
// Explicit exit: the guard being exercised is the worker's live lease signal, an AbortSignal.timeout
// that outlives this run (15 minutes here). Without this the process lingers until it fires, and a
// lane that runs it without an outer bound looks like a stuck lane to the reaper.
Deno.exit(ok ? 0 : 1);
