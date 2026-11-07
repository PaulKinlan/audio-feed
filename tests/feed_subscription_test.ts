/**
 * RSS/Atom subscription tests (audio-feed-2e5).
 *
 * The feature's promise is "paste a feed URL and its posts become audio", so the
 * tests are arranged along that sentence: parse the feed, queue only what is new,
 * refuse the wrong callers, and finally subscribe and play what the feed serves.
 *
 * No network anywhere: the feed document and the article bodies are both injected.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import {
  MAX_FEED_ITEMS_EXAMINED,
  parseFeedItems,
  pollFeedSource,
  runFeedPollBatch,
  sourceIdForFeed,
} from "../src/ingest/feed.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { ingestCreationLimiter } from "../src/compose/ingest.ts";
import type { MetadataStore } from "../src/storage/mod.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { DecodedAudioResult, GeminiGenerateContentRequest } from "../src/tts/gemini.ts";
import { GeminiTtsClient, uint8ArrayToBase64 } from "../src/tts/gemini.ts";
import type { Article, Episode, Source } from "../src/types.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Stratechery</title>
  <item>
    <title>Aggregation &amp; AI</title>
    <link>https://stratechery.com/2026/aggregation</link>
    <pubDate>Mon, 01 Sep 2026 06:00:00 +0000</pubDate>
    <description><![CDATA[<p>The lead paragraph.</p>]]></description>
  </item>
  <item>
    <title>Second post</title>
    <link>https://stratechery.com/2026/second</link>
    <pubDate>Tue, 02 Sep 2026 06:00:00 +0000</pubDate>
    <description>Another lead.</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom Post</title>
    <link rel="self" href="https://example.com/feed"/>
    <link rel="alternate" href="/posts/1"/>
    <updated>2026-09-03T09:00:00Z</updated>
    <summary>Atom summary</summary>
  </entry>
</feed>`;

/** A transport serving one feed document, so no test touches the network. */
const feedTransport =
  (xml: string, contentType = "application/rss+xml") => (_url: URL, _signal: AbortSignal) =>
    Promise.resolve(
      new Response(xml, {
        status: 200,
        headers: { "content-type": `${contentType}; charset=utf-8` },
      }),
    );

const article = (title: string, body: string) => () =>
  Promise.resolve({
    url: "https://example.com/x",
    title,
    author: "A. Writer",
    publishedAt: null,
    lead: "A lead.",
    body,
  });

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

Deno.test("RSS items parse with decoded entities, CDATA and RFC 822 dates", () => {
  const items = parseFeedItems(RSS, "https://stratechery.com/feed/");
  assertEquals(items.length, 2);
  assertEquals(items[0]!.title, "Aggregation & AI");
  assertEquals(items[0]!.link, "https://stratechery.com/2026/aggregation");
  assertEquals(items[0]!.publishedAt, "2026-09-01T06:00:00.000Z");
  assertStringIncludes(items[0]!.summary ?? "", "The lead paragraph");
});

Deno.test("Atom entries parse, preferring rel=alternate and resolving relative links", () => {
  const items = parseFeedItems(ATOM, "https://example.com/feed.xml");
  assertEquals(items.length, 1);
  assertEquals(items[0]!.title, "Atom Post");
  // The self link is the FEED, not the item; the relative alternate is resolved.
  assertEquals(items[0]!.link, "https://example.com/posts/1");
  assertEquals(items[0]!.publishedAt, "2026-09-03T09:00:00.000Z");
  assertEquals(items[0]!.summary, "Atom summary");
});

Deno.test("an item with no usable link is skipped rather than queued blind", () => {
  const xml =
    `<rss><channel><item><title>No link</title><description>x</description></item></channel></rss>`;
  assertEquals(parseFeedItems(xml, "https://e.com/feed").length, 0);
});

Deno.test("a guid that is a URL is used when there is no link", () => {
  const xml =
    `<rss><channel><item><title>Guid only</title><guid>https://e.com/g/1</guid></item></channel></rss>`;
  assertEquals(parseFeedItems(xml, "https://e.com/feed")[0]!.link, "https://e.com/g/1");
});

Deno.test("malformed XML yields no items instead of throwing", () => {
  assertEquals(parseFeedItems("not xml at all", "https://e.com/feed"), []);
});

Deno.test("source ids are readable, unique per user, and stable", () => {
  assertEquals(sourceIdForFeed("https://stratechery.com/feed/", new Set()), "stratechery");
  assertEquals(sourceIdForFeed("https://www.example.co.uk/feed", new Set()), "example");
  assertEquals(
    sourceIdForFeed("https://stratechery.com/feed/", new Set(["stratechery"])),
    "stratechery-2",
  );
  assertEquals(sourceIdForFeed("not a url", new Set()), "feed");
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function subscriberSource(feedUrl = "https://stratechery.com/feed/") {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );
  const source: Source = makeSource({ id: "stratechery", userId: "user-1", feedUrl });
  await stores.metadata.putSource(source);
  return { stores, ctx: { config, stores }, source };
}

/** One subscriber and ten distinct, retained feed items; the SAME limiter also serves ingest/upload. */
async function deferralFixture(budget: number) {
  const stores = memoryStores();
  const user = makeUser({ id: "deferral-user", dailyEpisodeBudget: budget });
  await stores.metadata.putUser(user);
  const source = makeSource({ id: "deferral-source", userId: user.id, feedUrl: `${BASE}/feed` });
  await stores.metadata.putSource(source);
  const ctx = { config, stores };
  const xml = `<rss><channel>${
    Array.from({ length: 10 }, (_, i) =>
      `<item><title>Post ${i}</title><link>${BASE}/post-${i}</link></item>`).join("")
  }</channel></rss>`;
  const deps = { transport: feedTransport(xml), fetchArticle: article("Post", "Body") };
  const limiter = ingestCreationLimiter(ctx, user);
  const episodes = () => stores.metadata.listEpisodes({ userId: user.id });
  return { stores, user, source, ctx, deps, limiter, episodes };
}

Deno.test("audio-feed-ukuka: exhausted allowance defers without seeing items; later allowance queues them", async () => {
  const { stores, user, source, ctx, deps, limiter, episodes } = await deferralFixture(10);
  for (let n = 0; n < 10; n++) assert((await limiter.check(user.id)).allowed);
  const first = await pollFeedSource(ctx, source, deps);
  assertEquals(first.queued, 0);
  assertEquals(first.deferred, 10);
  assertEquals(first.skipped, 0, "deferred does not mean already seen");
  assertEquals((await episodes()).length, 0);
  assertEquals(await stores.metadata.findArticleByUrl(user.id, `${BASE}/post-0`), null);
  const logs = await stores.metadata.listLogs({ limit: 20 });
  assert(logs.some((log) =>
    log.type === "feed.poll.deferred" &&
    log.context?.sourceId === source.id && log.context?.remaining === 0
  ));
  await limiter.reset(user.id); // simulate the rolling window expiring before the next poll
  const second = await pollFeedSource(ctx, source, deps);
  assertEquals(second.queued, 10);
  assertEquals((await episodes()).length, 10);
});

Deno.test("audio-feed-ukuka: partial allowance queues exactly its remaining credits, then recovers remainder", async () => {
  const { user, source, ctx, deps, limiter, episodes } = await deferralFixture(10);
  for (let n = 0; n < 7; n++) assert((await limiter.check(user.id)).allowed);
  const first = await pollFeedSource(ctx, source, deps);
  assertEquals(first.queued, 3);
  assertEquals(first.deferred, 7);
  assertEquals((await episodes()).length, 3);
  assertEquals((await limiter.peek(user.id)).remaining, 0);
  await limiter.reset(user.id);
  const second = await pollFeedSource(ctx, source, deps);
  assertEquals(second.queued, 7);
  assertEquals(second.skipped, 3);
  assertEquals((await episodes()).length, 10);
});

Deno.test("audio-feed-ukuka: full allowance leaves the ten-per-poll behavior unchanged", async () => {
  const { user, source, ctx, deps, limiter, episodes } = await deferralFixture(10);
  const result = await pollFeedSource(ctx, source, deps);
  assertEquals(result.items, 10);
  assertEquals(result.queued, 10);
  assertEquals(result.deferred, 0);
  assertEquals((await episodes()).length, 10);
  assertEquals((await limiter.peek(user.id)).remaining, 0);
});

Deno.test("audio-feed-ukuka: deferral never consumes a creation credit", async () => {
  const { user, source, ctx, deps, limiter } = await deferralFixture(2);
  const before = (await limiter.peek(user.id)).remaining;
  const first = await pollFeedSource(ctx, source, deps);
  assertEquals(first.queued, 2);
  assertEquals(first.deferred, 8);
  assertEquals((await limiter.peek(user.id)).remaining, before - first.queued);
  const second = await pollFeedSource(ctx, source, deps);
  assertEquals(second.queued, 0);
  assertEquals(second.deferred, 8);
  assertEquals((await limiter.peek(user.id)).remaining, 0);
});

/**
 * The same fixture's store, with the article+episode CAS replaced — the one seam a feed
 * poll cannot reach any other way (audio-feed-ukuka).
 */
function withInsert(
  ctx: { config: AppConfig; stores: Stores },
  insert: MetadataStore["insertArticleWithEpisodeIfAbsent"],
) {
  const metadata = new Proxy(ctx.stores.metadata, {
    get(target, prop) {
      if (prop === "insertArticleWithEpisodeIfAbsent") return insert;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...ctx, stores: { ...ctx.stores, metadata } };
}

Deno.test("audio-feed-ukuka: an uncommitted article+episode pair refunds its creation credit", async () => {
  const { user, source, ctx, deps, limiter } = await deferralFixture(10);
  const before = (await limiter.peek(user.id)).remaining;
  assertEquals(before, 10);

  // Lost CAS: another poll committed the same URL first. The reserved credit must come
  // back, or a racing poll silently eats the subscriber's allowance (before this fix the
  // allowance dropped by one per skipped item).
  const lost = await pollFeedSource(withInsert(ctx, () => Promise.resolve(false)), source, deps);
  assertEquals(lost.queued, 0);
  assertEquals(lost.skipped, 10);
  assertEquals((await limiter.peek(user.id)).remaining, before);

  // Store throw: the poll still fails loudly, and the credit is still refunded.
  await assertRejects(
    () =>
      pollFeedSource(
        withInsert(ctx, () => Promise.reject(new Error("store unavailable"))),
        source,
        deps,
      ),
    Error,
    "store unavailable",
  );
  assertEquals((await limiter.peek(user.id)).remaining, before);

  // Rollback cannot free budget it never reserved: a timestamp with no matching entry
  // removes nothing, so `release` is not a way to exceed the bound.
  assertEquals(await limiter.release(user.id, 1), false);
  assertEquals((await limiter.peek(user.id)).remaining, before);
  // Releasing the same reservation twice is also a no-op.
  const one = await limiter.check(user.id);
  assertEquals(await limiter.release(user.id, one.recordedAt!), true);
  assertEquals(await limiter.release(user.id, one.recordedAt!), false);
  assertEquals((await limiter.peek(user.id)).remaining, before);
});

function longFeed(count: number) {
  return `<rss><channel>${
    Array.from({ length: count }, (_, i) =>
      `<item><title>Post ${i}</title><link>${BASE}/post-${i}</link></item>`).join("")
  }</channel></rss>`;
}

Deno.test("audio-feed-ukuka: ten already-seen URLs do not hide five new items beyond them", async () => {
  const { stores, user, source, ctx, episodes } = await deferralFixture(50);
  for (let i = 0; i < 10; i++) {
    await stores.metadata.putArticle(makeArticle({
      id: `seen-${i}`,
      userId: user.id,
      sourceId: source.id,
      url: `${BASE}/post-${i}`,
    }));
  }
  const poll = await pollFeedSource(ctx, source, {
    transport: feedTransport(longFeed(15)),
    fetchArticle: article("Post", "Body"),
  });
  assertEquals(poll.queued, 5, "pre-slicing at ten before dedup would strand all five");
  assertEquals(poll.skipped, 10);
  assertEquals((await episodes()).length, 5);
});

Deno.test("audio-feed-ukuka: a scan window stops at its bound, logs, and continues on the next poll", async () => {
  const { stores, user, source, ctx, episodes } = await deferralFixture(50);
  for (let i = 0; i < MAX_FEED_ITEMS_EXAMINED; i++) {
    await stores.metadata.putArticle(makeArticle({
      id: `seen-${i}`,
      userId: user.id,
      sourceId: source.id,
      url: `${BASE}/post-${i}`,
    }));
  }
  const deps = {
    transport: feedTransport(longFeed(MAX_FEED_ITEMS_EXAMINED + 5)),
    fetchArticle: article("Post", "Body"),
  };
  const first = await pollFeedSource(ctx, source, deps);
  assertEquals(first.queued, 0);
  assertEquals(first.skipped, MAX_FEED_ITEMS_EXAMINED);
  const logs = await stores.metadata.listLogs({ limit: 20 });
  assert(logs.some((log) =>
    log.type === "feed.poll.scan_exhausted" &&
    log.context?.sourceId === source.id &&
    log.context?.examined === MAX_FEED_ITEMS_EXAMINED &&
    log.context?.selected === 0 && log.context?.remainingUnknown === 5
  ));
  assertEquals(
    (await stores.metadata.getSource(user.id, source.id))?.feedScanOffset,
    MAX_FEED_ITEMS_EXAMINED,
  );
  const next = await pollFeedSource(ctx, source, deps);
  assertEquals(next.queued, 5);
  assertEquals((await episodes()).length, 5);
});

Deno.test("audio-feed-ukuka: fifty unseen items still queue at most ten per periodic poll", async () => {
  const { source, ctx, episodes } = await deferralFixture(50);
  const deps = { transport: feedTransport(longFeed(50)), fetchArticle: article("Post", "Body") };
  const first = await pollFeedSource(ctx, source, deps);
  assertEquals(first.items, 10);
  assertEquals(first.queued, 10);
  assertEquals((await episodes()).length, 10);
  const next = await pollFeedSource(ctx, source, deps);
  assertEquals(next.queued, 10);
  assertEquals((await episodes()).length, 20);
});

Deno.test("polling a feed queues one pending episode per new item", async () => {
  const { stores, ctx, source } = await subscriberSource();
  const result = await pollFeedSource(ctx, source, {
    transport: feedTransport(RSS),
    fetchArticle: article("Aggregation", "The full body text."),
  });

  assertEquals(result.items, 2);
  assertEquals(result.queued, 2);
  assertEquals(result.failed, 0);

  const episodes = await stores.metadata.listEpisodes({ userId: "user-1" });
  assertEquals(episodes.length, 2);
  // Queued, never synthesised here: the worker owns synthesis.
  assert(episodes.every((e) => e.status === "pending"));
  assert(episodes.every((e) => e.sourceId === "stratechery"));
  // The article is what the worker will narrate.
  const stored = await stores.metadata.getArticle("user-1", episodes[0]!.articleId);
  assertStringIncludes(stored?.content ?? "", "The full body text");
});

Deno.test("a re-poll queues nothing new (dedupe by article URL)", async () => {
  const { stores, ctx, source } = await subscriberSource();
  const deps = { transport: feedTransport(RSS), fetchArticle: article("A", "Body.") };
  await pollFeedSource(ctx, source, deps);
  const second = await pollFeedSource(ctx, source, {
    ...deps,
    // A different body, same URLs: the article already exists, so nothing queues.
    fetchArticle: article("Changed", "Different body."),
  });
  assertEquals(second.queued, 0);
  assertEquals(second.skipped, 2);
  assertEquals((await stores.metadata.listEpisodes({ userId: "user-1" })).length, 2);
});

Deno.test("a refused episode write leaves no article, so the next poll still makes audio (audio-feed-2th)", async () => {
  // The bug this test exists to keep dead: the article committed, the episode write
  // failed, and every later poll then skipped the URL. The item never became audio
  // and nothing reported it after the first poll. Now the pair is one commit, so a
  // refusal is invisible to the next poll and the retry succeeds.
  const { stores, source } = await subscriberSource();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>One</title>
      <item><title>Only post</title><link>https://stratechery.com/2026/only</link></item>
    </channel></rss>`;
  const deps = { transport: feedTransport(xml), fetchArticle: article("Only post", "Body.") };

  const inner = stores.metadata;
  let refuse = true;
  // The seam is "the write that would create this item's episode fails once". It
  // is deliberately attached to both spellings of that write: `putEpisode` on the
  // old two-step path, and the pair method on the new one, so the test discriminates
  // between them instead of only exercising the code that exists today.
  // Methods are bound to the real instance: a Proxy receiver would break the
  // store's private fields rather than the behaviour under test.
  const flaky = new Proxy(inner, {
    get(target, prop) {
      if (prop === "insertArticleWithEpisodeIfAbsent" || prop === "putEpisode") {
        const name = prop;
        // Both take the same arguments in practice; the tuple type is spelled
        // per method, so forward through a bound lookup on the real instance.
        return (args1: unknown, args2: unknown) => {
          if (refuse) {
            refuse = false;
            return Promise.reject(new Error("store unavailable"));
          }
          if (name === "putEpisode") {
            return target.putEpisode(args1 as Parameters<MetadataStore["putEpisode"]>[0]);
          }
          return target.insertArticleWithEpisodeIfAbsent(
            args1 as Article,
            args2 as Episode,
          );
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MetadataStore;

  const first = pollFeedSource(
    { config, stores: { ...stores, metadata: flaky } },
    source,
    deps,
  );
  // A refused queue write aborts the poll: `queueItems` runs outside the per-item
  // catch, which only guards article extraction. That is pre-existing behaviour on
  // main for both spellings of the write, and this asserts it rather than hiding it.
  await assertRejects(() => first, Error, "store unavailable");
  // No tombstone: neither half of the pair survived the refusal.
  assertEquals(
    await stores.metadata.findArticleByUrl("user-1", "https://stratechery.com/2026/only"),
    null,
  );
  assertEquals((await stores.metadata.listEpisodes({ userId: "user-1" })).length, 0);

  // The store has healed, and because nothing was recorded the poll treats the item
  // as new: this is the audio the subscriber would otherwise never have received.
  const second = await pollFeedSource({ config, stores }, source, deps);
  assertEquals(second.queued, 1);
  assertEquals(second.failed, 0);
  const episodes = await stores.metadata.listEpisodes({ userId: "user-1" });
  assertEquals(episodes.length, 1);
  assertEquals(episodes[0]!.status, "pending");
  assert(await stores.metadata.getArticle("user-1", episodes[0]!.articleId));
});

Deno.test("lastPolledAt advances even when the feed is unreachable", async () => {
  const { stores, ctx, source } = await subscriberSource();
  const result = await pollFeedSource(ctx, source, {
    transport: () => Promise.resolve(new Response("nope", { status: 500 })),
  });
  assertEquals(result.queued, 0);
  assert(result.errors.length > 0);
  // Otherwise a permanently broken feed is retried on every single tick.
  assert((await stores.metadata.getSource("user-1", "stratechery"))?.lastPolledAt);
});

Deno.test("one unfetchable article does not fail the poll", async () => {
  const { stores, ctx, source } = await subscriberSource();
  let calls = 0;
  const result = await pollFeedSource(ctx, source, {
    transport: feedTransport(RSS),
    fetchArticle: (url) => {
      calls++;
      if (url.includes("aggregation")) return Promise.reject(new Error("403 paywall"));
      return article("Second", "Body two.")();
    },
  });
  assertEquals(calls, 2);
  assertEquals(result.queued, 1);
  assertEquals(result.failed, 1);
  assertStringIncludes(result.errors[0] ?? "", "403 paywall");
  assertEquals((await stores.metadata.listEpisodes({ userId: "user-1" })).length, 1);
});

Deno.test("new feed items are fetched with bounded concurrency, not one at a time (audio-feed-8ce2)", async () => {
  const { ctx, source } = await subscriberSource();
  const items = Array.from(
    { length: 6 },
    (_, i) =>
      `<item><title>Post ${i}</title><link>https://stratechery.com/2026/post-${i}</link></item>`,
  ).join("\n      ");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Many</title>
      ${items}
    </channel></rss>`;

  let inFlight = 0;
  let peak = 0;
  const result = await pollFeedSource(ctx, source, {
    transport: feedTransport(xml),
    fetchArticle: async (url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Long enough that a serial loop can never overlap two fetches: with a
      // sequential await the counter is back to 0 before the next item starts.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return {
        url,
        title: "Post",
        author: null,
        publishedAt: null,
        lead: "A lead.",
        body: "The body.",
      };
    },
  });

  assertEquals(result.queued, 6);
  assertEquals(result.failed, 0);
  // The promise of audio-feed-8ce2: N items cost ~ceil(N / cap) round-trips, not N.
  assert(peak > 1, "article fetches must overlap; a serial loop pays the sum of every fetch");
  // The promise of the cap: a feed cannot open one connection per item at once.
  assert(peak < 6, "six items must not put six article fetches in flight at once");
});

Deno.test("the batch poller only picks up sources that are due", async () => {
  const { stores, ctx, source } = await subscriberSource();
  const deps = { transport: feedTransport(RSS), fetchArticle: article("A", "Body.") };

  // Just polled: not due.
  await stores.metadata.putSource({ ...source, lastPolledAt: new Date().toISOString() });
  const notDue = await runFeedPollBatch(ctx, { ...deps, minIntervalMs: 60_000 });
  assertEquals(notDue.polled, 0);

  // Polled long ago: due.
  await stores.metadata.putSource({
    ...source,
    lastPolledAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  const due = await runFeedPollBatch(ctx, { ...deps, minIntervalMs: 60_000 });
  assertEquals(due.polled, 1);
  assertEquals(due.queued, 2);
});

Deno.test("runFeedPollBatch captures extraction errors when article fetch fails (audio-feed-e1d)", async () => {
  const { stores, ctx, source } = await subscriberSource();
  await stores.metadata.putSource({
    ...source,
    title: "Broken Tech Blog",
    lastPolledAt: new Date(Date.now() - 3_600_000).toISOString(),
  });

  const failingDeps = {
    transport: feedTransport(RSS),
    fetchArticle: () => Promise.reject(new Error("403 Forbidden: Cloudflare protection")),
  };

  const res = await runFeedPollBatch(ctx, failingDeps);
  assertEquals(res.polled, 1);
  assertEquals(res.queued, 0);
  assertEquals(res.failed, 2);
  assert(Array.isArray(res.errors), "errors must be present on batch result");
  assertEquals(res.errors?.length, 2);
  assertStringIncludes(res.errors![0]!, "Broken Tech Blog");
  assertStringIncludes(res.errors![0]!, "403 Forbidden: Cloudflare protection");
});

Deno.test("runFeedPollBatch scans user sources with bounded concurrency, not serially (audio-feed-f3aa)", async () => {
  const stores = memoryStores();
  let inFlight = 0;
  let peak = 0;
  const originalListSources = stores.metadata.listSources.bind(stores.metadata);

  stores.metadata.listSources = async (userId: string) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    try {
      return await originalListSources(userId);
    } finally {
      inFlight--;
    }
  };

  const ctx = { config: { port: 8000, adminToken: "token" }, stores };
  // Seed 6 users with no due sources so the scan walks users.
  for (let i = 1; i <= 6; i++) {
    await stores.metadata.putUser(makeUser({ id: `user-${i}`, status: "approved" }));
  }

  const result = await runFeedPollBatch(ctx, { minIntervalMs: 60_000 });
  assertEquals(result.polled, 0);
  assert(
    peak > 1,
    `user source scans must overlap (peak was ${peak}); a serial loop pays the sum of every user round-trip`,
  );
  assert(peak <= 4, `user source scans must not exceed bounded concurrency (peak was ${peak})`);
});

Deno.test("runFeedPollBatch round-trip counts match bounded concurrency measurements for idle and due cases (audio-feed-f3aa)", async () => {
  const dummyDeps = {
    transport: feedTransport(RSS),
    fetchArticle: article("A", "Body."),
  };

  const measure = async (N: number, sourcesPerUser: number, due: boolean) => {
    const stores = memoryStores();
    let listSourcesCalls = 0;
    const origListSources = stores.metadata.listSources.bind(stores.metadata);
    stores.metadata.listSources = async (userId: string) => {
      listSourcesCalls++;
      return await origListSources(userId);
    };

    const ctx = { config: { port: 8000, adminToken: "token" }, stores };
    const now = Date.now();
    for (let i = 1; i <= N; i++) {
      const userId = `user-${i}`;
      await stores.metadata.putUser(makeUser({ id: userId, status: "approved" }));
      for (let s = 1; s <= sourcesPerUser; s++) {
        await stores.metadata.putSource(
          makeSource({
            id: `src-${i}-${s}`,
            userId,
            feedUrl: `https://example.com/u${i}/f${s}.xml`,
            lastPolledAt: due
              ? new Date(now - 7_200_000).toISOString()
              : new Date(now - 1_000).toISOString(),
          }),
        );
      }
    }

    listSourcesCalls = 0;
    const res = await runFeedPollBatch(ctx, { ...dummyDeps, minIntervalMs: 60_000, batchSize: 5 });
    return { listSourcesCalls, polled: res.polled };
  };

  // Idle case: walks all N users (unbounded in N)
  assertEquals((await measure(1, 2, false)).listSourcesCalls, 1);
  assertEquals((await measure(3, 2, false)).listSourcesCalls, 3);
  assertEquals((await measure(10, 2, false)).listSourcesCalls, 10);

  // Early-exit case: stops once batchSize is reached
  // 1 source per user, all due -> needs 5 users -> stops at user 5 (5 calls for N=10, not 8)
  const due10 = await measure(10, 1, true);
  assertEquals(due10.listSourcesCalls, 5);
  assertEquals(due10.polled, 5);

  // 5 sources per user, all due -> user 1 has 5 due -> stops at user 1 (1 call for N=10, not 4)
  const due10Batch = await measure(10, 5, true);
  assertEquals(due10Batch.listSourcesCalls, 1);
  assertEquals(due10Batch.polled, 5);
});

Deno.test("runFeedPollBatch never issues more listSources calls than serial code (audio-feed-f3aa)", async () => {
  const dummyDeps = {
    transport: feedTransport(RSS),
    fetchArticle: article("A", "Body."),
  };

  const measureCalls = async (
    N: number,
    sourcesPerUser: number,
    due: boolean,
    concurrency?: number,
  ) => {
    const stores = memoryStores();
    let calls = 0;
    const origList = stores.metadata.listSources.bind(stores.metadata);
    stores.metadata.listSources = async (uid: string) => {
      calls++;
      return await origList(uid);
    };

    const ctx = { config: { port: 8000, adminToken: "token" }, stores };
    const now = Date.now();
    for (let i = 1; i <= N; i++) {
      const userId = `user-${i}`;
      await stores.metadata.putUser(makeUser({ id: userId, status: "approved" }));
      for (let s = 1; s <= sourcesPerUser; s++) {
        await stores.metadata.putSource(
          makeSource({
            id: `src-${i}-${s}`,
            userId,
            feedUrl: `https://example.com/u${i}/f${s}.xml`,
            lastPolledAt: due
              ? new Date(now - 7_200_000).toISOString()
              : new Date(now - 1_000).toISOString(),
          }),
        );
      }
    }

    calls = 0;
    await runFeedPollBatch(ctx, {
      ...dummyDeps,
      minIntervalMs: 60_000,
      batchSize: 5,
      ...(concurrency !== undefined ? { userScanConcurrency: concurrency } : {}),
    });
    return calls;
  };

  // Three test cases:
  // Case 1: N=10, 0 due (idle) -> serial issues 10, change must issue <= 10
  const idleConcurrent = await measureCalls(10, 2, false);
  const idleSerial = await measureCalls(10, 2, false, 1);
  assert(
    idleConcurrent <= idleSerial,
    `idle case issued ${idleConcurrent} calls, serial was ${idleSerial}`,
  );

  // Case 2: N=10, 1 due/user -> serial issues 5, change must issue <= 5 (not 8)
  const due10Concurrent = await measureCalls(10, 1, true);
  const due10Serial = await measureCalls(10, 1, true, 1);
  assert(
    due10Concurrent <= due10Serial,
    `1 due/user case issued ${due10Concurrent} calls, serial was ${due10Serial}`,
  );

  // Case 3: N=10, 5 due/user -> serial issues 1, change must issue <= 1 (not 4)
  const due10BatchConcurrent = await measureCalls(10, 5, true);
  const due10BatchSerial = await measureCalls(10, 5, true, 1);
  assert(
    due10BatchConcurrent <= due10BatchSerial,
    `5 due/user case issued ${due10BatchConcurrent} calls, serial was ${due10BatchSerial}`,
  );
});

Deno.test("runFeedPollBatch preserves exact same due sources selected and ordering as sequential scan (audio-feed-f3aa)", async () => {
  const stores = memoryStores();
  const polledSourceUrls: string[] = [];
  const rssTransport = feedTransport(RSS);
  const recordingDeps = {
    transport: (url: URL, signal: AbortSignal) => {
      polledSourceUrls.push(url.toString());
      return rssTransport(url, signal);
    },
    fetchArticle: article("A", "Body."),
  };

  const ctx = { config: { port: 8000, adminToken: "token" }, stores };
  const now = Date.now();

  // Create 8 users with a variety of sources
  for (let i = 1; i <= 8; i++) {
    const userId = `user-${i}`;
    await stores.metadata.putUser(makeUser({ id: userId, status: "approved" }));
  }

  // user-1: src-1 (due), src-2 (not due)
  await stores.metadata.putSource(
    makeSource({
      id: "src-1-1",
      userId: "user-1",
      feedUrl: "https://example.com/u1/1",
      lastPolledAt: new Date(now - 7_200_000).toISOString(),
    }),
  );
  await stores.metadata.putSource(
    makeSource({
      id: "src-1-2",
      userId: "user-1",
      feedUrl: "https://example.com/u1/2",
      lastPolledAt: new Date(now - 1_000).toISOString(),
    }),
  );

  // user-2: src-1 (no feedUrl), src-2 (due)
  await stores.metadata.putSource(
    makeSource({
      id: "src-2-1",
      userId: "user-2",
      feedUrl: undefined,
      lastPolledAt: new Date(now - 7_200_000).toISOString(),
    }),
  );
  await stores.metadata.putSource(
    makeSource({
      id: "src-2-2",
      userId: "user-2",
      feedUrl: "https://example.com/u2/2",
      lastPolledAt: new Date(now - 7_200_000).toISOString(),
    }),
  );

  // user-3: no sources

  // user-4: src-1 (due), src-2 (due)
  await stores.metadata.putSource(
    makeSource({
      id: "src-4-1",
      userId: "user-4",
      feedUrl: "https://example.com/u4/1",
      lastPolledAt: new Date(now - 7_200_000).toISOString(),
    }),
  );
  await stores.metadata.putSource(
    makeSource({
      id: "src-4-2",
      userId: "user-4",
      feedUrl: "https://example.com/u4/2",
      lastPolledAt: new Date(now - 7_200_000).toISOString(),
    }),
  );

  // user-5: src-1 (due)
  await stores.metadata.putSource(
    makeSource({
      id: "src-5-1",
      userId: "user-5",
      feedUrl: "https://example.com/u5/1",
      lastPolledAt: new Date(now - 7_200_000).toISOString(),
    }),
  );

  // user-6..8: src-1 (due)
  for (let i = 6; i <= 8; i++) {
    await stores.metadata.putSource(
      makeSource({
        id: `src-${i}-1`,
        userId: `user-${i}`,
        feedUrl: `https://example.com/u${i}/1`,
        lastPolledAt: new Date(now - 7_200_000).toISOString(),
      }),
    );
  }

  // With batchSize = 5:
  // Expected due in order:
  // 1. user-1: src-1-1
  // 2. user-2: src-2-2
  // 3. user-4: src-4-1
  // 4. user-4: src-4-2
  // 5. user-5: src-5-1
  // users 6, 7, 8 must NOT be polled.
  const res = await runFeedPollBatch(ctx, {
    ...recordingDeps,
    minIntervalMs: 60_000,
    batchSize: 5,
  });
  assertEquals(res.polled, 5);
  assertEquals(polledSourceUrls, [
    "https://example.com/u1/1",
    "https://example.com/u2/2",
    "https://example.com/u4/1",
    "https://example.com/u4/2",
    "https://example.com/u5/1",
  ]);
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const app = (deps: Parameters<typeof createHandlers>[1] = {}) => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx, deps));
  return { fetch, stores, ctx };
};

const post = (path: string, body: unknown, token?: string) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-feed-token": token } : {}),
    },
    body: JSON.stringify(body),
  });

Deno.test("POST /api/sources subscribes and polls immediately", async () => {
  const { fetch, stores } = app({
    feedTransport: feedTransport(RSS),
    fetchArticle: article("Aggregation", "Body text."),
  });
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  const res = await fetch(
    post("/api/sources", { feedUrl: "https://stratechery.com/feed/" }, "token-user-1"),
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.source.id, "stratechery");
  assertEquals(body.poll.queued, 2);
  // The response tells the user what to subscribe to next.
  assertEquals(body.feedPaths, ["/feed/token-user-1/stratechery/direct.xml"]);
  assertEquals((await stores.metadata.listSources("user-1")).length, 1);
});

Deno.test("subscribing requires an approved user's token", async () => {
  const { fetch, stores } = app({ feedTransport: feedTransport(RSS) });
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "pending-1", status: "pending", feedToken: "token-pending" }),
  );

  const feed = { feedUrl: "https://stratechery.com/feed/" };
  assertEquals((await fetch(post("/api/sources", feed))).status, 403);
  assertEquals((await fetch(post("/api/sources", feed, "nonsense"))).status, 403);
  // A pending subscriber cannot queue work that costs money.
  assertEquals((await fetch(post("/api/sources", feed, "token-pending"))).status, 403);
  assertEquals((await stores.metadata.listSources("user-1")).length, 0);
  assertEquals((await stores.metadata.listSources("pending-1")).length, 0);
});

Deno.test("a non-feed URL is refused, and nothing is stored", async () => {
  // The transport must discriminate, or the refusal path is never exercised: a
  // transport that answers every URL with a feed cannot tell an article from a feed.
  const selective = (url: URL, _signal: AbortSignal) =>
    url.pathname.includes("feed")
      ? Promise.resolve(
        new Response(RSS, { status: 200, headers: { "content-type": "application/rss+xml" } }),
      )
      : Promise.resolve(
        new Response("<html><body>an article</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
  const { fetch, stores } = app({ feedTransport: selective });
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  const notAFeed = await fetch(
    post("/api/sources", { feedUrl: "https://example.com/article" }, "token-user-1"),
  );
  assertEquals(notAFeed.status, 422);
  assertStringIncludes(await notAFeed.text(), "RSS or Atom");

  assertEquals((await fetch(post("/api/sources", {}, "token-user-1"))).status, 400);
  assertEquals((await stores.metadata.listSources("user-1")).length, 0);
});

Deno.test("a text/plain response that contains valid XML/Atom is accepted", async () => {
  const textPlainFeed = (_url: URL, _signal: AbortSignal) =>
    Promise.resolve(
      new Response(RSS, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
  const { fetch, stores } = app({ feedTransport: textPlainFeed });
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  const res = await fetch(
    post("/api/sources", { feedUrl: "https://bandarra.me/feed/feed.xml" }, "token-user-1"),
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.source.feedUrl, "https://bandarra.me/feed/feed.xml");
  assert(body.feedPaths.length > 0);
});

Deno.test("GET /api/sources lists the caller's feeds and their feed paths", async () => {
  const { fetch, stores } = app({
    feedTransport: feedTransport(RSS),
    fetchArticle: article("A", "Body."),
  });
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );
  await fetch(
    post(
      "/api/sources",
      { feedUrl: "https://stratechery.com/feed/", title: "Stratechery" },
      "token-user-1",
    ),
  );

  const res = await fetch(
    new Request(`${BASE}/api/sources`, { headers: { "x-feed-token": "token-user-1" } }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.sources.length, 1);
  assertEquals(body.sources[0]!.title, "Stratechery");
  assertEquals(body.sources[0]!.feedPaths, ["/feed/token-user-1/stratechery/direct.xml"]);
  // Another user's token must not see it.
  await stores.metadata.putUser(
    makeUser({ id: "user-2", status: "approved", feedToken: "token-user-2" }),
  );
  const other = await fetch(
    new Request(`${BASE}/api/sources`, { headers: { "x-feed-token": "token-user-2" } }),
  );
  assertEquals((await other.json()).sources.length, 0);
});

// ---------------------------------------------------------------------------
// The promise, end to end: subscribe, and the posts become playable audio
// ---------------------------------------------------------------------------

Deno.test("END TO END: subscribe to a feed, then play what its episodes publish", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(
    ctx,
    createHandlers(ctx, {
      feedTransport: feedTransport(RSS),
      fetchArticle: (url) =>
        Promise.resolve({
          url,
          title: "Aggregation & AI",
          author: "Ben Thompson",
          publishedAt: "2026-09-01T06:00:00.000Z",
          lead: "The lead paragraph.",
          body: "Aggregation theory explains why platforms win.",
        }),
    }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  // 1. The subscriber pastes a feed URL.
  const subscribed = await fetch(
    post("/api/sources", { feedUrl: "https://stratechery.com/feed/" }, "token-user-1"),
  );
  assertEquals(subscribed.status, 201);
  assertEquals((await subscribed.json()).poll.queued, 2);

  // 2. The worker turns the queued posts into audio.
  const audio = (): DecodedAudioResult => {
    const raw = new Uint8Array(44 + 300);
    raw.set([0x52, 0x49, 0x46, 0x46], 0);
    raw.set([0x57, 0x41, 0x56, 0x45], 8);
    raw.set([0x64, 0x61, 0x74, 0x61], 36);
    return {
      rawBytes: raw,
      mimeType: "audio/wav",
      format: "wav",
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      durationSeconds: 1,
      finishReason: "STOP",
      truncated: false,
      toWav: () => raw,
    };
  };
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(audio()), { batchSize: 5 });
  assertEquals(run.ready.length, 2);

  // 3. Their per-source feed now carries both posts, each with playable audio.
  const feed = await fetch(new Request(`${BASE}/feed/token-user-1/stratechery/direct.xml`));
  assertEquals(feed.status, 200);
  const xml = await feed.text();
  assertEquals((xml.match(/<item>/g) ?? []).length, 2);
  assertStringIncludes(xml, "Aggregation");
  const enclosure = xml.match(/<enclosure url="([^"]+)" length="(\d+)"/);
  assert(enclosure, "the subscribed feed must advertise audio");
  const bytes = await fetch(new Request(enclosure[1]!));
  assertEquals(bytes.status, 200);
  assertEquals((await bytes.bytes()).length, Number(enclosure[2]));

  // 4. And nothing was queued twice.
  const repoll = await pollFeedSource(
    ctx,
    (await stores.metadata.getSource("user-1", "stratechery"))!,
    {
      transport: feedTransport(RSS),
      fetchArticle: (url) =>
        Promise.resolve({ url, title: "x", author: null, publishedAt: null, lead: "", body: "x" }),
    },
  );
  assertEquals(repoll.queued, 0);
});

Deno.test("admin create subscriber with optional feedUrl subscribes and queues immediately", async () => {
  const { fetch, stores } = app({
    feedTransport: feedTransport(RSS),
    fetchArticle: article("Aggregation & AI", "Body text."),
  });
  const res = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "admin-secret",
      },
      body: JSON.stringify({
        email: "subscribed-new@example.com",
        displayName: "Subscribed User",
        feedUrl: "https://stratechery.com/feed/",
      }),
    }),
  );

  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.email, "subscribed-new@example.com");
  assertEquals(body.status, "approved");
  assert(body.feedToken, "must return feed token");
  assert(body.initialSource, "must return initialSource");
  assertEquals(body.initialSource.title, "stratechery.com");
  assertEquals(body.initialSource.queued, 2);

  const sources = await stores.metadata.listSources(body.id);
  assertEquals(sources.length, 1);
  assertEquals(sources[0]?.title, "stratechery.com");

  const episodes = await stores.metadata.listEpisodes({ userId: body.id });
  assertEquals(episodes.length, 2);
});

Deno.test("a store failure while subscribing is answered with a fixed detail (audio-feed-yj8cq)", async () => {
  // THE DEFECT this pins: the subscribe catch-all answered with
  // `String((error as Error)?.message ?? error)`, so any non-IngestError thrown inside
  // subscribeToFeed - a store/provider failure - was echoed to the caller verbatim. This
  // store key shape is what a putSource failure can actually carry.
  const { fetch, stores } = app({ feedTransport: feedTransport(RSS) });
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );
  const storeMessage =
    'kv put failed for ["source","user-1","stratechery"] at blob://audio-store/private-bucket';
  stores.metadata.putSource = () => Promise.reject(new Error(storeMessage));

  const res = await fetch(
    post("/api/sources", { feedUrl: "https://stratechery.com/feed/" }, "token-user-1"),
  );
  const body = await res.json();
  assert(
    !JSON.stringify(body).includes("private-bucket"),
    "store key text must not reach the caller",
  );
  assertEquals(body.error, "Could not subscribe to that feed.");
  assertEquals(res.status, 502);
});

Deno.test("POST /api/sources refuses (N+1)th source with 429 when budget-tied ceiling is reached (audio-feed-jgois)", async () => {
  const ceiling = 2;
  const { fetch, stores } = app({
    feedTransport: feedTransport(RSS),
    fetchArticle: article("A", "Body."),
  });
  await stores.metadata.putUser(
    makeUser({
      id: "user-limit",
      status: "approved",
      feedToken: "token-limit",
      dailyEpisodeBudget: ceiling,
    }),
  );

  const res1 = await fetch(
    post("/api/sources", { feedUrl: "https://example.com/s1/feed.xml" }, "token-limit"),
  );
  assertEquals(res1.status, 201);

  const res2 = await fetch(
    post("/api/sources", { feedUrl: "https://example.com/s2/feed.xml" }, "token-limit"),
  );
  assertEquals(res2.status, 201);

  // 3rd source is beyond ceiling 2
  const res3 = await fetch(
    post("/api/sources", { feedUrl: "https://example.com/s3/feed.xml" }, "token-limit"),
  );
  assertEquals(res3.status, 429);
  const body = await res3.json();
  assertStringIncludes(body.error, `at most ${ceiling} sources`);
});

Deno.test("POST /api/sources with all-invalid modes returns 400", async () => {
  const { fetch, stores } = app({
    feedTransport: feedTransport(RSS),
    fetchArticle: article("A", "Body."),
  });
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  const res = await fetch(
    post(
      "/api/sources",
      { feedUrl: "https://example.com/feed.xml", modes: ["nonsense", "invalid"] },
      "token-user-1",
    ),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertStringIncludes(body.error, "valid audio mode is required");
});

Deno.test("RSS/Atom parses media, content, and feedburner namespaces (audio-feed-dcj)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:media="http://search.yahoo.com/mrss/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:feedburner="http://rssnamespace.org/feedburner/ext/1.0">
  <channel>
    <title>Media Showcase</title>
    <item>
      <media:title>Media Title</media:title>
      <link>https://feedproxy.google.com/~r/test/~3/abc</link>
      <feedburner:origLink>https://example.com/canonical-article</feedburner:origLink>
      <content:encoded><![CDATA[<p>Full article text in content encoded format.</p>]]></content:encoded>
      <media:description>Summary description</media:description>
      <pubDate>Wed, 02 Sep 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Video Item</title>
      <media:content url="https://example.com/video-post" type="video/mp4" />
      <description>Video description</description>
    </item>
  </channel>
</rss>`;

  const items = parseFeedItems(xml, "https://example.com/feed.xml");
  assertEquals(items.length, 2);

  assertEquals(items[0]!.title, "Media Title");
  assertEquals(items[0]!.link, "https://example.com/canonical-article");
  assertStringIncludes(items[0]!.summary ?? "", "Full article text in content encoded");
  assertEquals(items[0]!.publishedAt, "2026-09-02T12:00:00.000Z");

  assertEquals(items[1]!.title, "Video Item");
  assertEquals(items[1]!.link, "https://example.com/video-post");
  assertEquals(items[1]!.summary, "Video description");
});

Deno.test("pollFeedSource falls back to embedded feed content when web article fetch fails (audio-feed-dcj)", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Substack Blog</title>
    <item>
      <title>Paywalled Web Post</title>
      <link>https://example.substack.com/p/paywalled-post</link>
      <content:encoded><![CDATA[<p>This is the full rich text of the article provided directly inside the RSS feed body. It contains all the necessary paragraphs for audio synthesis even if the web link requires a Cloudflare challenge or login.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

  const source: Source = makeSource({
    id: "substack",
    userId: "user-1",
    feedUrl: "https://example.substack.com/feed",
  });
  await stores.metadata.putSource(source);

  // fetchArticle simulates a 403 bot-block / paywall on the web URL
  const poll = await pollFeedSource(ctx, source, {
    transport: feedTransport(feedXml),
    fetchArticle: () => Promise.reject(new Error("403 Forbidden - Cloudflare bot challenge")),
  });

  // Because feed had rich content:encoded (>= 80 chars), it fell back and queued the episode!
  assertEquals(poll.queued, 1);
  assertEquals(poll.failed, 0);

  const episodes = await stores.metadata.listEpisodes({ userId: "user-1" });
  assertEquals(episodes.length, 1);
  assertEquals(episodes[0]!.title, "Paywalled Web Post");

  const article = await stores.metadata.getArticle("user-1", episodes[0]!.articleId);
  assert(article, "article must be stored from feed content fallback");
  assertStringIncludes(
    article.content,
    "full rich text of the article provided directly inside the RSS feed",
  );
});

Deno.test("pollFeedSource does NOT fall back on description only or short content:encoded (audio-feed-yh2)", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Paywalled Feeds</title>
    <!-- Item 1: Paywall teaser in description only (>80 chars) -->
    <item>
      <title>Teaser Only Post</title>
      <link>https://example.com/teaser-post</link>
      <description>Subscribe to keep reading this post and get 7 days of free access to our entire catalog of deep dives.</description>
    </item>
    <!-- Item 2: Short content:encoded (<80 chars) -->
    <item>
      <title>Short Content Post</title>
      <link>https://example.com/short-post</link>
      <content:encoded><![CDATA[<p>Too short to narrate.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

  const source: Source = makeSource({
    id: "paywalled-source",
    userId: "user-1",
    feedUrl: "https://example.com/feed.xml",
  });
  await stores.metadata.putSource(source);

  const poll = await pollFeedSource(ctx, source, {
    transport: feedTransport(feedXml),
    fetchArticle: () => Promise.reject(new Error("403 Forbidden - Paywall")),
  });

  // Neither item should be queued as an episode
  assertEquals(poll.queued, 0);
  assertEquals(poll.failed, 2);

  const episodes = await stores.metadata.listEpisodes({ userId: "user-1" });
  assertEquals(
    episodes.length,
    0,
    "must not queue episodes for paywall teasers or sub-80 char content",
  );
});

Deno.test("feed fallback strips the markup off a bare-fragment content:encoded before the TTS reads it (audio-feed-8g0)", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  // content:encoded is a BARE FRAGMENT in practice — CDATA-wrapped body HTML, never a
  // full document — and that is the one shape whose `body.textContent` came back empty,
  // so the old `text || rawHtml` returned the markup unchanged.
  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Fragment Blog</title>
    <item>
      <title>Two Paragraphs</title>
      <link>https://example.com/two-paragraphs</link>
      <content:encoded><![CDATA[<p>The first paragraph of the embedded article, long enough on its own to say what the piece is about.</p><p>The second paragraph continues the argument and must not run into the first one.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

  const source: Source = makeSource({
    id: "fragment-blog",
    userId: "user-1",
    feedUrl: "https://example.com/feed.xml",
  });
  await stores.metadata.putSource(source);

  const poll = await pollFeedSource(ctx, source, {
    transport: feedTransport(feedXml),
    fetchArticle: () => Promise.reject(new Error("403 Forbidden - Cloudflare bot challenge")),
  });
  assertEquals(poll.queued, 1);

  const episodes = await stores.metadata.listEpisodes({ userId: "user-1" });
  const article = await stores.metadata.getArticle("user-1", episodes[0]!.articleId);
  assert(article, "the embedded body must be stored");
  assert(
    !article.content.includes("<"),
    `markup reached the stored body: ${article.content}`,
  );
  assert(
    article.content.includes("about.\n\nThe second"),
    `block boundaries must survive as paragraph breaks, not run-together words: ${article.content}`,
  );

  // The finding is about what the MODEL is asked to read, so capture the outgoing
  // narration request through the real synthesizer rather than asserting on the
  // stored string alone.
  let prompt = "";
  const synthesize = createGeminiSynthesizer(ctx, {
    client: new GeminiTtsClient({
      apiKey: "test-key-not-real",
      fetchFn: (_input, init) => {
        const body = JSON.parse(String(init?.body)) as GeminiGenerateContentRequest;
        prompt = body.contents?.[0]?.parts?.map((p) => p.text).join("\n\n") ?? "";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{
                      inlineData: {
                        mimeType: "audio/pcm;rate=24000",
                        data: uint8ArrayToBase64(new Uint8Array(48000)),
                      },
                    }],
                  },
                  finishReason: "STOP",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    }),
  });

  const run = await runSynthesisBatch(ctx, synthesize, { batchSize: 1 });
  assertEquals(run.ready.length, 1, "the embedded article must still synthesise");
  assert(prompt.length > 0, "the narration prompt must have been captured");
  assertEquals(prompt.includes("<"), false, `markup reached the prompt: ${prompt}`);
  assertStringIncludes(prompt, "The first paragraph");
  assertStringIncludes(prompt, "The second paragraph");
});

Deno.test("the fallback lead comes from content:encoded, never from the teaser in description (audio-feed-7jp)", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  const TEASER =
    "Subscribe to keep reading this post and get 7 days of free access to our entire catalog of deep dives.";
  const FIRST_PARAGRAPH =
    "The embedded article opens by describing the practical realities of the shift, which is what a listener should hear first.";
  const SECOND_PARAGRAPH = "It then moves on to the trade-offs the marketing copy never mentions.";

  // The teaser sits in `description` (merged into FeedItem.summary alongside
  // content:encoded), and a full body sits in content:encoded, so the fallback fires.
  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Teased Blog</title>
    <item>
      <title>A Teased Post</title>
      <link>https://example.com/teased-post</link>
      <description>${TEASER}</description>
      <content:encoded><![CDATA[<p>${FIRST_PARAGRAPH}</p><p>${SECOND_PARAGRAPH}</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

  const source: Source = makeSource({
    id: "teased-blog",
    userId: "user-1",
    feedUrl: "https://example.com/feed.xml",
    modes: ["deepdive"],
  });
  await stores.metadata.putSource(source);

  const poll = await pollFeedSource(ctx, source, {
    transport: feedTransport(feedXml),
    fetchArticle: () => Promise.reject(new Error("403 Forbidden - Cloudflare bot challenge")),
  });
  assertEquals(poll.queued, 1);

  const episodes = await stores.metadata.listEpisodes({ userId: "user-1" });
  const episode = episodes[0]!;
  const article = await stores.metadata.getArticle("user-1", episode.articleId);
  assert(article, "the embedded body must be stored");

  // The lead is not decorative: it is the episode description in the published feed
  // and the grounding line of the deep dive's second turn.
  assertEquals((article.excerpt ?? "").includes("Subscribe to keep reading"), false);
  assertStringIncludes(article.excerpt ?? "", "practical realities");
  assertEquals(episode.description?.includes("Subscribe to keep reading") ?? false, false);
  assertStringIncludes(episode.description ?? "", "practical realities");

  // Walk the dialogue path as well: the teaser was measurable in
  // $.contents[0].parts[1].text, so assert on the whole outgoing request rather than
  // on the stored fields alone.
  let sent = "";
  const synthesize = createGeminiSynthesizer(ctx, {
    client: new GeminiTtsClient({
      apiKey: "test-key-not-real",
      fetchFn: (_input, init) => {
        sent = String(init?.body);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{
                      inlineData: {
                        mimeType: "audio/pcm;rate=24000",
                        data: uint8ArrayToBase64(new Uint8Array(24000)),
                      },
                    }],
                  },
                  finishReason: "STOP",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    }),
  });

  const run = await runSynthesisBatch(ctx, synthesize, { batchSize: 1 });
  assertEquals(run.ready.length, 1, "the deep dive must synthesise");
  assert(sent.length > 0, "the dialogue request must have been captured");
  assertEquals(
    sent.includes("Subscribe to keep reading"),
    false,
    `the teaser reached the dialogue request: ${sent}`,
  );
  assertStringIncludes(sent, "practical realities");
});

Deno.test("pollFeedSource records lastPollError on source and clears it on success (audio-feed-dcj)", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );

  const source: Source = makeSource({
    id: "failing-source",
    userId: "user-1",
    feedUrl: "https://broken.example.com/rss",
  });
  await stores.metadata.putSource(source);

  // 1. Poll fails with transport 404
  const failedPoll = await pollFeedSource(ctx, source, {
    transport: () =>
      Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
  });
  assertEquals(failedPoll.errors.length, 1);

  const updatedSource = await stores.metadata.getSource("user-1", "failing-source");
  assert(updatedSource?.lastPollError, "lastPollError must be recorded");
  assertStringIncludes(updatedSource!.lastPollError, "unavailable");

  // 2. Poll succeeds on subsequent attempt
  const goodXml = `<rss version="2.0"><channel><title>Fixed</title></channel></rss>`;
  await pollFeedSource(ctx, source, {
    transport: feedTransport(goodXml),
  });

  const healedSource = await stores.metadata.getSource("user-1", "failing-source");
  assertEquals(healedSource?.lastPollError, undefined, "lastPollError must be cleared on success");
});

Deno.test("POST /api/sources sets codeHandling and persists it on the source (audio-feed-bdo)", async () => {
  const { stores, ctx } = await subscriberSource();
  const user = (await stores.metadata.getUser("user-1"))!;
  const { fetch } = createApp(ctx, createHandlers(ctx, { feedTransport: feedTransport(RSS) }));
  const res = await fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": user.feedToken!,
      },
      body: JSON.stringify({
        feedUrl: "https://codefeed.example.com/feed.xml",
        title: "Code Feed",
        modes: ["direct"],
        codeHandling: "explain",
      }),
    }),
  );
  assertEquals(res.status, 201);
  const data = await res.json();
  assertEquals(data.source.codeHandling, "explain");

  const stored = await stores.metadata.getSource(user.id, data.source.id);
  assertEquals(stored?.codeHandling, "explain");
});

Deno.test("createGeminiSynthesizer respects source codeHandling, stripping code on skip and using summarizer on explain with fallback (audio-feed-bdo, audio-feed-bjt)", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));

  const bodyWithCode =
    "First paragraph.\n\n```javascript\nconst a = 1;\nconsole.log(a);\n```\n\nLast paragraph.";

  // 1. Source with codeHandling = "skip" (or default)
  const sourceSkip = makeSource({
    id: "src-skip",
    userId: "user-1",
    codeHandling: "skip",
  });
  await stores.metadata.putSource(sourceSkip);

  let capturedPrompt = "";
  let capturedSystemInstruction = "";
  const clientSkip = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: (_url, init) => {
      const req = JSON.parse(String(init?.body)) as GeminiGenerateContentRequest;
      capturedPrompt = req.contents[0]?.parts.map((p) => p.text).join("\n\n") ?? "";
      capturedSystemInstruction = req.systemInstruction?.parts[0]?.text ?? "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  inlineData: {
                    mimeType: "audio/pcm;rate=24000",
                    data: uint8ArrayToBase64(new Uint8Array(24)),
                  },
                }],
              },
              finishReason: "STOP",
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    },
  });

  const synthSkip = createGeminiSynthesizer(ctx, { client: clientSkip });
  const articleObj: Article = {
    id: "art-1",
    userId: "user-1",
    sourceId: "src-skip",
    url: "https://example.com/art-1",
    title: "Code Article",
    author: "Dev",
    content: bodyWithCode,
    ingestedAt: new Date().toISOString(),
  };
  await synthSkip({
    article: articleObj,
    source: sourceSkip,
    episode: makeEpisode({ id: "ep-1", userId: "user-1", articleId: "art-1", mode: "direct" }),
    mode: "direct",
  });

  // Raw code must NOT reach the model prompt
  assertEquals(capturedPrompt.includes("const a = 1"), false);
  assertEquals(capturedPrompt.includes("First paragraph."), true);
  assertEquals(capturedPrompt.includes("Last paragraph."), true);
  // audio-feed-bjt: parts.text contains ONLY article text, NEVER system instructions
  assertEquals(capturedPrompt.includes("Skip code blocks"), false);
  assertEquals(capturedPrompt.includes("You are an audio narrator"), false);
  assertEquals(capturedSystemInstruction, "");

  // 2. Source with codeHandling = "explain" AND summarizer provided
  const sourceExplain = makeSource({
    id: "src-explain",
    userId: "user-1",
    codeHandling: "explain",
  });
  await stores.metadata.putSource(sourceExplain);

  const synthExplain = createGeminiSynthesizer(ctx, {
    client: clientSkip,
    codeSummarizer: (code) => `declares variable in ${code.split("\n")[0]}`,
  });
  await synthExplain({
    article: { ...articleObj, sourceId: "src-explain" },
    source: sourceExplain,
    episode: makeEpisode({ id: "ep-2", userId: "user-1", articleId: "art-1", mode: "direct" }),
    mode: "direct",
  });

  assertEquals(
    capturedPrompt.includes("Here is what that code does: declares variable in const a = 1;"),
    true,
  );
  assertEquals(
    capturedPrompt.includes("["),
    false,
    "brackets must not reach spoken prompt (audio-feed-sju)",
  );
  assertEquals(capturedPrompt.includes("const a = 1;\nconsole.log(a);"), false);
  // audio-feed-bjt: parts.text contains ONLY article text, NEVER system instructions
  assertEquals(capturedPrompt.includes("explain or summarize"), false);
  assertEquals(capturedPrompt.includes("You are an audio narrator"), false);
  assertEquals(capturedSystemInstruction, "");

  // 3. Source with codeHandling = "explain" BUT NO summarizer provided -> fallback to skip
  const synthFallback = createGeminiSynthesizer(ctx, { client: clientSkip });
  await synthFallback({
    article: { ...articleObj, sourceId: "src-explain" },
    source: sourceExplain,
    episode: makeEpisode({ id: "ep-3", userId: "user-1", articleId: "art-1", mode: "direct" }),
    mode: "direct",
  });

  // Falls back to skipping raw code completely
  assertEquals(capturedPrompt.includes("const a = 1"), false);
  assertEquals(capturedPrompt.includes("First paragraph."), true);
  assertEquals(capturedPrompt.includes("Last paragraph."), true);
});
