/**
 * Runs the shared conformance suites against every adapter.
 *
 * The KV adapter uses an in-memory Deno KV (`:memory:`), so this needs no
 * external service and stays runnable in CI and on a laptop.
 */

import { runMetadataConformance } from "./conformance/metadata.ts";
import { runBlobConformance } from "./conformance/blobs.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";

runMetadataConformance({
  name: "MemoryMetadataStore",
  create: () => new MemoryMetadataStore(),
});

runMetadataConformance({
  name: "KvMetadataStore",
  create: async () => {
    const kv = await Deno.openKv(":memory:");
    return new KvMetadataStore(kv, { ownsConnection: true });
  },
});

runBlobConformance({
  name: "MemoryBlobStore",
  create: () => new MemoryBlobStore(),
});
