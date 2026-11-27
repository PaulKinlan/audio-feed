/**
 * P0 Production Reliability Fixes:
 * - wrapTurnFailure never marks 429/500/502/503/504 as permanent
 * - ttsPcmBytes allows valid RIFF trailing chunks/padding, rejects truncated PCM,
 *   and treats 0-byte/incomplete fresh Gemini PCM as retryable (non-permanent)
 * - Empty candidate captures finishReason/blockReason/safetyRatings/promptFeedback
 *   and adaptively splits segments
 * - Error masking & same-tick retry storms prevented (real upstream error preserved)
 * - Deepdive script-stage timeout persists static fallback scriptTurns cleanly
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import {
  buildSingleVoiceRequest,
  decodeAudioResponse,
  GeminiTtsClient,
  GeminiTtsEmptyCandidateError,
  GeminiTtsError,
  MAX_TTS_INPUT_BYTES,
  pcmToWav,
  ttsPcmBytes,
  uint8ArrayToBase64,
} from "../src/tts/gemini.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { SynthesisYieldError, type InvocationClock } from "../src/synthesis/limits.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

function controlledInvocationClock() {
  let nowMs = 1_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const clock: InvocationClock = {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const entry = { at: nowMs + Math.max(0, ms), fn, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return {
    clock,
    async advance(ms: number) {
      nowMs += ms;
      for (const t of timers.slice()) {
        if (!t.cancelled && t.at <= nowMs) {
          t.cancelled = true;
          t.fn();
        }
      }
      await Promise.resolve();
    },
  };
}

function wavWithTrailingChunk(pcmBytes: Uint8Array, fourCC: string, payload: Uint8Array): Uint8Array {
  const base = pcmToWav(pcmBytes);
  const pad = payload.byteLength & 1;
  const out = new Uint8Array(base.byteLength + 8 + payload.byteLength + pad);
  out.set(base, 0);
  const view = new DataView(out.buffer);
  // Update RIFF chunk size
  view.setUint32(4, out.byteLength - 8, true);
  const off = base.byteLength;
  for (let i = 0; i < 4; i++) out[off + i] = fourCC.charCodeAt(i);
  view.setUint32(off + 4, payload.byteLength, true);
  out.set(payload, off + 8);
  return out;
}

function makeSuccessResponse(bytes: Uint8Array = pcmToWav(new Uint8Array(960))): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{
            inlineData: { mimeType: "audio/wav", data: uint8ArrayToBase64(bytes) },
          }],
        },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

Deno.test("P0.1: wrapTurnFailure keeps 408/429/500/502/503/504 transient and 400/401/403/404/422 permanent", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const client = new GeminiTtsClient({
      apiKey: "test-key",
      retryOn: "none",
      fetchFn: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: `err ${status}` } }), { status }),
        ),
    });
    const err = await assertRejects(() =>
      client.synthesizeNarration({ title: "T", body: "Hello world." })
    );
    assert(err instanceof GeminiTtsError);
    assertEquals(err.status, status);
    assertEquals(err.permanent, false, `HTTP ${status} must not be permanent`);
  }

  for (const status of [400, 401, 403, 404, 422]) {
    const client = new GeminiTtsClient({
      apiKey: "test-key",
      retryOn: "none",
      fetchFn: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: `err ${status}` } }), { status }),
        ),
    });
    const err = await assertRejects(() =>
      client.synthesizeNarration({ title: "T", body: "Hello world." })
    );
    assert(err instanceof GeminiTtsError);
    assertEquals(err.status, status);
    assertEquals(err.permanent, true, `HTTP ${status} must be permanent`);
  }
});

Deno.test("P0.2: ttsPcmBytes allows valid RIFF trailing chunks, rejects truncated PCM, and makes 0-byte fresh PCM retryable", async () => {
  const pcm = new Uint8Array(480);
  const wavWithList = wavWithTrailingChunk(pcm, "LIST", new TextEncoder().encode("INFOtest"));
  const decodedWithTrailing: DecodedAudioResult = {
    rawBytes: wavWithList,
    mimeType: "audio/wav",
    format: "wav",
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    durationSeconds: 0.01,
    truncated: false,
    toWav: () => wavWithList,
  };
  assertEquals(ttsPcmBytes(decodedWithTrailing, "fresh"), 480);
  assertEquals(ttsPcmBytes(decodedWithTrailing, "stored"), 480);

  // Truncated PCM (declared dataLength > remaining bytes) must be rejected
  const fullWav = pcmToWav(new Uint8Array(480));
  const truncatedWav = fullWav.subarray(0, 100);
  const decodedTruncated: DecodedAudioResult = {
    rawBytes: truncatedWav,
    mimeType: "audio/wav",
    format: "wav",
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    durationSeconds: 0,
    truncated: false,
    toWav: () => truncatedWav,
  };
  let freshTruncErr: unknown;
  try {
    ttsPcmBytes(decodedTruncated, "fresh");
  } catch (err) {
    freshTruncErr = err;
  }
  assert(freshTruncErr instanceof GeminiTtsError);
  assertEquals(freshTruncErr.permanent, false);
  assertEquals(freshTruncErr.status, undefined);

  // Fresh 0-byte WAV from Gemini must be transient/retryable (not permanent 400)
  const emptyWav = pcmToWav(new Uint8Array(0));
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    retryOn: "none",
    fetchFn: () => Promise.resolve(makeSuccessResponse(emptyWav)),
  });
  const emptyErr = await assertRejects(() =>
    client.synthesizeNarration({ title: "T", body: "Hello world." })
  );
  assert(emptyErr instanceof GeminiTtsError);
  assertEquals(emptyErr.permanent, false, "0-byte fresh Gemini WAV must be retryable");
  assertEquals(emptyErr.status, undefined, "0-byte fresh Gemini WAV must not invent HTTP 400");
});

Deno.test("P0.3: empty candidate logs diagnostics (finishReason, blockReason, safetyRatings, promptFeedback) and adaptively splits", async () => {
  // Diagnostics captured in decodeAudioResponse
  let diagErr: unknown;
  try {
    decodeAudioResponse({
      promptFeedback: { blockReason: "OTHER" },
      candidates: [{
        finishReason: "OTHER",
        safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "NEGLIGIBLE" }],
        content: { parts: [] },
      }],
    });
  } catch (err) {
    diagErr = err;
  }
  assert(diagErr instanceof GeminiTtsEmptyCandidateError);
  assertEquals(diagErr.permanent, false);
  assertStringIncludes(diagErr.message, "finishReason=OTHER");
  assertStringIncludes(diagErr.message, "blockReason=OTHER");
  assertStringIncludes(diagErr.message, "safetyRatings=");
  assertStringIncludes(diagErr.message, "promptFeedback=");

  // Adaptive split: a 600-byte narration fails with empty candidate on first call,
  // splits into two smaller sub-segments, and succeeds!
  const seenTexts: string[] = [];
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    retryOn: "none",
    fetchFn: (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
      };
      const text = parsed.contents?.[0]?.parts?.[0]?.text ?? "";
      seenTexts.push(text);
      if (seenTexts.length === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [{ finishReason: "OTHER", content: { parts: [] } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(makeSuccessResponse());
    },
  });

  const body = "Adaptive splitting keeps long sentences moving reliably. ".repeat(12);
  const result = await client.synthesizeNarration({ title: "Split Test", body, includeIntro: false });
  assert(seenTexts.length >= 3, `expected empty-candidate retry via split halves, got ${seenTexts.length}`);
  assert(seenTexts[1]!.length < seenTexts[0]!.length, "split sub-segment must be smaller than failed segment");
  assert(result.rawBytes.byteLength > 0);
});

Deno.test("P0.4: MAX_TTS_INPUT_BYTES is 2_000 bytes", () => {
  assertEquals(MAX_TTS_INPUT_BYTES, 2_000);
});

Deno.test("P0.5: slow transient connection drop yields cleanly without same-tick retry storm and never masks real error on exhaustion", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "a1", userId: "u1", sourceId: "inbox", content: "Short body." }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep1",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "direct",
    }),
  );
  const ctx = {
    config: { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "secret" },
    stores,
  };
  const time = controlledInvocationClock();
  let calls = 0;
  const droppingSynthesizer = async () => {
    calls++;
    await time.advance(31_000);
    throw new Error("error reading a body from connection");
  };

  // Tick 1: should make ONLY 1 call (no same-tick retry storm) and yield cleanly!
  const tick1 = await runSynthesisBatch(ctx, droppingSynthesizer, {
    owner: "w1",
    maxAttempts: 3,
    maxClaims: 3,
    maxInvocationDurationMs: 90_000,
    clock: time.clock,
    retryBaseDelayMs: 1,
  });
  assertEquals(calls, 1, "must NOT burn back-to-back calls inside one tick after a 31s drop");
  assertEquals(tick1.yielded.length, 1);
  assertEquals(tick1.failed.length, 0);

  // Tick 2: yields cleanly again (1 call)
  const tick2 = await runSynthesisBatch(ctx, droppingSynthesizer, {
    owner: "w2",
    maxAttempts: 3,
    maxClaims: 3,
    maxInvocationDurationMs: 90_000,
    clock: time.clock,
    retryBaseDelayMs: 1,
  });
  assertEquals(calls, 2);
  assertEquals(tick2.yielded.length, 1);

  // Tick 3: exhausts claims and records the REAL connection error, NOT SynthesisYieldError!
  const tick3 = await runSynthesisBatch(ctx, droppingSynthesizer, {
    owner: "w3",
    maxAttempts: 3,
    maxClaims: 3,
    maxInvocationDurationMs: 90_000,
    clock: time.clock,
    retryBaseDelayMs: 1,
  });
  assertEquals(calls, 3);
  assertEquals(tick3.failed.length, 1);
  const ep = await stores.metadata.getEpisode("u1", "ep1");
  assertEquals(ep?.status, "failed");
  assertStringIncludes(ep?.error ?? "", "error reading a body from connection");
  assert(
    !(ep?.error ?? "").includes("Synthesis yielded before paid turn"),
    `real error must never be masked by SynthesisYieldError: ${ep?.error}`,
  );
});

Deno.test("P0.5: deepdive script timeout persists static fallback scriptTurns and yields with durable progress", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));
  await stores.metadata.putArticle(
    makeArticle({
      id: "a1",
      userId: "u1",
      sourceId: "inbox",
      title: "Deep Dive Article",
      content: "Paragraph one with substantive points.\n\nParagraph two with additional analysis.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-dd",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "deepdive",
    }),
  );
  const ctx = {
    config: { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "secret" },
    stores,
  };
  const time = controlledInvocationClock();
  let scriptCalls = 0;
  let ttsCalls = 0;
  const mockClient = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: () => {
      ttsCalls++;
      return Promise.resolve(makeSuccessResponse());
    },
  });
  const synth = createGeminiSynthesizer(ctx, {
    client: mockClient,
    scriptGenerator: async () => {
      scriptCalls++;
      // Grounded script burns 60s and throws a timeout error -> falls back to static dialogue
      await time.advance(60_000);
      throw new Error("Grounded script request timed out after 60000ms");
    },
  });

  // Tick 1 (90s budget): script fails at 60s, remaining 30s < 50s -> persists static fallback
  // scriptTurns and yields WITH durable progress (attempts resets to 0)!
  const tick1 = await runSynthesisBatch(ctx, synth, {
    owner: "dd-w1",
    maxInvocationDurationMs: 90_000,
    clock: time.clock,
    retryBaseDelayMs: 1,
  });
  assertEquals(scriptCalls, 1);
  assertEquals(ttsCalls, 0);
  assertEquals(tick1.yielded.length, 1);
  const afterTick1 = await stores.metadata.getEpisode("u1", "ep-dd");
  assertEquals(afterTick1?.status, "pending");
  assertEquals(afterTick1?.attempts, 0, "persisting static fallback turns is durable progress");
  assert(
    (afterTick1?.scriptTurns?.length ?? 0) > 0,
    "static fallback scriptTurns must be persisted durably",
  );

  // Tick 2: skips scriptGenerator completely and completes TTS!
  const tick2 = await runSynthesisBatch(ctx, synth, {
    owner: "dd-w2",
    maxInvocationDurationMs: 90_000,
    clock: time.clock,
    retryBaseDelayMs: 1,
  });
  assertEquals(scriptCalls, 1, "tick 2 must reuse persisted fallback scriptTurns");
  assert(ttsCalls >= 1);
  assertEquals(tick2.ready.length, 1);
});

Deno.test("P0.5: SynthesisYieldError after an earlier provider error in same tick never masks provider error on exhaustion", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "a1", userId: "u1", sourceId: "inbox", content: "Body." }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-mask",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "direct",
      attempts: 2, // claim 3/3
    }),
  );
  const ctx = {
    config: { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "secret" },
    stores,
  };
  let attempt = 0;
  const res = await runSynthesisBatch(
    ctx,
    async (req) => {
      attempt++;
      req.resume?.noteTurnInitiated?.();
      if (attempt === 1) {
        throw new Error("upstream TLS reset");
      }
      throw new SynthesisYieldError(0, 1, "Synthesis yielded before paid turn 1");
    },
    { owner: "mask-w1", maxAttempts: 3, maxClaims: 3, retryBaseDelayMs: 1 },
  );
  assertEquals(res.failed.length, 1);
  assertStringIncludes(res.failed[0]!.error, "upstream TLS reset");
});

Deno.test("Cloudflare Workers compat: GeminiTtsClient never invokes fetch with `this === client`", async () => {
  // Mirrors workerd's WebIDL receiver check on globalThis.fetch.
  const strictFetch = function (this: unknown) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    return Promise.resolve(makeSuccessResponse());
  } as unknown as typeof fetch;

  const clientWithInjected = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: strictFetch,
  });
  const res1 = await clientWithInjected.sendRequest(
    buildSingleVoiceRequest("Hello world.", "Charon"),
    { maxRetries: 0 },
  );
  assert(res1.rawBytes.byteLength > 44);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = strictFetch;
  try {
    const clientWithDefault = new GeminiTtsClient({ apiKey: "test-key" });
    const res2 = await clientWithDefault.sendRequest(
      buildSingleVoiceRequest("Hello world.", "Charon"),
      { maxRetries: 0 },
    );
    assert(res2.rawBytes.byteLength > 44);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
