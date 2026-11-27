-- audio-feed Cloudflare D1 migration (migrations/0002_playback_state.sql)
-- Cross-device playback state sync: per-user bounded JSON document storing
-- episode resume positions, played history, Up Next queue, and audio preferences.

CREATE TABLE IF NOT EXISTS playback_state (
  user_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
