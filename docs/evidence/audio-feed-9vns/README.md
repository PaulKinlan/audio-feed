# audio-feed-9vns: Live End-to-End GeminiTtsClient Verification & 8-Segment Stitched Playback

- Script: scripts/verify_live_e2e_tts.ts
- Timeout: 600
- Asserts: GeminiTtsClient resolves baseUrl with /v1beta suffix; raw article prompt splits into 8
  segments under byte budget; raw article segment returns usable speech from the real client:
  decoded audio with finishReason STOP (audio-feed-zrx9, audio-feed-fipl, audio-feed-kx2m); provider
  returns usable speech for the raw article: status 200, candidate present, finishReason STOP,
  production decoder accepted it (audio-feed-zrx9, audio-feed-fipl, audio-feed-kx2m); narration
  prompt splits into 8 segments under byte budget; narration segments have seamless text boundaries;
  all 8 narration segments synthesized; captured segments are in narration order; stitched audio
  format is PCM; stitched audio is not marked as truncated; stitched WAV has valid length; stitched
  WAV has valid RIFF header; stitched WAV has valid WAVE format; production audio decoder accepts
  stitched WAV; WAV header specifies PCM audio format 1; WAV header specifies 24000 Hz sample rate;
  WAV header specifies 1 mono channel; WAV header specifies 16 bits per sample; WAV header has
  non-zero PCM data length; stitched duration matches sum of segment durations within 50ms; stitched
  PCM byte length matches sum of segment PCM bytes

## Run Provenance

Run against the live fleet proxy at `https://gemini.int.exe.xyz`. The timestamp, whether each
segment was fresh or cached, and all per-run quantities are recorded in the same-run
[`live-e2e-validation.json`](live-e2e-validation.json). The original verification was on 2026-10-08;
regenerated results must be read from their own JSON, not inferred from that date.

## Background & Scope

Follow-up to `audio-feed-u60a` (landed `commit-757ea14`). In `u60a`, live proxy controls, token
bounds, and single-segment excerpts were verified, but the production `GeminiTtsClient` could not be
tested end-to-end because:

1. `src/tts/gemini.ts` hardcoded
   `GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"`, forcing u60a to
   reimplement transport.
2. Full multi-segment synthesis (8 segments) and stitched audio assembly through
   `client.synthesizeNarration` remained unverified.

This verification addresses both gaps using the REAL production `GeminiTtsClient`.

## Live Verification Status & Provider Behavior (audio-feed-zrx9)

The two raw-article refusal claims were **narrowed on 2026-10-12**, after re-measuring the live
provider through the real production client. The record of why, so the narrowing can be judged
rather than trusted:

- **What changed**: the old claims were
  `negative control: raw article segment fails closed on real client` and
  `negative control: provider returns candidate finishReason OTHER`. Re-run on 2026-10-12, raw
  segment 1 returned candidate `finishReason: STOP` and the real client did **not** fail closed, so
  the claims no longer describe the provider.
- **Why this is not a silent deletion, and why the narrowing needed correcting twice**: the checks
  now require the invariant before concluding anything about a refusal - POSITIVE evidence that
  usable speech was received: a client call that returned decoded audio with `finishReason STOP`,
  and a direct provider response that production's own `decodeAudioResponse` accepted after
  answering 200 with a candidate that completed. The first narrowing asserted the refusal's absence
  directly, which review caught (`audio-feed-fipl`): `finishReason !== "OTHER"` is also true for an
  HTTP 500, an empty candidate list and a malformed body, so "we saw nothing" was indistinguishable
  from "there was nothing to see". The first positive form then measured an audio string instead of
  decoded audio, which review caught too (`audio-feed-kx2m`): a non-empty but undecodable payload
  passed while the application's decoder threw. The direct check now consults that decoder's verdict
  on the very response it observed. Every one of these shapes is pinned as an offline mutant in
  `tests/synthesis_observation_test.ts` and keeps the checks red.
- **What the app actually depends on** (the property that survives the narrowing): every paid call
  is segmented to `MAX_TTS_INPUT_BYTES` = 6,000 bytes, asserted here and inside
  `synthesizeNarration`; and a refused or part-less provider response must produce no audio rather
  than a published episode, which is kept as a deterministic control in
  `tests/tts_hardening_test.ts` ("a copyright-recitation refusal fails closed through the decoder")
  because the live provider can no longer be made to produce that shape on demand.
- **Not a product change**: `PRODUCT.md` specifies Direct Read of the full article text and the
  narration path has always sent the article body, segmented - the refusal was defence in depth
  against an unsegmented send, not a mechanism the pipeline relies on. If the operator treats
  provider-side recitation refusal as a compliance control rather than a backstop, that is a product
  decision above this script's pay grade and belongs on `audio-feed-zrx9`.
- **Execution bounds**: Fresh end-to-end synthesis of all 8 segments takes ~342 seconds and produces
  ~129MB of WAV audio, exceeding standard bounded test timeouts (`timeout -k 30 150` exits 124).

## 1. Base-URL Override & Unit Tests

- Modified `src/tts/gemini.ts` to introduce `getGeminiApiBaseUrl(override?)` and support
  `GEMINI_API_BASE_URL` env override while preserving the production literal
  `DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"` as the default.
- Added host-only URL normalization: passing `https://gemini.int.exe.xyz` appends `/v1beta` so
  `/models/...` paths resolve correctly on the proxy.
- Key handling remains untouched (`config.apiKey || envKey || ""`); the proxy injects
  `x-goog-api-key` server-side.
- Added focused unit tests in `tests/gemini_base_url_test.ts`:
  - Default literal constant preserved: `DEFAULT_GEMINI_API_BASE_URL` and `GEMINI_API_BASE_URL`
    equal `"https://generativelanguage.googleapis.com/v1beta"`.
  - Unset environment variable defaults to the Google API endpoint.
  - `GEMINI_API_BASE_URL` env variable properly overrides base URL and normalizes host-only URLs.
  - Explicit `config.baseUrl` takes precedence over environment variable.
  - `client.sendRequest` dispatches to the overridden base URL.

## 2. Raw Article Text: Provider Behavior After the 2026-10-12 Narrowing

The raw 47k-character article from `docs/evidence/audio-feed-gueb/article.txt` (Wikipedia "History
of the Internet") was segmented with production `splitTextUnderByteBudget(prompt, 6000)` into 8
segments (5,867 bytes in segment 1).

Exercising `client.sendRequest` on raw segment 1 **as it behaved on the 2026-10-08 run** failed
closed:

- Provider response: HTTP 200, `candidates[0].finishReason: "OTHER"`
- Candidate finishMessage:
  `"The generated content was filtered because it may contain material that resembles existing copyrighted works. ..."`
- Production client threw `GeminiTtsError: Gemini API candidate contained no content parts`.

**Re-measured 2026-10-12 (audio-feed-zrx9): the refusal no longer fires.** The same request returns
a normal completion through the real client. The checks above therefore assert the positive
observation - the application's own decoder accepted the response that was actually observed and
handed back audio - and only conclude from it that no refusal was seen; a returning refusal, a 500,
an empty candidate list, a malformed body and a non-empty payload the decoder cannot decode all keep
them red (mutants in `tests/synthesis_observation_test.ts`). The client-side fail-closed behaviour
that the old control was really protecting is verified deterministically against constructed refusal
responses in `tests/tts_hardening_test.ts` instead of depending on the live model to refuse on
demand.

## 3. Production Narration Script & 8-Segment Synthesis

Production segmentation under `MAX_TTS_INPUT_BYTES = 6000` yields eight segments, and
`assertTextSeams(prompt, segments)` checks for dropped or duplicate characters. Per-segment
characters, bytes, durations, PCM sizes, source and observed finish reasons are in the same-run
`live-e2e-validation.json`; generated audio sizes and durations are not fixed expectations. A fresh
run records `dataSource: fresh` and `freshRun: true` with `source: fresh` for each segment. On cache
replay the harness omits unobserved finish reasons and truncation flags; do not describe cached
bytes as newly synthesized audio.

## 4. Stitched Output Audio Verification

`client.synthesizeNarration` stitches eight segments via `joinTtsAudio`. The same-run
`live-e2e-validation.json` records PCM/WAV byte lengths, duration, summed segment duration, delta
and first 16 WAV header bytes. The proof checks that the stitched PCM byte length equals the sum of
segment PCM bytes and that its duration is within 50ms of the sum of segment durations, rather than
expecting the 2026-10-08 run's exact audio length.

It also checks RIFF/WAVE magic, uncompressed PCM format 1, 24,000 Hz mono 16-bit output, non-empty
data and acceptance by production `decodeAudioResponse` as non-truncated WAV.

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

**VERIFIED as of the 2026-10-08 run; NARROWED AND CORRECTED TWICE 2026-10-12 (audio-feed-zrx9, then
audio-feed-fipl, then audio-feed-kx2m): the raw-article refusal claims no longer describe the
provider, so they now assert that usable speech was returned - 200, a candidate that completed, and
the application's own decoder accepting the observed response - before concluding that no refusal
was seen; every shape the two earlier attempts got wrong is pinned as an offline mutant in
tests/synthesis_observation_test.ts - see the live verification status section above.** The
production `GeminiTtsClient` resolves the proxy base URL via `GEMINI_API_BASE_URL`, checks synthesis
of all eight narration segments and their stitching into a valid, decodable RIFF/WAVE file without
assuming an exact generated duration; the measured duration is in the same-run JSON, and pass/fail
status is in the proof assertions.
