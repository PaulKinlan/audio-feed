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
import type { ListPendingOptions, ListPendingResult } from "./mod.ts";
import type { AtomicWrite, EpisodePage, EpisodePageResult } from "./mod.ts";
import {
  type BlobInfo,
  type BlobObject,
  type BlobStore,
  type ByteRange,
  collect,
  type DownloadCounts,
  type EpisodeClaim,
  type EpisodeQuery,
  type MetadataRepositories,
  type MetadataStore,
  resolveRange,
  type RunRecord,
  streamOf,
} from "./mod.ts";
import { createMemoryState } from "./memory/state.ts";
import type { MemoryState } from "./memory/state.ts";
import { createUsersRepository } from "./memory/users.ts";
import { createSourcesRepository } from "./memory/sources.ts";
import { createArticlesRepository } from "./memory/articles.ts";
import { createEpisodesRepository } from "./memory/episodes.ts";
import { createSegmentsRepository } from "./memory/synthesis-segments.ts";
import { createOrphanBlobsRepository } from "./memory/orphan-blobs.ts";
import { createUsageRepository } from "./memory/usage.ts";
import { createNotificationsRepository } from "./memory/notifications.ts";
import { createRunsRepository } from "./memory/runs.ts";
import { createAuthRepository } from "./memory/auth.ts";

// The collections and the sort helpers moved to ./memory/state.ts (audio-feed-8r1e); they
// stay re-exported here because this module is where callers and tests already import them.
export { byCreatedThenId, byNewestFirst, byOldestFirst, type EpisodeKey } from "./memory/state.ts";

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

  /**
   * Atomic conditional create for MemoryBlobStore.
   * Note: In-memory store provides single-isolate atomicity; test-only.
   * Guarantees that if the key already exists, returns null without overwriting.
   */
  async putIfAbsent(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string },
  ): Promise<BlobInfo | null> {
    if (this.#objects.has(key)) {
      return null;
    }
    const bytes = body instanceof Uint8Array ? body : await collect(body);
    const contentType = opts?.contentType ?? "application/octet-stream";
    if (this.#objects.has(key)) {
      return null;
    }
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
  /** Shared counters (audio-feed-2zvc): the same CAS shape the KV adapter implements. */
  readonly #atomics = new Map<string, { value: unknown; expiresAt?: number }>();
  #state: MemoryState;

  /**
   * The per-domain implementations (audio-feed-8r1e). Each member owns that entity's state and
   * logic; `repositories.episodes` and this class's `getEpisode` are the same call, but the work
   * happens in `src/storage/memory/episodes.ts`.
   */
  readonly repositories: MetadataRepositories;

  constructor() {
    this.#state = createMemoryState();
    this.repositories = {
      users: createUsersRepository(this.#state, () => this),
      sources: createSourcesRepository(this.#state, () => this),
      articles: createArticlesRepository(this.#state, () => this),
      episodes: createEpisodesRepository(this.#state, () => this),
      segments: createSegmentsRepository(this.#state, () => this),
      orphanBlobs: createOrphanBlobsRepository(this.#state, () => this),
      usage: createUsageRepository(this.#state, () => this),
      notifications: createNotificationsRepository(this.#state, () => this),
      runs: createRunsRepository(this.#state, () => this),
      auth: createAuthRepository(this.#state, () => this),
    };
  }

  // -- users --
  insertUser(user: User): Promise<boolean> {
    return this.repositories.users.insertUser(user);
  }
  putUser(user: User): Promise<void> {
    return this.repositories.users.putUser(user);
  }
  getUser(id: string): Promise<User | null> {
    return this.repositories.users.getUser(id);
  }
  getUserByEmail(email: string): Promise<User | null> {
    return this.repositories.users.getUserByEmail(email);
  }
  getUserByFeedToken(token: string): Promise<User | null> {
    return this.repositories.users.getUserByFeedToken(token);
  }
  listUsers(): Promise<User[]> {
    return this.repositories.users.listUsers();
  }
  recordApproval(user: User, record: ApprovalRecord): Promise<void> {
    return this.repositories.users.recordApproval(user, record);
  }
  listApprovalLog(): Promise<ApprovalRecord[]> {
    return this.repositories.users.listApprovalLog();
  }
  setAdminRole(
    userId: string,
    isAdmin: boolean,
    by: { adminId: string; at: string },
  ): Promise<"changed" | "unchanged" | "last-admin" | "missing"> {
    return this.repositories.users.setAdminRole(userId, isAdmin, by);
  }
  // -- sources --
  putSource(source: Source): Promise<void> {
    return this.repositories.sources.putSource(source);
  }
  getSource(userId: string, id: string): Promise<Source | null> {
    return this.repositories.sources.getSource(userId, id);
  }
  listSources(userId: string): Promise<Source[]> {
    return this.repositories.sources.listSources(userId);
  }
  deleteSource(userId: string, id: string): Promise<void> {
    return this.repositories.sources.deleteSource(userId, id);
  }
  // -- articles --
  putArticle(article: Article): Promise<void> {
    return this.repositories.articles.putArticle(article);
  }
  insertArticleIfAbsent(article: Article): Promise<boolean> {
    return this.repositories.articles.insertArticleIfAbsent(article);
  }
  insertArticleWithEpisodeIfAbsent(article: Article, episode: Episode): Promise<boolean> {
    return this.repositories.articles.insertArticleWithEpisodeIfAbsent(article, episode);
  }
  putArticleWithEpisode(article: Article, episode: Episode): Promise<void> {
    return this.repositories.articles.putArticleWithEpisode(article, episode);
  }
  getArticle(userId: string, id: string): Promise<Article | null> {
    return this.repositories.articles.getArticle(userId, id);
  }
  getArticles(userId: string, ids: string[]): Promise<(Article | null)[]> {
    return this.repositories.articles.getArticles(userId, ids);
  }
  findArticleByUrl(userId: string, url: string): Promise<Article | null> {
    return this.repositories.articles.findArticleByUrl(userId, url);
  }
  deleteArticle(userId: string, id: string): Promise<void> {
    return this.repositories.articles.deleteArticle(userId, id);
  }
  // -- episodes --
  putEpisode(episode: Episode): Promise<void> {
    return this.repositories.episodes.putEpisode(episode);
  }
  getEpisode(userId: string, id: string): Promise<Episode | null> {
    return this.repositories.episodes.getEpisode(userId, id);
  }
  deleteEpisode(userId: string, id: string): Promise<boolean> {
    return this.repositories.episodes.deleteEpisode(userId, id);
  }
  backfillEpisodeSourceTitle(userId: string, id: string, sourceTitle: string): Promise<boolean> {
    return this.repositories.episodes.backfillEpisodeSourceTitle(userId, id, sourceTitle);
  }

  updateEpisodeAudioKeyIfCurrent(
    userId: string,
    id: string,
    expectedKey: string,
    newKey: string,
  ): Promise<boolean> {
    return this.repositories.episodes.updateEpisodeAudioKeyIfCurrent(
      userId,
      id,
      expectedKey,
      newKey,
    );
  }
  listEpisodes(query: EpisodeQuery): Promise<Episode[]> {
    return this.repositories.episodes.listEpisodes(query);
  }
  listEpisodePage(query: EpisodePage): Promise<EpisodePageResult> {
    return this.repositories.episodes.listEpisodePage(query);
  }
  listPendingEpisodes(opts?: ListPendingOptions): Promise<ListPendingResult> {
    return this.repositories.episodes.listPendingEpisodes(opts);
  }
  claimEpisode(userId: string, episodeId: string, claim: EpisodeClaim): Promise<Episode | null> {
    return this.repositories.episodes.claimEpisode(userId, episodeId, claim);
  }
  completeEpisode(episode: Episode, owner: string): Promise<boolean> {
    return this.repositories.episodes.completeEpisode(episode, owner);
  }
  touchEpisodeClaim(
    userId: string,
    episodeId: string,
    owner: string,
    update: {
      phase?: string;
      now?: string;
      scriptTurns?: Array<{ speaker: string; text: string }>;
    },
  ): Promise<boolean> {
    return this.repositories.episodes.touchEpisodeClaim(userId, episodeId, owner, update);
  }
  yieldEpisodeClaim(
    userId: string,
    episodeId: string,
    owner: string,
    update?: {
      phase?: string;
      now?: string;
      advanceAttempts?: boolean;
    },
  ): Promise<boolean> {
    return this.repositories.episodes.yieldEpisodeClaim(userId, episodeId, owner, update);
  }
  retryEpisode(userId: string, id: string): Promise<Episode | null> {
    return this.repositories.episodes.retryEpisode(userId, id);
  }
  requeueEpisode(userId: string, id: string): Promise<Episode | null> {
    return this.repositories.episodes.requeueEpisode(userId, id);
  }
  cancelRegeneration(userId: string, id: string): Promise<boolean> {
    return this.repositories.episodes.cancelRegeneration(userId, id);
  }
  // -- segments --
  reserveSynthesisSegment(
    userId: string,
    episodeId: string,
    record: SynthesisSegmentRecord,
    nowMs: number,
    leaseMs: number,
  ): Promise<"reserved" | "finalized" | "no-claim"> {
    return this.repositories.segments.reserveSynthesisSegment(
      userId,
      episodeId,
      record,
      nowMs,
      leaseMs,
    );
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
    return this.repositories.segments.finalizeSynthesisSegment(
      userId,
      episodeId,
      slot,
      audio,
      owner,
      nowMs,
      leaseMs,
    );
  }
  listSynthesisSegments(userId: string, episodeId: string): Promise<SynthesisSegmentRecord[]> {
    return this.repositories.segments.listSynthesisSegments(userId, episodeId);
  }
  clearSynthesisSegments(userId: string, episodeId: string): Promise<void> {
    return this.repositories.segments.clearSynthesisSegments(userId, episodeId);
  }
  // -- orphanBlobs --
  recordOrphanBlob(key: string): Promise<void> {
    return this.repositories.orphanBlobs.recordOrphanBlob(key);
  }
  listOrphanBlobs(limit: number): Promise<string[]> {
    return this.repositories.orphanBlobs.listOrphanBlobs(limit);
  }
  forgetOrphanBlob(key: string): Promise<void> {
    return this.repositories.orphanBlobs.forgetOrphanBlob(key);
  }
  // -- usage --
  recordDownload(userId: string | null): Promise<void> {
    return this.repositories.usage.recordDownload(userId);
  }
  getDownloadCounts(): Promise<DownloadCounts> {
    return this.repositories.usage.getDownloadCounts();
  }
  recordSynthesis(userId: string, bytes: number, at?: Date): Promise<void> {
    return this.repositories.usage.recordSynthesis(userId, bytes, at);
  }
  getSynthesisCounts(today?: string): Promise<SynthesisCounts> {
    return this.repositories.usage.getSynthesisCounts(today);
  }
  getDailySynthesisCount(day: string): Promise<number> {
    return this.repositories.usage.getDailySynthesisCount(day);
  }
  getUserDailySynthesisCount(userId: string, day: string): Promise<number> {
    return this.repositories.usage.getUserDailySynthesisCount(userId, day);
  }
  // -- notifications --
  queueNotification(notification: OutboxNotification): Promise<void> {
    return this.repositories.notifications.queueNotification(notification);
  }
  listOutbox(limit?: number): Promise<OutboxNotification[]> {
    return this.repositories.notifications.listOutbox(limit);
  }
  ackNotification(id: string): Promise<boolean> {
    return this.repositories.notifications.ackNotification(id);
  }
  // -- runs --
  recordRun(record: RunRecord): Promise<void> {
    return this.repositories.runs.recordRun(record);
  }
  listRuns(limit?: number): Promise<RunRecord[]> {
    return this.repositories.runs.listRuns(limit);
  }
  // -- auth --
  putSession(session: Session): Promise<void> {
    return this.repositories.auth.putSession(session);
  }
  getSession(idHash: string): Promise<Session | null> {
    return this.repositories.auth.getSession(idHash);
  }
  deleteSession(idHash: string): Promise<void> {
    return this.repositories.auth.deleteSession(idHash);
  }
  putCredential(credential: PasskeyCredential): Promise<void> {
    return this.repositories.auth.putCredential(credential);
  }
  getCredential(id: string): Promise<PasskeyCredential | null> {
    return this.repositories.auth.getCredential(id);
  }
  listCredentials(userId: string): Promise<PasskeyCredential[]> {
    return this.repositories.auth.listCredentials(userId);
  }
  deleteCredential(userId: string, id: string): Promise<"deleted" | "last" | "missing"> {
    return this.repositories.auth.deleteCredential(userId, id);
  }
  putSetupLink(link: SetupLink): Promise<void> {
    return this.repositories.auth.putSetupLink(link);
  }
  getSetupLink(tokenHash: string): Promise<SetupLink | null> {
    return this.repositories.auth.getSetupLink(tokenHash);
  }
  consumeSetupLink(tokenHash: string): Promise<SetupLink | null> {
    return this.repositories.auth.consumeSetupLink(tokenHash);
  }
  putChallenge(challenge: AuthChallenge): Promise<void> {
    return this.repositories.auth.putChallenge(challenge);
  }
  consumeChallenge(challenge: string): Promise<AuthChallenge | null> {
    return this.repositories.auth.consumeChallenge(challenge);
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
  ): Promise<AtomicWrite<T>> {
    const now = Date.now();
    const row = this.#atomics.get(key);
    const live = row && (row.expiresAt === undefined || row.expiresAt > now);
    if (row && !live) this.#atomics.delete(key);
    const current = live ? row.value as T : null;
    const next = mutate(current);
    // A null return means "do not write"; the caller still gets what is there.
    if (next === null) return Promise.resolve({ value: current, committed: false });
    this.#atomics.set(key, {
      value: structuredClone(next),
      expiresAt: ttlMs === undefined ? undefined : now + ttlMs,
    });
    return Promise.resolve({ value: next, committed: true });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
