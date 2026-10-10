/**
 * Articles: ingested content, the URL dedupe index, and the chunked storage + article/episode pair writes.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import v8 from "node:v8";
import type { Article, Episode } from "../../types.ts";
import type { ArticleRepository, MetadataStore } from "../mod.ts";
import type { KvCore } from "./core.ts";
import {
  ARTICLE_CHUNK_SIZE,
  CorruptArticleError,
  EPISODE_READ_BATCH,
  isCorruptArticleError,
  MAX_KV_VALUE_BYTES,
} from "./core.ts";

// -- articles -------------------------------------------------------------

function splitArticleForStorage(
  _core: KvCore,
  article: Article,
): { baseArticle: Article; chunks: string[] } {
  const encoder = new TextEncoder();
  const totalUtf8Bytes = encoder.encode(article.content).length;
  const totalV8Bytes = v8.serialize(article.content).byteLength;
  // An article whose UTF-8 bytes and V8 serialized bytes fit within limits needs no chunking.
  if (totalUtf8Bytes <= ARTICLE_CHUNK_SIZE && totalV8Bytes <= MAX_KV_VALUE_BYTES) {
    return {
      baseArticle: {
        ...article,
        chunkCount: 0,
      },
      chunks: [],
    };
  }

  const chunks: string[] = [];
  let startIndex = 0;
  const text = article.content;

  while (startIndex < text.length) {
    const loopStart = startIndex;
    let sliceLength = Math.min(text.length - startIndex, ARTICLE_CHUNK_SIZE);
    let slice = text.slice(startIndex, startIndex + sliceLength);
    let utf8Bytes = encoder.encode(slice).length;
    let v8Bytes = v8.serialize(slice).byteLength;

    while ((utf8Bytes > ARTICLE_CHUNK_SIZE || v8Bytes > MAX_KV_VALUE_BYTES) && sliceLength > 1) {
      const ratio = Math.min(ARTICLE_CHUNK_SIZE / utf8Bytes, MAX_KV_VALUE_BYTES / v8Bytes);
      sliceLength = Math.max(1, Math.floor(sliceLength * ratio));
      slice = text.slice(startIndex, startIndex + sliceLength);

      // Do not split surrogate pair
      const lastCode = slice.charCodeAt(slice.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        sliceLength--;
        slice = text.slice(startIndex, startIndex + sliceLength);
      }

      utf8Bytes = encoder.encode(slice).length;
      v8Bytes = v8.serialize(slice).byteLength;
    }

    const lastCode = slice.charCodeAt(slice.length - 1);
    // Only step back when there is something to step back to. At sliceLength === 1 the decrement made
    // the slice empty and startIndex never advanced, so the loop spun forever on an article ending in
    // an unpaired high surrogate (audio-feed-64wu). A lone surrogate is emitted as its own chunk.
    if (lastCode >= 0xd800 && lastCode <= 0xdbff && sliceLength > 1) {
      sliceLength--;
      slice = text.slice(startIndex, startIndex + sliceLength);
    }

    // Invariant assertion: must strictly fit in Deno KV (65,536 bytes)
    const finalV8 = v8.serialize(slice).byteLength;
    const finalUtf8 = encoder.encode(slice).length;
    if (finalV8 > 65_536 || finalUtf8 > 65_536) {
      throw new Error(
        `Chunk ${chunks.length} of article ${article.id} exceeds max KV value size (v8=${finalV8}, utf8=${finalUtf8} > 65536 bytes)`,
      );
    }

    chunks.push(slice);
    startIndex += sliceLength;
    // Progress invariant, not a size limit: any future edit that lets a chunk consume nothing must
    // surface as a thrown error rather than a permanently pinned core. The loop is synchronous, so no
    // timer, watchdog or Promise.race on this isolate could observe a stall (audio-feed-64wu).
    if (startIndex <= loopStart) {
      throw new Error(
        `Article chunking stalled for ${article.id} at index ${startIndex} (sliceLength=${sliceLength})`,
      );
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
async function writeArticleChunks(
  core: KvCore,
  userId: string,
  id: string,
  chunks: string[],
): Promise<void> {
  let writtenCount = 0;
  try {
    for (let i = 0; i < chunks.length; i += 10) {
      const tx = core.kv.atomic();
      const end = Math.min(i + 10, chunks.length);
      for (let j = i; j < end; j++) {
        tx.set(["article_chunk", userId, id, j], chunks[j]);
      }
      const res = await tx.commit();
      if (!res.ok) throw new Error(`Failed to commit article chunks for ${id}`);
      writtenCount = end;
    }
  } catch (err) {
    if (writtenCount > 0) {
      await deleteArticleChunks(core, userId, id, writtenCount);
    }
    throw err;
  }
}
async function deleteArticleChunks(
  core: KvCore,
  userId: string,
  id: string,
  chunkCount?: number,
): Promise<void> {
  if (typeof chunkCount === "number" && chunkCount > 0) {
    for (let i = 0; i < chunkCount; i += 10) {
      const tx = core.kv.atomic();
      const end = Math.min(i + 10, chunkCount);
      for (let j = i; j < end; j++) {
        tx.delete(["article_chunk", userId, id, j]);
      }
      await tx.commit();
    }
  } else {
    for await (const entry of core.kv.list({ prefix: ["article_chunk", userId, id] })) {
      await core.kv.delete(entry.key);
    }
  }
}
async function hydrateArticle(core: KvCore, userId: string, article: Article): Promise<Article> {
  if (!article.chunkCount || article.chunkCount <= 0) {
    return article;
  }
  const chunkKeys: Deno.KvKey[] = [];
  for (let i = 0; i < article.chunkCount; i++) {
    chunkKeys.push(["article_chunk", userId, article.id, i]);
  }
  const chunkPieces: string[] = [];
  for (let start = 0; start < chunkKeys.length; start += 10) {
    const batch = chunkKeys.slice(start, start + 10);
    const rows = (await core.kv.getMany(batch)) as Deno.KvEntryMaybe<string>[];
    for (const row of rows) {
      if (typeof row.value === "string") {
        chunkPieces.push(row.value);
      }
    }
  }
  if (chunkPieces.length !== article.chunkCount) {
    throw new CorruptArticleError(article.id, article.chunkCount, chunkPieces.length);
  }
  return {
    ...article,
    content: chunkPieces.join(""),
  };
}
export function createArticlesRepository(
  core: KvCore,
  host: () => MetadataStore,
): ArticleRepository {
  return {
    async putArticle(article: Article): Promise<void> {
      const existing = (await core.kv.get<Article>(["article", article.userId, article.id])).value;
      const { baseArticle, chunks } = splitArticleForStorage(core, article);
      if (chunks.length > 0) {
        await writeArticleChunks(core, article.userId, article.id, chunks);
      }
      const result = await core.kv.atomic()
        .set(["article", baseArticle.userId, baseArticle.id], baseArticle)
        .set(["article_by_url", baseArticle.userId, baseArticle.url], baseArticle.id)
        .commit();
      if (!result.ok) {
        if (chunks.length > 0) {
          await deleteArticleChunks(core, article.userId, article.id, chunks.length);
        }
        throw new Error(`putArticle failed for ${article.id}`);
      }
      if (existing?.chunkCount && existing.chunkCount > chunks.length) {
        for (let i = chunks.length; i < existing.chunkCount; i++) {
          await core.kv.delete(["article_chunk", article.userId, article.id, i]);
        }
      }
    },
    async insertArticleIfAbsent(article: Article): Promise<boolean> {
      const { baseArticle, chunks } = splitArticleForStorage(core, article);
      if (chunks.length > 0) {
        const existing = await core.kv.get(["article_by_url", article.userId, article.url]);
        if (existing.value !== null) return false;
        await writeArticleChunks(core, article.userId, article.id, chunks);
      }
      const result = await core.kv.atomic()
        .check({ key: ["article_by_url", article.userId, article.url], versionstamp: null })
        .set(["article", baseArticle.userId, baseArticle.id], baseArticle)
        .set(["article_by_url", baseArticle.userId, baseArticle.url], baseArticle.id)
        .commit();
      if (!result.ok && chunks.length > 0) {
        await deleteArticleChunks(core, article.userId, article.id, chunks.length);
      }
      return result.ok;
    },
    async insertArticleWithEpisodeIfAbsent(
      article: Article,
      episode: Episode,
    ): Promise<boolean> {
      // One transaction, so the pair either exists together or does not exist at
      // all (audio-feed-2th). The URL check is the audio-feed-33m guard: a losing
      // commit writes neither record.
      const { baseArticle, chunks } = splitArticleForStorage(core, article);
      if (chunks.length > 0) {
        const existing = await core.kv.get(["article_by_url", article.userId, article.url]);
        if (existing.value !== null) return false;
        await writeArticleChunks(core, article.userId, article.id, chunks);
      }
      const tx = core.kv.atomic()
        .check({ key: ["article_by_url", article.userId, article.url], versionstamp: null })
        .set(["article", baseArticle.userId, baseArticle.id], baseArticle)
        .set(["article_by_url", baseArticle.userId, baseArticle.url], baseArticle.id);
      core.writeEpisode(tx, episode);
      const result = await tx.commit();
      if (!result.ok && chunks.length > 0) {
        await deleteArticleChunks(core, article.userId, article.id, chunks.length);
      }
      return result.ok;
    },
    async putArticleWithEpisode(article: Article, episode: Episode): Promise<void> {
      // Same single-commit guarantee as the dedupe variant, without the URL check
      // (audio-feed-d8q): the inbox re-write of a URL is a new episode by request, but
      // it must never be half a pair.
      const existing = (await core.kv.get<Article>(["article", article.userId, article.id])).value;
      const { baseArticle, chunks } = splitArticleForStorage(core, article);
      if (chunks.length > 0) {
        await writeArticleChunks(core, article.userId, article.id, chunks);
      }
      const tx = core.kv.atomic()
        .set(["article", baseArticle.userId, baseArticle.id], baseArticle)
        .set(["article_by_url", baseArticle.userId, baseArticle.url], baseArticle.id);
      core.writeEpisode(tx, episode);
      const result = await tx.commit();
      if (!result.ok) {
        if (chunks.length > 0) {
          await deleteArticleChunks(core, article.userId, article.id, chunks.length);
        }
        throw new Error(`putArticleWithEpisode failed for ${article.id}`);
      }
      if (existing?.chunkCount && existing.chunkCount > chunks.length) {
        for (let i = chunks.length; i < existing.chunkCount; i++) {
          await core.kv.delete(["article_chunk", article.userId, article.id, i]);
        }
      }
    },
    async getArticle(userId: string, id: string): Promise<Article | null> {
      const entry = await core.kv.get<Article>(["article", userId, id]);
      if (!entry.value) return null;
      return await hydrateArticle(core, userId, entry.value);
    },
    async getArticles(userId: string, ids: string[]): Promise<(Article | null)[]> {
      if (ids.length === 0) return [];
      const articles: (Article | null)[] = [];
      for (let start = 0; start < ids.length; start += EPISODE_READ_BATCH) {
        const chunk = ids.slice(start, start + EPISODE_READ_BATCH);
        const rows =
          (await core.kv.getMany(chunk.map((id) => ["article", userId, id]))) as Deno.KvEntryMaybe<
            Article
          >[];
        for (const row of rows) articles.push(row.value);
      }
      return await Promise.all(
        articles.map((art) =>
          art
            ? hydrateArticle(core, userId, art).catch((err: unknown) => {
              // Only a corrupt article degrades to a missing row. Anything else — a KV fault, a bug in
              // hydration — has to keep travelling, or an outage shows up as quietly absent content and
              // nobody notices. The single-article read path deliberately has no equivalent handler:
              // synthesis must fail closed rather than speak truncated text (audio-feed-jnor).
              if (!isCorruptArticleError(err)) throw err;
              console.warn(JSON.stringify({
                event: "article.corrupt",
                articleId: err.articleId,
                expectedChunks: err.expectedChunks,
                foundChunks: err.foundChunks,
                action: "omitted-from-batch",
              }));
              return null;
            })
            : Promise.resolve(null)
        ),
      );
    },
    async findArticleByUrl(userId: string, url: string): Promise<Article | null> {
      const pointer = await core.kv.get<string>(["article_by_url", userId, url]);
      if (!pointer.value) return null;
      return await host().getArticle(userId, pointer.value);
    },
    async deleteArticle(userId: string, id: string): Promise<void> {
      const article = (await core.kv.get<Article>(["article", userId, id])).value;
      await deleteArticleChunks(core, userId, id, article?.chunkCount);
      if (article) {
        await core.kv.atomic()
          .delete(["article", userId, id])
          .delete(["article_by_url", userId, article.url])
          .commit();
      }
    },
    // -- episodes -------------------------------------------------------------,
  };
}
