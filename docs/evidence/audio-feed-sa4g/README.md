# audio-feed-sa4g — narration extraction: hero figcaption and URL slugs

- Capture: no assertions
- Reason: Static before/after dumps of article text extraction (before.txt, after.txt), vendored HTML fixture (article.html), and local capture helper (capture.ts). Behavioral properties and regressions are asserted in tests/ingest_test.ts, not by an automated evidence runner script.

Historical evidence capture for narration extraction UX fixes in `src/ingest/url.ts` (`extractArticle` and `plainText`). Before the fix, hero video URL fallback text and figure captions were narrated at the opening of an article, and URL path slugs were spelled out character-by-character; after the fix, narration opens with the article's first substantive paragraph and bare-URL text is excluded from spoken audio.

Captured via `capture.ts` using vendored HTML from `https://www.bram.us/2026/09/23/show-keystrokes/` (`article.html`). Ongoing regression coverage is enforced in `tests/ingest_test.ts`.
