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
- **Mitigation (audio-feed-kp30l):** accepted episode CREATION is capped per subscriber. Both routes
  compose `authorizeIngest` with `refuseIngestOverCreationCap` (`src/compose/ingest.ts`), which counts
  one hit in a shared 24-hour `SlidingWindowRateLimiter` window (`INGEST_CREATION_RATE`, 50 per
  rolling 24 hours, namespace `ingest_creation`, row keyed on the USER id — the account whose token
  pays, not the address). The check runs inside `authorize`, i.e. after identity resolves and BEFORE
  the article fetch and before `putArticleWithEpisode` commits, so a refused submit costs one window
  write, no fetch, and no queue row. The refusal is `429` carrying the bound's name
  (`episode_creations_per_token`), the limit, the window and a `retry-after`.
- **Residual (partly mitigated, recorded):** **why the count is on creations, not on spend.** The
  daily counters increment only in the same atomic commit that marks an episode `ready`
  (`src/storage/kv/episodes.ts:64-74`), so a paid attempt that ends `failed` is spent and never
  counted — and counting attempts instead would change what the daily budget MEANS (one broken
  article consuming three of a subscriber's fifty) while still not bounding how many episodes exist.
  Creation is what a token chooses and is countable before anything is paid. The shared
  ingest/upload/periodic-poll/initial-subscription-poll creation window bounds that subset to **50 creations x `maxAttempts`
  3 = 150 paid attempts** per rolling 24 hours at the default funded budget; operator
  actions are outside this window. A same-URL resubmission — which IS
  a new episode by request
  (`src/storage/kv/articles.ts:251`) — is charged like any other creation.
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
  - **The read wall admits a request carrying NEITHER `Sec-Fetch-Site` NOR `Origin`**
    (`src/auth/sessions.ts:139-152`) — audio-feed-vfyte, decision below. The routes it gates today
    are all pure reads, listed and pinned in `tests/read_wall_population_test.ts`: `GET
    /api/episodes` (`src/compose/shared.ts:113` via `callerUserFor`), and `GET /api/admin/users`,
    `GET /api/admin/users/:id/sources`, `GET /api/admin/users/:id/episodes`, `GET /api/admin/stats`,
    `GET /api/admin/outbox` (`src/compose/admin.ts:92` via `adminGate`, safe methods only — writes on
    that gate use `sameOrigin`).
  - **Absent-both is admitted on purpose, and this wall is for reads only.** A cross-origin
    attacker cannot READ a read route's response: the same-origin policy blocks the body, and the
    session cookie is `SameSite=Lax`, so a cross-site subresource carries no credential at all. So
    fail-closing absent-both defends an attack that is not available, while 403ing real subscribers
    — legacy WebKit (< 16.4, iOS 15) and in-app WKWebViews send no Fetch Metadata and no `Origin` on
    a GET. That compatibility cost was bought for no security gain, so the fail-closed change
    (branch `fleet/csrf-absent`) was REJECTED as over-broad.
  - **The one read route with server-side work left the wall instead.** `POST
    /api/account/discover-feed` (`src/app.ts:387`) fetched a third-party page on the signed-in
    subscriber's behalf; it is now POST behind `sameOrigin` (`src/routes/account_api.ts:104-107`,
    handler at `:483`) with a per-subscriber rate limit and per-hop SSRF re-validation (23782a1e,
    audio-feed-oq4pz). **Rule for future authors: a cookie-authenticated route that does server-side
    work — an outbound fetch, a write, paid synthesis — uses `sameOrigin` on a state-changing
    method, never `sameSiteRead`.** Nothing in the type system or the router enforces that rule;
    the only check today is the pinned population in `tests/read_wall_population_test.ts`, which
    reddens when a new `sameSiteRead`-gated route appears unclassified.
  - The `/listen` bare path redirects an approved session to its capability URL with
    `cache-control: no-store` and `referrer-policy: no-referrer`, so the token is never written to
    localStorage (`src/app.ts:202-228`).
- **Residual (documented, accepted):** a stolen session cookie is a bearer credential until logout
  or `rotate-token`; nothing in code detects a replayed cookie from a second device.
- **Residual (documented, accepted):** the read wall's absent-both admission is a standing
  assumption that every gated route is a pure read. It is hand-maintained — a new side-effecting
  read route would silently inherit the admission and could be steered by a hostile page on legacy
  WebKit. Nothing refuses that at runtime; the pinned population test is the only tripwire.

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
    `:118-140`; bootstrap at `src/routes/account_api.ts:354-357`). The lockout gates attempts before
    secret compare (audio-feed-pymwh), so candidates are not evaluated at line rate.
  - The observability API is a separate Bearer shared key, `timingSafeEqual`-compared, and closed
    when `AUDIOFEED_OBSERVABILITY_KEY` is unset (`src/routes/observability.ts:110-147`).
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
  fetchable — loopback, LAN, metadata and transition ranges are denied (`:53`); every redirect target is
  re-validated and chains are capped at 5 (`:238`, `:310-311`, `:348`, `:537`); reads are bounded at 2 MiB
  and 15 s (`:512-513`); a public hostname that resolves to a private address is refused (`:456-457`);
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
  (`buildScriptPrompt`, `:180-213`), every publisher-controlled field (`title`, `author`, `summary`,
  `body`) is length-capped before fencing (`capped()`, `:189`, bound `DEFAULT_MAX_BODY_CHARS`
  12,000 chars, `:49`), enclosed in field-specific XML-like tags (`<article_title>`,
  `<article_author>`, `<article_summary>`, `<article_body>`, `:124-138`), stripped to a fixed point
  of all fence-tag variants across all four names (`UNTRUSTED_FENCE_TAG` and `fencedRegion`,
  `:153-172`), and framed as untrusted data to analyze rather than instructions to follow
  (`:192-195`). The repo pins this structural invariant in `tests/prompt_census_test.ts:42` (mutant
  test at `:254-282`). The prompt is sent to Gemini `generateContent` with Google Search grounding
  (`src/worker/script.ts:468`), while the TTS builders (`src/tts/gemini.ts:1421`, `:1498`, `:2207`)
  are transcript-only without prompt instructions (`tests/prompt_census_test.ts:49-53`). What the
  fence CANNOT defend against: a fence reduces delimiter breakout and payload size, but does not
  eliminate semantic prompt injection. Injections that survive within the 12,000-character cap can
  still attempt to bias the model's reasoning or grounded retrieval; model-level instruction following
  is not guaranteed; and output-side effects in generated dialogue turns flow directly into TTS
  narration (`src/worker/synthesis.ts:1094`, `src/tts/gemini.ts:2116`). On the direct narration path,
  article text is read aloud verbatim. The blast radius remains narration audio content integrity,
  not code execution or server compromise.
- **Residual (documented, accepted) — a PDF parse outlives the request that refused it
  (audio-feed-ppikk, audio-feed-a3y; recorded on audio-feed-32leq):** `pdf-parse` accepts no
  `AbortSignal` into its worker loop, so the deadline is a `Promise.race` that answers 504 and
  abandons the promise rather than a cancellation — the abandoned parse keeps burning CPU until it
  finishes or the isolate recycles (`src/ingest/url.ts:805-808` states the limitation; the
  unabortable call is `:864`, the race `:872`). What IS bounded: input size — `MAX_PDF_BYTES`
  10 MiB (`:42`, checked against `content-length` at `:256` and against the bytes themselves at
  `:947`); the WAIT — 504 at the 10 s `PDF_PARSE_TIMEOUT_MS` (`:43`, `:841-852`), preceded by a
  30 s bound on the upload body (`src/ingest/upload.ts:499`); and the NUMBER of parses running at
  once — `MAX_CONCURRENT_PDF_PARSES` **2** (`:49`), where the slot is bound to the PARSE rather
  than to the request (`:866-868`) and is therefore still held after a 504, and a request arriving
  with both slots held is refused 429 instead of being queued or started (`:826-831`). WHY
  ACCEPTED rather than bounded: the only real bound is an abort inside `pdf-parse`, which the
  pinned dependency (`npm:pdf-parse@1.1.1`, `:10`) does not expose, so no code in this repo can
  stop a run that has begun; and the counter is module state, so the cap is **per isolate**, not
  fleet-wide — the exposure is 2 x the isolate count, rising with the fleet rather than capped by
  it. The worst case the tree makes derivable: a subscriber is admitted at most 50 submissions per
  rolling 24 hours at the default budget — the cap IS that subscriber's funded budget, so an
  admin-set personal budget raises it (`refuseIngestOverCreationCap`,
  `src/compose/ingest.ts:178-193`, composed into `/api/ingest` and `/api/upload` at `:216-219`) —
  so ≤ **50 x 10 MiB** of PDF per subscriber per day with **at most 2 parses executing at once per
  isolate**. Input size and document COUNT are bounded; parse DURATION is not, so the residual is
  CPU time proportional to document size, inside a per-isolate concurrency window rather than
  against a fixed CPU budget.
- **Residual (documented, accepted) — the .docx inflation ceiling bounds one document, not the
  number inflating at once (audio-feed-yl3bq; recorded on audio-feed-32leq):** a .docx arrives only
  through `POST /api/upload`, and only its `word/document.xml` entry is inflated
  (`extractDocxArticle`, `src/ingest/upload.ts:313`; entry located at `:353-378`). The current bound
  is `MAX_DOCX_INFLATED_BYTES` **4 MiB** (`:26`), enforced WHILE streaming: the inflated total is
  counted chunk by chunk and the read is refused the moment it crosses the ceiling
  (`inflateRawBounded`, `:190-218`), so the allocation can never exceed the cap. A stored
  (`compressionMethod` 0) entry takes the same ceiling before use (`:405-420`), so choosing no
  compression does not dodge it. What happens when it is exceeded: `IngestError` 413 naming the
  4 MiB limit, answered as HTTP 413 carrying `limit: MAX_DOCX_INFLATED_BYTES`, with the reader
  cancelled in `finally` (`:217`) — the upload is rejected before extraction, before the
  192,000-byte `MAX_NARRATION_BYTES` check (`:16`, `:845-872`) and before any paid call;
  `tests/upload_test.ts:544-604` and `:606-644` pin the deflated and stored shapes. Compressed
  input is separately capped at `MAX_UPLOAD_BYTES` 10 MiB (`:15`, read bounded at `:499-507`), the
  entry's declared size is re-checked against the real buffer (`:399-401`), and extraction is a
  linear SCAN of the capped XML rather than a DOM (`extractDocxParagraphs`, `:269-311`,
  audio-feed-heeem), so working memory stays proportional to the ceiling. WHY ACCEPTED rather than
  bounded further: 4 MiB is a **per-document, per-request** ceiling with no concurrency counter
  behind it — unlike PDF parsing there is no cap on how many inflations run at once and no 429
  shedding — so K concurrent uploads inflate K x 4 MiB at once. Worst case derivable: per upload at
  most 4 MiB of inflated XML, one linear scan over it, and extracted text limited downstream to
  192,000 narration bytes — a few MiB of transient allocation plus a linear pass, multiplied by the
  uploads a subscriber has in flight, whose COUNT the per-subscriber creation cap bounds — 50 per
  rolling 24 hours at the default budget (`src/compose/ingest.ts:178-193`). Two formats are NOT
  parsed at all: legacy `.doc` returns 415 (`:665-678`) and a bare zip archive returns 415
  (`:680-693`).


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
  that later fails, and such an attempt does not increment the daily counters (they bill only at
  `ready`, `src/storage/kv/episodes.ts:64-74`); accepted as the price of the feature. Since
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
  ~20-25 minutes of a UTC day (synthesis cron runs `*/2 * * * *`, `src/cron.ts:207`, at `batchSize` 5
  per tick, `src/worker/synthesis.ts:280`: 50 episodes needs 10 ticks = ~20 minutes minimum, plus ~50 s
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
  UNBOUNDED is bounded. `authorizeIngestWithCap` (`src/compose/ingest.ts:195-199`) composes the
  identity gate (`authorizeIngest`, `src/compose/ingest.ts:68`) with `refuseIngestOverCreationCap`
  (`:157-193`) on both `/api/ingest` and `/api/upload` (`:325`, `:365`), and since
  audio-feed-ukuka and audio-feed-jgois periodic feed polls and initial subscription polls consume
  the SAME row (`src/ingest/feed.ts:313-314`, `:658-662`), while subscription creation is bounded
  by `sourceCeilingFor` (`src/compose/ingest.ts`).
  The window is one `SlidingWindowRateLimiter` row: `INGEST_CREATION_RATE.windowMs` = 24 hours
  (`src/compose/ingest.ts:125-129`), namespace `ingest_creation` (`:131`), keyed on the USER id —
  the account whose token pays, not the address — and the bound is that subscriber's own funded
  budget, `dailyEpisodeBudgetFor` (`src/worker/synthesis.ts:339-352`): an admin-set personal
  budget, else `DEFAULT_DAILY_EPISODE_BUDGET` **50** (`src/config.ts:42`). Cap and spend budget
  read one number, so the cap cannot refuse a day the budget would fund. The check sits inside
  `authorize`, i.e. after identity resolves and BEFORE the article fetch and before
  `putArticleWithEpisode` commits (`src/compose/ingest.ts:195-199`, `src/ingest/url.ts:1130`), and
  a REFUSAL costs no credit: the refusal branch returns the active window unchanged rather than
  appending a hit (`src/auth/rate_limit.ts:137-145`), so it buys no fetch and commits no episode,
  and it answers `429` naming the bound (`episode_creations_per_token`), the limit, the window and
  a `retry-after` (`src/compose/ingest.ts:172-192`). `tests/ingest_creation_cap_test.ts` pins the
  shape from the outside: N accepted, the N+1th refused by name, and the refusal never reaching
  the fetch (`:97-131`).
- **Residuals that remain (recorded):** (a) it is a ceiling, not an absence — the worst case at
  the default budget is 50 accepted creations x `maxAttempts` 3 claims x the per-episode **$9.70**
  provider ceiling quoted above = **$1,455 per rolling 24 hours** per subscriber, against the $485
  that 50 COMPLETED episodes cost, because the window bounds CREATIONS while the daily counters
  bill only at `ready` (`src/storage/kv/episodes.ts:64-74`) and a re-claim that resumes no
  persisted segment re-bills (`src/worker/synthesis.ts:126-132`). (b) A creation whose fetch fails
  still consumed its slot, so a mistyped or unreachable URL costs a legitimate subscriber one of
  fifty — accepted: the count has to precede the fetch for the refusal to be cheap (boundary 2,
  residual (d)). (c) Initial subscription polls consume the SAME cap row as periodic polls and
  ingest/upload: when allowance is exhausted, initial polls DEFER items (queueing 0, holding offset 0)
  rather than bypassing the cap or refusing the subscription itself (`src/ingest/feed.ts:658-675`).
  Subscription creation is capped at `sourceCeilingFor` (`src/compose/ingest.ts`), derived from
  `dailyEpisodeBudgetFor` (50 by default), so subscribers cannot accumulate unbounded active sources;
  creating the (N+1)th source is refused with 429 (`SubscriptionLimitError`) and consumes no credit.
  (d) A periodic poll with no allowance left DEFERS rather than
  refuses: nothing is written for the item, not even its URL, and the scan offset is kept so the
  same window is retried (`src/ingest/feed.ts:426-440`, `:337`) — so an item whose publisher drops
  it (window rotation, a truncated document) before the allowance comes back is LOST silently, and
  no later poll can recover it. (e) One subscriber's cap does not bound the fleet: N approved
  subscribers multiply it, which is why `GLOBAL_DAILY_EPISODE_BUDGET` (**500** paid episodes per
  UTC day, boundary 8) exists, and the fleet-wide throughput those 150 attempts are drawn from is
  720 ticks/day x 5 claims = 3,600 episode-attempts/day, shared across every subscriber.
