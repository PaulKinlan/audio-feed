# Audio Feed (`audio-feed`)

A personal, multi-user podcast generation service powered by **Gemini 3.8 Flash TTS**, hosted on **Deno Deploy**.

Converts RSS articles and on-demand web URLs into personalized podcast feeds featuring both straight author reads and two-voice NotebookLM-style ecosystem deep dives.

---

## 1. Core Vision & Features

### Audio Presentation Modes
1. **Direct Read (Stratechery / Ben Thompson Style)**
   - Includes article title, publication date, author, and brief intro context.
   - Professional, uninterrupted, clear single-voice reading of the full article text.
   - Custom voice assigned per feed source.

2. **Deep Dive Discussion (NotebookLM Style)**
   - Two-voice conversational podcast between a domain expert and a curious interviewer/foil.
   - Supplements article claims with automated ecosystem research, counter-arguments, historical context, and related links.
   - Dynamic pacing, natural conversational banter, and structured chapter markers.

### Feed Topology
- **Master Aggregated Feed:** `https://<domain>/feed/<feed-token>/master.xml` (all subscribed articles in one unified feed across all sources for podcast players like Pocket Casts, Apple Podcasts, Overcast; capped to the newest 200 episodes; tolerates client tracking/cache-busting query parameters).
- **Per-Source Direct Read Feed:** `https://<domain>/feed/<feed-token>/<source-id>/direct.xml` (single-voice author narration for an individual source, capped to the newest 200 episodes).
- **Per-Source Deep Dive Feed:** `https://<domain>/feed/<feed-token>/<source-id>/deepdive.xml` (two-voice dialogue analysis for an individual source, capped to the newest 200 episodes).

### Instant Ingest ("Send-to-Audio")
- Modeled after the local `remarkable-pending` reading workflow.
- Ingest arbitrary article URLs via Telegram bot, chaos-relay, or HTTP API.
- Headless fetcher extracts clean readable markdown (stripping ads, paywall banners, navigation).
- Synthesizes audio and immediately appends the episode to your personal feed with playback enclosures.

### Multi-User & Access Control
- Multi-user data model supporting distinct subscriber profiles and separate listening personas.
- **Admin Approval Gate:** Public signups or incoming requests are held in a `pending` queue; admin approval is strictly required before audio generation is authorized (preventing unauthorized Gemini API cost exposure).

---

## 2. Technical Architecture

- **Runtime:** Deno 2+ / Deno Deploy.
- **Audio Engine:** Google Gemini 3.8 Flash TTS / Audio Generation API (voice presets: Aoede, Charon, Fenrir, Kore, Puck).
- **Storage:**
  - Metadata: Deno KV (users, feeds, episodes, admin approval ledger).
  - Audio Blobs: Cloudflare R2 / S3-compatible object storage with signed playback URLs.
- **Task Tracking:** Beads (`bd`) issue tracker.
