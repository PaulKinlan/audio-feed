/**
 * Bounded live Gemini 3.8 Flash TTS verification for audio-feed-u60a.
 * Run once with: timeout -k 30 300 deno run -A scripts/verify_live_tts.ts
 * The proxy injects authentication; this script reimplements HTTP transport, not the production client.
 */
import {
  buildSingleVoiceRequest,
  decodeAudioResponse,
  formatNarrationPrompt,
  MAX_TTS_INPUT_BYTES,
  parseWavHeader,
} from "../src/tts/gemini.ts";
import { splitTextUnderByteBudget } from "../src/synthesis/limits.ts";

const base = "https://gemini.int.exe.xyz/v1beta";
const model = "gemini-3.8-flash-tts";
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function provider(path: string, body?: unknown, timeoutMs = 20_000) {
  const response = await fetch(`${base}/models/${model}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, json: await response.json() };
}

const countRequest = (text: string) => ({ contents: [{ parts: [{ text }] }] });
async function countTokens(text: string): Promise<number> {
  const { status, json } = await provider(":countTokens", countRequest(text));
  requireCondition(status === 200 && typeof json.totalTokens === "number", "countTokens failed");
  return json.totalTokens;
}

function negativeRequest(text: string) {
  return {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
    },
  };
}

async function negativeControl(description: string, text: string, expectedStatus: number) {
  const tokens = await countTokens(text);
  requireCondition(tokens > 8192, `${description}: input is not above the published cap`);
  const { status, json } = await provider(":generateContent", negativeRequest(text), 120_000);
  requireCondition(
    status === expectedStatus,
    `${description}: expected ${expectedStatus}, got ${status}`,
  );
  if (status === 400) {
    requireCondition(
      json.error?.status === "INVALID_ARGUMENT" &&
        json.error?.message ===
          "The input token count exceeds the maximum number of tokens allowed (8192).",
      `${description}: unexpected rejection`,
    );
    return { description, tokens, status, error: json.error };
  }
  const candidate = json.candidates?.[0];
  requireCondition(
    candidate?.finishReason === "OTHER" &&
      candidate.finishMessage?.includes("copyrighted works") &&
      !candidate.content?.parts?.length,
    `${description}: expected copyright-filtered, audio-less OTHER`,
  );
  let failClosed = false;
  try {
    decodeAudioResponse(json);
  } catch {
    failClosed = true;
  }
  requireCondition(failClosed, `${description}: production decoder did not fail closed`);
  return {
    description,
    tokens,
    status,
    finishReason: candidate.finishReason,
    finishMessage: candidate.finishMessage,
    audioReturned: false,
    decoderFailedClosed: failClosed,
    usageMetadata: json.usageMetadata,
  };
}

const { status: metadataStatus, json: metadata } = await provider("");
requireCondition(
  metadataStatus === 200 && metadata.inputTokenLimit === 8192 &&
    metadata.outputTokenLimit === 16384,
  "Unexpected model metadata",
);

const article = await Deno.readTextFile(
  new URL("../docs/evidence/audio-feed-gueb/article.txt", import.meta.url),
);
const prompt = formatNarrationPrompt({ title: "History of the Internet", body: article });
const segments = splitTextUnderByteBudget(prompt, MAX_TTS_INPUT_BYTES);
requireCondition(
  segments.length === 8,
  `Expected eight production segments; got ${segments.length}`,
);
const segmentCounts = [];
for (const [index, segment] of segments.entries()) {
  requireCondition(
    bytes(segment) <= MAX_TTS_INPUT_BYTES,
    `Segment ${index + 1} exceeds byte budget`,
  );
  segmentCounts.push({
    index: index + 1,
    bytes: bytes(segment),
    tokens: await countTokens(segment),
  });
}

// Two distinct unsegmented article controls: a reproducible expanded preamble and raw prose.
// The exact preamble count is measured rather than inferred from an earlier ad-hoc prompt.
const preamble = "Please narrate the following article clearly and naturally. ".repeat(70);
const negativeControls = [
  await negativeControl(
    "Synthetic repeated sentence",
    "The quick brown fox jumps over the lazy dog. ".repeat(1500),
    400,
  ),
  await negativeControl("Article with expanded preamble", `${preamble}\n\n${article}`, 400),
  await negativeControl("Raw unsegmented article", article, 200),
];

// Real prose, not the earlier 78-character smoke-test text.
const sampleText = article.split("\n\n").slice(0, 2).join("\n\n");
const request = buildSingleVoiceRequest(sampleText, "Charon", 0.7);
const { status, json } = await provider(":generateContent", request, 120_000);
requireCondition(
  status === 200 && json.candidates?.[0]?.finishReason === "STOP",
  "Positive synthesis failed",
);
const inline = json.candidates[0].content?.parts?.find((part: { inlineData?: unknown }) =>
  part.inlineData
)
  ?.inlineData;
requireCondition(
  inline?.mimeType === "audio/wav" && typeof inline.data === "string",
  "No WAV audio",
);
const audioBytes = Uint8Array.fromBase64(inline.data);
const wav = parseWavHeader(audioBytes);
requireCondition(
  String.fromCharCode(...audioBytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...audioBytes.subarray(8, 12)) === "WAVE" &&
    wav.audioFormat === 1 && wav.sampleRate === 24000 && wav.channels === 1 &&
    wav.bitsPerSample === 16 && wav.dataLength > 0 &&
    Math.abs(
        wav.durationSeconds -
          wav.dataLength / (wav.sampleRate * wav.channels * wav.bitsPerSample / 8),
      ) < 0.001,
  "Invalid PCM RIFF/WAVE audio",
);
const decoded = decodeAudioResponse(json);
requireCondition(decoded.format === "wav" && !decoded.truncated, "Production audio decoder failed");

console.log(JSON.stringify(
  {
    model: {
      name: metadata.name,
      version: metadata.version,
      inputTokenLimit: metadata.inputTokenLimit,
      outputTokenLimit: metadata.outputTokenLimit,
      supportedGenerationMethods: metadata.supportedGenerationMethods,
    },
    article: {
      source: "docs/evidence/audio-feed-gueb/article.txt",
      characters: article.length,
      bytes: bytes(article),
      promptBytes: bytes(prompt),
      promptTokens: await countTokens(prompt),
    },
    negativeControls,
    productionSegmentation: { budgetBytes: MAX_TTS_INPUT_BYTES, segments: segmentCounts },
    positiveAudioSynthesis: {
      source: "First two paragraphs of article.txt, joined by two newlines",
      sampleCharacters: sampleText.length,
      sampleBytes: bytes(sampleText),
      requestMaxOutputTokens: request.generationConfig.maxOutputTokens,
      httpStatus: status,
      modelVersion: json.modelVersion,
      usageMetadata: json.usageMetadata,
      finishReason: json.candidates[0].finishReason,
      mimeType: inline.mimeType,
      base64Length: inline.data.length,
      rawAudioBytes: audioBytes.length,
      audioHeaderHex: Array.from(audioBytes.subarray(0, 16), (b) => b.toString(16).padStart(2, "0"))
        .join(" "),
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      bitsPerSample: wav.bitsPerSample,
      pcmDataBytes: wav.dataLength,
      durationSeconds: wav.durationSeconds,
    },
  },
  null,
  2,
));
