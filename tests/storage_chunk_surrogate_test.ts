// audio-feed-64wu: #splitArticleForStorage spun forever when content exceeded ARTICLE_CHUNK_SIZE and the
// final code unit was an unpaired high surrogate — the surrogate step-back drove sliceLength to 0, so an
// empty chunk was pushed and startIndex never advanced.
//
// These tests do not need to detect a hang, and that is deliberate. The fix adds a progress invariant
// that throws if a chunk consumes nothing, so any regression here is a loud error rather than a core
// pinned forever inside `deno task gate` (the gate has no --allow-run, so a subprocess-with-timeout test
// was not an option, and a test that hangs the suite is worse than one that fails).
import { assertEquals } from "@std/assert";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { ARTICLE_CHUNK_SIZE } from "../src/storage/kv.ts";
import type { Article } from "../src/types.ts";

async function roundTripArticle(content: string, id: string): Promise<Article | null> {
  const kv = await Deno.openKv(":memory:");
  const store = new KvMetadataStore(kv, { ownsConnection: true });
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
    kv.close();
  }
}

async function roundTrip(content: string, id: string): Promise<string | null> {
  return (await roundTripArticle(content, id))?.content ?? null;
}

const OVER = ARTICLE_CHUNK_SIZE + 1;

Deno.test("article ending in an unpaired high surrogate round-trips instead of stalling", async () => {
  const content = "x".repeat(OVER) + "\ud800";
  const back = await roundTrip(content, "lone-high");
  // Exact equality, not "did not throw": the degenerate chunk must still reassemble byte-for-byte.
  assertEquals(
    back,
    content,
    "content ending in a lone high surrogate must round-trip identically",
  );
});

Deno.test("article ending in an unpaired low surrogate round-trips", async () => {
  // The mirror case: a trailing low surrogate is not caught by the high-surrogate test.
  const content = "y".repeat(OVER) + "\udc00";
  assertEquals(await roundTrip(content, "lone-low"), content);
});

Deno.test("surrogate pair straddling the chunk boundary still round-trips", async () => {
  // This passed before the fix; it is the guard's actual purpose, so the fix must not break it.
  const content = "x".repeat(ARTICLE_CHUNK_SIZE - 1) + "\u{1F600}".repeat(50);
  assertEquals(await roundTrip(content, "straddle"), content);
});

Deno.test("pure astral content round-trips", async () => {
  const content = "\u{1F600}".repeat(30_000);
  assertEquals(await roundTrip(content, "emoji-only"), content);
});

Deno.test("chunking completes promptly rather than spinning when a chunk cannot advance", async () => {
  // Prove the safety net itself works: a lone surrogate as the very last code unit, with the body sized
  // so the final slice is exactly one code unit. Before the fix this shape never returned.
  const content = "z".repeat(OVER) + "\ud800";
  // docs/speed.md census row 8: this row asserted `Date.now() - started < 10_000`, a real-clock
  // promptness ceiling on purely in-memory chunking - a timing outcome the host decides, not the
  // product. "Does not spin" is a STRUCTURE fact here: the chunker's progress invariant throws rather
  // than looping when a chunk consumes nothing (see the file header), and progress that does happen
  // yields exactly one chunk per consumed region. Both are asserted below with no clock at all, so a
  // spin reds as a thrown stall error or a wrong chunk count on any host, loaded or not.
  const back = await roundTripArticle(content, "invariant");
  assertEquals(back?.content, content);
  assertEquals(
    back?.chunkCount,
    3,
    "one chunk per consumed region: 48,000 code units, then 'z', then the lone surrogate",
  );
});
