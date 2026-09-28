/**
 * Storage contracts for audio-feed.
 *
 * Two independent concerns, deliberately kept apart:
 *   - `MetadataStore` — users, sources, articles, episodes. Deno KV in prod.
 *   - `BlobStore`     — audio bytes. R2/S3 in prod, memory/disk in tests.
 *
 * Every implementation of either interface must pass the shared conformance
 * suite in `tests/conformance/`. If your lane needs a new query, add it to the
 * interface *and* the conformance suite — do not reach around the interface
 * into `Deno.openKv()` or `fetch()` from feature code.
 *
 * Owned by: audio-feed-0h8.
 */

import type {
  ApprovalRecord,
  Article,
  AudioMode,
  AuthChallenge,
  Episode,
  EpisodeStatus,
  OutboxNotification,
  PasskeyCredential,
  Session,
  SetupLink,
  Source,
  SynthesisCounts,
  User,
} from "../types.ts";
export { utcDayKey } from "../types.ts";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface EpisodeClaim {
  /** Opaque worker identity, recorded for diagnosis. */
  owner: string;
  /** Claim instant, ISO 8601. Passed in so a caller can make time deterministic. */
  now: string;
  /** How long this claim is honoured before another worker may take over. */
  leaseMs: number;
  /**
   * Claims allowed before the episode is abandoned as unprocessable.
   *
   * Reached means the store writes `failed` itself and resolves `null`: an
   * input that kills its host must not be re-claimed and re-billed forever.
   */
  maxClaims: number;
}

/** Why a claim was not granted. `superseded` is the interesting one. */
export type ClaimRefusal = "held" | "not-claimable" | "exhausted";

export interface EpisodeQuery {
  userId: string;
  /** Omit for the master feed (all sources). */
  sourceId?: string;
  /** Omit to include both modes. */
  mode?: AudioMode;
  status?: EpisodeStatus;
  /** Newest first. Default 50. */
  limit?: number;
}

export interface EpisodePage extends EpisodeQuery {
  /** Opaque cursor from the previous page; omit for the first page. */
  cursor?: string;
}

export interface EpisodePageResult {
  episodes: Episode[];
  /** Absent when the scan is exhausted. */
  cursor?: string;
}

export interface ListPendingOptions {
  limit?: number;
  cursor?: string;
  nowMs?: number;
  leaseMs?: number;
}

export interface ListPendingResult {
  episodes: Episode[];
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Operational stats (audio-feed-ndc)
// ---------------------------------------------------------------------------

/**
 * Every background job that records run history. Each keeps its own bounded
 * history, so the adapters iterate this list; RunKind is derived from it so the
 * two cannot drift apart (audio-feed-ct1).
 */
export const RUN_KINDS = ["feed-poll", "synthesis"] as const;

/** Which background job a run record describes. */
export type RunKind = (typeof RUN_KINDS)[number];

/** How a run was started. `cron` is Deno.cron; `manual` is an admin trigger. */
export type RunTrigger = "cron" | "manual";

/**
 * One completed background run, for the admin dashboard's history.
 *
 * Recorded after the run finishes, including when it threw — a run that failed
 * is the one an operator most needs to see, so `error` is part of the record
 * rather than a reason not to write one.
 */
export interface RunRecord {
  id: string;
  kind: RunKind;
  trigger: RunTrigger;
  /** ISO 8601. History is ordered newest-first on this. */
  startedAt: string;
  durationMs: number;
  /** feed-poll: sources polled, episodes queued, sources that errored. */
  polled?: number;
  queued?: number;
  failed?: number;
  /** synthesis: episodes finished, deferred behind an unapproved user. */
  ready?: number;
  deferred?: number;
  /** Present only when the run threw. */
  error?: string;
  /**
   * A scheduled tick that did nothing (audio-feed-0ob). A run of idle ticks is
   * kept as one row, the latest, so a job that is nearly always idle does not
   * fill its history with them.
   */
  idle?: boolean;
}

/**
 * Enclosure request counts.
 *
 * NOT the same as "plays". Counted at the audio route, so a store that hands out
 * direct URLs (S3/R2) is counted when the redirect is ISSUED, not when the
 * client finishes downloading — the bytes never reach us. The dashboard labels
 * this honestly rather than implying a completed download.
 */
export interface DownloadCounts {
  total: number;
  /** Descending by count. Only users with at least one request appear. */
  perUser: { userId: string; count: number }[];
}

export interface MetadataStore {
  // -- users ------------------------------------------------------------
  /**
   * Atomic first write. Resolves `false` — never throws — when the email or the
   * feed token is already taken.
   *
   * Separate from `putUser` because signup needs an uniqueness guarantee that a
   * read-then-write cannot give: two concurrent signups for one email both see
   * "free" and both succeed. Callers map `false` to their own duplicate error.
   */
  insertUser(user: User): Promise<boolean>;
  /** Update an existing user. Keeps the email and feed-token indexes in step. */
  putUser(user: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  /** Resolves `null` for an unknown, empty, or malformed token. Never throws. */
  getUserByFeedToken(token: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  /**
   * Write a status change and its ledger entry in ONE commit.
   *
   * Two calls would let the ledger disagree with the user it describes — an
   * approval that happened with no record, or a record for an approval that
   * did not. The audit trail is only worth having if it cannot drift.
   */
  recordApproval(user: User, record: ApprovalRecord): Promise<void>;
  /** Oldest first. The admin audit trail. */
  listApprovalLog(): Promise<ApprovalRecord[]>;
  /**
   * Grant or revoke admin and write a `role` ledger entry in ONE commit
   * (audio-feed-8fc). Refuses (`last-admin`) any change that would leave no
   * approved admin, atomically: of two concurrent demotions of the last two
   * admins exactly one succeeds. `unchanged` writes nothing.
   */
  setAdminRole(
    userId: string,
    isAdmin: boolean,
    by: { adminId: string; at: string },
  ): Promise<"changed" | "unchanged" | "last-admin" | "missing">;

  // -- sources ----------------------------------------------------------
  putSource(source: Source): Promise<void>;
  getSource(userId: string, id: string): Promise<Source | null>;
  listSources(userId: string): Promise<Source[]>;
  deleteSource(userId: string, id: string): Promise<void>;

  // -- articles ---------------------------------------------------------
  putArticle(article: Article): Promise<void>;
  /**
   * Atomic first write for an article (audio-feed-33m).
   * Resolves `true` if the article was inserted, or `false` if an article
   * with the same URL already exists for this user.
   *
   * A queueing caller almost always wants `insertArticleWithEpisodeIfAbsent`
   * instead: an article stored without its episode is a tombstone (audio-feed-2th).
   * This one stays for callers that genuinely write the article alone.
   */
  insertArticleIfAbsent(article: Article): Promise<boolean>;
  /**
   * Atomic first write for an article AND the episode that will narrate it
   * (audio-feed-2th).
   *
   * Resolves `true` when both landed, `false` when an article with the same URL
   * already exists for this user — in which case NEITHER record was written.
   *
   * This exists because the two records are one promise to the subscriber. Write
   * them separately and an article that commits with an episode that does not
   * leaves a tombstone: every later poll sees the article, skips the URL, and no
   * retry can create the missing episode. One commit removes the window instead of
   * narrowing it. The same method also carries the audio-feed-33m dedupe guarantee,
   * so callers never need `insertArticleIfAbsent` + `putEpisode` side by side.
   */
  insertArticleWithEpisodeIfAbsent(article: Article, episode: Episode): Promise<boolean>;

  /**
   * Write an article and its episode in ONE commit, with no URL dedupe
   * (audio-feed-d8q).
   *
   * The inbox path needs the pair guarantee of `insertArticleWithEpisodeIfAbsent`
   * without its refusal: re-sending the same URL to "Send to Audio" is a request
   * for another episode, not a duplicate to drop. What must not happen either way
   * is the half-write — an article stored with no episode is a URL that every later
   * feed poll skips, because queueItems dedupes on the article alone. Measured on
   * main before this existed: an article stored with no episode made a feed poll of
   * that same URL report queued=0 skipped=1 episodes=0, forever.
   *
   * Throws if the commit fails, so the caller's error path is the whole story: after
   * a throw, nothing was stored and a retry starts from clean.
   */
  putArticleWithEpisode(article: Article, episode: Episode): Promise<void>;
  getArticle(userId: string, id: string): Promise<Article | null>;
  /**
   * Batched `getArticle` (audio-feed-3jb): the player resolves the author for every row it
   * lists, so a per-row await was up to 200 serial remote reads behind one page. The result
   * order matches `ids`; a missing article is `null` in its slot.
   */
  getArticles(userId: string, ids: string[]): Promise<(Article | null)[]>;
  /** Dedupe hook for repeat ingests of the same URL. */
  findArticleByUrl(userId: string, url: string): Promise<Article | null>;

  // -- episodes ---------------------------------------------------------
  putEpisode(episode: Episode): Promise<void>;
  getEpisode(userId: string, id: string): Promise<Episode | null>;
  deleteEpisode(userId: string, id: string): Promise<boolean>;
  /**
   * Backfill sourceTitle on an existing episode with optimistic concurrency control (CAS).
   * Resolves `false` if the episode does not exist (prevents resurrection, audio-feed-hvn).
   */
  backfillEpisodeSourceTitle(userId: string, id: string, sourceTitle: string): Promise<boolean>;
  /**
   * Newest first. Backs both the per-source and master feeds.
   *
   * `limit` bounds MATCHES, not index entries examined: a filtered query keeps
   * scanning until it has `limit` matching episodes or the index is exhausted.
   * That distinction is the whole difference between this and `listEpisodePage`
   * below, and it is load-bearing — the drain loops in `compose.ts` stop on an
   * empty batch, so a `limit` that bounded entries would let them report success
   * over episodes they never removed (audio-feed-m04).
   */
  listEpisodes(query: EpisodeQuery): Promise<Episode[]>;
  /**
   * Cursor-paged `listEpisodes`, so a full-catalogue scan never has to be held
   * in memory at once (audio-feed-att). Cursors are adapter-defined and opaque;
   * they address a position in the index scan, so this is not a stable snapshot
   * across concurrent writes.
   *
   * A page can hold fewer than `limit` episodes — entries the query filters out
   * still consume the underlying scan — so keep paging until `cursor` is absent
   * rather than treating a short page as the end. Here `limit` bounds the scan
   * worked, not the matches returned; `listEpisodes` above is the variant whose
   * `limit` counts matches. The two adapters differ in how tightly they honour
   * this `limit` (memory bounds matches, KV bounds entries), which is why callers
   * must page to exhaustion rather than infer completion from a short page.
   */
  listEpisodePage(query: EpisodePage): Promise<EpisodePageResult>;
  /**
   * Pending and recoverable episodes, in the order the synthesis worker must take them.
   * Cross-user queue backing the synthesis worker (audio-feed-bbb).
   *
   * Ordering is NOT plain FIFO: new work is served ahead of regenerations, and each of those
   * two groups is FIFO by `createdAt` (audio-feed-15e). A regeneration keeps the createdAt it
   * was published with — that date is the episode's position in the feed and in the player —
   * so a single FIFO queue let a "Regenerate all" after a prompt change place every re-render
   * ahead of anything ingested afterwards, and the subscriber's newest article waited behind
   * work on audio they could already hear.
   *
   * Regenerations are never starved by this: they are the same scan, in a later segment of the
   * queue key, so an idle new-work segment simply falls through to them.
   */
  listPendingEpisodes(opts?: ListPendingOptions): Promise<ListPendingResult>;
  /**
   * Take exclusive ownership of an episode for synthesis, atomically.
   *
   * Resolves the claimed episode (status `synthesizing`, claim recorded), or
   * `null` when the caller did not win it. `null` is the normal, expected
   * answer — never an error — and the caller simply moves to the next job.
   *
   * Claimable means: `pending`, or `synthesizing` with an expired lease.
   * Anything else (`ready`, `failed`, a live claim) resolves `null`.
   *
   * This exists because `putEpisode` is a blind write. Read-then-write lets two
   * workers both observe `pending`, both write `synthesizing`, and both call a
   * paid API for the same episode — the second write wins silently and the
   * first synthesis is billed and discarded (audio-feed-vfs). Every
   * implementation must make the losing claim fail, not merely be unlikely.
   */
  claimEpisode(
    userId: string,
    episodeId: string,
    claim: EpisodeClaim,
  ): Promise<Episode | null>;
  /**
   * Write a terminal state (`ready` / `failed`), but only if the caller still
   * owns the claim.
   *
   * Resolves `false` when the episode has moved on — a different owner, or a
   * state that is no longer `synthesizing`. That happens when a slow worker
   * finishes after its lease expired and another worker already completed the
   * job; an unguarded `putEpisode` there would overwrite the winner's result
   * with stale audio, leaving no trace that it happened.
   *
   * The refusal is a signal worth reporting, not an error to swallow: it means
   * "you were superseded", and the caller should discard its result.
   */
  completeEpisode(episode: Episode, owner: string): Promise<boolean>;
  /**
   * Put a FAILED episode back in the synthesis queue (audio-feed-7s2), atomically.
   *
   * This is the subscriber's "try again", and it is deliberately a different method from
   * `requeueEpisode` rather than a flag on it, because the two transitions mean different
   * things: a requeue starts from `ready` and KEEPS the old audio playable while the new
   * render is made, whereas a retry starts from `failed`, where there is no trustworthy
   * audio to keep playing. One method accepting both would either strand a failed episode
   * or, worse, mark a broken render as publishable.
   *
   * So the episode returns to `pending` with its error cleared and a fresh claim budget,
   * and WITHOUT `regenerating` — which is what keeps it out of the feed until it actually
   * has audio again. The audio fields stay on the record so a partially-written blob is
   * still reachable by the failed-blob path rather than orphaned here.
   *
   * Resolves the queued episode, or `null` when there is nothing to do: not failed (a
   * ready episode is requeueEpisode's job; a pending or synthesizing one is already
   * queued), no such episode, or a concurrent write won the race.
   */
  retryEpisode(userId: string, id: string): Promise<Episode | null>;
  /**
   * Queue a published (`ready`) episode for re-synthesis with the current prompts
   * (audio-feed-8oz), atomically. The episode goes back to `pending` with
   * `regenerating` set and a fresh claim budget, KEEPING its audio fields, so it
   * stays publishable on the old audio until the worker swaps the new key in.
   *
   * Resolves the queued episode, or `null` when there is nothing to do: already
   * queued or synthesizing (so a repeat is idempotent), no audio, or no episode.
   */
  requeueEpisode(userId: string, id: string): Promise<Episode | null>;
  /**
   * Abandon a queued or in-flight regeneration, restoring the episode to `ready` on
   * its old audio. A worker still holding the claim is then refused by
   * `completeEpisode`. Resolves `false` for anything that is not regenerating.
   */
  cancelRegeneration(userId: string, id: string): Promise<boolean>;

  /**
   * Blobs a delete failed on after they became unreferenced, kept so a later
   * synthesis batch can retry them (audio-feed-8oz). Recording a key twice keeps
   * one record; forgetting an unknown key is a no-op.
   */
  recordOrphanBlob(key: string): Promise<void>;
  listOrphanBlobs(limit: number): Promise<string[]>;
  forgetOrphanBlob(key: string): Promise<void>;

  // -- operational stats (audio-feed-ndc) --------------------------------

  /**
   * Count one enclosure request, against the total and against `userId` when
   * the blob key identifies one.
   *
   * MUST be atomic per counter. A read-modify-write loses increments under
   * concurrency, and this is the one route podcast clients hammer: measured on
   * Deno KV, 200 concurrent read-modify-writes landed 1 of 200, while 200
   * atomic increments landed all 200.
   *
   * Resolves rather than throwing on a storage failure. A counter is not worth
   * failing a download for.
   */
  recordDownload(userId: string | null): Promise<void>;
  getDownloadCounts(): Promise<DownloadCounts>;

  /**
   * Record synthesis statistics for a user (audio-feed-9mp, audio-feed-akm).
   * Increments total count, byte length, and daily window count atomically.
   *
   * Unlike recordDownload (which is telemetry that must never abort audio delivery),
   * recordSynthesis backs the financial spend ceiling. Failures are retried,
   * logged loudly via console.error, and propagated to the caller.
   */
  recordSynthesis(userId: string, bytes: number, at?: Date): Promise<void>;
  getSynthesisCounts(today?: string): Promise<SynthesisCounts>;
  getUserDailySynthesisCount(userId: string, day: string): Promise<number>;

  // -- outbox notifications (audio-feed-np5) --------------------------------
  /**
   * Outbox notification queue for on-demand ingest completion.
   * Delivery failures must not affect synthesis or audio publishing.
   */
  queueNotification(notification: OutboxNotification): Promise<void>;
  listOutbox(limit?: number): Promise<OutboxNotification[]>;
  ackNotification(id: string): Promise<boolean>;

  /**
   * Append a run to its job's history, pruning that job to its newest
   * `RUN_HISTORY_LIMIT`.
   *
   * Bounded on write, deliberately: an unbounded history is the audio-feed-att
   * failure — a scan that is cheap today and a multi-megabyte read later.
   *
   * Bounded PER JOB, also deliberately (audio-feed-ct1). One shared cap let the
   * synthesis cron, which records a run every 2 minutes even when idle, push the
   * 15-minute feed poll out of the history entirely, and the dashboard then said
   * a poller that had only stopped had never run.
   *
   * An idle tick replaces its job's newest row when that row is an idle tick
   * that started no later (audio-feed-0ob). The synthesis cron is idle on nearly
   * all of its 720 ticks a day, and appending each one then pruning past the
   * limit read the job's whole history on every one of them.
   */
  recordRun(record: RunRecord): Promise<void>;
  /**
   * Newest first across every job, ties broken by `compareRunsNewestFirst`. The
   * default limit returns everything retained.
   */
  listRuns(limit?: number): Promise<RunRecord[]>;

  // -- accounts (audio-feed-8fc) -------------------------------------------
  //
  // Storage only. Expiry, hashing and ownership rules live in src/auth/, which
  // checks `expiresAt` on every read; an adapter may also drop expired rows.

  putSession(session: Session): Promise<void>;
  getSession(idHash: string): Promise<Session | null>;
  deleteSession(idHash: string): Promise<void>;

  /** Insert or update (the signature counter changes on every sign-in). */
  putCredential(credential: PasskeyCredential): Promise<void>;
  getCredential(id: string): Promise<PasskeyCredential | null>;
  /** Oldest first. */
  listCredentials(userId: string): Promise<PasskeyCredential[]>;
  /**
   * Delete a passkey unless it is the owner's last one, as ONE step: of two
   * concurrent deletes of a user's last two passkeys exactly one succeeds.
   * `missing` when the credential does not exist or belongs to someone else.
   */
  deleteCredential(userId: string, id: string): Promise<"deleted" | "last" | "missing">;

  putSetupLink(link: SetupLink): Promise<void>;
  /** Read without consuming, so a page can say whose link it is. */
  getSetupLink(tokenHash: string): Promise<SetupLink | null>;
  /**
   * Take the link and delete it in ONE step. Of two concurrent consumers exactly
   * one gets the link and the other `null`: a setup link is single use.
   */
  consumeSetupLink(tokenHash: string): Promise<SetupLink | null>;

  putChallenge(challenge: AuthChallenge): Promise<void>;
  /** Single use, with the same exactly-one guarantee as `consumeSetupLink`. */
  consumeChallenge(challenge: string): Promise<AuthChallenge | null>;

  close(): Promise<void>;
}

/** How many runs each job's history keeps. Older records are dropped on write. */
export const RUN_HISTORY_LIMIT = 50;

/**
 * Newest first; a same-millisecond tie goes to the lower id.
 *
 * Shared by both adapters because merging two jobs' histories makes a tie
 * reachable, and they used to break it in opposite directions (audio-feed-ct1).
 * It is the order the KV adapter's descending keys already list in: inverted
 * time, then the id ascending. An unparseable time sorts as the epoch, as it
 * does there.
 */
export function compareRunsNewestFirst(a: RunRecord, b: RunRecord): number {
  const time = (r: RunRecord) => {
    const ms = Date.parse(r.startedAt);
    return Number.isFinite(ms) ? ms : 0;
  };
  const byTime = time(b) - time(a);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

export interface BlobInfo {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
}

export interface ByteRange {
  /** Inclusive first byte. */
  start: number;
  /** Inclusive last byte. Omit for "to the end". */
  end?: number;
}

export interface BlobObject extends BlobInfo {
  body: ReadableStream<Uint8Array>;
  /** Present when the read was satisfied as a partial response. */
  range?: { start: number; end: number; total: number };
}

export interface BlobStore {
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string },
  ): Promise<BlobInfo>;
  /**
   * Range requests are not optional: podcast clients (Apple Podcasts, Pocket
   * Casts, Overcast) seek with `Range`, and a store that ignores it breaks
   * scrubbing.
   */
  get(key: string, opts?: { range?: ByteRange }): Promise<BlobObject | null>;
  head(key: string): Promise<BlobInfo | null>;
  delete(key: string): Promise<void>;
  /**
   * Direct playback URL, signed where the backend requires it.
   * `null` means "this store cannot be reached by a client" — callers fall back
   * to proxying through `GET /audio/:key`.
   */
  url(key: string, opts?: { expiresInSeconds?: number }): Promise<string | null>;
}

/** Thrown for a syntactically valid but unsatisfiable range. */
export class RangeNotSatisfiableError extends Error {
  constructor(readonly size: number) {
    super(`Range not satisfiable for object of ${size} bytes`);
    this.name = "RangeNotSatisfiableError";
  }
}

/**
 * Clamp a requested range against a known object size.
 * Returns `null` when the whole object should be returned.
 */
export function resolveRange(range: ByteRange | undefined, size: number) {
  if (!range) return null;
  if (size === 0) throw new RangeNotSatisfiableError(0);
  const requested = Math.trunc(range.start);

  // Negative start encodes the suffix form (`bytes=-500` → last 500 bytes).
  if (requested < 0) {
    const suffix = -requested;
    if (suffix === 0) throw new RangeNotSatisfiableError(size);
    return { start: Math.max(0, size - suffix), end: size - 1, total: size };
  }

  if (requested >= size) throw new RangeNotSatisfiableError(size);
  const end = range.end === undefined ? size - 1 : Math.min(Math.trunc(range.end), size - 1);
  if (end < requested) throw new RangeNotSatisfiableError(size);
  return { start: requested, end, total: size };
}

/** Parse a single-range HTTP `Range` header. Multi-range is not supported. */
export function parseRangeHeader(header: string | null): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  if (rawStart === "") {
    // Suffix form: `bytes=-500` means the last 500 bytes. Resolved by the store,
    // which is the only thing that knows the size, so signal it with a negative
    // start the store normalizes.
    return { start: -Number(rawEnd) };
  }
  return rawEnd === ""
    ? { start: Number(rawStart) }
    : { start: Number(rawStart), end: Number(rawEnd) };
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
