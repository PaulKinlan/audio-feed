/**
 * Sources: the subscriptions a user's feed is built from.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { Source } from "../../types.ts";
import type { MetadataStore, SourceRepository } from "../mod.ts";
import type { KvCore } from "./core.ts";

export function createSourcesRepository(
  core: KvCore,
  _host: () => MetadataStore,
): SourceRepository {
  return {
    // -- sources --------------------------------------------------------------

    async putSource(source: Source): Promise<void> {
      await core.kv.set(["source", source.userId, source.id], source);
    },
    async getSource(userId: string, id: string): Promise<Source | null> {
      return (await core.kv.get<Source>(["source", userId, id])).value;
    },
    async listSources(userId: string): Promise<Source[]> {
      const out: Source[] = [];
      for await (const entry of core.kv.list<Source>({ prefix: ["source", userId] })) {
        out.push(entry.value);
      }
      return out;
    },
    async deleteSource(userId: string, id: string): Promise<void> {
      await core.kv.delete(["source", userId, id]);
    },
  };
}
