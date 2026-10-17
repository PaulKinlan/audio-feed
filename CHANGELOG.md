# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- **The admin page's own view has an id you can quote (audio-feed-xapat)**: the page rendered correlation ids
  for FAILURE ROWS, but the page's own view had none - `src/app.ts`, `src/router.ts` and `src/http.ts` carried
  no request id at all - so an operator looking at the page could not go from what was in front of them to the
  log line that produced it, which is the copy-and-paste step Paul asked us to remove. The id the edge already
  mints for every request (`src/server.ts`) is now handed to the app on the request for THIS ROUTE ALONE and
  rendered as "View correlation id", and the page writes its own `admin.view` record under the same id. It is
  additive: no routing, caching, auth or response-body change, `x-correlation-id` is already a response header,
  and a client-supplied value is still never adopted. The record is written fire-and-forget through the logger,
  which resolves to null rather than throwing, so a wedged log store cannot stop this page rendering - the
  browser proof asserts the id still renders in its unreadable-store phase and asserts the join (the id on the
  page resolving to a record) in the wedged-with-traces phase, while a test through the real edge pins the
  three-way join page id == response header == the request's own `http.request` record.

### Added

- **The fast gate's selection is now a proven subset of the full gate, and the gap that let a fast
  PASS hide a full FAIL is closed (audio-feed-es8y)**: `scripts/test-selection.ts` is the one source
  of truth for which test modules exist — it discovers what `deno test` with no arguments would run
  (Deno's `{*_,*.,}test.<ext>` basename rule, verified empirically on Deno 2.9.7) — and the fast
  gate's universe is DERIVED from it by filtering, rather than being a second walk of `tests/`.
  `deno task gate` now opens with
  `deno run --allow-read --allow-env --allow-run=deno
  scripts/test-selection.ts --prove-discovery`,
  which fails the gate by NAME when a module the full gate runs can never be selected by the fast
  gate (or when a `FAST_GATE_EXCLUSIONS` entry does not name a real module and say where it runs
  instead), so drift is loud at the start of a run instead of discovered by a merger. The same step
  PROVES the universe rather than asserting it: it plants a corpus of `*_test.{ts,js,mts}` /
  `*.test.*` files (plus look-alikes that must NOT be discovered, and files under the excluded
  trees) and compares its walk with `deno test --no-run`'s own scan under this repo's exclude list.
  Non-TypeScript changes outside `src/` and `tests/` are no longer assumed unobservable, and their
  read relation is NOT a list maintained beside the suites: `scripts/test-selection.ts` DERIVES who
  reads what by scanning the suites' own code (and the repo modules they import) for read/execute
  call sites with statically resolvable paths — string literals,
  `new URL("<literal>", import.meta.url)`, and path constants or templates built from
  `${import.meta.dirname}`. A `docs/evidence/*.png` therefore selects `tests/evidence_size_test.ts`
  (found through `evidencePngs()` -> `EVIDENCE_DIR`) and `scripts/observability-agent-run.sh`
  selects `tests/observability_agent_poll_test.ts`, which executes it — no mapping table to keep in
  sync. There is nothing hand-written: `UNREAD_DECLARATIONS` and its reconciliation audit are DELETED
  (audio-feed-r9fe) - a standing "nothing reads this" claim is one a later suite can contradict
  silently, and the measured cost of removing it is a full suite on the rare tooling-config change
  (15 changes in 652 commits). Anything the derivation cannot see runs the full suite and names
  itself. The module-graph config list is a net audited against the config files the resolver
  actually reads (derived from `deno.json(c)`), not the safety mechanism. Before this, a 200KB
  screenshot selected ZERO suites:
  the fast gate passed while the full gate failed on the same tree. An EMPTY selection is never a
  silent pass either: it is allowed only when every changed file is markdown no suite is derived to
  read, and then the run
  says `NO SUITES SELECTED — 0 of N test module(s) ran` and emits `fast-gate: unmapped: <files>`,
  which the fleet's coverage reporter turns into a COVERAGE WARNING, so a gate that ran nothing is
  visibly not a gate that ran suites and passed. Anything not provably inert runs the full suite —
  including a standalone `scripts/` module nothing imports, whose old silent zero ("the type-check
  is its gate") is gone.

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
  fails closed and only loopback is accepted. `ALLOWED_HOSTS` remains as an override that adds
  hosts.
- **Host-injection hardening (audio-feed-fp4r)**: new `ALLOWED_HOSTS` environment variable
  (comma-separated). When set, the advertised origin — feed `selfUrl`, enclosure URLs, redirects,
  and the WebAuthn RP ID derived from it — can only ever be a listed host; requests arriving on any
  other host are answered `421 Misdirected Request`. Unset preserves the request-derived origin
  behaviour (safe on Deno Deploy, whose router validates Host).

### Fixed

- **The gate type-checks the tree once per run, not twice (audio-feed-pnw73)**: `deno task gate` ran
  `deno check main.ts src tests scripts` and then `deno test`, which type-checked the same tree over the
  same roots a second time — and the fast tier did the same through `TEST_FLAGS`, whose cheap steps always
  run `deno task check` first. The test step in both now carries `--no-check`; measured on Deno 2.9.7 with
  this repo's 2267 tests, removing the duplicate takes the full suite from 201.4s / 259.8s to 191.6s /
  187.5s with an identical result. `--no-check` is sound **only** directly after that whole-tree check, so
  the bare `deno test` task (which runs no check first) keeps type-checking, and `tests/fast_check_test.ts`
  pins all three halves — both the flag's presence in the gate and its absence from the bare task — so a
  future edit cannot quietly leave a tree unverified. `deno test --parallel`, the other half of the same
  bead, is measured at ~4x (187s to 48s) but needs 3-4 suites made parallel-safe first and is tracked as
  audio-feed-e4udd.
- **The fence-scan timing test measures the work, not the machine (audio-feed-0evr)**: `tests/tts_test.ts`
  bounded three `formatCodeForTts` scans with a single, unwarmed `performance.now()` reading each, so the
  fence case was asserted against the wall clock - and the same work measured 648-1119ms of wall under 8 CPU
  hogs (4.1-9.1s under starvation) and failed in isolation at ordinary load, while the whole file passed only
  because earlier tests in it happen to warm the path first (on identical code and the same filter, a quiet
  run read 250ms alone, 230ms with a couple of earlier tests matched, and 50ms inside the whole file). Two
  CPU-time measures were tried and refuted by measurement before the clock was dropped: process-wide
  `process.cpuUsage()` accumulates the runtime's sibling threads (519-968ms on the same calls), and this
  thread's `process.threadCpuUsage()` floor of 15 calls still moved with load (the floor arrives by call 3
  quiet, but not until call 12 under 8 hogs, where a shallower minimum reports 120-300ms). **The scans now
  report the work they do**: `ScanWork.examined`, the characters the scan's forward searches covered
  (`src/tts/gemini.ts`), asserted against shape ceilings instead of a duration - `examined <= len*len` for
  the fence sizes (measured 12,001x and 48,001x the input length, so the ceiling is a shape claim and not a
  fit), `examined <= 8x len` for the `<pre>` and no-gt scans (measured 4.00x and 3.00x), and the growth
  across a 4x increase in markers held between 4x and 20x (measured 16.00x). A count cannot be made
  comfortable by whatever ran first, which is the whole point. The only clock left is a **15s hang guard**
  (`SCAN_HANG_GUARD_MS`), not the property, and what the suite no longer sees is stated in it rather than
  glossed: a constant-factor slowdown that does no extra string work. The fence path is super-linear today
  (4x markers = 16.00x the work, the shape a quadratic predicts), so no linearity claim is made for it -
  the band accepts linear through quadratic and catches a scan that stopped looking: audio-feed-1mowv.
- **The invocation budget's clock belongs to whoever drives it, so the deadline is a decision rather
  than a property of the machine (audio-feed-ugak)**: two suites in `tests/synthesis_resume_test.ts`
  asserted that an 80ms *real* deadline landed after segment 1 committed and before turn 2 finished —
  a race the machine won or lost (measured: 8 PASS / 2 FAIL idle, 0 PASS / 10 FAIL under CPU
  starvation, with turn 1's own preflight observed anywhere between 7ms and 91ms of real elapsed
  time). Because a gate runs test modules concurrently, contention is its normal case, so every
  landing that touched those suites carried a coin flip. `src/synthesis/limits.ts` now reads the time
  and arms the deadline through one injectable `InvocationClock`, defaulting to `REAL_INVOCATION_CLOCK`
  (process monotonic time plus the platform scheduler) so **no production path passes one and no
  behaviour changed**; the two suites pass a clock they drive, keep every product assertion, and pin
  the decision instead (the armed deadline is exactly 75ms = 80ms budget − 5ms flush margin, and the
  abort is observed in flight with turn 2's paid call entered). Measured after: 10/10 green idle, 10/10
  green whole-file under 16 CPU hogs, and 10/10 green in the starvation condition whose before was
  0/10. A deadline that cannot fire is a named failure, not a hang. Rejected, by measurement: a
  derived or raised budget (10x it — 800ms, ~50-100x the real per-segment work — still failed 2/5
  under the same load and 4/5 at 24 hogs), and a virtual timer alone (`@std/testing` `FakeTime`
  patches `Date.now` and `setTimeout` but **not** `performance.now`, which is what a budget measures
  elapsed time with).

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
  closed is unchanged — nothing is derived from the request. On a Deploy deployment the boot line
  for the empty state is error-level and says what a visitor gets; tests now cover the empty-set
  shape the incident shipped in, which the original 7lsy verification never exercised.
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
