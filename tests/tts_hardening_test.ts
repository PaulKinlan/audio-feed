/**
 * Hardening tests for the TTS client (audio-feed-e6l).
 *
 * Everything here is deterministic: the API is replaced by a scripted fetchFn, so retry counts,
 * backoff behaviour and truncation policy are asserted without network access or spend.
 */
import {
  decodeAudioResponse,
  detectAudioFormat,
  GeminiTtsClient,
  GeminiTtsError,
  GeminiTtsTruncatedError,
} from "../src/tts/gemini.ts";

/** Minimal valid base64 payload (4 raw bytes) so decoding succeeds. */
const PAYLOAD = btoa("\x01\x02\x03\x04");

const audioBody = (finishReason = "STOP", mimeType = "audio/wav") =>
  JSON.stringify({
    candidates: [{
      finishReason,
      content: { parts: [{ inlineData: { mimeType, data: PAYLOAD } }] },
    }],
  });

const okResponse = (finishReason = "STOP") =>
  new Response(audioBody(finishReason), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const errorResponse = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: `boom ${status}` } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Scripted fetch: returns each queued response, and counts attempts. */
function scripted(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("scripted fetch ran out of responses");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }) as typeof fetch;
  return { fn, calls };
}

const client = (fetchFn: typeof fetch, config: Record<string, unknown> = {}) =>
  new GeminiTtsClient({ apiKey: "test-key", fetchFn, retryBaseDelayMs: 1, ...config });

const request = {
  contents: [{ parts: [{ text: "hi" }] }],
  generationConfig: {
    responseModalities: ["AUDIO"] as ["AUDIO"],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
  },
};

Deno.test("transient 429 is retried and the retry's audio is returned", async () => {
  const { fn, calls } = scripted([errorResponse(429), okResponse()]);
  const result = await client(fn).sendRequest(request);

  if (calls.length !== 2) throw new Error(`expected 2 attempts, got ${calls.length}`);
  if (result.truncated) throw new Error("complete audio must not be flagged truncated");
});

Deno.test("retries honour Retry-After instead of the default backoff", async () => {
  const { fn, calls } = scripted([errorResponse(503, { "retry-after": "0" }), okResponse()]);
  const started = Date.now();
  const result = await client(fn, { retryBaseDelayMs: 60_000 }).sendRequest(request);
  if (calls.length !== 2) throw new Error(`expected 2 attempts, got ${calls.length}`);
  if (!result.rawBytes || result.rawBytes.length === 0) {
    throw new Error("expected audio from retry");
  }
  // A 0-second Retry-After must beat the 60s base delay; jitter cannot mask it.
  // docs/speed.md census row 6: raised ceiling from 5s to 10s to absorb scheduler contention
  // on loaded hosts, while staying safely below the 15,000ms minimum backoff (60s base capped
  // at 30s with min 0.5 jitter = 15,000ms).
  const elapsed = Date.now() - started;
  if (elapsed > 10_000) throw new Error(`Retry-After was ignored (elapsed ${elapsed}ms > 10000ms)`);
});

Deno.test("a plain 500 is NOT retried by default (a retry could double-charge)", async () => {
  const { fn, calls } = scripted([errorResponse(500), okResponse()]);
  let threw = false;
  try {
    await client(fn).sendRequest(request);
  } catch (error) {
    threw = error instanceof GeminiTtsError && (error as GeminiTtsError).status === 500;
  }
  if (!threw) throw new Error("500 should throw");
  if (calls.length !== 1) {
    throw new Error(`500 must not be retried by default, got ${calls.length} attempts`);
  }
});

Deno.test("retryOn: 'all' retries 5xx, and retries are bounded", async () => {
  const once = scripted([errorResponse(500), okResponse()]);
  await client(once.fn, { retryOn: "all" }).sendRequest(request);
  if (once.calls.length !== 2) throw new Error(`expected 2 attempts, got ${once.calls.length}`);

  const exhausted = scripted([errorResponse(500), errorResponse(500), errorResponse(500)]);
  let attempts = 0;
  try {
    await client(exhausted.fn, { retryOn: "all", maxRetries: 2 }).sendRequest(request);
  } catch (error) {
    if (!(error instanceof GeminiTtsError)) throw error;
    attempts = exhausted.calls.length;
  }
  if (attempts !== 3) throw new Error(`maxRetries: 2 means 3 attempts, got ${attempts}`);
});

Deno.test("retryOn: 'none' disables retries entirely", async () => {
  const { fn, calls } = scripted([errorResponse(429), okResponse()]);
  let threw = false;
  try {
    await client(fn, { retryOn: "none" }).sendRequest(request);
  } catch {
    threw = true;
  }
  if (!threw || calls.length !== 1) {
    throw new Error(`expected one attempt then throw, got ${calls.length}`);
  }
});

Deno.test("a hung request is killed by the per-attempt timeout", async () => {
  // Never resolves unless aborted — the whole reason a default deadline exists.
  let aborted = false;
  const hang =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal!.reason);
        });
      })) as typeof fetch;

  const started = Date.now();
  let message = "";
  try {
    await client(hang, { timeoutMs: 150, retryOn: "none" }).sendRequest(request);
  } catch (error) {
    message = String((error as Error).message);
  }
  const elapsed = Date.now() - started;
  if (!aborted) throw new Error("fetch signal was not aborted by per-attempt timeout");
  if (!/timed out after 150ms/.test(message)) throw new Error(`unexpected error: ${message}`);
  // docs/speed.md census row 7: replaced 5s real-clock ceiling with order assertion (aborted signal)
  // and lower-bound-only floor (elapsed >= 100ms) against the 150ms timeout. Host scheduler delay only
  // increases elapsed time, making a lower-bound assertion load-independent.
  if (elapsed < 100) throw new Error(`timeout fired impossibly fast: ${elapsed}ms < 100ms`);
});

Deno.test("a per-attempt timeout is named with its deadline even when a caller signal exists (audio-feed-bp6r)", async () => {
  // The worker always passes a lease signal, and the old `!options.signal` guard then let the
  // raw TimeoutError through — which is how the 2026-10-09 incident surfaced as a bare
  // "The operation was aborted due to timeout" with no deadline attached.
  const hang =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

  const caller = new AbortController(); // never fired: the per-attempt deadline must win the name
  let message = "";
  try {
    await client(hang, { timeoutMs: 150, retryOn: "none" })
      .sendRequest(request, { signal: caller.signal });
  } catch (error) {
    message = String((error as Error).message);
  }
  if (!/timed out after 150ms/.test(message)) throw new Error(`unexpected error: ${message}`);
});

Deno.test("a timeout during the response body read is named with its deadline (audio-feed-bp6r)", async () => {
  // The incident path itself: the provider returned 200 headers just inside the deadline
  // and the abort fired while the multi-MB base64 body was still streaming — that throw
  // never enters the fetch-await catch. Simulate a real streaming body: it errors with the
  // abort reason, exactly as a fetch response body does when the request signal fires.
  const streaming = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
        // never enqueues: the body read hangs until the signal fires
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;

  const caller = new AbortController(); // live but never fired, like the worker's lease signal
  let message = "";
  try {
    await client(streaming, { timeoutMs: 150, retryOn: "none" })
      .sendRequest(request, { signal: caller.signal });
  } catch (error) {
    message = String((error as Error).message);
  }
  if (!/timed out after 150ms while reading the response body/.test(message)) {
    throw new Error(`unexpected error: ${message}`);
  }
});

Deno.test("caller cancellation during the body read surfaces as-is (audio-feed-bp6r)", async () => {
  // The body-read catch must keep the same caller-first precedence as the fetch stage:
  // a caller abort mid-stream is the lease expiring, not the per-attempt deadline.
  const caller = new AbortController();
  caller.abort(new Error("caller gave up"));
  const streaming = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;

  let message = "";
  try {
    await client(streaming, { timeoutMs: 30_000, retryOn: "none" })
      .sendRequest(request, { signal: caller.signal });
  } catch (error) {
    message = String((error as Error).message);
  }
  if (!/caller gave up/.test(message)) {
    throw new Error(`caller abort must surface raw, got: ${message}`);
  }
});

Deno.test("a deadline during a non-2xx error-body read is named with its deadline (audio-feed-icl4)", async () => {
  // The same path the incident took, one branch over: a proxy/gateway 5xx whose error body streams
  // slowly. The old bare `catch {}` swallowed the abort, so the persisted cause read like an
  // ordinary provider rejection with an empty body and our own bound was invisible.
  const streaming = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "text/html" },
      }),
    );
  }) as typeof fetch;

  const caller = new AbortController(); // live but never fired, like the worker's lease signal
  let error: unknown;
  try {
    // Through synthesizeNarration, because that is where `permanent` is decided: the wrapper reads
    // the inner provider verdict and must keep reading it the same way.
    await client(streaming, { timeoutMs: 150, retryOn: "none" })
      .synthesizeNarration({ title: "Title", body: "hello" }, { signal: caller.signal });
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof GeminiTtsError)) {
    throw new Error(`expected a GeminiTtsError, got ${error}`);
  }
  // Named with the deadline that fired…
  if (!/timed out after 150ms while reading the error response body/.test(error.message)) {
    throw new Error(`deadline must be named on the non-2xx path, got: ${error.message}`);
  }
  // …while the classification is untouched: the PROVIDER's status survives, so the failure stays
  // permanent and describeSynthesisFailure still labels it "provider status 503".
  if (error.status !== 503) throw new Error(`provider status must survive, got ${error.status}`);
  if (error.permanent !== true) throw new Error("a provider verdict must stay permanent");
  if (!/503/.test(error.message)) {
    throw new Error(`status text must survive, got: ${error.message}`);
  }

  // The inner error keeps the non-Error provider-response shape the status label is read from.
  const inner = error.details;
  if (!(inner instanceof GeminiTtsError) || inner.status !== 503) {
    throw new Error(`the inner failure must stay a 503 provider error, got ${inner}`);
  }
  if (inner.details === undefined || inner.details instanceof Error) {
    throw new Error("inner details must stay the non-Error { statusText } stand-in");
  }
});

Deno.test("caller cancellation during a non-2xx error-body read surfaces as-is (audio-feed-icl4)", async () => {
  // A lease expiry is not a provider error, so it must not be dressed up as a 503 the way the old
  // swallow did (the ok branch already had this precedence, audio-feed-bp6r).
  const caller = new AbortController();
  caller.abort(new Error("caller gave up"));
  const streaming = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
    });
    return Promise.resolve(
      new Response(body, { status: 503, statusText: "Service Unavailable" }),
    );
  }) as typeof fetch;

  let error: unknown;
  try {
    await client(streaming, { timeoutMs: 30_000, retryOn: "none" })
      .sendRequest(request, { signal: caller.signal });
  } catch (caught) {
    error = caught;
  }

  if (error instanceof GeminiTtsError) {
    throw new Error(`a lease abort must not become a provider error, got: ${error.message}`);
  }
  if (!/caller gave up/.test(String((error as Error)?.message ?? error))) {
    throw new Error(`caller abort must surface raw, got: ${error}`);
  }
});

Deno.test("caller cancellation is never retried and surfaces as-is", async () => {
  const controller = new AbortController();
  let attempts = 0;
  // Rejects only when the caller's signal aborts, so this is a real in-flight cancellation rather
  // than a function that fails before the request starts.
  const hangUntilAborted = ((_input: RequestInfo | URL, init?: RequestInit) => {
    attempts++;
    return new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as typeof fetch;

  const pending = client(hangUntilAborted, { retryOn: "all", timeoutMs: 30_000 })
    .sendRequest(request, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("caller gave up")), 20);

  let message = "";
  try {
    await pending;
  } catch (error) {
    message = String((error as Error).message);
  }
  if (!/caller gave up/.test(message)) {
    throw new Error(`caller abort must surface, got: ${message}`);
  }
  if (attempts !== 1) throw new Error(`cancellation must not be retried, got ${attempts} attempts`);
});

Deno.test("truncated audio throws by default and is opt-in via allowTruncated", async () => {
  const { fn } = scripted([okResponse("MAX_TOKENS")]);
  let truncatedError: GeminiTtsTruncatedError | null = null;
  try {
    await client(fn).sendRequest(request);
  } catch (error) {
    truncatedError = error instanceof GeminiTtsTruncatedError ? error : null;
  }
  if (!truncatedError) throw new Error("MAX_TOKENS must throw GeminiTtsTruncatedError");
  if (truncatedError.finishReason !== "MAX_TOKENS") throw new Error(truncatedError.finishReason);
  if (!/split the input/.test(truncatedError.message)) throw new Error(truncatedError.message);

  const optIn = scripted([okResponse("MAX_TOKENS")]);
  const partial = await client(optIn.fn).sendRequest(request, { allowTruncated: true });
  if (partial.truncated !== true) throw new Error("partial audio must be flagged truncated");
  if (partial.finishReason !== "MAX_TOKENS") throw new Error(String(partial.finishReason));
});

Deno.test("decodeAudioResponse reports finishReason and truncation on the result", () => {
  const complete = decodeAudioResponse(JSON.parse(audioBody("STOP", "audio/wav")));
  if (complete.truncated || complete.finishReason !== "STOP") {
    throw new Error("complete audio misflagged");
  }

  let flagged = false;
  try {
    decodeAudioResponse(JSON.parse(audioBody("RECITATION", "audio/wav")));
  } catch (error) {
    flagged = error instanceof GeminiTtsTruncatedError;
  }
  if (!flagged) throw new Error("RECITATION must be treated as truncated");
});

Deno.test("a SAFETY block is still an error, not a truncation", () => {
  let isSafety = false;
  try {
    decodeAudioResponse(JSON.parse(audioBody("SAFETY", "audio/wav")));
  } catch (error) {
    isSafety = error instanceof GeminiTtsError && !(error instanceof GeminiTtsTruncatedError) &&
      /SAFETY/.test((error as Error).message);
  }
  if (!isSafety) throw new Error("SAFETY must stay a plain GeminiTtsError");
});

/**
 * audio-feed-zrx9: the live provider stopped returning a copyright-recitation refusal for raw
 * Wikipedia prose, so the two live negative controls that asserted that refusal were narrowed.
 * THIS test is what keeps the property the app actually depends on, and it no longer needs the
 * provider to cooperate: a recitation/copyright refusal must produce no audio and must throw,
 * under every response shape the provider has been seen to use, and even for a caller that
 * accepts truncation - a filter block must never become a published episode.
 */
Deno.test("a copyright-recitation refusal fails closed through the decoder", () => {
  const refusal = (candidate: Record<string, unknown>) =>
    JSON.stringify({ candidates: [candidate] });
  const finishMessage =
    "The generated content was filtered because it may contain material that resembles existing copyrighted works.";

  const cases: Array<[string, string]> = [
    ["no content at all", refusal({ finishReason: "OTHER", finishMessage })],
    [
      "content with empty parts",
      refusal({
        finishReason: "OTHER",
        finishMessage,
        content: { parts: [] },
      }),
    ],
    [
      "content whose only part is text",
      refusal({
        finishReason: "OTHER",
        finishMessage,
        content: { parts: [{ text: "I cannot read that aloud." }] },
      }),
    ],
  ];

  for (const [name, body] of cases) {
    for (const allowTruncated of [false, true]) {
      let thrown: Error | null = null;
      try {
        decodeAudioResponse(JSON.parse(body), 24000, { allowTruncated });
      } catch (error) {
        thrown = error as Error;
      }
      if (!thrown) {
        throw new Error(`${name}: a refusal must throw, not return audio`);
      }
      if (thrown instanceof GeminiTtsTruncatedError) {
        throw new Error(`${name}: a refusal is not truncation (allowTruncated=${allowTruncated})`);
      }
      if (!(thrown instanceof GeminiTtsError)) {
        throw new Error(`${name}: expected GeminiTtsError, got ${thrown.name}`);
      }
    }
  }
});

Deno.test("detectAudioFormat: an explicit hint beats the weak MPEG frame sync", () => {
  // Raw L16 PCM whose first sample starts 0xFF 0xE0.. — the exact case that was misread as mp3.
  const l16LooksLikeSync = new Uint8Array([0xff, 0xe0, 0x12, 0x34, 0x56, 0x78]);
  const got = detectAudioFormat(l16LooksLikeSync, "audio/L16;codec=pcm;rate=24000");
  if (got !== "pcm") throw new Error(`expected pcm, got ${got}`);
  if (detectAudioFormat(l16LooksLikeSync, "audio/pcm;rate=24000") !== "pcm") {
    throw new Error("audio/pcm hint must win");
  }
  // Container signatures stay authoritative even against a contradicting hint.
  const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  if (detectAudioFormat(riff, "audio/pcm") !== "wav") {
    throw new Error("RIFF must win over a wrong hint");
  }
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]);
  if (detectAudioFormat(id3, "audio/pcm") !== "mp3") {
    throw new Error("ID3 must win over a wrong hint");
  }
  // With no hint the sync heuristic still applies.
  if (detectAudioFormat(l16LooksLikeSync) !== "mp3") {
    throw new Error("bare sync should still detect mp3");
  }
});

Deno.test("the API key never appears in the request URL", async () => {
  const { fn, calls } = scripted([okResponse()]);
  await client(fn).sendRequest(request);
  const url = calls[0]!.url;
  if (url.includes("test-key")) throw new Error(`key leaked into url: ${url}`);
  const headers = calls[0]!.init?.headers as Record<string, string>;
  if (headers["x-goog-api-key"] !== "test-key") throw new Error("header missing");
});

/**
 * audio-feed-0cmu. This defect is about PROCESS LIFETIME, so it cannot be asserted in-process:
 * Deno's test runner exits without draining the event loop (measured — a test that leaves a live
 * 60s timer behind still passes, and `deno test` returns in ~1s), which is exactly why the old
 * `AbortSignal.any` composite went unnoticed for weeks. It only shows up in a one-shot process,
 * so this runs the real client and the real script generator in a child with the production shape
 * — a caller signal that will not fire for ten minutes, and per-attempt deadlines that do — and
 * requires the child to exit by itself. Before the fix the child stayed alive for the whole ten
 * minutes; the SIGKILL below is what a regression looks like.
 */
Deno.test("a timed-out attempt leaves nothing holding the process open (audio-feed-0cmu)", async () => {
  const clientUrl = new URL("../src/tts/gemini.ts", import.meta.url).href;
  const scriptUrl = new URL("../src/worker/script.ts", import.meta.url).href;
  const child = `
const { GeminiTtsClient } = await import(${JSON.stringify(clientUrl)});
const { createGroundedScriptGenerator } = await import(${JSON.stringify(scriptUrl)});
const hanging = (_input, init) =>
  Promise.resolve(new Response(new ReadableStream({
    start(controller) {
      const signal = init?.signal;
      if (signal?.aborted) { controller.error(signal.reason); return; }
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  }), { status: 503, statusText: "Service Unavailable" }));

// The worker's shape: a claim lease that is ten minutes away, and a deadline that fires.
const lease = AbortSignal.timeout(600_000);
const tts = new GeminiTtsClient({ apiKey: "k", fetchFn: hanging, timeoutMs: 150, retryOn: "none" });
await tts.sendRequest(${JSON.stringify(request)}, { signal: lease }).catch(() => {});
console.log("tts attempt finished");

const generator = createGroundedScriptGenerator({
  apiKey: "k",
  timeoutMs: 150,
  fetchFn: (_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }),
});
await generator({
  article: { title: "t", body: "b" },
  speakers: [{ name: "Alex", role: "expert", voice: "Charon" }, { name: "Sam", role: "curious_foil", voice: "Puck" }],
}, { signal: lease }).catch(() => {});
console.log("script attempt finished");
`;
  const job = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      child,
    ],
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // docs/speed.md rule 2: the 20s SIGKILL is a HANG GUARD, not an assertion. The property
  // under test is that the child exits BY ITSELF - both markers printed, exit code 0; a
  // regression leaves the process held open and the SIGKILL turns that into the named
  // non-zero exit below. There is deliberately NO elapsed-time ceiling (audio-feed-1xfvx):
  // the old `elapsed > 15_000` check was redundant with this guard (a real hang already
  // reds via exit code) and reddened the row when a loaded gate host merely pushed a
  // correct `deno eval` cold start past 15s.
  const giveUp = setTimeout(() => job.kill("SIGKILL"), 20_000);
  const started = Date.now();
  const { code, stdout, stderr } = await job.output();
  clearTimeout(giveUp);
  const elapsed = Date.now() - started;
  const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  if (!output.includes("tts attempt finished")) throw new Error(`tts attempt never ran: ${output}`);
  if (!output.includes("script attempt finished")) {
    throw new Error(`script attempt never ran: ${output}`);
  }
  if (code !== 0) throw new Error(`child exited ${code} after ${elapsed}ms: ${output}`);
});
