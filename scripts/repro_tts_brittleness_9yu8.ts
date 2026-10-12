/**
 * Live verification for audio-feed-9yu8 — the brittleness behind the 2026-10-09 incident
 * (audio-feed-bp6r): a 60s per-attempt deadline inside the real latency distribution, a
 * deadline abort that was never retried per segment, and a wrapper that relabelled our own
 * abort as a provider-looking 400.
 *
 * It runs the REAL client against the auth-injecting proxy (gemini.int.exe.xyz) with an
 * instrumented fetchFn, so the HTTP call count itself is the evidence — not an assertion
 * about a helper.
 *
 *  A. REAL one-segment narration with production defaults (120s deadline, one timeout retry):
 *     the happy path still works and the configured deadline is what was in force.
 *  B. REAL multi-segment input with a forced 1.5s deadline and the DEFAULT policy: a timeout
 *     is retried ONCE even though multi-segment forces maxRetries 0, and the wrapper that comes
 *     out is status-less and transient (the worker's maxAttempts can now apply).
 *  C. Same, retryOn: "none": exactly one HTTP call, so an operator can still opt out.
 *  D. LIVE provider rejection (a bogus model): the provider's own status survives the wrapper
 *     and the failure stays permanent — the re-billing guard, captured, not asserted.
 *
 * Cost note: A is one small paid synthesis; B and C abort at 1.5s (a deadline can fire after the
 * provider began generating, which is the double-bill risk the bead documents); D is rejected
 * before any audio is generated.
 *
 * Run: GEMINI_API_KEY=dummy-via-proxy timeout -k 30 600 deno run -A scripts/repro_tts_brittleness_9yu8.ts
 */
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_RETRIES,
  GeminiTtsClient,
  GeminiTtsError,
} from "../src/tts/gemini.ts";
import { splitTextUnderByteBudget } from "../src/synthesis/limits.ts";
import { MAX_TTS_INPUT_BYTES } from "../src/tts/gemini.ts";
import { loadConfig } from "../src/config.ts";
import { runProof, writeEvidenceReadme } from "./proof-helper.ts";

const PROXY = "https://gemini.int.exe.xyz/v1beta";

interface HttpObservation {
  seq: number;
  url: string;
  durationMs: number;
  status?: number;
  statusText?: string;
  errorName?: string;
  errorMessage?: string;
}

function instrumentedFetch(log: HttpObservation[]): typeof fetch {
  let seq = 0;
  return async (input, init) => {
    const n = ++seq;
    const t0 = performance.now();
    try {
      const res = await fetch(input, init);
      log.push({
        seq: n,
        url: String(input),
        durationMs: Math.round(performance.now() - t0),
        status: res.status,
        statusText: res.statusText,
      });
      return res;
    } catch (error) {
      log.push({
        seq: n,
        url: String(input),
        durationMs: Math.round(performance.now() - t0),
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/** The error chain, flattened so the evidence shows what the worker will classify. */
function describe(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    status: error instanceof GeminiTtsError ? error.status : undefined,
    permanent: error instanceof GeminiTtsError ? error.permanent : undefined,
    innerError: error instanceof GeminiTtsError && error.details instanceof Error
      ? {
        name: error.details.name,
        message: error.details.message,
        status: error.details instanceof GeminiTtsError ? error.details.status : undefined,
      }
      : undefined,
  };
}

const article = await Deno.readTextFile(
  new URL("../docs/evidence/audio-feed-gueb/article.txt", import.meta.url),
);
// Long enough to force the multi-segment path (maxRetries 0 per segment), short enough that only
// the first segment's attempts are made before the thrown failure.
const multiSegmentBody = article.slice(0, 13_000);

await runProof("repro_tts_brittleness_9yu8", async (checker) => {
  const report: Record<string, unknown> = {
    bead: "audio-feed-9yu8",
    capturedAt: new Date().toISOString(),
    capturedAgainst: "post-fix (the pre-fix capture is docs/evidence/audio-feed-bp6r/repro.json)",
    provider: {
      endpoint: `${PROXY}/models/gemini-3.8-flash-tts:generateContent`,
      note: "gemini.int.exe.xyz injects Paul's real API key; the client sends a dummy key",
      model: "gemini-3.8-flash-tts",
    },
    defaults: {
      DEFAULT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_RETRIES,
    },
  };

  // ---------------------------------------------------------------------------
  // Part A: the happy path, production defaults (120s deadline)
  // ---------------------------------------------------------------------------
  {
    const http: HttpObservation[] = [];
    const client = new GeminiTtsClient({
      apiKey: "dummy-via-proxy",
      baseUrl: PROXY,
      fetchFn: instrumentedFetch(http),
      // Production defaults, stated explicitly so the evidence names what was in force.
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retryOn: "transient",
    });
    const t0 = performance.now();
    let outcome: Record<string, unknown>;
    try {
      const audio = await client.synthesizeNarration({
        title: "Deadline verification",
        body: "Paul's audio feed verifies the per-attempt deadline and timeout retry.",
        author: "Verification",
        publishedAt: "2026-10-10",
      });
      outcome = {
        result: "success",
        totalMs: Math.round(performance.now() - t0),
        durationSeconds: audio.durationSeconds,
        bytes: audio.rawBytes.length,
        finishReason: audio.finishReason,
        truncated: audio.truncated,
      };
    } catch (error) {
      outcome = {
        result: "failure",
        totalMs: Math.round(performance.now() - t0),
        ...describe(error),
      };
    }
    report.partA_realNarration = {
      description:
        "One real narration through the production client with the new 120s default deadline and " +
        "default retry policy (no timeout retry is exercised: the call succeeds).",
      outcome,
      httpCallsMade: http.length,
      http,
    };
    console.error(`[9yu8] part A done: ${JSON.stringify(outcome)}`);
  }

  // ---------------------------------------------------------------------------
  // Part B: forced 1.5s deadline, DEFAULT policy, multi-segment input
  // ---------------------------------------------------------------------------
  {
    const segments = splitTextUnderByteBudget(multiSegmentBody, MAX_TTS_INPUT_BYTES);
    const http: HttpObservation[] = [];
    const client = new GeminiTtsClient({
      apiKey: "dummy-via-proxy",
      baseUrl: PROXY,
      fetchFn: instrumentedFetch(http),
      timeoutMs: 1_500, // forced so a timeout is deterministic
      // retryOn and timeoutRetries left at their production defaults.
    });
    const t0 = performance.now();
    let outcome: Record<string, unknown>;
    try {
      await client.synthesizeNarration({ title: "Timeout verification", body: multiSegmentBody });
      outcome = { result: "unexpected success" };
    } catch (error) {
      outcome = {
        result: "failure",
        totalMs: Math.round(performance.now() - t0),
        ...describe(error),
      };
    }
    report.partB_deadlineRetry = {
      description:
        "Multi-segment input (>1 segment forces maxRetries 0 per segment) with a forced 1.5s " +
        "deadline. Expect 2 HTTP calls for the first segment: the deadline retry fires on its own " +
        "budget, then the failure surfaces status-less and transient instead of as our own 400.",
      segmentCount: segments.length,
      outcome,
      httpCallsMade: http.length,
      http,
    };
    console.error(`[9yu8] part B done: ${JSON.stringify(outcome)} calls=${http.length}`);
  }

  // ---------------------------------------------------------------------------
  // Part C: retryOn: "none" keeps a deadline terminal after one attempt
  // ---------------------------------------------------------------------------
  {
    const http: HttpObservation[] = [];
    const client = new GeminiTtsClient({
      apiKey: "dummy-via-proxy",
      baseUrl: PROXY,
      fetchFn: instrumentedFetch(http),
      timeoutMs: 1_500,
      retryOn: "none",
    });
    let outcome: Record<string, unknown>;
    try {
      await client.synthesizeNarration({ title: "Timeout opt-out", body: multiSegmentBody });
      outcome = { result: "unexpected success" };
    } catch (error) {
      outcome = describe(error);
    }
    report.partC_retryOptOut = {
      description:
        "The same forced deadline with retryOn: 'none'. Expect exactly 1 HTTP call: the operator " +
        "opt-out is preserved for the deadline retry too.",
      outcome,
      httpCallsMade: http.length,
      http,
    };
    console.error(`[9yu8] part C done: calls=${http.length}`);
  }

  // ---------------------------------------------------------------------------
  // Part D: a live provider verdict stays permanent through the wrapper
  // ---------------------------------------------------------------------------
  {
    const http: HttpObservation[] = [];
    const client = new GeminiTtsClient({
      apiKey: "dummy-via-proxy",
      baseUrl: PROXY,
      model: "gemini-3.8-flash-tts-does-not-exist",
      fetchFn: instrumentedFetch(http),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retryOn: "none",
    });
    let outcome: Record<string, unknown>;
    try {
      await client.synthesizeNarration({
        title: "Provider rejection",
        body: "This request must be rejected by the provider.",
      });
      outcome = { result: "unexpected success" };
    } catch (error) {
      outcome = describe(error);
    }
    report.partD_providerVerdict = {
      description:
        "A bogus model name makes the proxy return the provider's real HTTP error. Expect the " +
        "provider's status to survive the wrapper and permanent === true: the re-billing guard " +
        "still refuses an episode retry for a provider verdict.",
      outcome,
      httpCallsMade: http.length,
      http,
    };
    console.error(`[9yu8] part D done: ${JSON.stringify(outcome)}`);
  }

  // ---------------------------------------------------------------------------
  // Part E: the environment knob, resolved by the real boot config (local, no network)
  // ---------------------------------------------------------------------------
  {
    const had = Deno.env.get("TTS_TIMEOUT_MS");
    try {
      Deno.env.delete("TTS_TIMEOUT_MS");
      const fallback = loadConfig().ttsTimeoutMs;
      Deno.env.set("TTS_TIMEOUT_MS", "45000");
      const override = loadConfig().ttsTimeoutMs;
      report.partE_envKnob = {
        description: "loadConfig resolves TTS_TIMEOUT_MS; unset means the 120s default.",
        unset: fallback,
        ttsTimeoutMs45000: override,
      };
    } finally {
      if (had === undefined) Deno.env.delete("TTS_TIMEOUT_MS");
      else Deno.env.set("TTS_TIMEOUT_MS", had);
    }
  }

  const outPath = new URL("../docs/evidence/audio-feed-9yu8/repro.json", import.meta.url);
  await Deno.mkdir(new URL(".", outPath), { recursive: true });
  await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2) + "\n");
  console.error(`[9yu8] wrote ${outPath.pathname}`);

  const partA = report.partA_realNarration as {
    outcome: Record<string, unknown>;
    httpCallsMade: number;
  };
  const partB = report.partB_deadlineRetry as {
    outcome: Record<string, unknown>;
    httpCallsMade: number;
    http: HttpObservation[];
  };
  const partC = report.partC_retryOptOut as {
    outcome: Record<string, unknown>;
    httpCallsMade: number;
    http: HttpObservation[];
  };
  const partD = report.partD_providerVerdict as {
    outcome: Record<string, unknown>;
    httpCallsMade: number;
  };
  const partE = report.partE_envKnob as { unset: number; ttsTimeoutMs45000: number };

  checker.check(
    "production defaults synthesize narration successfully within deadline",
    partA.outcome.result === "success" && partA.httpCallsMade === 1,
    `result: ${partA.outcome.result}, calls: ${partA.httpCallsMade}`,
  );
  checker.check(
    "forced timeout retries once on default policy",
    partB.httpCallsMade === 2 &&
      partB.outcome.result === "failure" &&
      partB.http.length === 2 &&
      partB.http.every((h) => h.errorName === "TimeoutError"),
    `calls: ${partB.httpCallsMade}, result: ${partB.outcome.result}, errors: ${
      partB.http.map((h) => h.errorName).join(",")
    }`,
  );
  checker.check(
    "timeout error surfaces as transient without provider HTTP status",
    partB.outcome.permanent === false && partB.outcome.status === undefined,
    `permanent: ${partB.outcome.permanent}, status: ${partB.outcome.status}`,
  );
  checker.check(
    "forced timeout with retryOn none makes exactly one HTTP attempt",
    partC.httpCallsMade === 1 &&
      partC.outcome.result !== "unexpected success" &&
      partC.http.length === 1 &&
      partC.http[0]?.errorName === "TimeoutError",
    `calls: ${partC.httpCallsMade}, error: ${partC.http[0]?.errorName}`,
  );
  checker.check(
    "provider model rejection preserves provider 404 status and marks failure permanent",
    partD.outcome.status === 404 && partD.outcome.permanent === true,
    `status: ${partD.outcome.status}, permanent: ${partD.outcome.permanent}`,
  );
  checker.check(
    "loadConfig respects TTS_TIMEOUT_MS environment override",
    partE.unset === 120_000 && partE.ttsTimeoutMs45000 === 45_000,
    `unset: ${partE.unset}, override: ${partE.ttsTimeoutMs45000}`,
  );

  await writeEvidenceReadme({
    dir: "docs/evidence/audio-feed-9yu8",
    title: "Evidence: audio-feed-9yu8",
    script: "scripts/repro_tts_brittleness_9yu8.ts",
    asserts: [
      "production defaults synthesize narration successfully within deadline",
      "forced timeout retries once on default policy",
      "timeout error surfaces as transient without provider HTTP status",
      "forced timeout with retryOn none makes exactly one HTTP attempt",
      "provider model rejection preserves provider 404 status and marks failure permanent",
      "loadConfig respects TTS_TIMEOUT_MS environment override",
    ],
    sections: [
      {
        heading: "Verification Overview",
        body:
          `Live verification for audio-feed-9yu8 — the brittleness behind the incident (audio-feed-bp6r):
a 60s per-attempt deadline inside the real latency distribution, a deadline abort that was never retried
per segment, and a wrapper that relabelled our own abort as a provider-looking 400.

1. **Happy Path**: One real narration through the production client with 120s default deadline and default retry policy completes within deadline.
2. **Deadline Retry**: Multi-segment input with forced 1.5s deadline retries once on default policy and surfaces as transient.
3. **Opt-Out**: Same forced deadline with retryOn: "none" makes exactly 1 HTTP call.
4. **Permanent Rejection**: Live provider rejection (non-existent model) preserves provider 404 status and marks permanent: true.
5. **Configuration**: loadConfig resolves TTS_TIMEOUT_MS environment override with 120s default fallback.`,
      },
    ],
  });
});
