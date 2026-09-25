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
import type { AppContext } from "../src/app.ts";
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

  assertEquals(jobs.registered, 2);
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
  assertEquals(jobs.registered, 1);
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

Deno.test("registerCronJobs: idle synthesis ticks are recorded as idle, and kept as one row (audio-feed-0ob)", async () => {
  // Nothing is pending, so every tick finds nothing to do: the common case on
  // Deploy, where this job runs every 2 minutes.
  const stores: Stores = memoryStores();
  const registered: CronRegistration[] = [];
  const mockCron = (name: string, schedule: string, handler: () => Promise<void>) => {
    registered.push({ name, schedule, handler });
  };
  registerCronJobs({ config, stores }, {
    cron: mockCron,
    synthesizer: () => Promise.resolve(mockAudio()),
  });

  const synthJob = registered.find((j) => j.name === "audio-feed-synthesis");
  assert(synthJob);
  for (let i = 0; i < 3; i++) await synthJob.handler();

  const runs = await stores.metadata.listRuns();
  assertEquals(runs.map((r) => [r.kind, r.idle]), [["synthesis", true]]);
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

Deno.test("concurrent feed polls with immediate fetchArticle do not duplicate (audio-feed-33m)", async () => {
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
    // Immediate resolve with no setTimeout / delay (the degenerate case that broke pre-33m)
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
    "exactly 2 episodes must be queued even with immediate synchronous resolution",
  );
  const episodes = await stores.metadata.listEpisodes({ userId: "u1" });
  assertEquals(episodes.length, 2, "storage must contain exactly 2 distinct episodes");
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

// ---------------------------------------------------------------------------
// audio-feed-2j5 — distinguish "no cron here" from "nothing to register", and
// exercise the REAL Deno.cron when the runtime offers it.
// ---------------------------------------------------------------------------

Deno.test("registerCronJobs: an unavailable Deno.cron is a loud, distinguishable failure", () => {
  // The old shape returned [], which read as "registered nothing" and was
  // indistinguishable from a successful no-op. A deployment whose background jobs
  // never scheduled looked exactly like a healthy one.
  const stores: Stores = memoryStores();
  const ctx = { config, stores };

  const result = registerCronJobs(ctx, {
    // Explicitly absent: models a runtime with no Deno.cron and no injected mock.
    cron: undefined as unknown as (
      name: string,
      schedule: string,
      handler: () => Promise<void>,
    ) => void,
  });

  if (typeof (globalThis as { Deno?: { cron?: unknown } }).Deno?.cron === "function") {
    // Under --unstable-cron the real API exists, so registration must succeed.
    assertEquals(result.ok, true, "real Deno.cron must accept registration");
    assertEquals(result.registered, 2);
    assertEquals(
      result.jobs.map((j) => j.name).sort(),
      ["audio-feed-poll-feeds", "audio-feed-synthesis"],
      "both job names must reach the real platform API",
    );
    assertEquals(
      result.jobs.find((j) => j.name === "audio-feed-poll-feeds")?.schedule,
      "*/15 * * * *",
    );
    assertEquals(
      result.jobs.find((j) => j.name === "audio-feed-synthesis")?.schedule,
      "*/2 * * * *",
    );
  } else {
    // Without the flag this branch asserts the NEW behaviour. Both paths assert
    // something: a test that silently skips is green while covering nothing.
    assertEquals(result.ok, false);
    assertEquals(result.reason, "cron-unavailable");
    assertEquals(result.registered, 0);
    assertEquals(result.jobs.length, 0);
  }
});

Deno.test("registerCronJobs: the unavailable-cron warning is emitted, not just the return value", () => {
  // Added because mutation proved the return value alone did not pin the warning:
  // deleting the console.warn while keeping `ok: false` left every test green. The
  // structured result tells a caller; the warning is what tells an operator reading
  // deploy logs, and audio-feed-2j5 exists because this path was silent.
  //
  // This test deliberately does NOT call registerCronJobs when the real Deno.cron is
  // present. Measured under --unstable-cron: a second registration in the same
  // process throws "Cron with this name already exists" from ext:deno_cron, because
  // real cron is keyed by name and is NOT idempotent. The preceding test already
  // performed the one real registration this process is allowed, so re-entering here
  // would assert on a platform collision rather than on this behaviour. That
  // non-idempotence is itself a finding for audio-feed-tgc/ncf and is recorded there.
  if (typeof (globalThis as { Deno?: { cron?: unknown } }).Deno?.cron === "function") {
    console.log(
      "SKIP: warning path unreachable while Deno.cron exists; asserted by the normal gate",
    );
    return;
  }

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  let result: ReturnType<typeof registerCronJobs>;
  try {
    const stores: Stores = memoryStores();
    result = registerCronJobs({ config, stores } as AppContext, {
      cron: undefined as unknown as (
        name: string,
        schedule: string,
        handler: () => Promise<void>,
      ) => void,
    });
  } finally {
    console.warn = original;
  }

  assertEquals(result.ok, false);
  const hit = warnings.find((w) => w.includes("Deno.cron is unavailable"));
  assert(
    hit,
    `expected a warning naming Deno.cron unavailability, got: ${JSON.stringify(warnings)}`,
  );
  // Actionable, not merely descriptive: it must say what will not happen.
  assertStringIncludes(hit, "not scheduled");
});
