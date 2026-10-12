# audio-feed-ldsb — strip byline chrome from narration intro

- Capture: no assertions
- Reason: Static before/after dumps of byline extraction and opening narration on vendored fixture article.html, with local capture helper (capture.ts). Behavioral properties are asserted in tests/ingest_test.ts, not by an automated evidence runner script.

Historical evidence capture for byline chrome stripping in `src/ingest/url.ts` (`cleanBylineName`). Before the fix, Readability's byline on bram.us produced `By Published by Bramus!.` in direct narration; after the fix, it produces `By Bramus.`.

Captured via `capture.ts` using vendored HTML from `docs/evidence/audio-feed-sa4g/article.html`. Ongoing regression coverage is enforced in `tests/ingest_test.ts`.
