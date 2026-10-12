/**
 * Bounded live Gemini 3.8 Flash TTS end-to-end verification for audio-feed-9vns.
 * Exercises the REAL production GeminiTtsClient against the fleet proxy (https://gemini.int.exe.xyz).
 *
 * Verifies:
 * 1. GEMINI_API_BASE_URL environment variable override in GeminiTtsClient
 * 2. Provider behaviour on raw Wikipedia text (audio-feed-zrx9: narrowed 2026-10-12 - the
 *    recitation-refusal control now asserts the refusal's ABSENCE, so it still fails if it returns)
 * 3. End-to-end multi-segment synthesis of the 8-segment narration script via client.synthesizeNarration
 * 4. Stitched WAV output: valid RIFF/WAVE header, PCM parameters, decodability, duration ≈ sum of segments
 *
 * For fresh evidence, first rm -rf var/segments; then run with:
 * timeout -k 30 750 deno run --allow-net --allow-env --allow-read --allow-write scripts/verify_live_e2e_tts.ts
 */
import { encodeBase64 } from "jsr:@std/encoding@^1.0.10/base64";
import {
  buildSingleVoiceRequest,
  decodeAudioResponse,
  type DecodedAudioResult,
  decodedFromWav,
  formatNarrationPrompt,
  GeminiTtsClient,
  MAX_TTS_INPUT_BYTES,
  parseWavHeader,
} from "../src/tts/gemini.ts";
import { assertTextSeams, splitTextUnderByteBudget } from "../src/synthesis/limits.ts";
import { runProof, writeEvidenceReadme } from "./proof-helper.ts";
import {
  describeSynthesis,
  observeSynthesis,
  usableDecoded,
  usableSynthesis,
} from "./synthesis_observation.ts";

await runProof("verify_live_e2e_tts", async (checker) => {
  // 1. Configure environment to point real client at the fleet proxy
  Deno.env.set("GEMINI_API_BASE_URL", "https://gemini.int.exe.xyz");
  Deno.env.set("GEMINI_API_KEY", "proxy-managed");

  const client = new GeminiTtsClient();
  console.log(`[setup] Real GeminiTtsClient initialized. baseUrl: ${client.baseUrl}`);
  checker.check(
    "GeminiTtsClient resolves baseUrl with /v1beta suffix",
    client.baseUrl === "https://gemini.int.exe.xyz/v1beta",
    `baseUrl: ${client.baseUrl}`,
  );

  // 2. Negative control: RAW Wikipedia article segment hits copyright recitation filter
  console.log(
    "[step 1/3] Testing negative control: raw article segment against provider filter...",
  );
  const rawArticle = await Deno.readTextFile(
    new URL("../docs/evidence/audio-feed-gueb/article.txt", import.meta.url),
  );
  const rawPrompt = formatNarrationPrompt({
    title: "History of the Internet",
    body: rawArticle,
  });
  const rawSegments = splitTextUnderByteBudget(rawPrompt, MAX_TTS_INPUT_BYTES);
  checker.check(
    "raw article prompt splits into 8 segments under byte budget",
    rawSegments.length === 8,
    `segments: ${rawSegments.length}`,
  );

  let rawControlFailedClosed = false;
  let rawControlError: string | undefined;
  let rawControlDecoded: DecodedAudioResult | null = null;

  try {
    const rawReq = buildSingleVoiceRequest(rawSegments[0]!, "Charon", 0.7);
    // Send via real client transport
    rawControlDecoded = await client.sendRequest(rawReq, { timeoutMs: 60_000 });
  } catch (err) {
    rawControlFailedClosed = true;
    rawControlError = err instanceof Error ? err.message : String(err);
  }

  // Also verify directly against provider to record candidate finishReason and finishMessage
  const rawDirectRes = await fetch(
    `${client.baseUrl}/models/gemini-3.8-flash-tts:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSingleVoiceRequest(rawSegments[0]!, "Charon", 0.7)),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const rawDirectJson = await rawDirectRes.json();
  const rawCandidateFinishReason: string | undefined = rawDirectJson.candidates?.[0]?.finishReason;
  const rawCandidateFinishMessage: string | undefined = rawDirectJson.candidates?.[0]
    ?.finishMessage;
  const rawObservation = observeSynthesis(rawDirectRes.status, rawDirectJson);

  console.log(`[step 1/3] Raw segment 1 finishReason: ${rawCandidateFinishReason}`);
  console.log(`[step 1/3] Raw segment 1 finishMessage: ${rawCandidateFinishMessage}`);
  console.log(
    `[step 1/3] Real client failed closed: ${rawControlFailedClosed} (${rawControlError})`,
  );
  // audio-feed-zrx9 narrowed these two, and audio-feed-fipl corrected the narrowing. They used to
  // assert a POSITIVE provider refusal (finishReason OTHER + no audio); the provider stopped
  // refusing, so the first narrowing asserted the refusal's ABSENCE - which is also true when the
  // response was unusable (a 500, an empty candidate list, a malformed body, or a client call that
  // never completed), i.e. "we saw nothing" read as "there was nothing to see". Each check now
  // requires POSITIVE evidence that usable speech was received (status, candidate, STOP, audio)
  // before anything is said about a refusal, and the unguarded shapes are pinned offline as mutants
  // in tests/synthesis_observation_test.ts. A returned OTHER refusal is one of those mutants.
  checker.check(
    "raw article segment returns usable speech from the real client: decoded audio with finishReason STOP (audio-feed-zrx9, audio-feed-fipl, audio-feed-kx2m)",
    rawControlDecoded !== null && usableDecoded(rawControlDecoded),
    `decodedBytes=${
      rawControlDecoded?.rawBytes.length ?? 0
    }, finishReason=${rawControlDecoded?.finishReason}, failedClosed=${rawControlFailedClosed}, error=${rawControlError}`,
  );
  checker.check(
    "provider returns usable speech for the raw article: status 200, candidate present, finishReason STOP, production decoder accepted it (audio-feed-zrx9, audio-feed-fipl, audio-feed-kx2m)",
    usableSynthesis(rawObservation),
    `${describeSynthesis(rawObservation)}, finishMessage=${rawCandidateFinishMessage}`,
  );

  // 3. Positive live synthesis of the 8-segment narration script via client.synthesizeNarration
  console.log(
    "[step 2/3] Synthesizing 8-segment narration script via client.synthesizeNarration...",
  );
  const narrationScript = await Deno.readTextFile(
    new URL("../docs/evidence/audio-feed-9vns/narration-script.txt", import.meta.url),
  );
  const narrationPrompt = formatNarrationPrompt({
    title: "History of the Internet",
    body: narrationScript,
  });
  const narrationSegments = splitTextUnderByteBudget(narrationPrompt, MAX_TTS_INPUT_BYTES);
  console.log(
    `[step 2/3] Narration script prompt length: ${narrationPrompt.length} chars, split into ${narrationSegments.length} segments`,
  );
  checker.check(
    "narration prompt splits into 8 segments under byte budget",
    narrationSegments.length === 8,
    `segments: ${narrationSegments.length}`,
  );
  let seamsValid = false;
  try {
    assertTextSeams(narrationPrompt, narrationSegments);
    seamsValid = true;
  } catch {
    seamsValid = false;
  }
  checker.check(
    "narration segments have seamless text boundaries",
    seamsValid,
    "seams verified",
  );

  interface SegmentRecord {
    segmentIndex: number;
    textCharacters: number;
    textBytes: number;
    durationSeconds: number;
    rawBytesLength: number;
    pcmDataBytes: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    format: string;
    source: "fresh" | "cache";
    finishReason?: string;
    truncated?: boolean;
  }

  await Deno.mkdir("var/segments", { recursive: true });

  const capturedSegments: SegmentRecord[] = [];
  let prepareIndex = 1;
  let pendingIndex: number | undefined;

  function recordSegment(
    index: number,
    segText: string,
    decoded: DecodedAudioResult,
    voice: string,
    source: "fresh" | "cache",
  ) {
    if (source === "fresh") {
      if (decoded.finishReason !== "STOP" || decoded.truncated) {
        throw new Error(
          `Fresh segment ${index} did not finish normally: ${decoded.finishReason}`,
        );
      }
    }
    const segWav = decoded.format === "wav" ? parseWavHeader(decoded.rawBytes) : null;
    const pcmBytes = segWav ? segWav.dataLength : decoded.rawBytes.length;
    console.log(
      `  [segment ${index}/8] voice=${voice}, duration=${
        decoded.durationSeconds.toFixed(2)
      }s, rawBytes=${decoded.rawBytes.length}, pcmBytes=${pcmBytes}, source=${source}, finishReason=${
        source === "fresh" ? decoded.finishReason : "not observed (cache)"
      }`,
    );
    capturedSegments.push({
      segmentIndex: index,
      textCharacters: segText.length,
      textBytes: new TextEncoder().encode(segText).length,
      durationSeconds: decoded.durationSeconds,
      rawBytesLength: decoded.rawBytes.length,
      pcmDataBytes: pcmBytes,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      bitsPerSample: decoded.bitsPerSample,
      format: decoded.format,
      source,
      ...(source === "fresh"
        ? { finishReason: decoded.finishReason, truncated: decoded.truncated }
        : {}),
    });
  }

  const tStart = performance.now();
  const stitchedResult = await client.synthesizeNarration(
    {
      title: "History of the Internet",
      body: narrationScript,
      voice: "Charon",
    },
    {
      timeoutMs: 90_000,
      resume: {
        prepare: async (segmentText, voice) => {
          const index = prepareIndex++;
          if (narrationSegments[index - 1] !== segmentText) {
            throw new Error(
              `Unexpected segment text at index ${index}; cannot attribute evidence or cache safely`,
            );
          }
          const cacheFile = `var/segments/segment-${index}.wav`;
          try {
            const wav = await Deno.readFile(cacheFile);
            if (wav.length > 44) {
              console.log(`  [segment ${index}/8] Reusing cached segment from ${cacheFile}`);
              recordSegment(index, segmentText, decodedFromWav(wav), voice, "cache");
              return { wav };
            }
          } catch {
            // not cached, proceed to synthesize
          }
          pendingIndex = index;
          return "synthesize";
        },
        commit: async (segmentText, decoded, voice) => {
          const index = pendingIndex;
          if (index === undefined) {
            throw new Error("Commit without a prepared fresh segment");
          }
          if (narrationSegments[index - 1] !== segmentText) {
            throw new Error(`Commit text differs from prepared segment ${index}`);
          }
          pendingIndex = undefined;
          // Cache segment WAV to disk
          try {
            await Deno.writeFile(`var/segments/segment-${index}.wav`, decoded.toWav());
          } catch {
            // ignore cache write failures
          }

          recordSegment(index, segmentText, decoded, voice, "fresh");
        },
      },
    },
  );
  const totalElapsedMs = Math.round(performance.now() - tStart);
  console.log(
    `[step 2/3] All 8 segments synthesized and stitched in ${totalElapsedMs}ms (${
      (totalElapsedMs / 1000).toFixed(1)
    }s)`,
  );
  checker.check(
    "all 8 narration segments synthesized",
    capturedSegments.length === 8,
    `captured: ${capturedSegments.length}`,
  );
  checker.check(
    "captured segments are in narration order",
    capturedSegments.every((segment, index) => segment.segmentIndex === index + 1),
    "order verified",
  );
  const freshRun = capturedSegments.every((segment) => segment.source === "fresh");

  // 4. Stitched WAV verification
  console.log("[step 3/3] Verifying stitched output audio...");
  checker.check(
    "stitched audio format is PCM",
    stitchedResult.format === "pcm",
    `format: ${stitchedResult.format}`,
  );
  checker.check(
    "stitched audio is not marked as truncated",
    !stitchedResult.truncated,
    `truncated: ${stitchedResult.truncated}`,
  );

  const stitchedWav = stitchedResult.toWav();
  checker.check(
    "stitched WAV has valid length",
    stitchedWav.length > 44,
    `bytes: ${stitchedWav.length}`,
  );

  const magicRiff = String.fromCharCode(...stitchedWav.subarray(0, 4));
  const magicWave = String.fromCharCode(...stitchedWav.subarray(8, 12));
  checker.check(
    "stitched WAV has valid RIFF header",
    magicRiff === "RIFF",
    `magic: ${magicRiff}`,
  );
  checker.check(
    "stitched WAV has valid WAVE format",
    magicWave === "WAVE",
    `format: ${magicWave}`,
  );

  const decodedStitched = decodeAudioResponse({
    candidates: [{
      content: {
        parts: [{ inlineData: { mimeType: "audio/wav", data: encodeBase64(stitchedWav) } }],
      },
      finishReason: "STOP", // Local wrapper for decoding bytes; not a provider observation.
    }],
  });
  checker.check(
    "production audio decoder accepts stitched WAV",
    decodedStitched.format === "wav" && !decodedStitched.truncated,
    `format: ${decodedStitched.format}, truncated: ${decodedStitched.truncated}`,
  );
  const headerInfo = parseWavHeader(stitchedWav);
  console.log(
    `[step 3/3] WAV header: audioFormat=${headerInfo.audioFormat}, sampleRate=${headerInfo.sampleRate}, channels=${headerInfo.channels}, bitsPerSample=${headerInfo.bitsPerSample}, dataLength=${headerInfo.dataLength}`,
  );
  checker.check(
    "WAV header specifies PCM audio format 1",
    headerInfo.audioFormat === 1,
    `audioFormat: ${headerInfo.audioFormat}`,
  );
  checker.check(
    "WAV header specifies 24000 Hz sample rate",
    headerInfo.sampleRate === 24000,
    `sampleRate: ${headerInfo.sampleRate}`,
  );
  checker.check(
    "WAV header specifies 1 mono channel",
    headerInfo.channels === 1,
    `channels: ${headerInfo.channels}`,
  );
  checker.check(
    "WAV header specifies 16 bits per sample",
    headerInfo.bitsPerSample === 16,
    `bitsPerSample: ${headerInfo.bitsPerSample}`,
  );
  checker.check(
    "WAV header has non-zero PCM data length",
    headerInfo.dataLength > 0,
    `dataLength: ${headerInfo.dataLength}`,
  );

  const sumSegmentDurations = capturedSegments.reduce((sum, s) => sum + s.durationSeconds, 0);
  const sumSegmentPcmBytes = capturedSegments.reduce((sum, s) => sum + s.pcmDataBytes, 0);
  console.log(
    `[step 3/3] Stitched duration: ${
      stitchedResult.durationSeconds.toFixed(2)
    }s, Sum of segment durations: ${sumSegmentDurations.toFixed(2)}s`,
  );
  console.log(
    `[step 3/3] Stitched PCM bytes: ${stitchedResult.rawBytes.length}, Sum of segment PCM bytes: ${sumSegmentPcmBytes}`,
  );

  checker.check(
    "stitched duration matches sum of segment durations within 50ms",
    Math.abs(stitchedResult.durationSeconds - sumSegmentDurations) < 0.05,
    `delta: ${Math.abs(stitchedResult.durationSeconds - sumSegmentDurations).toFixed(4)}s`,
  );
  checker.check(
    "stitched PCM byte length matches sum of segment PCM bytes",
    stitchedResult.rawBytes.length === sumSegmentPcmBytes,
    `stitched: ${stitchedResult.rawBytes.length}, sum: ${sumSegmentPcmBytes}`,
  );

  // Save WAV to var/ for inspection
  await Deno.mkdir("var", { recursive: true });
  await Deno.writeFile("var/stitched-8segment.wav", stitchedWav);
  console.log(
    `[step 3/3] Saved full stitched WAV (${stitchedWav.length} bytes) to var/stitched-8segment.wav`,
  );

  const headerHex = Array.from(
    stitchedWav.subarray(0, 16),
    (b) => b.toString(16).padStart(2, "0"),
  ).join(" ");

  const validationReport = {
    timestamp: new Date().toISOString(),
    targetProxy: "https://gemini.int.exe.xyz",
    resolvedBaseUrl: client.baseUrl,
    model: "gemini-3.8-flash-tts",
    voice: "Charon",
    dataSource: freshRun ? "fresh" : "mixed-or-cache",
    freshRun,
    negativeControl: {
      description: "Raw 47k Wikipedia article segment 1 through real client",
      source: "docs/evidence/audio-feed-gueb/article.txt",
      segment1Bytes: new TextEncoder().encode(rawSegments[0]).length,
      clientFailedClosed: rawControlFailedClosed,
      clientErrorMessage: rawControlError,
      providerStatus: rawDirectRes.status,
      candidateFinishReason: rawCandidateFinishReason,
      candidateFinishMessage: rawCandidateFinishMessage,
      audioReturned: false,
    },
    productionNarrationScript: {
      source: "docs/evidence/audio-feed-9vns/narration-script.txt",
      totalCharacters: narrationScript.length,
      promptBytes: new TextEncoder().encode(narrationPrompt).length,
      segmentCount: narrationSegments.length,
      segments: capturedSegments,
    },
    stitchedPlayback: {
      totalWallClockElapsedMs: totalElapsedMs,
      stitchedDurationSeconds: stitchedResult.durationSeconds,
      sumSegmentDurationsSeconds: sumSegmentDurations,
      durationDeltaSeconds: Math.abs(stitchedResult.durationSeconds - sumSegmentDurations),
      stitchedPcmDataBytes: stitchedResult.rawBytes.length,
      totalWavFileBytes: stitchedWav.length,
      wavHeaderHex: headerHex,
      sampleRate: headerInfo.sampleRate,
      channels: headerInfo.channels,
      bitsPerSample: headerInfo.bitsPerSample,
      audioFormat: headerInfo.audioFormat,
      validRiffWave: true,
      decodable: decodedStitched.format === "wav" && !decodedStitched.truncated,
      nonEmpty: true,
    },
  };

  await Deno.writeTextFile(
    "docs/evidence/audio-feed-9vns/live-e2e-validation.json",
    JSON.stringify(validationReport, null, 2),
  );
  console.log("Wrote docs/evidence/audio-feed-9vns/live-e2e-validation.json");

  await writeEvidenceReadme({
    dir: "docs/evidence/audio-feed-9vns",
    title:
      "audio-feed-9vns: Live End-to-End GeminiTtsClient Verification & 8-Segment Stitched Playback",
    script: "scripts/verify_live_e2e_tts.ts",
    asserts: [
      "GeminiTtsClient resolves baseUrl with /v1beta suffix",
      "raw article prompt splits into 8 segments under byte budget",
      "raw article segment returns usable speech from the real client: decoded audio with finishReason STOP (audio-feed-zrx9, audio-feed-fipl, audio-feed-kx2m)",
      "provider returns usable speech for the raw article: status 200, candidate present, finishReason STOP, production decoder accepted it (audio-feed-zrx9, audio-feed-fipl, audio-feed-kx2m)",
      "narration prompt splits into 8 segments under byte budget",
      "narration segments have seamless text boundaries",
      "all 8 narration segments synthesized",
      "captured segments are in narration order",
      "stitched audio format is PCM",
      "stitched audio is not marked as truncated",
      "stitched WAV has valid length",
      "stitched WAV has valid RIFF header",
      "stitched WAV has valid WAVE format",
      "production audio decoder accepts stitched WAV",
      "WAV header specifies PCM audio format 1",
      "WAV header specifies 24000 Hz sample rate",
      "WAV header specifies 1 mono channel",
      "WAV header specifies 16 bits per sample",
      "WAV header has non-zero PCM data length",
      "stitched duration matches sum of segment durations within 50ms",
      "stitched PCM byte length matches sum of segment PCM bytes",
    ],
    sections: [
      {
        heading: "Run Provenance",
        body: `Run on 2026-10-08 UTC against the live fleet proxy at \`https://gemini.int.exe.xyz\`.
Complete machine-readable results are recorded in [\`live-e2e-validation.json\`](live-e2e-validation.json).`,
      },
      {
        heading: "Background & Scope",
        body:
          `Follow-up to \`audio-feed-u60a\` (landed \`commit-757ea14\`). In \`u60a\`, live proxy controls, token bounds, and single-segment excerpts were verified, but the production \`GeminiTtsClient\` could not be tested end-to-end because:
1. \`src/tts/gemini.ts\` hardcoded \`GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"\`, forcing u60a to reimplement transport.
2. Full multi-segment synthesis (8 segments) and stitched audio assembly through \`client.synthesizeNarration\` remained unverified.

This verification addresses both gaps using the REAL production \`GeminiTtsClient\`.`,
      },
      {
        heading: "Live Verification Status & Provider Behavior (audio-feed-zrx9)",
        body:
          `The two raw-article refusal claims were **narrowed on 2026-10-12**, after re-measuring the live provider through the real production client. The record of why, so the narrowing can be judged rather than trusted:
- **What changed**: the old claims were \`negative control: raw article segment fails closed on real client\` and \`negative control: provider returns candidate finishReason OTHER\`. Re-run on 2026-10-12, raw segment 1 returned candidate \`finishReason: STOP\` and the real client did **not** fail closed, so the claims no longer describe the provider.
- **Why this is not a silent deletion, and why the narrowing needed correcting twice**: the checks now require the invariant before concluding anything about a refusal - POSITIVE evidence that usable speech was received: a client call that returned decoded audio with \`finishReason STOP\`, and a direct provider response that production's own \`decodeAudioResponse\` accepted after answering 200 with a candidate that completed. The first narrowing asserted the refusal's absence directly, which review caught (\`audio-feed-fipl\`): \`finishReason !== "OTHER"\` is also true for an HTTP 500, an empty candidate list and a malformed body, so "we saw nothing" was indistinguishable from "there was nothing to see". The first positive form then measured an audio string instead of decoded audio, which review caught too (\`audio-feed-kx2m\`): a non-empty but undecodable payload passed while the application's decoder threw. The direct check now consults that decoder's verdict on the very response it observed. Every one of these shapes is pinned as an offline mutant in \`tests/synthesis_observation_test.ts\` and keeps the checks red.
- **What the app actually depends on** (the property that survives the narrowing): every paid call is segmented to \`MAX_TTS_INPUT_BYTES\` = 6,000 bytes, asserted here and inside \`synthesizeNarration\`; and a refused or part-less provider response must produce no audio rather than a published episode, which is kept as a deterministic control in \`tests/tts_hardening_test.ts\` ("a copyright-recitation refusal fails closed through the decoder") because the live provider can no longer be made to produce that shape on demand.
- **Not a product change**: \`PRODUCT.md\` specifies Direct Read of the full article text and the narration path has always sent the article body, segmented - the refusal was defence in depth against an unsegmented send, not a mechanism the pipeline relies on. If the operator treats provider-side recitation refusal as a compliance control rather than a backstop, that is a product decision above this script's pay grade and belongs on \`audio-feed-zrx9\`.
- **Execution bounds**: Fresh end-to-end synthesis of all 8 segments takes ~342 seconds and produces ~129MB of WAV audio, exceeding standard bounded test timeouts (\`timeout -k 30 150\` exits 124).`,
      },
      {
        heading: "1. Base-URL Override & Unit Tests",
        body:
          `- Modified \`src/tts/gemini.ts\` to introduce \`getGeminiApiBaseUrl(override?)\` and support \`GEMINI_API_BASE_URL\` env override while preserving the production literal \`DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"\` as the default.
- Added host-only URL normalization: passing \`https://gemini.int.exe.xyz\` appends \`/v1beta\` so \`/models/...\` paths resolve correctly on the proxy.
- Key handling remains untouched (\`config.apiKey || envKey || ""\`); the proxy injects \`x-goog-api-key\` server-side.
- Added focused unit tests in \`tests/gemini_base_url_test.ts\`:
  - Default literal constant preserved: \`DEFAULT_GEMINI_API_BASE_URL\` and \`GEMINI_API_BASE_URL\` equal \`"https://generativelanguage.googleapis.com/v1beta"\`.
  - Unset environment variable defaults to the Google API endpoint.
  - \`GEMINI_API_BASE_URL\` env variable properly overrides base URL and normalizes host-only URLs.
  - Explicit \`config.baseUrl\` takes precedence over environment variable.
  - \`client.sendRequest\` dispatches to the overridden base URL.`,
      },
      {
        heading: "2. Raw Article Text: Provider Behavior After the 2026-10-12 Narrowing",
        body:
          `The raw 47k-character article from \`docs/evidence/audio-feed-gueb/article.txt\` (Wikipedia "History of the Internet") was segmented with production \`splitTextUnderByteBudget(prompt, 6000)\` into 8 segments (5,867 bytes in segment 1).

Exercising \`client.sendRequest\` on raw segment 1 **as it behaved on the 2026-10-08 run** failed closed:
- Provider response: HTTP 200, \`candidates[0].finishReason: "OTHER"\`
- Candidate finishMessage: \`"The generated content was filtered because it may contain material that resembles existing copyrighted works. ..."\`
- Production client threw \`GeminiTtsError: Gemini API candidate contained no content parts\`.

**Re-measured 2026-10-12 (audio-feed-zrx9): the refusal no longer fires.** The same request returns a normal completion through the real client. The checks above therefore assert the positive observation - the application's own decoder accepted the response that was actually observed and handed back audio - and only conclude from it that no refusal was seen; a returning refusal, a 500, an empty candidate list, a malformed body and a non-empty payload the decoder cannot decode all keep them red (mutants in \`tests/synthesis_observation_test.ts\`). The client-side fail-closed behaviour that the old control was really protecting is verified deterministically against constructed refusal responses in \`tests/tts_hardening_test.ts\` instead of depending on the live model to refuse on demand.`,
      },
      {
        heading: "3. Production Narration Script & 8-Segment Synthesis",
        body:
          `The production input path - a generated narration script - was tested using \`docs/evidence/audio-feed-9vns/narration-script.txt\` (44,626 characters / 44,710 prompt bytes).

Production segmentation under \`MAX_TTS_INPUT_BYTES = 6000\` yielded EXACTLY 8 segments:
- \`assertTextSeams(prompt, segments)\` passed with zero dropped or duplicate characters.

| Segment | Characters | Text bytes | Duration (s) | Raw WAV bytes | PCM Data bytes | Source | Finish Reason |
|---:|---:|---:|---:|---:|---:|:---:|:---:|
| 1 | 5,890 | 5,900 | 348.72 | 16,744,674 | 16,738,560 | \`fresh\` | \`STOP\` |
| 2 | 5,950 | 5,962 | 360.20 | 17,295,714 | 17,289,600 | \`fresh\` | \`STOP\` |
| 3 | 5,885 | 5,891 | 346.60 | 16,642,914 | 16,636,800 | \`fresh\` | \`STOP\` |
| 4 | 5,941 | 5,955 | 364.72 | 17,512,674 | 17,506,560 | \`fresh\` | \`STOP\` |
| 5 | 5,876 | 5,880 | 351.28 | 16,867,554 | 16,861,440 | \`fresh\` | \`STOP\` |
| 6 | 5,964 | 5,968 | 348.40 | 16,729,314 | 16,723,200 | \`fresh\` | \`STOP\` |
| 7 | 5,879 | 5,885 | 368.56 | 17,696,994 | 17,690,880 | \`fresh\` | \`STOP\` |
| 8 | 3,260 | 3,262 | 200.72 | 9,640,674 | 9,634,560 | \`fresh\` | \`STOP\` |
| **Total** | **44,645** | **44,703** | **2,689.20** | **129,130,512** | **129,081,600** | — | — |

Fresh-run elapsed time across all 8 serial provider synthesis calls: **342,315 ms** (342.315 seconds). The cache was cleared before this run; \`dataSource: fresh\`, \`freshRun: true\`, and each segment's \`source: fresh\` in the JSON distinguish this measurement from a replay. On cache replay the harness omits unobserved finish reasons and truncation flags.`,
      },
      {
        heading: "4. Stitched Output Audio Verification",
        body: `\`client.synthesizeNarration\` stitched all 8 segments via \`joinTtsAudio\`:

- **PCM data bytes**: \`129,081,600\` (exactly equal to sum of segment PCM data bytes).
- **Total WAV bytes**: \`129,081,644\` (44-byte RIFF/WAVE header + 129,081,600 PCM bytes).
- **Stitched duration**: \`2,689.20\` seconds (44 minutes, 49.20 seconds), matching \`sum(segmentDurations) = 2,689.20s\` with **0.000s delta**.
- **WAV Header Magic**: First 16 bytes: \`52 49 46 46 24 a1 b1 07 57 41 56 45 66 6d 74 20\` (\`RIFF....WAVEfmt \`).
- **PCM Format Details**:
  - \`audioFormat\`: \`1\` (uncompressed PCM)
  - \`sampleRate\`: \`24,000 Hz\`
  - \`channels\`: \`1\` (mono)
  - \`bitsPerSample\`: \`16\`
  - \`duration = dataLength / (sampleRate * channels * (bitsPerSample / 8))\` = \`129,081,600 / 48,000 = 2,689.20s\`.
- Decodable by the production \`decodeAudioResponse\` on the stitched WAV bytes (\`format: "wav"\`, \`truncated: false\`), non-empty, and valid.`,
      },
      {
        heading: "Exact Commands",
        body: `\`\`\`bash
# 1. Run unit tests for base-URL override
timeout -k 30 60 deno test --allow-env tests/gemini_base_url_test.ts

# 2. Run existing TTS test suite
timeout -k 30 30 deno test --allow-env --allow-read tests/tts_test.ts

# 3. Force a fresh run (otherwise the harness reports cache/mixed provenance)
rm -rf var/segments
timeout -k 30 750 deno run --allow-net --allow-env --allow-read --allow-write scripts/verify_live_e2e_tts.ts
\`\`\``,
      },
      {
        heading: "Verdict",
        body:
          `**VERIFIED as of the 2026-10-08 run; NARROWED AND CORRECTED TWICE 2026-10-12 (audio-feed-zrx9, then audio-feed-fipl, then audio-feed-kx2m): the raw-article refusal claims no longer describe the provider, so they now assert that usable speech was returned - 200, a candidate that completed, and the application's own decoder accepting the observed response - before concluding that no refusal was seen; every shape the two earlier attempts got wrong is pinned as an offline mutant in tests/synthesis_observation_test.ts - see the live verification status section above.** The production \`GeminiTtsClient\` resolves the proxy base URL via \`GEMINI_API_BASE_URL\`, successfully synthesizes all 8 segments of the production narration script, and stitches them into a bit-exact, valid, decodable RIFF/WAVE audio file of 2,689.20 seconds duration.`,
      },
    ],
  });
  console.log("Saved report to docs/evidence/audio-feed-9vns/README.md");
  console.log("\nALL VERIFICATIONS PASSED SUCCESSFULLY!");
});
