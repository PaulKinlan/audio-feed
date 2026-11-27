/**
 * Users repository for Cloudflare D1.
 */

import type { ApprovalRecord, User } from "../../types.ts";
import type { MetadataStore, UserRepository } from "../mod.ts";
import type { D1Core } from "./core.ts";
import type { D1PreparedStatementLike } from "./types.ts";

interface UserRow {
  data: string;
  version: number;
}

async function buildPutUserStatements(
  core: D1Core,
  user: User,
): Promise<D1PreparedStatementLike[]> {
  const email = user.email.toLowerCase();
  const prev = await core.db.prepare(`SELECT email, feed_token FROM users WHERE id = ?`)
    .bind(user.id)
    .first<{ email: string; feed_token: string }>();

  const stmts: D1PreparedStatementLike[] = [];
  if (prev) {
    if (prev.email !== email) {
      stmts.push(
        core.db.prepare(`DELETE FROM user_emails WHERE email = ? AND user_id = ?`)
          .bind(prev.email, user.id),
      );
    }
    if (prev.feed_token !== user.feedToken) {
      stmts.push(
        core.db.prepare(`DELETE FROM user_feed_tokens WHERE feed_token = ? AND user_id = ?`)
          .bind(prev.feed_token, user.id),
      );
    }
  }

  stmts.push(
    core.db.prepare(
      `INSERT INTO users (id, email, feed_token, status, is_admin, version, data)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         feed_token = excluded.feed_token,
         status = excluded.status,
         is_admin = excluded.is_admin,
         version = users.version + 1,
         data = excluded.data`,
    ).bind(
      user.id,
      email,
      user.feedToken,
      user.status,
      user.isAdmin ? 1 : 0,
      JSON.stringify(user),
    ),
    core.db.prepare(
      `INSERT INTO user_emails (email, user_id) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id`,
    ).bind(email, user.id),
    core.db.prepare(
      `INSERT INTO user_feed_tokens (feed_token, user_id) VALUES (?, ?)
       ON CONFLICT(feed_token) DO UPDATE SET user_id = excluded.user_id`,
    ).bind(user.feedToken, user.id),
  );
  return stmts;
}

export function createD1UsersRepository(
  core: D1Core,
  host: () => MetadataStore,
): UserRepository {
  return {
    async insertUser(user: User): Promise<boolean> {
      const email = user.email.toLowerCase();
      const results = await core.db.batch([
        core.db.prepare(
          `INSERT OR IGNORE INTO users (id, email, feed_token, status, is_admin, version, data)
           SELECT ?, ?, ?, ?, ?, 1, ?
           WHERE NOT EXISTS (SELECT 1 FROM user_emails WHERE email = ?)
             AND NOT EXISTS (SELECT 1 FROM user_feed_tokens WHERE feed_token = ?)`,
        ).bind(
          user.id,
          email,
          user.feedToken,
          user.status,
          user.isAdmin ? 1 : 0,
          JSON.stringify(user),
          email,
          user.feedToken,
        ),
        core.db.prepare(
          `INSERT OR IGNORE INTO user_emails (email, user_id)
           SELECT ?, ?
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND email = ?)`,
        ).bind(email, user.id, user.id, email),
        core.db.prepare(
          `INSERT OR IGNORE INTO user_feed_tokens (feed_token, user_id)
           SELECT ?, ?
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND feed_token = ?)`,
        ).bind(user.feedToken, user.id, user.id, user.feedToken),
      ]);
      return (results[0]?.meta.changes ?? 0) === 1;
    },

    async putUser(user: User): Promise<void> {
      const stmts = await buildPutUserStatements(core, user);
      await core.db.batch(stmts);
    },

    async getUser(id: string): Promise<User | null> {
      const row = await core.db.prepare(`SELECT data FROM users WHERE id = ?`)
        .bind(id)
        .first<{ data: string }>();
      return row ? (JSON.parse(row.data) as User) : null;
    },

    async getUserByEmail(email: string): Promise<User | null> {
      const ptr = await core.db.prepare(`SELECT user_id FROM user_emails WHERE email = ?`)
        .bind(email.toLowerCase())
        .first<{ user_id: string }>();
      if (!ptr) return null;
      return await host().getUser(ptr.user_id);
    },

    async getUserByFeedToken(token: string): Promise<User | null> {
      if (!token) return null;
      const ptr = await core.db.prepare(`SELECT user_id FROM user_feed_tokens WHERE feed_token = ?`)
        .bind(token)
        .first<{ user_id: string }>();
      if (!ptr) return null;
      return await host().getUser(ptr.user_id);
    },

    async listUsers(): Promise<User[]> {
      const res = await core.db.prepare(`SELECT data FROM users ORDER BY id ASC`)
        .all<{ data: string }>();
      return res.results.map((r) => JSON.parse(r.data) as User);
    },

    async recordApproval(user: User, record: ApprovalRecord): Promise<void> {
      const stmts = await buildPutUserStatements(core, user);
      stmts.push(
        core.db.prepare(
          `INSERT INTO approval_log (at, user_id, data) VALUES (?, ?, ?)`,
        ).bind(record.at, record.userId, JSON.stringify(record)),
      );
      await core.db.batch(stmts);
    },

    async listApprovalLog(): Promise<ApprovalRecord[]> {
      const res = await core.db.prepare(
        `SELECT data FROM approval_log ORDER BY at ASC, user_id ASC, seq ASC`,
      ).all<{ data: string }>();
      return res.results.map((r) => JSON.parse(r.data) as ApprovalRecord);
    },

    async setAdminRole(
      userId: string,
      isAdmin: boolean,
      by: { adminId: string; at: string },
    ): Promise<"changed" | "unchanged" | "last-admin" | "missing"> {
      for (let attempt = 0; attempt < 16; attempt++) {
        const row = await core.db.prepare(`SELECT data, version FROM users WHERE id = ?`)
          .bind(userId)
          .first<UserRow>();
        if (!row) return "missing";
        const target = JSON.parse(row.data) as User;
        if (target.isAdmin === isAdmin) return "unchanged";

        const nextVersion = row.version + 1;
        const updated: User = { ...target, isAdmin };
        const record: ApprovalRecord = {
          userId,
          action: "role",
          adminId: by.adminId,
          at: by.at,
          fromRole: isAdmin ? "user" : "admin",
          toRole: isAdmin ? "admin" : "user",
        };

        const updateStmt = !isAdmin && target.status === "approved"
          ? core.db.prepare(
            `UPDATE users
             SET is_admin = 0, version = ?, data = ?
             WHERE id = ? AND version = ?
               AND (SELECT COUNT(*) FROM users WHERE id != ? AND is_admin = 1 AND status = 'approved') > 0`,
          ).bind(nextVersion, JSON.stringify(updated), userId, row.version, userId)
          : core.db.prepare(
            `UPDATE users
             SET is_admin = ?, version = ?, data = ?
             WHERE id = ? AND version = ?`,
          ).bind(isAdmin ? 1 : 0, nextVersion, JSON.stringify(updated), userId, row.version);

        const logStmt = core.db.prepare(
          `INSERT INTO approval_log (at, user_id, data)
           SELECT ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND version = ?)`,
        ).bind(record.at, userId, JSON.stringify(record), userId, nextVersion);

        const results = await core.db.batch([updateStmt, logStmt]);
        if ((results[0]?.meta.changes ?? 0) === 1) return "changed";

        if (!isAdmin && target.status === "approved") {
          const check = await core.db.prepare(
            `SELECT COUNT(*) AS cnt FROM users WHERE id != ? AND is_admin = 1 AND status = 'approved'`,
          ).bind(userId).first<{ cnt: number }>();
          if ((check?.cnt ?? 0) === 0) return "last-admin";
        }
      }
      return "last-admin";
    },
  };
}
