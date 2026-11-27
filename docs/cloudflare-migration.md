# Migrating `audio-feed` from Deno Deploy to Cloudflare Workers (`audiofeed.app`)

This runbook moves production off Deno Deploy + Deno KV onto **Cloudflare Workers + Cloudflare D1 + Cloudflare R2** at **`https://audiofeed.app`**, preserving all users, `feedToken`s, RSS subscriptions, articles, episodes, R2 audio blobs, usage counters, and logs.

> **Why audio blobs don't need moving:** Production audio already lives in your Cloudflare R2 bucket. Every migrated episode keeps its exact `audioKey`, so playback works immediately once the existing R2 credentials are set on the Worker.
>
> **Why passkeys must be re-enrolled once:** WebAuthn passkeys are cryptographically bound to the old `audio-feed.paulkinlan-ea.deno.net` RP ID and cannot verify on `audiofeed.app` once Deno Deploy shuts down. The migration archives old passkey metadata for audit and starts `audiofeed.app` clean so every user re-enrols once on the domain you own.

---

## 1. Authenticate Wrangler & Provision D1

```bash
npx wrangler login
npx wrangler d1 create audio-feed
```

Copy the returned `database_id` into `wrangler.jsonc` (replacing `REPLACE_WITH_D1_DATABASE_ID`), then apply the schema migration to remote D1:

```bash
npm run d1:migrate:remote
```

Make sure `audiofeed.app` is added as a zone in your Cloudflare account (Workers Custom Domains will automatically provision DNS + TLS for `audiofeed.app` on `wrangler deploy`).

---

## 2. Configure Worker Secrets

Set the Worker secrets (your R2 bucket `audio-feed` is already bound natively via `AUDIO_BUCKET` in `wrangler.jsonc`, so no R2 S3 credentials are required):

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AUDIOFEED_OBSERVABILITY_KEY
```

*(Non-secret vars like `PUBLIC_BASE_URL="https://audiofeed.app"`, `WEBAUTHN_RP_ID="audiofeed.app"`, budgets, and retention are already configured in `wrangler.jsonc`.)*

---

## 3. Export All Live Data from Deno Deploy KV

In the Deno Deploy dashboard (`paulkinlan-ea`) → **Databases**, copy the KV **Database ID** (UUID) and use your Deno Deploy access token (`DENO_KV_ACCESS_TOKEN`):

```bash
DENO_KV_ACCESS_TOKEN="$DENO_DEPLOY" deno run \
  --allow-net --allow-env --allow-read --allow-write --unstable-kv \
  scripts/export-deno-kv.ts \
  --kv https://api.deno.com/v2/databases/<database-id>/connect \
  --out ./var/deno-kv-export.json
```

Check the summary output:
- Verify user, source, article, episode, and usage counts look right.
- Verify `Unknown KV prefixes` is absent (empty).
- Keep `./var/deno-kv-export.json` local (`var/` is gitignored) — it contains secret `feedToken`s.

---

## 4. Import Data into Cloudflare D1 & Verify Parity

Dry-run first (no writes):

```bash
npx tsx scripts/import-d1.ts --in ./var/deno-kv-export.json --remote --dry-run
```

Execute the import and automatic 1:1 row-count verification:

```bash
npx tsx scripts/import-d1.ts --in ./var/deno-kv-export.json --remote
```

The script executes batched SQL files via `wrangler d1 execute --remote`, verifies every table's row count matches the snapshot 100%, and prints the list of users who need a new passkey on `https://audiofeed.app`.

---

## 5. Deploy to `https://audiofeed.app`

```bash
npm run deploy
```

Verify the live deployment:

```bash
# Health + D1/S3 backends + Cloudflare version ID
curl -sS https://audiofeed.app/health

# WebAuthn Related Origin config
curl -sS https://audiofeed.app/.well-known/webauthn

# Existing RSS feed (same feedToken, new domain!)
curl -sSI https://audiofeed.app/feed/<your-existing-feedToken>/master.xml
```

---

## 6. Re-Enrol Passkeys on `https://audiofeed.app`

Because your admin account already exists in D1 after migration, **Admin bootstrap** will refuse to overwrite it. Instead, issue a one-time recovery setup link using your `ADMIN_TOKEN`:

```bash
curl -sS -X POST https://audiofeed.app/api/admin/users/<your-admin-user-id>/setup-link \
  -H "x-admin-token: <your-ADMIN_TOKEN>"
```

1. Open the returned `https://audiofeed.app/login#setup=...` URL in your browser and register your passkey on `audiofeed.app`.
2. Open **`https://audiofeed.app/admin`** → **Subscribers** and generate 7-day setup links for any other subscribers who sign in with a passkey.
3. Update your podcast player (Apple Podcasts / Pocket Casts / Overcast) subscription URLs from `https://audio-feed.paulkinlan-ea.deno.net/feed/<token>/...` to `https://audiofeed.app/feed/<token>/...`.

---

## 7. Decommission Deno Deploy

Once `https://audiofeed.app` is serving feeds, playing R2 audio, and running scheduled Cron Triggers (`*/15 * * * *` feed poll, `*/2 * * * *` synthesis, `17 4 * * *` log retention):

1. Pause/delete the Deno Deploy project (or temporarily deploy a 308 redirect to `https://audiofeed.app` for any podcast client still polling the old URL).
2. Delete the local `./var/deno-kv-export.json` backup once you're confident in the Cloudflare D1 backup.
