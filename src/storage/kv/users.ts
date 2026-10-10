/**
 * Users: accounts, approval state, feed tokens and the admin role.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { ApprovalRecord, User } from "../../types.ts";
import type { MetadataStore, UserRepository } from "../mod.ts";
import type { KvCore } from "./core.ts";

export function createUsersRepository(core: KvCore, host: () => MetadataStore): UserRepository {
  return {
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
        core.kv.get<User>(userKey),
        core.kv.get<string>(emailKey),
        core.kv.get<string>(tokenKey),
      ]);
      if (existingUser.value || existingEmail.value || existingToken.value) return false;

      const result = await core.kv.atomic()
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
    },
    async putUser(user: User): Promise<void> {
      const email = user.email.toLowerCase();
      const existing = await core.kv.get<User>(["user", user.id]);

      const tx = core.kv.atomic()
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
    },
    async getUser(id: string): Promise<User | null> {
      return (await core.kv.get<User>(["user", id])).value;
    },
    async getUserByEmail(email: string): Promise<User | null> {
      const pointer = await core.kv.get<string>(["user_by_email", email.toLowerCase()]);
      if (!pointer.value) return null;
      return await host().getUser(pointer.value);
    },
    async getUserByFeedToken(token: string): Promise<User | null> {
      // An empty key part throws in Deno KV; a feed route must answer 404, not 500.
      if (!token) return null;
      const pointer = await core.kv.get<string>(["user_by_feed_token", token]);
      if (!pointer.value) return null;
      return await host().getUser(pointer.value);
    },
    async listUsers(): Promise<User[]> {
      const out: User[] = [];
      for await (const entry of core.kv.list<User>({ prefix: ["user"] })) {
        out.push(entry.value);
      }
      return out;
    },
    /** One commit, so the ledger can never disagree with the user it describes. */
    async recordApproval(user: User, record: ApprovalRecord): Promise<void> {
      const result = await core.kv.atomic()
        .set(["user", user.id], user)
        .set(["approval_log", record.at, record.userId], record)
        .commit();
      if (!result.ok) throw new Error(`recordApproval failed for ${user.id}`);
    },
    async listApprovalLog(): Promise<ApprovalRecord[]> {
      const out: ApprovalRecord[] = [];
      // Key order is [at, userId], so an ascending scan is already oldest-first.
      for await (const entry of core.kv.list<ApprovalRecord>({ prefix: ["approval_log"] })) {
        out.push(entry.value);
      }
      return out;
    },
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
        const target = await core.kv.get<User>(["user", userId]);
        if (!target.value) return "missing";
        if (target.value.isAdmin === isAdmin) return "unchanged";
        const tx = core.kv.atomic().check(target);
        if (!isAdmin && target.value.status === "approved") {
          const others: Deno.KvEntry<User>[] = [];
          for await (const entry of core.kv.list<User>({ prefix: ["user"] })) {
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
    },
  };
}
