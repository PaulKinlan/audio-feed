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
 * Owned by: audio-feed-0h8, extended by audio-feed-ruw.
 */

import type { ApprovalRecord, Article, Episode, Source, User } from "../types.ts";
import { DEFAULT_CLAIM_LEASE_MS, isClaimExpired } from "../types.ts";
import type { EpisodeClaim, EpisodeQuery, MetadataStore } from "./mod.ts";

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
    const tx = this.#kv.atomic()
      .set(["episode", episode.userId, episode.id], episode)
      // master feed index
      .set(["episode_by_user", episode.userId, sortKey], episode.id)
      // per-source-and-mode feed index
      .set(
        ["episode_by_source", episode.userId, episode.sourceId, episode.mode, sortKey],
        episode.id,
      );

    if (episode.status === "pending") {
      tx.set(["pending_episodes", episode.createdAt, episode.id], {
        userId: episode.userId,
        id: episode.id,
      });
      tx.delete(["synthesizing_episodes", episode.createdAt, episode.id]);
    } else if (episode.status === "synthesizing") {
      tx.delete(["pending_episodes", episode.createdAt, episode.id]);
      tx.set(["synthesizing_episodes", episode.createdAt, episode.id], {
        userId: episode.userId,
        id: episode.id,
      });
    } else {
      tx.delete(["pending_episodes", episode.createdAt, episode.id]);
      tx.delete(["synthesizing_episodes", episode.createdAt, episode.id]);
    }

    const result = await tx.commit();
    if (!result.ok) throw new Error(`putEpisode failed for ${episode.id}`);
  }

  async getEpisode(userId: string, id: string): Promise<Episode | null> {
    return (await this.#kv.get<Episode>(["episode", userId, id])).value;
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
      const abandoned: Episode = {
        ...found,
        status: "failed",
        error: `abandoned after ${claim.maxClaims} attempts`,
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

    if (episode.status === "pending") {
      tx.set(["pending_episodes", episode.createdAt, episode.id], {
        userId: episode.userId,
        id: episode.id,
      });
      tx.delete(["synthesizing_episodes", episode.createdAt, episode.id]);
    } else if (episode.status === "synthesizing") {
      tx.delete(["pending_episodes", episode.createdAt, episode.id]);
      tx.set(["synthesizing_episodes", episode.createdAt, episode.id], {
        userId: episode.userId,
        id: episode.id,
      });
    } else {
      tx.delete(["pending_episodes", episode.createdAt, episode.id]);
      tx.delete(["synthesizing_episodes", episode.createdAt, episode.id]);
    }

    const result = await tx.commit();
    return result.ok;
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

  async listPendingEpisodes(
    opts: {
      limit?: number;
      offset?: number;
      nowMs?: number;
      leaseMs?: number;
    } = {},
  ): Promise<Episode[]> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const nowMs = opts.nowMs ?? Date.now();
    const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;

    const candidates: Episode[] = [];
    let skipped = 0;

    // 1. Pending episodes (scanned in createdAt ascending order)
    for await (
      const entry of this.#kv.list<{ userId: string; id: string }>({
        prefix: ["pending_episodes"],
      })
    ) {
      const { userId, id } = entry.value;
      const episode = await this.getEpisode(userId, id);
      if (episode && episode.status === "pending") {
        if (skipped < offset) {
          skipped++;
          continue;
        }
        candidates.push(episode);
        // Break early once limit is reached (avoid O(N) full-prefix scan — xxn)
        if (Number.isFinite(limit) && candidates.length >= limit) {
          break;
        }
      }
    }

    // 2. Synthesizing episodes with expired claims
    if (!Number.isFinite(limit) || candidates.length < limit) {
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
          candidates.push(episode);
        }
      }
      candidates.sort((a, b) => {
        const timeDiff = a.createdAt.localeCompare(b.createdAt);
        return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
      });
    }

    return Number.isFinite(limit) ? candidates.slice(0, limit) : candidates;
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
