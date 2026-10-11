# audio-feed

Personal podcast feed generator powered by **Gemini 3.8 Flash TTS** on **Deno Deploy**.

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
# Run locally with Deno
deno task dev

# Run all tests
deno test -A

# Fast tier while iterating: fmt + lint + type-check + only the tests your
# change affects (import graph + name convention; falls back to the full
# suite for deno.json/deno.lock, cross-cutting files, or uncovered code).
# Measured: ~11s for a typical route change vs ~65-108s for the full gate.
deno task test:fast
```

## Configuration

Set the following environment variables on Deno Deploy or in your local `.env`:

```env
# Gemini TTS Synthesis (Required)
GEMINI_API_KEY=<your-google-ai-studio-api-key>

# Admin Security Token (Required for user approvals; 16+ chars recommended)
ADMIN_TOKEN=<your-secret-admin-passphrase>

# Object Storage: Cloudflare R2 / S3 (Required in production)
STORAGE_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
STORAGE_BUCKET=audio-feed
STORAGE_ACCESS_KEY_ID=<cloudflare-r2-access-key-id>
STORAGE_SECRET_ACCESS_KEY=<cloudflare-r2-secret-access-key>
STORAGE_REGION=auto

# Optional Origin Overrides
# PUBLIC_BASE_URL=https://audio-feed.paulkinlan-ea.deno.net
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
# (503 observability_not_configured) rather than open. See docs/observability-api.md.
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

## Cloudflare R2 Object Storage Setup

When configuring Cloudflare R2 for `audio-feed`:

### 1. Endpoint vs Bucket Name Split

Do not combine the bucket name into the endpoint URL. For a bucket URL such as
`https://<account_id>.r2.cloudflarestorage.com/audio-feed`:

- **`STORAGE_ENDPOINT`**: `https://<account_id>.r2.cloudflarestorage.com` (host only, no trailing
  bucket or slash)
- **`STORAGE_BUCKET`**: `audio-feed` (the bucket name)

### 2. Securing the R2 Bucket & Generating API Credentials

Cloudflare R2 buckets are **100% private by default** — neither public writes nor unauthenticated
reads are permitted:

1. In the **Cloudflare Dashboard**, navigate to **R2 Object Storage**.
2. In the right-hand panel, select **Manage R2 API Tokens**.
3. Click **Create API token**.
4. Configure permissions:
   - **Permissions**: Select **Object Read & Write**.
   - **Apply to specific bucket**: Select `audio-feed` (recommended for least-privilege access).
5. Click **Create API Token**.
6. Cloudflare will display:
   - **Access Key ID** → set as `STORAGE_ACCESS_KEY_ID`
   - **Secret Access Key** → set as `STORAGE_SECRET_ACCESS_KEY`

`audio-feed` uses AWS SigV4 via `aws4fetch` to sign every PUT request directly from the Deno Deploy
worker using these credentials.

### 3. Private Bucket Playback

Because the R2 bucket remains completely private, `audio-feed` automatically creates temporary
**presigned GET URLs** (expiring in 1 hour) when podcast clients request episode audio. Podcast apps
stream seamlessly without exposing public read or write access to the bucket.

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
curl -X POST https://audio-feed.paulkinlan-ea.deno.net/api/admin/users/usr_12345/approve \
  -H "x-admin-token: your-secret-admin-passphrase"
```

### CLI User Provisioning Tool

To create and approve a subscriber directly, use `scripts/create-user.ts`:

```bash
# Provision a user against local or remote Deno KV:
deno run -A scripts/create-user.ts you@example.com "Your Name"

# To provision against a remote Deno Deploy KV database:
DENO_KV_ACCESS_TOKEN=... deno run -A scripts/create-user.ts you@example.com "Your Name" \
  --kv https://api.deno.com/databases/<database-id>/connect
```

This generates and displays:

- The user's secret `feedToken`
- The personal RSS Master Feed URL (`/feed/<token>/master.xml`)
- Ready-to-use curl and web submission parameters

### Background Workers & Manual Triggers

On serverless platforms like Deno Deploy, background workers operate on native `Deno.cron` to ensure
tasks run even when the HTTP isolate sleeps:

- **`audio-feed-poll-feeds` (`*/15 * * * *`)**: Polls due RSS/Atom feeds every 15 minutes.
- **`audio-feed-synthesis` (`*/2 * * * *`)**: Drains the pending synthesis queue every 2 minutes.

Operators can trigger immediate batch runs on demand via the `/admin` console UI ("Poll Feeds Now"
and "Synthesize Queue Now" buttons) or directly via REST API:

```bash
# Immediately poll all due RSS feeds
curl -X POST https://audio-feed.paulkinlan-ea.deno.net/api/admin/poll-now \
  -H "x-admin-token: <your-admin-token>"

# Immediately run a synthesis batch on pending episodes
curl -X POST https://audio-feed.paulkinlan-ea.deno.net/api/admin/synthesize-now \
  -H "x-admin-token: <your-admin-token>"
```

---

## Send-to-Audio (Ingest)

Approved users can submit articles to be synthesized:

1. **Web UI:** Open `GET /` (`https://audio-feed.paulkinlan-ea.deno.net/`), enter the article URL,
   select the mode (_Author narration_ or _Two-voice dialogue_), and enter your `feedToken`.
2. **REST API:**

```bash
curl -X POST https://audio-feed.paulkinlan-ea.deno.net/api/ingest \
  -H "content-type: application/json" \
  -H "x-feed-token: <your-feed-token>" \
  -d '{"url":"https://example.com/article","mode":"dialogue"}'
```
