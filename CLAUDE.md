# Project Instructions for AI Agents

This repository (`audio-feed`) runs on **Cloudflare Workers** with **D1** (SQLite metadata),
**R2** (audio & artwork blobs with streaming Multipart Upload), **Cloudflare Workflows**
(`EpisodeSynthesisWorkflow`), and **Cloudflare Queues** (`audio-feed-poll`), served at
`https://audiofeed.app`.

## Build & Test

Requires Node >= 22.5 (for built-in `node:sqlite` in D1 tests).

```bash
# Install dependencies (public npm registry pinned in .npmrc)
npm install

# Run full verification gate (~10s):
# asset bundle + tsc --noEmit + wrangler deploy --dry-run + all Vitest suites
npm run gate

# Run Vitest directly
npm test

# Local dev server (Wrangler)
npm run dev

# Manual deploy (Git pushes to main also deploy via Cloudflare Workers Builds)
npm run deploy
```

## Architecture Overview

- `src/worker_entry.ts` — Cloudflare Worker `fetch`, `scheduled`, `queue`, and `EpisodeSynthesisWorkflow` export.
- `src/app.ts` — Single route table (audited by `tests/route_census_test.ts` and `THREAT_MODEL.md`).
- `src/storage/d1/` & `migrations/` — Cloudflare D1 metadata store (48 KiB article chunking).
- `src/storage/r2.ts` & `src/storage/wav_assembly.ts` — Native R2 binding + streaming 8 MiB multipart WAV assembly.
- `src/worker/synthesis_workflow.ts` — Durable per-segment synthesis pipeline (`EpisodeSynthesisWorkflow`).
- `src/artwork/` & `src/synthesis/chapters.ts` — Raster PNG cover art, `og:image` / Gemini art, and Podcasting 2.0 JSON Chapters.
- `src/routes/account.ts`, `src/routes/listen.ts`, `src/assets/` — Tabbed `/account` UI and full `/listen/` podcast player.

## Conventions & Safety

- Always run `npm run gate` before committing or deploying.
- Never commit secrets or local exports (`var/`, `.dev.vars`).
- Any new route added to `src/app.ts` must also update `THREAT_MODEL.md` and `tests/route_census_test.ts`.
- HTML pages enforce nonce-based CSP (`style-src 'self' 'nonce-...'`, `img-src 'self' data:`): no inline `style="..."` attributes and no `.innerHTML =` assignments.
