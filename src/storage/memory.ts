/**
 * In-memory adapters. The reference implementation for both interfaces and the
 * default for tests — every other adapter must behave identically under the
 * conformance suite.
 *
 * Owned by: audio-feed-0h8.
 */

import type { Article, AudioMode, Episode, Source, User } from "../types.ts";
import {
  type BlobInfo,
  type BlobObject,
  type BlobStore,
  type ByteRange,
  collect,
  type EpisodeQuery,
  type MetadataStore,
  resolveRange,
  streamOf,
} from "./mod.ts";

export class MemoryBlobStore implements BlobStore {
  readonly #objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string },
  ): Promise<BlobInfo> {
    const bytes = body instanceof Uint8Array ? body : await collect(body);
    const contentType = opts?.contentType ?? "application/octet-stream";
    this.#objects.set(key, { bytes, contentType });
    return { key, size: bytes.byteLength, contentType };
  }

  get(key: string, opts?: { range?: ByteRange }): Promise<BlobObject | null> {
    const found = this.#objects.get(key);
    if (!found) return Promise.resolve(null);
    const range = resolveRange(opts?.range, found.bytes.byteLength);
    const slice = range ? found.bytes.subarray(range.start, range.end + 1) : found.bytes;
    return Promise.resolve({
      key,
      size: found.bytes.byteLength,
      contentType: found.contentType,
      body: streamOf(slice),
      ...(range ? { range } : {}),
    });
  }

  head(key: string): Promise<BlobInfo | null> {
    const found = this.#objects.get(key);
    return Promise.resolve(
      found ? { key, size: found.bytes.byteLength, contentType: found.contentType } : null,
    );
  }

  delete(key: string): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }

  /** Not client-reachable: callers proxy through `GET /audio/:key`. */
  url(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

export class MemoryMetadataStore implements MetadataStore {
  readonly #users = new Map<string, User>();
  readonly #sources = new Map<string, Source>();
  readonly #articles = new Map<string, Article>();
  readonly #episodes = new Map<string, Episode>();

  static #scoped(userId: string, id: string) {
    return `${userId}\u0000${id}`;
  }

  // -- users ----------------------------------------------------------------

  putUser(user: User): Promise<void> {
    this.#users.set(user.id, structuredClone(user));
    return Promise.resolve();
  }

  getUser(id: string): Promise<User | null> {
    const found = this.#users.get(id);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  getUserByEmail(email: string): Promise<User | null> {
    const needle = email.toLowerCase();
    for (const user of this.#users.values()) {
      if (user.email.toLowerCase() === needle) return Promise.resolve(structuredClone(user));
    }
    return Promise.resolve(null);
  }

  listUsers(): Promise<User[]> {
    return Promise.resolve([...this.#users.values()].map((u) => structuredClone(u)));
  }

  // -- sources --------------------------------------------------------------

  putSource(source: Source): Promise<void> {
    this.#sources.set(
      MemoryMetadataStore.#scoped(source.userId, source.id),
      structuredClone(source),
    );
    return Promise.resolve();
  }

  getSource(userId: string, id: string): Promise<Source | null> {
    const found = this.#sources.get(MemoryMetadataStore.#scoped(userId, id));
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  listSources(userId: string): Promise<Source[]> {
    const out = [...this.#sources.values()]
      .filter((s) => s.userId === userId)
      .map((s) => structuredClone(s))
      .sort((a, b) => a.id.localeCompare(b.id));
    return Promise.resolve(out);
  }

  // -- articles -------------------------------------------------------------

  putArticle(article: Article): Promise<void> {
    this.#articles.set(
      MemoryMetadataStore.#scoped(article.userId, article.id),
      structuredClone(article),
    );
    return Promise.resolve();
  }

  getArticle(userId: string, id: string): Promise<Article | null> {
    const found = this.#articles.get(MemoryMetadataStore.#scoped(userId, id));
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  findArticleByUrl(userId: string, url: string): Promise<Article | null> {
    for (const article of this.#articles.values()) {
      if (article.userId === userId && article.url === url) {
        return Promise.resolve(structuredClone(article));
      }
    }
    return Promise.resolve(null);
  }

  // -- episodes -------------------------------------------------------------

  putEpisode(episode: Episode): Promise<void> {
    this.#episodes.set(
      MemoryMetadataStore.#scoped(episode.userId, episode.id),
      structuredClone(episode),
    );
    return Promise.resolve();
  }

  getEpisode(userId: string, id: string): Promise<Episode | null> {
    const found = this.#episodes.get(MemoryMetadataStore.#scoped(userId, id));
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  listEpisodes(query: EpisodeQuery): Promise<Episode[]> {
    const limit = query.limit ?? 50;
    const out = [...this.#episodes.values()]
      .filter((e) => e.userId === query.userId)
      .filter((e) => !query.sourceId || e.sourceId === query.sourceId)
      .filter((e) => !query.mode || e.mode === query.mode)
      .filter((e) => !query.status || e.status === query.status)
      .sort(byNewestFirst)
      .slice(0, limit)
      .map((e) => structuredClone(e));
    return Promise.resolve(out);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Newest first, tie-broken by id so ordering is total and stable — episodes
 * minted in the same millisecond must not swap places between reads.
 */
export function byNewestFirst(a: Episode, b: Episode): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id.localeCompare(a.id);
}

/** Convenience for tests and local dev. */
export function memoryStores(): { metadata: MemoryMetadataStore; blobs: MemoryBlobStore } {
  return { metadata: new MemoryMetadataStore(), blobs: new MemoryBlobStore() };
}

export type { AudioMode };
