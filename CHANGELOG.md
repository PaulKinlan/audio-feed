# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security

- **Host-injection hardening (audio-feed-fp4r)**: new `ALLOWED_HOSTS` environment variable
  (comma-separated). When set, the advertised origin — feed `selfUrl`, enclosure URLs, redirects,
  and the WebAuthn RP ID derived from it — can only ever be a listed host; requests arriving on any
  other host are answered `421 Misdirected Request`. Unset preserves the request-derived origin
  behaviour (safe on Deno Deploy, whose router validates Host).

### Fixed
- **TTS deadline brittleness (audio-feed-9yu8)**: The per-attempt synthesis deadline was 60s — inside the real 45-55s/segment distribution, and the 2026-10-09 incidents needed 59.8s for headers+body alone — and it was not settable. It is now 120s by default and settable with `TTS_TIMEOUT_MS`. A deadline abort is retried once per segment on its own budget (multi-segment episodes force `maxRetries: 0`, so a single slow segment used to end the whole episode), and the whole-episode wrapper no longer relabels our own abort as a provider-looking 400: a deadline surfaces status-less so the worker may retry the episode, while provider verdicts and truncations are explicitly permanent so the re-billing guard is unchanged.
- **TTS input pre-check unit (audio-feed-y98q)**: The synthesis worker's pre-spend input guard counted UTF-16 code units while the TTS budget it approximates is in UTF-8 bytes, so non-Latin articles passed the check and then hard-failed inside the client at the 12-segment cap — after the episode had been claimed. The guard is now `maxInputBytes` and measures UTF-8 bytes, and its error message reports real byte counts.

### Removed

- **Chapter markers specification (audio-feed-bqt)**: Removed the unproduced `Chapter` type,
  `Episode.chapters`, `FeedEpisode.chaptersUrl`, and `<podcast:chapters>` RSS emitter. Gemini 3.8
  Flash TTS outputs direct stream audio without alignment timestamps; advertising chapter URLs that
  404 broke the Podcast 2.0 specification for podcast players.
