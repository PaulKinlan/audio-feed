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
 * KEY OWNERSHIP (audio-feed-ruw): this module is the ONLY writer of `["user",
 * id]`. `src/auth/users.ts` used to write the same key with a different record
 * shape, so whichever ran last silently dropped the other's fields. Policy now
 * lives in `auth/users.ts` and persistence lives here. Do not reintroduce a
 * second writer — if a caller needs a new user query, add it to `MetadataStore`.
 *
 * Index keys, all distinct first parts so a `["user"]` prefix scan returns user
 * records and nothing else:
 *   ["user", id]                  the record
 *   ["user_by_email", email]      -> id
 *   ["user_by_feed_token", token] -> id
 *   ["approval_log", at, userId]  the admin audit trail
 *
 * Accounts (audio-feed-8fc), none under a ["user"] prefix:
 *   ["session", idHash]                          session, expireIn = its expiry
 *   ["passkey", credentialId]                    the credential
 *   ["passkey_by_user", userId, createdAt, id]   -> credentialId
 *   ["setup_link", tokenHash]                    one-time enrolment link
 *   ["auth_challenge", challenge]                pending WebAuthn challenge
 *
 * Owned by: audio-feed-0h8, extended by audio-feed-ruw.
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
  User,
} from "../types.ts";
import {
  DEFAULT_CLAIM_LEASE_MS,
  isClaimExpired,
  isPublishable,
  unsynthesized,
  utcDayKey,
} from "../types.ts";
import type {
  DownloadCounts,
  EpisodeClaim,
  EpisodePage,
  EpisodePageResult,
  EpisodeQuery,
  ListPendingOptions,
  ListPendingResult,
  MetadataStore,
  RunRecord,
} from "./mod.ts";
import { compareRunsNewestFirst, RUN_HISTORY_LIMIT, RUN_KINDS } from "./mod.ts";

const MAX_TIME = 9_999_999_999_999; // ~year 2286, comfortably past any real createdAt

/**
 * An open `kv.atomic()` builder. Derived from the method rather than named: Deno
 * does not export the transaction type under a stable `Deno.*` name, so this
 * cannot go stale when it renames.
 */
type KvAtomic = ReturnType<Deno.Kv["atomic"]>;

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
function expireInMs(expiresAt: string): number {
  const ms = Date.parse(expiresAt) - Date.now();
  return Number.isFinite(ms) ? Math.max(ms, 60_000) : 60_000;
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
        const indexKey: Deno.KvKey = KvMetadataStore.#pendingKey(ep);
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
  async insertUser(user: User): Promise<boolean> {
    const email = user.email.toLowerCase();
    const userKey: Deno.KvKey = ["user", user.id];
    const emailKey: Deno.KvKey = ["user_by_email", email];
    const tokenKey: Deno.KvKey = ["user_by_feed_token", user.feedToken];

    const [existingUser, existingEmail, existingToken] = await Promise.all([
      this.#kv.get<User>(userKey),
      this.#kv.get<string>(emailKey),
      this.#kv.get<string>(tokenKey),
    ]);
    if (existingUser.value || existingEmail.value || existingToken.value) return false;

    const result = await this.#kv.atomic()
      .check(existingUser)
      .check(existingEmail)
      .check(existingToken)
      .set(userKey, user)
      .set(emailKey, user.id)
      .set(tokenKey, user.id)
      .commit();

    // A failed check means someone else won the race, which is the same answer
    // as "already taken" — not an error condition.
    return result.ok;
  }

  async putUser(user: User): Promise<void> {
    const email = user.email.toLowerCase();
    const existing = await this.#kv.get<User>(["user", user.id]);

    const tx = this.#kv.atomic()
      .set(["user", user.id], user)
      .set(["user_by_email", email], user.id)
      .set(["user_by_feed_token", user.feedToken], user.id);

    // A changed email or a rotated token must not leave a stale index entry
    // pointing at this user — a rotated feed token that still resolves has not
    // actually been revoked.
    const previous = existing.value;
    if (previous) {
      const previousEmail = previous.email.toLowerCase();
      if (previousEmail !== email) tx.delete(["user_by_email", previousEmail]);
      if (previous.feedToken !== user.feedToken) {
        tx.delete(["user_by_feed_token", previous.feedToken]);
      }
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

  async getUserByFeedToken(token: string): Promise<User | null> {
    // An empty key part throws in Deno KV; a feed route must answer 404, not 500.
    if (!token) return null;
    const pointer = await this.#kv.get<string>(["user_by_feed_token", token]);
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

  /** One commit, so the ledger can never disagree with the user it describes. */
  async recordApproval(user: User, record: ApprovalRecord): Promise<void> {
    const result = await this.#kv.atomic()
      .set(["user", user.id], user)
      .set(["approval_log", record.at, record.userId], record)
      .commit();
    if (!result.ok) throw new Error(`recordApproval failed for ${user.id}`);
  }

  /**
   * A demotion `check`s every other approved admin it counted, so of two
   * concurrent demotions the second commit fails and its retry sees one admin.
   */
  async setAdminRole(
    userId: string,
    isAdmin: boolean,
    by: { adminId: string; at: string },
  ): Promise<"changed" | "unchanged" | "last-admin" | "missing"> {
    while (true) {
      const target = await this.#kv.get<User>(["user", userId]);
      if (!target.value) return "missing";
      if (target.value.isAdmin === isAdmin) return "unchanged";
      const tx = this.#kv.atomic().check(target);
      if (!isAdmin && target.value.status === "approved") {
        const others: Deno.KvEntry<User>[] = [];
        for await (const entry of this.#kv.list<User>({ prefix: ["user"] })) {
          const u = entry.value;
          if (u.id !== userId && u.isAdmin && u.status === "approved") others.push(entry);
        }
        if (others.length === 0) return "last-admin";
        for (const entry of others) tx.check(entry);
      }
      const record: ApprovalRecord = {
        userId,
        action: "role",
        adminId: by.adminId,
        at: by.at,
        fromRole: isAdmin ? "user" : "admin",
        toRole: isAdmin ? "admin" : "user",
      };
      const result = await tx
        .set(["user", userId], { ...target.value, isAdmin })
        .set(["approval_log", record.at, userId], record)
        .commit();
      if (result.ok) return "changed";
    }
  }

  async listApprovalLog(): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = [];
    // Key order is [at, userId], so an ascending scan is already oldest-first.
    for await (const entry of this.#kv.list<ApprovalRecord>({ prefix: ["approval_log"] })) {
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

  async deleteSource(userId: string, id: string): Promise<void> {
    await this.#kv.delete(["source", userId, id]);
  }

  // -- articles -------------------------------------------------------------

  async putArticle(article: Article): Promise<void> {
    const result = await this.#kv.atomic()
      .set(["article", article.userId, article.id], article)
      .set(["article_by_url", article.userId, article.url], article.id)
      .commit();
    if (!result.ok) throw new Error(`putArticle failed for ${article.id}`);
  }

  async insertArticleIfAbsent(article: Article): Promise<boolean> {
    const result = await this.#kv.atomic()
      .check({ key: ["article_by_url", article.userId, article.url], versionstamp: null })
      .set(["article", article.userId, article.id], article)
      .set(["article_by_url", article.userId, article.url], article.id)
      .commit();
    return result.ok;
  }

  async insertArticleWithEpisodeIfAbsent(
    article: Article,
    episode: Episode,
  ): Promise<boolean> {
    // One transaction, so the pair either exists together or does not exist at
    // all (audio-feed-2th). The URL check is the audio-feed-33m guard: a losing
    // commit writes neither record.
    const tx = this.#kv.atomic()
      .check({ key: ["article_by_url", article.userId, article.url], versionstamp: null })
      .set(["article", article.userId, article.id], article)
      .set(["article_by_url", article.userId, article.url], article.id);
    KvMetadataStore.#writeEpisode(tx, episode);
    return (await tx.commit()).ok;
  }

  async putArticleWithEpisode(article: Article, episode: Episode): Promise<void> {
    // Same single-commit guarantee as the dedupe variant, without the URL check
    // (audio-feed-d8q): the inbox re-write of a URL is a new episode by request, but
    // it must never be half a pair.
    const tx = this.#kv.atomic()
      .set(["article", article.userId, article.id], article)
      .set(["article_by_url", article.userId, article.url], article.id);
    KvMetadataStore.#writeEpisode(tx, episode);
    const result = await tx.commit();
    if (!result.ok) throw new Error(`putArticleWithEpisode failed for ${article.id}`);
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

  /**
   * Add the episode and every index entry that points at it to an open
   * transaction. Shared by `putEpisode` and the article+episode pair so the
   * index set cannot drift between the two write paths.
   */
  static #writeEpisode(tx: KvAtomic, episode: Episode): void {
    const sortKey = descendingKey(episode.createdAt, episode.id);
    tx.set(["episode", episode.userId, episode.id], episode)
      // master feed index
      .set(["episode_by_user", episode.userId, sortKey], episode.id)
      // per-source-and-mode feed index
      .set(
        ["episode_by_source", episode.userId, episode.sourceId, episode.mode, sortKey],
        episode.id,
      );

    KvMetadataStore.#writeQueueIndexes(tx, episode);
  }

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
  static #pendingKey(episode: Episode): Deno.KvKey {
    // Derived from #pendingKeys rather than restating the segments: two definitions of one key
    // is how the write path and the backfill start disagreeing about where an episode lives.
    const [newWork, regeneration] = KvMetadataStore.#pendingKeys(episode);
    return episode.regenerating ? regeneration : newWork;
  }

  /** Both priority segments for an episode's date, so a flag change can be undone without
   *  reading the previous record first. */
  static #pendingKeys(episode: Episode): [Deno.KvKey, Deno.KvKey] {
    return [
      ["pending_episodes", "0", episode.createdAt, episode.id],
      ["pending_episodes", "1", episode.createdAt, episode.id],
    ];
  }

  /**
   * Apply the queue half of an episode write: exactly one pointer, in the priority its flag
   * selects.
   *
   * This is the only place that decision is written, on purpose. Two copies is how an episode
   * ends up with no pointer - not a visible bug, but an episode that silently never synthesises -
   * and how it ends up with two, which bills the same work twice.
   */
  static #writeQueueIndexes(tx: KvAtomic, episode: Episode): void {
    const [newWork, regeneration] = KvMetadataStore.#pendingKeys(episode);
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

  async putEpisode(episode: Episode): Promise<void> {
    const tx = this.#kv.atomic();
    KvMetadataStore.#writeEpisode(tx, episode);
    const result = await tx.commit();
    if (!result.ok) throw new Error(`putEpisode failed for ${episode.id}`);
  }

  async getEpisode(userId: string, id: string): Promise<Episode | null> {
    return (await this.#kv.get<Episode>(["episode", userId, id])).value;
  }

  async deleteEpisode(userId: string, id: string): Promise<boolean> {
    const key: Deno.KvKey = ["episode", userId, id];
    const entry = await this.#kv.get<Episode>(key);
    if (!entry.value) return false;
    const ep = entry.value;
    const sortKey = descendingKey(ep.createdAt, ep.id);
    const result = await this.#kv.atomic()
      .check(entry)
      .delete(key)
      .delete(["episode_by_user", userId, sortKey])
      .delete(["episode_by_source", userId, ep.sourceId, ep.mode, sortKey])
      .delete(["pending_episodes", "0", ep.createdAt, ep.id])
      .delete(["pending_episodes", "1", ep.createdAt, ep.id])
      .delete(["synthesizing_episodes", ep.createdAt, ep.id])
      .commit();
    if (result.ok) return true;

    const retry = await this.#kv.get<Episode>(key);
    if (!retry.value) return false;
    const retrySortKey = descendingKey(retry.value.createdAt, retry.value.id);
    const retryResult = await this.#kv.atomic()
      .check(retry)
      .delete(key)
      .delete(["episode_by_user", userId, retrySortKey])
      .delete([
        "episode_by_source",
        userId,
        retry.value.sourceId,
        retry.value.mode,
        retrySortKey,
      ])
      .delete(["pending_episodes", "0", retry.value.createdAt, retry.value.id])
      .delete(["pending_episodes", "1", retry.value.createdAt, retry.value.id])
      .delete(["synthesizing_episodes", retry.value.createdAt, retry.value.id])
      .commit();
    return retryResult.ok;
  }

  async backfillEpisodeSourceTitle(
    userId: string,
    id: string,
    sourceTitle: string,
  ): Promise<boolean> {
    const key: Deno.KvKey = ["episode", userId, id];
    const entry = await this.#kv.get<Episode>(key);
    if (!entry.value) return false;
    if (entry.value.sourceTitle) return true;
    const updated: Episode = { ...entry.value, sourceTitle };
    const res = await this.#kv.atomic()
      .check(entry)
      .set(key, updated)
      .commit();
    if (res.ok) return true;

    // Retry once if atomic check collided
    const retry = await this.#kv.get<Episode>(key);
    if (!retry.value) return false;
    if (retry.value.sourceTitle) return true;
    const retryUpdated: Episode = { ...retry.value, sourceTitle };
    const retryRes = await this.#kv.atomic()
      .check(retry)
      .set(key, retryUpdated)
      .commit();
    return retryRes.ok;
  }

  /**
   * Compare-and-swap claim. The `.check(entry)` is the entire point.
   *
   * A read-then-write lets two isolates both observe `pending`, both write
   * `synthesizing`, and both call a paid API for one episode — the second write
   * wins silently and the first synthesis is billed and thrown away
   * (audio-feed-vfs). The check makes the loser's commit fail against the
   * versionstamp it read, so exactly one worker proceeds.
   */
  async claimEpisode(
    userId: string,
    episodeId: string,
    claim: EpisodeClaim,
  ): Promise<Episode | null> {
    const key: Deno.KvKey = ["episode", userId, episodeId];
    const entry = await this.#kv.get<Episode>(key);
    const found = entry.value;
    if (!found) return null;

    const nowMs = Date.parse(claim.now);
    const claimable = found.status === "pending" ||
      (found.status === "synthesizing" && isClaimExpired(found, nowMs, claim.leaseMs));
    if (!claimable) return null;

    const attempts = (found.attempts ?? 0) + 1;
    if (attempts > claim.maxClaims) {
      // Abandon rather than re-bill. Still checked, so this cannot clobber a
      // worker that legitimately claimed between our read and this write.
      // A regeneration goes back to ready on its old audio instead (audio-feed-8oz).
      const abandoned: Episode = {
        ...unsynthesized(found, `abandoned after ${claim.maxClaims} attempts`),
        claimedAt: undefined,
        claimedBy: undefined,
      };
      await this.#atomicPutEpisode(abandoned, entry);
      return null;
    }

    const claimed: Episode = {
      ...found,
      status: "synthesizing",
      claimedAt: claim.now,
      claimedBy: claim.owner,
      attempts,
    };
    const ok = await this.#atomicPutEpisode(claimed, entry);
    // A failed check means another worker won the race — the normal answer, not
    // an error. The caller moves on to the next job.
    return ok ? claimed : null;
  }

  async completeEpisode(episode: Episode, owner: string): Promise<boolean> {
    const key: Deno.KvKey = ["episode", episode.userId, episode.id];
    const entry = await this.#kv.get<Episode>(key);
    const current = entry.value;
    // Superseded: the lease expired and another worker already finished this.
    // Writing anyway would overwrite the winner's audio with ours, silently.
    if (!current || current.status !== "synthesizing" || current.claimedBy !== owner) {
      return false;
    }
    return await this.#atomicPutEpisode(episode, entry);
  }

  /** Versionstamp-checked, so it cannot clobber a claim taken between read and write. */
  async requeueEpisode(userId: string, id: string): Promise<Episode | null> {
    const entry = await this.#kv.get<Episode>(["episode", userId, id]);
    const found = entry.value;
    if (!found || found.status !== "ready" || !isPublishable(found)) return null;
    const queued: Episode = {
      ...found,
      status: "pending",
      regenerating: true,
      attempts: undefined,
      claimedAt: undefined,
      claimedBy: undefined,
      error: undefined,
    };
    return (await this.#atomicPutEpisode(queued, entry)) ? queued : null;
  }

  async retryEpisode(userId: string, id: string): Promise<Episode | null> {
    const entry = await this.#kv.get<Episode>(["episode", userId, id]);
    const found = entry.value;
    // `failed` only, and the versionstamp check makes a concurrent claim or requeue win
    // rather than interleave.
    if (!found || found.status !== "failed") return null;
    const queued: Episode = {
      ...found,
      status: "pending",
      attempts: undefined,
      claimedAt: undefined,
      claimedBy: undefined,
      error: undefined,
      // regenerating is NOT set: a failed render has no audio worth playing while it retries,
      // and setting it would put those bytes back into the subscriber's feed.
      regenerating: undefined,
    };
    return (await this.#atomicPutEpisode(queued, entry)) ? queued : null;
  }

  async cancelRegeneration(userId: string, id: string): Promise<boolean> {
    const entry = await this.#kv.get<Episode>(["episode", userId, id]);
    const found = entry.value;
    if (
      !found?.regenerating || (found.status !== "pending" && found.status !== "synthesizing")
    ) {
      return false;
    }
    return await this.#atomicPutEpisode({
      ...found,
      status: "ready",
      regenerating: undefined,
      claimedAt: undefined,
      claimedBy: undefined,
    }, entry);
  }

  /**
   * `putEpisode`'s write set, guarded by the versionstamp the caller read.
   * Keeps the feed indexes in step with the record in one commit.
   */
  async #atomicPutEpisode(
    episode: Episode,
    guard: Deno.KvEntryMaybe<Episode>,
  ): Promise<boolean> {
    const sortKey = descendingKey(episode.createdAt, episode.id);
    const tx = this.#kv.atomic()
      .check(guard)
      .set(["episode", episode.userId, episode.id], episode)
      .set(["episode_by_user", episode.userId, sortKey], episode.id)
      .set(
        ["episode_by_source", episode.userId, episode.sourceId, episode.mode, sortKey],
        episode.id,
      );

    KvMetadataStore.#writeQueueIndexes(tx, episode);

    const result = await tx.commit();
    return result.ok;
  }

  async listEpisodes(query: EpisodeQuery): Promise<Episode[]> {
    // `limit` bounds MATCHES here, not entries examined. A filtered query's
    // matches can sit arbitrarily deep in a newest-first index scan, so one
    // page of `listEpisodePage` (whose limit bounds the underlying scan) is not
    // equivalent to what this method has always returned. The two drain loops in
    // createAdminDeleteSourceHandler stop on `batch.length === 0`, so returning
    // short here silently abandons episodes for a feed that is being deleted
    // (audio-feed-m04, the audio-feed-4qj shape arriving through a changed seam).
    const limit = query.limit ?? 50;
    if (!Number.isFinite(limit)) return (await this.listEpisodePage(query)).episodes;

    const out: Episode[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listEpisodePage({ ...query, limit, cursor });
      out.push(...page.episodes);
      if (out.length >= limit || !page.cursor || page.cursor === cursor) break;
      cursor = page.cursor;
    }
    return out.slice(0, limit);
  }

  async listEpisodePage(query: EpisodePage): Promise<EpisodePageResult> {
    const limit = query.limit ?? 50;
    const prefix = this.#indexPrefix(query);

    const episodes: Episode[] = [];
    const iter = this.#kv.list<string>({ prefix }, {
      cursor: query.cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    // Keys are stored newest-first, so a plain ascending scan is already ordered.
    for await (const entry of iter) {
      const episode = await this.getEpisode(query.userId, entry.value);
      if (!episode) continue;
      if (query.sourceId && episode.sourceId !== query.sourceId) continue;
      if (query.mode && episode.mode !== query.mode) continue;
      if (query.status && episode.status !== query.status) continue;
      episodes.push(episode);
      if (episodes.length >= limit) break;
    }

    const cursor = iter.cursor && iter.cursor !== "" ? iter.cursor : undefined;
    return { episodes, cursor };
  }

  async listPendingEpisodes(
    opts: ListPendingOptions = {},
  ): Promise<ListPendingResult> {
    const limit = opts.limit ?? 50;
    const nowMs = opts.nowMs ?? Date.now();
    const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;

    const episodes: Episode[] = [];

    // Native Deno KV iterator with cursor and limit — zero skip overhead (audio-feed-bbb, xxn)
    const iter = this.#kv.list<{ userId: string; id: string }>(
      { prefix: ["pending_episodes"] },
      {
        cursor: opts.cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      },
    );

    for await (const entry of iter) {
      const { userId, id } = entry.value;
      const episode = await this.getEpisode(userId, id);
      if (episode && episode.status === "pending") {
        episodes.push(episode);
      }
    }

    const nextCursor = iter.cursor && iter.cursor !== "" ? iter.cursor : undefined;

    // Check synthesizing episodes with expired claims only on initial scan (cursor undefined)
    let mergedExpired = false;
    if (!opts.cursor && (!Number.isFinite(limit) || episodes.length < limit)) {
      for await (
        const entry of this.#kv.list<{ userId: string; id: string }>({
          prefix: ["synthesizing_episodes"],
        })
      ) {
        const { userId, id } = entry.value;
        const episode = await this.getEpisode(userId, id);
        if (
          episode &&
          episode.status === "synthesizing" &&
          isClaimExpired(episode, nowMs, leaseMs)
        ) {
          episodes.push(episode);
          mergedExpired = true;
        }
      }
      // Re-sort ONLY when something was merged. The queue scan is already in priority order, and
      // this sort used to run unconditionally - which silently undid audio-feed-15e, because a
      // requeued episode's createdAt is old BY DESIGN, so sorting the whole result by date put
      // every regeneration back in front of the new article the queue key had just moved ahead.
      // When a merge is needed the order must be the queue's order: priority, then FIFO.
      if (mergedExpired) {
        episodes.sort((a, b) => {
          const ap = a.regenerating ? 1 : 0;
          const bp = b.regenerating ? 1 : 0;
          if (ap !== bp) return ap - bp;
          const timeDiff = a.createdAt.localeCompare(b.createdAt);
          return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
        });
      }
    }

    return {
      episodes: Number.isFinite(limit) ? episodes.slice(0, limit) : episodes,
      cursor: nextCursor,
    };
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

  async recordOrphanBlob(key: string): Promise<void> {
    await this.#kv.set(["orphan_blob", key], true);
  }

  async listOrphanBlobs(limit: number): Promise<string[]> {
    const keys: string[] = [];
    for await (const entry of this.#kv.list({ prefix: ["orphan_blob"] }, { limit })) {
      if (typeof entry.key[1] === "string") keys.push(entry.key[1]);
    }
    return keys;
  }

  async forgetOrphanBlob(key: string): Promise<void> {
    await this.#kv.delete(["orphan_blob", key]);
  }

  // -- operational stats (audio-feed-ndc) ------------------------------------

  /**
   * `.sum()` on a `KvU64`, not read-then-write.
   *
   * Measured on this runtime: 200 concurrent read-modify-writes landed 1 of
   * 200; 200 atomic sums landed all 200. `/audio/:key+` is the route podcast
   * clients hammer, so the naive form would undercount by orders of magnitude
   * exactly when the number matters.
   */
  async recordDownload(userId: string | null): Promise<void> {
    try {
      const tx = this.#kv.atomic().sum(["download_total"], 1n);
      if (userId) tx.sum(["download_by_user", userId], 1n);
      await tx.commit();
    } catch {
      // A counter is not worth failing a download for. The episode still plays.
    }
  }

  async getDownloadCounts(): Promise<DownloadCounts> {
    const total = await this.#kv.get<Deno.KvU64>(["download_total"]);
    const perUser: { userId: string; count: number }[] = [];
    for await (const entry of this.#kv.list<Deno.KvU64>({ prefix: ["download_by_user"] })) {
      const userId = entry.key[1];
      if (typeof userId !== "string" || !entry.value) continue;
      perUser.push({ userId, count: Number(entry.value.value) });
    }
    perUser.sort((a, b) => b.count - a.count);
    return { total: Number(total.value?.value ?? 0n), perUser };
  }

  // Synthesis stats & budget tracking (audio-feed-9mp, audio-feed-akm)
  async recordSynthesis(userId: string, bytes: number, at = new Date()): Promise<void> {
    const day = utcDayKey(at);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tx = this.#kv.atomic()
          .sum(["synthesis_total"], 1n)
          .sum(["synthesis_total_bytes"], BigInt(bytes))
          .sum(["synthesis_by_user", userId], 1n)
          .sum(["synthesis_bytes_by_user", userId], BigInt(bytes))
          .sum(["synthesis_daily", userId, day], 1n);
        const res = await tx.commit();
        if (res.ok) return;
        lastError = new Error(`atomic commit failed (attempt ${attempt + 1}/3)`);
      } catch (err) {
        lastError = err;
      }
    }
    console.error(
      `[audio-feed] recordSynthesis failed for user ${userId} (${bytes} bytes):`,
      lastError,
    );
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async getSynthesisCounts(today = utcDayKey()): Promise<SynthesisCounts> {
    const [totalEntry, bytesEntry] = await Promise.all([
      this.#kv.get<Deno.KvU64>(["synthesis_total"]),
      this.#kv.get<Deno.KvU64>(["synthesis_total_bytes"]),
    ]);
    const perUser: { userId: string; count: number; bytes: number; todayCount: number }[] = [];
    for await (const entry of this.#kv.list<Deno.KvU64>({ prefix: ["synthesis_by_user"] })) {
      const userId = entry.key[1];
      if (typeof userId !== "string" || !entry.value) continue;
      const [userBytes, todayEntry] = await Promise.all([
        this.#kv.get<Deno.KvU64>(["synthesis_bytes_by_user", userId]),
        this.#kv.get<Deno.KvU64>(["synthesis_daily", userId, today]),
      ]);
      perUser.push({
        userId,
        count: Number(entry.value.value),
        bytes: Number(userBytes.value?.value ?? 0n),
        todayCount: Number(todayEntry.value?.value ?? 0n),
      });
    }
    perUser.sort((a, b) => b.count - a.count);
    return {
      total: Number(totalEntry.value?.value ?? 0n),
      totalBytes: Number(bytesEntry.value?.value ?? 0n),
      perUser,
    };
  }

  async getUserDailySynthesisCount(userId: string, day: string): Promise<number> {
    const entry = await this.#kv.get<Deno.KvU64>(["synthesis_daily", userId, day]);
    return Number(entry.value?.value ?? 0n);
  }

  // -- outbox notifications (audio-feed-np5) --------------------------------

  async queueNotification(notification: OutboxNotification): Promise<void> {
    const tx = this.#kv.atomic()
      .set(["outbox", notification.id], notification)
      .set(["outbox_pending", notification.createdAt, notification.id], notification.id);
    const res = await tx.commit();
    if (!res.ok) throw new Error(`queueNotification failed for ${notification.id}`);
  }

  async listOutbox(limit = 50): Promise<OutboxNotification[]> {
    const notifications: OutboxNotification[] = [];
    for await (const entry of this.#kv.list<string>({ prefix: ["outbox_pending"] }, { limit })) {
      const id = entry.value;
      const n = await this.#kv.get<OutboxNotification>(["outbox", id]);
      if (n.value && !n.value.deliveredAt) notifications.push(n.value);
    }
    return notifications;
  }

  async ackNotification(id: string): Promise<boolean> {
    const entry = await this.#kv.get<OutboxNotification>(["outbox", id]);
    if (!entry.value) return false;
    const n = entry.value;
    n.deliveredAt = new Date().toISOString();
    const tx = this.#kv.atomic()
      .set(["outbox", id], n)
      .delete(["outbox_pending", n.createdAt, n.id]);
    const res = await tx.commit();
    return res.ok;
  }

  /**
   * Newest-first key under the job's own prefix, then prune that job past the
   * limit.
   *
   * Bounded on WRITE rather than on read: an unbounded history reads cheaply
   * today and is a multi-megabyte scan a year in, which is the audio-feed-att
   * failure. The prune costs one bounded list per run, and runs are minutes
   * apart.
   *
   * Keyed and pruned PER JOB (audio-feed-ct1). Under one shared ["run"] prefix
   * the synthesis cron's idle ticks evicted every feed poll within about 100
   * minutes.
   */
  async recordRun(record: RunRecord): Promise<void> {
    try {
      const job = ["run", record.kind];
      const key = [...job, descendingKey(record.startedAt, record.id)];
      if (record.idle) {
        // A run of idle ticks is kept as one row, the latest (audio-feed-0ob). When
        // the job's newest row is an idle tick that started no later, swap this
        // one in for it: the history does not grow, so there is nothing to prune,
        // and the write reads one entry instead of the job's whole history.
        for await (const newest of this.#kv.list<RunRecord>({ prefix: job }, { limit: 1 })) {
          if (
            newest.value?.idle &&
            Date.parse(newest.value.startedAt) <= Date.parse(record.startedAt)
          ) {
            const swap = this.#kv.atomic().check(newest).delete(newest.key).set(key, record);
            // If the row changed underneath us, fall through to an ordinary insert.
            if ((await swap.commit()).ok) return;
          }
        }
      }
      await this.#kv.set(key, record);
      // Drop anything past the limit. `list` is ascending over descending keys,
      // so everything after the first RUN_HISTORY_LIMIT entries is older.
      let seen = 0;
      for await (const entry of this.#kv.list<RunRecord>({ prefix: job })) {
        seen++;
        if (seen > RUN_HISTORY_LIMIT) await this.#kv.delete(entry.key);
      }
    } catch {
      // History is diagnostic. Losing a record must not fail the run it describes.
    }
  }

  /** Every job's newest-first history, merged. No job can contribute more than `limit`. */
  async listRuns(limit = RUN_HISTORY_LIMIT * RUN_KINDS.length): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (const kind of RUN_KINDS) {
      for await (const entry of this.#kv.list<RunRecord>({ prefix: ["run", kind] }, { limit })) {
        if (entry.value) out.push(entry.value);
      }
    }
    return out.sort(compareRunsNewestFirst).slice(0, limit);
  }

  // -- accounts (audio-feed-8fc) --------------------------------------------

  async putSession(session: Session): Promise<void> {
    await this.#kv.set(["session", session.idHash], session, {
      expireIn: expireInMs(session.expiresAt),
    });
  }

  async getSession(idHash: string): Promise<Session | null> {
    return (await this.#kv.get<Session>(["session", idHash])).value;
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.#kv.delete(["session", idHash]);
  }

  async putCredential(credential: PasskeyCredential): Promise<void> {
    const result = await this.#kv.atomic()
      .set(["passkey", credential.id], credential)
      .set(
        ["passkey_by_user", credential.userId, credential.createdAt, credential.id],
        credential.id,
      )
      .commit();
    if (!result.ok) throw new Error(`putCredential failed for ${credential.id}`);
  }

  async getCredential(id: string): Promise<PasskeyCredential | null> {
    return (await this.#kv.get<PasskeyCredential>(["passkey", id])).value;
  }

  async listCredentials(userId: string): Promise<PasskeyCredential[]> {
    const out: PasskeyCredential[] = [];
    for await (const entry of this.#kv.list<string>({ prefix: ["passkey_by_user", userId] })) {
      const credential = await this.getCredential(entry.value);
      if (credential && credential.userId === userId) out.push(credential);
    }
    return out;
  }

  /**
   * The count and the delete are one commit: every index row the count read is
   * `check`ed, so a concurrent delete of a sibling fails this commit and the
   * retry sees the smaller count.
   */
  async deleteCredential(userId: string, id: string): Promise<"deleted" | "last" | "missing"> {
    while (true) {
      const entry = await this.#kv.get<PasskeyCredential>(["passkey", id]);
      if (!entry.value || entry.value.userId !== userId) return "missing";
      const index: Deno.KvEntry<string>[] = [];
      for await (const row of this.#kv.list<string>({ prefix: ["passkey_by_user", userId] })) {
        index.push(row);
      }
      if (new Set(index.map((row) => row.value)).size <= 1) return "last";
      const tx = this.#kv.atomic().check(entry);
      for (const row of index) tx.check(row);
      const result = await tx
        .delete(["passkey", id])
        .delete(["passkey_by_user", userId, entry.value.createdAt, id])
        .commit();
      if (result.ok) return "deleted";
    }
  }

  async putSetupLink(link: SetupLink): Promise<void> {
    await this.#kv.set(["setup_link", link.tokenHash], link, {
      expireIn: expireInMs(link.expiresAt),
    });
  }

  async getSetupLink(tokenHash: string): Promise<SetupLink | null> {
    return (await this.#kv.get<SetupLink>(["setup_link", tokenHash])).value;
  }

  consumeSetupLink(tokenHash: string): Promise<SetupLink | null> {
    return this.#consume<SetupLink>(["setup_link", tokenHash]);
  }

  async putChallenge(challenge: AuthChallenge): Promise<void> {
    await this.#kv.set(["auth_challenge", challenge.challenge], challenge, {
      expireIn: expireInMs(challenge.expiresAt),
    });
  }

  consumeChallenge(challenge: string): Promise<AuthChallenge | null> {
    return this.#consume<AuthChallenge>(["auth_challenge", challenge]);
  }

  /**
   * Read and delete in one compare-and-swap: of two concurrent consumers the
   * second commit fails its check, so exactly one gets the value.
   */
  async #consume<T>(key: Deno.KvKey): Promise<T | null> {
    const entry = await this.#kv.get<T>(key);
    if (entry.value === null) return null;
    const result = await this.#kv.atomic().check(entry).delete(key).commit();
    return result.ok ? entry.value : null;
  }

  close(): Promise<void> {
    if (this.#ownsConnection) this.#kv.close();
    return Promise.resolve();
  }
}
