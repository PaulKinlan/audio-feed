import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@^1.0.10";
import {
  buildSingleVoiceRequest,
  DEFAULT_TTS_MODEL,
  formatNarrationPrompt,
  GeminiTtsClient,
  MAX_TTS_INPUT_BYTES,
  MAX_TTS_OUTPUT_TOKENS,
  pcmToWav,
  splitTtsText,
  uint8ArrayToBase64,
} from "../src/tts/gemini.ts";

const article = await Deno.readTextFile(
  new URL("../docs/evidence/audio-feed-gueb/article.txt", import.meta.url),
);
const input = { title: "History of the Internet", body: article };
const pcm = new Uint8Array([0, 0, 1, 0, 2, 0, 3, 0]);
const success = () =>
  new Response(
    JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{
            inlineData: { mimeType: "audio/pcm;rate=24000", data: uint8ArrayToBase64(pcm) },
          }],
        },
      }],
    }),
    { status: 200 },
  );

Deno.test("long real article: former single TTS request exceeds 8192-token budget", () => {
  const legacy = buildSingleVoiceRequest(formatNarrationPrompt(input));
  const bytes = new TextEncoder().encode(legacy.contents[0]!.parts[0]!.text).length;
  assert(bytes > 8192);
  assertEquals(DEFAULT_TTS_MODEL, "gemini-3.8-flash-tts");
  console.log(
    JSON.stringify({
      stage: "before",
      model: DEFAULT_TTS_MODEL,
      article: "History of the Internet (Wikipedia)",
      inputBytes: bytes,
      inputTokenCount: "unavailable without Gemini countTokens API",
      maxOutputTokens: "unset in original request",
      temperature: legacy.generationConfig.temperature,
      expectedApiError: "The input token count exceeds the maximum number of tokens allowed (8192)",
    }),
  );
});

Deno.test("long real article: narrated in bounded ordered segments, audio joined without losing bytes", async () => {
  const requests: Array<
    { url: string; text: string; config: { temperature: number; maxOutputTokens: number } }
  > = [];
  const client = new GeminiTtsClient({
    apiKey: "fixture-key",
    fetchFn: ((url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push({
        url: String(url).split("?")[0]!,
        text: request.contents[0].parts[0].text,
        config: request.generationConfig,
      });
      return Promise.resolve(success());
    }) as typeof fetch,
  });
  const audio = await client.synthesizeNarration(input);
  assert(requests.length > 1);
  assert(requests.every((r) => r.url.endsWith(`/models/${DEFAULT_TTS_MODEL}:generateContent`)));
  assert(requests.every((r) => new TextEncoder().encode(r.text).length <= MAX_TTS_INPUT_BYTES));
  assert(
    requests.every((r) =>
      r.config.temperature === 0.7 && r.config.maxOutputTokens === MAX_TTS_OUTPUT_TOKENS
    ),
  );
  const originalWords = formatNarrationPrompt(input).split(/\s+/u);
  assertEquals(requests.map((r) => r.text).join(" ").split(/\s+/u), originalWords);
  assertEquals(audio.rawBytes.length, requests.length * pcm.length);
  assertEquals(audio.toWav().length, 44 + requests.length * pcm.length);
  console.log(
    JSON.stringify({
      stage: "after",
      model: DEFAULT_TTS_MODEL,
      requests: requests.length,
      inputBytesPerRequest: requests.map((r) => new TextEncoder().encode(r.text).length),
      inputTokenCount: "unavailable without Gemini countTokens API",
      maxOutputTokens: MAX_TTS_OUTPUT_TOKENS,
      temperature: 0.7,
      audioBytes: audio.rawBytes.length,
    }),
  );
});

Deno.test("original single-request failure is reproducible with real article and mocked API refusal", async () => {
  let captured: unknown;
  const client = new GeminiTtsClient({
    apiKey: "fixture-key",
    maxRetries: 0,
    fetchFn: ((_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "The input token count exceeds the maximum number of tokens allowed (8192).",
            },
          }),
          { status: 400 },
        ),
      );
    }) as typeof fetch,
  });
  const legacy = buildSingleVoiceRequest(formatNarrationPrompt(input));
  delete legacy.generationConfig.maxOutputTokens;
  const error = await assertRejects(() => client.sendRequest(legacy));
  assertEquals(captured, legacy);
  assert(error instanceof Error);
  assertStringIncludes(error.message, `model=${DEFAULT_TTS_MODEL}`);
  assertStringIncludes(error.message, "inputBytes=47044");
  assertStringIncludes(error.message, "estimatedInputTokens<=");
  assertStringIncludes(error.message, "maxOutputTokens=unset");
});

Deno.test("multispeaker and Unicode paragraphs stay bounded; malformed or mismatched segments fail closed", async () => {
  assert(
    splitTtsText("🚀".repeat(4000)).every((s) =>
      new TextEncoder().encode(s).length <= MAX_TTS_INPUT_BYTES
    ),
  );
  const calls: Array<{ parts: Array<{ text: string; speech_metadata: { speaker: string } }> }> = [];
  const client = new GeminiTtsClient({
    apiKey: "fixture-key",
    fetchFn: ((_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)).contents[0]);
      return Promise.resolve(success());
    }) as typeof fetch,
  });
  await client.synthesizeDialogue({
    turns: [{ speaker: "Alex", text: article }, { speaker: "Sam", text: "Indeed." }],
    speakers: [{ name: "Alex", role: "expert", voice: "Fenrir" }, {
      name: "Sam",
      role: "host",
      voice: "Puck",
    }],
  });
  assert(calls.length > 1);
  assert(
    calls.every((c) =>
      c.parts.every((p) =>
        p.speech_metadata.speaker === "Alex" || p.speech_metadata.speaker === "Sam"
      )
    ),
  );
  assert(
    calls.every((c) =>
      new TextEncoder().encode(c.parts.map((p) => p.text).join("")).length <= MAX_TTS_INPUT_BYTES
    ),
  );
  let n = 0;
  const incompatible = new GeminiTtsClient({
    apiKey: "fixture-key",
    fetchFn: (() => {
      n++;
      const data = pcmToWav(pcm, {
        sampleRate: n === 1 ? 24000 : 16000,
        numChannels: 1,
        bitsPerSample: 16,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{
              finishReason: "STOP",
              content: {
                parts: [{ inlineData: { mimeType: "audio/wav", data: uint8ArrayToBase64(data) } }],
              },
            }],
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch,
  });
  const err = await assertRejects(() => incompatible.synthesizeNarration(input));
  assert(err instanceof Error);
  assertStringIncludes(err.message, "incompatible");
});
