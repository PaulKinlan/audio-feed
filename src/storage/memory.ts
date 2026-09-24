/**
 * In-memory adapters. The reference implementation for both interfaces and the
 * default for tests — every other adapter must behave identically under the
 * conformance suite.
 *
 * Owned by: audio-feed-0h8.
 */

import type { ApprovalRecord, Article, Episode, Source, User } from "../types.ts";
import type { ListPendingOptions, ListPendingResult } from "./mod.ts";
import type { EpisodePage, EpisodePageResult } from "./mod.ts";
import { DEFAULT_CLAIM_LEASE_MS, isClaimExpired } from "../types.ts";
import {
  type BlobInfo,
  type BlobObject,
  type BlobStore,
  type ByteRange,
  collect,
  type EpisodeClaim,
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

  // The `async` keyword here is load-bearing, not decoration. `resolveRange`
  // throws for an unsatisfiable range; from a sync function returning
  // `Promise.resolve(...)` that throw escapes *before* the promise exists, so
  // `store.get(k).catch(...)` gets an uncaught exception on this adapter while
  // the S3 adapter rejects normally. Same interface, two failure modes — which
  // is exactly what the conformance suite caught. `async` converts the throw
  // into a rejection so every adapter behaves identically.
  // deno-lint-ignore require-await
  async get(key: string, opts?: { range?: ByteRange }): Promise<BlobObject | null> {
    const found = this.#objects.get(key);
    if (!found) return null;
    const range = resolveRange(opts?.range, found.bytes.byteLength);
    const slice = range ? found.bytes.subarray(range.start, range.end + 1) : found.bytes;
    return {
      key,
      size: found.bytes.byteLength,
      contentType: found.contentType,
      body: streamOf(slice),
      ...(range ? { range } : {}),
    };
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
  readonly #approvals: ApprovalRecord[] = [];
  readonly #sources = new Map<string, Source>();
  readonly #articles = new Map<string, Article>();
  readonly #episodes = new Map<string, Episode>();
  // Sorted indexes of pending and synthesizing episodes (audio-feed-7li)
  readonly #pendingIndex: { sortKey: string; userId: string; id: string }[] = [];
  readonly #synthesizingIndex: { sortKey: string; userId: string; id: string }[] = [];

  static #scoped(userId: string, id: string) {
    return `${userId}\u0000${id}`;
  }

  // -- users ----------------------------------------------------------------

  insertUser(user: User): Promise<boolean> {
    if (this.#users.has(user.id)) return Promise.resolve(false);
    const email = user.email.toLowerCase();
    for (const existing of this.#users.values()) {
      if (existing.email.toLowerCase() === email) return Promise.resolve(false);
      if (existing.feedToken === user.feedToken) return Promise.resolve(false);
    }
    this.#users.set(user.id, structuredClone(user));
    return Promise.resolve(true);
  }

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

  getUserByFeedToken(token: string): Promise<User | null> {
    if (!token) return Promise.resolve(null);
    for (const user of this.#users.values()) {
      if (user.feedToken === token) return Promise.resolve(structuredClone(user));
    }
    return Promise.resolve(null);
  }

  listUsers(): Promise<User[]> {
    return Promise.resolve([...this.#users.values()].map((u) => structuredClone(u)));
  }

  recordApproval(user: User, record: ApprovalRecord): Promise<void> {
    this.#users.set(user.id, structuredClone(user));
    this.#approvals.push(structuredClone(record));
    return Promise.resolve();
  }

  listApprovalLog(): Promise<ApprovalRecord[]> {
    const out = this.#approvals.map((record) => structuredClone(record));
    // Oldest first, tie-broken by user so repeated reads cannot swap entries.
    out.sort((a, b) => a.at === b.at ? a.userId.localeCompare(b.userId) : a.at.localeCompare(b.at));
    return Promise.resolve(out);
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

  deleteSource(userId: string, id: string): Promise<void> {
    this.#sources.delete(MemoryMetadataStore.#scoped(userId, id));
    return Promise.resolve();
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
    const key = MemoryMetadataStore.#scoped(episode.userId, episode.id);
    const existing = this.#episodes.get(key);
    if (existing) {
      const oldSortKey = `${existing.createdAt}\u0000${existing.id}`;
      removeSortedIndex(this.#pendingIndex, oldSortKey);
      removeSortedIndex(this.#synthesizingIndex, oldSortKey);
    }
    const newSortKey = `${episode.createdAt}\u0000${episode.id}`;
    if (episode.status === "pending") {
      insertSortedIndex(this.#pendingIndex, {
        sortKey: newSortKey,
        userId: episode.userId,
        id: episode.id,
      });
    } else if (episode.status === "synthesizing") {
      insertSortedIndex(this.#synthesizingIndex, {
        sortKey: newSortKey,
        userId: episode.userId,
        id: episode.id,
      });
    }
    this.#episodes.set(key, structuredClone(episode));
    return Promise.resolve();
  }

  getEpisode(userId: string, id: string): Promise<Episode | null> {
    const found = this.#episodes.get(MemoryMetadataStore.#scoped(userId, id));
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  deleteEpisode(userId: string, id: string): Promise<boolean> {
    const key = MemoryMetadataStore.#scoped(userId, id);
    const ep = this.#episodes.get(key);
    if (!ep) return Promise.resolve(false);
    const sortKey = `${ep.createdAt}\u0000${ep.id}`;
    removeSortedIndex(this.#pendingIndex, sortKey);
    removeSortedIndex(this.#synthesizingIndex, sortKey);
    this.#episodes.delete(key);
    return Promise.resolve(true);
  }

  backfillEpisodeSourceTitle(
    userId: string,
    id: string,
    sourceTitle: string,
  ): Promise<boolean> {
    const key = MemoryMetadataStore.#scoped(userId, id);
    const ep = this.#episodes.get(key);
    if (!ep) return Promise.resolve(false);
    if (!ep.sourceTitle) ep.sourceTitle = sourceTitle;
    return Promise.resolve(true);
  }

  listEpisodes(query: EpisodeQuery): Promise<Episode[]> {
    return this.listEpisodePage(query).then((page) => page.episodes);
  }

  listEpisodePage(query: EpisodePage): Promise<EpisodePageResult> {
    const limit = query.limit ?? 50;
    const matches = [...this.#episodes.values()]
      .filter((e) => e.userId === query.userId)
      .filter((e) => !query.sourceId || e.sourceId === query.sourceId)
      .filter((e) => !query.mode || e.mode === query.mode)
      .filter((e) => !query.status || e.status === query.status)
      .sort(byNewestFirst);
    // Cursor is the last returned episode's position in the total order, NOT an
    // array index: the array is rebuilt per call, so a concurrent delete behind
    // an index cursor shifts it and silently skips an episode — the exact
    // unrecoverable-skip class audio-feed-c9q was filed for, which this paging
    // exists to remove. (listPendingEpisodes still uses an index cursor; that is
    // audio-feed-7li's scope, and its worker caller tolerates a revisit.)
    let from = 0;
    if (query.cursor) {
      const at = query.cursor.lastIndexOf("|");
      const createdAt = at < 0 ? "" : query.cursor.slice(0, at);
      const id = at < 0 ? "" : query.cursor.slice(at + 1);
      const anchor = { createdAt, id };
      // First episode that sorts strictly AFTER the anchor (newest-first order).
      from = matches.findIndex((e) => byNewestFirst(anchor, e) < 0);
      if (from === -1) from = matches.length;
    }
    const end = Number.isFinite(limit) ? from + limit : matches.length;
    const episodes = matches.slice(from, end).map((e) => structuredClone(e));
    const last = episodes.at(-1);
    return Promise.resolve({
      episodes,
      cursor: end < matches.length && last ? `${last.createdAt}|${last.id}` : undefined,
    });
  }

  listPendingEpisodes(
    opts: ListPendingOptions = {},
  ): Promise<ListPendingResult> {
    const limit = opts.limit ?? 50;
    const nowMs = opts.nowMs ?? Date.now();
    const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;

    let startIndex = 0;
    if (opts.cursor) {
      if (/^\d+$/.test(opts.cursor)) {
        startIndex = parseInt(opts.cursor, 10);
      } else {
        const idx = binarySearchIndex(this.#pendingIndex, opts.cursor);
        startIndex = idx >= 0 ? idx + 1 : ~idx;
      }
    }

    const episodes: Episode[] = [];
    let currentIndex = startIndex;

    while (currentIndex < this.#pendingIndex.length) {
      if (Number.isFinite(limit) && episodes.length >= limit) break;
      const entry = this.#pendingIndex[currentIndex];
      currentIndex++;
      if (!entry) break;
      const ep = this.#episodes.get(MemoryMetadataStore.#scoped(entry.userId, entry.id));
      if (ep && ep.status === "pending") {
        episodes.push(structuredClone(ep));
      }
    }

    const last = this.#pendingIndex[currentIndex - 1];
    const nextCursor = currentIndex < this.#pendingIndex.length && last && episodes.length > 0
      ? last.sortKey
      : undefined;

    // Check synthesizing episodes with expired claims only on initial scan (cursor undefined),
    // matching KvMetadataStore behaviour
    if (!opts.cursor && (!Number.isFinite(limit) || episodes.length < limit)) {
      let addedExpired = false;
      for (const entry of this.#synthesizingIndex) {
        if (Number.isFinite(limit) && episodes.length >= limit) break;
        const ep = this.#episodes.get(MemoryMetadataStore.#scoped(entry.userId, entry.id));
        if (
          ep &&
          ep.status === "synthesizing" &&
          isClaimExpired(ep, nowMs, leaseMs)
        ) {
          episodes.push(structuredClone(ep));
          addedExpired = true;
        }
      }
      if (addedExpired) {
        episodes.sort(byOldestFirst);
      }
    }

    return Promise.resolve({ episodes, cursor: nextCursor });
  }

  /**
   * Single-threaded JS makes this trivially atomic: nothing can interleave
   * between the read and the write because there is no `await` between them.
   *
   * That is precisely why it must be written carefully rather than casually —
   * a memory adapter that grants a claim the KV adapter would refuse lets the
   * conformance suite pass while production double-spends, which is the exact
   * failure the suite exists to prevent.
   */
  claimEpisode(userId: string, episodeId: string, claim: EpisodeClaim): Promise<Episode | null> {
    const key = MemoryMetadataStore.#scoped(userId, episodeId);
    const found = this.#episodes.get(key);
    if (!found) return Promise.resolve(null);

    const nowMs = Date.parse(claim.now);
    const claimable = found.status === "pending" ||
      (found.status === "synthesizing" && isClaimExpired(found, nowMs, claim.leaseMs));
    if (!claimable) return Promise.resolve(null);

    const oldSortKey = `${found.createdAt}\u0000${found.id}`;
    const attempts = (found.attempts ?? 0) + 1;
    if (attempts > claim.maxClaims) {
      // Abandon rather than re-bill: an input that keeps killing its host would
      // otherwise be re-claimed forever on lease expiry.
      removeSortedIndex(this.#pendingIndex, oldSortKey);
      removeSortedIndex(this.#synthesizingIndex, oldSortKey);
      this.#episodes.set(key, {
        ...structuredClone(found),
        status: "failed",
        error: `abandoned after ${claim.maxClaims} attempts`,
        claimedAt: undefined,
        claimedBy: undefined,
      });
      return Promise.resolve(null);
    }

    const claimed: Episode = {
      ...structuredClone(found),
      status: "synthesizing",
      claimedAt: claim.now,
      claimedBy: claim.owner,
      attempts,
    };
    removeSortedIndex(this.#pendingIndex, oldSortKey);
    insertSortedIndex(this.#synthesizingIndex, {
      sortKey: oldSortKey,
      userId,
      id: episodeId,
    });
    this.#episodes.set(key, claimed);
    return Promise.resolve(structuredClone(claimed));
  }

  completeEpisode(episode: Episode, owner: string): Promise<boolean> {
    const key = MemoryMetadataStore.#scoped(episode.userId, episode.id);
    const current = this.#episodes.get(key);
    // Superseded: another worker reclaimed the expired lease and finished first.
    if (!current || current.status !== "synthesizing" || current.claimedBy !== owner) {
      return Promise.resolve(false);
    }
    const sortKey = `${current.createdAt}\u0000${current.id}`;
    removeSortedIndex(this.#synthesizingIndex, sortKey);
    removeSortedIndex(this.#pendingIndex, sortKey);
    this.#episodes.set(key, structuredClone(episode));
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Newest first, tie-broken by id so ordering is total and stable — episodes
 * minted in the same millisecond must not swap places between reads.
 */
/** The two fields that fully order an episode; an anchor cursor holds only these. */
export type EpisodeKey = Pick<Episode, "createdAt" | "id">;

export function byNewestFirst(a: EpisodeKey, b: EpisodeKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id.localeCompare(a.id);
}

export function byOldestFirst(a: Episode, b: Episode): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

interface IndexEntry {
  sortKey: string;
  userId: string;
  id: string;
}

function compareSortKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function binarySearchIndex(list: IndexEntry[], sortKey: string): number {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const item = list[mid];
    if (!item) break;
    const cmp = compareSortKeys(item.sortKey, sortKey);
    if (cmp === 0) return mid;
    if (cmp < 0) low = mid + 1;
    else high = mid - 1;
  }
  return ~low;
}

function insertSortedIndex(list: IndexEntry[], entry: IndexEntry): void {
  const idx = binarySearchIndex(list, entry.sortKey);
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.splice(~idx, 0, entry);
  }
}

function removeSortedIndex(list: IndexEntry[], sortKey: string): void {
  const idx = binarySearchIndex(list, sortKey);
  if (idx >= 0) {
    list.splice(idx, 1);
  }
}
