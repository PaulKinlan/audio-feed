# audio-feed

Personal podcast feed generator powered by **Gemini 3.8 Flash TTS** on **Cloudflare Workers**
(D1 + R2 + Workflows + Queues).

Converts RSS feeds and on-demand web articles into custom podcast feeds with single-voice author
reads and two-voice deep dive analysis.

## Features

- **Direct Reads:** Clear narration (Ben Thompson style) announcing title, author, publish date, and
  full article read.
- **Deep Dives:** Two-voice dialogue (NotebookLM style) with an expert and a curious foil,
  incorporating ecosystem research and counter-perspectives.
- **Master & Per-Source Feeds:** Standard podcast RSS 2.0 / iTunes XML feeds compatible with Pocket
  Casts, Apple Podcasts, and Overcast.
- **On-Demand URL Ingest:** "Send-to-Audio" endpoint to ingest any article link from Telegram or
  web.
- **Admin Approval Gating:** Multi-user data model where new accounts require admin verification to
  prevent unauthorized Gemini API spend.

## Podcast Feeds & Syndication Topology

`audio-feed` publishes standard podcast RSS 2.0 / iTunes XML feeds with Atom self-links, pubDates,
episode durations, and authenticated audio enclosures (`/audio/...`). Feed URLs are secured via the
user's secret capability token (`feedToken`).

### 1. Master Aggregated Feed (`GET /feed/:token/master.xml`)

The Master Feed consolidates all published audio across all of a user's subscribed RSS feeds and
on-demand web ingests into a single unified podcast channel.

- **Unified Catalog:** Combines both Direct Narration and Deep Dive Dialogue episodes from all
  sources.
- **Unfiltered by Source:** The master feed represents the user's aggregated library across all
  subscribed sources.
- **Query Parameter Tolerance:** Any query parameters appended to the URL (such as `?sourceId=...`,
  `?t=...`, or client cache-busters) are intentionally ignored rather than rejected with HTTP 400.
  Real-world podcast clients and aggregators (Apple Podcasts, Overcast, Pocket Casts, AntennaPod)
  routinely append tracking, timestamp, and cache-busting parameters when polling feeds. Returning
  400 would break live subscriber playback. To subscribe to a specific source alone, use its
  dedicated per-source feed URL instead.
- **200-Episode Window:** Capped to the newest 200 ready episodes. This follows standard podcast
  publishing practice for aggregate feeds, preventing multi-megabyte XML payloads, mobile bandwidth
  exhaustion, and aggregator timeout errors. Older episodes beyond the 200 newest are omitted from
  the syndicated XML.

### 2. Per-Source Feeds (`GET /feed/:token/:sourceId/:mode.xml`)

Subscribers who prefer dedicated channels for specific publications or presentation styles can
subscribe to individual per-source feeds:

- **Modes:**
  - `:mode = direct` — Single-voice author narration (Stratechery style).
  - `:mode = deepdive` — Two-voice conversational analysis and debate (NotebookLM style).
- **200-Episode Window:** Each individual per-source feed is likewise capped to its newest 200 ready
  episodes using the same bounded window.

## Quickstart

```bash
# Install dependencies
npm install

# Run locally with Wrangler (local D1 + R2)
npm run dev

# Run all tests (Node + Vitest)
npm test

# Full local verification gate: asset build, TypeScript typecheck,
# wrangler deploy --dry-run, and the entire Vitest suite (~8s)
npm run gate

# Deploy to Cloudflare Workers (https://audiofeed.app)
npm run deploy
```

## Configuration

Bindings (`DB`, `AUDIO_BUCKET`, `EPISODE_WORKFLOW`, `FEED_POLL_QUEUE`) and non-secret variables are
configured in `wrangler.jsonc`. Secrets are uploaded via `npx wrangler secret put <NAME>`:

```env
# Gemini TTS Synthesis (Required secret)
GEMINI_API_KEY=<your-google-ai-studio-api-key>

# Admin Security Token (Required secret; 16+ chars recommended)
ADMIN_TOKEN=<your-secret-admin-passphrase>

# Optional: Observability endpoint token (secret)
# AUDIOFEED_OBSERVABILITY_KEY=<secret>

# Optional Origin Overrides (configured in wrangler.jsonc vars)
# PUBLIC_BASE_URL=https://audiofeed.app
# WEBAUTHN_RP_ID=audiofeed.app
# TRUST_PROXY_HEADERS=1
# Enable only behind a proxy that APPENDS the client address it saw. The rate limiter keys on the
# last x-forwarded-for entry for that reason: a caller that prepends a forged address is ignored
# rather than handed a fresh allowance.
# The advertised origin (feed URLs, redirects, WebAuthn RP ID) is pinned to the
# host of PUBLIC_BASE_URL, and a request arriving on any other host is answered
# 421 - the protection configures itself and does not depend on this variable.
# SET THIS ON A DEPLOYMENT: with neither PUBLIC_BASE_URL nor ALLOWED_HOSTS set the
# host gate has nothing it can accept, so every non-loopback request is answered
# 500 server_misconfigured (the body names PUBLIC_BASE_URL) instead of serving.
# ALLOWED_HOSTS only ADDS hosts (staging, a preview URL, a custom domain).
# Comma-separated; the PUBLIC_BASE_URL host and loopback are always accepted.
# ALLOWED_HOSTS=staging.audio-feed.example

# Optional: system default narration voice
# DEFAULT_VOICE=Aoede

# Optional: daily episodes synthesised per subscriber who has no budget of their own.
# Unset means 50. 0 means an unconfigured subscriber synthesises nothing.
# DEFAULT_DAILY_EPISODE_BUDGET=50

# Optional: daily paid episodes across ALL subscribers, together (audio-feed-m182).
# Unset means 500 — ten subscribers' worth of the default above. 0 means nothing is synthesised.
# GLOBAL_DAILY_EPISODE_BUDGET=500

# Optional: how many days of structured log records to keep (audio-feed-wzv9).
# Unset means 7. 0 keeps them indefinitely, which is opt-in because the store's cursor
# promises to know what it has dropped.
# LOG_RETENTION_DAYS=7
# Shared key for GET /api/observability/{errors,summary}. With it unset the API is CLOSED
# (503 observability_not_configured) rather than open, and that refusal names this variable so an
# operator is not left reading a generic failure. These two endpoints stay reachable when the host
# gate is refusing every other request, which is the case you most need them in (audio-feed-2tbv).
# See docs/observability-api.md.
AUDIOFEED_OBSERVABILITY_KEY=<shared-secret>
```

### Structured logs

Every process — the app, the synthesis worker and the cron ticks — writes one record shape into one
store, and the errors API reads that store rather than keeping a second log of its own.

```json
{
  "seq": 42,
  "time": "2026-10-11T09:05:00.108Z",
  "severity": "error",
  "type": "synthesis.failed",
  "message": "synthesis failed: TTS provider returned 503 after 3 attempts",
  "process": "storage",
  "correlationId": "epi-abc",
  "job": "synthesis",
  "episodeId": "epi-abc",
  "userId": "user-1",
  "phase": "terminal",
  "attempt": 2,
  "reason": "TTS provider returned 503 after 3 attempts",
  "durationMs": 184223,
  "context": { "status": "failed" }
}
```

- `seq` is the cursor: durable, monotonic, and the **only** ordering key. Timestamps collide and
  lose events, so `time` is for people and `seq` is for reading.
- `correlationId` carries one id through a request or a job, so every record about one episode —
  including every retry — reads as a single story. HTTP responses also echo it as
  `x-correlation-id`.
- Errors keep their `stack`, and the siv1 triple (`phase`, `attempt`, `reason`) is what makes a
  claim that dies mid-synthesis explainable: the claim is recorded before any work starts, so a
  process that never returns still leaves the phase it reached.
- **Capability tokens never reach the store.** Request paths are redacted to labels
  (`/listen/:token`, `/audio/:key`) before they become fields, query strings are never recorded, and
  the store redacts by field name as a second line of defence.
- `LOG_RETENTION_DAYS` (default 7) is enforced by a daily cron pass. `logBounds()` reports the
  oldest retained `seq`, so a reader holding an expired cursor can be told "cursor too old" instead
  of silently skipping records.

### Daily spend ceiling

Paid synthesis is capped per subscriber per UTC day. A subscriber can be given their own
`dailyEpisodeBudget` in the admin console; a subscriber without one is held to
`DEFAULT_DAILY_EPISODE_BUDGET` (50 by default) rather than being left uncapped. Episodes over the
ceiling are **deferred, not failed** — nothing is spent, and they are picked up the next day when
the counter resets. Deferrals are visible three ways: the run history records a reason naming the
ceiling and whether it was the subscriber's own budget or the deployment default, a subscriber held
by the default logs one line per run, and `GET /api/admin/stats` reports each subscriber's effective
ceiling plus a count of subscribers running on the default (`usersWithoutBudget`). There is no
setting that removes the ceiling: "effectively unlimited" is chosen by naming a large number.

### Fleet-wide spend ceiling

The per-subscriber ceiling bounds one subscriber, so total spend is still that number times the
number of approved subscribers — and approving one is a single action. `GLOBAL_DAILY_EPISODE_BUDGET`
(500 by default) caps paid episodes per UTC day across **all** subscribers together. It is resolved
the same way as the per-subscriber ceiling (an explicit value, then the deployment's config, then
the constant) and enforced at both the point where the worker decides who gets the batch and the
point where it spends, so no path that synthesises can miss it. Exceeding it defers work exactly as
the per-subscriber ceiling does: episodes stay pending and are served the next day.
`GET /api/admin/stats` reports `globalDailyEpisodeBudget`, `globalBudgetSource` (whether an operator
set it or it is the built-in number) and `globalEpisodesToday`, the usage the ceiling is measured
against.

Note the two interact by design: a subscriber on the default per-subscriber ceiling stops at 50, so
reaching a 500 fleet ceiling takes about ten of them. Raise the fleet number when you approve more
subscribers than that, or set per-subscriber budgets so the fleet ceiling is the one that bites.

### Default narration voice

When a source does not specify a narrator, the voice is resolved in this order:

1. the source's own `voices.direct`, if it was explicitly set;
2. the user's `voice` preference (set when the subscriber is created);
3. `DEFAULT_VOICE` from the environment;
4. `Charon`.

`DEFAULT_VOICE` must be one of `Aoede`, `Charon`, `Fenrir`, `Kore`, `Puck`. An unrecognised value
**fails at boot** rather than falling back silently — a typo would otherwise read every article in a
different voice while the deployment looked healthy.

Two things this deliberately does not do:

- **Deep dive dialogue is not affected.** `DEFAULT_VOICE` is a single name and a deep dive needs a
  pair (expert, foil); mapping one onto the other is a product decision, so the pair still falls
  back to `Kore` and `Puck`.
- **Existing sources keep their voice.** Sources created before this change were stamped with an
  explicit `Charon` at creation, so they resolve at step 1 and are unaffected. The precedence chain
  applies to sources created afterwards.

If storage variables are omitted locally, the app defaults to an in-memory blob store for offline
development and testing.

---

## Cloudflare Workers, D1, R2, Workflows & Queues

`audio-feed` runs natively on Cloudflare Workers (`src/worker_entry.ts`, configured in `wrangler.jsonc`):

- **Cloudflare D1 (`DB`)**: SQLite metadata store (`migrations/0001_initial.sql`) with chunked
  article storage and batched URL deduplication.
- **Cloudflare R2 (`AUDIO_BUCKET`)**: Native binding (zero S3 credentials needed in production) with
  same-origin HTTP Range playback and streaming **R2 Multipart Upload** WAV assembly (~16 MB
  constant peak RAM for multi-hour episodes).
- **Cloudflare Workflows (`EPISODE_WORKFLOW` — `EpisodeSynthesisWorkflow`)**: Durable per-episode
  synthesis pipeline where each TTS segment runs as an independent `step.do(...)` with exponential
  backoff and `step.sleepUntil(nextUtcMidnight)` on daily budget limits.
- **Cloudflare Queues (`FEED_POLL_QUEUE` — `audio-feed-poll` / `audio-feed-poll-dlq`)**: `*/15`
  cron fans out due RSS sources so each feed polls inside an isolated Worker with automatic retries.

See `docs/cloudflare-migration.md` for provisioning, D1 migrations, and passkey recovery details.

---

## Admin Endpoints & User Management

To protect against unauthorized Gemini TTS spending, audio synthesis requires an approved user
bearer token (`feedToken`).

### Admin Approval Endpoint

- **URL:** `POST /api/admin/users/:id/approve`
- **Headers:** `x-admin-token: <ADMIN_TOKEN>` (or `Authorization: Bearer <ADMIN_TOKEN>`)

Failed admin token attempts on header routes and `/api/auth/bootstrap` are rate-limited per client
IP (10 failed attempts per 5-minute sliding window) to prevent brute-force attacks. Tokens under 16
characters emit a startup/admin advisory warning.

Example:

```bash
curl -X POST https://audiofeed.app/api/admin/users/usr_12345/approve \
  -H "x-admin-token: your-secret-admin-passphrase"
```

### Background Workers & Manual Triggers

Background jobs run on Cloudflare Cron Triggers, Queues, and Workflows:

- **`*/15 * * * *`**: Enqueues all due RSS/Atom feeds onto `FEED_POLL_QUEUE` (`audio-feed-poll`).
- **`*/2 * * * *`**: Safety-net sweep that triggers `EpisodeSynthesisWorkflow` for any unstarted
  pending episodes.
- **`17 4 * * *`**: Enforces structured log retention (`LOG_RETENTION_DAYS`).

Operators can trigger immediate batch runs on demand via the `/admin` console UI ("Poll Feeds Now"
and "Synthesize Queue Now" buttons) or directly via REST API:

```bash
# Immediately poll all due RSS feeds
curl -X POST https://audiofeed.app/api/admin/poll-now \
  -H "x-admin-token: <your-admin-token>"

# Immediately run a synthesis batch on pending episodes
curl -X POST https://audiofeed.app/api/admin/synthesize-now \
  -H "x-admin-token: <your-admin-token>"
```

---

## Send-to-Audio (Ingest)

Approved users can submit articles to be synthesized:

1. **Web UI:** Open `GET /` (`https://audiofeed.app/`), enter the article URL,
   select the mode (_Author narration_ or _Two-voice dialogue_), and enter your `feedToken`.
2. **REST API:**

```bash
curl -X POST https://audiofeed.app/api/ingest \
  -H "content-type: application/json" \
  -H "x-feed-token: <your-feed-token>" \
  -d '{"url":"https://example.com/article","mode":"dialogue"}'
```

### Real-voice upload acceptance (cost-marked, dry by default)

The offline test suite proves ingest → worker → READY with an injected stub synthesizer; it cannot
catch a real Gemini TTS failure by construction. One command closes that gap with a single small
real document (one segment, seconds of audio), and it **spends money only when you say so**:

```bash
# DRY (default): prints the plan, the token estimate and the worst-case spend. No network.
deno run --allow-net --allow-env --allow-read --allow-write scripts/real-voice-upload-acceptance.ts

# LIVE: boots the app in-process with the production synthesizer, uploads one small real
# document through POST /api/upload, waits for the episode, prints episode id, state,
# audio bytes, duration and observed cost, and writes the WAV to a temp path to listen to.
GEMINI_API_BASE_URL=https://gemini.int.exe.xyz/v1beta \
  deno run --allow-net --allow-env --allow-read --allow-write scripts/real-voice-upload-acceptance.ts --live

# Same, and afterwards it deletes the created episode, article, audio blob and temp WAV.
# (Stores are in-memory regardless: nothing but the temp WAV can outlive the process.)
... --live --cleanup
```

It prints the price schedule it used (gemini-3.8-flash-tts: $0.50/$9.00 per 1M input/output audio
tokens promotional through 2026-12-31, then $1.00/$18.00 — Google Cloud TTS pricing), an exact
input-token count from the provider's free `countTokens` before spending, the worst case from the
provider caps (~$9.70 per invocation promotional at the 64-segment ceiling, audio-feed-cco6g;
output cannot be known before generation), and
afterwards the observed cost derived from measured duration at Google's documented 25 audio
tokens/second. Expected cost for the built-in document: a fraction of a cent. A run passes only if
the episode reaches READY with decodable audio — listen to the WAV; the acceptance is the voice, not
the status code.
