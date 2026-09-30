// audio-feed-jnor: one damaged article must cost the user one row, not the whole player.
//
// #hydrateArticle refuses to join a partial article (audio-feed-cei) and that refusal is correct —
// handing truncated text to a TTS queue would put a silently-cut article in someone's feed. The bug is
// that the refusal escaped: getArticles hydrates through Promise.all, so a single rejected hydration
// rejected the whole batch, and listen.ts awaits it bare — one corrupt chunk 500s /listen/:token.
//
// The fix is deliberately asymmetric, and these tests pin both halves of that asymmetry:
//   getArticles  -> null for the damaged index (its contract is already (Article | null)[])
//   getArticle   -> still throws, because synthesis must fail closed
// A fix that made both tolerant would be worse than the bug: it would let partial content reach TTS.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { isCorruptArticleError, KvMetadataStore } from "../src/storage/kv.ts";
import { MemoryBlobStore } from "../src/storage/memory.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { CorruptArticleError } from "../src/storage/kv.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

const BASE = "https://audio.example.com";
const TOKEN = "token-user-1";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

/** 120k chars is > 2 x ARTICLE_CHUNK_SIZE (48k), so this really does split into chunks. */
const LONG_BODY = "x".repeat(120_000);

async function seededWithCorruption() {
  // A real KV store, because chunking only exists in the KV backend — memoryStores() would silently
  // test nothing, since it never splits an article and so never has a chunk to lose.
  const kv = await Deno.openKv(":memory:");
  const metadata = new KvMetadataStore(kv, { ownsConnection: false });
  const stores: Stores = { metadata, blobs: new MemoryBlobStore(), describe: "test=kv" };

  await stores.metadata.putUser(
    makeUser({ id: "user-1", displayName: "Paul", status: "approved", feedToken: TOKEN }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "stratechery", userId: "user-1", title: "Stratechery" }),
  );
  await stores.metadata.putArticle(
    makeArticle({
      id: "art-healthy",
      userId: "user-1",
      sourceId: "stratechery",
      content: LONG_BODY,
    }),
  );
  await stores.metadata.putArticle(
    makeArticle({
      id: "art-damaged",
      userId: "user-1",
      sourceId: "stratechery",
      content: LONG_BODY,
    }),
  );
  for (
    const [episodeId, articleId, title] of [
      ["ep-healthy", "art-healthy", "The Healthy Episode"],
      ["ep-damaged", "art-damaged", "The Damaged Episode"],
    ] as const
  ) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: episodeId,
        userId: "user-1",
        sourceId: "stratechery",
        articleId,
        status: "ready",
        title,
        audioKey: `${episodeId}.wav`,
        byteLength: 1024,
        durationSeconds: 1875,
        contentType: "audio/wav",
        mode: "direct",
      }),
    );
  }

  // Damage it the way reality does: the base article still claims its chunkCount, one chunk is gone.
  const before = await kv.get<number>(["article_chunk", "user-1", "art-damaged", 1]);
  assert(before.value !== null, "precondition: the damaged article must actually be chunked");
  await kv.delete(["article_chunk", "user-1", "art-damaged", 1]);

  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores, kv };
}

Deno.test("getArticles yields null for a damaged article instead of rejecting the batch", async () => {
  const { stores, kv } = await seededWithCorruption();
  try {
    const rows = await stores.metadata.getArticles("user-1", ["art-healthy", "art-damaged"]);
    assertEquals(rows.length, 2, "one row per requested id, damaged or not");
    assert(rows[0] !== null, "the healthy article must still come back");
    assertEquals(rows[0]?.content, LONG_BODY, "and it must be fully hydrated");
    assertEquals(rows[1], null, "the damaged article must be null, not a rejection");
  } finally {
    kv.close();
  }
});

Deno.test("getArticle still refuses: synthesis must never receive partial content", async () => {
  const { stores, kv } = await seededWithCorruption();
  try {
    let threw = false;
    try {
      await stores.metadata.getArticle("user-1", "art-damaged");
    } catch {
      threw = true;
    }
    assert(
      threw,
      "the single-article read must keep failing closed — degrading it here is how truncated articles reach TTS",
    );
  } finally {
    kv.close();
  }
});

Deno.test("/listen/:token serves with healthy episodes when one article is damaged", async () => {
  const { fetch, kv } = await seededWithCorruption();
  try {
    const res = await fetch(new Request(`${BASE}/listen/${TOKEN}`));
    assertEquals(res.status, 200, "one damaged article must not take the whole player down");
    const html = await res.text();
    assertStringIncludes(html, "The Healthy Episode", "healthy episodes must still render");
    // Measured, not assumed: the damaged row SURVIVES, because an episode carries its own title and
    // audioKey — only article-derived metadata (author, source link) is lost when its lookup yields
    // null. So the degradation is one row's detail, not a missing episode and not a dead page. Assert
    // that shape explicitly; if a later change drops the row instead, this test says so out loud
    // rather than quietly passing on either behaviour.
    assertStringIncludes(
      html,
      "The Damaged Episode",
      "the damaged episode keeps its row (title/audio live on the episode)",
    );
    assertStringIncludes(
      html,
      "2 episodes",
      "the episode count must not silently drop the damaged one",
    );
  } finally {
    kv.close();
  }
});

Deno.test("the degrade discriminator accepts only a corrupt article", () => {
  // The catch must be by error identity, not a blanket try/catch: if a KV read fails for another reason
  // (quota, timeout, a bug in hydration), swallowing it would hide a real outage behind a missing row.
  // This is asserted on the exported guard because nothing else in the suite can reach that branch —
  // #hydrateArticle has exactly one throw site, so a behavioural test cannot produce a foreign error
  // there without reimplementing the private method.
  assertEquals(
    isCorruptArticleError(new Error("Corrupted article storage for x: expected 3, found 2")),
    false,
    "a same-worded plain Error must NOT be treated as degradable",
  );
  assertEquals(isCorruptArticleError(new TypeError("kv unavailable")), false);
  assertEquals(isCorruptArticleError(undefined), false);
  assertEquals(
    isCorruptArticleError({ name: "CorruptArticleError" }),
    false,
    "duck-typing is not enough",
  );
  assertEquals(isCorruptArticleError(new CorruptArticleError("art-1", 3, 2)), true);
});

Deno.test("healthy and genuinely-absent articles are unchanged by the new handling", async () => {
  const { stores, kv } = await seededWithCorruption();
  try {
    const healthy = await stores.metadata.getArticles("user-1", ["art-healthy"]);
    assertEquals(healthy.length, 1);
    assert(healthy[0] !== null, "undamaged articles are unaffected by the new handling");
    // A missing id is still null for the pre-existing reason, not the new one.
    assertEquals((await stores.metadata.getArticles("user-1", ["no-such-article"]))[0], null);
  } finally {
    kv.close();
  }
});
