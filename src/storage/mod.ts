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
  Episode,
  EpisodeStatus,
  Source,
  User,
} from "../types.ts";

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
   * Pending and recoverable episodes, ordered by `createdAt` ascending (FIFO, oldest first).
   * Cross-user queue backing the synthesis worker (audio-feed-bbb).
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

  close(): Promise<void>;
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
