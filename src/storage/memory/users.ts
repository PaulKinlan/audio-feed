/**
 * Users: accounts, approval state, feed tokens and the admin role.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import type { ApprovalRecord, User } from "../../types.ts";
import { type MetadataStore } from "../mod.ts";
import type { UserRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";

export function createUsersRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): UserRepository {
  return {
    // -- users ----------------------------------------------------------------

    insertUser(user: User): Promise<boolean> {
      if (state.users.has(user.id)) return Promise.resolve(false);
      const email = user.email.toLowerCase();
      for (const existing of state.users.values()) {
        if (existing.email.toLowerCase() === email) return Promise.resolve(false);
        if (existing.feedToken === user.feedToken) return Promise.resolve(false);
      }
      state.users.set(user.id, structuredClone(user));
      return Promise.resolve(true);
    },
    putUser(user: User): Promise<void> {
      state.users.set(user.id, structuredClone(user));
      return Promise.resolve();
    },
    getUser(id: string): Promise<User | null> {
      const found = state.users.get(id);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    getUserByEmail(email: string): Promise<User | null> {
      const needle = email.toLowerCase();
      for (const user of state.users.values()) {
        if (user.email.toLowerCase() === needle) return Promise.resolve(structuredClone(user));
      }
      return Promise.resolve(null);
    },
    getUserByFeedToken(token: string): Promise<User | null> {
      if (!token) return Promise.resolve(null);
      for (const user of state.users.values()) {
        if (user.feedToken === token) return Promise.resolve(structuredClone(user));
      }
      return Promise.resolve(null);
    },
    listUsers(): Promise<User[]> {
      return Promise.resolve([...state.users.values()].map((u) => structuredClone(u)));
    },
    recordApproval(user: User, record: ApprovalRecord): Promise<void> {
      state.users.set(user.id, structuredClone(user));
      state.approvals.push(structuredClone(record));
      return Promise.resolve();
    },
    listApprovalLog(): Promise<ApprovalRecord[]> {
      const out = state.approvals.map((record) => structuredClone(record));
      // Oldest first, tie-broken by user so repeated reads cannot swap entries.
      out.sort((a, b) =>
        a.at === b.at ? a.userId.localeCompare(b.userId) : a.at.localeCompare(b.at)
      );
      return Promise.resolve(out);
    },
    // Single-threaded: the admin count and the write cannot interleave with another call.
    setAdminRole(
      userId: string,
      isAdmin: boolean,
      by: { adminId: string; at: string },
    ): Promise<"changed" | "unchanged" | "last-admin" | "missing"> {
      const target = state.users.get(userId);
      if (!target) return Promise.resolve("missing");
      if (target.isAdmin === isAdmin) return Promise.resolve("unchanged");
      if (!isAdmin && target.status === "approved") {
        const others = [...state.users.values()].filter((u) =>
          u.id !== userId && u.isAdmin && u.status === "approved"
        );
        if (others.length === 0) return Promise.resolve("last-admin");
      }
      state.users.set(userId, { ...target, isAdmin });
      state.approvals.push({
        userId,
        action: "role",
        adminId: by.adminId,
        at: by.at,
        fromRole: isAdmin ? "user" : "admin",
        toRole: isAdmin ? "admin" : "user",
      });
      return Promise.resolve("changed");
    },
  };
}
