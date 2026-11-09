/**
 * audio-feed-oxyp1 — public capability feed routes are rate-limited and per-request work is bounded.
 *
 * Four rows, each pinning a required guarantee:
 *  (a) N requests allowed, N+1 refused 429 before any store read (seam counter).
 *  (b) An account with many pending episodes returns within the work bound rather than paging forever
 *      — assert the head() call count.
 *  (c) A normal small account is unaffected (all episodes present).
 *  (d) Refusal does not extend the window.
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import {
  FEED_IP_RATE,
  FEED_MAX_HEAD_CALLS,
  FEED_MAX_PAGES,
  FEED_TOKEN_RATE,
  FEED_TOKEN_WINDOW,
} from "../src/compose/feeds.ts";
import { SlidingWindowRateLimiter } from "../src/auth/rate_limit.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { MemoryBlobStore } from "../src/storage/memory.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { Episode } from "../src/types.ts";
import type { MetadataStore } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const TOKEN = "token-feed-limit";

const CLIENT = { remoteAddr: { hostname: "198.51.100.12" } };

function app(stores: Stores) {
  const ctx = { config: CONFIG, stores };
  return createApp(ctx, createHandlers(ctx));
}

async function seedUser(stores: Stores, userId = "user-1", feedToken = TOKEN): Promise<void> {
  await stores.metadata.putUser(
    makeUser({ id: userId, feedToken, status: "approved" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-a", userId, title: "Source A", modes: ["direct", "deepdive"] }),
  );
}

function counting(store: MetadataStore): { store: MetadataStore; reads: () => number } {
  let tenantReads = 0;
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      switch (prop) {
        case "getUserByFeedToken":
        case "listEpisodePage":
        case "listSources":
        case "listEpisodes":
        case "getSource":
        case "getArticles":
        case "getArticle":
        case "getEpisode":
          return (...args: unknown[]) => {
            tenantReads += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        default:
          return value.bind(target);
      }
    },
  });
  return { store: wrapped, reads: () => tenantReads };
}

async function drain(res: Response): Promise<string> {
  return await res.text();
}

function countXmlItems(xml: string): number {
  const matches = xml.match(/<item>/g);
  return matches ? matches.length : 0;
}

// Row (a): N requests allowed, N+1 refused 429 before any store read (seam counter)
Deno.test("feed routes: N requests allowed, N+1 refused 429 before any store read (audio-feed-oxyp1)", async () => {
  const inner = memoryStores();
  await seedUser(inner);
  await inner.metadata.putArticle(
    makeArticle({ id: "art-1", userId: "user-1", sourceId: "src-a", title: "Article 1" }),
  );
  await inner.metadata.putEpisode(
    makeEpisode({
      id: "ep-1",
      userId: "user-1",
      sourceId: "src-a",
      articleId: "art-1",
      title: "Article 1",
      status: "ready",
      audioKey: "audio/user-1/direct/ep-1.mp3",
      byteLength: 1024,
    }),
  );

  const { store, reads } = counting(inner.metadata);
  const { fetch } = app({ ...inner, metadata: store });

  // Requests up to FEED_TOKEN_RATE.maxRequests must succeed (status 200).
  for (let i = 0; i < FEED_TOKEN_RATE.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`), CLIENT);
    assertEquals(res.status, 200, `request ${i + 1} must be within the bound`);
    await drain(res);
  }

  const beforeRefusal = reads();
  assert(beforeRefusal > 0, "admitted requests must have performed real store reads");

  // N+1 request: must be refused with 429 and retry-after header.
  const refusedMaster = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`), CLIENT);
  assertEquals(refusedMaster.status, 429, "request past the token bound must be refused with 429");
  const retryAfter = refusedMaster.headers.get("retry-after");
  assert(
    retryAfter !== null && Number(retryAfter) >= 1,
    "429 must carry retry-after header of at least 1 second",
  );
  const contentType = refusedMaster.headers.get("content-type") ?? "";
  assert(contentType.startsWith("application/json"), `429 must be JSON, got "${contentType}"`);
  const body = JSON.parse(await drain(refusedMaster));
  assertEquals(body.error, "too_many_requests");

  // The refused request must have performed ZERO tenant store reads!
  assertEquals(
    reads(),
    beforeRefusal,
    "refused master feed request must cost zero tenant store reads",
  );

  // Per-source feed route shares the same token limiter and also refuses without store reads.
  const refusedSource = await fetch(
    new Request(`${BASE}/feed/${TOKEN}/src-a/direct.xml`),
    CLIENT,
  );
  assertEquals(refusedSource.status, 429);
  await drain(refusedSource);
  assertEquals(
    reads(),
    beforeRefusal,
    "refused per-source feed request must cost zero tenant store reads",
  );

  // Per-IP limiter also prevents token enumeration:
  // Using a distinct IP, exhaust the IP quota using varying fake tokens.
  const ENUM_CLIENT = { remoteAddr: { hostname: "198.51.100.99" } };
  for (let i = 0; i < FEED_IP_RATE.maxRequests; i++) {
    const res = await fetch(
      new Request(`${BASE}/feed/enum-probe-${i}/master.xml`),
      ENUM_CLIENT,
    );
    assertEquals(res.status, 404, `unknown token ${i + 1} 404s before IP limit`);
    await drain(res);
  }
  const readsAfterEnum = reads();

  // N+1 request from the same IP: refused by IP limiter BEFORE store read!
  const refusedEnum = await fetch(
    new Request(`${BASE}/feed/enum-probe-excess/master.xml`),
    ENUM_CLIENT,
  );
  assertEquals(refusedEnum.status, 429, "IP limit must refuse enumeration spray");
  await drain(refusedEnum);
  assertEquals(
    reads(),
    readsAfterEnum,
    "IP-refused request must not do any tenant store read",
  );
});

// Row (a): 600 pending/failed followed by 10 ready -> the feed contains all 10 ready episodes (audio-feed-oxyp1)
Deno.test("feed row (a): 600 pending/failed followed by 10 ready episodes yields all 10 ready episodes (audio-feed-oxyp1)", async () => {
  const stores = memoryStores();
  const REACH_TOKEN = "token-reach-test";
  await seedUser(stores, "user-reach", REACH_TOKEN);

  // 10 ready playable episodes, older createdAt so they sit behind pending/failed in newest-first scan.
  const baseTime = Date.parse("2026-09-01T10:00:00.000Z");
  for (let i = 0; i < 10; i++) {
    const id = `ready-${i}`;
    const key = `audio/user-reach/direct/${id}.mp3`;
    await stores.blobs.put(key, new Uint8Array(500), { contentType: "audio/mpeg" });
    await stores.metadata.putArticle(
      makeArticle({
        id: `art-${id}`,
        userId: "user-reach",
        sourceId: "src-a",
        title: `Ready Article ${i}`,
      }),
    );
    await stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-reach",
        sourceId: "src-a",
        articleId: `art-${id}`,
        title: `Ready Article ${i}`,
        status: "ready",
        audioKey: key,
        byteLength: 500,
        contentType: "audio/mpeg",
        createdAt: new Date(baseTime + i * 1000).toISOString(),
        readyAt: new Date(baseTime + i * 1000).toISOString(),
      }),
    );
  }

  // 600 newer pending/failed episodes (300 pending + 300 failed).
  // These sit ahead of the ready episodes in the newest-first index.
  const junkTime = Date.parse("2026-09-02T10:00:00.000Z");
  for (let i = 0; i < 600; i++) {
    const id = `junk-${i}`;
    const isFailed = i % 2 === 0;
    await stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-reach",
        sourceId: "src-a",
        title: `Junk Article ${id}`,
        status: isFailed ? ("failed" as const) : ("pending" as const),
        audioKey: undefined,
        byteLength: undefined,
        createdAt: new Date(junkTime + i * 1000).toISOString(),
      }),
    );
  }

  const { fetch } = app(stores);
  const res = await fetch(new Request(`${BASE}/feed/${REACH_TOKEN}/master.xml`), CLIENT);
  assertEquals(res.status, 200);
  const xml = await drain(res);

  // The feed must contain ALL 10 ready episodes, NOT 0!
  assertEquals(
    countXmlItems(xml),
    10,
    "feed must reach all 10 ready episodes despite 600 preceding junk records",
  );

  // Also verify against KvMetadataStore to prove reach across storage adapters:
  const kv = await Deno.openKv(":memory:");
  const kvStores: Stores = {
    metadata: new KvMetadataStore(kv, { ownsConnection: true }),
    blobs: new MemoryBlobStore(),
    describe: "blobs=memory metadata=kv",
  };
  await seedUser(kvStores, "user-kv-reach", REACH_TOKEN);
  for (let i = 0; i < 10; i++) {
    const id = `ready-${i}`;
    const key = `audio/user-kv-reach/direct/${id}.mp3`;
    await kvStores.blobs.put(key, new Uint8Array(500), { contentType: "audio/mpeg" });
    await kvStores.metadata.putArticle(
      makeArticle({
        id: `art-${id}`,
        userId: "user-kv-reach",
        sourceId: "src-a",
        title: `Ready Article ${i}`,
      }),
    );
    await kvStores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-kv-reach",
        sourceId: "src-a",
        articleId: `art-${id}`,
        title: `Ready Article ${i}`,
        status: "ready",
        audioKey: key,
        byteLength: 500,
        contentType: "audio/mpeg",
        createdAt: new Date(baseTime + i * 1000).toISOString(),
        readyAt: new Date(baseTime + i * 1000).toISOString(),
      }),
    );
  }
  for (let i = 0; i < 600; i++) {
    const id = `junk-${i}`;
    await kvStores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-kv-reach",
        sourceId: "src-a",
        title: `Junk Article ${id}`,
        status: i % 2 === 0 ? ("failed" as const) : ("pending" as const),
        createdAt: new Date(junkTime + i * 1000).toISOString(),
      }),
    );
  }
  const kvApp = app(kvStores);
  const kvRes = await kvApp.fetch(new Request(`${BASE}/feed/${REACH_TOKEN}/master.xml`), CLIENT);
  assertEquals(kvRes.status, 200);
  const kvXml = await drain(kvRes);
  assertEquals(
    countXmlItems(kvXml),
    10,
    "KV store feed must reach all 10 ready episodes despite 600 preceding junk records",
  );
  await kvStores.metadata.close();
});

// Row (b): a huge all-pending account still returns within the bound and does not page forever (audio-feed-oxyp1)
Deno.test("feed row (b): a huge all-pending account still returns within the bound and does not page forever (audio-feed-oxyp1)", async () => {
  const stores = memoryStores();
  await seedUser(stores);

  // 1,000 pending episodes (huge backlog of unfinished work).
  for (let i = 0; i < 1000; i++) {
    const id = `pending-${i}`;
    await stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-1",
        sourceId: "src-a",
        title: `Pending Article ${id}`,
        status: "pending" as Episode["status"],
        audioKey: `audio/user-1/direct/${id}.mp3`,
        byteLength: 0,
      }),
    );
  }

  // Instrument blob store to count head() calls.
  let headCalls = 0;
  const originalHead = stores.blobs.head.bind(stores.blobs);
  stores.blobs.head = (key: string) => {
    headCalls++;
    return originalHead(key);
  };

  // Instrument metadata store to count listEpisodePage calls.
  let pageCalls = 0;
  const originalListEpisodePage = stores.metadata.listEpisodePage.bind(stores.metadata);
  stores.metadata.listEpisodePage = (query) => {
    pageCalls++;
    return originalListEpisodePage(query);
  };

  const { fetch } = app(stores);
  const res = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`), CLIENT);
  assertEquals(res.status, 200);
  const xml = await drain(res);
  assert(xml.includes("<rss"), "master feed must be valid RSS XML");

  // Assertion: head() call count must be 0 because pending episodes are not publishable!
  assertEquals(
    headCalls,
    0,
    "pending episodes are not publishable and must NEVER trigger blob head() calls",
  );

  // Assertion: pagination must be bounded by FEED_MAX_PAGES (3), not paging 1000 episodes forever!
  assert(
    pageCalls <= FEED_MAX_PAGES,
    `pages scanned (${pageCalls}) must be capped at FEED_MAX_PAGES (${FEED_MAX_PAGES})`,
  );
  assertEquals(countXmlItems(xml), 0, "all-pending account has 0 publishable items");
});

// Row (c): a normal 30-episode account unchanged (audio-feed-oxyp1)
Deno.test("feed row (c): a normal 30-episode account unchanged (audio-feed-oxyp1)", async () => {
  const stores = memoryStores();
  await seedUser(stores);

  // 30 ready episodes: 15 direct and 15 deepdive.
  for (let i = 0; i < 30; i++) {
    const mode = i < 15 ? "direct" : "deepdive";
    const id = `normal-ep-${i}`;
    await stores.metadata.putArticle(
      makeArticle({
        id: `art-${id}`,
        userId: "user-1",
        sourceId: "src-a",
        title: `Article ${i}`,
      }),
    );
    await stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-1",
        sourceId: "src-a",
        articleId: `art-${id}`,
        title: `Article ${i}`,
        mode,
        status: "ready",
        audioKey: `audio/user-1/${mode}/${id}.mp3`,
        byteLength: 5000 + i,
      }),
    );
  }

  const { fetch } = app(stores);

  // Master feed: all 30 episodes must be present.
  const masterRes = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`), CLIENT);
  assertEquals(masterRes.status, 200);
  const masterXml = await drain(masterRes);
  assertEquals(countXmlItems(masterXml), 30, "master feed must carry all 30 episodes");

  // Per-source direct feed: exactly 15 direct episodes.
  const directRes = await fetch(
    new Request(`${BASE}/feed/${TOKEN}/src-a/direct.xml`),
    CLIENT,
  );
  assertEquals(directRes.status, 200);
  const directXml = await drain(directRes);
  assertEquals(countXmlItems(directXml), 15, "direct feed must carry all 15 direct episodes");

  // Per-source deepdive feed: exactly 15 deepdive episodes.
  const deepdiveRes = await fetch(
    new Request(`${BASE}/feed/${TOKEN}/src-a/deepdive.xml`),
    CLIENT,
  );
  assertEquals(deepdiveRes.status, 200);
  const deepdiveXml = await drain(deepdiveRes);
  assertEquals(countXmlItems(deepdiveXml), 15, "deepdive feed must carry all 15 deepdive episodes");
});

// Row (d): the head() cap row stays green (audio-feed-oxyp1)
Deno.test("feed row (d): the head() cap row stays green (audio-feed-oxyp1)", async () => {
  const stores = memoryStores();
  const LEGACY_TOKEN = "token-legacy-ready";
  await seedUser(stores, "user-legacy", LEGACY_TOKEN);

  // 50 ready episodes that have byteLength: 0.
  for (let i = 0; i < 50; i++) {
    const id = `legacy-ep-${i}`;
    const key = `audio/user-legacy/direct/${id}.mp3`;
    await stores.blobs.put(key, new Uint8Array(100), { contentType: "audio/mpeg" });
    await stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-legacy",
        sourceId: "src-a",
        title: `Legacy Article ${id}`,
        status: "ready",
        audioKey: key,
        byteLength: 0,
      }),
    );
  }

  let headCalls = 0;
  const originalHead = stores.blobs.head.bind(stores.blobs);
  stores.blobs.head = (key: string) => {
    headCalls++;
    return originalHead(key);
  };

  const { fetch } = app(stores);
  const legacyRes = await fetch(
    new Request(`${BASE}/feed/${LEGACY_TOKEN}/master.xml`),
    { remoteAddr: { hostname: "198.51.100.13" } },
  );
  assertEquals(legacyRes.status, 200);
  const legacyXml = await drain(legacyRes);

  // All 50 episodes are publishable and must appear in the feed.
  assertEquals(countXmlItems(legacyXml), 50, "all 50 legacy episodes must appear in the feed");

  // But head() calls must be strictly capped at FEED_MAX_HEAD_CALLS (30), not 50!
  assertEquals(
    headCalls,
    FEED_MAX_HEAD_CALLS,
    `head() calls (${headCalls}) must be capped at FEED_MAX_HEAD_CALLS (${FEED_MAX_HEAD_CALLS})`,
  );
});

// Silent-empty guard: feed never returns 200-with-zero-items when the store holds ready episodes (audio-feed-oxyp1)
Deno.test("feed silent-empty guard: feed never returns 200-with-zero-items when the store holds ready episodes (audio-feed-oxyp1)", async () => {
  const stores = memoryStores();
  const SILENT_TOKEN = "token-silent-empty";
  await seedUser(stores, "user-silent", SILENT_TOKEN);

  // 5 ready episodes sitting behind 600 pending/failed records.
  const baseTime = Date.parse("2026-09-01T10:00:00.000Z");
  for (let i = 0; i < 5; i++) {
    const id = `silent-ready-${i}`;
    const key = `audio/user-silent/direct/${id}.mp3`;
    await stores.blobs.put(key, new Uint8Array(200), { contentType: "audio/mpeg" });
    await stores.metadata.putArticle(
      makeArticle({
        id: `art-${id}`,
        userId: "user-silent",
        sourceId: "src-a",
        title: `Article ${i}`,
      }),
    );
    await stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-silent",
        sourceId: "src-a",
        articleId: `art-${id}`,
        title: `Article ${i}`,
        status: "ready",
        audioKey: key,
        byteLength: 200,
        contentType: "audio/mpeg",
        createdAt: new Date(baseTime + i * 1000).toISOString(),
        readyAt: new Date(baseTime + i * 1000).toISOString(),
      }),
    );
  }

  // 600 junk records ahead in the index.
  const junkTime = Date.parse("2026-09-02T10:00:00.000Z");
  for (let i = 0; i < 600; i++) {
    const id = `silent-junk-${i}`;
    await stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "user-silent",
        sourceId: "src-a",
        title: `Junk ${id}`,
        status: i % 2 === 0 ? "failed" : "pending",
        createdAt: new Date(junkTime + i * 1000).toISOString(),
      }),
    );
  }

  const { fetch } = app(stores);
  const res = await fetch(new Request(`${BASE}/feed/${SILENT_TOKEN}/master.xml`), CLIENT);
  assertEquals(res.status, 200, "feed returns 200 OK");
  const xml = await drain(res);

  const items = countXmlItems(xml);
  // Must NOT be 0 (the silent-empty defect)!
  assert(
    items > 0,
    `feed must never return 200 with zero items when ready episodes exist in the store (got ${items})`,
  );
  assertEquals(items, 5, "feed must contain all 5 ready episodes");
});

// Row (d): refusal does not extend the window
Deno.test("feed rate limit: refusal does not extend the window (audio-feed-oxyp1)", async () => {
  const stores = memoryStores();
  await seedUser(stores);
  const { fetch } = app(stores);

  // Exhaust the token limit.
  for (let i = 0; i < FEED_TOKEN_RATE.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`), CLIENT);
    assertEquals(res.status, 200);
    await drain(res);
  }

  // Refusal 1 (N+1).
  const ref1 = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`), CLIENT);
  assertEquals(ref1.status, 429);
  await drain(ref1);

  // Refusal 2 (N+2).
  const ref2 = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`), CLIENT);
  assertEquals(ref2.status, 429);
  await drain(ref2);

  // Refusal 3 (N+3).
  const ref3 = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`), CLIENT);
  assertEquals(ref3.status, 429);
  await drain(ref3);

  // Verify that the store recorded exactly FEED_TOKEN_RATE.maxRequests entries, not N+3.
  const stored = await stores.metadata.atomicUpdate<number[]>(
    `${FEED_TOKEN_WINDOW}:${TOKEN}`,
    () => null,
  );
  assertEquals(
    stored.value?.length,
    FEED_TOKEN_RATE.maxRequests,
    "refused attempts must not record additional hits or extend the window",
  );

  // Verify that once the window rolls past the oldest hit, the token recovers without lockout.
  assert(stored.value && stored.value.length > 0, "window must contain recorded timestamps");
  const oldestHit = stored.value[0]!;
  const laterTime = oldestHit + FEED_TOKEN_RATE.windowMs + 10;
  const limiter = new SlidingWindowRateLimiter(FEED_TOKEN_RATE, stores.metadata, FEED_TOKEN_WINDOW);
  const probe = await limiter.check(TOKEN, laterTime);
  assertEquals(
    probe.allowed,
    true,
    "client recovers automatically once the sliding window rolls past the oldest hit",
  );
});
