# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security

- **Unbounded paid synthesis when no per-subscriber budget was configured (audio-feed-khk3)**: the
  daily episode ceiling was enforced only when a subscriber had a `dailyEpisodeBudget` of their own,
  so a subscriber without one — including the ones nobody had configured yet and any budget that the
  admin form failed to parse into a number — could be synthesised without limit for as long as
  episodes were queued. The ceiling now falls back to `DEFAULT_DAILY_EPISODE_BUDGET` (50 per
  subscriber per UTC day, settable; `0` means an unconfigured subscriber gets nothing), and there is
  no longer any value of the user record, the worker option or the environment that leaves a
  subscriber uncapped. Exceeding the ceiling still DEFERS rather than fails, so the episodes are
  served the next day. `GET /api/admin/stats` reports each subscriber's effective ceiling, its
  source, and `usersWithoutBudget`, and a subscriber held by the default logs one line per run.
- **Rate limits keyed on a header the caller controls (audio-feed-u2ve)**: with
  `TRUST_PROXY_HEADERS=1`, the client address used to key every rate limit came from the FIRST entry
  of `x-forwarded-for` — the entry a client supplies, since each hop appends to that header — so a
  caller could rotate the header, land in a fresh bucket every request, and never meet the bound.
  `cf-connecting-ip` was consulted before the chain as well, so a forged single-value header won
  even when the trusted hop had appended the real address. The key is now the LAST entry of the
  forwarded chain (the address the nearest hop appended, and the safe choice whether a proxy appends
  or replaces), with `cf-connecting-ip` only as a fallback when there is no chain, and any value too
  long to be an address falls back to the socket address rather than becoming an unbounded store
  key. Measured against a bound of 5: 20 requests with a rotating forged prefix were all allowed
  before, and exactly 5 are allowed now.

- **Host-injection hardening (audio-feed-fp4r)**: new `ALLOWED_HOSTS` environment variable
  (comma-separated). When set, the advertised origin — feed `selfUrl`, enclosure URLs, redirects,
  and the WebAuthn RP ID derived from it — can only ever be a listed host; requests arriving on any
  other host are answered `421 Misdirected Request`. Unset preserves the request-derived origin
  behaviour (safe on Deno Deploy, whose router validates Host).

### Fixed

- **TTS deadline brittleness (audio-feed-9yu8)**: The per-attempt synthesis deadline was 60s —
  inside the real 45-55s/segment distribution, and the 2026-10-09 incidents needed 59.8s for
  headers+body alone — and it was not settable. It is now 120s by default and settable with
  `TTS_TIMEOUT_MS`. A deadline abort is retried once per segment on its own budget (multi-segment
  episodes force `maxRetries: 0`, so a single slow segment used to end the whole episode), and the
  whole-episode wrapper no longer relabels our own abort as a provider-looking 400: a deadline
  surfaces status-less so the worker may retry the episode, while provider verdicts and truncations
  are explicitly permanent so the re-billing guard is unchanged.
- **TTS input pre-check unit (audio-feed-y98q)**: The synthesis worker's pre-spend input guard
  counted UTF-16 code units while the TTS budget it approximates is in UTF-8 bytes, so non-Latin
  articles passed the check and then hard-failed inside the client at the 12-segment cap — after the
  episode had been claimed. The guard is now `maxInputBytes` and measures UTF-8 bytes, and its error
  message reports real byte counts.

### Removed

- **Chapter markers specification (audio-feed-bqt)**: Removed the unproduced `Chapter` type,
  `Episode.chapters`, `FeedEpisode.chaptersUrl`, and `<podcast:chapters>` RSS emitter. Gemini 3.8
  Flash TTS outputs direct stream audio without alignment timestamps; advertising chapter URLs that
  404 broke the Podcast 2.0 specification for podcast players.
