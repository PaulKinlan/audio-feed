/**
 * Cron and background trigger tests (audio-feed-dsn).
 *
 * Verifies:
 * 1. Native Deno.cron schedule registration (poll feeds every 15m, synthesis every 2m).
 * 2. POST /api/admin/poll-now: manual trigger for feed polling with admin authentication.
 * 3. POST /api/admin/synthesize-now: manual trigger for synthesis batch with admin authentication.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { type CronRegistration, registerCronJobs } from "../src/cron.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";

const BASE = "https://audio.example.com";
const ADMIN = "admin-secret";
const config: AppConfig = {
  port: 8000,
  publicBaseUrl: BASE,
  adminToken: ADMIN,
  geminiApiKey: "fake-key",
};

const mockAudio = (): DecodedAudioResult => {
  const raw = new Uint8Array(44 + 100);
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

const req = (path: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
const auth = { "x-admin-token": ADMIN };

// ---------------------------------------------------------------------------
// Deno.cron registration
// ---------------------------------------------------------------------------

Deno.test("registerCronJobs: registers poll-feeds and synthesis jobs with expected schedules", () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };

  const registered: Array<{ name: string; schedule: string; handler: () => Promise<void> }> = [];
  const mockCron = (name: string, schedule: string, handler: () => Promise<void>) => {
    registered.push({ name, schedule, handler });
  };

  const jobs = registerCronJobs(ctx, {
    cron: mockCron,
    synthesizer: () => Promise.resolve(mockAudio()),
  });

  assertEquals(jobs.length, 2);
  assertEquals(registered.length, 2);

  const pollJob = registered.find((j) => j.name === "audio-feed-poll-feeds");
  assert(pollJob, "audio-feed-poll-feeds must be registered");
  assertEquals(pollJob.schedule, "*/15 * * * *", "feeds must be polled every 15 minutes");

  const synthJob = registered.find((j) => j.name === "audio-feed-synthesis");
  assert(synthJob, "audio-feed-synthesis must be registered");
  assertEquals(synthJob.schedule, "*/2 * * * *", "synthesis must run every 2 minutes");
});

Deno.test("registerCronJobs: skips synthesis cron job when geminiApiKey is unset and no synthesizer provided", () => {
  const stores: Stores = memoryStores();
  const ctx = { config: { ...config, geminiApiKey: undefined }, stores };

  const registered: CronRegistration[] = [];
  const mockCron = (name: string, schedule: string, handler: () => Promise<void>) => {
    registered.push({ name, schedule, handler });
  };

  const jobs = registerCronJobs(ctx, { cron: mockCron });
  assertEquals(jobs.length, 1);
  assertEquals(registered.length, 1);
  assertEquals(registered[0]!.name, "audio-feed-poll-feeds");
  assertEquals(registered[0]!.schedule, "*/15 * * * *");
});

Deno.test("registerCronJobs: handlers execute batch operations and handle errors gracefully", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };

  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await stores.metadata.putArticle(makeArticle({ id: "article-1", userId: "u1" }));
  await stores.metadata.putSource(
    makeSource({ id: "s1", userId: "u1", feedUrl: "https://example.com/feed.xml" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({ id: "ep1", userId: "u1", status: "pending", mode: "direct" }),
  );

  const registered: CronRegistration[] = [];
  const mockCron = (name: string, schedule: string, handler: () => Promise<void>) => {
    registered.push({ name, schedule, handler });
  };

  registerCronJobs(ctx, {
    cron: mockCron,
    synthesizer: () => Promise.resolve(mockAudio()),
  });

  const pollJob = registered.find((j) => j.name === "audio-feed-poll-feeds");
  assert(pollJob);
  // Executing the cron handler must not throw even if network fails
  await pollJob.handler();

  const synthJob = registered.find((j) => j.name === "audio-feed-synthesis");
  assert(synthJob);
  await synthJob.handler();
  const ep = await stores.metadata.getEpisode("u1", "ep1");
  assertEquals(ep?.status, "ready");
});

Deno.test("registerCronJobs: supports lazy context provider function (audio-feed-ncf)", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };

  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await stores.metadata.putArticle(makeArticle({ id: "article-1", userId: "u1" }));
  await stores.metadata.putEpisode(
    makeEpisode({ id: "ep1", userId: "u1", status: "pending", mode: "direct" }),
  );

  const registered: CronRegistration[] = [];
  const mockCron = (name: string, schedule: string, handler: () => Promise<void>) => {
    registered.push({ name, schedule, handler });
  };

  registerCronJobs(() =>
    Promise.resolve({
      ctx,
      synthesizer: () => Promise.resolve(mockAudio()),
    }), { cron: mockCron });

  assertEquals(registered.length, 2);
  const synthJob = registered.find((j) => j.name === "audio-feed-synthesis");
  assert(synthJob);
  await synthJob.handler();
  const ep = await stores.metadata.getEpisode("u1", "ep1");
  assertEquals(ep?.status, "ready");
});

Deno.test("concurrent feed polls de-duplicate and do not queue duplicate episodes (audio-feed-562)", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  const source = makeSource({ id: "s1", userId: "u1", feedUrl: "https://example.com/feed.xml" });
  await stores.metadata.putSource(source);

  const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Feed 1</title>
  <item>
    <title>Article One</title>
    <link>https://example.com/one</link>
    <pubDate>Mon, 01 Sep 2026 06:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Article Two</title>
    <link>https://example.com/two</link>
    <pubDate>Tue, 02 Sep 2026 06:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

  const deps = {
    transport: () =>
      Promise.resolve(
        new Response(sampleRss, { headers: { "content-type": "application/rss+xml" } }),
      ),
    fetchArticle: (url: string) =>
      new Promise<
        { url: string; title: string; author: null; publishedAt: null; lead: string; body: string }
      >(
        (resolve) =>
          setTimeout(
            () =>
              resolve({
                url,
                title: url.endsWith("one") ? "Article One" : "Article Two",
                author: null,
                publishedAt: null,
                lead: "",
                body: "Body text.",
              }),
            10,
          ),
      ),
  };

  // Two polls running concurrently against the same feed
  const { pollFeedSource } = await import("../src/ingest/feed.ts");
  const [resA, resB] = await Promise.all([
    pollFeedSource(ctx, source, deps),
    pollFeedSource(ctx, source, deps),
  ]);

  // Combined queued count must be exactly 2 (the 2 items), never 4
  assertEquals(
    resA.queued + resB.queued,
    2,
    "exactly 2 episodes must be queued across concurrent polls",
  );
  const episodes = await stores.metadata.listEpisodes({ userId: "u1" });
  assertEquals(episodes.length, 2, "storage must contain exactly 2 distinct episodes");
});

Deno.test("concurrent polls with an immediately-resolved fetch still queue no duplicates (audio-feed-33m)", async () => {
  // The shape audio-feed-33m named as the one the 562 re-check could not survive.
  // The test above resolves fetchArticle after 10ms, which yields to the microtask
  // queue and lets the first poll's write land before the second reaches its
  // re-check - so it passes against a weaker implementation. With a synchronously
  // resolved promise both polls passed the re-check before either wrote, and the
  // same article queued twice. This is the case that requires the atomic insert.
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  const source = makeSource({ id: "s1", userId: "u1", feedUrl: "https://example.com/feed.xml" });
  await stores.metadata.putSource(source);

  const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Feed 1</title>
  <item>
    <title>Article One</title>
    <link>https://example.com/one</link>
    <pubDate>Mon, 01 Sep 2026 06:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Article Two</title>
    <link>https://example.com/two</link>
    <pubDate>Tue, 02 Sep 2026 06:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

  const deps = {
    transport: () =>
      Promise.resolve(
        new Response(sampleRss, { headers: { "content-type": "application/rss+xml" } }),
      ),
    // No setTimeout, no await boundary: resolves immediately.
    fetchArticle: (url: string) =>
      Promise.resolve({
        url,
        title: url.endsWith("one") ? "Article One" : "Article Two",
        author: null,
        publishedAt: null,
        lead: "",
        body: "Body text.",
      }),
  };

  const { pollFeedSource } = await import("../src/ingest/feed.ts");
  const [resA, resB] = await Promise.all([
    pollFeedSource(ctx, source, deps),
    pollFeedSource(ctx, source, deps),
  ]);

  assertEquals(
    resA.queued + resB.queued,
    2,
    "exactly 2 episodes across concurrent polls, never 4 (duplicate = double synthesis spend)",
  );
  const episodes = await stores.metadata.listEpisodes({ userId: "u1" });
  assertEquals(episodes.length, 2, "storage must contain exactly 2 distinct episodes");
  const articles = await Promise.all(
    ["https://example.com/one", "https://example.com/two"].map((u) =>
      stores.metadata.findArticleByUrl("u1", u)
    ),
  );
  assertEquals(articles.filter(Boolean).length, 2, "one article per url");
  // The loser skipped rather than errored: 2 items seen by each poll, 2 queued in
  // total, so the other 2 must be accounted for as skips and not as failures.
  assertEquals(resA.failed + resB.failed, 0, "a lost insert is a skip, not a failure");
  assertEquals(resA.items + resB.items, 4, "both polls saw both items");
});

// ---------------------------------------------------------------------------
// POST /api/admin/poll-now
// ---------------------------------------------------------------------------

Deno.test("POST /api/admin/poll-now requires admin token and runs batch feed poll", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await stores.metadata.putSource(
    makeSource({ id: "s1", userId: "u1", feedUrl: "https://example.com/feed.xml" }),
  );

  const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Feed 1</title>
  <item>
    <title>Post 1</title>
    <link>https://example.com/post-1</link>
    <pubDate>Mon, 01 Sep 2026 06:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

  const handlers = createHandlers(ctx, {
    feedTransport: () =>
      Promise.resolve(
        new Response(sampleRss, { headers: { "content-type": "application/rss+xml" } }),
      ),
    fetchArticle: () =>
      Promise.resolve({
        url: "https://example.com/post-1",
        title: "Post 1",
        author: "Author",
        publishedAt: null,
        lead: "",
        body: "Article text.",
      }),
  });

  const { fetch } = createApp(ctx, handlers);

  // 1. Refuses without token
  const unauth = await fetch(req("/api/admin/poll-now", { method: "POST" }));
  assertEquals(unauth.status, 401);

  // 2. Refuses with wrong token
  const wrong = await fetch(
    req("/api/admin/poll-now", { method: "POST", headers: { "x-admin-token": "wrong" } }),
  );
  assertEquals(wrong.status, 401);

  // 3. Succeeds with valid admin token
  const ok = await fetch(req("/api/admin/poll-now", { method: "POST", headers: auth }));
  assertEquals(ok.status, 200);
  const data = await ok.json();
  assertEquals(data.ok, true);
  assertEquals(data.polled, 1);
  assertEquals(data.queued, 1);
  assertEquals(data.failed, 0);

  // The episode was queued into storage
  const episodes = await stores.metadata.listEpisodes({ userId: "u1" });
  assertEquals(episodes.length, 1);
  assertEquals(episodes[0]!.title, "Post 1");
  assertEquals(episodes[0]!.status, "pending");
});

// ---------------------------------------------------------------------------
// POST /api/admin/synthesize-now
// ---------------------------------------------------------------------------

Deno.test("POST /api/admin/synthesize-now requires admin token and runs batch synthesis", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await stores.metadata.putArticle(makeArticle({ id: "article-1", userId: "u1" }));
  await stores.metadata.putEpisode(
    makeEpisode({ id: "ep1", userId: "u1", status: "pending", mode: "direct" }),
  );

  const handlers = createHandlers(ctx, {
    synthesizer: () => Promise.resolve(mockAudio()),
  });

  const { fetch } = createApp(ctx, handlers);

  // 1. Refuses without token
  const unauth = await fetch(req("/api/admin/synthesize-now", { method: "POST" }));
  assertEquals(unauth.status, 401);

  // 2. Refuses with wrong token
  const wrong = await fetch(
    req("/api/admin/synthesize-now", { method: "POST", headers: { "x-admin-token": "wrong" } }),
  );
  assertEquals(wrong.status, 401);

  // 3. Succeeds with valid token
  const ok = await fetch(req("/api/admin/synthesize-now", { method: "POST", headers: auth }));
  assertEquals(ok.status, 200);
  const data = await ok.json();
  assertEquals(data.ok, true);
  assertEquals(data.ready, 1);
  assertEquals(data.failed, 0);
  assertEquals(data.deferred, 0);

  // Episode is now ready in storage
  const ep = await stores.metadata.getEpisode("u1", "ep1");
  assertEquals(ep?.status, "ready");
});

Deno.test("POST /api/admin/synthesize-now returns 503 when synthesis is unconfigured", async () => {
  const stores: Stores = memoryStores();
  const unconfiguredCtx = { config: { ...config, geminiApiKey: undefined }, stores };
  const handlers = createHandlers(unconfiguredCtx);
  const { fetch } = createApp(unconfiguredCtx, handlers);

  const res = await fetch(req("/api/admin/synthesize-now", { method: "POST", headers: auth }));
  assertEquals(res.status, 503);
  const data = await res.json();
  assertEquals(data.ok, false);
  assertStringIncludes(data.error, "GEMINI_API_KEY");
});
