/**
 * audio-feed-9yu8 — the brittleness behind the 2026-10-09 incident (audio-feed-bp6r):
 *
 * (1) a 60s per-attempt deadline that sat INSIDE the real 45-55s/segment distribution, and that
 *     no environment variable could raise;
 * (2) a deadline abort that was never retried, while multi-segment episodes forced
 *     `maxRetries: 0` — so one slow segment ended the whole episode;
 * (3) a whole-episode wrapper that relabelled our own abort as a provider-looking 400, which made
 *     it terminal on claim 1 while hiding the real cause.
 *
 * Everything here replaces the API with a scripted fetchFn, so retry counts and deadlines are
 * asserted without network access or spend. The last two cases drive the REAL client through the
 * REAL `createGeminiSynthesizer` seam — including a replaced `globalThis.fetch`, which the client
 * captures at construction — so the config→client plumbing is checked at its call site rather than
 * through a helper's opinion.
 */
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { loadConfig, memoryStores } from "../src/config.ts";
import { createGeminiSynthesizer } from "../src/worker/synthesis.ts";
import {
  decodedFromWav,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_RETRIES,
  GeminiTtsClient,
  GeminiTtsError,
  pcmToWav,
  ttsClientConfig,
} from "../src/tts/gemini.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode } from "./fixtures.ts";
import type { AppConfig } from "../src/config.ts";
import type { AppContext } from "../src/app.ts";

/** Minimal valid base64 payload (4 raw bytes) so decoding succeeds. */
const PAYLOAD = btoa("\x01\x02\x03\x04");

const okResponse = () =>
  new Response(
    JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: "audio/wav", data: PAYLOAD } }] },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const errorResponse = (status: number) =>
  new Response(JSON.stringify({ error: { message: `boom ${status}` } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A request that only ever ends by aborting: the per-attempt deadline is the only exit. */
const hangs = () =>
  ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;

const request = {
  contents: [{ parts: [{ text: "hi" }] }],
  generationConfig: {
    responseModalities: ["AUDIO"] as ["AUDIO"],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
  },
};

const client = (fetchFn: typeof fetch, config: Record<string, unknown> = {}) =>
  new GeminiTtsClient({ apiKey: "test-key", fetchFn, retryBaseDelayMs: 1, ...config });

/** A decode result a mocked client can hand back without any provider round-trip. */
const fakeAudio = (): DecodedAudioResult => {
  const pcm = new Uint8Array(64);
  const wav = pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
  return { ...decodedFromWav(wav), durationSeconds: 10 };
};

/** A client whose per-call options are recorded, so a test can see WHICH deadline the batch passed. */
const recordingClient = (constructorTimeoutMs: number, seen: Array<number | undefined>) => {
  const mock = new GeminiTtsClient({ apiKey: "dummy-key", timeoutMs: constructorTimeoutMs });
  mock.synthesizeNarration = (_input, options) => {
    seen.push(options?.timeoutMs);
    return Promise.resolve(fakeAudio());
  };
  return mock;
};

Deno.test("the default deadline is 120s and carries one timeout retry (audio-feed-9yu8)", () => {
  // The two numbers this bead exists to change. 9vns measured 45-55s/segment and the recorded
  // failure needed 59.8s just for headers+body, so 60s sat inside the distribution.
  assertEquals(DEFAULT_TIMEOUT_MS, 120_000);
  assertEquals(DEFAULT_TIMEOUT_RETRIES, 1);
});

Deno.test("a deadline abort is retried once and the retry's audio is returned, even with maxRetries 0 (audio-feed-9yu8)", async () => {
  // A multi-segment episode spreads `maxRetries: 0` over every segment, so the old code had no
  // retry at all here. One slow segment must not be able to end the episode.
  let calls = 0;
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }
    return Promise.resolve(okResponse());
  }) as typeof fetch;

  const result = await client(fetchFn, { timeoutMs: 60, maxRetries: 0 }).sendRequest(request);
  assertEquals(calls, 2, "maxRetries 0 must not make a deadline terminal");
  assertEquals(result.truncated, false, "the retry's complete audio must be returned");
});

Deno.test("a deadline is retried at most once per segment (audio-feed-9yu8)", async () => {
  let calls = 0;
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as typeof fetch;

  const error = await assertRejects(
    () => client(fetchFn, { timeoutMs: 60, timeoutRetries: 1 }).sendRequest(request),
    GeminiTtsError,
    "timed out after 60ms",
  );
  assertEquals(calls, 2, "one retry, not an unbounded loop");
  assertEquals((error as GeminiTtsError).status, undefined, "a deadline is not a provider status");
});

Deno.test("retryOn: 'none' still disables the deadline retry entirely (audio-feed-9yu8)", async () => {
  let calls = 0;
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as typeof fetch;

  await assertRejects(
    () => client(fetchFn, { timeoutMs: 60, retryOn: "none" }).sendRequest(request),
    GeminiTtsError,
    "timed out after 60ms",
  );
  assertEquals(calls, 1, "an operator who opted out of retries gets exactly one attempt");
});

Deno.test("the body-read deadline is retried too — the path the incident took (audio-feed-9yu8)", async () => {
  let calls = 0;
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (calls > 1) return Promise.resolve(okResponse());
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;

  const result = await client(fetchFn, { timeoutMs: 60, maxRetries: 0 }).sendRequest(request);
  assertEquals(calls, 2, "a stalled body read must be retried, not fatal");
  assertEquals(result.truncated, false);
});

Deno.test("a deadline retry does not consume the status-retry budget (audio-feed-9yu8)", async () => {
  // One timeout, then one 429, then success: the timeout has its own budget, and the status
  // budget (maxRetries 1) is still intact afterwards.
  let calls = 0;
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }
    if (calls === 2) return Promise.resolve(errorResponse(429));
    return Promise.resolve(okResponse());
  }) as typeof fetch;

  await client(fetchFn, { timeoutMs: 60, maxRetries: 1 }).sendRequest(request);
  assertEquals(calls, 3, "one deadline retry plus one status retry");
});

Deno.test("TTS_TIMEOUT_MS is validated at boot and defaults to 120s (audio-feed-9yu8)", () => {
  // Fake readers, not process-global env mutation (audio-feed-lnnjd).
  const ttsEnv = (value?: string) => ({
    get: (key: string) => key === "TTS_TIMEOUT_MS" ? value : undefined,
  });

  assertEquals(
    loadConfig(ttsEnv()).ttsTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    "unset means the new default",
  );

  assertEquals(
    loadConfig(ttsEnv("45000")).ttsTimeoutMs,
    45_000,
    "an operator can raise or lower it",
  );

  for (const bad of ["0", "-1", "1.5", "soon", "120000ms"]) {
    assertThrows(
      () => loadConfig(ttsEnv(bad)),
      Error,
      "Invalid TTS_TIMEOUT_MS",
      `"${bad}" must fail closed rather than silently use the default`,
    );
  }
});

Deno.test("ttsClientConfig carries the configured deadline into the client (audio-feed-9yu8)", async () => {
  const config = ttsClientConfig({ geminiApiKey: "test-key", ttsTimeoutMs: 150 });
  assertEquals(config.timeoutMs, 150);

  let calls = 0;
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as typeof fetch;

  await assertRejects(
    () =>
      new GeminiTtsClient({ ...config, fetchFn, retryBaseDelayMs: 1, retryOn: "none" }).sendRequest(
        request,
      ),
    GeminiTtsError,
    "timed out after 150ms",
  );
  assertEquals(calls, 1);
});

Deno.test("createGeminiSynthesizer drives the real client with the configured deadline (audio-feed-9yu8)", async () => {
  // The production call site, not a helper: createGeminiSynthesizer builds its own client, and the
  // client captures `fetch` at construction — so replacing globalThis.fetch here observes exactly
  // what production would send, and with which per-attempt deadline.
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as typeof fetch;

    const ctx = {
      config: { port: 0, geminiApiKey: "test-key", ttsTimeoutMs: 120 } as AppConfig,
      stores: memoryStores(),
    } as unknown as AppContext;

    // scriptGenerator: null keeps the deep-dive script stage out of this direct-mode path.
    const synthesize = createGeminiSynthesizer(ctx, { scriptGenerator: null });
    const error = await assertRejects(() =>
      synthesize({
        article: makeArticle(),
        source: null,
        episode: makeEpisode(),
        mode: "direct",
      })
    );
    assertStringIncludes(String((error as Error).message), "timed out after 120ms");
    assertEquals(calls, 2, "the production client retries the deadline once");
    assertEquals(
      (error as GeminiTtsError).permanent,
      false,
      "a deadline is transient, so the worker may retry the episode",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("the per-turn deadline is owned by the per-call option, never by the client constructor (audio-feed-1qvdl)", async () => {
  // THE TRAP (audio-feed-1qvdl, the icl4 proof ad9c10a8): runSynthesisBatch spreads a per-call
  // `timeoutMs` into EVERY synthesizeNarration call (the ttsOptions spread in
  // src/worker/synthesis.ts), and the client prefers per-call options over its constructor value
  // (src/tts/gemini.ts sendRequest: `options.timeoutMs ?? this.timeoutMs`). A hand-configured
  // client instance's constructor timeoutMs therefore NEVER arms through the batch — the proof
  // kept passing while proving nothing. These rows pin the precedence chain the batch computes,
  // observed at the client boundary through the injected-client seam.
  const seen: Array<number | undefined> = [];
  const synthesizeWith = (
    config: AppConfig,
    deps: { client: GeminiTtsClient; perTurnTimeoutMs?: number },
  ) =>
    createGeminiSynthesizer(
      { config, stores: memoryStores() } as unknown as AppContext,
      { scriptGenerator: null, ...deps },
    );
  const call = () => ({
    article: makeArticle(),
    source: null,
    episode: makeEpisode(),
    mode: "direct" as const,
  });

  // 1. deps.perTurnTimeoutMs wins over BOTH the client constructor (5s, never armed) and config.
  const configured = { port: 0, geminiApiKey: "test-key", ttsTimeoutMs: 150 } as AppConfig;
  await synthesizeWith(configured, { client: recordingClient(5_000, seen), perTurnTimeoutMs: 50 })(
    call(),
  );
  assertEquals(seen.at(-1), 50, "the per-call deps.perTurnTimeoutMs must win");

  // 2. No deps value: the configured deadline is passed per-call, still shadowing the constructor.
  await synthesizeWith(configured, { client: recordingClient(5_000, seen) })(call());
  assertEquals(seen.at(-1), 150, "config.ttsTimeoutMs must be the per-call fallback");

  // 3. Neither is configured: the 120s default. The batch NEVER leaves per-call timeoutMs unset,
  // which is precisely why a client constructor timeoutMs cannot ever arm through this path.
  const unconfigured = { port: 0, geminiApiKey: "test-key" } as AppConfig;
  await synthesizeWith(unconfigured, { client: recordingClient(5_000, seen) })(call());
  assertEquals(seen.at(-1), DEFAULT_TIMEOUT_MS, "the batch always passes a per-call deadline");
});

Deno.test("the client's own precedence: a per-call timeoutMs beats the constructor value, which applies when no per-call value is given (audio-feed-1qvdl)", async () => {
  // src/tts/gemini.ts sendRequest: `options.timeoutMs ?? this.timeoutMs`. The icl4 proof built its
  // client with `timeoutMs: 200` expecting that to arm; the moment callers pass per-call values it
  // cannot. If this precedence ever inverts, the first row's hang burns the 5s constructor
  // deadline and the message names 5000ms instead of 50ms.
  let message = "";
  try {
    await client(hangs(), { timeoutMs: 5_000, retryOn: "none" })
      .sendRequest(request, { timeoutMs: 50 });
  } catch (error) {
    message = String((error as Error).message);
  }
  if (!/timed out after 50ms/.test(message)) {
    throw new Error(`a per-call timeoutMs must win over the constructor value: ${message}`);
  }

  // With no per-call value the constructor/config deadline still applies — the constructor is a
  // fallback, not a dead option.
  message = "";
  try {
    await client(hangs(), { timeoutMs: 150, retryOn: "none" }).sendRequest(request);
  } catch (error) {
    message = String((error as Error).message);
  }
  if (!/timed out after 150ms/.test(message)) {
    throw new Error(
      `the constructor timeoutMs must apply when no per-call value is given: ${message}`,
    );
  }
});

Deno.test("the wrapper propagates the verdict: status-less for our own abort, permanent for a provider rejection or a truncation (audio-feed-9yu8)", async () => {
  // Our own deadline: no status at all, so the worker's maxAttempts can apply.
  const timedOut = await assertRejects(() =>
    client(hangs(), { timeoutMs: 40, retryOn: "none" }).synthesizeNarration({
      title: "An Article",
      body: "hello",
    })
  );
  assertEquals((timedOut as GeminiTtsError).status, undefined, "no invented 400");
  assertEquals((timedOut as GeminiTtsError).permanent, false);
  assertStringIncludes((timedOut as Error).message, "timed out after 40ms");

  // A provider verdict: the real status survives, and the failure stays terminal.
  const rejected = await assertRejects(() =>
    client(() => Promise.resolve(errorResponse(500)), { retryOn: "none" }).synthesizeNarration({
      title: "An Article",
      body: "hello",
    })
  );
  assertEquals((rejected as GeminiTtsError).status, 500);
  assertEquals((rejected as GeminiTtsError).permanent, true);
  assertStringIncludes((rejected as Error).message, "refusing whole-episode retry");

  // A truncation: terminal by CLASS, with no status to carry the verdict. A status-only
  // propagation would have made this retryable and thrice-billed the segment.
  const truncated = await assertRejects(() =>
    client(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [{
                finishReason: "RECITATION",
                content: { parts: [{ inlineData: { mimeType: "audio/wav", data: PAYLOAD } }] },
              }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    ).synthesizeNarration({ title: "An Article", body: "hello" })
  );
  assertEquals((truncated as GeminiTtsError).permanent, true);
  assertEquals((truncated as GeminiTtsError).status, undefined);
  assertStringIncludes((truncated as Error).message, "refusing whole-episode retry");
});
