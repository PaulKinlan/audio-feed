# audio-feed-u60a: bounded live Gemini TTS verification

- Script: scripts/verify_live_tts.ts
- Asserts: model metadata returns 8192 input token limit and 16384 output limit; production prompt splits into 8 segments under 6000-byte budget; every segment stays within MAX_TTS_INPUT_BYTES budget; negative control: synthetic repeated sentence exceeds input token limit (400); negative control: article with expanded preamble exceeds input token limit (400); raw unsegmented article returns usable speech: 200, candidate, STOP, non-empty audio (audio-feed-zrx9 narrowing, audio-feed-fipl); positive synthesis returns HTTP 200 with STOP finishReason; positive synthesis returns audio/wav inline data; positive audio contains valid RIFF header; positive audio contains valid WAVE format; positive audio WAV header matches 24000Hz 16-bit mono PCM format; positive audio duration matches PCM data length calculation; production audio decoder accepts generated WAV as non-truncated

## Artifact Provenance
Run on 2026-10-08 UTC: `timeout -k 30 300 deno run -A scripts/verify_live_tts.ts`. The **complete actual script output** is [`live-validation.json`](live-validation.json). Each provider fetch has an AbortSignal timeout (20 seconds for metadata/counts, 120 seconds for synthesis controls). The fleet proxy at `https://gemini.int.exe.xyz/v1beta` appends the API path and injects the key server-side; no credential is stored or transmitted by this script.

The `live-validation.json` artifact in this directory was captured by hand from script stdout during the original verification pass, while the claims declared above are programmatically verified by `scripts/verify_live_tts.ts`.

## Live Verification Status & Provider Behavior (audio-feed-zrx9)
The raw-article refusal control was **narrowed on 2026-10-12**, after re-measuring the live provider. What follows is the record of why, so the narrowing can be judged rather than trusted:
- **What changed**: the old claim was `negative control: raw unsegmented article triggers copyright filter (200 OTHER)`. It required HTTP 200 + `finishReason: "OTHER"` + a `finishMessage` naming copyrighted works + no audio. Re-run on 2026-10-12 the same 10,506-token input returned **HTTP 200, `finishReason: STOP`, and ordinary audio** (`failClosed=false`), so the claim no longer describes the provider.
- **Why this is not a silent deletion, and why the first narrowing needed correcting**: the narrow claim is that the provider returns usable speech for the raw article (`status 200` + at least one candidate + `finishReason STOP` + non-empty audio), and the refusal's absence is concluded only AFTER that shape is observed. The first narrowing asserted the refusal's absence directly, which review caught as a defect (`audio-feed-fipl`): `finishReason !== "OTHER"` is also true for an HTTP 500, an empty candidate list and a malformed body, so "we saw nothing" was indistinguishable from "there was nothing to see". Those three shapes, plus a genuine `OTHER` refusal and a `STOP` candidate with no audio, are pinned as offline mutants in `tests/synthesis_observation_test.ts`, and every one of them keeps the control red. The two token-cap controls above are unchanged and still fail on over-cap inputs.
- **What the app actually depends on** (so the property survives the narrowing): (1) every paid call is segmented to `MAX_TTS_INPUT_BYTES` = 6,000 bytes — asserted above for all eight production segments and enforced again inside `synthesizeNarration`; and (2) a refused or part-less provider response must produce no audio rather than a published episode, which `decodeAudioResponse` enforces and which is kept as a deterministic control in `tests/tts_hardening_test.ts` ("a copyright-recitation refusal fails closed through the decoder") because the live provider can no longer be made to produce that shape on demand.
- **Not a product change**: `PRODUCT.md` specifies Direct Read of the full article text and `src/worker/synthesis.ts` has always sent the article body, segmented - the refusal was defence in depth against an unsegmented send, not a mechanism the pipeline relies on. If the operator treats provider-side recitation refusal as a compliance control rather than a backstop, that is a product decision above this script's pay grade and belongs on `audio-feed-zrx9`.

## Transport and scope
The harness **reimplements HTTP transport against the proxy** rather than invoking `GeminiTtsClient.sendRequest`, whose production default remains `https://generativelanguage.googleapis.com/v1beta` and requires `x-goog-api-key`. It uses production `formatNarrationPrompt`, `splitTextUnderByteBudget`, `buildSingleVoiceRequest`, `parseWavHeader`, and `decodeAudioResponse`. Thus the provider/model behavior, production segmentation, request construction, and decoder are measured, but production auth, retries, and full end-to-end multi-segment synthesis/stitching are **not** live-verified here. The positive call synthesizes only an article excerpt, not all eight segments; listening quality is not assessed.

## Model and controls
`models/gemini-3.8-flash-tts` returned an 8,192 input-token limit, 16,384 output-token limit, and `generateContent`, `countTokens`, `batchGenerateContent` methods. Unsegmented controls use the same proxy/model:

| Input | Measured tokens | HTTP | Result |
|---|---:|---:|---|
| Repeated synthetic sentence | 15,001 | 400 | `INVALID_ARGUMENT`: `The input token count exceeds the maximum number of tokens allowed (8192).` |
| Raw article preceded by `"Please narrate the following article clearly and naturally. "` repeated 70 times plus two newlines | 11,208 | 400 | Same limit error |
| Raw article alone | 10,506 | 200 | No refusal since 2026-10-12: `finishReason STOP` with audio (before that date: `OTHER`, copyright-resemblance filter, no audio). See the narrowing note above. |

The previous ad-hoc expanded-preamble result was **11,207** tokens; the committed, explicitly constructed preamble measured **11,208** on the 2026-10-08 run. The raw article's 10,506 tokens differ from the formatted production prompt's 10,512 because the latter includes the narration intro. Both distinctions are preserved rather than labelling unlike inputs with the same count.

**Enforcement anomaly (re-measured 2026-10-12):** the published cap and the 400 error both say 8,192, yet the raw 10,506-token request returned HTTP 200 — now with *audio*, where on 2026-10-08 it returned 200 with no audio. So the cap has never been a reliable backstop for an accidentally unsegmented send, on either side of this change: the 11,208-token expanded request is refused, the 10,506-token raw article is not. Production safety here comes from `splitTextUnderByteBudget` keeping every paid call at or under the 6,000-byte budget (asserted above), not from the provider refusing large inputs.

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
**VERIFIED as of the 2026-10-08 run (bounded proxy/provider segmentation, controls and excerpt audio; production-client end-to-end and eight-segment playback UNVERIFIED); NARROWED 2026-10-12 AND CORRECTED THE SAME DAY (audio-feed-fipl): the raw-article refusal control no longer describes the provider, so the claim is now that the call returned usable speech (status 200, candidate, finishReason STOP, non-empty audio) and only then that no refusal was seen; the unguarded shapes a bare absence check accepted are pinned as mutants in tests/synthesis_observation_test.ts — see the live verification status section above.** The harness enforces expected HTTP/filter behavior as observed on that run and real WAV validity, but not byte-for-byte identity of future generated audio.
