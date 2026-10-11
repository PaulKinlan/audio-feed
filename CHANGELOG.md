# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **An admin observability page: failures and job state without copying anything out
  (audio-feed-n6uu)**: `GET /admin/observability`, behind the existing admin gate (session plus
  `isActiveAdmin` — `ADMIN_TOKEN` unchanged as the passkey bootstrap token), rendering recent
  failures from the obs-2 log store with the PER-ATTEMPT claim history Paul needed: each attempt's
  worker id, start, last heartbeat, the phase chain it reached, the lease expiry, and whether the
  attempt ended with a TERMINAL WRITE or the lease simply expired with nobody writing — the siv1
  distinction that a bare "failed" cannot express. Also the queue's live state (claimable depth,
  oldest waiting episode, live claims, abandonments, and a draining/stalled verdict with its rule
  stated), the episode record's accumulated error, and the correlation id per failure. Read-only in
  v1 and every read is durable and in-process (log store, episode records, queue, run history), so
  the page renders while the thing it reports on is broken. Claim-start records now also carry the
  owner, lease and max-claims in their context — the episode only persists the CURRENT claim's
  owner, so a past attempt's owner was otherwise unrecoverable.

### Security

- **Total TTS spend is bounded now, not just per-subscriber spend (audio-feed-m182)**: the daily
  episode ceiling applied to each subscriber separately, so the deployment's total spend was linear
  in the number of approved subscribers — approving one is a single button, and nothing bounded the
  sum. A fleet-wide ceiling (`GLOBAL_DAILY_EPISODE_BUDGET`, 500 by default: ten subscribers' worth
  of the per-subscriber default) now caps paid episodes per UTC day across all subscribers together.
  It is resolved the same way as the per-subscriber ceiling and enforced inside the worker at both
  gates, so no path that synthesises can miss it, and exceeding it defers work rather than failing
  it — episodes stay pending and are served the next day. `GET /api/admin/stats` reports the
  ceiling, its source and the day's fleet usage. Measured on the real worker: nine queued episodes
  across three subscribers went from nine paid calls to four paid with five still pending.

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

- **Host gate configures itself (audio-feed-7lsy, P1)**: the accepted host now comes from
  `PUBLIC_BASE_URL` - the same value the WebAuthn RP ID already derives from - so a deployment that
  knows its own host no longer needs an operator to type it a second time. Requests on an
  unrecognised host are answered `421` instead of being served; with no configured host the gate
  fails closed and only loopback is accepted. `ALLOWED_HOSTS` remains as an override that adds hosts.
- **Host-injection hardening (audio-feed-fp4r)**: new `ALLOWED_HOSTS` environment variable
  (comma-separated). When set, the advertised origin — feed `selfUrl`, enclosure URLs, redirects,
  and the WebAuthn RP ID derived from it — can only ever be a listed host; requests arriving on any
  other host are answered `421 Misdirected Request`. Unset preserves the request-derived origin
  behaviour (safe on Deno Deploy, whose router validates Host).

### Fixed

- **The Deno Deploy entrypoint is pinned in the repo (audio-feed-w55i)**: the live project failed a
  build with `Entrypoint at '/tmp/build/src/src/server.ts' not found` (`src/` applied twice) because
  the entrypoint existed only in the Deploy dashboard, out of sight of the repo. `deno.json` now
  carries `deploy.runtime {type: dynamic, entrypoint: main.ts}` — the root deno-serve entrypoint
  Paul added in bc47dd4 — and Deno Deploy reads runtime configuration from source, which takes
  precedence over the dashboard. `tests/deploy_config_test.ts` fails the repo's own gate if the
  block is removed or the entrypoint path stops naming a real file, so the next typo costs
  milliseconds here instead of a failed build on the platform.
- **The error log is now readable during the incident that is refusing requests (audio-feed-2tbv)**: the
  observability API sits behind the host gate, and the gate refuses before any route runs, so during
  the live 421 (`audio-feed-du8w`) `GET /api/observability/errors` answered 421 on the very host being
  diagnosed — the tool for reading the incident was itself refused by the incident. Those two JSON
  endpoints (`/errors`, `/summary`) are now served even when the gate refuses, and both refusal bodies
  name them so an operator is told where the errors are. This is not a hole in the gate: they remain
  key-gated (401 without `AUDIOFEED_OBSERVABILITY_KEY`, 503 naming the variable when it is unset), they
  emit nothing derived from the request — no redirect, no origin, no `Access-Control-Allow-Origin` —
  and matching is exact, so no product route, lookalike or sub-path is exempt. The "`Host` header does
  not change `request.url` locally" trap is pinned by function tests.

- **An unconfigured deployment blamed every visitor for its own missing configuration
  (audio-feed-3k2d)**: with neither `PUBLIC_BASE_URL` nor a usable `ALLOWED_HOSTS` entry set, the
  host gate answered the same `421 misdirected_request` it uses for a forged `Host`, so the live
  deployment (audio-feed-du8w) refused all traffic with a body that read as "you asked for the wrong
  host" — the operator saw exactly what a visitor saw, and nothing named the variable to set. The
  refusal now distinguishes the two states: an EMPTY allowed set (a deployment that cannot name its
  own host) answers `500 server_misconfigured` whose detail names `PUBLIC_BASE_URL`, while a
  non-empty set that does not contain the request host is still the `421` it always was. Failing
  closed is unchanged — nothing is derived from the request. On a Deploy deployment the boot line for
  the empty state is error-level and says what a visitor gets; tests now cover the empty-set shape
  the incident shipped in, which the original 7lsy verification never exercised.
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
