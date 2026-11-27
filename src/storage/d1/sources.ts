/**
 * Sources repository for Cloudflare D1.
 */

import type { Source } from "../../types.ts";
import type { MetadataStore, SourceRepository } from "../mod.ts";
import type { D1Core } from "./core.ts";

export function createD1SourcesRepository(
  core: D1Core,
  _host: () => MetadataStore,
): SourceRepository {
  return {
    async putSource(source: Source): Promise<void> {
      await core.db.prepare(
        `INSERT INTO sources (user_id, id, data) VALUES (?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET data = excluded.data`,
      ).bind(source.userId, source.id, JSON.stringify(source)).run();
    },

    async getSource(userId: string, id: string): Promise<Source | null> {
      const row = await core.db.prepare(
        `SELECT data FROM sources WHERE user_id = ? AND id = ?`,
      ).bind(userId, id).first<{ data: string }>();
      return row ? (JSON.parse(row.data) as Source) : null;
    },

    async listSources(userId: string): Promise<Source[]> {
      const res = await core.db.prepare(
        `SELECT data FROM sources WHERE user_id = ? ORDER BY id ASC`,
      ).bind(userId).all<{ data: string }>();
      return res.results.map((r) => JSON.parse(r.data) as Source);
    },

    async deleteSource(userId: string, id: string): Promise<void> {
      await core.db.prepare(`DELETE FROM sources WHERE user_id = ? AND id = ?`)
        .bind(userId, id)
        .run();
    },
  };
}
