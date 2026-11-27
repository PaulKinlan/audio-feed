/**
 * Orphaned audio blobs repository for Cloudflare D1.
 */

import type { MetadataStore, OrphanBlobRepository } from "../mod.ts";
import type { D1Core } from "./core.ts";

export function createD1OrphanBlobsRepository(
  core: D1Core,
  _host: () => MetadataStore,
): OrphanBlobRepository {
  return {
    async recordOrphanBlob(key: string): Promise<void> {
      await core.db.prepare(`INSERT OR IGNORE INTO orphan_blobs (key) VALUES (?)`)
        .bind(key)
        .run();
    },

    async listOrphanBlobs(limit: number): Promise<string[]> {
      const res = await core.db.prepare(
        `SELECT key FROM orphan_blobs ORDER BY key ASC LIMIT ?`,
      ).bind(limit).all<{ key: string }>();
      return res.results.map((r) => r.key);
    },

    async forgetOrphanBlob(key: string): Promise<void> {
      await core.db.prepare(`DELETE FROM orphan_blobs WHERE key = ?`).bind(key).run();
    },
  };
}
