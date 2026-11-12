# THREAT_MODEL.md

Documented security decisions live here so a reviewer does not have to rediscover the reasoning from
diffs. This file is a seed: the software factory's threat-model station owns growing it into the
full model; entries below are decisions that were made and reviewed on specific beads, not an
exhaustive analysis.

## Entry-point coverage (index, audio-feed-uclpx)

The route table lives in exactly one file (`src/app.ts`, "Application wiring — the single place
routes are mounted"), and every entry point is one `router.<method>(...)` registration there. Routes
are mounted from that single registration path and nowhere else: `createRouter` registers all 72
itself, and no callback, hook or extra-registration seam exists through which a caller could mount a
route this census does not see — the census is the whole population, not a sample of it.
The count is mechanical, re-derivable with:

    grep -nE 'router\.(get|post|delete|put|patch|add)\(' src/app.ts

Run from the repository root, on the revision this section was last re-derived at (`07d8e60a`,
2026-11-10), that command yields **72 registrations** (35 GET, 33 POST, 3 DELETE, 1 `add`): 71
literal patterns plus the constant `ADMIN_OBSERVABILITY_ROUTE` (= `/admin/observability`, the
exported constant in `src/app.ts`). The `router.add("OPTIONS", "/api/reports/csp", …)` registration
shares the POST handler, so there are **71 distinct handler endpoints**, of which one (`GET
/__test/throw`, the `AUDIO_FEED_TEST_THROW` trap door inside `createRouter`) exists only when an
operator sets `AUDIO_FEED_TEST_THROW=1` and is not part of a
production attack surface — leaving **70 production entry points**.

**70 production entry points; all 70 covered by one of the eight boundary sections below**; the three
pre-existing decision sections (CSP reports, `/health`, offline cache) are cited from inside them.
Unmitigated boundaries are labelled as such — none are softened or omitted. A citation should be
re-derivable by a command; line ranges are the last resort and must say so. Concretely, every
citation in this file takes one of two forms: a durable anchor — a symbol (function, constant,
type), a route literal, a pinned test name, or the command that reproduces the claim — or a
`file:line` pointer carrying an explicit `last resort:` clause saying why nothing nameable locates
it. Symbols and route literals win wherever they can name the thing, because they survive the
refactors that move line numbers: a number that is not the only way to name the code is a citation
waiting to rot. (audio-feed-0c5uc swept this file to that rule.)

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

- **Routes:** `GET /feed/:token/master.xml` and `GET /feed/:token/:sourceId/:mode.xml`, `GET
  /listen/:token` + `GET /listen/:token/status` +
  `POST /listen/:token/episodes/:episodeId/retry`, and `GET /audio/:key+` — each one a
  `router.get`/`router.post` line naming that exact pattern inside `createRouter` (`src/app.ts`; the
  census command above reproduces all 72). Podcast clients cannot authenticate, so the path token is
  the only credential these routes will ever get (stated in the `-- feeds --` registration comment in
  `src/app.ts`).
- **Attacker controls:** the path token or key itself — it leaks through browser history, proxy logs
  and pasted links; anyone holding it is, from the server's view, the subscriber.
- **Mitigations:**
  - Token resolution is a single indexed lookup on the capability, and user IDs are deliberately NOT
    accepted as tokens (the historical ID-as-token bypass is documented above `presentedToken` and
    `loadUserByFeedToken` in `src/compose/shared.ts`);
    every user-scoped route shares `approvedUserFor` (`src/compose/shared.ts`) so the approval
    gate cannot be forgotten on a new route.
  - `/listen` refusals are uniform 404s with no status detail distinguishing unknown token, unapproved
    owner or missing episode (audio-feed-se8s8; routes `GET /listen/:token`, `GET /listen/:token/status`,
    and `POST /listen/:token/episodes/:episodeId/retry` in functions `handleListen`, `handleListenStatus`,
    and `handleListenRetry` in `src/routes/listen.ts`; reproducible check:
    `grep -nE 'listen 404 \(unapproved\)' src/routes/listen.ts`, pinned by
    `tests/listen_test.ts` tests "the token is the only credential, and it is checked" and
    "retry refuses an unapproved token with the uniform 404, byte-identical to an unknown one (audio-feed-se8s8)"). The
    `/audio` precedent is approval-before-blob (audio-feed-7kdhb): the owner's approval is checked on
    the key that actually resolved, failing closed, BEFORE any blob read or cache spend, so a refusal
    cannot confirm blob existence (`checkUserApproval` in `src/routes/audio.ts`, called once in
    `handleAudio` before any blob read — reproducible check:
    `grep -n 'checkUserApproval' src/routes/audio.ts`).
  - The feed routes follow the same rule (audio-feed-vcpyi): an unknown token and a
    known-but-unapproved owner answer the IDENTICAL 404 `{"error":"Unknown feed"}` with no status
    detail, so holding a capability cannot confirm it or read the account's lifecycle out of a refusal
    (`createMasterFeedHandler` and `createSourceFeedHandler` in `src/compose/feeds.ts`, each with its
    own refusal — reproducible check: `grep -n 'Unknown feed' src/compose/feeds.ts`).
  - The served feed document carries no subscriber EMAIL and no account status (audio-feed-zlu04):
    `ownerEmail` is never populated from the account, so no `<itunes:owner><itunes:email>` is emitted.
    A capability URL is pasted into third-party clients and directories, and an address published that
    way cannot be recalled (the `ownerEmail` comments in `createMasterFeedHandler` and
    `createSourceFeedHandler`, `src/compose/feeds.ts`; reproducible check:
    `grep -n 'ownerEmail' src/compose/feeds.ts`). What the document DOES still
    publish is the display name: the master feed's channel `<title>` is `${displayName} — Audio Feed`
    and its `<itunes:author>` is `displayName` itself (the channel object of `createMasterFeedHandler`
    in `src/compose/feeds.ts`); a
    per-source feed titles itself from the source and sends the SOURCE title as `<itunes:author>`
    (the same two fields in `createSourceFeedHandler`), so the account name does not appear there. No
    email, no account id and no
    approval status ride along, and the `tests/feed_disclosure_test.ts` tests "the served feed publishes
    no account email and no itunes:owner (audio-feed-zlu04)" and "the metadata a subscriber keeps is
    the show's, not the account's (audio-feed-zlu04)" pin both halves — the
    absent email shape and the present title/author. Dropping the display name as well was left as a
    PRODUCT decision rather than a leak fix: clients render `<itunes:author>` as the show's author, so
    removing it changes what every subscriber sees in their player.
  - The retry POST (`POST /listen/:token/episodes/:episodeId/retry`) is a PAID mutation behind the
    weaker credential, walled three ways (audio-feed-8jzgl): a same-origin wall, two sliding windows
    (10/10 min per token+address via `LISTEN_RETRY_ADDR_RATE`, 30/10 min per token via
    `LISTEN_RETRY_TOKEN_RATE`) and a durable lifetime ceiling of 5 retries per episode via
    `LISTEN_RETRY_CEILING` in `src/routes/listen.ts` (reproducible check:
    `grep -nE 'export const LISTEN_RETRY_(ADDR_RATE|TOKEN_RATE|CEILING)' src/routes/listen.ts`, pinned by
    `tests/listen_activity_test.ts` tests "retry is rate-limited per feed token and client address (audio-feed-8jzgl)",
    "retry is rate-limited per feed token even from fresh addresses (audio-feed-8jzgl)", and
    "retry has a lifetime ceiling per episode that no retry resets (audio-feed-8jzgl)").
  - The listen page (`GET /listen/:token`) and its status poll (`GET /listen/:token/status`) are
    rate-limited before ANY store work: 60 page loads and 120 status polls per 5 min per
    (route, address) across independent sliding windows (audio-feed-l11jx, audio-feed-cfogj;
    constants `LISTEN_PAGE_RATE` and `LISTEN_STATUS_RATE` in `src/routes/listen.ts`,
    namespaces `listen_page` and `listen_status`; reproducible check:
    `grep -nE 'LISTEN_(PAGE|STATUS)_RATE' src/routes/listen.ts`, pinned by
    `tests/listen_read_limit_test.ts` test "the listen read bounds are the documented numbers, written as literals (audio-feed-cfogj)").
    By design, the bare `/listen` landing page (`renderListenLanding`, covered in Boundary 4) is
    unbounded: it is a store-free template render with no token and no tenant reads, so read
    limits do not cover it.
  - Feed routes (`GET /feed/:token/master.xml` and `GET /feed/:token/:sourceId/:mode.xml`) are
    rate-limited before ANY store work (audio-feed-oxyp1; `refuseFeedRead` in `src/compose/feeds.ts`): dual
    sliding windows in the shared metadata store bound requests per client IP (`FEED_IP_RATE`: 120
    per 5 min) against token enumeration and per capability token (`FEED_TOKEN_RATE`: 60 per 5 min)
    across aggregator IPs and client apps, returning a clean 429 with `Retry-After`.
  - Feed generation work per request is bounded (audio-feed-oxyp1; `publishableEpisodes` and the
    `FEED_EPISODE_CAP` / `FEED_MAX_PAGES` / `FEED_MAX_SCAN_PAGES` / `FEED_MAX_HEAD_CALLS` constants in
    `src/compose/feeds.ts`): `publishableEpisodes` asks the store for publishable episodes (`publishable: true`)
    so unpublishable noise (pending/failed/synthesizing) never consumes a page slot, scans at most
    `FEED_MAX_PAGES` (3 pages of `FEED_EPISODE_CAP` = 200) once it has found one,
    `FEED_MAX_SCAN_PAGES` (10 pages) only while it has found nothing, never calls blob `head()` on
    an unpublishable episode, and caps those calls at `FEED_MAX_HEAD_CALLS` (30) for legacy records
    lacking `byteLength`.
  - Capability keys are redacted from logs and error URLs (`src/router.ts`, `redactAudioKey`,
    `sanitizeRequestUrl`).
  - **Audio enclosure URL lifetime vs rotation (audio-feed-3wenc):** `/audio/:key+` URLs are bearer
    capabilities that embed the user id and episode id (`audio/<userId>/<mode>/<id>.<ext>`), but do NOT
    embed the feed token (`enclosureUrl` in `src/feed/adapter.ts`). Rotating a feed token (`POST /api/account/rotate-token`
    or `POST /api/admin/users/:id/rotate-token`) invalidates the feed XML (`/feed/:token/...`) and web
    player (`/listen/:token/...`) with uniform 404 ("Unknown feed"), revoking podcast client updates
    and web playback. It intentionally does NOT invalidate already-syndicated enclosure URLs: podcast
    clients poll feeds over months, audio responses are cached `public, immutable`, and the audio route's
    pre-blob gate (`checkUserApproval`, called from `handleAudio` in `src/routes/audio.ts`) verifies only that the owning user
    is in `approved` status. The only server-side kill switch for audio enclosure access is account
    suspension (which marks `user.status` away from "approved", causing `checkUserApproval` to refuse
    with uniform 404 "Unknown audio object") or episode deletion.
- **Residual (documented, accepted):** a leaked capability is a bearer credential, valid until
  rotated; rotation is subscriber-initiated (`POST /api/account/rotate-token`) or admin-initiated
  (`POST /api/admin/users/:id/rotate-token`), and neither can reach a device that already downloaded
  episodes — see the offline-cache section below (enclosure URLs already syndicated also survive
  feed-token rotation until account suspension, audio-feed-3wenc). The retry ceiling is intentionally small; a
  persistently failing episode is an owner problem by design (constant `LISTEN_RETRY_CEILING` in
  `src/routes/listen.ts`; reproducible check: `grep -nE 'export const LISTEN_RETRY_CEILING' src/routes/listen.ts`,
  pinned by `tests/listen_activity_test.ts` test "retry has a lifetime ceiling per episode that no retry resets (audio-feed-8jzgl)").
  Feed reach is bounded by RAW records, not only by publishable ones: `listEpisodePage`'s `limit`
  bounds the underlying scan and the `publishable` filter runs over the page it returns, so once a
  request has found one publishable episode the loop stops after `FEED_MAX_PAGES` x
  `FEED_EPISODE_CAP` = **600 raw index entries** — ready episodes past that are missing from a
  non-empty feed. The 2,000-record `FEED_MAX_SCAN_PAGES` ceiling therefore applies only to a request
  that found NOTHING, which is also the only case the `feed.scan_ceiling_reached` warning covers;
  the non-empty truncation logs `feed.publishable_page_cap_reached`.

### Boundary 2 — Feed-token APIs (capability-token account surface)

- **Routes:** `POST /api/ingest`, `POST /api/upload`, `GET/POST /api/sources`, `GET /api/episodes`
  (the matching `router.post`/`router.get` lines in `createRouter`, `src/app.ts`).
- **Attacker controls:** the presented token (`x-feed-token`, `x-user-token`, or `Authorization:
  Bearer`; `TOKEN_HEADERS` and `presentedToken` in `src/compose/shared.ts`) and, on ingest/upload, the URL or document content.
- **Mitigation:** both ingest and upload resolve through `authorizeIngest`
  (`src/compose/ingest.ts`): an explicit token goes through `approvedUserFor` (boundary 1's
  gate); a cookie-only request must ALSO pass the strict same-origin wall, because a cookie is
  ambient. Both paths require an approved user.
- **Mitigation (audio-feed-kp30l):** accepted episode CREATION is capped per subscriber. Both routes
  compose `authorizeIngest` with `refuseIngestOverCreationCap` (`src/compose/ingest.ts`; on the two
  creating routes the pair is composed by `authorizeIngestWithCap`), which counts
  one hit in a shared 24-hour `SlidingWindowRateLimiter` window (`INGEST_CREATION_RATE`, 50 per
  rolling 24 hours, namespace `ingest_creation`, row keyed on the USER id — the account whose token
  pays, not the address). The check runs inside `authorize`, i.e. after identity resolves and BEFORE
  the article fetch and before `putArticleWithEpisode` commits, so a refused submit costs one window
  write, no fetch, and no queue row. The refusal is `429` carrying the bound's name
  (`episode_creations_per_token`), the limit, the window and a `retry-after`.
- **Residual (partly mitigated, recorded):** **why the count is on creations, not on spend.** The
  daily counters increment only in the same atomic commit that marks an episode `ready`
  (`atomicPutEpisode` in `src/storage/kv/episodes.ts`), so a paid attempt that ends `failed` is spent and never
  counted — and counting attempts instead would change what the daily budget MEANS (one broken
  article consuming three of a subscriber's fifty) while still not bounding how many episodes exist.
  Creation is what a token chooses and is countable before anything is paid. The shared
  ingest/upload/periodic-poll/initial-subscription-poll creation window bounds that subset to **50 creations x `maxAttempts`
  3 = 150 paid attempts** per rolling 24 hours at the default funded budget; operator
  actions are outside this window. A same-URL resubmission — which IS
  a new episode by request
  (the `putArticleWithEpisode` comment in `createArticlesRepository`, `src/storage/kv/articles.ts`) — is charged like any other creation.
- **Residuals that remain:** (a) those 150 attempts still do not reach the completion counter: the
  bound limits how many episodes can be attempted, not how spend is accounted, and the per-episode
  segment/attempt ceilings still multiply per episode (see boundary 8). (b) The cap covers
  the *refusal* on user-initiated submits (/api/ingest and /api/upload), and since audio-feed-jgois
  subscription creation is bounded by a source ceiling code-tied to `dailyEpisodeBudgetFor`
  (`sourceCeilingFor`, bound `sources_per_subscriber`), refusing the (N+1)th source at no credit cost.
  Initial subscription polls and periodic feed polls both consume the SAME rolling 24h funded creation
  limiter as ingest/upload to defer new items beyond the subscriber's remaining allowance, leaving them
  unmarked for subsequent polls; they never refuse subscriptions or discard feed updates. Initial subscription
  polls queue at most 5 items per source and hold offset 0 when deferred; periodic feed polls are bounded
  by 10 items per source per poll: 96 polls/day across S sources could otherwise enqueue up to 960 x S episodes/day.
  Polls examine at most 100 feed items' URLs per source per tick, walking
  past seen URLs to select up to 10 unseen items; a persisted offset resumes a scan window on the
  next tick when 100 lookups were insufficient. Polls log deferred counts, remaining allowance,
  and exhausted scan windows per source. Parsing the fetched XML document is still proportional
  to its byte size; the bound limits metadata URL lookups, not feed download or XML parsing.
  (c) One subscriber's cap does not
  bound the fleet: N approved subscribers multiply it, which is why the global daily episode budget
  exists (boundary 8). (d) A submission that fails URL validation or the fetch still consumed its
  slot, so a mistyped URL costs a legitimate subscriber one of fifty — accepted: the count has to
  precede the fetch for the refusal to be cheap. (e) A deferred item is only deferred, never held:
  the poll writes nothing for it, not even its URL. If the feed drops that item — the publisher
  rotates its window, or truncates the document — before the subscriber's allowance comes back, no
  later poll can find it and that episode is lost silently. (f) The 10-items-per-poll drain has no
  catch-up: a source that publishes faster than a poll can drain keeps a backlog that only grows,
  so items near the end of the scan can stay unseen indefinitely. Deferral closes neither one:
  closing (e) would need the deferred URLs stored somewhere that outlives the feed document, and
  closing (f) would need a drain rate that can exceed a publisher's rate.

### Boundary 3 — Anonymous browser writes

- **Routes:** `POST /api/auth/login/options`, `POST /api/auth/register/options`,
  `POST /api/request-access`, `POST /api/cwv`, `POST /api/reports/csp` (+ its `router.add("OPTIONS", …)`
  alias) — each the matching registration line in `createRouter` (`src/app.ts`) — plus `GET /share`
  which only validates
  a shared URL as http/https and redirects signed-in subscribers to the quick-add panel
  (`isValidWebUrl` and `handleShare` in `src/routes/share.ts`).
- **Attacker controls:** everything — no credential exists; the only varying input is the client
  address and the body.
- **Mitigations:**
  - The passkey challenge write is bounded per address BEFORE the handler mints a challenge: 60 per
    5 min, with the window equal to the challenge TTL so an address can never hold more than 60 live
    challenge rows, and unaddressed clients collapsed onto a dedicated limiter key
    (audio-feed-plmhk; `LOGIN_OPTIONS_RATE` and the `loginOptions` handler's check in
    `src/routes/account_api.ts`; reproducible check:
    `grep -n 'LOGIN_OPTIONS_RATE' src/routes/account_api.ts`). The verify halves
    (`login/verify`, `register/verify`) require a challenge minted by the options call
    (single-use, TTL `CHALLENGE_TTL_MS`, `src/auth/passkeys.ts`), so this bound caps verify attempts too.
  - Request-access: 5 per hour per IP, atomic email dedup that does not reveal an account's
    existence or status, tokens never returned to the applicant (audio-feed-r97/oxw5g/2zvc;
    `createRequestAccessHandler` and `REQUEST_ACCESS_NAMESPACE` in `src/compose/access.ts`, whose
    header comment states the atomic-dedup rule).
  - The CWV beacon is a typed record, not request fields, with a 4 KiB body cap and a 60/min per
    client window (`MAX_CWV_BODY_BYTES` and `CWV_RATE_LIMIT` in `src/routes/cwv.ts`; the record is
    built by `parseCwvReport` in `src/observability/cwv.ts`).
  - CSP reports: see the origin-policy section below (untrusted or absent `Origin` accepted with 204
    but never stored, never budgeted).
- **Residual (documented, accepted):** origin-less CSP reports from legacy WebKit engines are
  invisible by policy (existing section below). No other write in this class is unbounded.

### Boundary 4 — Session APIs and pages

- **Routes:** `POST /api/auth/logout`, the 9 `/api/account/*` routes, `POST /api/auth/login/verify`,
  `POST /api/auth/register/verify`, `GET /account`, `GET /login`, `GET /add`, and the bare `GET
  /listen` — each the registration line naming that pattern in `createRouter` (`src/app.ts`).
- **Attacker controls:** a cross-site browser context (CSRF position); a stolen session cookie if
  they have one.
- **Mitigations:**
  - A session is a random secret in a `__Host-af_session` cookie (`SESSION_COOKIE` in
    `src/auth/sessions.ts`);
    `__Host-` forces Secure, Path=/ and no Domain (`sessionCookie` in the same file), and the store holds
    only its hash (the header comment of `src/auth/sessions.ts`, and `hashSecret`, which every write
    goes through).
  - Every state-changing session API sits behind the strict same-origin wall
    (`crossOrigin`, which wraps `sameOrigin` in `src/routes/account_api.ts`); admin reads use the looser
    `sameSiteRead` so legitimate
    same-origin GETs without an Origin header succeed while cross-site requests are refused
    (the `sameSiteRead` branch of `adminGate`, `src/compose/admin.ts`).
  - **The read wall admits a request carrying NEITHER `Sec-Fetch-Site` NOR `Origin`**
    (`sameSiteRead` in `src/auth/sessions.ts`) — audio-feed-vfyte, decision below. The routes it gates today
    are all pure reads, listed and pinned in `tests/read_wall_population_test.ts`: `GET
    /api/episodes` (`callerUserFor` in `src/compose/shared.ts`), and `GET /api/admin/users`,
    `GET /api/admin/users/:id/sources`, `GET /api/admin/users/:id/episodes`, `GET /api/admin/stats`,
    `GET /api/admin/outbox` (`adminGate` in `src/compose/admin.ts`, safe methods only — writes on
    that gate use `sameOrigin`).
  - **Absent-both is admitted on purpose, and this wall is for reads only.** A cross-origin
    attacker cannot READ a read route's response: the same-origin policy blocks the body, and the
    session cookie is `SameSite=Lax`, so a cross-site subresource carries no credential at all. So
    fail-closing absent-both defends an attack that is not available, while 403ing real subscribers
    — legacy WebKit (< 16.4, iOS 15) and in-app WKWebViews send no Fetch Metadata and no `Origin` on
    a GET. That compatibility cost was bought for no security gain, so the fail-closed change
    (branch `fleet/csrf-absent`) was REJECTED as over-broad.
  - **The one read route with server-side work left the wall instead.** `POST
    /api/account/discover-feed` (the registration line in `createRouter`, `src/app.ts`) fetched a third-party page on the signed-in
    subscriber's behalf; it is now POST behind `sameOrigin` (the `crossOrigin` prelude,
    `src/routes/account_api.ts`, handler `discoverFeed`) with a per-subscriber rate limit and per-hop SSRF re-validation (23782a1e,
    audio-feed-oq4pz). **Rule for future authors: a cookie-authenticated route that does server-side
    work — an outbound fetch, a write, paid synthesis — uses `sameOrigin` on a state-changing
    method, never `sameSiteRead`.** Nothing in the type system or the router enforces that rule;
    the only check today is the pinned population in `tests/read_wall_population_test.ts`, which
    reddens when a new `sameSiteRead`-gated route appears unclassified.
  - The `/listen` bare path redirects an approved session to its capability URL with
    `cache-control: no-store` and `referrer-policy: no-referrer`, so the token is never written to
    localStorage (the inline `GET /listen` handler in `createRouter`, `src/app.ts`). When unauthenticated, it renders the bare landing page
    (`renderListenLanding` in `src/routes/listen.ts`; reproducible check:
    `grep -nE 'export function renderListenLanding' src/routes/listen.ts`, pinned by
    `tests/listen_test.ts` test "the bare /listen launch resolves the session server-side (audio-feed-b6nr)"), which is unbounded by design (store-free
    template render, no token, no tenant reads).
- **Residual (documented, accepted):** a stolen session cookie is a bearer credential until logout
  or `rotate-token`; nothing in code detects a replayed cookie from a second device.
- **Residual (documented, accepted):** the read wall's absent-both admission is a standing
  assumption that every gated route is a pure read. It is hand-maintained — a new side-effecting
  read route would silently inherit the admission and could be steered by a hostile page on legacy
  WebKit. Nothing refuses that at runtime; the pinned population test is the only tripwire.

### Boundary 5 — Admin surface (console, admin API, break-glass, observability API)

- **Routes:** the 6 `/admin*` pages, the 19 `/api/admin/*` routes, `POST /api/auth/bootstrap`
  (break-glass), and the observability API `GET /api/observability/errors` +
  `GET /api/observability/summary` — every one a registration line naming that pattern in
  `createRouter` (`src/app.ts`); the census command above counts them.
- **Attacker controls:** the whole unauthenticated internet; plus a subscriber session attempting to
  reach admin data.
- **Mitigations:**
  - ONE gate helper, `adminGate` (`src/compose/admin.ts`), so "a new admin route cannot be
    added without the token check by accident" (audio-feed-z2s): the normal path is session +
    `isActiveAdmin` + strict same-origin on writes / `sameSiteRead` on reads; the break-glass path is
    `x-admin-token`/Bearer checked by `requireAdminToken` (`src/auth/users.ts`); and an
    unconfigured `ADMIN_TOKEN` fails CLOSED (the `ADMIN_TOKEN is not configured` branch of `adminGate`;
    reproducible check: `grep -n 'is not configured' src/compose/admin.ts`). The admin pages render
    no subscriber data in the shell; data comes only from the gated API routes (`createRouter`'s
    admin-shell comment, `src/app.ts`).
  - Failed attempts on the header path AND bootstrap share ONE sliding-window lockout limiter
    (audio-feed-bns, store-shared so the bound holds across isolates; the `AdminGateDeps.limiter`
    path and the `guardSecretAuth` call in `adminGate`, `src/compose/admin.ts`, plus the matching
    `guardSecretAuth` call in the `bootstrap` handler, `src/routes/account_api.ts`). The lockout gates attempts before
    secret compare (audio-feed-pymwh), so candidates are not evaluated at line rate.
  - The observability API is a separate Bearer shared key, `timingSafeEqual`-compared, and closed
    when `AUDIOFEED_OBSERVABILITY_KEY` is unset (`presentedKey` and `authorise` in
    `src/routes/observability.ts`).
- **Residual (documented, accepted):** the break-glass token is a static configured secret with no
  expiry or rotation enforcement in code — rotation is an operational concern outside this repo.
  Admin-initiated feed-token rotation cannot reach a device's already-downloaded library
  (offline-cache section below). There is no recorded inside-actor boundary: an active admin is
  fully trusted by this model.

### Boundary 6 — Ingest fetch: the server fetching attacker-supplied URLs (SSRF)

- **Where:** the server-side half of `POST /api/ingest` and `POST /api/upload`, feed discovery on
  `POST /api/sources` and `POST /api/account/discover-feed` (audio-feed-oq4pz), and scheduled feed polling;
  implemented in `src/ingest/url.ts` and `src/ingest/feed.ts`.
- **Attacker controls:** the URL — and everything behind it — that the SERVER fetches, including
  redirect chains; a hostile feed also controls the content later narrated to the subscriber.
- **Mitigations (`src/ingest/url.ts`, `src/routes/account_api.ts`):** only global-unicast hosts are
  fetchable — loopback, LAN, metadata and transition ranges are denied (`isPublicAddress`); every redirect target is
  re-validated and chains are capped at 5 (`fetchArticle`, `fetchFeedDocument` and `discoverFeeds`, each
  raising its own `invalid or excessive redirect chain` `IngestError`; reproducible check:
  `grep -n 'excessive redirect chain' src/ingest/url.ts`); reads are bounded per
  content type in `fetchArticle` — `MAX_HTML_BYTES` 2 MiB for HTML and other non-PDF reads, `MAX_PDF_BYTES`
  10 MiB for PDF, chosen from the response's content type there — under the shared 15 s
  `TIMEOUT_MS` abort, and the PDF bound's
  parse-time residuals are recorded below; a public hostname that resolves to a private address is
  refused at the socket by `publicLookup`;
  feed discovery re-validates each redirect hop through `articleUrl` and `publicLookup`; `POST /api/account/discover-feed` is
  gated by the strict same-origin CSRF wall (`signedIn`, refusing GET via 405 Method Not Allowed) and
  rate-limited per subscriber (`DISCOVER_FEED_RATE` 30 requests / 5 min, `src/routes/account_api.ts`).
- **Residuals:** (a) the fetch walls bound WHERE the server fetches, and since audio-feed-kp30l the
  creation cap in boundary 2 is checked BEFORE the fetch, so one subscriber cannot exceed 50 accepted
  article fetches per rolling 24 hours through `/api/ingest` or `/api/upload`, and since
  audio-feed-ukuka and audio-feed-jgois periodic feed polls and initial subscription polls consume
  the same row too, so their accepted article fetches count against that same 50 rather than sitting
  outside it; `POST /api/sources` discovery (which fetches a feed document, not an article) and
  `POST /api/account/discover-feed` (which discovers feeds from a subscriber-provided page) remain
  outside the daily creation window, bounded instead by subscriber auth, strict same-origin CSRF,
  per-subscriber sliding-window rate limiting, 2 MiB / 15 s caps, per-hop public redirect re-validation,
  and public-unicast address validation. (b) Prompt injection and content
  integrity (partly mitigated, recorded — audio-feed-o9wew): publisher-supplied text reaches the
  reasoning LLM under delimiter fencing rather than raw. In `src/worker/script.ts`
  (`buildScriptPrompt`), every publisher-controlled field (`title`, `author`, `summary`,
  `body`) is length-capped before fencing (the `capped()` local, bound `DEFAULT_MAX_BODY_CHARS`
  12,000 chars), enclosed in field-specific XML-like tags (`<article_title>`,
  `<article_author>`, `<article_summary>`, `<article_body>` — the four names in `FENCE_NAMES`), stripped to a fixed point
  of all fence-tag variants across all four names (`UNTRUSTED_FENCE_TAG` and `fencedRegion`),
  and framed as untrusted data to analyze rather than instructions to follow (the framing text inside
  `buildScriptPrompt`). The repo pins this structural invariant in `tests/prompt_census_test.ts`
  (`EXPECTED_PROMPT_SITES`, which records `buildScriptPrompt` as "fenced", and the mutant tests
  "MUTANT: deleting the fence call flips buildScriptPrompt to unmitigated" and "MUTANT: deleting
  capped() from a field in buildScriptPrompt fails the cap check"). The prompt is sent to Gemini
  `generateContent` with Google Search grounding
  (`createGroundedScriptGenerator` in `src/worker/script.ts`), while the TTS builders
  (`formatNarrationIntro`, `formatNarrationPrompt` and `formatDialoguePrompt` in `src/tts/gemini.ts`,
  the three sites `EXPECTED_PROMPT_SITES` records as "transcript-only") are transcript-only without
  prompt instructions. What the
  fence CANNOT defend against: a fence reduces delimiter breakout and payload size, but does not
  eliminate semantic prompt injection. Injections that survive within the 12,000-character cap can
  still attempt to bias the model's reasoning or grounded retrieval; model-level instruction following
  is not guaranteed; and output-side effects in generated dialogue turns flow directly into TTS
  narration (`createGeminiSynthesizer` in `src/worker/synthesis.ts` and the `GeminiTtsClient`
  narration request in `src/tts/gemini.ts`). On the direct narration path,
  article text is read aloud verbatim. The blast radius remains narration audio content integrity,
  not code execution or server compromise.
- **Residual (documented, accepted) — a PDF parse outlives the request that refused it
  (audio-feed-ppikk, audio-feed-a3y; recorded on audio-feed-32leq):** `pdf-parse` accepts no
  `AbortSignal` into its worker loop, so the deadline is a `Promise.race` that answers 504 and
  abandons the promise rather than a cancellation — the abandoned parse keeps burning CPU until it
  finishes or the isolate recycles (the `activePdfParses` counter and the surrounding comment in
  `src/ingest/url.ts` state the limitation; the
  unabortable call is `pdfParse(bytes)` inside `parsePdfBounded`, and the race is the
  `Promise.race` in that same function). What IS bounded: input size — `MAX_PDF_BYTES`
  10 MiB (checked against `content-length` in `fetchArticle` and against the bytes themselves in
  `extractPdfArticle`); the WAIT — 504 at the 10 s `PDF_PARSE_TIMEOUT_MS` (raised by
  `parsePdfBounded`), preceded by a
  30 s bound on the upload body (the `readBounded` call in `createUploadIngestHandler`,
  `src/ingest/upload.ts`); and the NUMBER of parses running at
  once — `MAX_CONCURRENT_PDF_PARSES` **2**, where the slot is bound to the PARSE rather
  than to the request (the `parsePromise.then(releaseSlot, releaseSlot)` line in `parsePdfBounded`)
  and is therefore still held after a 504, and a request arriving
  with both slots held is refused 429 instead of being queued or started (the same function). WHY
  ACCEPTED rather than bounded: the only real bound is an abort inside `pdf-parse`, which the
  pinned dependency (the `pdfParse` import at the head of `src/ingest/url.ts`, `npm:pdf-parse@1.1.1`)
  does not expose, so no code in this repo can
  stop a run that has begun; and the counter is module state, so the cap is **per isolate**, not
  fleet-wide — the exposure is 2 x the isolate count, rising with the fleet rather than capped by
  it. The worst case the tree makes derivable: a subscriber is admitted at most 50 submissions per
  rolling 24 hours at the default budget — the cap IS that subscriber's funded budget, so an
  admin-set personal budget raises it (`refuseIngestOverCreationCap`,
  `src/compose/ingest.ts`, composed into `/api/ingest` and `/api/upload` by `authorizeIngestWithCap`) —
  so ≤ **50 x 10 MiB** of PDF per subscriber per day with **at most 2 parses executing at once per
  isolate**. Input size and document COUNT are bounded; parse DURATION is not, so the residual is
  CPU time proportional to document size, inside a per-isolate concurrency window rather than
  against a fixed CPU budget.
- **Residual (documented, accepted) — the .docx inflation ceiling bounds one document, not the
  number inflating at once (audio-feed-yl3bq; recorded on audio-feed-32leq):** a .docx arrives only
  through `POST /api/upload`, and only its `word/document.xml` entry is inflated
  (`extractDocxArticle`, `src/ingest/upload.ts`). The current bound
  is `MAX_DOCX_INFLATED_BYTES` **4 MiB**, enforced WHILE streaming: the inflated total is
  counted chunk by chunk and the read is refused the moment it crosses the ceiling
  (`inflateRawBounded`), so the allocation can never exceed the cap. A stored
  (`compressionMethod` 0) entry takes the same ceiling before use (the `compressionMethod` branch in
  `extractDocxArticle`), so choosing no
  compression does not dodge it. What happens when it is exceeded: `IngestError` 413 naming the
  4 MiB limit, answered as HTTP 413 carrying `limit: MAX_DOCX_INFLATED_BYTES`, with the reader
  cancelled in the `finally` of `inflateRawBounded` — the upload is rejected before extraction, before the
  192,000-byte `MAX_NARRATION_BYTES` check and before any paid call;
  three tests in `tests/upload_test.ts` pin the deflated and stored shapes: "extractDocxArticle rejects
  a deflated zip bomb DURING decompression, before allocation (audio-feed-yl3bq)", "POST /api/upload
  rejects a deflated .docx zip bomb with 413 naming the inflated limit (audio-feed-yl3bq)" and "POST
  /api/upload rejects a stored .docx whose document XML exceeds the inflated bound (audio-feed-yl3bq)". Compressed
  input is separately capped at `MAX_UPLOAD_BYTES` 10 MiB (read bounded in
  `createUploadIngestHandler`), the
  entry's declared size is re-checked against the real buffer (in `extractDocxArticle`), and extraction is a
  linear SCAN of the capped XML rather than a DOM (`extractDocxParagraphs`,
  audio-feed-heeem), so working memory stays proportional to the ceiling. WHY ACCEPTED rather than
  bounded further: 4 MiB is a **per-document, per-request** ceiling with no concurrency counter
  behind it — unlike PDF parsing there is no cap on how many inflations run at once and no 429
  shedding — so K concurrent uploads inflate K x 4 MiB at once. Worst case derivable: per upload at
  most 4 MiB of inflated XML, one linear scan over it, and extracted text limited downstream to
  192,000 narration bytes — a few MiB of transient allocation plus a linear pass, multiplied by the
  uploads a subscriber has in flight, whose COUNT the per-subscriber creation cap bounds — 50 per
  rolling 24 hours at the default budget (`refuseIngestOverCreationCap`, `src/compose/ingest.ts`). Two formats are NOT
  parsed at all: legacy `.doc` returns 415 and a bare zip archive returns 415 (the `detected.kind`
  branches in `createUploadIngestHandler`, `src/ingest/upload.ts`; reproducible check:
  `grep -n 'Zip archives are not supported\|Legacy .doc files' src/ingest/upload.ts`).


### Boundary 7 — Static, well-known and public pages

- **Routes:** `/`, `/sw.js`, `/manifest.json`, `/robots.txt`, `/icon.svg`, `/assets/:name`,
  `/.well-known/webauthn`, `/health`, `/assets/voices/:voice` — each the registration line naming
  that pattern in `createRouter` (`src/app.ts`).
- **Attacker controls:** nothing credential-bearing; some query parameters and the Asset name.
- **Mitigations:** HTML responses carry a per-response CSP nonce and the shared security-header set
  (`src/router.ts` `applySecurityHeaders`; `src/routes/csp.ts` `htmlResponse`/`newCspNonce`); assets
  are content-addressed (audio-feed-3xq, the `router.get("/assets/:name", …)` line in `src/app.ts`); voice samples are NOT public — the
  handler runs session → voice allowlist → cache/generate, and nothing before the allowlist check
  reads a blob or pays for generation (the guard-order comment at the head of
  `src/routes/voice-samples.ts` and the `isVoiceSampleName` refusal in
  `createVoiceSampleHandler`); the service worker
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
  with explicit handling of segments billed after a deadline fires (the segment and deadline
  constants in `src/tts/gemini.ts`; `MAX_TTS_SEGMENTS` bounds the segment count),
  under the limits in `src/synthesis/limits.ts`.
- **Residual (documented, accepted):** a synthesis job's provider cost can be incurred by content
  that later fails, and such an attempt does not increment the daily counters (they bill only at
  `ready`, the `atomicPutEpisode` commit in `src/storage/kv/episodes.ts`); accepted as the price of the feature. Since
  audio-feed-kp30l the number of episodes one subscriber can create per rolling 24 hours — and so the
  number that can fail — is bounded at 50 (boundary 2), so failed-attempt spend is bounded at 50 x
  `maxAttempts` 3 paid attempts per subscriber per day rather than unbounded.

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

## Offline audio cache — bounded size (audio-feed-g3noh), survives an update, not a sign-out (audio-feed-vnu4g)

- **Decision:** the offline audio cache (`audio-feed-offline-v1`, written by the player and served
  cache-first by the service worker for `/audio/`) deliberately survives a service-worker update —
  "the subscriber's own downloaded library must survive an update". That is NOT "must survive
  sign-out". The worker now deletes the whole offline audio cache (`audio-feed-offline-v1`) when
  the server confirms a DEVICE-initiated `POST /api/auth/logout` (either the no-script form, which
  303s, or the JSON call) or a device-initiated `POST /api/account/rotate-token` passing through
  its fetch handler; a failed call changes nothing.
  The shell cache (`audio-feed-shell-v2`) deliberately survives sign-out (audio-feed-9ooyy):
  it contains only install-critical shell assets (`/manifest.json`, `/icon.svg`) and unauthenticated
  public navigation shells. Sensitive authenticated views and capability-bearing routes (`/admin`,
  `/account`, `/listen`, `/login`, `/share`, `/feed`, `/add`) are strictly excluded at admission
  time via `Cache-Control: no-store / private` headers and the `SENSITIVE_PREFIXES` admission refuse list,
  so no authenticated or subscriber-specific responses are ever stored in `SHELL_CACHE`. Purging
  `SHELL_CACHE` on logout would break offline installability for subsequent users on a shared device
  without security benefit.
  Only device-initiated calls can purge: admin/remote token rotation and
  session expiry never contact the device, which keeps playing its downloaded library until it
  next connects. On `activate` the worker also sweeps superseded `audio-feed-shell-*` AND
  `audio-feed-offline-*` generations, so a future cache version bump cannot leave the old
  generation installed forever.
- **Cache bounding and eviction (audio-feed-g3noh, audio-feed-cby):** the offline audio cache is
  strictly bounded to `MAX_OFFLINE_BYTES` = 640 MiB (640 * 1024 * 1024 bytes) as primary budget,
  with `MAX_OFFLINE_EPISODES` = 20 entries as a secondary guard.
  Derivation: 640 MiB ~ 3.9 h of audio at 48,000 B/s (24kHz 16-bit mono WAV), ~61% of a 1 GB mobile
  quota ceiling, leaving headroom for shell cache, HTTP responses, and IndexedDB without risking
  quota eviction or storage crashes even with worst-case 64-segment episodes.
  Both writers — the player's foreground download (`src/assets/listen.js`) and the service worker's
  `backgroundfetchsuccess` handler (`src/routes/pwa.ts`) — stamp entries with a write-time `x-stored-at`
  header and perform oldest-first eviction after every put. Eviction never touches the shell cache,
  protects the freshly written entry (and on the client, the currently playing episode), and stops
  when only protected entries remain. An evicted episode remains fully playable online without disrupting
  playback semantics.
- **Why purge by name instead of sweeping keys:** the audio URLs in this cache are public capability
  URLs (`/audio/<key>`; the key IS the capability) and carry no feed token, so there are no
  token-bearing keys to match — a key sweep would be a no-op with extra reads. The navigation cache
  never stores token-bearing or authenticated paths in the first place (`SENSITIVE_PREFIXES`
  excludes `/admin`, `/account`, `/listen`, `/login`, `/share`, `/feed`, `/add`,
  audio-feed-s3f0, audio-feed-9ooyy).
- **Residual (documented, accepted):** admin suspension stops a subscriber's feed server-side but
  cannot reach a device to purge it — the device is never contacted — so a suspended account's
  already-downloaded episodes stay on disk until sign-out. Admin token rotation
  (`POST /api/admin/users/:id/rotate-token`, which rotates another subscriber's feed token
  remotely) has the same shape: the stale feed fails on the device's next refresh, but the
  already-downloaded episodes stay on disk and keep playing there until it next connects.

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
  drains at `batchSize` 5 per tick with a measured ~10.2 s per episode — all 50 spend within the first
  ~20-25 minutes of a UTC day (the `audio-feed-synthesis` job in `registerCronJobs`,
  `schedule: "*/2 * * * *"`, `src/cron.ts`, at `batchSize` 5
  per tick, `DEFAULTS.batchSize` in `src/worker/synthesis.ts`: 50 episodes needs 10 ticks = ~20 minutes minimum, plus ~50 s
  of batch work per tick). The per-episode ceiling cannot be grown by a bigger article either: narration
  input is capped at `MAX_NARRATION_BYTES` 192,000 bytes at accept for `/api/upload`
  (`src/ingest/upload.ts`) and at the worker's `maxInputBytes` preflight for every path, before any paid
  call.
- **Residual (documented, accepted):** the ceilings count COMPLETED episodes — billing commits atomically
  with `status: "ready"` (`src/storage/kv/episodes.ts`), so an attempt that spends TTS turns and then
  fails terminally is paid without incrementing the count. Each such episode is bounded (`maxAttempts` 3,
  `DEFAULT_MAX_CLAIMS` 3, the same 64-call / 192 KB caps) and the ingest request cannot force it
  deterministically: the request-time refusals — oversized narration, unreadable article, unapproved user
  — all happen before any paid call. So one request is a margin on the ceiling, not a way round it.
- **Residual (CLOSED by the creation cap — audio-feed-kp30l; recorded 2026-11-06):** accepted
  episode CREATION is capped per subscriber, so the failed-attempt spend this passage used to call
  UNBOUNDED is bounded. `authorizeIngestWithCap` (`src/compose/ingest.ts`) composes the
  identity gate (`authorizeIngest`) with `refuseIngestOverCreationCap`
  (same file) on both `/api/ingest` and `/api/upload` — the only two registrations that compose it — and since
  audio-feed-ukuka and audio-feed-jgois periodic feed polls and initial subscription polls consume
  the SAME row (`pollFeedSource` and `subscribeToFeed` in `src/ingest/feed.ts`), while subscription creation is bounded
  by `sourceCeilingFor` (`src/compose/ingest.ts`).
  The window is one `SlidingWindowRateLimiter` row: `INGEST_CREATION_RATE.windowMs` = 24 hours
  (the `INGEST_CREATION_RATE` constant), namespace `INGEST_CREATION_WINDOW` (`ingest_creation`, same file), keyed on the USER id —
  the account whose token pays, not the address — and the bound is that subscriber's own funded
  budget, `dailyEpisodeBudgetFor` (`src/worker/synthesis.ts`): an admin-set personal
  budget, else `DEFAULT_DAILY_EPISODE_BUDGET` **50** (`src/config.ts`). Cap and spend budget
  read one number, so the cap cannot refuse a day the budget would fund. The check sits inside
  `authorize`, i.e. after identity resolves and BEFORE the article fetch and before
  `putArticleWithEpisode` commits (`authorizeIngestWithCap` in `src/compose/ingest.ts`, called from
  `createUrlIngestHandler` and the upload handler), and
  a REFUSAL costs no credit: the refusal branch returns the active window unchanged rather than
  appending a hit (`SlidingWindowRateLimiter` in `src/auth/rate_limit.ts`), so it buys no fetch and commits no episode,
  and it answers `429` naming the bound (`episode_creations_per_token`), the limit, the window and
  a `retry-after` (the refusal branch of `refuseIngestOverCreationCap`). `tests/ingest_creation_cap_test.ts` pins the
  shape from the outside: "audio-feed-kp30l: one token is accepted up to the creation bound and the
  next submit is refused by name".
- **Residuals that remain (recorded):** (a) it is a ceiling, not an absence — the worst case at
  the default budget is 50 accepted creations x `maxAttempts` 3 claims x the per-episode **$9.70**
  provider ceiling quoted above = **$1,455 per rolling 24 hours** per subscriber, against the $485
  that 50 COMPLETED episodes cost, because the window bounds CREATIONS while the daily counters
  bill only at `ready` (`atomicPutEpisode`, `src/storage/kv/episodes.ts`) and a re-claim that resumes no
  persisted segment re-bills (`Synthesizer` in `src/worker/synthesis.ts`). (b) A creation whose fetch fails
  still consumed its slot, so a mistyped or unreachable URL costs a legitimate subscriber one of
  fifty — accepted: the count has to precede the fetch for the refusal to be cheap (boundary 2,
  residual (d)). (c) Initial subscription polls consume the SAME cap row as periodic polls and
  ingest/upload: when allowance is exhausted, initial polls DEFER items (queueing 0, holding offset 0)
  rather than bypassing the cap or refusing the subscription itself (`subscribeToFeed` in
  `src/ingest/feed.ts`, which defers and holds offset 0).
  Subscription creation is capped at `sourceCeilingFor` (`src/compose/ingest.ts`), derived from
  `dailyEpisodeBudgetFor` (50 by default), so subscribers cannot accumulate unbounded active sources;
  creating the (N+1)th source is refused with 429 (`SubscriptionLimitError`) and consumes no credit.
  (d) A periodic poll with no allowance left DEFERS rather than
  refuses: nothing is written for the item, not even its URL, and the scan offset is kept so the
  same window is retried (the `feedScanOffset` write-back in `pollFeedSource`, `src/ingest/feed.ts`, kept
  whenever `deferred > 0`) — so an item whose publisher drops
  it (window rotation, a truncated document) before the allowance comes back is LOST silently, and
  no later poll can recover it. (e) One subscriber's cap does not bound the fleet: N approved
  subscribers multiply it, which is why `GLOBAL_DAILY_EPISODE_BUDGET` (**500** paid episodes per
  UTC day, boundary 8) exists, and the fleet-wide throughput those 150 attempts are drawn from is
  720 ticks/day x 5 claims = 3,600 episode-attempts/day, shared across every subscriber.

## Explicitly trusted / non-threat register

**Rule:** Every entry in this register is an affirmative security decision made with concrete code
evidence, not a blanket waiver or permanent exemption. If a cited code anchor moves, changes signature,
is refactored, or a check command yields unexpected output, the entry must be re-checked against the
updated code. Whole-codebase negative claims must be accompanied by a reproducible verification command
and verified output. Any new candidate shape or scanner hit not explicitly listed here must still undergo
triage rather than being assumed benign. Under no circumstances may an admitted accepted residual or a broad
vulnerability class be declared a trusted non-threat shape.

This register enumerates known safe patterns and code structures that deterministic scanners or
nightly audits flag as candidate vulnerabilities, recording why each shape is deliberately trusted,
its concrete code anchor, and the exact command to verify the claim.

| # | Candidate scanner shape | Why trusted (non-threat justification) | Code anchor | How to check (reproducible command & verified state) |
|---|---|---|---|---|
| 1 | Dynamic code execution (`eval`, `new Function`, dynamic runtime evaluation) | The server runtime contains zero calls to `eval()`, `new Function()`, or dynamic code evaluation in `src/` or `main.ts`. All application modules and dependencies are statically imported, compiled, and strictly type-checked ahead of time. | Whole runtime (`src/`, `main.ts`) | `grep -rnE 'eval\(|new Function\(' src/ main.ts` (0 matches at `6ca30737`, verified 2026-11-09) |
| 2 | Command execution and process spawning (`Deno.Command`, `Deno.run`) | Neither `Deno.Command` nor `Deno.run` is used anywhere in server runtime source (`src/` or `main.ts`). Incoming request data never reaches a process spawner or system shell; requests are handled strictly in-process using standard Web and Deno runtime APIs. | Whole runtime (`src/`, `main.ts`) | `grep -rnE 'Deno\.Command|Deno\.run' src/ main.ts` (0 matches at `6ca30737`, verified 2026-11-09) |
| 3 | Service Worker shell cache prefix refuse list (`SENSITIVE_PREFIXES`) | `SENSITIVE_PREFIXES` is a static constant in worker source code acting as an admission refuse guard in `/sw.js` to exclude capability and authenticated routes from `audio-feed-shell-v2`; it is not mutable database state or user-controlled configuration. | `SENSITIVE_PREFIXES` in `src/routes/pwa.ts` — its definition, its injection into the `/sw.js` template, and the admission check | `grep -n -C 1 'SENSITIVE_PREFIXES' src/routes/pwa.ts` (confirms definition array, `/sw.js` template injection, and cache admission check) |
| 4 | Keyword and pattern hits on documentation, comments, and audit records | Text occurrences of security terminology (e.g. CSRF, SSRF, XSS, tokens, exploits) in markdown files (`docs/`, `THREAT_MODEL.md`, `README.md`) and code comments are architectural documentation, threat model definitions, and audit explanations, not executable runtime code or exposed endpoints. | `docs/**`, `*.md`, and the JSDoc block above `SENSITIVE_PREFIXES` in `src/routes/pwa.ts` | `git ls-files 'docs/**' '*.md' | grep -vE '\.(ts|js)$'` (confirms documentation files are non-executable text) and `grep -n -B 17 'export const SENSITIVE_PREFIXES' src/routes/pwa.ts` (confirms the cited code hit is inside a JSDoc block comment) |
| 5 | Static literal regular expression execution on length-bounded inputs (`RegExp.prototype.exec`, `RegExp.prototype.test`, `String.prototype.match`, `matchAll`) | Regular expressions across routing, key parsing, HTTP headers, rate limiting, and synthesis chunking execute static literal patterns without nested quantifiers over short, length-bounded inputs (URL paths, HTTP headers, XML tags from S3, IP addresses, bounded text chunks, model output). The regex execution class is NOT safe by construction: complex multi-line patterns like markdown code block extraction in `src/tts/gemini.ts` exhibited quadratic complexity under measurement and were replaced with a bounded hand-written scanner (`tests/c0gj_linear_complexity_test.ts`). | Whole runtime (`src/`, `main.ts`) | `grep -rnE '\.(exec|match|matchAll)\(' src/ main.ts` (36 matches at `34ae917d`, verified 2026-11-10; 25 static literal regex executions across 14 files, 9 Cache/Client/Storage calls, 2 URLPattern exec calls; 11 regex execution sites sit outside original 7 sampled anchors, 0 unanchored quadratic patterns) |
| 6 | Client-side browser `fetch()` invocations in frontend scripts — the modules under `src/assets/` and the inline scripts embedded in route modules | Every browser-side `fetch()` call in the frontend enumerates to one of: a same-origin `/api/...` path literal, a `/api/...` literal prefix concatenated with `encodeURIComponent()` segments, `ORIGIN + ...` (the origin the page was rendered with), or a capability audio URL this server minted (`episode.audioUrl`). Three wrappers forward a CALLER-supplied path into `fetch()` — `api(path, options)` in `src/assets/admin.js`, `send(method, path, body)` in `src/routes/account.ts` and `post(path, body)` in `PASSKEY_CLIENT` (`src/routes/shell.ts`) — so the guarantee is a property of their call sites, not of the wrapper signatures; the row 6 note below states the constraint those call sites satisfy today. | The 9 `fetch(` call sites in `src/assets/admin.js`, `home.js`, `cwv.js`, `listen.js` (3), `src/routes/account.ts` (2) and `src/routes/shell.ts` — enumerated by the command in the next column | `grep -rn 'fetch(' src/assets/ src/routes/ --exclude=pwa.ts` (15 hits at `07d8e60a`, verified 2026-11-10: 9 `fetch()` call sites — 6 in `src/assets/`, 3 inline in `src/routes/account.ts` and `src/routes/shell.ts` — plus 6 comment lines; the 4 `fetch(request)` service-worker passthroughs in `src/routes/pwa.ts` are row 7). **This command is `fetch(`-scoped: it enumerates the three wrapper DEFINITIONS above, not their call sites, so it cannot establish a call-site count — use the four-step method in "Register row 6 in detail" below.** |
| 7 | Service Worker fetch event listener request passthroughs | The service worker's `fetch` handler uses `fetch(request)` as a standard passthrough for un-cached network requests, navigation requests, and network-first strategies; it does not redirect requests to third-party hosts or bypass security headers. | The 4 `fetch(request)` passthroughs in `boundOfflineAudio`, `src/routes/pwa.ts` — enumerated by the command in the next column | `grep -n 'fetch(request)' src/routes/pwa.ts` (verifies all 4 fetch handlers pass through un-cached requests to origin) |
| 8 | Outbound S3/R2 client storage requests with path-shaped object keys | Storage operations target operator-configured endpoints (`#config.endpoint`) and enforce `assertSafeBlobKey(key)` prior to URL construction and SigV4 signing, preventing path traversal, dot segments (`..`), empty segments, or prefix escapes. | `#encodeKey` and `#objectUrl` on `S3BlobStore` (`src/storage/s3.ts`), and `assertSafeBlobKey` (`src/storage/blob_key.ts`) | `grep -n -C 2 'assertSafeBlobKey' src/storage/s3.ts src/storage/blob_key.ts` (confirms validation is executed in `#encodeKey` before `#objectUrl` builds request) |
| 9 | Offline evidence capture scripts and artifacts under `docs/evidence/**` | Artifacts under `docs/evidence/` are offline proof outputs (run records, PNG screenshots) committed for build and verification evidence; they are never mounted as static routes or served by the application HTTP server. | Offline directory `docs/evidence/**` | `grep -rn 'docs/evidence' src/ main.ts` (0 matches at `6ca30737`, verified 2026-11-09; confirms path is never referenced in server routing or static serving) |
| 10 | Dynamic regular expression construction (`new RegExp`) | Dynamic RegExp pattern construction is strictly limited to compile-time boundary constants escaped via `escapeRegExp()` (`CONFIRM_SHARED_BEGIN`/`CONFIRM_SHARED_END` in `src/routes/shell.ts`) and an internal hardcoded identifier array (`FENCE_NAMES` in `src/worker/script.ts`, which `UNTRUSTED_FENCE_TAG` is built from). Arbitrary user input is never interpolated into regular expressions. Dynamic regex construction is not trusted by class; new sites require explicit audit and register entry. | `CONFIRM_SHARED_BEGIN`/`CONFIRM_SHARED_END` (`src/routes/shell.ts`), `FENCE_NAMES` (`src/worker/script.ts`) | `grep -rnE 'new RegExp\(' src/ main.ts` (3 matches at `34ae917d`, verified 2026-11-10; 2 in `src/routes/shell.ts`, 1 in `src/worker/script.ts`, 0 unescaped user-input patterns; enforced by `tests/dynamic_regexp_population_test.ts`) |


### Register row 6 in detail — the path-forwarding helpers in inline scripts (audio-feed-fxeug)

Three browser-side helpers take a path instead of a fixed route and hand it straight to `fetch()`:

- `api(path, options = {})` — the helper `api` in `src/assets/admin.js`; 16 call sites, all
  in that file (module-scoped, so the file is the whole population).
- `send(method, path, body)` — the helper `send` in `src/routes/account.ts`; 13 call sites,
  all in that file. The `send` in `src/assets/cwv.js` is a same-name collision with a different signature
  (`send(metric, value)`), takes no path, and is not in this population.
- `post(path, body)` — the helper `post` in `PASSKEY_CLIENT` (`src/routes/shell.ts`); 11 call sites, none of
  them in `shell.ts` (see the enumeration method below).

**How these populations are enumerated (audio-feed-fxeug review correction, `a0f55db1`).** Counting
call sites for these three needs four steps, not one, and steps 2 and 3 are the ones an earlier
revision of this note skipped — it recorded `post(` as having **zero** call sites on the strength of
`grep -n 'post(' src/routes/shell.ts`, a single-file grep that returns only the definition, because
the call sites are in *different files*:

1. Locate the definition (`grep -rnE 'function (api|send|post)\(' src/`).
2. For a definition that lives inside a template literal, find which pages splice that literal into
   their own script: `post` is defined in `PASSKEY_CLIENT` (`src/routes/shell.ts`), exported, and
   interpolated into `renderLoginPage` (`src/routes/login.ts`) and `renderAccountPage`
   (`src/routes/account.ts`). Neither page imports the
   *function* — they import the string that inlines it — so the helper is in scope at runtime while
   being invisible to any import graph or single-file grep.
3. Grep the bare name across all of `src/` and `main.ts`, not one file: `grep -rnE '(^|[^.\w])post\('`.
   The leading guard drops the router method `router.post(` in `src/app.ts` and the same-named method
   declared in `src/router.ts`; prose and string decoys such as `" post(s) queued"` go with them, and
   the scope check in step 2 discards unrelated same-name helpers (the test-local `post` in
   `tests/regenerate_test.ts` builds a server-side `Request`; it is not the browser wrapper and is
   not in `src/`).
4. Read each surviving site's path argument. All three families were counted this way at `a0f55db1`:
   16 + 13 + 11 = **40 wrapper call sites**.

The row's own published check repeats that mistake one level out: it is a `fetch(`-scoped grep,
so it enumerates the three wrapper DEFINITIONS, not their call sites, and cannot establish a
call-site count — a reader who runs only the row re-derives "0 `post(` sites". Use the four steps
above; the row's check cell says so too.

Because the helpers accept any string, the guarantee row 6 records is a constraint on the CALL SITES:
**a path argument must be a same-origin string that begins with a single `/` — `//host/...` or a
scheme is a protocol-relative or absolute URL to another host and must never appear — and no part of
it may come from an attacker- or operator-supplied host.** What the row's enumeration actually shows
at `a0f55db1` (verified 2026-11-10; the previous revision of this note counted 29 at `07d8e60a`,
omitting all 11 `post(` sites):

- 40 wrapper call sites: 16 `api(`, 13 `send(`, 11 `post(`.
- **No caller passes a non-literal arbitrary path**, but "all callers pass same-origin literals" is
  imprecise and is corrected here: 25 pass a pure string literal and 15 build the path by
  concatenating a literal `/api/...` prefix with `encodeURIComponent(...)` segments
  (e.g. `"/api/account/sources/" + encodeURIComponent(id)`). Per family:
  - `api(` — 16 = 5 pure literals + 11 concatenated; enumerated by
    `grep -nE '(^|[^.\w])api\(' src/assets/admin.js`, which returns 17 lines: this 16 plus the
    declaration. Call-site line numbers are NOT reproduced here — they are positions inside a
    1,200-line inline script and rot on the next edit above them; the grep is the citation.
  - `send(` — 13 = 9 pure literals + 4 concatenated; enumerated by
    `grep -nE '(^|[^.\w])send\(' src/routes/account.ts`, which returns 14 lines: these 13 plus the
    declaration.
  - `post(` — 11 = **11 pure literals, 0 concatenated**, enumerated by
    `grep -rnE '(^|[^.\w])post\(' src/ main.ts` — 17 lines raw, discounted by step 3's guards to
    these 11 (declaration, `Router.post`'s own declaration, two `" post(s) queued"` prose decoys and
    one comment). The eleven, by
    PATH: `/api/auth/login/options` (twice in `renderLoginPage`, `src/routes/login.ts`),
    `/api/auth/login/verify` (twice there), `/api/auth/bootstrap` (there),
    `/api/auth/register/options` (twice there, once in `renderAccountPage`,
    `src/routes/account.ts`), and `/api/auth/register/verify` (twice there, once in
    `renderAccountPage`). Every one is a single-leading-slash same-origin `/api/...` string —
    no host, no scheme, no `//`, no concatenation, no variable component — so the constraint above
    holds for all 11 today. The defect this correction fixes is the undercount, not a live violation.
- **No call site in any family passes anything other than a literal or a literal-plus-
  `encodeURIComponent` concatenation** — no template-literal paths, no bare variables, no
  caller-supplied hosts.
- The one caller-supplied component inside a path is `action` in `act(userId, action, button)`
  (the `act` helper in `src/assets/admin.js`), appended to `/api/admin/users/<id>/`. `act(` has
  exactly two call sites and both pass a literal (`"approve"` and `"suspend"`), enumerated by
  `grep -nE '(^|[^.\w])act\(' src/assets/admin.js` (3 lines: the declaration plus the two calls),
  but `action` is
  caller-supplied by signature rather than fixed by construction, so that one site counts as
  concatenation.
- The direct, non-wrapper calls are `fetch("/api/request-access")`, `fetch("/api/cwv")`,
  `fetch("/api/upload")`, two `ORIGIN + "/listen/..."` calls (`ORIGIN` is the origin the page was
  rendered with), and `fetch(episode.audioUrl)` (a capability URL this server minted).

Residual, stated rather than softened: nothing enforces that constraint today, and the 11 `post(`
sites are the sharpest evidence of it — they went uncounted in this very note until `a0f55db1`. No
test inspects these call sites, so a future caller passing a server- or user-influenced absolute URL
would issue that request from the page — `fetch()` defaults to `credentials: "same-origin"`, so
cookies would not ride along, but the request, including whatever the caller put in its path or body,
would reach that origin, and this register would still be citing an enumeration that cannot see the
defect. Closing it needs enforcement in `src/` — a typed union of literal route strings on the three
helpers, or a test asserting every `api(`/`send(`/`post(` path argument starts with a single `/` —
not another edit to this file.
