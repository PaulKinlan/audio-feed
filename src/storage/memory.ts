/**
 * In-memory adapters. The reference implementation for both interfaces and the
 * default for tests — every other adapter must behave identically under the
 * conformance suite.
 *
 * Owned by: audio-feed-0h8.
 */

import type {
  ApprovalRecord,
  Article,
  AuthChallenge,
  Episode,
  OutboxNotification,
  PasskeyCredential,
  Session,
  SetupLink,
  Source,
  SynthesisCounts,
  SynthesisSegmentRecord,
  User,
} from "../types.ts";
import { utcDayKey } from "../types.ts";
import type { ListPendingOptions, ListPendingResult } from "./mod.ts";
import type { EpisodePage, EpisodePageResult } from "./mod.ts";
import { DEFAULT_CLAIM_LEASE_MS, isClaimExpired, isPublishable, unsynthesized } from "../types.ts";
import {
  type BlobInfo,
  type BlobObject,
  type BlobStore,
  type ByteRange,
  collect,
  compareRunsNewestFirst,
  type DownloadCounts,
  type EpisodeClaim,
  type EpisodeQuery,
  type MetadataStore,
  resolveRange,
  RUN_HISTORY_LIMIT,
  RUN_KINDS,
  type RunRecord,
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
  /** URL → article id, mirroring KV's `article_by_url` index (audio-feed-d8q). */
  readonly #articleByUrl = new Map<string, string>();
  readonly #episodes = new Map<string, Episode>();
  /** audio-feed-wr1u: persisted TTS segments per episode, keyed by slot (hash@version@voice). */
  readonly #segments = new Map<string, Map<string, SynthesisSegmentRecord>>();

  /** One slot per (text, prompt version, voice): drift opens a new slot, never a fight. */
  static #slotKey(slot: { textHash: string; promptVersion: string; voice: string }): string {
    return `${slot.textHash}\u0000${slot.promptVersion}\u0000${slot.voice}`;
  }
  // Sorted indexes of pending and synthesizing episodes (audio-feed-7li)
  readonly #pendingIndex: { sortKey: string; userId: string; id: string }[] = [];
  readonly #synthesizingIndex: { sortKey: string; userId: string; id: string }[] = [];
  // Operational stats (audio-feed-ndc). Single-threaded here, so a plain
  // counter is already atomic; the KV adapter needs `.sum()` for the same job.
  #downloadTotal = 0;
  readonly #downloadsByUser = new Map<string, number>();
  readonly #runs: RunRecord[] = [];
  // Accounts (audio-feed-8fc).
  readonly #sessions = new Map<string, Session>();
  readonly #credentials = new Map<string, PasskeyCredential>();
  readonly #setupLinks = new Map<string, SetupLink>();
  readonly #challenges = new Map<string, AuthChallenge>();
  readonly #orphanBlobs = new Set<string>();
  #synthesisTotal = 0;
  #synthesisTotalBytes = 0;
  readonly #synthesisByUser = new Map<string, { count: number; bytes: number }>();
  readonly #synthesisByUserAndDay = new Map<string, number>();
  readonly #outbox: OutboxNotification[] = [];
  /** Shared counters (audio-feed-2zvc): the same CAS shape the KV adapter implements. */
  readonly #atomics = new Map<string, { value: unknown; expiresAt?: number }>();

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

  // Single-threaded: the admin count and the write cannot interleave with another call.
  setAdminRole(
    userId: string,
    isAdmin: boolean,
    by: { adminId: string; at: string },
  ): Promise<"changed" | "unchanged" | "last-admin" | "missing"> {
    const target = this.#users.get(userId);
    if (!target) return Promise.resolve("missing");
    if (target.isAdmin === isAdmin) return Promise.resolve("unchanged");
    if (!isAdmin && target.status === "approved") {
      const others = [...this.#users.values()].filter((u) =>
        u.id !== userId && u.isAdmin && u.status === "approved"
      );
      if (others.length === 0) return Promise.resolve("last-admin");
    }
    this.#users.set(userId, { ...target, isAdmin });
    this.#approvals.push({
      userId,
      action: "role",
      adminId: by.adminId,
      at: by.at,
      fromRole: isAdmin ? "user" : "admin",
      toRole: isAdmin ? "admin" : "user",
    });
    return Promise.resolve("changed");
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
    this.#indexArticle(article);
    return Promise.resolve();
  }

  /**
   * Record an article and point the URL index at it, which is what the KV adapter's
   * `article_by_url` key does. Kept as a real index rather than a scan so the two
   * adapters agree on which article a URL resolves to after the same URL is written
   * twice — the inbox re-send case (audio-feed-d8q), where scanning returned the
   * OLDEST match here while KV returned the NEWEST.
   */
  #indexArticle(article: Article): void {
    this.#articles.set(
      MemoryMetadataStore.#scoped(article.userId, article.id),
      structuredClone(article),
    );
    this.#articleByUrl.set(`${article.userId}\u0000${article.url}`, article.id);
  }

  insertArticleIfAbsent(article: Article): Promise<boolean> {
    if (this.#hasArticleByUrl(article.userId, article.url)) return Promise.resolve(false);
    this.#indexArticle(article);
    return Promise.resolve(true);
  }

  insertArticleWithEpisodeIfAbsent(
    article: Article,
    episode: Episode,
  ): Promise<boolean> {
    // The whole body runs without an await, so no other task can observe an
    // article whose episode is missing (audio-feed-2th).
    if (this.#hasArticleByUrl(article.userId, article.url)) return Promise.resolve(false);
    this.#indexArticle(article);
    this.#writeEpisode(episode);
    return Promise.resolve(true);
  }

  putArticleWithEpisode(article: Article, episode: Episode): Promise<void> {
    // Synchronous start to finish, so no other task observes an article whose episode
    // is not yet there (audio-feed-d8q).
    this.#indexArticle(article);
    this.#writeEpisode(episode);
    return Promise.resolve();
  }

  #hasArticleByUrl(userId: string, url: string): boolean {
    return this.#articleByUrl.has(`${userId}\u0000${url}`);
  }

  getArticle(userId: string, id: string): Promise<Article | null> {
    const found = this.#articles.get(MemoryMetadataStore.#scoped(userId, id));
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  getArticles(userId: string, ids: string[]): Promise<(Article | null)[]> {
    return Promise.resolve(ids.map((id) => {
      const found = this.#articles.get(MemoryMetadataStore.#scoped(userId, id));
      return found ? structuredClone(found) : null;
    }));
  }

  findArticleByUrl(userId: string, url: string): Promise<Article | null> {
    const id = this.#articleByUrl.get(`${userId}\u0000${url}`);
    if (!id) return Promise.resolve(null);
    return this.getArticle(userId, id);
  }

  deleteArticle(userId: string, id: string): Promise<void> {
    const key = MemoryMetadataStore.#scoped(userId, id);
    const existing = this.#articles.get(key);
    if (existing) {
      this.#articles.delete(key);
      this.#articleByUrl.delete(`${userId}\u0000${existing.url}`);
    }
    return Promise.resolve();
  }

  // -- episodes -------------------------------------------------------------

  #writeEpisode(episode: Episode): void {
    const key = MemoryMetadataStore.#scoped(episode.userId, episode.id);
    const existing = this.#episodes.get(key);
    if (existing) {
      this.#removePendingPointer(existing);
      removeSortedIndex(this.#synthesizingIndex, `${existing.createdAt}\u0000${existing.id}`);
    }
    if (episode.status === "pending") {
      insertSortedIndex(this.#pendingIndex, {
        sortKey: pendingSortKey(episode),
        userId: episode.userId,
        id: episode.id,
      });
    } else if (episode.status === "synthesizing") {
      // The claim index keeps the plain date key: an in-flight job is not queued work, so it
      // has no priority segment (audio-feed-15e).
      insertSortedIndex(this.#synthesizingIndex, {
        sortKey: `${episode.createdAt}\u0000${episode.id}`,
        userId: episode.userId,
        id: episode.id,
      });
    }
    this.#episodes.set(key, structuredClone(episode));
  }

  putEpisode(episode: Episode): Promise<void> {
    this.#writeEpisode(episode);
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
    this.#removePendingPointer(ep);
    removeSortedIndex(this.#synthesizingIndex, `${ep.createdAt}\u0000${ep.id}`);
    this.#episodes.delete(key);
    return Promise.resolve(true);
  }

  /** Clear a pending pointer from the queue, whichever priority it was written under. */
  #removePendingPointer(episode: {
    createdAt: string;
    id: string;
    regenerating?: boolean;
  }): void {
    const [newWork, regeneration] = pendingSortKeys(episode);
    removeSortedIndex(this.#pendingIndex, newWork);
    removeSortedIndex(this.#pendingIndex, regeneration);
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

  async listPendingEpisodes(
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
      const ep = await this.getEpisode(entry.userId, entry.id);
      if (ep && ep.status === "pending") {
        episodes.push(ep);
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
        const ep = await this.getEpisode(entry.userId, entry.id);
        if (
          ep &&
          ep.status === "synthesizing" &&
          isClaimExpired(ep, nowMs, leaseMs)
        ) {
          episodes.push(ep);
          addedExpired = true;
        }
      }
      if (addedExpired) {
        episodes.sort(byOldestFirst);
      }
    }

    return { episodes, cursor: nextCursor };
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
      this.#removePendingPointer(found);
      removeSortedIndex(this.#synthesizingIndex, oldSortKey);
      this.#episodes.set(key, {
        ...unsynthesized(structuredClone(found), `abandoned after ${claim.maxClaims} attempts`),
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
    this.#removePendingPointer(found);
    insertSortedIndex(this.#synthesizingIndex, {
      sortKey: oldSortKey,
      userId,
      id: episodeId,
    });
    this.#episodes.set(key, claimed);
    return Promise.resolve(structuredClone(claimed));
  }

  reserveSynthesisSegment(
    userId: string,
    episodeId: string,
    record: SynthesisSegmentRecord,
    nowMs: number,
    leaseMs: number,
  ): Promise<"reserved" | "finalized" | "no-claim"> {
    const episode = this.#episodes.get(MemoryMetadataStore.#scoped(userId, episodeId));
    // Spend guard: only the live claimant reserves. A superseded worker's reserve is
    // refused here, not at finalize, so it never reaches the paid call.
    if (
      !episode || episode.status !== "synthesizing" || episode.claimedBy !== record.owner ||
      isClaimExpired(episode, nowMs, leaseMs)
    ) {
      return Promise.resolve("no-claim");
    }
    const key = MemoryMetadataStore.#scoped(userId, episodeId);
    let slots = this.#segments.get(key);
    if (!slots) {
      slots = new Map();
      this.#segments.set(key, slots);
    }
    const slotKey = MemoryMetadataStore.#slotKey(record);
    const current = slots.get(slotKey);
    if (current?.finalized) return Promise.resolve("finalized");
    // A reservation by anyone other than the live claimant is by definition left by a
    // claim that has since moved on: stealable, like an expired episode lease.
    slots.set(slotKey, structuredClone(record));
    return Promise.resolve("reserved");
  }

  finalizeSynthesisSegment(
    userId: string,
    episodeId: string,
    slot: { textHash: string; promptVersion: string; voice: string },
    audio: { audioKey: string; byteLength: number },
    owner: string,
    nowMs: number,
    leaseMs: number,
  ): Promise<boolean> {
    const episode = this.#episodes.get(MemoryMetadataStore.#scoped(userId, episodeId));
    if (
      !episode || episode.status !== "synthesizing" || episode.claimedBy !== owner ||
      isClaimExpired(episode, nowMs, leaseMs)
    ) {
      return Promise.resolve(false);
    }
    const slots = this.#segments.get(MemoryMetadataStore.#scoped(userId, episodeId));
    const current = slots?.get(MemoryMetadataStore.#slotKey(slot));
    if (!current || current.finalized || current.owner !== owner) return Promise.resolve(false);
    slots!.set(MemoryMetadataStore.#slotKey(slot), {
      ...structuredClone(current),
      audioKey: audio.audioKey,
      byteLength: audio.byteLength,
      finalized: true,
    });
    return Promise.resolve(true);
  }

  listSynthesisSegments(userId: string, episodeId: string): Promise<SynthesisSegmentRecord[]> {
    const slots = this.#segments.get(MemoryMetadataStore.#scoped(userId, episodeId));
    return Promise.resolve([...(slots?.values() ?? [])].map((r) => structuredClone(r)));
  }

  clearSynthesisSegments(userId: string, episodeId: string): Promise<void> {
    this.#segments.delete(MemoryMetadataStore.#scoped(userId, episodeId));
    return Promise.resolve();
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
    this.#removePendingPointer(current);
    this.#episodes.set(key, structuredClone(episode));
    return Promise.resolve(true);
  }

  requeueEpisode(userId: string, id: string): Promise<Episode | null> {
    const found = this.#episodes.get(MemoryMetadataStore.#scoped(userId, id));
    if (!found || found.status !== "ready" || !isPublishable(found)) {
      return Promise.resolve(null);
    }
    const queued: Episode = {
      ...structuredClone(found),
      status: "pending",
      regenerating: true,
      attempts: undefined,
      claimedAt: undefined,
      claimedBy: undefined,
      error: undefined,
    };
    this.#writeEpisode(queued);
    return Promise.resolve(structuredClone(queued));
  }

  retryEpisode(userId: string, id: string): Promise<Episode | null> {
    const key = MemoryMetadataStore.#scoped(userId, id);
    const found = this.#episodes.get(key);
    if (!found || found.status !== "failed") return Promise.resolve(null);
    const queued: Episode = {
      ...structuredClone(found),
      status: "pending",
      attempts: undefined,
      claimedAt: undefined,
      claimedBy: undefined,
      error: undefined,
      regenerating: undefined,
    };
    // No await between the read and the write, so this is as single-stepped as the KV
    // versionstamp check it is matching (see the note above #writeEpisode).
    this.#writeEpisode(queued);
    return Promise.resolve(structuredClone(queued));
  }

  cancelRegeneration(userId: string, id: string): Promise<boolean> {
    const found = this.#episodes.get(MemoryMetadataStore.#scoped(userId, id));
    if (
      !found?.regenerating || (found.status !== "pending" && found.status !== "synthesizing")
    ) {
      return Promise.resolve(false);
    }
    this.#writeEpisode({
      ...found,
      status: "ready",
      regenerating: undefined,
      claimedAt: undefined,
      claimedBy: undefined,
    });
    return Promise.resolve(true);
  }

  recordOrphanBlob(key: string): Promise<void> {
    this.#orphanBlobs.add(key);
    return Promise.resolve();
  }

  listOrphanBlobs(limit: number): Promise<string[]> {
    return Promise.resolve([...this.#orphanBlobs].slice(0, limit));
  }

  forgetOrphanBlob(key: string): Promise<void> {
    this.#orphanBlobs.delete(key);
    return Promise.resolve();
  }

  // -- operational stats (audio-feed-ndc) ------------------------------------

  recordDownload(userId: string | null): Promise<void> {
    this.#downloadTotal++;
    if (userId) {
      this.#downloadsByUser.set(userId, (this.#downloadsByUser.get(userId) ?? 0) + 1);
    }
    return Promise.resolve();
  }

  getDownloadCounts(): Promise<DownloadCounts> {
    const perUser = [...this.#downloadsByUser.entries()]
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count);
    return Promise.resolve({ total: this.#downloadTotal, perUser });
  }

  // Synthesis stats & budget tracking (audio-feed-9mp)
  recordSynthesis(userId: string, bytes: number, at = new Date()): Promise<void> {
    const day = utcDayKey(at);
    this.#synthesisTotal++;
    this.#synthesisTotalBytes += bytes;
    const userTotal = this.#synthesisByUser.get(userId) ?? { count: 0, bytes: 0 };
    this.#synthesisByUser.set(userId, {
      count: userTotal.count + 1,
      bytes: userTotal.bytes + bytes,
    });
    const dayKey = `${userId}:${day}`;
    this.#synthesisByUserAndDay.set(dayKey, (this.#synthesisByUserAndDay.get(dayKey) ?? 0) + 1);
    return Promise.resolve();
  }

  getSynthesisCounts(today = utcDayKey()): Promise<SynthesisCounts> {
    const perUser = [...this.#synthesisByUser.entries()]
      .map(([userId, data]) => ({
        userId,
        count: data.count,
        bytes: data.bytes,
        todayCount: this.#synthesisByUserAndDay.get(`${userId}:${today}`) ?? 0,
      }))
      .sort((a, b) => b.count - a.count);
    return Promise.resolve({
      total: this.#synthesisTotal,
      totalBytes: this.#synthesisTotalBytes,
      perUser,
    });
  }

  getUserDailySynthesisCount(userId: string, day: string): Promise<number> {
    return Promise.resolve(this.#synthesisByUserAndDay.get(`${userId}:${day}`) ?? 0);
  }

  // -- outbox notifications (audio-feed-np5) --------------------------------

  queueNotification(notification: OutboxNotification): Promise<void> {
    // Deduplicate: skip if an entry for the same episodeId and status already exists
    const duplicate = this.#outbox.some(
      (n) => n.episodeId === notification.episodeId && n.status === notification.status,
    );
    if (duplicate) return Promise.resolve();

    this.#outbox.push(structuredClone(notification));
    // Keep outbox bounded in memory to 500 items, pruning delivered items first
    if (this.#outbox.length > 500) {
      const deliveredIdx = this.#outbox.findIndex((n) => n.deliveredAt);
      if (deliveredIdx >= 0) {
        this.#outbox.splice(deliveredIdx, 1);
      } else {
        this.#outbox.shift();
      }
    }
    return Promise.resolve();
  }

  listOutbox(limit = 50): Promise<OutboxNotification[]> {
    return Promise.resolve(
      this.#outbox
        .filter((n) => !n.deliveredAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map((n) => structuredClone(n)),
    );
  }

  ackNotification(id: string): Promise<boolean> {
    const found = this.#outbox.find((n) => n.id === id);
    if (!found || found.deliveredAt) return Promise.resolve(false);
    found.deliveredAt = new Date().toISOString();
    return Promise.resolve(true);
  }

  /** Newest first, bounded on write per job — the same contract the KV adapter honours. */
  recordRun(record: RunRecord): Promise<void> {
    // A run of idle ticks is kept as one row, the latest, as in the KV adapter
    // (audio-feed-0ob). #runs is newest first, so find() gets the job's newest.
    const newest = this.#runs.find((r) => r.kind === record.kind);
    if (
      record.idle && newest?.idle &&
      Date.parse(newest.startedAt) <= Date.parse(record.startedAt)
    ) {
      this.#runs.splice(this.#runs.indexOf(newest), 1);
    }
    this.#runs.push(structuredClone(record));
    this.#runs.sort(compareRunsNewestFirst);
    // Per job (audio-feed-ct1): a busy job must not evict a quiet one's history.
    const sameJob = this.#runs.filter((r) => r.kind === record.kind);
    for (const stale of sameJob.slice(RUN_HISTORY_LIMIT)) {
      this.#runs.splice(this.#runs.indexOf(stale), 1);
    }
    return Promise.resolve();
  }

  listRuns(limit = RUN_HISTORY_LIMIT * RUN_KINDS.length): Promise<RunRecord[]> {
    return Promise.resolve(this.#runs.slice(0, limit).map((r) => structuredClone(r)));
  }

  // -- accounts (audio-feed-8fc) --------------------------------------------

  putSession(session: Session): Promise<void> {
    this.#sessions.set(session.idHash, structuredClone(session));
    return Promise.resolve();
  }

  getSession(idHash: string): Promise<Session | null> {
    const found = this.#sessions.get(idHash);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  deleteSession(idHash: string): Promise<void> {
    this.#sessions.delete(idHash);
    return Promise.resolve();
  }

  putCredential(credential: PasskeyCredential): Promise<void> {
    this.#credentials.set(credential.id, structuredClone(credential));
    return Promise.resolve();
  }

  getCredential(id: string): Promise<PasskeyCredential | null> {
    const found = this.#credentials.get(id);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  listCredentials(userId: string): Promise<PasskeyCredential[]> {
    return Promise.resolve(
      [...this.#credentials.values()]
        .filter((c) => c.userId === userId)
        .sort(byCreatedThenId)
        .map((c) => structuredClone(c)),
    );
  }

  // Single-threaded: the count and the delete cannot interleave with another call.
  deleteCredential(userId: string, id: string): Promise<"deleted" | "last" | "missing"> {
    const found = this.#credentials.get(id);
    if (!found || found.userId !== userId) return Promise.resolve("missing");
    const owned = [...this.#credentials.values()].filter((c) => c.userId === userId).length;
    if (owned <= 1) return Promise.resolve("last");
    this.#credentials.delete(id);
    return Promise.resolve("deleted");
  }

  putSetupLink(link: SetupLink): Promise<void> {
    this.#setupLinks.set(link.tokenHash, structuredClone(link));
    return Promise.resolve();
  }

  getSetupLink(tokenHash: string): Promise<SetupLink | null> {
    const found = this.#setupLinks.get(tokenHash);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  consumeSetupLink(tokenHash: string): Promise<SetupLink | null> {
    // Single-threaded: read and delete cannot interleave with another consumer.
    const found = this.#setupLinks.get(tokenHash);
    this.#setupLinks.delete(tokenHash);
    return Promise.resolve(found ?? null);
  }

  putChallenge(challenge: AuthChallenge): Promise<void> {
    this.#challenges.set(challenge.challenge, structuredClone(challenge));
    return Promise.resolve();
  }

  consumeChallenge(challenge: string): Promise<AuthChallenge | null> {
    const found = this.#challenges.get(challenge);
    this.#challenges.delete(challenge);
    return Promise.resolve(found ?? null);
  }

  /**
   * Shared counters (audio-feed-2zvc). Single-threaded: the callback and the
   * write below cannot interleave with another request, so this is already the
   * atomic step the KV adapter has to make explicit with a versionstamp check.
   * The two adapters are deliberately the same shape so policy above them has
   * one behaviour to reason about.
   */
  atomicUpdate<T>(
    key: string,
    mutate: (current: T | null) => T | null,
    ttlMs?: number,
  ): Promise<T | null> {
    const now = Date.now();
    const row = this.#atomics.get(key);
    const live = row && (row.expiresAt === undefined || row.expiresAt > now);
    if (row && !live) this.#atomics.delete(key);
    const current = live ? row.value as T : null;
    const next = mutate(current);
    // A null return means "do not write"; the caller still gets what is there.
    if (next === null) return Promise.resolve(current);
    this.#atomics.set(key, {
      value: structuredClone(next),
      expiresAt: ttlMs === undefined ? undefined : now + ttlMs,
    });
    return Promise.resolve(next);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Oldest first, tie-broken by id: the passkey list order both adapters share. */
export function byCreatedThenId(
  a: Pick<PasskeyCredential, "createdAt" | "id">,
  b: Pick<PasskeyCredential, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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

/**
 * The pending-index sort keys for an episode's date — BOTH priorities, so a removal can never
 * miss the pointer it means to clear (audio-feed-15e). The leading segment is what makes new
 * work sort ahead of regenerations; see `pendingSortKey`.
 */
function pendingSortKeys(episode: {
  createdAt: string;
  id: string;
  regenerating?: boolean;
}): [string, string] {
  return [
    `0\u0000${episode.createdAt}\u0000${episode.id}`,
    `1\u0000${episode.createdAt}\u0000${episode.id}`,
  ];
}

/** The one queue key an episode's pending pointer lives under, chosen by its flag. */
function pendingSortKey(episode: {
  createdAt: string;
  id: string;
  regenerating?: boolean;
}): string {
  return episode.regenerating ? pendingSortKeys(episode)[1] : pendingSortKeys(episode)[0];
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
