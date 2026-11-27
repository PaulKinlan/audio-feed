// audio-feed-64wu: #splitArticleForStorage spun forever when content exceeded ARTICLE_CHUNK_SIZE and the
// final code unit was an unpaired high surrogate — the surrogate step-back drove sliceLength to 0, so an
// empty chunk was pushed and startIndex never advanced.
//
// These tests do not need to detect a hang, and that is deliberate. The fix adds a progress invariant
// that throws if a chunk consumes nothing, so any regression here is a loud error rather than a core
// pinned forever inside `deno task gate` (the gate has no --allow-run, so a subprocess-with-timeout test
// was not an option, and a test that hangs the suite is worse than one that fails).
import { assertEquals } from "@std/assert";
import { D1_ARTICLE_CHUNK_BYTES as ARTICLE_CHUNK_SIZE, D1MetadataStore } from "../src/storage/d1.ts";
import { createTestD1 } from "./sqlite_d1.ts";
import type { Article } from "../src/types.ts";

async function roundTripArticle(content: string, id: string): Promise<Article | null> {
  const d1 = createTestD1();
  const store = new D1MetadataStore(d1);
  const article: Article = {
    id,
    userId: "u1",
    sourceId: "s1",
    url: `https://example.com/${id}`,
    title: "T",
    content,
    ingestedAt: new Date().toISOString(),
  };
  try {
    await store.putArticle(article);
    return await store.getArticle("u1", id);
  } finally {
    d1.close();
  }
}

async function roundTrip(content: string, id: string): Promise<string | null> {
  return (await roundTripArticle(content, id))?.content ?? null;
}

const OVER = ARTICLE_CHUNK_SIZE + 1;

Deno.test("article ending in an unpaired high surrogate round-trips instead of stalling", async () => {
  const content = "x".repeat(OVER) + "\ud800";
  const back = await roundTrip(content, "lone-high");
  // SQLite TEXT stores valid UTF-8, normalizing unpaired surrogates to U+FFFD;
  // verify length and prefix integrity without stalling.
  assertEquals(
    back,
    "x".repeat(OVER) + "\ufffd",
    "content ending in a lone high surrogate must complete cleanly with UTF-8 normalization",
  );
});

Deno.test("article ending in an unpaired low surrogate round-trips", async () => {
  const content = "y".repeat(OVER) + "\udc00";
  assertEquals(await roundTrip(content, "lone-low"), "y".repeat(OVER) + "\ufffd");
});

Deno.test("surrogate pair straddling the chunk boundary still round-trips", async () => {
  const content = "x".repeat(ARTICLE_CHUNK_SIZE - 1) + "\u{1F600}".repeat(50);
  assertEquals(await roundTrip(content, "straddle"), content);
});

Deno.test("pure astral content round-trips", async () => {
  const content = "\u{1F600}".repeat(30_000);
  assertEquals(await roundTrip(content, "emoji-only"), content);
});

Deno.test("chunking completes promptly rather than spinning when a chunk cannot advance", async () => {
  const content = "z".repeat(OVER) + "\ud800";
  const back = await roundTripArticle(content, "invariant");
  assertEquals(back?.content, "z".repeat(OVER) + "\ufffd");
  assertEquals(
    back?.chunkCount,
    3,
    "one chunk per consumed region: 48,000 code units, then 'z', then the lone surrogate",
  );
});
