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
import { describeSynthesis, observeSynthesis, usableSynthesis } from "./synthesis_observation.ts";

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
        raw: {
          description,
          tokens,
          status,
          error: json.error,
          observation: observeSynthesis(status, json),
        },
      };
    }

    const candidate = json.candidates?.[0];
    const candidateFiltered = candidate?.finishReason === "OTHER" &&
      candidate.finishMessage?.includes("copyrighted works") &&
      !candidate.content?.parts?.length;
    // ONE decode, by the application's own decoder, and BOTH the legacy refusal-control record and
    // the positive usable-speech observation are derived from what it said (audio-feed-kx2m: a
    // separately computed `failClosed` once disagreed with the observation's invented audio term).
    const observation = observeSynthesis(status, json);
    const failClosed = observation.decoder === "rejected";
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
        audioReturned: observation.decoder === "accepted",
        decoderFailedClosed: failClosed,
        usageMetadata: json.usageMetadata,
        observation,
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

  // audio-feed-zrx9 NARROWING, CORRECTED BY audio-feed-fipl AND THEN BY audio-feed-kx2m. This
  // control used to require the provider to recitation-filter raw Wikipedia prose (HTTP 200 +
  // finishReason OTHER + finishMessage "copyrighted works" + no audio). Re-measured against the
  // live provider on 2026-10-12: 200 + STOP + ordinary audio for the same 10,506-token input, so
  // the old claim no longer describes the provider. The first narrowing then asserted the refusal's
  // ABSENCE (a 500, an empty candidate list and a malformed body all read as "not refused" -
  // audio-feed-fipl), and the first positive form measured an audio STRING, which an undecodable
  // payload still has (audio-feed-kx2m). The claim is now the invariant: HTTP 200, a candidate that
  // completed, and the APPLICATION'S OWN decoder accepting that very response and handing back
  // audio. `observeSynthesis` calls `decodeAudioResponse`, and this check consults that verdict
  // rather than any term this proof invented for itself. The shapes that must keep it red are
  // pinned offline in tests/synthesis_observation_test.ts, `data: "%%%%"` included.
  const ctrl3 = await runNegativeControl(
    "Raw unsegmented article",
    article,
    200,
  );
  const ctrl3Observation = ctrl3.raw.observation;
  checker.check(
    "raw unsegmented article returns usable speech: 200, candidate, STOP, production decoder accepted it (audio-feed-zrx9 narrowing, audio-feed-fipl, audio-feed-kx2m)",
    usableSynthesis(ctrl3Observation),
    `${
      describeSynthesis(ctrl3Observation)
    } - a refusal's absence is only asserted after the application's own decoder accepted the observed response`,
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
      "raw unsegmented article returns usable speech: 200, candidate, STOP, production decoder accepted it (audio-feed-zrx9 narrowing, audio-feed-fipl, audio-feed-kx2m)",
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
          `Run on 2026-10-08 UTC: \`timeout -k 30 300 deno run -A scripts/verify_live_tts.ts\`. The **complete actual script output** is [\`live-validation.json\`](live-validation.json). Each provider fetch has an AbortSignal timeout (20 seconds for metadata/counts, 120 seconds for synthesis controls). The fleet proxy at \`https://gemini.int.exe.xyz/v1beta\` appends the API path and injects the key server-side; no credential is stored or transmitted by this script.

The \`live-validation.json\` artifact in this directory was captured by hand from script stdout during the original verification pass, while the claims declared above are programmatically verified by \`scripts/verify_live_tts.ts\`.`,
      },
      {
        heading: "Live Verification Status & Provider Behavior (audio-feed-zrx9)",
        body:
          `The raw-article refusal control was **narrowed on 2026-10-12**, after re-measuring the live provider. What follows is the record of why, so the narrowing can be judged rather than trusted:
- **What changed**: the old claim was \`negative control: raw unsegmented article triggers copyright filter (200 OTHER)\`. It required HTTP 200 + \`finishReason: "OTHER"\` + a \`finishMessage\` naming copyrighted works + no audio. Re-run on 2026-10-12 the same 10,506-token input returned **HTTP 200, \`finishReason: STOP\`, and ordinary audio** (\`failClosed=false\`), so the claim no longer describes the provider.
- **Why this is not a silent deletion, and why the narrowing needed correcting twice**: the claim is the invariant - HTTP 200, a candidate that completed, and the APPLICATION'S OWN decoder accepting that very response and handing back audio - and the refusal's absence follows from it rather than replacing it. The first narrowing asserted the refusal's absence directly, which review caught (\`audio-feed-fipl\`): \`finishReason !== "OTHER"\` is also true for an HTTP 500, an empty candidate list and a malformed body, so "we saw nothing" was indistinguishable from "there was nothing to see". The first positive form then measured an audio string rather than decoded audio, which review caught too (\`audio-feed-kx2m\`): \`data: "%%%%"\` on a 200 with \`finishReason STOP\` passed while \`decodeAudioResponse\` threw. The observation now calls the application's decoder and consults its verdict. Every one of those shapes is pinned as an offline mutant in \`tests/synthesis_observation_test.ts\` and keeps the control red. The two token-cap controls above are unchanged and still fail on over-cap inputs.
- **What the app actually depends on** (so the property survives the narrowing): (1) every paid call is segmented to \`MAX_TTS_INPUT_BYTES\` = 6,000 bytes — asserted above for all eight production segments and enforced again inside \`synthesizeNarration\`; and (2) a refused or part-less provider response must produce no audio rather than a published episode, which \`decodeAudioResponse\` enforces and which is kept as a deterministic control in \`tests/tts_hardening_test.ts\` ("a copyright-recitation refusal fails closed through the decoder") because the live provider can no longer be made to produce that shape on demand.
- **Not a product change**: \`PRODUCT.md\` specifies Direct Read of the full article text and \`src/worker/synthesis.ts\` has always sent the article body, segmented - the refusal was defence in depth against an unsegmented send, not a mechanism the pipeline relies on. If the operator treats provider-side recitation refusal as a compliance control rather than a backstop, that is a product decision above this script's pay grade and belongs on \`audio-feed-zrx9\`.`,
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
| Raw article alone | 10,506 | 200 | No refusal since 2026-10-12: \`finishReason STOP\` with audio (before that date: \`OTHER\`, copyright-resemblance filter, no audio). See the narrowing note above. |

The previous ad-hoc expanded-preamble result was **11,207** tokens; the committed, explicitly constructed preamble measured **11,208** on the 2026-10-08 run. The raw article's 10,506 tokens differ from the formatted production prompt's 10,512 because the latter includes the narration intro. Both distinctions are preserved rather than labelling unlike inputs with the same count.

**Enforcement anomaly (re-measured 2026-10-12):** the published cap and the 400 error both say 8,192, yet the raw 10,506-token request returned HTTP 200 — now with *audio*, where on 2026-10-08 it returned 200 with no audio. So the cap has never been a reliable backstop for an accidentally unsegmented send, on either side of this change: the 11,208-token expanded request is refused, the 10,506-token raw article is not. Production safety here comes from \`splitTextUnderByteBudget\` keeping every paid call at or under the 6,000-byte budget (asserted above), not from the provider refusing large inputs.`,
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
          `**VERIFIED as of the 2026-10-08 run (bounded proxy/provider segmentation, controls and excerpt audio; production-client end-to-end and eight-segment playback UNVERIFIED); NARROWED 2026-10-12 AND CORRECTED THE SAME DAY (audio-feed-fipl): the raw-article refusal control no longer describes the provider, so the claim is now that the call returned usable speech (HTTP 200, a candidate that completed, and the application's own decoder accepting that response and handing back audio) and only then that no refusal was seen; the shapes both earlier attempts got wrong are pinned as offline mutants in tests/synthesis_observation_test.ts — see the live verification status section above.** The harness enforces expected HTTP/filter behavior as observed on that run and real WAV validity, but not byte-for-byte identity of future generated audio.`,
      },
    ],
  });
  console.log("Saved report to docs/evidence/audio-feed-u60a/README.md");
});
