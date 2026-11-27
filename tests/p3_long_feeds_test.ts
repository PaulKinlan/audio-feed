/**
 * P3 Long RSS Feed Reliability & Performance tests:
 * - Batched `findExistingArticleUrls` on D1MetadataStore (>50 URL chunking) and MemoryMetadataStore
 * - Head-first scanning prevents starving brand-new index-0 posts when `feedScanOffset > 0`
 * - Conditional GET (`ETag` / `Last-Modified` -> `304 Not Modified`) fast-path
 * - Raised feed fetch timeout (30s) & size cap (5 MiB)
 */

import { assert, assertEquals } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import {
  HEAD_SCAN_WINDOW,
  MAX_FEED_ITEMS_EXAMINED,
  pollFeedSource,
} from "../src/ingest/feed.ts";
import { FEED_TIMEOUT_MS, MAX_FEED_BYTES } from "../src/ingest/url.ts";
import { createTestD1 } from "./sqlite_d1.ts";
import { makeArticle, makeSource, makeUser } from "./fixtures.ts";

const BASE = "https://blog.example.com";

function rssForUrls(items: Array<{ title: string; url: string }>): string {
  const xmlItems = items.map((it) =>
    `<item><title>${it.title}</title><link>${it.url}</link></item>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Long Blog</title>${xmlItems}</channel></rss>`;
}

Deno.test("P3: findExistingArticleUrls batches >50 URLs cleanly on both D1MetadataStore and MemoryMetadataStore", async () => {
  const d1 = createTestD1();
  const d1Store = new D1MetadataStore(d1);
  const memStore = memoryStores().metadata;

  try {
    for (const store of [d1Store, memStore]) {
      await store.putUser(makeUser({ id: "u1", status: "approved" }));
      await store.putSource(makeSource({ id: "s1", userId: "u1" }));

      // Insert 75 articles (even indices 0..148)
      for (let i = 0; i < 150; i += 2) {
        await store.putArticle(
          makeArticle({
            id: `art-${i}`,
            userId: "u1",
            sourceId: "s1",
            url: `${BASE}/post-${i}`,
          }),
        );
      }

      // Query 125 URLs in a single call (> 100 D1 bind-param limit; forces chunking at 50)
      const queryUrls = Array.from({ length: 125 }, (_, i) => `${BASE}/post-${i}`);
      const existing = await store.findExistingArticleUrls("u1", queryUrls);

      assertEquals(existing.size, 63, "even indices 0,2,...,124 = 63 existing URLs");
      assert(existing.has(`${BASE}/post-0`));
      assert(existing.has(`${BASE}/post-124`));
      assert(!existing.has(`${BASE}/post-1`));
      assert(!existing.has(`${BASE}/post-123`));

      // Empty query returns empty set
      assertEquals((await store.findExistingArticleUrls("u1", [])).size, 0);
      // Other user sees none of u1's URLs
      assertEquals((await store.findExistingArticleUrls("u2", queryUrls)).size, 0);
    }
  } finally {
    d1.close();
  }
});

Deno.test("P3: head-first scanning picks up new index-0 posts even when feedScanOffset > 0", async () => {
  const stores = memoryStores();
  const user = makeUser({ id: "u1", status: "approved", dailyEpisodeBudget: 50 });
  const source = makeSource({
    id: "long-feed",
    userId: user.id,
    feedUrl: `${BASE}/feed.xml`,
    feedScanOffset: MAX_FEED_ITEMS_EXAMINED, // mid-backfill at index 100!
  });
  await stores.metadata.putUser(user);
  await stores.metadata.putSource(source);

  // Mark items 1..100 as already seen, but item 0 is brand new AND items 101..104 are unseen backfill!
  for (let i = 1; i <= MAX_FEED_ITEMS_EXAMINED; i++) {
    await stores.metadata.putArticle(
      makeArticle({
        id: `seen-${i}`,
        userId: user.id,
        sourceId: source.id,
        url: `${BASE}/old-${i}`,
      }),
    );
  }

  const feedItems = [
    { title: "Brand New Breaking Post", url: `${BASE}/breaking-new-post` },
    ...Array.from({ length: MAX_FEED_ITEMS_EXAMINED }, (_, i) => ({
      title: `Old ${i + 1}`,
      url: `${BASE}/old-${i + 1}`,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      title: `Backfill ${i}`,
      url: `${BASE}/backfill-${i}`,
    })),
  ];

  const fetchedUrls: string[] = [];
  const ctx = {
    config: { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "secret" },
    stores,
  };
  const poll = await pollFeedSource(ctx, source, {
    transport: () =>
      Promise.resolve(
        new Response(rssForUrls(feedItems), {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        }),
      ),
    fetchArticle: (url) => {
      fetchedUrls.push(url);
      return Promise.resolve({
        url,
        title: url,
        author: null,
        publishedAt: null,
        lead: "Lead",
        body: "Substantive article body text for testing.",
      });
    },
  });

  assert(HEAD_SCAN_WINDOW >= 25);
  assert(
    fetchedUrls.includes(`${BASE}/breaking-new-post`),
    "brand-new post at index 0 must NEVER be starved behind feedScanOffset",
  );
  assert(
    fetchedUrls.includes(`${BASE}/backfill-0`),
    "backfill items past feedScanOffset should still progress in the same poll",
  );
  assertEquals(poll.queued, 4, "1 new head item + 3 backfill items queued");
});

Deno.test("P3: ETag & Last-Modified conditional GET uses 304 Not Modified fast-path with zero work", async () => {
  const stores = memoryStores();
  const user = makeUser({ id: "u1", status: "approved", dailyEpisodeBudget: 50 });
  const source = makeSource({
    id: "etag-feed",
    userId: user.id,
    feedUrl: `${BASE}/etag.xml`,
  });
  await stores.metadata.putUser(user);
  await stores.metadata.putSource(source);

  const seenHeaders: Array<Record<string, string> | undefined> = [];
  let responseCount = 0;
  const transport = (
    _url: URL,
    _signal: AbortSignal,
    init?: { headers?: Record<string, string> },
  ) => {
    seenHeaders.push(init?.headers);
    responseCount++;
    if (responseCount === 1) {
      return Promise.resolve(
        new Response(rssForUrls([{ title: "Post 1", url: `${BASE}/p1` }]), {
          status: 200,
          headers: {
            "content-type": "application/rss+xml",
            "etag": '"etag-v1"',
            "last-modified": "Thu, 26 Nov 2026 12:00:00 GMT",
          },
        }),
      );
    }
    if (init?.headers?.["If-None-Match"] === '"etag-v1"') {
      return Promise.resolve(
        new Response(null, {
          status: 304,
          headers: { "etag": '"etag-v1"' },
        }),
      );
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  };

  let articleFetchCalls = 0;
  const ctx = {
    config: { port: 8000, publicBaseUrl: "https://audio.example.com", adminToken: "secret" },
    stores,
  };

  // Poll 1: HTTP 200 -> queues item and persists ETag + Last-Modified on Source
  const p1 = await pollFeedSource(ctx, source, {
    transport,
    fetchArticle: (url) => {
      articleFetchCalls++;
      return Promise.resolve({
        url,
        title: "Post 1",
        author: null,
        publishedAt: null,
        lead: "Lead",
        body: "Body text.",
      });
    },
  });
  assertEquals(p1.queued, 1);
  assertEquals(p1.notModified, undefined);
  const updatedSource = await stores.metadata.getSource(user.id, source.id);
  assertEquals(updatedSource?.etag, '"etag-v1"');
  assertEquals(updatedSource?.lastModified, "Thu, 26 Nov 2026 12:00:00 GMT");

  // Poll 2: sends If-None-Match + If-Modified-Since -> 304 Not Modified fast-path!
  const p2 = await pollFeedSource(ctx, updatedSource!, {
    transport,
    fetchArticle: () => {
      articleFetchCalls++;
      throw new Error("should never fetch articles on 304 Not Modified");
    },
  });
  assertEquals(p2.notModified, true);
  assertEquals(p2.queued, 0);
  assertEquals(p2.failed, 0);
  assertEquals(articleFetchCalls, 1);
  assertEquals(seenHeaders[1]?.["If-None-Match"], '"etag-v1"');
  assertEquals(seenHeaders[1]?.["If-Modified-Since"], "Thu, 26 Nov 2026 12:00:00 GMT");
});

Deno.test("P3: feed fetch limits raised to 30s timeout and 5 MiB XML cap", () => {
  assertEquals(FEED_TIMEOUT_MS, 30_000);
  assertEquals(MAX_FEED_BYTES, 5 * 1024 * 1024);
});
