/**
 * Orphaned audio blobs: keys a delete failed on, kept for a later sweep.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { MetadataStore, OrphanBlobRepository } from "../mod.ts";
import type { KvCore } from "./core.ts";

export function createOrphanBlobsRepository(
  core: KvCore,
  _host: () => MetadataStore,
): OrphanBlobRepository {
  return {
    async recordOrphanBlob(key: string): Promise<void> {
      await core.kv.set(["orphan_blob", key], true);
    },
    async listOrphanBlobs(limit: number): Promise<string[]> {
      const keys: string[] = [];
      for await (const entry of core.kv.list({ prefix: ["orphan_blob"] }, { limit })) {
        if (typeof entry.key[1] === "string") keys.push(entry.key[1]);
      }
      return keys;
    },
    async forgetOrphanBlob(key: string): Promise<void> {
      await core.kv.delete(["orphan_blob", key]);
    },
    // -- operational stats (audio-feed-ndc) ------------------------------------,
  };
}
