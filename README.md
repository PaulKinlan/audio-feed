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

## Quickstart

```bash
# Run locally with Deno
deno task dev

# Run all tests
deno test -A
```

## Configuration

Set the following environment variables on Deno Deploy or in your local `.env`:

```env
# Gemini TTS Synthesis (Required)
GEMINI_API_KEY=<your-google-ai-studio-api-key>

# Admin Security Token (Required for user approvals)
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
```

If storage variables are omitted locally, the app defaults to an in-memory blob store for offline development and testing.

---

## Cloudflare R2 Object Storage Setup

When configuring Cloudflare R2 for `audio-feed`:

### 1. Endpoint vs Bucket Name Split

Do not combine the bucket name into the endpoint URL. For a bucket URL such as `https://<account_id>.r2.cloudflarestorage.com/audio-feed`:

- **`STORAGE_ENDPOINT`**: `https://<account_id>.r2.cloudflarestorage.com` (host only, no trailing bucket or slash)
- **`STORAGE_BUCKET`**: `audio-feed` (the bucket name)

### 2. Securing the R2 Bucket & Generating API Credentials

Cloudflare R2 buckets are **100% private by default** — neither public writes nor unauthenticated reads are permitted:

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

`audio-feed` uses AWS SigV4 via `aws4fetch` to sign every PUT request directly from the Deno Deploy worker using these credentials.

### 3. Private Bucket Playback

Because the R2 bucket remains completely private, `audio-feed` automatically creates temporary **presigned GET URLs** (expiring in 1 hour) when podcast clients request episode audio. Podcast apps stream seamlessly without exposing public read or write access to the bucket.

---

## Admin Endpoints & User Management

To protect against unauthorized Gemini TTS spending, audio synthesis requires an approved user bearer token (`feedToken`).

### Admin Approval Endpoint

- **URL:** `POST /api/admin/users/:id/approve`
- **Headers:** `x-admin-token: <ADMIN_TOKEN>` (or `Authorization: Bearer <ADMIN_TOKEN>`)

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

---

## Send-to-Audio (Ingest)

Approved users can submit articles to be synthesized:

1. **Web UI:** Open `GET /` (`https://audio-feed.paulkinlan-ea.deno.net/`), enter the article URL, select the mode (*Author narration* or *Two-voice dialogue*), and enter your `feedToken`.
2. **REST API:**
```bash
curl -X POST https://audio-feed.paulkinlan-ea.deno.net/api/ingest \
  -H "content-type: application/json" \
  -H "x-feed-token: <your-feed-token>" \
  -d '{"url":"https://example.com/article","mode":"dialogue"}'
```
