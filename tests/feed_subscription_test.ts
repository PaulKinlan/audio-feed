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
import type { DecodedAudioResult, GeminiGenerateContentRequest } from "../src/tts/gemini.ts";
import { GeminiTtsClient, uint8ArrayToBase64 } from "../src/tts/gemini.ts";
import type { Source } from "../src/types.ts";
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
        prompt = body.contents?.[0]?.parts?.[0]?.text ?? "";
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
