-- audio-feed Cloudflare D1 schema (migrations/0001_initial.sql)
-- Mirrors every domain repository of MetadataStore (src/storage/mod.ts).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  feed_token TEXT NOT NULL,
  status TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_feed_tokens (
  feed_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_log_at ON approval_log(at, user_id, seq);

CREATE TABLE IF NOT EXISTS sources (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS articles (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  url TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS article_urls (
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  article_id TEXT NOT NULL,
  PRIMARY KEY (user_id, url)
);

CREATE TABLE IF NOT EXISTS article_chunks (
  user_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk TEXT NOT NULL,
  PRIMARY KEY (user_id, article_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS episodes (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  regenerating INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  audio_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_episodes_user_sort ON episodes(user_id, sort_key);
CREATE INDEX IF NOT EXISTS idx_episodes_source_mode_sort ON episodes(user_id, source_id, mode, sort_key);
CREATE INDEX IF NOT EXISTS idx_episodes_pending ON episodes(status, regenerating, created_at, id);
CREATE INDEX IF NOT EXISTS idx_episodes_synthesizing ON episodes(status, claimed_at, id);

CREATE TABLE IF NOT EXISTS synthesis_segments (
  user_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  voice TEXT NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, episode_id, text_hash, prompt_version, voice)
);
CREATE INDEX IF NOT EXISTS idx_segments_episode ON synthesis_segments(user_id, episode_id);

CREATE TABLE IF NOT EXISTS orphan_blobs (
  key TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS usage_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbox_notifications (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(episode_id, status)
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_notifications(delivered_at, created_at, id);

CREATE TABLE IF NOT EXISTS runs (
  kind TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  idle INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, sort_key)
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_credentials(user_id, created_at, id);

CREATE TABLE IF NOT EXISTS setup_links (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS log_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  newest_seq INTEGER NOT NULL DEFAULT 0,
  watermark INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO log_meta (id, newest_seq, watermark) VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS logs (
  seq INTEGER PRIMARY KEY,
  time TEXT NOT NULL,
  detector_key TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS log_once_markers (
  key TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS atomic_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER
);
