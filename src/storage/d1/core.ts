/**
 * Shared D1 substrate and helpers across the 11 domain repositories.
 */

import type { Episode } from "../../types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./types.ts";

export const MAX_TIME = 9_999_999_999_999;

/**
 * Maximum UTF-8 byte size for a single article row or chunk in Cloudflare D1.
 * Cloudflare D1 caps individual SQL statements at 100 KiB (SQLITE_LIMIT_SQL_LENGTH);
 * 48 KiB leaves generous headroom for JSON and SQL literal escaping.
 */
export const D1_ARTICLE_CHUNK_BYTES = 48_000;

/**
 * Descending sort token: lexicographic ascending order over these strings is
 * chronological descending order over the source timestamps, breaking ties by id.
 */
export function descendingKey(iso: string, id: string): string {
  const ms = Date.parse(iso);
  const inverted = MAX_TIME - (Number.isFinite(ms) ? ms : 0);
  return `${inverted.toString().padStart(13, "0")}:${id}`;
}

export class CorruptArticleError extends Error {
  readonly articleId: string;
  readonly expectedChunks: number;
  readonly foundChunks: number;

  constructor(articleId: string, expectedChunks: number, foundChunks: number) {
    super(
      `Corrupted article storage for ${articleId}: expected ${expectedChunks} chunks, found ${foundChunks}`,
    );
    this.name = "CorruptArticleError";
    this.articleId = articleId;
    this.expectedChunks = expectedChunks;
    this.foundChunks = foundChunks;
  }
}

export function isCorruptArticleError(err: unknown): err is CorruptArticleError {
  return err instanceof CorruptArticleError;
}

export function parseExpiresAtMs(expiresAt: string): number {
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) ? ms : Date.now() + 60_000;
}

export interface D1Core {
  readonly db: D1DatabaseLike;
  upsertEpisodeStatement(episode: Episode): D1PreparedStatementLike;
  conditionalInsertEpisodeStatement(
    episode: Episode,
    articleUserId: string,
    articleUrl: string,
    articleId: string,
  ): D1PreparedStatementLike;
}

export function createD1Core(db: D1DatabaseLike): D1Core {
  return {
    db,
    upsertEpisodeStatement(episode: Episode): D1PreparedStatementLike {
      const sortKey = descendingKey(episode.createdAt, episode.id);
      return db.prepare(
        `INSERT INTO episodes (
          user_id, id, source_id, mode, status, regenerating, created_at, sort_key,
          claimed_at, claimed_by, audio_key, version, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(user_id, id) DO UPDATE SET
          source_id = excluded.source_id,
          mode = excluded.mode,
          status = excluded.status,
          regenerating = excluded.regenerating,
          created_at = excluded.created_at,
          sort_key = excluded.sort_key,
          claimed_at = excluded.claimed_at,
          claimed_by = excluded.claimed_by,
          audio_key = excluded.audio_key,
          version = episodes.version + 1,
          data = excluded.data`,
      ).bind(
        episode.userId,
        episode.id,
        episode.sourceId,
        episode.mode,
        episode.status,
        episode.regenerating ? 1 : 0,
        episode.createdAt,
        sortKey,
        episode.claimedAt ?? null,
        episode.claimedBy ?? null,
        episode.audioKey ?? null,
        JSON.stringify(episode),
      );
    },
    conditionalInsertEpisodeStatement(
      episode: Episode,
      articleUserId: string,
      articleUrl: string,
      articleId: string,
    ): D1PreparedStatementLike {
      const sortKey = descendingKey(episode.createdAt, episode.id);
      return db.prepare(
        `INSERT INTO episodes (
          user_id, id, source_id, mode, status, regenerating, created_at, sort_key,
          claimed_at, claimed_by, audio_key, version, data
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
        WHERE EXISTS (
          SELECT 1 FROM article_urls
          WHERE user_id = ? AND url = ? AND article_id = ?
        )`,
      ).bind(
        episode.userId,
        episode.id,
        episode.sourceId,
        episode.mode,
        episode.status,
        episode.regenerating ? 1 : 0,
        episode.createdAt,
        sortKey,
        episode.claimedAt ?? null,
        episode.claimedBy ?? null,
        episode.audioKey ?? null,
        JSON.stringify(episode),
        articleUserId,
        articleUrl,
        articleId,
      );
    },
  };
}
