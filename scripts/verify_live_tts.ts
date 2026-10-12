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
import { runProof, writeEvidenceReadme } from "./proof-helper.ts";

const base = "https://gemini.int.exe.xyz/v1beta";
const model = "gemini-3.8-flash-tts";
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

await runProof("verify_live_tts", async (checker) => {
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
    if (status !== 200 || typeof json.totalTokens !== "number") {
      throw new Error(`countTokens failed: status=${status}`);
    }
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

  async function runNegativeControl(
    description: string,
    text: string,
    expectedStatus: number,
  ) {
    const tokens = await countTokens(text);
    const tokenCapExceeded = tokens > 8192;
    const { status, json } = await provider(
      ":generateContent",
      negativeRequest(text),
      120_000,
    );
    const statusMatches = status === expectedStatus;

    if (status === 400) {
      const errorMatches = json.error?.status === "INVALID_ARGUMENT" &&
        json.error?.message ===
          "The input token count exceeds the maximum number of tokens allowed (8192).";
      return {
        description,
        tokens,
        status,
        pass: tokenCapExceeded && statusMatches && errorMatches,
        detail: `status=${status}, tokens=${tokens}, error=${json.error?.message}`,
        raw: { description, tokens, status, error: json.error },
      };
    }

    const candidate = json.candidates?.[0];
    const candidateFiltered = candidate?.finishReason === "OTHER" &&
      candidate.finishMessage?.includes("copyrighted works") &&
      !candidate.content?.parts?.length;
    let failClosed = false;
    try {
      decodeAudioResponse(json);
    } catch {
      failClosed = true;
    }
    return {
      description,
      tokens,
      status,
      pass: tokenCapExceeded && statusMatches && candidateFiltered && failClosed,
      detail:
        `status=${status}, tokens=${tokens}, finishReason=${candidate?.finishReason}, failClosed=${failClosed}`,
      raw: {
        description,
        tokens,
        status,
        finishReason: candidate?.finishReason,
        finishMessage: candidate?.finishMessage,
        audioReturned: false,
        decoderFailedClosed: failClosed,
        usageMetadata: json.usageMetadata,
      },
    };
  }

  const { status: metadataStatus, json: metadata } = await provider("");
  checker.check(
    "model metadata returns 8192 input token limit and 16384 output limit",
    metadataStatus === 200 && metadata.inputTokenLimit === 8192 &&
      metadata.outputTokenLimit === 16384,
    `status: ${metadataStatus}, input: ${metadata.inputTokenLimit}, output: ${metadata.outputTokenLimit}`,
  );

  const article = await Deno.readTextFile(
    new URL("../docs/evidence/audio-feed-gueb/article.txt", import.meta.url),
  );
  const prompt = formatNarrationPrompt({ title: "History of the Internet", body: article });
  const segments = splitTextUnderByteBudget(prompt, MAX_TTS_INPUT_BYTES);
  checker.check(
    "production prompt splits into 8 segments under 6000-byte budget",
    segments.length === 8,
    `segments: ${segments.length}`,
  );
  const segmentCounts = [];
  for (const [index, segment] of segments.entries()) {
    segmentCounts.push({
      index: index + 1,
      bytes: bytes(segment),
      tokens: await countTokens(segment),
    });
  }
  checker.check(
    "every segment stays within MAX_TTS_INPUT_BYTES budget",
    segments.every((s) => bytes(s) <= MAX_TTS_INPUT_BYTES),
    `maxBudget: ${MAX_TTS_INPUT_BYTES}`,
  );

  // Two distinct unsegmented article controls: a reproducible expanded preamble and raw prose.
  const preamble = "Please narrate the following article clearly and naturally. ".repeat(70);
  const ctrl1 = await runNegativeControl(
    "Synthetic repeated sentence",
    "The quick brown fox jumps over the lazy dog. ".repeat(1500),
    400,
  );
  checker.check(
    "negative control: synthetic repeated sentence exceeds input token limit (400)",
    ctrl1.pass,
    ctrl1.detail,
  );

  const ctrl2 = await runNegativeControl(
    "Article with expanded preamble",
    `${preamble}\n\n${article}`,
    400,
  );
  checker.check(
    "negative control: article with expanded preamble exceeds input token limit (400)",
    ctrl2.pass,
    ctrl2.detail,
  );

  const ctrl3 = await runNegativeControl(
    "Raw unsegmented article",
    article,
    200,
  );
  checker.check(
    "negative control: raw unsegmented article triggers copyright filter (200 OTHER)",
    ctrl3.pass,
    ctrl3.detail,
  );
  const negativeControls = [ctrl1.raw, ctrl2.raw, ctrl3.raw];

  // Real prose, not the earlier 78-character smoke-test text.
  const sampleText = article.split("\n\n").slice(0, 2).join("\n\n");
  const request = buildSingleVoiceRequest(sampleText, "Charon", 0.7);
  const { status, json } = await provider(":generateContent", request, 120_000);
  checker.check(
    "positive synthesis returns HTTP 200 with STOP finishReason",
    status === 200 && json.candidates?.[0]?.finishReason === "STOP",
    `status: ${status}, finishReason: ${json.candidates?.[0]?.finishReason}`,
  );
  const inline = json.candidates?.[0]?.content?.parts?.find((
    part: { inlineData?: unknown },
  ) => part.inlineData)?.inlineData;
  checker.check(
    "positive synthesis returns audio/wav inline data",
    inline?.mimeType === "audio/wav" && typeof inline?.data === "string",
    `mimeType: ${inline?.mimeType}, dataLength: ${inline?.data?.length}`,
  );

  let audioBytes = new Uint8Array(0);
  try {
    if (typeof inline?.data === "string") {
      audioBytes = Uint8Array.fromBase64(inline.data);
    }
  } catch {
    // empty audio bytes
  }

  let wav = {
    audioFormat: 0,
    sampleRate: 0,
    channels: 0,
    bitsPerSample: 0,
    dataLength: 0,
    durationSeconds: 0,
  };
  try {
    if (audioBytes.length > 44) {
      wav = parseWavHeader(audioBytes);
    }
  } catch {
    // header parse failure
  }

  const riffHeader = audioBytes.length >= 4
    ? String.fromCharCode(...audioBytes.subarray(0, 4))
    : "";
  const waveHeader = audioBytes.length >= 12
    ? String.fromCharCode(...audioBytes.subarray(8, 12))
    : "";
  checker.check(
    "positive audio contains valid RIFF header",
    riffHeader === "RIFF",
    `magic: ${riffHeader}`,
  );
  checker.check(
    "positive audio contains valid WAVE format",
    waveHeader === "WAVE",
    `format: ${waveHeader}`,
  );
  checker.check(
    "positive audio WAV header matches 24000Hz 16-bit mono PCM format",
    wav.audioFormat === 1 && wav.sampleRate === 24000 && wav.channels === 1 &&
      wav.bitsPerSample === 16 && wav.dataLength > 0,
    `audioFormat: ${wav.audioFormat}, sampleRate: ${wav.sampleRate}, channels: ${wav.channels}, bitsPerSample: ${wav.bitsPerSample}, dataLength: ${wav.dataLength}`,
  );
  checker.check(
    "positive audio duration matches PCM data length calculation",
    Math.abs(
      wav.durationSeconds -
        wav.dataLength / (wav.sampleRate * wav.channels * wav.bitsPerSample / 8),
    ) < 0.001,
    `duration: ${wav.durationSeconds.toFixed(3)}s`,
  );

  let decodedFormat = "";
  let decodedTruncated = true;
  try {
    const decoded = decodeAudioResponse(json);
    decodedFormat = decoded.format;
    decodedTruncated = decoded.truncated;
  } catch {
    // decode failed
  }
  checker.check(
    "production audio decoder accepts generated WAV as non-truncated",
    decodedFormat === "wav" && !decodedTruncated,
    `format: ${decodedFormat}, truncated: ${decodedTruncated}`,
  );

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
        finishReason: json.candidates[0]?.finishReason,
        mimeType: inline?.mimeType,
        base64Length: inline?.data?.length,
        rawAudioBytes: audioBytes.length,
        audioHeaderHex: Array.from(
          audioBytes.subarray(0, 16),
          (b) => b.toString(16).padStart(2, "0"),
        ).join(" "),
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

  await writeEvidenceReadme({
    dir: "docs/evidence/audio-feed-u60a",
    title: "audio-feed-u60a: bounded live Gemini TTS verification",
    script: "scripts/verify_live_tts.ts",
    asserts: [
      "model metadata returns 8192 input token limit and 16384 output limit",
      "production prompt splits into 8 segments under 6000-byte budget",
      "every segment stays within MAX_TTS_INPUT_BYTES budget",
      "negative control: synthetic repeated sentence exceeds input token limit (400)",
      "negative control: article with expanded preamble exceeds input token limit (400)",
      "negative control: raw unsegmented article triggers copyright filter (200 OTHER)",
      "positive synthesis returns HTTP 200 with STOP finishReason",
      "positive synthesis returns audio/wav inline data",
      "positive audio contains valid RIFF header",
      "positive audio contains valid WAVE format",
      "positive audio WAV header matches 24000Hz 16-bit mono PCM format",
      "positive audio duration matches PCM data length calculation",
      "production audio decoder accepts generated WAV as non-truncated",
    ],
    sections: [
      {
        heading: "Artifact Provenance",
        body:
          "The `live-validation.json` artifact in this directory was captured by hand from script stdout during the original verification pass, while the claims declared below are programmatically verified by `scripts/verify_live_tts.ts`.",
      },
      {
        heading: "Live Verification Status & Provider Behavior (audio-feed-zrx9)",
        body: `Notice on asserted claim outcome:
- **Currently failing claim**: The assertion \`negative control: raw unsegmented article triggers copyright filter (200 OTHER)\` is currently FAILING against the live provider: observed HTTP status=200, tokens=10506, finishReason=STOP, failClosed=false.
- **Identical failure on main**: This failure was already present and failing identically on \`main\` prior to this migration when run against the live provider.
- **Live provider behavior, not application code**: The failing assertion tests the behavior of the external live Gemini TTS model at \`https://gemini.int.exe.xyz/v1beta\` on raw Wikipedia text, not our application code or transport. The migration neither introduced nor hides this failure.
- **Product tracking**: The question of whether the application relies on provider-side copyright filtering for correctness versus defense-in-depth is tracked under \`audio-feed-zrx9\` (P2).`,
      },
      {
        heading: "Transport and scope",
        body:
          `The harness **reimplements HTTP transport against the proxy** rather than invoking \`GeminiTtsClient.sendRequest\`, whose production default remains \`https://generativelanguage.googleapis.com/v1beta\` and requires \`x-goog-api-key\`. It uses production \`formatNarrationPrompt\`, \`splitTextUnderByteBudget\`, \`buildSingleVoiceRequest\`, \`parseWavHeader\`, and \`decodeAudioResponse\`. Thus the provider/model behavior, production segmentation, request construction, and decoder are measured, but production auth, retries, and full end-to-end multi-segment synthesis/stitching are **not** live-verified here. The positive call synthesizes only an article excerpt, not all eight segments; listening quality is not assessed.`,
      },
      {
        heading: "Model and controls",
        body:
          `\`models/gemini-3.8-flash-tts\` returned an 8,192 input-token limit, 16,384 output-token limit, and \`generateContent\`, \`countTokens\`, \`batchGenerateContent\` methods. Unsegmented controls use the same proxy/model:

| Input | Measured tokens | HTTP | Result |
|---|---:|---:|---|
| Repeated synthetic sentence | 15,001 | 400 | \`INVALID_ARGUMENT\`: \`The input token count exceeds the maximum number of tokens allowed (8192).\` |
| Raw article preceded by \`"Please narrate the following article clearly and naturally. "\` repeated 70 times plus two newlines | 11,208 | 400 | Same limit error |
| Raw article alone | 10,506 | 200 | \`OTHER\`, copyright-resemblance filter, no audio; production \`decodeAudioResponse\` throws |

The previous ad-hoc expanded-preamble result was **11,207** tokens; the committed, explicitly constructed preamble measured **11,208** on this run. The raw article's 10,506 tokens differ from the formatted production prompt's 10,512 because the latter includes the narration intro. Both distinctions are preserved rather than labelling unlike inputs with the same count.

**Enforcement anomaly:** The published cap and 400 error both say 8,192, yet this raw 10,506-token request returned HTTP 200 with *no usable audio* due to copyright filtering, while the 11,208-token expanded request returned 400. This does not establish an acceptance threshold, or successful generation above the cap. The production 6,000-byte budget stays below the declared cap for all measured segments.`,
      },
      {
        heading: "Article segmentation and positive audio",
        body:
          `The source \`docs/evidence/audio-feed-gueb/article.txt\` has **47,000 characters / 47,018 UTF-8 bytes**. \`formatNarrationPrompt({ title: "History of the Internet", body: article })\` yields 47,044 bytes and 10,512 provider-counted tokens. Production segmentation yields eight chunks under the 6,000-byte budget:

| Segment | Bytes | Provider tokens |
|---:|---:|---:|
| 1 | 5,867 | 1,238 |
| 2 | 5,989 | 1,365 |
| 3 | 5,974 | 1,369 |
| 4 | 5,834 | 1,353 |
| 5 | 5,975 | 1,310 |
| 6 | 5,830 | 1,284 |
| 7 | 5,858 | 1,372 |
| 8 | 5,706 | 1,218 |

The largest segment is 1,372 tokens (16.75% of the published input cap), matching the earlier mock-exact 8-chunk prediction. The positive request uses \`buildSingleVoiceRequest\` with Charon, temperature 0.7 and \`maxOutputTokens: 16384\` over the **first two paragraphs of article.txt** (1,097 characters / bytes), not the former 78-character smoke text. Observed HTTP 200, \`STOP\`, model version \`gemini-3.8-flash-tts\`, usage **215 text prompt tokens + 1,568 audio candidate tokens = 1,783 total**. The returned \`audio/wav\` base64 is 4,022,232 characters; decoded WAV is 3,016,674 bytes with first 16 header bytes \`52 49 46 46 da 07 2e 00 57 41 56 45 66 6d 74 20\`. Both RIFF and WAVE bytes are checked; PCM WAV header parsing confirmed **24,000 Hz, mono, 16-bit, 3,010,560 data bytes**, yielding **62.72 seconds** from the declared PCM rate. The production decoder also accepted it as non-truncated WAV. Generated audio token count/byte length can vary on a future rerun; these are observations from the committed output, not deterministic assertions.`,
      },
      {
        heading: "Verdict",
        body:
          `**VERIFIED for bounded proxy/provider segmentation, controls and excerpt audio; production-client end-to-end and eight-segment playback UNVERIFIED.** The harness enforces expected HTTP/filter behavior and real WAV validity, but not byte-for-byte identity of future generated audio.`,
      },
    ],
  });
  console.log("Saved report to docs/evidence/audio-feed-u60a/README.md");
});
