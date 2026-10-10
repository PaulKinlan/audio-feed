/**
 * Orphaned audio blobs: keys a delete failed on, kept for a later sweep.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import { type MetadataStore } from "../mod.ts";
import type { OrphanBlobRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";

export function createOrphanBlobsRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): OrphanBlobRepository {
  return {
    recordOrphanBlob(key: string): Promise<void> {
      state.orphanBlobs.add(key);
      return Promise.resolve();
    },
    listOrphanBlobs(limit: number): Promise<string[]> {
      return Promise.resolve([...state.orphanBlobs].slice(0, limit));
    },
    forgetOrphanBlob(key: string): Promise<void> {
      state.orphanBlobs.delete(key);
      return Promise.resolve();
    },
  };
}
