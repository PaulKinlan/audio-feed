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
  User,
} from "../types.ts";
import { SynthesisSegmentRecord } from "../types.ts";
import type {
  AtomicWrite,
  DownloadCounts,
  EpisodeBilling,
  EpisodeClaim,
  EpisodePage,
  EpisodePageResult,
  EpisodeQuery,
  ListPendingOptions,
  ListPendingResult,
  LogBounds,
  LogQuery,
  LogRecord,
  LogSummary,
  MetadataRepositories,
  MetadataStore,
  RunRecord,
} from "./mod.ts";
import { createKvCore } from "./kv/core.ts";
import type { KvCore } from "./kv/core.ts";
import { pendingKey } from "./kv/core.ts";
import { createUsersRepository } from "./kv/users.ts";
import { createSourcesRepository } from "./kv/sources.ts";
import { createArticlesRepository } from "./kv/articles.ts";
import { createEpisodesRepository } from "./kv/episodes.ts";
import { createSegmentsRepository } from "./kv/synthesis-segments.ts";
import { createOrphanBlobsRepository } from "./kv/orphan-blobs.ts";
import { createUsageRepository } from "./kv/usage.ts";
import { createNotificationsRepository } from "./kv/notifications.ts";
import { createRunsRepository } from "./kv/runs.ts";
import { createLogsRepository } from "./kv/logs.ts";
import { createAuthRepository } from "./kv/auth.ts";

export {
  ARTICLE_CHUNK_SIZE,
  CorruptArticleError,
  descendingKey,
  EPISODE_READ_BATCH,
  isCorruptArticleError,
} from "./kv/core.ts";

export class KvMetadataStore implements MetadataStore {
  #kv: Deno.Kv;
  #ownsConnection: boolean;
  #core: KvCore;

  /**
   * The per-domain implementations (audio-feed-8r1e). Each member is the object that owns
   * that entity's keys and logic, not a view of this store: `repositories.episodes.getEpisode`
   * and `getEpisode` below are the same call, but the work happens in
   * `src/storage/kv/episodes.ts`.
   */
  readonly repositories: MetadataRepositories;

  constructor(kv: Deno.Kv, opts?: { ownsConnection?: boolean }) {
    this.#kv = kv;
    this.#ownsConnection = opts?.ownsConnection ?? false;
    this.#core = createKvCore(kv);
    this.repositories = {
      users: createUsersRepository(this.#core, () => this),
      sources: createSourcesRepository(this.#core, () => this),
      articles: createArticlesRepository(this.#core, () => this),
      episodes: createEpisodesRepository(this.#core, () => this),
      segments: createSegmentsRepository(this.#core, () => this),
      orphanBlobs: createOrphanBlobsRepository(this.#core, () => this),
      usage: createUsageRepository(this.#core, () => this),
      notifications: createNotificationsRepository(this.#core, () => this),
      logs: createLogsRepository(this.#core, () => this),
      runs: createRunsRepository(this.#core, () => this),
      auth: createAuthRepository(this.#core, () => this),
    };
  }

  static async open(path?: string): Promise<KvMetadataStore> {
    const kv = await Deno.openKv(path);
    const store = new KvMetadataStore(kv, { ownsConnection: true });
    await store.#ensurePendingEpisodesIndexed();
    return store;
  }

  /**
   * One-time backfill for pre-existing pending and synthesizing episodes (audio-feed-7li).
   * Scans ["episode"] prefix and ensures ["pending_episodes"] and ["synthesizing_episodes"]
   * index pointers exist for any legacy un-indexed episodes.
   */

  async reindexPendingEpisodes(): Promise<{ scanned: number; indexed: number }> {
    let scanned = 0;
    let indexed = 0;
    for await (const entry of this.#kv.list<Episode>({ prefix: ["episode"] })) {
      scanned++;
      const ep = entry.value;
      if (!ep) continue;
      if (ep.status === "pending") {
        // Priority-aware, so a fresh backfill never recreates the single-queue shape (15e).
        const indexKey: Deno.KvKey = pendingKey(ep);
        if (!(await this.#kv.get(indexKey)).value) {
          await this.#kv.set(indexKey, { userId: ep.userId, id: ep.id });
          indexed++;
        }
        // A pre-15e pointer has no priority segment, and a prefix scan matches BOTH shapes - so
        // leaving it would list the same episode twice in one tick. Removed only after its
        // replacement is in place.
        const legacyKey: Deno.KvKey = ["pending_episodes", ep.createdAt, ep.id];
        // `.value`, not the response: Deno KV's get() always resolves to an envelope object, so
        // `if (await get(k))` is true whether or not the key exists — which counted a deletion
        // that never happened. The audio-feed-7li test caught that.
        if ((await this.#kv.get(legacyKey)).value) {
          await this.#kv.delete(legacyKey);
          indexed++;
        }
      } else if (ep.status === "synthesizing") {
        const indexKey: Deno.KvKey = ["synthesizing_episodes", ep.createdAt, ep.id];
        const existing = await this.#kv.get(indexKey);
        if (!existing.value) {
          await this.#kv.set(indexKey, { userId: ep.userId, id: ep.id });
          indexed++;
        }
      }
    }
    return { scanned, indexed };
  }

  async #ensurePendingEpisodesIndexed(): Promise<void> {
    const migrationKey: Deno.KvKey = ["migration", "pending_episodes_reindex_v1"];
    if (!(await this.#kv.get(migrationKey)).value) {
      await this.reindexPendingEpisodes();
      await this.#kv.set(migrationKey, true);
    }

    // audio-feed-15e: a second marker, run after the first, so an instance upgrading across both
    // gets its pointers rewritten into priority segments rather than merely backfilled.
    const priorityKey: Deno.KvKey = ["migration", "pending_episodes_priority_v2"];
    if ((await this.#kv.get(priorityKey)).value) return;
    await this.reindexPendingEpisodes();
    await this.#kv.set(priorityKey, true);
  }

  // -- users ----------------------------------------------------------------

  /**
   * Atomic first write. The `check`s are the point: a read-then-write cannot
   * stop two concurrent signups for one email from both observing "free" and
   * both committing. Resolves `false` rather than throwing so the caller owns
   * the wording of the duplicate error.
   */

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
  completeEpisode<E extends Episode>(
    episode: E,
    owner: string,
    ...args: E extends { status: "ready" } ? [billing: EpisodeBilling] : [billing?: EpisodeBilling]
  ): Promise<boolean> {
    return (this.repositories.episodes.completeEpisode as (
      ep: Episode,
      ow: string,
      b?: EpisodeBilling,
    ) => Promise<boolean>)(episode, owner, args[0]);
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
  // -- logs (audio-feed-wzv9) --
  appendLog(record: Omit<LogRecord, "seq">): Promise<LogRecord | null> {
    return this.repositories.logs.appendLog(record);
  }
  listLogs(query?: LogQuery): Promise<LogRecord[]> {
    return this.repositories.logs.listLogs(query);
  }
  logBounds(): Promise<LogBounds> {
    return this.repositories.logs.logBounds();
  }
  summarizeLogs(query?: LogQuery): Promise<LogSummary> {
    return this.repositories.logs.summarizeLogs(query);
  }
  pruneLogs(before: Date): Promise<number> {
    return this.repositories.logs.pruneLogs(before);
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

  async atomicUpdate<T>(
    key: string,
    mutate: (current: T | null) => T | null,
    ttlMs?: number,
  ): Promise<AtomicWrite<T>> {
    const kvKey: Deno.KvKey = ["atomic", key];
    for (let attempt = 0; attempt < 32; attempt++) {
      const entry = await this.#kv.get<T>(kvKey);
      const next = mutate(entry.value);
      if (next === null) return { value: entry.value, committed: false };
      const commit = ttlMs === undefined
        ? await this.#kv.atomic().check(entry).set(kvKey, next).commit()
        : await this.#kv.atomic().check(entry).set(kvKey, next, { expireIn: ttlMs }).commit();
      if (commit.ok) return { value: next, committed: true };
      // Jittered backoff, capped low: without it a burst of writers that all
      // read the same versionstamp re-collides in lockstep until the retries
      // run out, which is how this path got exercised in the first place.
      if (attempt >= 2) {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      }
    }
    return { value: (await this.#kv.get<T>(kvKey)).value, committed: false };
  }

  /**
   * Read and delete in one compare-and-swap: of two concurrent consumers the
   * second commit fails its check, so exactly one gets the value.
   */

  close(): Promise<void> {
    if (this.#ownsConnection) this.#kv.close();
    return Promise.resolve();
  }
}
