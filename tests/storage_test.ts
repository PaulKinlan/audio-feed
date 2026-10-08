/**
 * Runs the shared conformance suites against every adapter.
 *
 * The KV adapter uses an in-memory Deno KV (`:memory:`), so this needs no
 * external service and stays runnable in CI and on a laptop.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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

Deno.test("KvMetadataStore: F1 acceptance matrix - byte-safe chunking across non-ASCII, CJK, and emoji (audio-feed-cei)", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });

  try {
    // 1. 48,000 ASCII: stores whole, 0 chunks, identity true
    const ascii48k = "A".repeat(48_000);
    const art48k = makeArticle({
      id: "art-48k",
      userId: "u",
      url: "https://example.com/48k",
      content: ascii48k,
    });
    await store.putArticle(art48k);
    const raw48k = (await kv.get(["article", "u", "art-48k"])).value as { chunkCount: number };
    assertEquals(raw48k.chunkCount, 0, "48k ASCII must store whole with chunkCount: 0");
    assertEquals((await store.getArticle("u", "art-48k"))?.content, ascii48k);

    // 2. 48,001 ASCII: 2 chunks, identity true
    const ascii48k1 = "A".repeat(48_001);
    const art48k1 = makeArticle({
      id: "art-48k1",
      userId: "u",
      url: "https://example.com/48k1",
      content: ascii48k1,
    });
    await store.putArticle(art48k1);
    const raw48k1 = (await kv.get(["article", "u", "art-48k1"])).value as { chunkCount: number };
    assertEquals(raw48k1.chunkCount, 2);
    assertEquals((await store.getArticle("u", "art-48k1"))?.content, ascii48k1);

    // 3. 96,000 ASCII: 2 chunks, identity true
    const ascii96k = "A".repeat(96_000);
    const art96k = makeArticle({
      id: "art-96k",
      userId: "u",
      url: "https://example.com/96k",
      content: ascii96k,
    });
    await store.putArticle(art96k);
    const raw96k = (await kv.get(["article", "u", "art-96k"])).value as { chunkCount: number };
    assertEquals(raw96k.chunkCount, 2);
    assertEquals((await store.getArticle("u", "art-96k"))?.content, ascii96k);

    // 4. 2,000,000 ASCII: identity true, chunkCount === ceil(len / CHUNK_SIZE)
    const ascii2m = "A".repeat(2_000_000);
    const art2m = makeArticle({
      id: "art-2m",
      userId: "u",
      url: "https://example.com/2m",
      content: ascii2m,
    });
    await store.putArticle(art2m);
    const raw2m = (await kv.get(["article", "u", "art-2m"])).value as { chunkCount: number };
    assertEquals(raw2m.chunkCount, Math.ceil(2_000_000 / ARTICLE_CHUNK_SIZE));
    assertEquals((await store.getArticle("u", "art-2m"))?.content, ascii2m);

    // 5. 48,000 CJK (144,000 B): stores and round-trips identically without error
    const cjk48k = "漢".repeat(48_000);
    const artCjk = makeArticle({
      id: "art-cjk",
      userId: "u",
      url: "https://example.com/cjk",
      content: cjk48k,
    });
    await store.putArticle(artCjk);
    const rawCjk = (await kv.get(["article", "u", "art-cjk"])).value as { chunkCount: number };
    assertEquals(rawCjk.chunkCount, 3, "144,000 B CJK must split into 3 chunks");
    assertEquals((await store.getArticle("u", "art-cjk"))?.content, cjk48k);

    // 6. 48,000 Cyrillic (96,000 B): stores and round-trips identically without error
    const cyr48k = "Я".repeat(48_000);
    const artCyr = makeArticle({
      id: "art-cyr",
      userId: "u",
      url: "https://example.com/cyr",
      content: cyr48k,
    });
    await store.putArticle(artCyr);
    const rawCyr = (await kv.get(["article", "u", "art-cyr"])).value as { chunkCount: number };
    assertEquals(rawCyr.chunkCount, 2, "96,000 B Cyrillic must split into 2 chunks");
    assertEquals((await store.getArticle("u", "art-cyr"))?.content, cyr48k);

    // 7. 30,000 emoji (120,000 B): stores and round-trips identically without error
    const emoji30k = "😀".repeat(30_000);
    const artEmoji = makeArticle({
      id: "art-emoji",
      userId: "u",
      url: "https://example.com/emoji",
      content: emoji30k,
    });
    await store.putArticle(artEmoji);
    const rawEmoji = (await kv.get(["article", "u", "art-emoji"])).value as { chunkCount: number };
    assertEquals(rawEmoji.chunkCount, 3, "120,000 B emoji must split into 3 chunks");
    assertEquals((await store.getArticle("u", "art-emoji"))?.content, emoji30k);

    // 8. Mixed ASCII + CJK + emoji crossing chunk boundary: round-trips; no chunk > 65,536 bytes
    const mixed = "A".repeat(47_990) + "😀" + "漢" + "B".repeat(100);
    const artMixed = makeArticle({
      id: "art-mixed",
      userId: "u",
      url: "https://example.com/mixed",
      content: mixed,
    });
    await store.putArticle(artMixed);
    assertEquals((await store.getArticle("u", "art-mixed"))?.content, mixed);

    // Assert every chunk across all stored articles is strictly <= 65,536 bytes
    const encoder = new TextEncoder();
    for await (const entry of kv.list({ prefix: ["article_chunk"] })) {
      const byteLen = encoder.encode(entry.value as string).length;
      assert(
        byteLen <= 65_536,
        `Chunk key ${JSON.stringify(entry.key)} size ${byteLen} exceeds 65536 bytes`,
      );
    }
  } finally {
    await kv.close();
  }
});

Deno.test("KvMetadataStore: F2 hydration refusal - missing chunk throws naming id, expected and found count (audio-feed-cei)", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });

  try {
    const content =
      "The edge architecture enables streaming transformations and real-time audio synthesis at scale. ";
    const fullContent = content.repeat(Math.ceil(150_000 / content.length)).slice(0, 150_000);
    const article = makeArticle({
      id: "art-corrupt-test",
      userId: "u-corrupt",
      url: "https://example.com/corrupt",
      content: fullContent,
    });

    await store.putArticle(article);

    // Delete 1 of 4 chunks to simulate partial/corrupted storage
    await kv.delete(["article_chunk", "u-corrupt", "art-corrupt-test", 2]);

    // getArticle must throw naming article id, expected count, and found count
    const err = await assertRejects(
      () => store.getArticle("u-corrupt", "art-corrupt-test"),
      Error,
    );
    assertStringIncludes(err.message, "Corrupted article storage for art-corrupt-test");
    assertStringIncludes(err.message, "expected 4 chunks");
    assertStringIncludes(err.message, "found 3");

    // getArticles degrades the damaged row to null rather than rejecting the whole batch
    // (audio-feed-jnor). The invariant this line used to protect — never hand back partial text — is
    // asserted directly now, which is stronger than asserting the throw: a rejection and a null both
    // prove "no partial content", but only null proves the batch survives. Rejecting the batch was the
    // mechanism that turned one lost chunk into a dead /listen page, because listen.ts awaits this call
    // bare and Promise.all let a single hydration failure take every other article down with it.
    const batch = await store.getArticles("u-corrupt", ["art-corrupt-test"]);
    assertEquals(batch.length, 1);
    assertEquals(batch[0], null, "a damaged article must be null, never truncated content");
  } finally {
    await kv.close();
  }
});

Deno.test("KvMetadataStore: multi-batch atomic write rollback, retry, and base-atomic rollback (audio-feed-cei)", async () => {
  const kv = await Deno.openKv(":memory:");
  let commitCount = 0;
  let failCommitOn = 2; // fail the 2nd atomic commit
  const wrappedKv = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "atomic") {
        return () => {
          const tx = target.atomic();
          const origCommit = tx.commit.bind(tx);
          tx.commit = async () => {
            commitCount++;
            if (commitCount === failCommitOn) {
              return { ok: false };
            }
            return await origCommit();
          };
          return tx;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function"
        ? (val as (...args: unknown[]) => unknown).bind(target)
        : val;
    },
  });

  const store = new KvMetadataStore(wrappedKv as unknown as Deno.Kv, { ownsConnection: false });

  try {
    // 22-chunk article: batches 10 / 10 / 2
    const content = "A".repeat(22 * ARTICLE_CHUNK_SIZE);
    const article = makeArticle({
      id: "art-inject-22",
      userId: "u-inject",
      url: "https://example.com/inject-22",
      content,
    });

    // 1. Fault injection: batch 1 commits (chunks 0-9), batch 2 fails -> throws
    commitCount = 0;
    failCommitOn = 2;
    const err = await assertRejects(
      () => store.putArticle(article),
      Error,
    );
    assertStringIncludes(err.message, "Failed to commit article chunks for art-inject-22");

    // Assert: chunk keys afterwards === 0 (batch 1's ten keys cleaned up)
    const chunksAfterFail = await Array.fromAsync(
      kv.list({ prefix: ["article_chunk", "u-inject", "art-inject-22"] }),
    );
    assertEquals(
      chunksAfterFail.length,
      0,
      "batch 1's committed chunks must be rolled back on batch 2 failure",
    );

    // Assert: base record absent
    const baseAfterFail = await kv.get(["article", "u-inject", "art-inject-22"]);
    assertEquals(baseAfterFail.value, null, "base record must be absent after failed chunk write");

    // 2. Trap 2: Retry after failure succeeds completely without leftover corruption
    failCommitOn = -1; // disable fault injection
    await store.putArticle(article);

    const retrieved = await store.getArticle("u-inject", "art-inject-22");
    assert(retrieved !== null);
    assertEquals(retrieved.content.length, 22 * ARTICLE_CHUNK_SIZE);
    assertEquals(retrieved.content, content);
    assertEquals(retrieved.chunkCount, 22);

    // Trap 1: Normal 22-chunk write keeps all 22 chunks in KV
    const chunksAfterSuccess = await Array.fromAsync(
      kv.list({ prefix: ["article_chunk", "u-inject", "art-inject-22"] }),
    );
    assertEquals(
      chunksAfterSuccess.length,
      22,
      "successful 22-chunk write must keep all 22 chunks",
    );

    // 3. Trap 3: Base-atomic rollback path still works when chunk writes succeed but base commit fails
    // A 22-chunk article has 3 chunk batches (commits 1, 2, 3) + 1 base commit (commit 4)
    commitCount = 0;
    failCommitOn = 4; // fail the 4th commit (the base article commit!)
    const article2 = makeArticle({
      id: "art-base-fail",
      userId: "u-inject",
      url: "https://example.com/base-fail",
      content,
    });
    const baseErr = await assertRejects(
      () => store.putArticle(article2),
      Error,
    );
    assertStringIncludes(baseErr.message, "putArticle failed for art-base-fail");

    // Assert: base atomic rollback cleaned up all 22 chunks
    const chunksAfterBaseFail = await Array.fromAsync(
      kv.list({ prefix: ["article_chunk", "u-inject", "art-base-fail"] }),
    );
    assertEquals(
      chunksAfterBaseFail.length,
      0,
      "base commit failure must roll back all written chunks",
    );
    const baseRecord2 = await kv.get(["article", "u-inject", "art-base-fail"]);
    assertEquals(baseRecord2.value, null);
  } finally {
    await kv.close();
  }
});

// ---------------------------------------------------------------------------
// atomicUpdate: the shared counter behind the rate limiters (audio-feed-2zvc)
// ---------------------------------------------------------------------------

Deno.test("atomicUpdate: concurrent read-modify-writes do not lose one (KV)", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });
  try {
    // Every writer reads the same value and tries to write it back +1. Without
    // the versionstamp check most of them would overwrite each other and the
    // final count would be far below the number of attempts — which is exactly
    // how a per-isolate counter under-counts a distributed guesser.
    const writers = Array.from(
      { length: 20 },
      () => store.atomicUpdate<number>("counter", (current) => (current ?? 0) + 1),
    );
    const results = await Promise.all(writers);
    assertEquals(results.filter((value) => value !== null).length, 20);
    assertEquals(await store.atomicUpdate<number>("counter", () => null), 20);
  } finally {
    await store.close();
  }
});

Deno.test("atomicUpdate: two stores over one KV share the row (audio-feed-2zvc)", async () => {
  const kv = await Deno.openKv(":memory:");
  const a = new KvMetadataStore(kv, { ownsConnection: false });
  const b = new KvMetadataStore(kv, { ownsConnection: false });
  try {
    await a.atomicUpdate<number[]>("window", (current) => [...(current ?? []), 1]);
    await b.atomicUpdate<number[]>("window", (current) => [...(current ?? []), 2]);
    // Two adapter objects, separate in-process state, one row: the substrate the
    // limiters share when Deno Deploy runs more than one isolate.
    assertEquals(await a.atomicUpdate<number[]>("window", () => null), [1, 2]);
  } finally {
    kv.close();
  }
});

Deno.test("atomicUpdate: a null mutation leaves the row untouched", async () => {
  const store = new MemoryMetadataStore();
  assertEquals(await store.atomicUpdate<number>("k", () => 7), 7);
  assertEquals(await store.atomicUpdate<number>("k", () => null), 7, "a peek must not write");
});

Deno.test("atomicUpdate: the memory adapter shows the same contract", async () => {
  const store = new MemoryMetadataStore();
  // Single-threaded, so this pins the observable contract rather than racing:
  // both adapters must behave the same for the policy above them.
  assertEquals(await store.atomicUpdate<number>("n", (current) => (current ?? 0) + 1), 1);
  assertEquals(await store.atomicUpdate<number>("n", (current) => (current ?? 0) + 1), 2);
  assertEquals(await store.atomicUpdate<number>("n", () => null), 2);
});
