/**
 * Cloudflare D1 (SQLite) implementation of `MetadataStore`.
 *
 * Composes the 11 domain repositories under `src/storage/d1/` with full atomic CAS
 * and transaction semantics matching `KvMetadataStore` and `MemoryMetadataStore`.
 */

import type {
  ApprovalRecord,
  Article,
  AuthChallenge,
  Episode,
  OutboxNotification,
  PasskeyCredential,
  PlaybackState,
  Session,
  SetupLink,
  Source,
  SynthesisCounts,
  SynthesisSegmentRecord,
  User,
} from "../types.ts";
import type { PlaybackStatePatch } from "../playback_state.ts";
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
  ListSynthesizingOptions,
  ListSynthesizingResult,
  LogAppendOnceResult,
  LogBounds,
  LogQuery,
  LogRecord,
  LogSummary,
  MetadataRepositories,
  MetadataStore,
  RunKind,
  RunRecord,
} from "./mod.ts";
import { createD1Core, type D1Core } from "./d1/core.ts";
import type { D1DatabaseLike } from "./d1/types.ts";
import { createD1UsersRepository } from "./d1/users.ts";
import { createD1SourcesRepository } from "./d1/sources.ts";
import { createD1ArticlesRepository } from "./d1/articles.ts";
import { createD1EpisodesRepository } from "./d1/episodes.ts";
import { createD1SegmentsRepository } from "./d1/synthesis-segments.ts";
import { createD1OrphanBlobsRepository } from "./d1/orphan-blobs.ts";
import { createD1UsageRepository } from "./d1/usage.ts";
import { createD1NotificationsRepository } from "./d1/notifications.ts";
import { createD1RunsRepository } from "./d1/runs.ts";
import { createD1LogsRepository } from "./d1/logs.ts";
import { createD1AuthRepository } from "./d1/auth.ts";
import { createD1PlaybackStateRepository } from "./d1/playback-state.ts";

export {
  CorruptArticleError,
  D1_ARTICLE_CHUNK_BYTES,
  descendingKey,
  isCorruptArticleError,
} from "./d1/core.ts";
export type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from "./d1/types.ts";

interface AtomicRow {
  value: string;
  version: number;
  expires_at: number | null;
}

export class D1MetadataStore implements MetadataStore {
  #core: D1Core;
  readonly repositories: MetadataRepositories;

  constructor(db: D1DatabaseLike) {
    this.#core = createD1Core(db);
    this.repositories = {
      users: createD1UsersRepository(this.#core, () => this),
      sources: createD1SourcesRepository(this.#core, () => this),
      articles: createD1ArticlesRepository(this.#core, () => this),
      episodes: createD1EpisodesRepository(this.#core, () => this),
      segments: createD1SegmentsRepository(this.#core, () => this),
      orphanBlobs: createD1OrphanBlobsRepository(this.#core, () => this),
      usage: createD1UsageRepository(this.#core, () => this),
      notifications: createD1NotificationsRepository(this.#core, () => this),
      runs: createD1RunsRepository(this.#core, () => this),
      logs: createD1LogsRepository(this.#core, () => this),
      auth: createD1AuthRepository(this.#core, () => this),
      playbackState: createD1PlaybackStateRepository(this.#core, () => this),
    };
  }

  // -- users -----------------------------------------------------------------
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

  // -- sources ---------------------------------------------------------------
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

  // -- articles --------------------------------------------------------------
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
  findExistingArticleUrls(userId: string, urls: string[]): Promise<Set<string>> {
    return this.repositories.articles.findExistingArticleUrls(userId, urls);
  }
  deleteArticle(userId: string, id: string): Promise<void> {
    return this.repositories.articles.deleteArticle(userId, id);
  }

  // -- episodes --------------------------------------------------------------
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
  listSynthesizingEpisodes(opts?: ListSynthesizingOptions): Promise<ListSynthesizingResult> {
    return this.repositories.episodes.listSynthesizingEpisodes(opts);
  }
  claimEpisode(userId: string, episodeId: string, claim: EpisodeClaim): Promise<Episode | null> {
    return this.repositories.episodes.claimEpisode(userId, episodeId, claim);
  }
  completeEpisode<E extends Episode>(
    episode: E,
    owner: string,
    ...args: E extends { status: "ready" } ? [billing: EpisodeBilling] : [billing?: EpisodeBilling]
  ): Promise<boolean> {
    return this.repositories.episodes.completeEpisode(episode, owner, ...args);
  }
  touchEpisodeClaim(
    userId: string,
    episodeId: string,
    owner: string,
    update: {
      phase?: string;
      now?: string;
      scriptTurns?: Array<{ speaker: string; text: string }>;
      bytesAttempted?: number;
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
      incrementRefusals?: boolean;
      uploadRetry?: number;
      incrementUploadRetry?: boolean;
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

  // -- segments --------------------------------------------------------------
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

  // -- orphan blobs ----------------------------------------------------------
  recordOrphanBlob(key: string): Promise<void> {
    return this.repositories.orphanBlobs.recordOrphanBlob(key);
  }
  listOrphanBlobs(limit: number): Promise<string[]> {
    return this.repositories.orphanBlobs.listOrphanBlobs(limit);
  }
  forgetOrphanBlob(key: string): Promise<void> {
    return this.repositories.orphanBlobs.forgetOrphanBlob(key);
  }

  // -- usage -----------------------------------------------------------------
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
  getUserDailySynthesisCount(userId: string, day: string): Promise<number> {
    return this.repositories.usage.getUserDailySynthesisCount(userId, day);
  }
  getDailySynthesisCount(day: string): Promise<number> {
    return this.repositories.usage.getDailySynthesisCount(day);
  }

  // -- notifications ---------------------------------------------------------
  queueNotification(notification: OutboxNotification): Promise<void> {
    return this.repositories.notifications.queueNotification(notification);
  }
  listOutbox(limit?: number): Promise<OutboxNotification[]> {
    return this.repositories.notifications.listOutbox(limit);
  }
  ackNotification(id: string): Promise<boolean> {
    return this.repositories.notifications.ackNotification(id);
  }

  // -- runs ------------------------------------------------------------------
  recordRun(record: RunRecord): Promise<void> {
    return this.repositories.runs.recordRun(record);
  }
  listRuns(limit?: number, kind?: RunKind): Promise<RunRecord[]> {
    return this.repositories.runs.listRuns(limit, kind);
  }

  // -- logs ------------------------------------------------------------------
  appendLog(record: Omit<LogRecord, "seq">): Promise<LogRecord | null> {
    return this.repositories.logs.appendLog(record);
  }
  appendLogOnce(
    record: Omit<LogRecord, "seq">,
    key: string,
    expectedNewestSeq: number,
  ): Promise<LogAppendOnceResult> {
    return this.repositories.logs.appendLogOnce(record, key, expectedNewestSeq);
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

  // -- auth ------------------------------------------------------------------
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

  // -- playback state --------------------------------------------------------
  getPlaybackState(userId: string): Promise<PlaybackState | null> {
    return this.repositories.playbackState.getPlaybackState(userId);
  }
  putPlaybackState(userId: string, state: PlaybackState): Promise<void> {
    return this.repositories.playbackState.putPlaybackState(userId, state);
  }
  mergePlaybackState(userId: string, incoming: PlaybackStatePatch): Promise<PlaybackState> {
    return this.repositories.playbackState.mergePlaybackState(userId, incoming);
  }

  // -- shared counters / rate limiters ---------------------------------------
  async atomicUpdate<T>(
    key: string,
    mutate: (current: T | null) => T | null,
    ttlMs?: number,
  ): Promise<AtomicWrite<T>> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const now = Date.now();
      const row = await this.#core.db.prepare(
        `SELECT value, version, expires_at FROM atomic_kv WHERE key = ?`,
      ).bind(key).first<AtomicRow>();

      const isExpired = row !== null && row.expires_at !== null && Number(row.expires_at) <= now;
      const current = row && !isExpired ? (JSON.parse(row.value) as T) : null;
      const next = mutate(current);
      if (next === null) return { value: current, committed: false };

      const expiresAt = ttlMs === undefined ? null : now + ttlMs;
      const nextJson = JSON.stringify(next);

      const res = !row || isExpired
        ? await this.#core.db.prepare(
          `INSERT INTO atomic_kv (key, value, version, expires_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             version = atomic_kv.version + 1,
             expires_at = excluded.expires_at
           WHERE atomic_kv.expires_at IS NOT NULL AND atomic_kv.expires_at <= ?`,
        ).bind(key, nextJson, expiresAt, now).run()
        : await this.#core.db.prepare(
          `UPDATE atomic_kv
           SET value = ?, version = ?, expires_at = ?
           WHERE key = ? AND version = ?`,
        ).bind(nextJson, row.version + 1, expiresAt, key, row.version).run();

      if ((res.meta.changes ?? 0) === 1) {
        return { value: next, committed: true };
      }

      if (attempt >= 2) {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      }
    }

    const finalRow = await this.#core.db.prepare(
      `SELECT value, expires_at FROM atomic_kv WHERE key = ?`,
    ).bind(key).first<{ value: string; expires_at: number | null }>();
    const expired = finalRow !== null && finalRow.expires_at !== null &&
      Number(finalRow.expires_at) <= Date.now();
    return {
      value: finalRow && !expired ? (JSON.parse(finalRow.value) as T) : null,
      committed: false,
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
