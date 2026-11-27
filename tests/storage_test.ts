/**
 * Runs the shared conformance suites against the Memory adapters plus atomicUpdate invariants.
 * (`D1MetadataStore` conformance runs in `tests/d1_storage_test.ts`; `R2BlobStore` in `tests/r2_blob_test.ts`.)
 */

import { assertEquals } from "@std/assert";
import { runMetadataConformance } from "./conformance/metadata.ts";
import { runBlobConformance } from "./conformance/blobs.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { makeEpisode } from "./fixtures.ts";

runMetadataConformance({
  name: "MemoryMetadataStore",
  create: () => new MemoryMetadataStore(),
});

runBlobConformance({
  name: "MemoryBlobStore",
  create: () => new MemoryBlobStore(),
});

Deno.test("MemoryMetadataStore: listPendingEpisodes work per page is O(limit) and does not scale with backlog size N (audio-feed-2np)", async () => {
  const store = new MemoryMetadataStore();

  for (let i = 0; i < 100; i++) {
    await store.putEpisode(
      makeEpisode({
        id: `ep-${i}`,
        userId: "u1",
        status: "pending",
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      }),
    );
  }

  let touched = 0;
  const origGet = store.getEpisode.bind(store);
  store.getEpisode = (userId, id) => {
    touched++;
    return origGet(userId, id);
  };

  const page = await store.listPendingEpisodes({ limit: 10 });
  assertEquals(page.episodes.length, 10);
  assertEquals(touched, 10, "work per page must be exactly limit items, not whole store");
});

Deno.test("atomicUpdate: a null mutation leaves the row untouched", async () => {
  const store = new MemoryMetadataStore();
  assertEquals(await store.atomicUpdate<number>("k", () => 7), { value: 7, committed: true });
  assertEquals(
    await store.atomicUpdate<number>("k", () => null),
    { value: 7, committed: false },
    "a peek must not write, and must say it did not",
  );
});

Deno.test("atomicUpdate: the memory adapter shows the same contract", async () => {
  const store = new MemoryMetadataStore();
  assertEquals((await store.atomicUpdate<number>("n", (current) => (current ?? 0) + 1)).value, 1);
  assertEquals((await store.atomicUpdate<number>("n", (current) => (current ?? 0) + 1)).value, 2);
  assertEquals((await store.atomicUpdate<number>("n", () => null)).value, 2);
});
