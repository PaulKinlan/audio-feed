/**
 * Deno KV metadata adapter — the production `MetadataStore`.
 *
 * Key design notes:
 *   - Episodes are indexed for the two reads the feeds actually perform:
 *     "newest N for a user" (master feed) and "newest N for a source+mode"
 *     (per-source feed). Both are `list` scans over a time-ordered key, not a
 *     full table scan, because the master feed is hit by every podcast client
 *     on a polling interval.
 *   - Sort keys use a descending timestamp so KV's natural ascending order
 *     yields newest-first without buffering the whole set.
 *
 * Owned by: audio-feed-0h8.
 */

import type { Article, Episode, Source, User } from "../types.ts";
import type { EpisodeQuery, MetadataStore } from "./mod.ts";

const MAX_TIME = 9_999_999_999_999; // ~year 2286, comfortably past any real createdAt

/**
 * Descending sort token: lexicographic ascending order over these strings is
 * chronological descending order over the source timestamps.
 */
export function descendingKey(iso: string, id: string): string {
  const ms = Date.parse(iso);
  const inverted = MAX_TIME - (Number.isFinite(ms) ? ms : 0);
  return `${inverted.toString().padStart(13, "0")}:${id}`;
}

export class KvMetadataStore implements MetadataStore {
  #kv: Deno.Kv;
  #ownsConnection: boolean;

  constructor(kv: Deno.Kv, opts?: { ownsConnection?: boolean }) {
    this.#kv = kv;
    this.#ownsConnection = opts?.ownsConnection ?? false;
  }

  static async open(path?: string): Promise<KvMetadataStore> {
    const kv = await Deno.openKv(path);
    return new KvMetadataStore(kv, { ownsConnection: true });
  }

  // -- users ----------------------------------------------------------------

  async putUser(user: User): Promise<void> {
    const emailKey = ["user_by_email", user.email.toLowerCase()];
    const existing = await this.#kv.get<User>(["user", user.id]);

    const tx = this.#kv.atomic().set(["user", user.id], user).set(emailKey, user.id);

    // An email change must not leave the old index pointing at this user.
    const previousEmail = existing.value?.email.toLowerCase();
    if (previousEmail && previousEmail !== user.email.toLowerCase()) {
      tx.delete(["user_by_email", previousEmail]);
    }

    const result = await tx.commit();
    if (!result.ok) throw new Error(`putUser failed for ${user.id}`);
  }

  async getUser(id: string): Promise<User | null> {
    return (await this.#kv.get<User>(["user", id])).value;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const pointer = await this.#kv.get<string>(["user_by_email", email.toLowerCase()]);
    if (!pointer.value) return null;
    return await this.getUser(pointer.value);
  }

  async listUsers(): Promise<User[]> {
    const out: User[] = [];
    for await (const entry of this.#kv.list<User>({ prefix: ["user"] })) {
      out.push(entry.value);
    }
    return out;
  }

  // -- sources --------------------------------------------------------------

  async putSource(source: Source): Promise<void> {
    await this.#kv.set(["source", source.userId, source.id], source);
  }

  async getSource(userId: string, id: string): Promise<Source | null> {
    return (await this.#kv.get<Source>(["source", userId, id])).value;
  }

  async listSources(userId: string): Promise<Source[]> {
    const out: Source[] = [];
    for await (const entry of this.#kv.list<Source>({ prefix: ["source", userId] })) {
      out.push(entry.value);
    }
    return out;
  }

  // -- articles -------------------------------------------------------------

  async putArticle(article: Article): Promise<void> {
    const result = await this.#kv.atomic()
      .set(["article", article.userId, article.id], article)
      .set(["article_by_url", article.userId, article.url], article.id)
      .commit();
    if (!result.ok) throw new Error(`putArticle failed for ${article.id}`);
  }

  async getArticle(userId: string, id: string): Promise<Article | null> {
    return (await this.#kv.get<Article>(["article", userId, id])).value;
  }

  async findArticleByUrl(userId: string, url: string): Promise<Article | null> {
    const pointer = await this.#kv.get<string>(["article_by_url", userId, url]);
    if (!pointer.value) return null;
    return await this.getArticle(userId, pointer.value);
  }

  // -- episodes -------------------------------------------------------------

  async putEpisode(episode: Episode): Promise<void> {
    const sortKey = descendingKey(episode.createdAt, episode.id);
    const result = await this.#kv.atomic()
      .set(["episode", episode.userId, episode.id], episode)
      // master feed index
      .set(["episode_by_user", episode.userId, sortKey], episode.id)
      // per-source-and-mode feed index
      .set(
        ["episode_by_source", episode.userId, episode.sourceId, episode.mode, sortKey],
        episode.id,
      )
      .commit();
    if (!result.ok) throw new Error(`putEpisode failed for ${episode.id}`);
  }

  async getEpisode(userId: string, id: string): Promise<Episode | null> {
    return (await this.#kv.get<Episode>(["episode", userId, id])).value;
  }

  async listEpisodes(query: EpisodeQuery): Promise<Episode[]> {
    const limit = query.limit ?? 50;
    const prefix = this.#indexPrefix(query);

    const out: Episode[] = [];
    // Keys are stored newest-first, so a plain ascending scan is already ordered.
    for await (const entry of this.#kv.list<string>({ prefix })) {
      const episode = await this.getEpisode(query.userId, entry.value);
      if (!episode) continue;
      if (query.sourceId && episode.sourceId !== query.sourceId) continue;
      if (query.mode && episode.mode !== query.mode) continue;
      if (query.status && episode.status !== query.status) continue;
      out.push(episode);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Only two prefixes are time-ordered end-to-end:
   *   - `episode_by_user/<user>`                    → newest across everything
   *   - `episode_by_source/<user>/<source>/<mode>`  → newest within one feed
   *
   * A `sourceId` without a `mode` must NOT scan `episode_by_source/<user>/<source>`:
   * the next key segment is `mode`, so that scan orders by mode first and only
   * then by time, i.e. every `deepdive` episode ahead of every `direct` one.
   * Fall back to the user index and filter — correct order beats a tighter scan.
   */
  #indexPrefix(query: EpisodeQuery): Deno.KvKey {
    if (query.sourceId && query.mode) {
      return ["episode_by_source", query.userId, query.sourceId, query.mode];
    }
    return ["episode_by_user", query.userId];
  }

  close(): Promise<void> {
    if (this.#ownsConnection) this.#kv.close();
    return Promise.resolve();
  }
}
