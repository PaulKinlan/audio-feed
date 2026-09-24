/**
 * RSS/Atom subscription tests (audio-feed-2e5).
 *
 * The feature's promise is "paste a feed URL and its posts become audio", so the
 * tests are arranged along that sentence: parse the feed, queue only what is new,
 * refuse the wrong callers, and finally subscribe and play what the feed serves.
 *
 * No network anywhere: the feed document and the article bodies are both injected.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import {
  parseFeedItems,
  pollFeedSource,
  runFeedPollBatch,
  sourceIdForFeed,
} from "../src/ingest/feed.ts";
import { makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import type { Source } from "../src/types.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";

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
