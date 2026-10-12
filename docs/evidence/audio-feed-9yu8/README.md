# Evidence: audio-feed-9yu8

- Script: scripts/repro_tts_brittleness_9yu8.ts
- Asserts: production defaults synthesize narration successfully within deadline; forced timeout retries once on default policy; timeout error surfaces as transient without provider HTTP status; forced timeout with retryOn none makes exactly one HTTP attempt; provider model rejection preserves provider 404 status and marks failure permanent; loadConfig respects TTS_TIMEOUT_MS environment override

## Verification Overview
Live verification for audio-feed-9yu8 — the brittleness behind the incident (audio-feed-bp6r):
a 60s per-attempt deadline inside the real latency distribution, a deadline abort that was never retried
per segment, and a wrapper that relabelled our own abort as a provider-looking 400.

1. **Happy Path**: One real narration through the production client with 120s default deadline and default retry policy completes within deadline.
2. **Deadline Retry**: Multi-segment input with forced 1.5s deadline retries once on default policy and surfaces as transient.
3. **Opt-Out**: Same forced deadline with retryOn: "none" makes exactly 1 HTTP call.
4. **Permanent Rejection**: Live provider rejection (non-existent model) preserves provider 404 status and marks permanent: true.
5. **Configuration**: loadConfig resolves TTS_TIMEOUT_MS environment override with 120s default fallback.
