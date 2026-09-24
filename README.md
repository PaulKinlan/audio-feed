# audio-feed

Personal podcast feed generator powered by **Gemini 3.8 Flash TTS** on **Deno Deploy**.

Converts RSS feeds and on-demand web articles into custom podcast feeds with single-voice author reads and two-voice deep dive analysis.

## Features

- **Direct Reads:** Clear narration (Ben Thompson style) announcing title, author, publish date, and full article read.
- **Deep Dives:** Two-voice dialogue (NotebookLM style) with an expert and a curious foil, incorporating ecosystem research and counter-perspectives.
- **Master & Per-Source Feeds:** Standard podcast RSS 2.0 / iTunes XML feeds compatible with Pocket Casts, Apple Podcasts, and Overcast.
- **On-Demand URL Ingest:** "Send-to-Audio" endpoint to ingest any article link from Telegram or web.
- **Admin Approval Gating:** Multi-user data model where new accounts require admin verification to prevent unauthorized Gemini API spend.

## Quickstart

```bash
# Run locally with Deno
deno task dev

# Run tests
deno test -A
```

## Configuration

Set the following environment variables:
- `GEMINI_API_KEY`: Google Gemini API key for Gemini 3.8 Flash TTS synthesis.
- `ADMIN_TOKEN`: Secret token for approving new users and managing feeds.
- `STORAGE_BUCKET`: S3 / R2 bucket name for audio MP3/M4A storage.
