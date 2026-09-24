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
  const { fn } = scripted([errorResponse(503, { "retry-after": "0" }), okResponse()]);
  const started = Date.now();
  await client(fn, { retryBaseDelayMs: 60_000 }).sendRequest(request);
  // A 0-second Retry-After must beat the 60s base delay; jitter cannot mask it.
  if (Date.now() - started > 5_000) throw new Error("Retry-After was ignored");
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
  const hang =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

  const started = Date.now();
  let message = "";
  try {
    await client(hang, { timeoutMs: 150, retryOn: "none" }).sendRequest(request);
  } catch (error) {
    message = String((error as Error).message);
  }
  const elapsed = Date.now() - started;
  if (!/timed out after 150ms/.test(message)) throw new Error(`unexpected error: ${message}`);
  if (elapsed > 5_000) throw new Error(`timeout took ${elapsed}ms`);
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
