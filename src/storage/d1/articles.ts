/**
 * Articles repository for Cloudflare D1.
 *
 * Splits content exceeding D1_ARTICLE_CHUNK_BYTES (400 KiB) across `article_chunks`
 * rows so even 2M-character articles never hit Cloudflare D1's 1 MiB row ceiling.
 */

import type { Article, Episode } from "../../types.ts";
import type { ArticleRepository, MetadataStore } from "../mod.ts";
import type { D1Core } from "./core.ts";
import {
  CorruptArticleError,
  D1_ARTICLE_CHUNK_BYTES,
  isCorruptArticleError,
} from "./core.ts";
import type { D1PreparedStatementLike } from "./types.ts";

const textEncoder = new TextEncoder();

function splitArticleForD1(article: Article): { baseArticle: Article; chunks: string[] } {
  const totalBytes = textEncoder.encode(article.content).length;
  if (totalBytes <= D1_ARTICLE_CHUNK_BYTES) {
    return {
      baseArticle: { ...article, chunkCount: 0 },
      chunks: [],
    };
  }

  const chunks: string[] = [];
  const text = article.content;
  let start = 0;

  while (start < text.length) {
    const loopStart = start;
    let sliceLen = Math.min(text.length - start, D1_ARTICLE_CHUNK_BYTES);
    let slice = text.slice(start, start + sliceLen);
    let bytes = textEncoder.encode(slice).length;

    while (bytes > D1_ARTICLE_CHUNK_BYTES && sliceLen > 1) {
      const ratio = D1_ARTICLE_CHUNK_BYTES / bytes;
      sliceLen = Math.max(1, Math.floor(sliceLen * ratio));
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
    if (start <= loopStart) {
      throw new Error(`Article chunking stalled for ${article.id} at index ${start}`);
    }
  }

  return {
    baseArticle: {
      ...article,
      content: "",
      chunkCount: chunks.length,
    },
    chunks,
  };
}

async function hydrateArticle(
  core: D1Core,
  userId: string,
  article: Article,
): Promise<Article> {
  if (!article.chunkCount || article.chunkCount <= 0) {
    return article;
  }
  const res = await core.db.prepare(
    `SELECT chunk_index, chunk FROM article_chunks
     WHERE user_id = ? AND article_id = ?
     ORDER BY chunk_index ASC`,
  ).bind(userId, article.id).all<{ chunk_index: number; chunk: string }>();

  if (res.results.length !== article.chunkCount) {
    throw new CorruptArticleError(article.id, article.chunkCount, res.results.length);
  }
  const parts: string[] = [];
  for (let i = 0; i < res.results.length; i++) {
    const row = res.results[i]!;
    if (row.chunk_index !== i) {
      throw new CorruptArticleError(article.id, article.chunkCount, res.results.length);
    }
    parts.push(row.chunk);
  }
  return {
    ...article,
    content: parts.join(""),
  };
}

export function createD1ArticlesRepository(
  core: D1Core,
  host: () => MetadataStore,
): ArticleRepository {
  return {
    async putArticle(article: Article): Promise<void> {
      const { baseArticle, chunks } = splitArticleForD1(article);
      const stmts: D1PreparedStatementLike[] = [
        core.db.prepare(
          `DELETE FROM article_chunks WHERE user_id = ? AND article_id = ?`,
        ).bind(article.userId, article.id),
        core.db.prepare(
          `INSERT INTO articles (user_id, id, url, chunk_count, data)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, id) DO UPDATE SET
             url = excluded.url,
             chunk_count = excluded.chunk_count,
             data = excluded.data`,
        ).bind(
          baseArticle.userId,
          baseArticle.id,
          baseArticle.url,
          chunks.length,
          JSON.stringify(baseArticle),
        ),
        core.db.prepare(
          `INSERT INTO article_urls (user_id, url, article_id)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id, url) DO UPDATE SET article_id = excluded.article_id`,
        ).bind(baseArticle.userId, baseArticle.url, baseArticle.id),
      ];
      for (let i = 0; i < chunks.length; i++) {
        stmts.push(
          core.db.prepare(
            `INSERT INTO article_chunks (user_id, article_id, chunk_index, chunk)
             VALUES (?, ?, ?, ?)`,
          ).bind(article.userId, article.id, i, chunks[i]),
        );
      }
      await core.db.batch(stmts);
    },

    async insertArticleIfAbsent(article: Article): Promise<boolean> {
      const { baseArticle, chunks } = splitArticleForD1(article);
      const stmts: D1PreparedStatementLike[] = [
        core.db.prepare(
          `INSERT OR IGNORE INTO article_urls (user_id, url, article_id) VALUES (?, ?, ?)`,
        ).bind(baseArticle.userId, baseArticle.url, baseArticle.id),
        core.db.prepare(
          `INSERT INTO articles (user_id, id, url, chunk_count, data)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM article_urls WHERE user_id = ? AND url = ? AND article_id = ?
           )`,
        ).bind(
          baseArticle.userId,
          baseArticle.id,
          baseArticle.url,
          chunks.length,
          JSON.stringify(baseArticle),
          baseArticle.userId,
          baseArticle.url,
          baseArticle.id,
        ),
      ];
      for (let i = 0; i < chunks.length; i++) {
        stmts.push(
          core.db.prepare(
            `INSERT INTO article_chunks (user_id, article_id, chunk_index, chunk)
             SELECT ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM article_urls WHERE user_id = ? AND url = ? AND article_id = ?
             )`,
          ).bind(
            baseArticle.userId,
            baseArticle.id,
            i,
            chunks[i],
            baseArticle.userId,
            baseArticle.url,
            baseArticle.id,
          ),
        );
      }
      const results = await core.db.batch(stmts);
      return (results[0]?.meta.changes ?? 0) === 1;
    },

    async insertArticleWithEpisodeIfAbsent(
      article: Article,
      episode: Episode,
    ): Promise<boolean> {
      const { baseArticle, chunks } = splitArticleForD1(article);
      const stmts: D1PreparedStatementLike[] = [
        core.db.prepare(
          `INSERT OR IGNORE INTO article_urls (user_id, url, article_id) VALUES (?, ?, ?)`,
        ).bind(baseArticle.userId, baseArticle.url, baseArticle.id),
        core.db.prepare(
          `INSERT INTO articles (user_id, id, url, chunk_count, data)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM article_urls WHERE user_id = ? AND url = ? AND article_id = ?
           )`,
        ).bind(
          baseArticle.userId,
          baseArticle.id,
          baseArticle.url,
          chunks.length,
          JSON.stringify(baseArticle),
          baseArticle.userId,
          baseArticle.url,
          baseArticle.id,
        ),
        core.conditionalInsertEpisodeStatement(
          episode,
          baseArticle.userId,
          baseArticle.url,
          baseArticle.id,
        ),
      ];
      for (let i = 0; i < chunks.length; i++) {
        stmts.push(
          core.db.prepare(
            `INSERT INTO article_chunks (user_id, article_id, chunk_index, chunk)
             SELECT ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM article_urls WHERE user_id = ? AND url = ? AND article_id = ?
             )`,
          ).bind(
            baseArticle.userId,
            baseArticle.id,
            i,
            chunks[i],
            baseArticle.userId,
            baseArticle.url,
            baseArticle.id,
          ),
        );
      }
      const results = await core.db.batch(stmts);
      return (results[0]?.meta.changes ?? 0) === 1;
    },

    async putArticleWithEpisode(article: Article, episode: Episode): Promise<void> {
      const { baseArticle, chunks } = splitArticleForD1(article);
      const stmts: D1PreparedStatementLike[] = [
        core.db.prepare(
          `DELETE FROM article_chunks WHERE user_id = ? AND article_id = ?`,
        ).bind(article.userId, article.id),
        core.db.prepare(
          `INSERT INTO articles (user_id, id, url, chunk_count, data)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, id) DO UPDATE SET
             url = excluded.url,
             chunk_count = excluded.chunk_count,
             data = excluded.data`,
        ).bind(
          baseArticle.userId,
          baseArticle.id,
          baseArticle.url,
          chunks.length,
          JSON.stringify(baseArticle),
        ),
        core.db.prepare(
          `INSERT INTO article_urls (user_id, url, article_id)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id, url) DO UPDATE SET article_id = excluded.article_id`,
        ).bind(baseArticle.userId, baseArticle.url, baseArticle.id),
        core.upsertEpisodeStatement(episode),
      ];
      for (let i = 0; i < chunks.length; i++) {
        stmts.push(
          core.db.prepare(
            `INSERT INTO article_chunks (user_id, article_id, chunk_index, chunk)
             VALUES (?, ?, ?, ?)`,
          ).bind(article.userId, article.id, i, chunks[i]),
        );
      }
      await core.db.batch(stmts);
    },

    async getArticle(userId: string, id: string): Promise<Article | null> {
      const row = await core.db.prepare(
        `SELECT data FROM articles WHERE user_id = ? AND id = ?`,
      ).bind(userId, id).first<{ data: string }>();
      if (!row) return null;
      return await hydrateArticle(core, userId, JSON.parse(row.data) as Article);
    },

    async getArticles(userId: string, ids: string[]): Promise<(Article | null)[]> {
      if (ids.length === 0) return [];
      const byId = new Map<string, Article>();
      // D1 binds max ~100 params per statement; chunk IN clauses safely at 50.
      for (let start = 0; start < ids.length; start += 50) {
        const batch = ids.slice(start, start + 50);
        const placeholders = batch.map(() => "?").join(", ");
        const res = await core.db.prepare(
          `SELECT id, data FROM articles WHERE user_id = ? AND id IN (${placeholders})`,
        ).bind(userId, ...batch).all<{ id: string; data: string }>();
        for (const row of res.results) {
          byId.set(row.id, JSON.parse(row.data) as Article);
        }
      }
      return await Promise.all(
        ids.map((id) => {
          const art = byId.get(id);
          if (!art) return Promise.resolve(null);
          return hydrateArticle(core, userId, art).catch((err: unknown) => {
            if (!isCorruptArticleError(err)) throw err;
            console.warn(JSON.stringify({
              event: "article.corrupt",
              articleId: err.articleId,
              expectedChunks: err.expectedChunks,
              foundChunks: err.foundChunks,
              action: "omitted-from-batch",
            }));
            return null;
          });
        }),
      );
    },

    async findArticleByUrl(userId: string, url: string): Promise<Article | null> {
      const row = await core.db.prepare(
        `SELECT article_id FROM article_urls WHERE user_id = ? AND url = ?`,
      ).bind(userId, url).first<{ article_id: string }>();
      if (!row) return null;
      return await host().getArticle(userId, row.article_id);
    },

    async findExistingArticleUrls(userId: string, urls: string[]): Promise<Set<string>> {
      const found = new Set<string>();
      if (urls.length === 0) return found;
      const unique = Array.from(new Set(urls));
      // D1 binds max ~100 params per statement; chunk IN clauses safely at 50 (<= 51 total params).
      for (let start = 0; start < unique.length; start += 50) {
        const batch = unique.slice(start, start + 50);
        const placeholders = batch.map(() => "?").join(", ");
        const res = await core.db.prepare(
          `SELECT url FROM article_urls WHERE user_id = ? AND url IN (${placeholders})`,
        ).bind(userId, ...batch).all<{ url: string }>();
        for (const row of res.results) {
          found.add(row.url);
        }
      }
      return found;
    },

    async deleteArticle(userId: string, id: string): Promise<void> {
      const row = await core.db.prepare(
        `SELECT url FROM articles WHERE user_id = ? AND id = ?`,
      ).bind(userId, id).first<{ url: string }>();
      const stmts: D1PreparedStatementLike[] = [
        core.db.prepare(
          `DELETE FROM article_chunks WHERE user_id = ? AND article_id = ?`,
        ).bind(userId, id),
        core.db.prepare(
          `DELETE FROM articles WHERE user_id = ? AND id = ?`,
        ).bind(userId, id),
      ];
      if (row) {
        stmts.push(
          core.db.prepare(
            `DELETE FROM article_urls WHERE user_id = ? AND url = ? AND article_id = ?`,
          ).bind(userId, row.url, id),
        );
      }
      await core.db.batch(stmts);
    },
  };
}
