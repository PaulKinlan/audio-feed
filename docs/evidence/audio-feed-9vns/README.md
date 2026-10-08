# audio-feed-9vns: Live End-to-End GeminiTtsClient Verification & 8-Segment Stitched Playback

Run on 2026-10-08 UTC against the live fleet proxy at `https://gemini.int.exe.xyz`.
Complete machine-readable results are recorded in [`live-e2e-validation.json`](live-e2e-validation.json).

## Background & Scope

Follow-up to `audio-feed-u60a` (landed `757ea14`). In `u60a`, live proxy controls, token bounds, and single-segment excerpts were verified, but the production `GeminiTtsClient` could not be tested end-to-end because:
1. `src/tts/gemini.ts` hardcoded `GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"`, forcing u60a to reimplement transport.
2. Full multi-segment synthesis (8 segments) and stitched audio assembly through `client.synthesizeNarration` remained unverified.

This verification addresses both gaps using the REAL production `GeminiTtsClient`.

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

## 2. Negative Control: Raw Article Recitation Filter

The raw 47k-character article from `docs/evidence/audio-feed-gueb/article.txt` (Wikipedia "History of the Internet") was segmented with production `splitTextUnderByteBudget(prompt, 6000)` into 8 segments (5,867 bytes in segment 1).

Exercising `client.sendRequest` on raw segment 1 failed closed:
- Provider response: HTTP 200, `candidates[0].finishReason: "OTHER"`
- Candidate finishMessage: `"The generated content was filtered because it may contain material that resembles existing copyrighted works. Try rephrasing the prompt. If you think this was an error, [send feedback](https://ai.google.dev/gemini-api/docs/troubleshooting)."`
- Production client threw `GeminiTtsError: Gemini API candidate contained no content parts`.
- Confirmed: raw verbatim Wikipedia text triggers the provider's copyright recitation filter, producing no audio.

## 3. Production Narration Script & 8-Segment Synthesis

As required when raw text hits the copyright recitation filter, the production input path—a generated narration script—was tested using `docs/evidence/audio-feed-9vns/narration-script.txt` (44,626 characters / 44,710 prompt bytes).

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

**VERIFIED.** The production `GeminiTtsClient` resolves the proxy base URL via `GEMINI_API_BASE_URL`, correctly triggers and fails closed on the copyright recitation filter for raw Wikipedia prose, successfully synthesizes all 8 segments of the production narration script, and stitches them into a bit-exact, valid, decodable RIFF/WAVE audio file of 2,689.20 seconds duration.
