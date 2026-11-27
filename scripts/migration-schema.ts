/**
 * Shared snapshot schema and SQL/D1 importer for migrating production data
 * from Deno Deploy KV to Cloudflare D1.
 */

import type {
  ApprovalRecord,
  Article,
  Episode,
  OutboxNotification,
  PasskeyCredential,
  Source,
  SynthesisSegmentRecord,
  User,
} from "../src/types.ts";
import type { LogRecord, RunRecord } from "../src/storage/mod.ts";
import { D1_ARTICLE_CHUNK_BYTES, descendingKey } from "../src/storage/d1/core.ts";
import type { D1DatabaseLike } from "../src/storage/d1/types.ts";

export interface MigrationSnapshot {
  version: 1;
  exportedAt: string;
  source: string;
  users: User[];
  approvalLog: ApprovalRecord[];
  sources: Source[];
  articles: Article[];
  articleUrls: Array<{ userId: string; url: string; articleId: string }>;
  episodes: Episode[];
  synthesisSegments: Array<{ userId: string; episodeId: string; record: SynthesisSegmentRecord }>;
  orphanBlobs: string[];
  usageCounters: Record<string, number>;
  outboxNotifications: OutboxNotification[];
  runs: RunRecord[];
  logs: LogRecord[];
  logMeta: { newestSeq: number; watermark: number };
  logOnceMarkers: Array<{ key: string; seq: number }>;
  /**
   * Archived for audit visibility only — NOT imported into Cloudflare D1 because
   * WebAuthn credentials are cryptographically bound to the old deno.net RP ID.
   */
  archivedDenoPasskeys: Array<{
    userId: string;
    credentialId: string;
    name: string;
    createdAt: string;
    lastUsedAt?: string;
    aaguid?: string;
  }>;
  /** Any unrecognized KV top-level prefixes encountered during export (should be empty). */
  unknownPrefixes: Record<string, number>;
}

const textEncoder = new TextEncoder();

export function sqlLiteral(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function splitContentForD1(article: Article): { base: Article; chunks: string[] } {
  const totalBytes = textEncoder.encode(article.content).length;
  if (totalBytes <= D1_ARTICLE_CHUNK_BYTES) {
    return { base: { ...article, chunkCount: 0 }, chunks: [] };
  }
  const chunks: string[] = [];
  const text = article.content;
  let start = 0;
  while (start < text.length) {
    let sliceLen = Math.min(text.length - start, D1_ARTICLE_CHUNK_BYTES);
    let slice = text.slice(start, start + sliceLen);
    let bytes = textEncoder.encode(slice).length;
    while (bytes > D1_ARTICLE_CHUNK_BYTES && sliceLen > 1) {
      sliceLen = Math.max(1, Math.floor(sliceLen * (D1_ARTICLE_CHUNK_BYTES / bytes)));
      slice = text.slice(start, start + sliceLen);
      const lastCode = slice.charCodeAt(slice.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff && sliceLen > 1) {
        sliceLen--;
        slice = text.slice(start, start + sliceLen);
      }
      bytes = textEncoder.encode(slice).length;
    }
    const lastCode = slice.charCodeAt(slice.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff && sliceLen > 1) {
      sliceLen--;
      slice = text.slice(start, start + sliceLen);
    }
    chunks.push(slice);
    start += sliceLen;
  }
  return {
    base: { ...article, content: "", chunkCount: chunks.length },
    chunks,
  };
}

/**
 * Generate idempotent SQL statements to load a MigrationSnapshot into D1.
 * Safe to re-run (uses INSERT OR REPLACE / INSERT OR IGNORE).
 */
export function snapshotToSqlStatements(snapshot: MigrationSnapshot): string[] {
  const stmts: string[] = [];

  for (const user of snapshot.users) {
    const email = user.email.toLowerCase();
    stmts.push(
      `INSERT OR REPLACE INTO users (id, email, feed_token, status, is_admin, version, data) VALUES (${
        sqlLiteral(user.id)
      }, ${sqlLiteral(email)}, ${sqlLiteral(user.feedToken)}, ${sqlLiteral(user.status)}, ${
        user.isAdmin ? 1 : 0
      }, 1, ${sqlLiteral(JSON.stringify(user))});`,
    );
    stmts.push(
      `INSERT OR REPLACE INTO user_emails (email, user_id) VALUES (${sqlLiteral(email)}, ${
        sqlLiteral(user.id)
      });`,
    );
    stmts.push(
      `INSERT OR REPLACE INTO user_feed_tokens (feed_token, user_id) VALUES (${
        sqlLiteral(user.feedToken)
      }, ${sqlLiteral(user.id)});`,
    );
  }

  // Replace approval_log cleanly on re-import to stay idempotent
  if (snapshot.approvalLog.length > 0) {
    stmts.push(`DELETE FROM approval_log;`);
    for (const rec of snapshot.approvalLog) {
      stmts.push(
        `INSERT INTO approval_log (at, user_id, data) VALUES (${sqlLiteral(rec.at)}, ${
          sqlLiteral(rec.userId)
        }, ${sqlLiteral(JSON.stringify(rec))});`,
      );
    }
  }

  for (const source of snapshot.sources) {
    stmts.push(
      `INSERT OR REPLACE INTO sources (user_id, id, data) VALUES (${sqlLiteral(source.userId)}, ${
        sqlLiteral(source.id)
      }, ${sqlLiteral(JSON.stringify(source))});`,
    );
  }

  for (const article of snapshot.articles) {
    const { base, chunks } = splitContentForD1(article);
    stmts.push(
      `DELETE FROM article_chunks WHERE user_id = ${sqlLiteral(article.userId)} AND article_id = ${
        sqlLiteral(article.id)
      };`,
    );
    stmts.push(
      `INSERT OR REPLACE INTO articles (user_id, id, url, chunk_count, data) VALUES (${
        sqlLiteral(base.userId)
      }, ${sqlLiteral(base.id)}, ${sqlLiteral(base.url)}, ${chunks.length}, ${
        sqlLiteral(JSON.stringify(base))
      });`,
    );
    for (let i = 0; i < chunks.length; i++) {
      stmts.push(
        `INSERT OR REPLACE INTO article_chunks (user_id, article_id, chunk_index, chunk) VALUES (${
          sqlLiteral(article.userId)
        }, ${sqlLiteral(article.id)}, ${i}, ${sqlLiteral(chunks[i])});`,
      );
    }
  }

  // Prefer explicit articleUrls index from KV; also backfill from articles if absent.
  const seenUrls = new Set<string>();
  for (const ptr of snapshot.articleUrls) {
    seenUrls.add(`${ptr.userId}\0${ptr.url}`);
    stmts.push(
      `INSERT OR REPLACE INTO article_urls (user_id, url, article_id) VALUES (${
        sqlLiteral(ptr.userId)
      }, ${sqlLiteral(ptr.url)}, ${sqlLiteral(ptr.articleId)});`,
    );
  }
  for (const article of snapshot.articles) {
    const k = `${article.userId}\0${article.url}`;
    if (!seenUrls.has(k)) {
      seenUrls.add(k);
      stmts.push(
        `INSERT OR IGNORE INTO article_urls (user_id, url, article_id) VALUES (${
          sqlLiteral(article.userId)
        }, ${sqlLiteral(article.url)}, ${sqlLiteral(article.id)});`,
      );
    }
  }

  for (const ep of snapshot.episodes) {
    const sortKey = descendingKey(ep.createdAt, ep.id);
    stmts.push(
      `INSERT OR REPLACE INTO episodes (user_id, id, source_id, mode, status, regenerating, created_at, sort_key, claimed_at, claimed_by, audio_key, version, data) VALUES (${
        sqlLiteral(ep.userId)
      }, ${sqlLiteral(ep.id)}, ${sqlLiteral(ep.sourceId)}, ${sqlLiteral(ep.mode)}, ${
        sqlLiteral(ep.status)
      }, ${ep.regenerating ? 1 : 0}, ${sqlLiteral(ep.createdAt)}, ${sqlLiteral(sortKey)}, ${
        sqlLiteral(ep.claimedAt ?? null)
      }, ${sqlLiteral(ep.claimedBy ?? null)}, ${sqlLiteral(ep.audioKey ?? null)}, 1, ${
        sqlLiteral(JSON.stringify(ep))
      });`,
    );
  }

  for (const { userId, episodeId, record: seg } of snapshot.synthesisSegments) {
    stmts.push(
      `INSERT OR REPLACE INTO synthesis_segments (user_id, episode_id, text_hash, prompt_version, voice, finalized, owner, version, data) VALUES (${
        sqlLiteral(userId)
      }, ${sqlLiteral(episodeId)}, ${sqlLiteral(seg.textHash)}, ${
        sqlLiteral(seg.promptVersion)
      }, ${sqlLiteral(seg.voice)}, ${seg.finalized ? 1 : 0}, ${sqlLiteral(seg.owner)}, 1, ${
        sqlLiteral(JSON.stringify(seg))
      });`,
    );
  }

  for (const key of snapshot.orphanBlobs) {
    stmts.push(`INSERT OR IGNORE INTO orphan_blobs (key) VALUES (${sqlLiteral(key)});`);
  }

  for (const [key, value] of Object.entries(snapshot.usageCounters)) {
    stmts.push(
      `INSERT OR REPLACE INTO usage_counters (key, value) VALUES (${sqlLiteral(key)}, ${
        Math.trunc(value)
      });`,
    );
  }

  const defaultExpiry = Date.now() + 14 * 86400 * 1000;
  for (const n of snapshot.outboxNotifications) {
    stmts.push(
      `INSERT OR REPLACE INTO outbox_notifications (id, episode_id, status, created_at, delivered_at, expires_at, data) VALUES (${
        sqlLiteral(n.id)
      }, ${sqlLiteral(n.episodeId)}, ${sqlLiteral(n.status)}, ${sqlLiteral(n.createdAt)}, ${
        sqlLiteral(n.deliveredAt ?? null)
      }, ${defaultExpiry}, ${sqlLiteral(JSON.stringify(n))});`,
    );
  }

  for (const run of snapshot.runs) {
    const sortKey = descendingKey(run.startedAt, run.id);
    stmts.push(
      `INSERT OR REPLACE INTO runs (kind, sort_key, id, started_at, idle, data) VALUES (${
        sqlLiteral(run.kind)
      }, ${sqlLiteral(sortKey)}, ${sqlLiteral(run.id)}, ${sqlLiteral(run.startedAt)}, ${
        run.idle ? 1 : 0
      }, ${sqlLiteral(JSON.stringify(run))});`,
    );
  }

  stmts.push(
    `INSERT OR REPLACE INTO log_meta (id, newest_seq, watermark) VALUES (1, ${
      Math.trunc(snapshot.logMeta.newestSeq)
    }, ${Math.trunc(snapshot.logMeta.watermark)});`,
  );

  for (const log of snapshot.logs) {
    const detectorKey = log.type === "synthesis.invocation.overdue" &&
        typeof log.context?.detectorKey === "string"
      ? log.context.detectorKey
      : null;
    stmts.push(
      `INSERT OR REPLACE INTO logs (seq, time, detector_key, data) VALUES (${
        Math.trunc(log.seq)
      }, ${sqlLiteral(log.time)}, ${sqlLiteral(detectorKey)}, ${sqlLiteral(JSON.stringify(log))});`,
    );
  }

  for (const marker of snapshot.logOnceMarkers) {
    stmts.push(
      `INSERT OR REPLACE INTO log_once_markers (key, seq) VALUES (${sqlLiteral(marker.key)}, ${
        Math.trunc(marker.seq)
      });`,
    );
  }

  return stmts;
}

/**
 * Group SQL statements into bounded chunks safe for `wrangler d1 execute --file`.
 * Caps each file at <= 4 MiB UTF-8 and <= 2,500 statements so large imports finish
 * in just a few remote D1 uploads.
 */
export function chunkSqlStatements(
  statements: string[],
  maxBytes = 4_000_000,
  maxStatements = 2_500,
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const stmt of statements) {
    const stmtBytes = textEncoder.encode(stmt).length + 1;
    if (
      current.length > 0 &&
      (current.length >= maxStatements || currentBytes + stmtBytes > maxBytes)
    ) {
      chunks.push(current.join("\n"));
      current = [];
      currentBytes = 0;
    }
    current.push(stmt);
    currentBytes += stmtBytes;
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

/**
 * Direct in-process import into any `D1DatabaseLike` (used by tests and local verification).
 */
export async function importSnapshotDirect(
  db: D1DatabaseLike,
  snapshot: MigrationSnapshot,
): Promise<void> {
  const stmts = snapshotToSqlStatements(snapshot);
  const BATCH = 100;
  for (let i = 0; i < stmts.length; i += BATCH) {
    const batch = stmts.slice(i, i + BATCH).map((sql) => db.prepare(sql));
    await db.batch(batch);
  }
}

export interface VerificationCounts {
  users: number;
  approvalLog: number;
  sources: number;
  articles: number;
  episodes: number;
  synthesisSegments: number;
  orphanBlobs: number;
  usageCounters: number;
  outboxNotifications: number;
  runs: number;
  logs: number;
  logOnceMarkers: number;
}

export function expectedCounts(snapshot: MigrationSnapshot): VerificationCounts {
  return {
    users: snapshot.users.length,
    approvalLog: snapshot.approvalLog.length,
    sources: snapshot.sources.length,
    articles: snapshot.articles.length,
    episodes: snapshot.episodes.length,
    synthesisSegments: snapshot.synthesisSegments.length,
    orphanBlobs: snapshot.orphanBlobs.length,
    usageCounters: Object.keys(snapshot.usageCounters).length,
    outboxNotifications: snapshot.outboxNotifications.length,
    runs: snapshot.runs.length,
    logs: snapshot.logs.length,
    logOnceMarkers: snapshot.logOnceMarkers.length,
  };
}

export async function verifySnapshotInD1(
  db: D1DatabaseLike,
  snapshot: MigrationSnapshot,
): Promise<{ ok: boolean; expected: VerificationCounts; actual: VerificationCounts; mismatches: string[] }> {
  const count = async (table: string): Promise<number> => {
    const row = await db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
      .first<{ cnt: number }>();
    return Number(row?.cnt ?? 0);
  };

  const actual: VerificationCounts = {
    users: await count("users"),
    approvalLog: await count("approval_log"),
    sources: await count("sources"),
    articles: await count("articles"),
    episodes: await count("episodes"),
    synthesisSegments: await count("synthesis_segments"),
    orphanBlobs: await count("orphan_blobs"),
    usageCounters: await count("usage_counters"),
    outboxNotifications: await count("outbox_notifications"),
    runs: await count("runs"),
    logs: await count("logs"),
    logOnceMarkers: await count("log_once_markers"),
  };

  const expected = expectedCounts(snapshot);
  const mismatches: string[] = [];
  for (const key of Object.keys(expected) as (keyof VerificationCounts)[]) {
    if (actual[key] !== expected[key]) {
      mismatches.push(`${key}: expected ${expected[key]}, got ${actual[key]}`);
    }
  }
  return { ok: mismatches.length === 0, expected, actual, mismatches };
}

export function passkeyArchiveSummary(cred: PasskeyCredential) {
  return {
    userId: cred.userId,
    credentialId: cred.id,
    name: cred.name,
    createdAt: cred.createdAt,
    lastUsedAt: cred.lastUsedAt,
    aaguid: cred.aaguid,
  };
}
