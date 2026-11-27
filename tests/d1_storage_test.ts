/**
 * Runs the shared MetadataStore conformance suite + D1-specific storage tests
 * against `D1MetadataStore` backed by real in-memory SQLite (`node:sqlite`).
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { runMetadataConformance } from "./conformance/metadata.ts";
import { D1_ARTICLE_CHUNK_BYTES, D1MetadataStore } from "../src/storage/d1.ts";
import { createTestD1 } from "./sqlite_d1.ts";
import { makeArticle } from "./fixtures.ts";

runMetadataConformance({
  name: "D1MetadataStore",
  create: () => {
    const d1 = createTestD1();
    const store = new D1MetadataStore(d1);
    const origClose = store.close.bind(store);
    store.close = async () => {
      await origClose();
      d1.close();
    };
    return store;
  },
});

Deno.test("D1MetadataStore: chunks and reconstitutes 2,000,000 character article cleanly", async () => {
  const d1 = createTestD1();
  const store = new D1MetadataStore(d1);
  try {
    const huge = "X".repeat(2_000_000);
    const article = makeArticle({
      id: "art-d1-2m",
      userId: "u-d1",
      url: "https://example.com/d1-2m",
      content: huge,
    });
    await store.putArticle(article);

    const chunkRows = await d1.prepare(
      `SELECT COUNT(*) AS cnt FROM article_chunks WHERE user_id = ? AND article_id = ?`,
    ).bind("u-d1", "art-d1-2m").first<{ cnt: number }>();
    assertEquals(chunkRows?.cnt, Math.ceil(2_000_000 / D1_ARTICLE_CHUNK_BYTES));

    const got = await store.getArticle("u-d1", "art-d1-2m");
    assert(got !== null);
    assertEquals(got.content.length, 2_000_000);
    assertEquals(got.content, huge);

    await store.deleteArticle("u-d1", "art-d1-2m");
    const afterChunks = await d1.prepare(
      `SELECT COUNT(*) AS cnt FROM article_chunks WHERE user_id = ? AND article_id = ?`,
    ).bind("u-d1", "art-d1-2m").first<{ cnt: number }>();
    assertEquals(afterChunks?.cnt, 0);
  } finally {
    d1.close();
  }
});

Deno.test("D1MetadataStore: missing chunk throws CorruptArticleError on getArticle and degrades to null in getArticles", async () => {
  const d1 = createTestD1();
  const store = new D1MetadataStore(d1);
  try {
    const content = "A".repeat(900_000);
    await store.putArticle(
      makeArticle({
        id: "art-d1-corrupt",
        userId: "u1",
        url: "https://example.com/d1-corrupt",
        content,
      }),
    );

    await d1.prepare(
      `DELETE FROM article_chunks WHERE user_id = ? AND article_id = ? AND chunk_index = 1`,
    ).bind("u1", "art-d1-corrupt").run();

    const err = await assertRejects(
      () => store.getArticle("u1", "art-d1-corrupt"),
      Error,
    );
    const expectedChunks = Math.ceil(content.length / D1_ARTICLE_CHUNK_BYTES);
    assertStringIncludes(err.message, "Corrupted article storage for art-d1-corrupt");
    assertStringIncludes(err.message, `expected ${expectedChunks} chunks`);
    assertStringIncludes(err.message, `found ${expectedChunks - 1}`);

    const batch = await store.getArticles("u1", ["art-d1-corrupt"]);
    assertEquals(batch, [null]);
  } finally {
    d1.close();
  }
});

Deno.test("D1MetadataStore: atomicUpdate handles concurrent increments and shared DB instances", async () => {
  const d1 = createTestD1();
  const a = new D1MetadataStore(d1);
  const b = new D1MetadataStore(d1);
  try {
    const writers = Array.from(
      { length: 20 },
      (_, i) => (i % 2 === 0 ? a : b).atomicUpdate<number>("counter", (cur) => (cur ?? 0) + 1),
    );
    const results = await Promise.all(writers);
    assertEquals(results.filter((r) => r.committed).length, 20);
    assertEquals((await a.atomicUpdate<number>("counter", () => null)).value, 20);
  } finally {
    d1.close();
  }
});
