# URL ingest acceptance — 2026-09-24

Author drive, not independent review. Runtime: local Deno 2.9.0, V8 14.9; Chrome via DevTools MCP.
Source: `audiofeed/astra-by7`, based on shared-contract commit `6f94558`. Tests and the browser
harness are committed beside the implementation.

## Automated checks

- `deno test --allow-read=tests/fixtures --allow-net=127.0.0.1 tests/ingest_test.ts`: **23 passed, 0
  failed**, serial; no external network or credentials. Includes actual Node HTTP socket lookup
  acceptance/refusal, mixed public/private DNS answers, IPv4/IPv6 special ranges, redirects, bounded
  bodies, cancellation, clean extraction, direct/deep-dive input, approval refusal and queue
  failure.
- `deno lint`: pass across this branch.
- `deno task check`: pass across this branch.
- Formatting of changed files: pass. Whole-repository `deno fmt --check`: **fails** on five
  unchanged baseline files: `AGENTS.md`, `CLAUDE.md`, `PRODUCT.md`, `.claude/settings.json`,
  `.agents/skills/beads/SKILL.md`. This is not an all-green repository gate. Reported to the
  scaffold owner rather than silently changing shared instructions.
- No full-suite launch under machine saturation: the last load reading was 68.06 / **43.58** / 31.87
  on the 32-core host. The targeted file above is the only test suite present on this candidate
  base; subsequent integration tests are not covered by that count.

## Browser drive

Started `tests/ingest_browser.ts` on an ephemeral loopback port. The page prominently states that
users and queue are fixtures. No API keys, persistent stores, paid synthesis or production resources
were used.

Observed on the final restarted handler:

| Action                                                                         | Observed outcome                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Click Send to Audio for `https://deno.com/blog/v2.0` with Approved + Full read | `202`, real HTTPS fetch, title `Announcing Deno 2`, publication date `2024-10-09T09:00:00.000Z`, **17,042 body characters**, full lead present intact in body, concluding section present; one fixture job |
| Submit fixture article with Approved + Full read                               | `202`, complete 711-character fixture body, title/author/date/lead, ad/paywall/navigation text absent                                                                                                      |
| Submit fixture article with Approved + Deep dive                               | `202`, mode `deepdive`, complete source body preserved                                                                                                                                                     |
| Submit fixture article with Pending                                            | `403`; job count unchanged                                                                                                                                                                                 |
| Submit metadata URL `http://169.254.169.254/latest/meta-data/` with Approved   | `400`; job count unchanged                                                                                                                                                                                 |

Positive and negative cases were asserted in-browser, not inferred from status codes alone. After
the real article plus two allowed fixture submissions, the queue held exactly three jobs; the two
refused submissions added none.

Screenshots of successful fixture submission, pending-user refusal and final real-article extraction
were captured as inline DevTools tool attachments in the author session. **Filesystem screenshot
export was denied by the MCP workspace allowlist**, both for the worktree and journal paths. No
saved screenshot files are claimed here; the committed harness lets the reviewer reproduce the view
independently.

## Defects caught during the drive

The first real article exposed source HTML newlines being converted into paragraph breaks. Fixed by
normalizing whitespace inside text nodes while retaining structural block breaks. A subsequent naive
headline fallback selected an internal `h1` (`LTS`) instead of the article title; removed that
fallback and kept Readability's metadata title, trimming a site suffix only when an extracted
heading agrees. Both have regression tests. The final server was restarted before the successful
observations above.

## Limits

Deno Deploy runtime compatibility, remote IPv6 connectivity, production authentication, durable
queue integration, audio synthesis and playback remain **unverified by this change**. Address policy
is unit-tested for IPv6; socket behavior was driven locally over IPv4/HTTPS. The queue/auth hooks
must be wired by the application and hosted transport checks must pass before production use.
Extractor heuristics cannot guarantee every publisher layout or completeness of a paywalled excerpt.
