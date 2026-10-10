/**
 * The KV substrate and the few helpers more than one repository needs (audio-feed-8r1e).
 *
 * WHY A SHARED CORE AT ALL — the alternative was a shared nothing, and it does not type-check
 * against reality: `insertArticleWithEpisodeIfAbsent` and `putArticleWithEpisode` write an Article
 * and an Episode in ONE atomic commit (audio-feed-2th), and both call `writeEpisode`, which
 * `putEpisode` also uses. That pair path is the deliberate exception to "one repository per file"
 * (recorded in docs/adr/0001-domain-repositories.md): the repository boundary is a type boundary,
 * not a transaction boundary, so whoever owns the episode indexes must be callable from the article
 * pair write. Everything else moved out.
 */

import type { Episode } from "../../types.ts";

export const MAX_TIME = 9_999_999_999_999; // ~year 2286, comfortably past any real createdAt

/**
 * How many index entries one `listEpisodePage` / `getArticles` call fetches per `getMany`
 * (audio-feed-3jb). The cap is Deno KV's own: `getMany` accepts AT MOST 10 ranges, and asking
 * for more fails the whole read with "Too many ranges (max 10)" — so the batch size IS that limit.
 * The N+1 this replaces awaited one remote `getEpisode` PER ENTRY; the index value already names
 * the episode, so a chunk is one read for up to ten episodes.
 */
export const EPISODE_READ_BATCH = 10;

/**
 * Maximum character/byte length of an article chunk in KV (audio-feed-cei).
 * Deno KV limits single values to 65,536 bytes. 48,000 bytes provides headroom for
 * V8 serialization overhead and index keys.
 */
export const ARTICLE_CHUNK_SIZE = 48_000;

/** Maximum V8 serialized bytes allowed per chunk to guarantee Deno KV acceptance. */
export const MAX_KV_VALUE_BYTES = 60_000;

/**
 * Descending sort token: lexicographic ascending order over these strings is
 * chronological descending order over the source timestamps.
 */
export function descendingKey(iso: string, id: string): string {
  const ms = Date.parse(iso);
  const inverted = MAX_TIME - (Number.isFinite(ms) ? ms : 0);
  return `${inverted.toString().padStart(13, "0")}:${id}`;
}

/**
 * KV's own expiry for a record that carries `expiresAt`. At least one minute, so
 * a record written at its deadline is still readable by the policy that rejects
 * it; the policy's `expiresAt` check is authoritative, this is only cleanup.
 */
export function expireInMs(expiresAt: string): number {
  const ms = Date.parse(expiresAt) - Date.now();
  return Number.isFinite(ms) ? Math.max(ms, 60_000) : 60_000;
}

/**
 * An article whose chunk set does not match its recorded `chunkCount` (audio-feed-cei).
 *
 * Thrown rather than silently joined: truncated article text must never reach a TTS queue. Callers that
 * render a list may degrade one row to null (see getArticles); callers that synthesize must not.
 * Exported so the two can be distinguished by identity — a blanket catch would also swallow quota,
 * timeout and genuine bugs in hydration and hide an outage behind a missing row.
 */
export class CorruptArticleError extends Error {
  readonly articleId: string;
  readonly expectedChunks: number;
  readonly foundChunks: number;

  constructor(articleId: string, expectedChunks: number, foundChunks: number) {
    super(
      `Corrupted article storage for ${articleId}: expected ${expectedChunks} chunks, found ${foundChunks}`,
    );
    this.name = "CorruptArticleError";
    this.articleId = articleId;
    this.expectedChunks = expectedChunks;
    this.foundChunks = foundChunks;
  }
}

/**
 * Type guard for the one storage failure a list read may degrade (audio-feed-jnor). Exported so the
 * discriminator is testable on its own: without it, a blanket `catch { return null }` would satisfy
 * every behavioural test in the file while also swallowing KV faults as quietly absent content.
 */
export function isCorruptArticleError(err: unknown): err is CorruptArticleError {
  return err instanceof CorruptArticleError;
}

/**
 * An open `kv.atomic()` builder. Derived from the method rather than named: Deno
 * does not export the transaction type under a stable `Deno.*` name, so this
 * cannot go stale when it renames.
 */
export type KvAtomic = ReturnType<Deno.Kv["atomic"]>;

export /**
 * Add the episode and every index entry that points at it to an open
 * transaction. Shared by `putEpisode` and the article+episode pair so the
 * index set cannot drift between the two write paths.
 */
function writeEpisode(tx: KvAtomic, episode: Episode): void {
  const sortKey = descendingKey(episode.createdAt, episode.id);
  tx.set(["episode", episode.userId, episode.id], episode)
    // master feed index
    .set(["episode_by_user", episode.userId, sortKey], episode.id)
    // per-source-and-mode feed index
    .set(
      ["episode_by_source", episode.userId, episode.sourceId, episode.mode, sortKey],
      episode.id,
    );

  writeQueueIndexes(tx, episode);
}

export /**
 * Apply the queue half of an episode write: exactly one pointer, in the priority its flag
 * selects.
 *
 * This is the only place that decision is written, on purpose. Two copies is how an episode
 * ends up with no pointer - not a visible bug, but an episode that silently never synthesises -
 * and how it ends up with two, which bills the same work twice.
 */
function writeQueueIndexes(tx: KvAtomic, episode: Episode): void {
  const [newWork, regeneration] = pendingKeys(episode);
  const own = episode.regenerating ? regeneration : newWork;
  const other = own === newWork ? regeneration : newWork;
  const synthesizingKey: Deno.KvKey = [
    "synthesizing_episodes",
    episode.createdAt,
    episode.id,
  ];

  if (episode.status === "pending") {
    tx.set(own, { userId: episode.userId, id: episode.id });
    // The other segment is cleared rather than left alone: requeueEpisode() and
    // cancelRegeneration() move an episode between priorities while its createdAt - and so the
    // remainder of its key - stays the same.
    tx.delete(other);
    tx.delete(synthesizingKey);
  } else if (episode.status === "synthesizing") {
    tx.delete(newWork);
    tx.delete(regeneration);
    tx.set(synthesizingKey, { userId: episode.userId, id: episode.id });
  } else {
    tx.delete(newWork);
    tx.delete(regeneration);
    tx.delete(synthesizingKey);
  }
}

export /**
 * The queue key for a pending episode: a priority segment, then createdAt, then id.
 *
 * "0" is work the subscriber has never heard. "1" is a regeneration - an episode they can
 * already play, re-rendered because a prompt changed (audio-feed-15e).
 *
 * A regeneration keeps its original createdAt, correctly: that date is the episode's position
 * in the feed and in the player. Keying one queue by createdAt alone therefore let a
 * "Regenerate all" after a prompt change put every re-render ahead of anything ingested
 * afterwards, because the old episodes are all older - the subscriber's newest article waited
 * behind work on audio they already had.
 *
 * Putting a priority segment BEFORE the date fixes that without touching the date, and it stays
 * a single lexicographic scan: same prefix, same cursor, same `limit` bounds-the-scan
 * behaviour, and regenerations still run whenever the "0" segment is exhausted.
 */
function pendingKey(episode: Episode): Deno.KvKey {
  // Derived from #pendingKeys rather than restating the segments: two definitions of one key
  // is how the write path and the backfill start disagreeing about where an episode lives.
  const [newWork, regeneration] = pendingKeys(episode);
  return episode.regenerating ? regeneration : newWork;
}

export /** Both priority segments for an episode's date, so a flag change can be undone without
 *  reading the previous record first. */
function pendingKeys(episode: Episode): [Deno.KvKey, Deno.KvKey] {
  return [
    ["pending_episodes", "0", episode.createdAt, episode.id],
    ["pending_episodes", "1", episode.createdAt, episode.id],
  ];
}

/** The shared substrate a KV repository is constructed with. */
export interface KvCore {
  readonly kv: Deno.Kv;
  /**
   * Add the episode and every index entry that points at it to an open
   * transaction. Shared by `putEpisode` and the article+episode pair so the
   * index set cannot drift between the two write paths.
   */
  writeEpisode(tx: KvAtomic, episode: Episode): void;
  /**
   * Apply the queue half of an episode write: exactly one pointer, in the priority its flag
   * selects.
   *
   * This is the only place that decision is written, on purpose. Two copies is how an episode
   * ends up with no pointer - not a visible bug, but an episode that silently never synthesises -
   * and how it ends up with two, which bills the same work twice.
   */
  writeQueueIndexes(tx: KvAtomic, episode: Episode): void;
  /**
   * The queue key for a pending episode: a priority segment, then createdAt, then id.
   *
   * "0" is work the subscriber has never heard. "1" is a regeneration - an episode they can
   * already play, re-rendered because a prompt changed (audio-feed-15e).
   *
   * A regeneration keeps its original createdAt, correctly: that date is the episode's position
   * in the feed and in the player. Keying one queue by createdAt alone therefore let a
   * "Regenerate all" after a prompt change put every re-render ahead of anything ingested
   * afterwards, because the old episodes are all older - the subscriber's newest article waited
   * behind work on audio they already had.
   *
   * Putting a priority segment BEFORE the date fixes that without touching the date, and it stays
   * a single lexicographic scan: same prefix, same cursor, same `limit` bounds-the-scan
   * behaviour, and regenerations still run whenever the "0" segment is exhausted.
   */
  pendingKey(episode: Episode): Deno.KvKey;
  /** Both priority segments for an episode's date, so a flag change can be undone without
   *  reading the previous record first. */
  pendingKeys(episode: Episode): [Deno.KvKey, Deno.KvKey];
}

/** Builds the context every domain repository takes. */
export function createKvCore(kv: Deno.Kv): KvCore {
  return { kv, writeEpisode, writeQueueIndexes, pendingKey, pendingKeys };
}
