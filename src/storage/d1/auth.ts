/**
 * Accounts storage repository (sessions, passkey credentials, setup links, challenges) for D1.
 */

import type { AuthChallenge, PasskeyCredential, Session, SetupLink } from "../../types.ts";
import type { AuthRepository, MetadataStore } from "../mod.ts";
import type { D1Core } from "./core.ts";
import { parseExpiresAtMs } from "./core.ts";

export function createD1AuthRepository(
  core: D1Core,
  _host: () => MetadataStore,
): AuthRepository {
  return {
    async putSession(session: Session): Promise<void> {
      await core.db.prepare(
        `INSERT INTO sessions (id_hash, expires_at, data) VALUES (?, ?, ?)
         ON CONFLICT(id_hash) DO UPDATE SET
           expires_at = excluded.expires_at,
           data = excluded.data`,
      ).bind(session.idHash, parseExpiresAtMs(session.expiresAt), JSON.stringify(session)).run();
    },

    async getSession(idHash: string): Promise<Session | null> {
      const row = await core.db.prepare(`SELECT data FROM sessions WHERE id_hash = ?`)
        .bind(idHash)
        .first<{ data: string }>();
      return row ? (JSON.parse(row.data) as Session) : null;
    },

    async deleteSession(idHash: string): Promise<void> {
      await core.db.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(idHash).run();
    },

    async putCredential(credential: PasskeyCredential): Promise<void> {
      await core.db.prepare(
        `INSERT INTO passkey_credentials (id, user_id, created_at, data)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           user_id = excluded.user_id,
           created_at = excluded.created_at,
           data = excluded.data`,
      ).bind(
        credential.id,
        credential.userId,
        credential.createdAt,
        JSON.stringify(credential),
      ).run();
    },

    async getCredential(id: string): Promise<PasskeyCredential | null> {
      const row = await core.db.prepare(`SELECT data FROM passkey_credentials WHERE id = ?`)
        .bind(id)
        .first<{ data: string }>();
      return row ? (JSON.parse(row.data) as PasskeyCredential) : null;
    },

    async listCredentials(userId: string): Promise<PasskeyCredential[]> {
      const res = await core.db.prepare(
        `SELECT data FROM passkey_credentials
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
      ).bind(userId).all<{ data: string }>();
      return res.results.map((r) => JSON.parse(r.data) as PasskeyCredential);
    },

    async deleteCredential(userId: string, id: string): Promise<"deleted" | "last" | "missing"> {
      const res = await core.db.prepare(
        `DELETE FROM passkey_credentials
         WHERE id = ? AND user_id = ?
           AND (SELECT COUNT(*) FROM passkey_credentials WHERE user_id = ?) > 1`,
      ).bind(id, userId, userId).run();
      if ((res.meta.changes ?? 0) === 1) return "deleted";

      const exists = await core.db.prepare(
        `SELECT 1 AS found FROM passkey_credentials WHERE id = ? AND user_id = ?`,
      ).bind(id, userId).first<{ found: number }>();
      return exists ? "last" : "missing";
    },

    async putSetupLink(link: SetupLink): Promise<void> {
      await core.db.prepare(
        `INSERT INTO setup_links (token_hash, expires_at, data) VALUES (?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           expires_at = excluded.expires_at,
           data = excluded.data`,
      ).bind(link.tokenHash, parseExpiresAtMs(link.expiresAt), JSON.stringify(link)).run();
    },

    async getSetupLink(tokenHash: string): Promise<SetupLink | null> {
      const row = await core.db.prepare(`SELECT data FROM setup_links WHERE token_hash = ?`)
        .bind(tokenHash)
        .first<{ data: string }>();
      return row ? (JSON.parse(row.data) as SetupLink) : null;
    },

    async consumeSetupLink(tokenHash: string): Promise<SetupLink | null> {
      const res = await core.db.prepare(
        `DELETE FROM setup_links WHERE token_hash = ? RETURNING data`,
      ).bind(tokenHash).all<{ data: string }>();
      const row = res.results[0];
      return row ? (JSON.parse(row.data) as SetupLink) : null;
    },

    async putChallenge(challenge: AuthChallenge): Promise<void> {
      await core.db.prepare(
        `INSERT INTO auth_challenges (challenge, expires_at, data) VALUES (?, ?, ?)
         ON CONFLICT(challenge) DO UPDATE SET
           expires_at = excluded.expires_at,
           data = excluded.data`,
      ).bind(
        challenge.challenge,
        parseExpiresAtMs(challenge.expiresAt),
        JSON.stringify(challenge),
      ).run();
    },

    async consumeChallenge(challenge: string): Promise<AuthChallenge | null> {
      const res = await core.db.prepare(
        `DELETE FROM auth_challenges WHERE challenge = ? RETURNING data`,
      ).bind(challenge).all<{ data: string }>();
      const row = res.results[0];
      return row ? (JSON.parse(row.data) as AuthChallenge) : null;
    },
  };
}
