# audio-feed-9vns: Live End-to-End GeminiTtsClient Verification & 8-Segment Stitched Playback

- Script: scripts/verify_live_e2e_tts.ts
- Asserts: GeminiTtsClient resolves baseUrl with /v1beta suffix; raw article prompt splits into 8 segments under byte budget; raw article segment is NOT refused by the provider (real client does not fail closed; audio-feed-zrx9 narrowing); provider does not return candidate finishReason OTHER for the raw article (audio-feed-zrx9 narrowing); narration prompt splits into 8 segments under byte budget; narration segments have seamless text boundaries; all 8 narration segments synthesized; captured segments are in narration order; stitched audio format is PCM; stitched audio is not marked as truncated; stitched WAV has valid length; stitched WAV has valid RIFF header; stitched WAV has valid WAVE format; production audio decoder accepts stitched WAV; WAV header specifies PCM audio format 1; WAV header specifies 24000 Hz sample rate; WAV header specifies 1 mono channel; WAV header specifies 16 bits per sample; WAV header has non-zero PCM data length; stitched duration matches sum of segment durations within 50ms; stitched PCM byte length matches sum of segment PCM bytes

## Run Provenance
Run on 2026-10-08 UTC against the live fleet proxy at `https://gemini.int.exe.xyz`.
Complete machine-readable results are recorded in [`live-e2e-validation.json`](live-e2e-validation.json).

## Background & Scope
Follow-up to `audio-feed-u60a` (landed `commit-757ea14`). In `u60a`, live proxy controls, token bounds, and single-segment excerpts were verified, but the production `GeminiTtsClient` could not be tested end-to-end because:
1. `src/tts/gemini.ts` hardcoded `GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"`, forcing u60a to reimplement transport.
2. Full multi-segment synthesis (8 segments) and stitched audio assembly through `client.synthesizeNarration` remained unverified.

This verification addresses both gaps using the REAL production `GeminiTtsClient`.

## Live Verification Status & Provider Behavior (audio-feed-zrx9)
The two raw-article refusal claims were **narrowed on 2026-10-12**, after re-measuring the live provider through the real production client. The record of why, so the narrowing can be judged rather than trusted:
- **What changed**: the old claims were `negative control: raw article segment fails closed on real client` and `negative control: provider returns candidate finishReason OTHER`. Re-run on 2026-10-12, raw segment 1 returned candidate `finishReason: STOP` and the real client did **not** fail closed, so the claims no longer describe the provider.
- **Why this is not a silent deletion**: the narrowed claims assert the refusal's ABSENCE through the same real client, and they **fail if the refusal comes back** - a future run returning `OTHER` (and a client that fails closed on it) turns them red and prints the finishReason and error in the failure detail.
- **What the app actually depends on** (the property that survives the narrowing): every paid call is segmented to `MAX_TTS_INPUT_BYTES` = 6,000 bytes, asserted here and inside `synthesizeNarration`; and a refused or part-less provider response must produce no audio rather than a published episode, which is kept as a deterministic control in `tests/tts_hardening_test.ts` ("a copyright-recitation refusal fails closed through the decoder") because the live provider can no longer be made to produce that shape on demand.
- **Not a product change**: `PRODUCT.md` specifies Direct Read of the full article text and the narration path has always sent the article body, segmented - the refusal was defence in depth against an unsegmented send, not a mechanism the pipeline relies on. If the operator treats provider-side recitation refusal as a compliance control rather than a backstop, that is a product decision above this script's pay grade and belongs on `audio-feed-zrx9`.
- **Execution bounds**: Fresh end-to-end synthesis of all 8 segments takes ~342 seconds and produces ~129MB of WAV audio, exceeding standard bounded test timeouts (`timeout -k 30 150` exits 124).

## 1. Base-URL Override & Unit Tests
- Modified `src/tts/gemini.ts` to introduce `getGeminiApiBaseUrl(override?)` and support `GEMINI_API_BASE_URL` env override while preserving the production literal `DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"` as the default.
- Added host-only URL normalization: passing `https://gemini.int.exe.xyz` appends `/v1beta` so `/models/...` paths resolve correctly on the proxy.
- Key handling remains untouched (`config.apiKey || envKey || ""`); the proxy injects `x-goog-api-key` server-side.
- Added focused unit tests in `tests/gemini_base_url_test.ts`:
  - Default literal constant preserved: `DEFAULT_GEMINI_API_BASE_URL` and `GEMINI_API_BASE_URL` equal `"https://generativelanguage.googleapis.com/v1beta"`.
  - Unset environment variable defaults to the Google API endpoint.
  - `GEMINI_API_BASE_URL` env variable properly overrides base URL and normalizes host-only URLs.
  - Explicit `config.baseUrl` takes precedence over environment variable.
  - `client.sendRequest` dispatches to the overridden base URL.

## 2. Raw Article Text: Provider Behavior After the 2026-10-12 Narrowing
The raw 47k-character article from `docs/evidence/audio-feed-gueb/article.txt` (Wikipedia "History of the Internet") was segmented with production `splitTextUnderByteBudget(prompt, 6000)` into 8 segments (5,867 bytes in segment 1).

Exercising `client.sendRequest` on raw segment 1 **as it behaved on the 2026-10-08 run** failed closed:
- Provider response: HTTP 200, `candidates[0].finishReason: "OTHER"`
- Candidate finishMessage: `"The generated content was filtered because it may contain material that resembles existing copyrighted works. ..."`
- Production client threw `GeminiTtsError: Gemini API candidate contained no content parts`.

**Re-measured 2026-10-12 (audio-feed-zrx9): the refusal no longer fires.** The same request returns a normal completion through the real client - the checks above now assert that absence, and they turn red if the refusal returns. The client-side fail-closed behaviour that the old control was really protecting is verified deterministically against constructed refusal responses in `tests/tts_hardening_test.ts` instead of depending on the live model to refuse on demand.

## 3. Production Narration Script & 8-Segment Synthesis
The production input path - a generated narration script - was tested using `docs/evidence/audio-feed-9vns/narration-script.txt` (44,626 characters / 44,710 prompt bytes).

Production segmentation under `MAX_TTS_INPUT_BYTES = 6000` yielded EXACTLY 8 segments:
- `assertTextSeams(prompt, segments)` passed with zero dropped or duplicate characters.

| Segment | Characters | Text bytes | Duration (s) | Raw WAV bytes | PCM Data bytes | Source | Finish Reason |
|---:|---:|---:|---:|---:|---:|:---:|:---:|
| 1 | 5,890 | 5,900 | 348.72 | 16,744,674 | 16,738,560 | `fresh` | `STOP` |
| 2 | 5,950 | 5,962 | 360.20 | 17,295,714 | 17,289,600 | `fresh` | `STOP` |
| 3 | 5,885 | 5,891 | 346.60 | 16,642,914 | 16,636,800 | `fresh` | `STOP` |
| 4 | 5,941 | 5,955 | 364.72 | 17,512,674 | 17,506,560 | `fresh` | `STOP` |
| 5 | 5,876 | 5,880 | 351.28 | 16,867,554 | 16,861,440 | `fresh` | `STOP` |
| 6 | 5,964 | 5,968 | 348.40 | 16,729,314 | 16,723,200 | `fresh` | `STOP` |
| 7 | 5,879 | 5,885 | 368.56 | 17,696,994 | 17,690,880 | `fresh` | `STOP` |
| 8 | 3,260 | 3,262 | 200.72 | 9,640,674 | 9,634,560 | `fresh` | `STOP` |
| **Total** | **44,645** | **44,703** | **2,689.20** | **129,130,512** | **129,081,600** | — | — |

Fresh-run elapsed time across all 8 serial provider synthesis calls: **342,315 ms** (342.315 seconds). The cache was cleared before this run; `dataSource: fresh`, `freshRun: true`, and each segment's `source: fresh` in the JSON distinguish this measurement from a replay. On cache replay the harness omits unobserved finish reasons and truncation flags.

## 4. Stitched Output Audio Verification
`client.synthesizeNarration` stitched all 8 segments via `joinTtsAudio`:

- **PCM data bytes**: `129,081,600` (exactly equal to sum of segment PCM data bytes).
- **Total WAV bytes**: `129,081,644` (44-byte RIFF/WAVE header + 129,081,600 PCM bytes).
- **Stitched duration**: `2,689.20` seconds (44 minutes, 49.20 seconds), matching `sum(segmentDurations) = 2,689.20s` with **0.000s delta**.
- **WAV Header Magic**: First 16 bytes: `52 49 46 46 24 a1 b1 07 57 41 56 45 66 6d 74 20` (`RIFF....WAVEfmt `).
- **PCM Format Details**:
  - `audioFormat`: `1` (uncompressed PCM)
  - `sampleRate`: `24,000 Hz`
  - `channels`: `1` (mono)
  - `bitsPerSample`: `16`
  - `duration = dataLength / (sampleRate * channels * (bitsPerSample / 8))` = `129,081,600 / 48,000 = 2,689.20s`.
- Decodable by the production `decodeAudioResponse` on the stitched WAV bytes (`format: "wav"`, `truncated: false`), non-empty, and valid.

## Exact Commands
```bash
# 1. Run unit tests for base-URL override
timeout -k 30 60 deno test --allow-env tests/gemini_base_url_test.ts

# 2. Run existing TTS test suite
timeout -k 30 30 deno test --allow-env --allow-read tests/tts_test.ts

# 3. Force a fresh run (otherwise the harness reports cache/mixed provenance)
rm -rf var/segments
timeout -k 30 750 deno run --allow-net --allow-env --allow-read --allow-write scripts/verify_live_e2e_tts.ts
```

## Verdict
**VERIFIED as of the 2026-10-08 run; NARROWED 2026-10-12: the raw-article refusal claims no longer describe the provider and are now asserted as its absence, which still fails if the refusal returns - see the live verification status section above.** The production `GeminiTtsClient` resolves the proxy base URL via `GEMINI_API_BASE_URL`, successfully synthesizes all 8 segments of the production narration script, and stitches them into a bit-exact, valid, decodable RIFF/WAVE audio file of 2,689.20 seconds duration.
