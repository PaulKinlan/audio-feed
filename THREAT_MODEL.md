# THREAT_MODEL.md

Documented security decisions live here so a reviewer does not have to rediscover the reasoning from
diffs. This file is a seed: the software factory's threat-model station owns growing it into the
full model; entries below are decisions that were made and reviewed on specific beads, not an
exhaustive analysis.

## Entry-point coverage (index, audio-feed-uclpx)

The route table lives in exactly one file (`src/app.ts`, "Application wiring — the single place
routes are mounted"), and every entry point is one `router.<method>(...)` registration there. The
count below is mechanical, re-derivable with:

    grep -nE 'router\.(get|post|delete|put|patch|add)\(' src/app.ts

On the revision that added this section that yields **72 registrations** (35 GET, 32 POST, 3 DELETE,
1 `add`): 71 literal patterns plus the constant `ADMIN_OBSERVABILITY_ROUTE` (= `/admin/observability`,
`src/app.ts:133`). The `OPTIONS` registration on `/api/reports/csp` (`src/app.ts:413`) shares the POST
handler, so there are **71 distinct handler endpoints**, of which one (`/__test/throw`,
`src/app.ts:172`) exists only when an operator sets `AUDIO_FEED_TEST_THROW=1` and is not part of a
production attack surface — leaving **70 production entry points**. One seam sits outside the table:
`handlers.extra?.(router)` at the end of `createRouter`; a route registered through it belongs to a
boundary below only if its author picks one and records it here.

**70 production entry points; all 70 covered by one of the eight boundary sections below**; the three
pre-existing decision sections (CSP reports, `/health`, offline cache) are cited from inside them.
Unmitigated boundaries are labelled as such — none are softened or omitted.

| # | Boundary | Registrations | Routes |
|---|---|---|---|
| 1 | Public capability URLs | 6 | `/feed/:token/master.xml`, `/feed/:token/:sourceId/:mode.xml`, `/listen/:token`, `/listen/:token/status`, `POST /listen/:token/episodes/:episodeId/retry`, `/audio/:key+` |
| 2 | Feed-token APIs | 5 | `POST /api/ingest`, `POST /api/upload`, `GET/POST /api/sources`, `GET /api/episodes` |
| 3 | Anonymous browser writes | 6 | `POST /api/auth/login/options`, `POST /api/auth/register/options`, `POST /api/request-access`, `POST /api/cwv`, `POST /api/reports/csp` (+ its OPTIONS alias) |
| 4 | Session APIs and pages | 16 | `POST /api/auth/logout`, the 9 `/api/account/*` routes, `POST /api/auth/login/verify`, `POST /api/auth/register/verify`, `GET /account`, `GET /login`, `GET /add`, `GET /listen` (bare path) |
| 5 | Admin surface | 28 | `GET /admin`, `GET /admin/subscribers(+:id)`, `GET /admin/observability(+/issues, /telemetry)`, the 19 `/api/admin/*` routes, `POST /api/auth/bootstrap`, `GET /api/observability/errors`, `GET /api/observability/summary` |
| 6 | Ingest fetch (SSRF) | — | the server-side fetch half of boundary 2, plus scheduled feed polling and `POST /api/sources` discovery |
| 7 | Static, well-known, public pages | 9 | `/`, `/sw.js`, `/manifest.json`, `/robots.txt`, `/icon.svg`, `/assets/:name`, `/.well-known/webauthn`, `/health`, `/assets/voices/:voice` |
| 8 | Non-HTTP entries | — | `Deno.cron` jobs, feed-poll and synthesis workers, and the admin `poll-now`/`synthesize-now` triggers (counted under boundary 5) |

Boundaries 6 and 8 have no registrations of their own; they are halves and code paths of the counted
routes, listed separately because the attacker's position there is different.

### Boundary 1 — Public capability URLs: the token in the path is the whole credential

- **Routes:** `GET /feed/:token/master.xml` and `GET /feed/:token/:sourceId/:mode.xml`
  (`src/app.ts:270-278`), `GET /listen/:token` + `GET /listen/:token/status` +
  `POST /listen/:token/episodes/:episodeId/retry` (`src/app.ts:230-236`), `GET /audio/:key+`
  (`src/app.ts:281`). Podcast clients cannot authenticate, so the path token is the only credential
  these routes will ever get (`src/app.ts:268-269`).
- **Attacker controls:** the path token or key itself — it leaks through browser history, proxy logs
  and pasted links; anyone holding it is, from the server's view, the subscriber.
- **Mitigations:**
  - Token resolution is a single indexed lookup on the capability, and user IDs are deliberately NOT
    accepted as tokens (the historical ID-as-token bypass is documented at `src/compose/shared.ts:40-56`);
    every user-scoped route shares `approvedUserFor` (`src/compose/shared.ts:69-90`) so the approval
    gate cannot be forgotten on a new route.
  - `/listen` refusals are uniform 404s with no status detail distinguishing unknown token, unapproved
    owner or missing episode (audio-feed-se8s8; `src/routes/listen.ts:723`, `:850`, `:1007`). The
    `/audio` precedent is approval-before-blob (audio-feed-7kdhb): the owner's approval is checked on
    the key that actually resolved, failing closed, BEFORE any blob read or cache spend, so a refusal
    cannot confirm blob existence (`src/routes/audio.ts:221-244`).
  - The retry POST is a PAID mutation behind the weaker credential, walled three ways (audio-feed-8jzgl):
    a same-origin wall, two sliding windows (10/10 min per token+address, 30/10 min per token) and a
    durable lifetime ceiling of 5 retries per episode (`src/routes/listen.ts:882-901`).
  - The listen page and its status poll are rate-limited before ANY store work: 60 per 5 min per
    (route, address) (audio-feed-l11jx; `src/routes/listen.ts:641`, `:714-715`).
  - Capability keys are redacted from logs and error URLs (`src/router.ts`, `redactAudioKey`,
    `sanitizeRequestUrl`).
- **Residual (documented, accepted):** a leaked capability is a bearer credential, valid until
  rotated; rotation is subscriber-initiated (`POST /api/account/rotate-token`) or admin-initiated
  (`POST /api/admin/users/:id/rotate-token`), and neither can reach a device that already downloaded
  episodes — see the offline-cache section below. The retry ceiling is intentionally small; a
  persistently failing episode is an owner problem by design (`src/routes/listen.ts:889-892`).

### Boundary 2 — Feed-token APIs (capability-token account surface)

- **Routes:** `POST /api/ingest`, `POST /api/upload`, `GET/POST /api/sources`, `GET /api/episodes`
  (`src/app.ts:284-297`).
- **Attacker controls:** the presented token (`x-feed-token`, `x-user-token`, or `Authorization:
  Bearer`; `src/compose/shared.ts:17-30`) and, on ingest/upload, the URL or document content.
- **Mitigation:** both ingest and upload resolve through `authorizeIngest`
  (`src/compose/ingest.ts:62-89`): an explicit token goes through `approvedUserFor` (boundary 1's
  gate); a cookie-only request must ALSO pass the strict same-origin wall, because a cookie is
  ambient. Both paths require an approved user.
- **Residual (unmitigated, recorded):** there is no per-token rate limit or spend cap on accepted
  ingest/upload work. Each accepted request queues a paid synthesis job; the only bound is holding a
  valid approved token. A leaked feed token therefore doubles as an unbounded spend button on
  ingest — unlike `/listen`'s retry, which is walled (boundary 1). Candidate bead, not filed here.

### Boundary 3 — Anonymous browser writes

- **Routes:** `POST /api/auth/login/options`, `POST /api/auth/register/options`,
  `POST /api/request-access`, `POST /api/cwv`, `POST /api/reports/csp` (+OPTIONS)
  (`src/app.ts:289-289`, `:361`, `:378`, `:380`, `:412-413`), plus `GET /share` which only validates
  a shared URL as http/https and redirects signed-in subscribers to the quick-add panel
  (`src/routes/share.ts:11-19`).
- **Attacker controls:** everything — no credential exists; the only varying input is the client
  address and the body.
- **Mitigations:**
  - The passkey challenge write is bounded per address BEFORE the handler mints a challenge: 60 per
    5 min, with the window equal to the challenge TTL so an address can never hold more than 60 live
    challenge rows, and unaddressed clients collapsed onto a dedicated limiter key
    (audio-feed-plmhk; `src/routes/account_api.ts:134-164`, check at `:240`). The verify halves
    (`login/verify`, `register/verify`) require a challenge minted by the options call
    (single-use, TTL 5 min, `src/routes/account_api.ts:138`), so this bound caps verify attempts too.
  - Request-access: 5 per hour per IP, atomic email dedup that does not reveal an account's
    existence or status, tokens never returned to the applicant (audio-feed-r97/oxw5g/2zvc;
    `src/compose/access.ts:24-46`).
  - The CWV beacon is a typed record, not request fields, with a 4 KiB body cap and a 60/min per
    client window (`src/routes/cwv.ts:25-41`, `:72`, `:99`).
  - CSP reports: see the origin-policy section below (untrusted or absent `Origin` accepted with 204
    but never stored, never budgeted).
- **Residual (documented, accepted):** origin-less CSP reports from legacy WebKit engines are
  invisible by policy (existing section below). No other write in this class is unbounded.

### Boundary 4 — Session APIs and pages

- **Routes:** `POST /api/auth/logout`, the 9 `/api/account/*` routes, `POST /api/auth/login/verify`,
  `POST /api/auth/register/verify` (`src/app.ts:378-392`), `GET /account`, `GET /login`, `GET /add`,
  `GET /listen` bare path (`src/app.ts:183-228`).
- **Attacker controls:** a cross-site browser context (CSRF position); a stolen session cookie if
  they have one.
- **Mitigations:**
  - A session is a random secret in a `__Host-af_session` cookie (`src/auth/sessions.ts:21`);
    `__Host-` forces Secure, Path=/ and no Domain (`src/auth/sessions.ts:104`), and the store holds
    only its hash (`src/auth/sessions.ts:6`).
  - Every state-changing session API sits behind the strict same-origin wall
    (`src/routes/account_api.ts:104-106`); admin reads use the looser `sameSiteRead` so legitimate
    same-origin GETs without an Origin header succeed while cross-site requests are refused
    (`src/compose/admin.ts:100-108`).
  - The `/listen` bare path redirects an approved session to its capability URL with
    `cache-control: no-store` and `referrer-policy: no-referrer`, so the token is never written to
    localStorage (`src/app.ts:202-228`).
- **Residual (documented, accepted):** a stolen session cookie is a bearer credential until logout
  or `rotate-token`; nothing in code detects a replayed cookie from a second device.

### Boundary 5 — Admin surface (console, admin API, break-glass, observability API)

- **Routes:** the 6 `/admin*` pages (`src/app.ts:152-162`), the 19 `/api/admin/*` routes
  (`src/app.ts:308-370`, `:394-406`), `POST /api/auth/bootstrap` (break-glass,
  `src/app.ts:382`), and the observability API `GET /api/observability/errors` +
  `GET /api/observability/summary` (`src/app.ts:300-307`).
- **Attacker controls:** the whole unauthenticated internet; plus a subscriber session attempting to
  reach admin data.
- **Mitigations:**
  - ONE gate helper, `adminGate` (`src/compose/admin.ts:64-119`), so "a new admin route cannot be
    added without the token check by accident" (audio-feed-z2s): the normal path is session +
    `isActiveAdmin` + strict same-origin on writes / `sameSiteRead` on reads; the break-glass path is
    `x-admin-token`/Bearer checked by `requireAdminToken` (`src/auth/users.ts:65-69`); and an
    unconfigured `ADMIN_TOKEN` fails CLOSED (`src/compose/admin.ts:97-100`). The admin pages render
    no subscriber data in the shell; data comes only from the gated API routes (`src/app.ts:150-153`).
  - Failed attempts on the header path AND bootstrap share ONE sliding-window lockout limiter
    (audio-feed-bns, store-shared so the bound holds across isolates; `src/compose/admin.ts:60-62`,
    `:118-140`; bootstrap at `src/routes/account_api.ts:354-357`).
  - The observability API is a separate Bearer shared key, `timingSafeEqual`-compared, and closed
    when `AUDIOFEED_OBSERVABILITY_KEY` is unset (`src/routes/observability.ts:110-147`).
- **Residual (documented, accepted):** the break-glass token is a static configured secret with no
  expiry or rotation enforcement in code — rotation is an operational concern outside this repo.
  Admin-initiated feed-token rotation cannot reach a device's already-downloaded library
  (offline-cache section below). There is no recorded inside-actor boundary: an active admin is
  fully trusted by this model.

### Boundary 6 — Ingest fetch: the server fetching attacker-supplied URLs (SSRF)

- **Where:** the server-side half of `POST /api/ingest` and `POST /api/upload`, feed discovery on
  `POST /api/sources`, and scheduled feed polling; implemented in `src/ingest/url.ts` and
  `src/ingest/feed.ts`.
- **Attacker controls:** the URL — and everything behind it — that the SERVER fetches, including
  redirect chains; a hostile feed also controls the content later narrated to the subscriber.
- **Mitigations (`src/ingest/url.ts`):** only global-unicast hosts are fetchable — loopback, LAN,
  metadata and transition ranges are denied (`:53`); every redirect target is re-validated and
  chains are capped at 5 (`:238`, `:310-311`, `:348`, `:537`); reads are bounded at 2 MiB and 15 s
  (`:512-513`); a public hostname that resolves to a private address is refused (`:456-457`).
- **Residuals:** (a) the fetch walls bound WHERE the server fetches, but accepting ingest work is not
  throttled — see boundary 2's unmitigated spend residual. (b) Unmitigated, unrecorded until now:
  ingested article text reaches the synthesis prompt with no sanitisation or injection boundary
  anywhere under `src/synthesis/`, `src/tts/`, `src/worker/` — a hostile feed can make the
  subscriber's own podcast narration say attacker-chosen things. The blast radius is narration
  audio, not code execution, but it is a real content-integrity surface. Candidate bead, not filed
  here.

### Boundary 7 — Static, well-known and public pages

- **Routes:** `/`, `/sw.js`, `/manifest.json`, `/robots.txt`, `/icon.svg`, `/assets/:name`,
  `/.well-known/webauthn`, `/health`, `/assets/voices/:voice` (`src/app.ts:148`, `:229-251`).
- **Attacker controls:** nothing credential-bearing; some query parameters and the Asset name.
- **Mitigations:** HTML responses carry a per-response CSP nonce and the shared security-header set
  (`src/router.ts` `applySecurityHeaders`; `src/routes/csp.ts` `htmlResponse`/`newCspNonce`); assets
  are content-addressed (audio-feed-3xq, `src/app.ts:229`); voice samples are NOT public — the
  handler runs session → voice allowlist → cache/generate, and nothing before the allowlist check
  reads a blob or pays for generation (`src/routes/voice-samples.ts:14`, `:73`); the service worker
  excludes token-bearing paths from every cache (audio-feed-s3f0, offline-cache section below);
  `/health` deliberately discloses deploy metadata — existing section below.
- **Residual (documented, accepted):** `/health` is an unauthenticated reconnaissance signal
  (existing section below).

### Boundary 8 — Non-HTTP entries: cron, workers, manual triggers

- **Where:** `Deno.cron` registrations (`src/cron.ts`, audio-feed-dsn), the feed-poll and synthesis
  workers (`src/worker/`), and the admin manual triggers `POST /api/admin/poll-now` /
  `POST /api/admin/synthesize-now` (same code paths, behind boundary 5).
- **Attacker controls:** nothing directly — these entries have no network listener; their input is
  stored state (feeds, episodes), reachable only through boundaries 2 and 6. There is no inbound
  webhook surface at all: every provider interaction is outbound polling.
- **Mitigation:** outbound fetches ride boundary 6's walls; TTS provider work is deadline-bounded
  with explicit handling of segments billed after a deadline fires (`src/tts/gemini.ts:123-133`),
  under the limits in `src/synthesis/limits.ts`.
- **Residual (documented, accepted):** a synthesis job's provider cost can be incurred by content
  that later fails; accepted as the price of the feature, and the spend rate is bounded only by
  boundary 2's (absent) ingest throttle.

## CSP report endpoint (`/api/reports/csp`) — origin policy

- **Decision** (audio-feed-cspreports; review delta ruled by coord, 2026-10-29): reports arriving
  with an UNTRUSTED or ABSENT `Origin` header are accepted with **204** — so the browser flushes and
  does not retry — but are **never stored** and **never consume** the visitor's per-window write
  budget (`reports:budget:*`), and are not attributed to the visitor.
  - Trusted means the origin host is in the configured allowlist or a loopback host
    (`src/origin.ts`, `isTrustedReportOrigin`); `Origin: null` and a missing header are untrusted.
  - The drop is narrated through the app's logger seam (`src/log.ts`, sink `appendLog`; record type
    `csp_report.origin_untrusted_dropped`), carrying the origin value or the literal `(absent)` in
    its reason, so "no CSP violations today" cannot silently mean "every report was discarded by the
    origin policy".
- **Residual (documented, accepted):** legacy WebKit engines that POST CSP reports without an
  `Origin` header are indistinguishable from the untrusted case and are dropped the same way — their
  violations are invisible by policy. Accepting them would require trusting origin-less requests on
  a cross-origin reporting endpoint, which is the surface this policy exists to close.

## Unauthenticated `/health` — deploy fingerprint and backend-kind disclosure

- **Decision** (audio-feed-1552, audio-feed-ciia; fallback behaviour on audio-feed-j9j1; section recorded on audio-feed-vaw6n): the
  unauthenticated `/health` route (`src/app.ts`) deliberately returns, to any caller without a
  token or session: the storage backend KIND (`ctx.stores.describe`, e.g. `blobs=s3`), the deploy
  id and its source, and the exact source commit SHA (`deploy.commit`).
- **Why accepted:** production has no other observable identity — every other surface is token- or
  session-gated — so this disclosure is what lets a landing be verified against the live deployment
  ("which revision is actually running?") without Deno Deploy API tokens.
- **Residual (documented, accepted):** the endpoint is an unauthenticated reconnaissance signal: it
  names the storage backend and pins the running revision, which tells an attacker exactly which
  version's bug classes to try. That is judged low-sensitivity operational metadata, not a secret.
- **Scope note:** an earlier revision leaked the blob-store BUCKET NAME through the same route;
  that leak is fixed and `Stores.describe` deliberately publishes the backend kind only
  (audio-feed-tra9d).

## Offline audio cache — survives an update, not a sign-out (audio-feed-vnu4g)

- **Decision:** the offline audio cache (`audio-feed-offline-v1`, written by the player and served
  cache-first by the service worker for `/audio/`) deliberately survives a service-worker update —
  "the subscriber's own downloaded library must survive an update". That is NOT "must survive
  sign-out". The worker now deletes the whole cache when the server confirms a DEVICE-initiated
  `POST /api/auth/logout` (either the no-script form, which 303s, or the JSON call) or a
  device-initiated `POST /api/account/rotate-token` passing through its fetch handler; a failed
  call changes nothing. Only device-initiated calls can purge: admin/remote token rotation and
  session expiry never contact the device, which keeps playing its downloaded library until it
  next connects. On `activate` the worker also sweeps superseded `audio-feed-shell-*` AND
  `audio-feed-offline-*` generations, so a future cache version bump cannot leave the old
  generation installed forever.
- **Why purge by name instead of sweeping keys:** the audio URLs in this cache are public capability
  URLs (`/audio/<key>`; the key IS the capability) and carry no feed token, so there are no
  token-bearing keys to match — a key sweep would be a no-op with extra reads. The navigation cache
  never stores token-bearing paths in the first place (`/listen/`, `/feed/` are excluded,
  audio-feed-s3f0).
- **Residual (documented, accepted):** admin suspension stops a subscriber's feed server-side but
  cannot reach a device to purge it — the device is never contacted — so a suspended account's
  already-downloaded episodes stay on disk until sign-out. Admin token rotation
  (`POST /api/admin/users/:id/rotate-token`, which rotates another subscriber's feed token
  remotely) has the same shape: the stale feed fails on the device's next refresh, but the
  already-downloaded episodes stay on disk and keep playing there until it next connects. Separately, the cache has no size bound:
  a device that downloads every episode grows without limit until sign-out (nightly audit
  2026-11-05); an app-driven write-time eviction is the follow-up mechanism if that bites.

## Feed-token ingest boundary — accepted paid synthesis spend (audio-feed-gvx0k)

- **Decision** (audio-feed-gvx0k, from the boundary pass on audio-feed-uclpx; decided 2026-11-05): a feed
  token IS bounded on paid synthesis spend — per token, before the money moves — so the earlier recording
  of this boundary ("the only ceiling is whatever global budget exists") understated a real mitigation.
  Two episode ceilings cover every synthesis path. Both are resolved INSIDE `runSynthesisBatch`
  (`src/worker/synthesis.ts`), so no entry point can forget them, re-read at the spend gate that runs
  immediately before `claimEpisode`, and fail closed (a count that cannot be read defers, never spends):
  - per subscriber — `dailyEpisodeBudget`, default `DEFAULT_DAILY_EPISODE_BUDGET` = **50** paid episodes
    per UTC day (`src/config.ts`, `dailyEpisodeBudgetFor`; an admin can set it per subscriber, `0` allows
    nothing);
  - fleet-wide — `GLOBAL_DAILY_EPISODE_BUDGET`, default **500** paid episodes per UTC day
    (`globalDailyEpisodeBudgetFor`, audio-feed-m182).
  The arithmetic: one episode's provider-contract ceiling is `MAX_TTS_SEGMENTS` 64 x 8,192 input /
  16,384 output tokens = **$9.70** at the promotional $0.50/$9.00-per-1M rates — the repo's own figure,
  `scripts/real-voice-upload-acceptance.ts` ($19.40 at the standard rates from 2027-01-01). So one token
  is bounded at 50 x $9.70 = **$485 per UTC day** ($970 standard), which is 10% of the deployment's
  500-episode = $4,850/day ceiling; a typical 2,000-4,000-word article (~13-27 min of audio at the
  documented 25 audio tokens/s) costs ~$0.18-$0.36, i.e. ~$9-$18/day per token. PER HOUR that figure is
  the whole allowance rather than a share of it, because the window resets at 00:00Z and the worker
  drains at `batchSize` 5 per tick with a measured ~10.2 s per episode — all 50 fit inside ~9 minutes of
  a UTC day's first tick. The per-episode ceiling cannot be grown by a bigger article either: narration
  input is capped at `MAX_NARRATION_BYTES` 192,000 bytes at accept for `/api/upload`
  (`src/ingest/upload.ts`) and at the worker's `maxInputBytes` preflight for every path, before any paid
  call.
- **Residual (documented, accepted):** the ceilings count COMPLETED episodes — billing commits atomically
  with `status: "ready"` (`src/storage/kv/episodes.ts`), so an attempt that spends TTS turns and then
  fails terminally is paid without incrementing the count. Each such episode is bounded (`maxAttempts` 3,
  `DEFAULT_MAX_CLAIMS` 3, the same 64-call / 192 KB caps) and the ingest request cannot force it
  deterministically: the request-time refusals — oversized narration, unreadable article, unapproved user
  — all happen before any paid call. So it is a margin on the ceiling, not a way round it. Separately,
  `/api/ingest` and `/api/upload` carry no per-window ACCEPT rate limit: a token can enqueue more pending
  episodes than its daily allowance, which costs storage and queue scanning but no synthesis money — the
  work simply defers at the gate. An accept-time rate limit would bound the queue, not the spend.
