# audio-feed-u60a: bounded live Gemini TTS verification

Run on 2026-10-08 UTC: `timeout -k 30 300 deno run -A scripts/verify_live_tts.ts`. The **complete actual script output** is [`live-validation.json`](live-validation.json). Each provider fetch has an AbortSignal timeout (20 seconds for metadata/counts, 120 seconds for synthesis controls). The fleet proxy at `https://gemini.int.exe.xyz/v1beta` appends the API path and injects the key server-side; no credential is stored or transmitted by this script.

## Transport and scope

The harness **reimplements HTTP transport against the proxy** rather than invoking `GeminiTtsClient.sendRequest`, whose production default remains `https://generativelanguage.googleapis.com/v1beta` and requires `x-goog-api-key`. It uses production `formatNarrationPrompt`, `splitTextUnderByteBudget`, `buildSingleVoiceRequest`, `parseWavHeader`, and `decodeAudioResponse`. Thus the provider/model behavior, production segmentation, request construction, and decoder are measured, but production auth, retries, and full end-to-end multi-segment synthesis/stitching are **not** live-verified here. The positive call synthesizes only an article excerpt, not all eight segments; listening quality is not assessed.

## Model and controls

`models/gemini-3.8-flash-tts` returned an 8,192 input-token limit, 16,384 output-token limit, and `generateContent`, `countTokens`, `batchGenerateContent` methods. Unsegmented controls use the same proxy/model:

| Input | Measured tokens | HTTP | Result |
|---|---:|---:|---|
| Repeated synthetic sentence | 15,001 | 400 | `INVALID_ARGUMENT`: `The input token count exceeds the maximum number of tokens allowed (8192).` |
| Raw article preceded by `"Please narrate the following article clearly and naturally. "` repeated 70 times plus two newlines | 11,208 | 400 | Same limit error |
| Raw article alone | 10,506 | 200 | `OTHER`, copyright-resemblance filter, no audio; production `decodeAudioResponse` throws |

The previous ad-hoc expanded-preamble result was **11,207** tokens; the committed, explicitly constructed preamble measured **11,208** on this run. The raw article's 10,506 tokens differ from the formatted production prompt's 10,512 because the latter includes the narration intro. Both distinctions are preserved rather than labelling unlike inputs with the same count.

**Enforcement anomaly:** The published cap and 400 error both say 8,192, yet this raw 10,506-token request returned HTTP 200 with *no usable audio* due to copyright filtering, while the 11,208-token expanded request returned 400. This does not establish an acceptance threshold, or successful generation above the cap. The production 6,000-byte budget stays below the declared cap for all measured segments.

## Article segmentation and positive audio

The source `docs/evidence/audio-feed-gueb/article.txt` has **47,000 characters / 47,018 UTF-8 bytes**. `formatNarrationPrompt({ title: "History of the Internet", body: article })` yields 47,044 bytes and 10,512 provider-counted tokens. Production segmentation yields eight chunks under the 6,000-byte budget:

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

The largest segment is 1,372 tokens (16.75% of the published input cap), matching the earlier mock-exact 8-chunk prediction. The positive request uses `buildSingleVoiceRequest` with Charon, temperature 0.7 and `maxOutputTokens: 16384` over the **first two paragraphs of article.txt** (1,097 characters / bytes), not the former 78-character smoke text. Observed HTTP 200, `STOP`, model version `gemini-3.8-flash-tts`, usage **215 text prompt tokens + 1,568 audio candidate tokens = 1,783 total**. The returned `audio/wav` base64 is 4,022,232 characters; decoded WAV is 3,016,674 bytes with first 16 header bytes `52 49 46 46 da 07 2e 00 57 41 56 45 66 6d 74 20`. Both RIFF and WAVE bytes are checked; PCM WAV header parsing confirmed **24,000 Hz, mono, 16-bit, 3,010,560 data bytes**, yielding **62.72 seconds** from the declared PCM rate. The production decoder also accepted it as non-truncated WAV. Generated audio token count/byte length can vary on a future rerun; these are observations from the committed output, not deterministic assertions.

## Verdict

**VERIFIED for bounded proxy/provider segmentation, controls and excerpt audio; production-client end-to-end and eight-segment playback UNVERIFIED.** The harness enforces expected HTTP/filter behavior and real WAV validity, but not byte-for-byte identity of future generated audio.
