/**
 * Sources: the subscriptions a user's feed is built from.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import type { Source } from "../../types.ts";
import { type MetadataStore } from "../mod.ts";
import type { SourceRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";
import { scoped } from "./state.ts";

export function createSourcesRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): SourceRepository {
  return {
    // -- sources --------------------------------------------------------------

    putSource(source: Source): Promise<void> {
      state.sources.set(
        scoped(source.userId, source.id),
        structuredClone(source),
      );
      return Promise.resolve();
    },
    getSource(userId: string, id: string): Promise<Source | null> {
      const found = state.sources.get(scoped(userId, id));
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    listSources(userId: string): Promise<Source[]> {
      const out = [...state.sources.values()]
        .filter((s) => s.userId === userId)
        .map((s) => structuredClone(s))
        .sort((a, b) => a.id.localeCompare(b.id));
      return Promise.resolve(out);
    },
    deleteSource(userId: string, id: string): Promise<void> {
      state.sources.delete(scoped(userId, id));
      return Promise.resolve();
    },
  };
}
