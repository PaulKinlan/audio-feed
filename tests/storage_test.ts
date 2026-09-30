/**
 * Runs the shared conformance suites against every adapter.
 *
 * The KV adapter uses an in-memory Deno KV (`:memory:`), so this needs no
 * external service and stays runnable in CI and on a laptop.
 */

import { assert, assertEquals } from "@std/assert";
import { runMetadataConformance } from "./conformance/metadata.ts";
import { runBlobConformance } from "./conformance/blobs.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { ARTICLE_CHUNK_SIZE, KvMetadataStore } from "../src/storage/kv.ts";
import { RUN_HISTORY_LIMIT, type RunRecord } from "../src/storage/mod.ts";
import { makeArticle, makeEpisode } from "./fixtures.ts";

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

Deno.test("KvMetadataStore: the backfill moves a legacy pointer into its priority segment, leaving one", async () => {
  // audio-feed-15e. A deployed instance already has pointers written in the old 3-segment shape,
  // and a prefix scan matches BOTH shapes — so an un-migrated episode would be listed twice in
  // one tick and could be claimed and billed twice. This drives the real upgrade path: legacy
  // pointer written by the previous build, then the backfill.
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });

  const legacy = makeEpisode({
    id: "ep-old",
    userId: "u1",
    status: "pending",
    regenerating: true,
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  await kv.set(["episode", "u1", legacy.id], legacy);
  // The pointer as the pre-15e build wrote it: no priority segment.
  await kv.set(["pending_episodes", legacy.createdAt, legacy.id], { userId: "u1", id: legacy.id });

  const stats = await store.reindexPendingEpisodes();
  assertEquals(stats.indexed, 2, "one pointer added in the right segment, the legacy one removed");

  const keys: string[] = [];
  for await (const entry of kv.list({ prefix: ["pending_episodes"] })) {
    keys.push(JSON.stringify(entry.key));
  }
  assertEquals(keys.length, 1, `exactly one queue pointer must survive, got ${keys.join(" ")}`);
  assertEquals(
    keys[0],
    JSON.stringify(["pending_episodes", "1", legacy.createdAt, legacy.id]),
    "a regeneration belongs in the lower priority segment",
  );

  const listed = await store.listPendingEpisodes({ limit: 10 });
  assertEquals(
    listed.episodes.map((e) => e.id),
    ["ep-old"],
    "and it is still queueable exactly once",
  );
  await kv.close();
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

Deno.test("KvMetadataStore: chunks and reconstitutes 150,000 character article with 100% fidelity (audio-feed-cei)", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });

  try {
    // Generate 150,000 chars of recognizable, verifiable content
    const sentence =
      "The edge architecture enables streaming transformations and real-time audio synthesis at scale. ";
    const fullContent = sentence.repeat(Math.ceil(150_000 / sentence.length)).slice(0, 150_000);
    assertEquals(fullContent.length, 150_000);

    const article = makeArticle({
      id: "art-large-150k",
      userId: "u-large",
      url: "https://example.com/large-post",
      title: "Scale Architecture Document",
      content: fullContent,
    });

    await store.putArticle(article);

    // Verify low-level KV base record has content: "" and chunkCount: 4
    const expectedChunks = Math.ceil(150_000 / ARTICLE_CHUNK_SIZE);
    assertEquals(expectedChunks, 4);

    const rawBase = await kv.get(["article", "u-large", "art-large-150k"]);
    assert(rawBase.value !== null);
    const baseValue = rawBase.value as { content: string; chunkCount: number };
    assertEquals(baseValue.content, "", "base KV entry must store empty content when chunked");
    assertEquals(baseValue.chunkCount, expectedChunks, "base KV entry must record chunkCount");

    // Verify raw chunk entries exist in KV
    for (let i = 0; i < expectedChunks; i++) {
      const chunkEntry = await kv.get(["article_chunk", "u-large", "art-large-150k", i]);
      assert(chunkEntry.value !== null, `chunk ${i} must exist in KV`);
      const expectedSlice = fullContent.slice(i * ARTICLE_CHUNK_SIZE, (i + 1) * ARTICLE_CHUNK_SIZE);
      assertEquals(chunkEntry.value, expectedSlice);
    }

    // 1. Verify getArticle reconstructs full content
    const retrieved = await store.getArticle("u-large", "art-large-150k");
    assert(retrieved !== null);
    assertEquals(retrieved.id, "art-large-150k");
    assertEquals(retrieved.content.length, 150_000);
    assertEquals(retrieved.content, fullContent, "reconstructed content must match 100%");

    // 2. Verify getArticles batches and hydrates
    const batch = await store.getArticles("u-large", ["art-large-150k", "non-existent"]);
    assertEquals(batch.length, 2);
    assertEquals(batch[0]?.content, fullContent);
    assertEquals(batch[1], null);

    // 3. Verify findArticleByUrl hydrates
    const byUrl = await store.findArticleByUrl("u-large", "https://example.com/large-post");
    assertEquals(byUrl?.content, fullContent);

    // 4. Verify deleteArticle deletes base article, url index, and all chunks
    await store.deleteArticle("u-large", "art-large-150k");
    assertEquals(await store.getArticle("u-large", "art-large-150k"), null);
    assertEquals(await store.findArticleByUrl("u-large", "https://example.com/large-post"), null);

    const remainingChunks = await Array.fromAsync(
      kv.list({ prefix: ["article_chunk", "u-large", "art-large-150k"] }),
    );
    assertEquals(remainingChunks.length, 0, "all chunk keys must be deleted");
  } finally {
    await kv.close();
  }
});

Deno.test("KvMetadataStore: supports multi-batch atomic chunking for 2,000,000 character article (audio-feed-cei)", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });

  try {
    const hugeContent = "X".repeat(2_000_000);
    const expectedChunks = Math.ceil(2_000_000 / ARTICLE_CHUNK_SIZE);
    assertEquals(expectedChunks, 42);

    const article = makeArticle({
      id: "art-huge-2m",
      userId: "u-huge",
      url: "https://example.com/huge-2m",
      title: "Two Million Character Document",
      content: hugeContent,
    });

    // Must not throw "Total mutation size too large (max 819200 bytes)"
    await store.putArticle(article);

    const retrieved = await store.getArticle("u-huge", "art-huge-2m");
    assert(retrieved !== null);
    assertEquals(retrieved.content.length, 2_000_000);
    assertEquals(retrieved.content, hugeContent);

    // Clean up
    await store.deleteArticle("u-huge", "art-huge-2m");
    const remainingChunks = await Array.fromAsync(
      kv.list({ prefix: ["article_chunk", "u-huge", "art-huge-2m"] }),
    );
    assertEquals(remainingChunks.length, 0);
  } finally {
    await kv.close();
  }
});

Deno.test("KvMetadataStore: insertArticleIfAbsent and insertArticleWithEpisodeIfAbsent support chunking (audio-feed-cei)", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });

  try {
    const content = "B".repeat(120_000);
    const art1 = makeArticle({
      id: "art-absent-1",
      userId: "u1",
      url: "https://example.com/absent-1",
      content,
    });

    // 1. insertArticleIfAbsent succeeds
    const inserted = await store.insertArticleIfAbsent(art1);
    assertEquals(inserted, true);
    const retrieved1 = await store.getArticle("u1", "art-absent-1");
    assertEquals(retrieved1?.content, content);

    // 2. duplicate insertArticleIfAbsent with same URL fails without corrupting or leaving orphan chunks
    const art1Dup = makeArticle({
      id: "art-absent-dup",
      userId: "u1",
      url: "https://example.com/absent-1",
      content: "C".repeat(120_000),
    });
    const dupResult = await store.insertArticleIfAbsent(art1Dup);
    assertEquals(dupResult, false);

    // Ensure no orphan chunks for art-absent-dup
    const orphanChunks = await Array.fromAsync(
      kv.list({ prefix: ["article_chunk", "u1", "art-absent-dup"] }),
    );
    assertEquals(orphanChunks.length, 0, "failed insert must not leave orphan chunks");

    // 3. insertArticleWithEpisodeIfAbsent with chunked article
    const ep = makeEpisode({
      id: "ep-pair-1",
      userId: "u1",
      articleId: "art-pair-1",
      status: "pending",
    });
    const artPair = makeArticle({
      id: "art-pair-1",
      userId: "u1",
      url: "https://example.com/pair-large",
      content,
    });
    const pairResult = await store.insertArticleWithEpisodeIfAbsent(artPair, ep);
    assertEquals(pairResult, true);

    const retrievedPair = await store.getArticle("u1", "art-pair-1");
    assertEquals(retrievedPair?.content, content);
    const retrievedEp = await store.getEpisode("u1", "ep-pair-1");
    assertEquals(retrievedEp?.id, "ep-pair-1");
  } finally {
    await kv.close();
  }
});
