/**
 * Runs the shared conformance suites against every adapter.
 *
 * The KV adapter uses an in-memory Deno KV (`:memory:`), so this needs no
 * external service and stays runnable in CI and on a laptop.
 */

import { assertEquals } from "@std/assert";
import { runMetadataConformance } from "./conformance/metadata.ts";
import { runBlobConformance } from "./conformance/blobs.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { RUN_HISTORY_LIMIT, type RunRecord } from "../src/storage/mod.ts";
import { makeEpisode } from "./fixtures.ts";

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

Deno.test("KvMetadataStore: reindexPendingEpisodes backfills pre-existing un-indexed pending episodes (audio-feed-7li)", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });

  const ep1 = makeEpisode({
    id: "ep-legacy-1",
    userId: "u1",
    status: "pending",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  const ep2 = makeEpisode({
    id: "ep-legacy-2",
    userId: "u1",
    status: "synthesizing",
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  const ep3 = makeEpisode({
    id: "ep-legacy-3",
    userId: "u1",
    status: "ready",
    createdAt: "2026-09-03T00:00:00.000Z",
  });

  await kv.set(["episode", "u1", ep1.id], ep1);
  await kv.set(["episode", "u1", ep2.id], ep2);
  await kv.set(["episode", "u1", ep3.id], ep3);

  // Before reindex: invisible to listPendingEpisodes
  const before = await store.listPendingEpisodes();
  assertEquals(before.episodes.length, 0);

  // Reindex
  const stats = await store.reindexPendingEpisodes();
  assertEquals(stats.scanned, 3);
  assertEquals(stats.indexed, 2);

  // After reindex: visible to listPendingEpisodes (1 pending + 1 synthesizing with expired claim)
  const after = await store.listPendingEpisodes();
  assertEquals(after.episodes.length, 2);
  assertEquals(after.episodes.map((e) => e.id), ["ep-legacy-1", "ep-legacy-2"]);

  // Re-running is idempotent
  const second = await store.reindexPendingEpisodes();
  assertEquals(second.indexed, 0);

  await store.close();
});

Deno.test("KvMetadataStore.open: runs automatic backfill migration on open (audio-feed-2np)", async () => {
  const tempDir = await Deno.makeTempDir();
  const kvPath = `${tempDir}/test.kv`;

  // Seed raw KV without indexes
  const kv = await Deno.openKv(kvPath);
  const ep = makeEpisode({
    id: "ep-legacy-auto",
    userId: "u1",
    status: "pending",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  await kv.set(["episode", "u1", ep.id], ep);
  kv.close();

  // Open through KvMetadataStore.open() - must run #ensurePendingEpisodesIndexed()
  const store = await KvMetadataStore.open(kvPath);

  const pending = await store.listPendingEpisodes();
  assertEquals(pending.episodes.length, 1);
  assertEquals(pending.episodes[0]?.id, "ep-legacy-auto");

  await store.close();
  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("MemoryMetadataStore: listPendingEpisodes work per page is O(limit) and does not scale with backlog size N (audio-feed-2np)", async () => {
  const store = new MemoryMetadataStore();

  // Populate 100 pending episodes
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

  // Fetch single page of limit 10
  const page = await store.listPendingEpisodes({ limit: 10 });
  assertEquals(page.episodes.length, 10);

  // The indexed implementation must touch ONLY the 10 episodes in the page,
  // NOT the 100 episodes in the store!
  assertEquals(touched, 10, "work per page must be exactly limit items, not whole store");
});

Deno.test("KvMetadataStore: recording an idle tick reads one entry, not the job's history (audio-feed-0ob)", async () => {
  // audio-feed-0ob is about this number, so count it. Every write used to list
  // the job's whole history to prune it: 51 entries at steady state. The
  // collapse tests in the conformance suite would still pass if that came back.
  const kv = await Deno.openKv(":memory:");
  let listed = 0;
  const counting = new Proxy(kv, {
    get(target, prop) {
      if (prop === "list") {
        return async function* (...args: Parameters<Deno.Kv["list"]>) {
          for await (const entry of target.list(...args)) {
            listed++;
            yield entry;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = new KvMetadataStore(counting);
  const run = (id: string, minute: number, idle = false): RunRecord => ({
    id,
    kind: "synthesis",
    trigger: "cron",
    startedAt: new Date(Date.UTC(2026, 8, 25) + minute * 60_000).toISOString(),
    durationMs: 30,
    ready: idle ? 0 : 1,
    ...(idle ? { idle: true } : {}),
  });

  try {
    // A full history of ticks that did work, then an idle tick after them.
    for (let i = 0; i < RUN_HISTORY_LIMIT; i++) await store.recordRun(run(`w${i}`, i));
    await store.recordRun(run("i1", RUN_HISTORY_LIMIT, true));

    listed = 0;
    await store.recordRun(run("i2", RUN_HISTORY_LIMIT + 1, true));
    assertEquals(listed, 1, "the next idle tick reads one entry");

    const ids = (await store.listRuns()).map((r) => r.id);
    assertEquals(ids.slice(0, 2), ["i2", `w${RUN_HISTORY_LIMIT - 1}`], "i2 replaced i1");
    assertEquals(ids.length, RUN_HISTORY_LIMIT, "still bounded");
  } finally {
    kv.close();
  }
});
