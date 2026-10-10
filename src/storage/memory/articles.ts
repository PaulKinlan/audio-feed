/**
 * Articles: ingested content, the URL dedupe index, and the chunked storage + article/episode pair writes.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import type { Article, Episode } from "../../types.ts";
import { type MetadataStore } from "../mod.ts";
import type { ArticleRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";
import { scoped, writeEpisode } from "./state.ts";

/**
 * Record an article and point the URL index at it, which is what the KV adapter's
 * `article_by_url` key does. Kept as a real index rather than a scan so the two
 * adapters agree on which article a URL resolves to after the same URL is written
 * twice — the inbox re-send case (audio-feed-d8q), where scanning returned the
 * OLDEST match here while KV returned the NEWEST.
 */
function indexArticle(state: MemoryState, article: Article): void {
  state.articles.set(
    scoped(article.userId, article.id),
    structuredClone(article),
  );
  state.articleByUrl.set(`${article.userId}\u0000${article.url}`, article.id);
}
function hasArticleByUrl(state: MemoryState, userId: string, url: string): boolean {
  return state.articleByUrl.has(`${userId}\u0000${url}`);
}
export function createArticlesRepository(
  state: MemoryState,
  host: () => MetadataStore,
): ArticleRepository {
  return {
    // -- articles -------------------------------------------------------------

    putArticle(article: Article): Promise<void> {
      indexArticle(state, article);
      return Promise.resolve();
    },
    insertArticleIfAbsent(article: Article): Promise<boolean> {
      if (hasArticleByUrl(state, article.userId, article.url)) return Promise.resolve(false);
      indexArticle(state, article);
      return Promise.resolve(true);
    },
    insertArticleWithEpisodeIfAbsent(
      article: Article,
      episode: Episode,
    ): Promise<boolean> {
      // The whole body runs without an await, so no other task can observe an
      // article whose episode is missing (audio-feed-2th).
      if (hasArticleByUrl(state, article.userId, article.url)) return Promise.resolve(false);
      indexArticle(state, article);
      writeEpisode(state, episode);
      return Promise.resolve(true);
    },
    putArticleWithEpisode(article: Article, episode: Episode): Promise<void> {
      // Synchronous start to finish, so no other task observes an article whose episode
      // is not yet there (audio-feed-d8q).
      indexArticle(state, article);
      writeEpisode(state, episode);
      return Promise.resolve();
    },
    getArticle(userId: string, id: string): Promise<Article | null> {
      const found = state.articles.get(scoped(userId, id));
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    getArticles(userId: string, ids: string[]): Promise<(Article | null)[]> {
      return Promise.resolve(ids.map((id) => {
        const found = state.articles.get(scoped(userId, id));
        return found ? structuredClone(found) : null;
      }));
    },
    findArticleByUrl(userId: string, url: string): Promise<Article | null> {
      const id = state.articleByUrl.get(`${userId}\u0000${url}`);
      if (!id) return Promise.resolve(null);
      return host().getArticle(userId, id);
    },
    deleteArticle(userId: string, id: string): Promise<void> {
      const key = scoped(userId, id);
      const existing = state.articles.get(key);
      if (existing) {
        state.articles.delete(key);
        state.articleByUrl.delete(`${userId}\u0000${existing.url}`);
      }
      return Promise.resolve();
    },
  };
}
