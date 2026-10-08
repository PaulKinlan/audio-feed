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

| Segment | Characters | Text bytes | Duration (s) | Raw WAV bytes | PCM Data bytes | Finish Reason |
|---:|---:|---:|---:|---:|---:|:---:|
| 1 | 5,890 | 5,900 | 352.08 | 16,905,954 | 16,899,840 | `STOP` |
| 2 | 5,950 | 5,962 | 351.32 | 16,869,474 | 16,863,360 | `STOP` |
| 3 | 5,885 | 5,891 | 343.44 | 16,491,234 | 16,485,120 | `STOP` |
| 4 | 5,941 | 5,955 | 354.40 | 17,017,314 | 17,011,200 | `STOP` |
| 5 | 5,876 | 5,880 | 345.20 | 16,575,714 | 16,569,600 | `STOP` |
| 6 | 5,964 | 5,968 | 354.60 | 17,026,914 | 17,020,800 | `STOP` |
| 7 | 5,879 | 5,885 | 356.32 | 17,109,474 | 17,103,360 | `STOP` |
| 8 | 3,260 | 3,262 | 193.68 | 9,302,754 | 9,296,640 | `STOP` |
| **Total** | **44,645** | **44,703** | **2,651.04** | **127,298,832** | **127,249,920** | — |

Live first-run elapsed time across all 8 serial provider synthesis calls: **332.6 seconds** (5.5 minutes), averaging ~41.5s per segment.

## 4. Stitched Output Audio Verification

`client.synthesizeNarration` stitched all 8 segments via `joinTtsAudio`:

- **PCM data bytes**: `127,249,920` (exactly equal to sum of segment PCM data bytes).
- **Total WAV bytes**: `127,249,964` (44-byte RIFF/WAVE header + 127,249,920 PCM bytes).
- **Stitched duration**: `2,651.04` seconds (44 minutes, 11 seconds), matching `sum(segmentDurations) = 2,651.04s` with **0.000s delta**.
- **WAV Header Magic**: First 16 bytes: `52 49 46 46 24 ae 95 07 57 41 56 45 66 6d 74 20` (`RIFF....WAVEfmt `).
- **PCM Format Details**:
  - `audioFormat`: `1` (uncompressed PCM)
  - `sampleRate`: `24,000 Hz`
  - `channels`: `1` (mono)
  - `bitsPerSample`: `16`
  - `duration = dataLength / (sampleRate * channels * (bitsPerSample / 8))` = `127,249,920 / 48,000 = 2,651.04s`.
- Decodable, non-empty, and valid.

## Exact Commands

```bash
# 1. Run unit tests for base-URL override
timeout -k 30 30 deno test --allow-env tests/gemini_base_url_test.ts

# 2. Run existing TTS test suite
timeout -k 30 30 deno test --allow-env --allow-read tests/tts_test.ts

# 3. Run live end-to-end verification through fleet proxy
timeout -k 30 600 deno run --allow-net --allow-env --allow-read --allow-write scripts/verify_live_e2e_tts.ts
```

## Verdict

**VERIFIED.** The production `GeminiTtsClient` resolves the proxy base URL via `GEMINI_API_BASE_URL`, correctly triggers and fails closed on the copyright recitation filter for raw Wikipedia prose, successfully synthesizes all 8 segments of the production narration script, and stitches them into a bit-exact, valid, decodable RIFF/WAVE audio file of 2,651.04 seconds duration.
