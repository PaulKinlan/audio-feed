/**
 * Composition-root acceptance check (audio-feed-agl).
 *
 * The bug this exists to prevent: every lane had landed and was tested in
 * isolation, `createApp` defaulted each seam to `notImplemented()`, and no module
 * imported the others — so ingest, both feed routes and admin approval all
 * answered 501 on a server that booted and reported /health 200.
 *
 * These assertions therefore drive the REAL dispatch function that Deno.serve
 * receives, seed a user/source/ready episode, and then do the thing the product
 * promises: subscribe to a feed URL, read the enclosure out of it, and fetch the
 * audio that enclosure points at.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { pollFeedSource } from "../src/ingest/feed.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { bytes, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { MetadataStore } from "../src/storage/mod.ts";
import type { AppConfig } from "../src/config.ts";
import type { ExtractedArticle } from "../src/ingest/url.ts";
import type { Stores } from "../src/config.ts";
import type { Article, Episode } from "../src/types.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

const ARTICLE: ExtractedArticle = {
  url: "https://example.com/an-article",
  title: "An Ingested Article",
  author: "A. Writer",
  publishedAt: "2026-09-01T00:00:00.000Z",
  lead: "A short lead.",
  body: "The full body text that would be narrated.",
};

/** An app whose stores are seeded, with the composition root mounted. */
async function seededApp() {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putUser(
    makeUser({ id: "pending-1", email: "p@example.com", status: "pending" }),
  );
  await stores.metadata.putSource(makeSource({ id: "stratechery", userId: "user-1" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "stratechery",
      status: "ready",
      mode: "direct",
      audioKey: "episode-1.mp3",
      byteLength: AUDIO.length,
      contentType: "audio/mpeg",
      durationSeconds: 12,
    }),
  );
  await stores.blobs.put("episode-1.mp3", AUDIO, { contentType: "audio/mpeg" });
  const handlers = createHandlers({ config, stores }, {
    fetchArticle: () => Promise.resolve(ARTICLE),
  });
  const { fetch } = createApp({ config, stores }, handlers);
  return { fetch, stores };
}

const AUDIO = bytes(2048);
const req = (path: string, init?: RequestInit) =>
  new Request(`${BASE}${path}`, { ...init, headers: { ...(init?.headers ?? {}) } });

/** The `<enclosure url=…>` a podcast client would subscribe to. */
function enclosureUrl(xml: string): string | null {
  return xml.match(/<enclosure url="([^"]+)"/)?.[1] ?? null;
}

Deno.test("a failed inbox write poisons no URL: the feed still turns it into audio (audio-feed-d8q)", async () => {
  // The seam this exists for. The inbox enqueue and the feed poller are different code,
  // but they share ONE fact: queueItems skips a URL whose ARTICLE exists. So while the
  // inbox wrote the two records in two steps, one failed putEpisode left an article with
  // no audio behind it, and every later poll of a feed carrying that URL skipped it.
  // Measured on main before the pair write existed: queued=0 skipped=1 episodes=0, with
  // nothing reporting an error after the first poll.
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  const source = makeSource({ id: "example", userId: "user-1" });
  await stores.metadata.putSource(source);

  const inner = stores.metadata;
  let refuse = true;
  // The seam is "the write that would create this item's episode fails once", attached to
  // both spellings of that write — `putEpisode` on the old two-step inbox, the pair method
  // on the new one — so the test discriminates between them rather than only exercising
  // the code that exists today. Methods bind to the real instance: a Proxy receiver would
  // break the store's private fields instead of the behaviour under test.
  const flaky = new Proxy(inner, {
    get(target, prop) {
      if (prop === "putArticleWithEpisode" || prop === "putEpisode") {
        const name = prop;
        return (arg1: unknown, arg2: unknown) => {
          if (refuse) {
            refuse = false;
            return Promise.reject(new Error("store unavailable"));
          }
          if (name === "putEpisode") {
            return target.putEpisode(arg1 as Parameters<MetadataStore["putEpisode"]>[0]);
          }
          return target.putArticleWithEpisode(arg1 as Article, arg2 as Episode);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MetadataStore;

  const ctx = { config, stores: { ...stores, metadata: flaky } };
  const handlers = createHandlers(ctx, { fetchArticle: () => Promise.resolve(ARTICLE) });
  const { fetch } = createApp(ctx, handlers);

  const res = await fetch(req("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-feed-token": "token-user-1" },
    body: JSON.stringify({ url: ARTICLE.url, mode: "direct" }),
  }));
  assertEquals(res.status, 503);
  // Nothing was recorded, so the URL is not claimed.
  assertEquals(await stores.metadata.findArticleByUrl("user-1", ARTICLE.url), null);
  assertEquals((await stores.metadata.listEpisodes({ userId: "user-1" })).length, 0);

  // The same URL now arrives through a feed. This is the assertion that fails on the
  // old two-step inbox: it saw the orphan article and skipped the item forever.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Example</title>
      <item><title>An Ingested Article</title><link>${ARTICLE.url}</link>
        <description><![CDATA[<p>A short lead.</p>]]></description></item>
    </channel></rss>`;
  const poll = await pollFeedSource({ config, stores }, source, {
    transport: () =>
      Promise.resolve(
        new Response(xml, {
          status: 200,
          headers: { "content-type": "application/rss+xml; charset=utf-8" },
        }),
      ),
    fetchArticle: () => Promise.resolve(ARTICLE),
  });
  assertEquals(poll.queued, 1, "the URL must still be queueable after the failed inbox write");
  assertEquals(poll.skipped, 0);
  const episodes = await stores.metadata.listEpisodes({ userId: "user-1" });
  assertEquals(episodes.length, 1);
  assertEquals(episodes[0]!.status, "pending");
});

// ---------------------------------------------------------------------------
// The headline: a feed URL is subscribable and its enclosure is playable
// ---------------------------------------------------------------------------

Deno.test("a subscriber can read the feed, take the enclosure and fetch the audio", async () => {
  const { fetch } = await seededApp();

  const feed = await fetch(req("/feed/token-user-1/master.xml"));
  assertEquals(feed.status, 200);
  assertStringIncludes(feed.headers.get("content-type") ?? "", "application/rss+xml");
  const xml = await feed.text();
  assertStringIncludes(xml, '<rss version="2.0"');
  assertStringIncludes(xml, "Stratechery: An Article");

  const enclosure = enclosureUrl(xml);
  assert(enclosure, "the feed must advertise an enclosure");
  assertStringIncludes(enclosure, "/audio/episode-1.mp3");

  // The enclosure must actually resolve: a feed pointing at a 404 is not a product.
  const audio = await fetch(new Request(enclosure));
  assertEquals(audio.status, 200);
  assertEquals(audio.headers.get("content-type"), "audio/mpeg");
  assertEquals((await audio.bytes()).length, AUDIO.length);

  // Podcast clients seek, so the enclosure must support ranges.
  const partial = await fetch(new Request(enclosure, { headers: { range: "bytes=0-99" } }));
  assertEquals(partial.status, 206);
  assertStringIncludes(partial.headers.get("content-range") ?? "", "bytes 0-99/");
});

Deno.test("the feed advertises the route that is actually served (tww contract)", async () => {
  const { fetch } = await seededApp();

  const master = await (await fetch(req("/feed/token-user-1/master.xml"))).text();
  assertStringIncludes(master, `<atom:link href="${BASE}/feed/token-user-1/master.xml"`);

  const source = await fetch(req("/feed/token-user-1/stratechery/direct.xml"));
  assertEquals(source.status, 200);
  const xml = await source.text();
  assertStringIncludes(xml, `<atom:link href="${BASE}/feed/token-user-1/stratechery/direct.xml"`);
  // The self-link must be a served route, not the origin-only helper's guess.
  assertEquals((await fetch(req("/feed/token-user-1/stratechery/direct.xml"))).status, 200);
});

Deno.test("an enclosure length comes from the store when the record lacks one", async () => {
  const { fetch, stores } = await seededApp();
  // A record written before synthesis finished carries no byteLength; the
  // enclosure must still publish the real size rather than 0, which would make
  // players guess (and is what a seeded/legacy record actually looks like).
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-2",
      userId: "user-1",
      sourceId: "stratechery",
      status: "ready",
      audioKey: "episode-2.mp3",
      byteLength: undefined,
      contentType: "audio/mpeg",
    }),
  );
  await stores.blobs.put("episode-2.mp3", bytes(999), { contentType: "audio/mpeg" });
  // 0 is not a real audio size either — it is the same "unknown" state, and the
  // live harness produced exactly that, so both spellings are asserted.
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-3",
      userId: "user-1",
      sourceId: "stratechery",
      status: "ready",
      audioKey: "episode-3.mp3",
      byteLength: 0,
      contentType: "audio/mpeg",
    }),
  );
  await stores.blobs.put("episode-3.mp3", bytes(777), { contentType: "audio/mpeg" });

  const xml = await (await fetch(req("/feed/token-user-1/master.xml"))).text();
  assertStringIncludes(xml, `<enclosure url="${BASE}/audio/episode-2.mp3" length="999"`);
  assertStringIncludes(xml, `<enclosure url="${BASE}/audio/episode-3.mp3" length="777"`);
  assertStringIncludes(
    xml,
    `<enclosure url="${BASE}/audio/episode-1.mp3" length="${AUDIO.length}"`,
  );
});

Deno.test("only publishable episodes are syndicated", async () => {
  const { fetch, stores } = await seededApp();
  await stores.metadata.putEpisode(
    makeEpisode({ id: "episode-2", userId: "user-1", status: "pending", audioKey: undefined }),
  );
  const xml = await (await fetch(req("/feed/token-user-1/master.xml"))).text();
  assert(xml.includes("episode-1"), "ready episode must be listed");
  assert(!xml.includes("episode-2"), "an episode with no audio must not be syndicated");
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

Deno.test("unapproved users have no feed, and unknown tokens are 404", async () => {
  const { fetch } = await seededApp();
  assertEquals((await fetch(req("/feed/token-pending-1/master.xml"))).status, 403);
  assertEquals((await fetch(req("/feed/nobody/master.xml"))).status, 404);
  assertEquals((await fetch(req("/feed/token-user-1/unknown-source/direct.xml"))).status, 404);
});

Deno.test("ingest queues for an approved user and refuses everyone else", async () => {
  const { fetch, stores } = await seededApp();
  const body = JSON.stringify({ url: "https://example.com/an-article", mode: "direct" });
  const json = { "content-type": "application/json", "x-feed-token": "token-user-1" };

  const queued = await fetch(req("/api/ingest", { method: "POST", headers: json, body }));
  assertEquals(queued.status, 202);
  const job = await queued.json();
  assertEquals(job.status, "queued");
  assertEquals(job.mode, "direct");
  // 202 means queued, not synthesized: the record must say pending.
  const stored = await stores.metadata.getEpisode("user-1", job.episodeId);
  assertEquals(stored?.status, "pending");

  assertEquals(
    (await fetch(
      req("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body }),
    )).status,
    403,
  );
  assertEquals(
    (await fetch(req("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-feed-token": "token-pending-1" },
      body,
    }))).status,
    403,
    "a pending user must not be able to spend synthesis money",
  );
});

Deno.test("admin approval requires the admin token and refuses unknown users", async () => {
  const { fetch, stores } = await seededApp();

  assertEquals(
    (await fetch(req("/api/admin/users/pending-1/approve", { method: "POST" }))).status,
    401,
  );
  assertEquals(
    (await fetch(req("/api/admin/users/pending-1/approve", {
      method: "POST",
      headers: { "x-admin-token": "wrong" },
    }))).status,
    401,
  );
  assertEquals((await stores.metadata.getUser("pending-1"))?.status, "pending");

  const approved = await fetch(req("/api/admin/users/pending-1/approve", {
    method: "POST",
    headers: { "x-admin-token": "admin-secret" },
  }));
  assertEquals(approved.status, 200);
  assertEquals((await approved.json()).status, "approved");
  assertEquals((await stores.metadata.getUser("pending-1"))?.status, "approved");

  assertEquals(
    (await fetch(req("/api/admin/users/ghost/approve", {
      method: "POST",
      headers: { "x-admin-token": "admin-secret" },
    }))).status,
    404,
  );
});

Deno.test("an unconfigured admin token cannot approve anyone", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "pending-1", status: "pending" }));
  const { fetch } = createApp(
    { config: { port: 8000, publicBaseUrl: BASE }, stores },
    createHandlers({ config: { port: 8000, publicBaseUrl: BASE }, stores }),
  );
  assertEquals(
    (await fetch(req("/api/admin/users/pending-1/approve", { method: "POST" }))).status,
    403,
  );
  assertEquals((await stores.metadata.getUser("pending-1"))?.status, "pending");
});

// ---------------------------------------------------------------------------
// The regression itself: nothing 501s once the composition root is mounted
// ---------------------------------------------------------------------------

Deno.test("no product route answers 501 when handlers are mounted", async () => {
  const { fetch } = await seededApp();
  const routes: Array<[string, RequestInit]> = [
    ["/feed/token-user-1/master.xml", {}],
    ["/feed/token-user-1/stratechery/direct.xml", {}],
    ["/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }],
    ["/api/admin/users/user-1/approve", { method: "POST" }],
  ];
  for (const [path, init] of routes) {
    const res = await fetch(req(path, init));
    assert(res.status !== 501, `${path} still answers 501 — the seam is unwired`);
  }
});

Deno.test("without handlers the seams still fail closed rather than open", async () => {
  // The unwired server (createApp with no handlers) is exactly the state agl
  // fixed: it must be OBVIOUSLY unwired, never silently permissive.
  const stores = memoryStores();
  const { fetch } = createApp({ config, stores });
  assertEquals((await fetch(req("/feed/token-user-1/master.xml"))).status, 501);
  assertEquals(
    (await fetch(req("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }))).status,
    501,
  );
  assertEquals(
    (await fetch(req("/api/admin/users/user-1/approve", { method: "POST" }))).status,
    501,
  );
});

// ---------------------------------------------------------------------------
// audio-feed-ruw: the feed capability is the feedToken, and ONLY the feedToken
// ---------------------------------------------------------------------------

Deno.test("a user id is not a feed capability", async () => {
  const { fetch } = await seededApp();

  // While the canonical User had no `feedToken`, the feed path fell back to
  // `getUser(token)`, so the id doubled as the capability. User ids are not
  // secret: they appear in `/api/episodes?userId=`, in the admin approve path,
  // and in this file's own 202 ingest body. Anyone who learned an id could read
  // that user's whole feed.
  assertEquals(
    (await fetch(req("/feed/user-1/master.xml"))).status,
    404,
    "a user id must not open a feed",
  );
  assertEquals(
    (await fetch(req("/feed/user-1/stratechery/direct.xml"))).status,
    404,
    "a user id must not open a per-source feed",
  );

  // And the real capability still works, so this is a narrowing, not a break.
  assertEquals((await fetch(req("/feed/token-user-1/master.xml"))).status, 200);
});

Deno.test("a user id is not accepted as an ingest credential", async () => {
  const { fetch } = await seededApp();
  const body = JSON.stringify({ url: "https://example.com/an-article", mode: "direct" });

  const withId = await fetch(req("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-feed-token": "user-1" },
    body,
  }));
  assertEquals(withId.status, 403, "a user id must not authorize paid synthesis");

  const withToken = await fetch(req("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-feed-token": "token-user-1" },
    body,
  }));
  assertEquals(withToken.status, 202);
});

Deno.test("one user's capability never opens another user's feed", async () => {
  const { fetch, stores } = await seededApp();
  await stores.metadata.putUser(
    makeUser({ id: "user-2", email: "other@example.com", status: "approved" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-other",
      userId: "user-2",
      sourceId: "stratechery",
      status: "ready",
      audioKey: "episode-other.mp3",
      contentType: "audio/mpeg",
    }),
  );

  const mine = await (await fetch(req("/feed/token-user-1/master.xml"))).text();
  assert(mine.includes("episode-1"), "own episode must be present");
  assert(!mine.includes("episode-other"), "another user's episode must never appear in my feed");
});

Deno.test("approval writes a ledger entry atomically with the status change", async () => {
  const { fetch, stores } = await seededApp();

  // Before ruw the approve route wrote only the user record, so the audit trail
  // did not exist. The ledger is only worth having if it cannot drift from the
  // decision it describes, which is why both are one commit.
  const approved = await fetch(req("/api/admin/users/pending-1/approve", {
    method: "POST",
    headers: { "x-admin-token": "admin-secret" },
  }));
  assertEquals(approved.status, 200);

  const body = await approved.json();
  assertEquals(body.status, "approved");
  assert(body.decidedAt, "the response must report when the decision was made");

  const log = await stores.metadata.listApprovalLog();
  assertEquals(log.length, 1, "an approval must leave exactly one ledger record");
  assertEquals(log[0]?.userId, "pending-1");
  assertEquals(log[0]?.action, "approved");
});

Deno.test("no route echoes a feed capability", async () => {
  const { fetch, stores } = await seededApp();
  const user = await stores.metadata.getUser("user-1");
  assert(user);

  // A leaked token grants feed access until it is rotated, and rotation breaks
  // every subscribed client. So no response body may contain one.
  const responses = [
    await fetch(req("/api/admin/users/pending-1/approve", {
      method: "POST",
      headers: { "x-admin-token": "admin-secret" },
    })),
    await fetch(req("/api/episodes?userId=user-1", {
      headers: { "x-feed-token": "token-user-1" },
    })),
    await fetch(req("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-feed-token": "token-user-1" },
      body: JSON.stringify({ url: "https://example.com/an-article", mode: "direct" }),
    })),
  ];

  for (const response of responses) {
    const text = await response.text();
    assert(
      !text.includes("feedToken"),
      `a response leaked the feedToken key: ${text.slice(0, 200)}`,
    );
    assert(
      !text.includes(user.feedToken),
      `a response leaked a feed token value: ${text.slice(0, 200)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// audio-feed-4fm: master.xml ignores query parameters and caps at 200 items
// ---------------------------------------------------------------------------

Deno.test("master.xml ignores query parameters and returns 200 across all sources (audio-feed-4fm)", async () => {
  const { fetch, stores } = await seededApp();
  // Add a second source and episode to verify multi-source aggregation.
  await stores.metadata.putSource(
    makeSource({ id: "daringfireball", userId: "user-1", title: "Daring Fireball" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-2",
      userId: "user-1",
      sourceId: "daringfireball",
      sourceTitle: "Daring Fireball",
      status: "ready",
      title: "Another Article",
      audioKey: "audio/user-1/direct/episode-2.mp3",
      createdAt: "2026-09-02T00:00:00.000Z",
      readyAt: "2026-09-02T00:05:00.000Z",
    }),
  );

  // A client appending ?sourceId=stratechery must get 200 (not 400),
  // and must receive the whole aggregated feed (including daringfireball),
  // because master.xml is unfiltered by design to tolerate podcast aggregators.
  const res = await fetch(req("/feed/token-user-1/master.xml?sourceId=stratechery"));
  assertEquals(res.status, 200);
  const xml = await res.text();
  assertStringIncludes(xml, "Stratechery: An Article");
  assertStringIncludes(xml, "Daring Fireball: Another Article");

  // Arbitrary cache-busting or tracking parameters must also be accepted with 200.
  const cacheBust = await fetch(
    req("/feed/token-user-1/master.xml?tracking=client123&t=1727218800&_cb=987"),
  );
  assertEquals(cacheBust.status, 200);
  assertStringIncludes(
    await cacheBust.text(),
    `<atom:link href="${BASE}/feed/token-user-1/master.xml"`,
  );
});

Deno.test("master.xml and per-source feeds cap output to newest 200 episodes (audio-feed-4fm)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(
    makeSource({ id: "src-1", userId: "user-1", title: "Source 1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-2", userId: "user-1", title: "Source 2" }),
  );

  // Seed 250 ready episodes across src-1 and src-2 with monotonically increasing timestamps.
  for (let i = 0; i < 250; i++) {
    const pad = String(i).padStart(3, "0");
    const sourceId = i % 2 === 0 ? "src-1" : "src-2";
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-${pad}`,
        userId: "user-1",
        sourceId,
        sourceTitle: sourceId === "src-1" ? "Source 1" : "Source 2",
        status: "ready",
        title: `Episode ${pad}`,
        audioKey: `audio/user-1/direct/ep-${pad}.mp3`,
        byteLength: 500,
        createdAt: ts,
        readyAt: ts,
      }),
    );
  }

  const handlers = createHandlers({ config, stores });
  const { fetch } = createApp({ config, stores }, handlers);

  // 1. Master feed is capped to 200 episodes.
  const masterRes = await fetch(req("/feed/token-user-1/master.xml"));
  assertEquals(masterRes.status, 200);
  const masterXml = await masterRes.text();
  const masterItems = masterXml.match(/<item>/g) ?? [];
  assertEquals(masterItems.length, 200, "master.xml must cap at 200 episodes");

  // The 200 returned should be the newest (ep-050 through ep-249), omitting ep-000 through ep-049.
  assertStringIncludes(masterXml, "Episode 249");
  assertStringIncludes(masterXml, "Episode 050");
  assert(
    !masterXml.includes("<title>Source 1: Episode 000</title>"),
    "oldest episode 000 must be omitted",
  );
  assert(
    !masterXml.includes("<title>Source 2: Episode 049</title>"),
    "oldest episode 049 must be omitted",
  );

  // 2. Per-source feed is also capped to 200 episodes if a source has >200.
  // Add 100 more episodes into src-1 (src-1 now has 125 + 100 = 225 episodes).
  for (let i = 250; i < 350; i++) {
    const pad = String(i).padStart(3, "0");
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-${pad}`,
        userId: "user-1",
        sourceId: "src-1",
        sourceTitle: "Source 1",
        status: "ready",
        title: `Episode ${pad}`,
        audioKey: `audio/user-1/direct/ep-${pad}.mp3`,
        byteLength: 500,
        createdAt: ts,
        readyAt: ts,
      }),
    );
  }

  const srcRes = await fetch(req("/feed/token-user-1/src-1/direct.xml"));
  assertEquals(srcRes.status, 200);
  const srcXml = await srcRes.text();
  const srcItems = srcXml.match(/<item>/g) ?? [];
  assertEquals(srcItems.length, 200, "per-source feed must also cap at 200 episodes");
  assertStringIncludes(srcXml, "Episode 349");
});

// ---------------------------------------------------------------------------
// audio-feed-2w8 — the feed cap is a cap on PUBLISHABLE episodes, not on episodes listed
// ---------------------------------------------------------------------------

/**
 * The feed is capped to the newest 200 episodes. Listing the newest 200 of ANY status and
 * filtering afterwards means every pending or failed episode among them silently removes a
 * playable episode from a subscriber's feed: after a large feed poll, or a large
 * "Regenerate all", the oldest ready episodes fall off the end even though plenty of ready
 * work exists to replace them.
 *
 * The player was fixed this way in audio-feed-8oz (listen.ts pages until it has its 100);
 * the RSS builder is the same bug on the other side of the same seam.
 */
async function feedWithEpisodes(ready: number, newerUnpublishable: number) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "stratechery", userId: "user-1" }));
  // `ready` playable episodes, all OLDER than the ones below. createdAt is the listing key,
  // so the newest entries are the ones that would push ready episodes off a capped page.
  for (let i = 0; i < ready; i++) {
    await stores.metadata.putEpisode(makeEpisode({
      id: `ready-${i}`,
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-1",
      title: `Ready article ${i}`,
      status: "ready",
      mode: "direct",
      audioKey: `ready-${i}.mp3`,
      byteLength: 1024,
      contentType: "audio/mpeg",
      createdAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    }));
  }
  // Newer, NOT publishable: pending with no audio yet, and failed.
  for (let i = 0; i < newerUnpublishable; i++) {
    await stores.metadata.putEpisode(makeEpisode({
      id: `pending-${i}`,
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-1",
      title: `Pending article ${i}`,
      status: "pending",
      mode: "direct",
      audioKey: undefined,
      byteLength: undefined,
      createdAt: new Date(Date.UTC(2026, 8, 20) + i * 60_000).toISOString(),
    }));
  }
  const handlers = createHandlers({ config, stores }, {
    fetchArticle: () => Promise.resolve(ARTICLE),
  });
  const { fetch } = createApp({ config, stores }, handlers);
  return { fetch, stores };
}

const itemCount = (xml: string) => (xml.match(/<item>/g) ?? []).length;

Deno.test("the master feed carries 200 playable episodes when newer pending ones exist (audio-feed-2w8)", async () => {
  const { fetch } = await feedWithEpisodes(200, 5);
  const xml = await (await fetch(req("/feed/token-user-1/master.xml"))).text();
  assertEquals(
    itemCount(xml),
    200,
    "5 pending episodes must not shrink the feed below its 200 cap — the cap is on playable items",
  );
});

Deno.test("a per-source feed carries 200 playable episodes when newer failed ones exist (audio-feed-2w8)", async () => {
  const { fetch, stores } = await feedWithEpisodes(200, 5);
  for (let i = 0; i < 5; i++) {
    await stores.metadata.putEpisode(makeEpisode({
      id: `failed-${i}`,
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-1",
      title: `Failed article ${i}`,
      status: "failed",
      mode: "direct",
      error: "synthesis failed",
      createdAt: new Date(Date.UTC(2026, 8, 25) + i * 60_000).toISOString(),
    }));
  }
  const xml = await (await fetch(req("/feed/token-user-1/stratechery/direct.xml"))).text();
  assertEquals(
    itemCount(xml),
    200,
    "newer failed episodes must not cost a subscriber 5 playable items",
  );
});

Deno.test("the feed stops at the real episode count and does not pad (audio-feed-2w8)", async () => {
  const { fetch } = await feedWithEpisodes(7, 3);
  const xml = await (await fetch(req("/feed/token-user-1/master.xml"))).text();
  assertEquals(
    itemCount(xml),
    7,
    "with fewer than 200 playable episodes the feed carries what exists",
  );
});

// ---------------------------------------------------------------------------
// GET /api/episodes — the caller's OWN listing (audio-feed-nx3o)
//
// The route used to read `userId` from the query string and return that
// subscriber's Episode records — title, description, status, audioKey — to
// anyone. User ids are not secret, so a known id was a full catalogue read, and
// each returned audioKey then opened /audio/<key> (which answers
// access-control-allow-origin: *). These assertions drive the real dispatch
// function Deno.serve receives, with real credentials.
// ---------------------------------------------------------------------------

Deno.test("episodes: an unauthenticated caller gets nothing, even for a known id", async () => {
  const { fetch } = await seededApp();
  assertEquals((await fetch(req("/api/episodes"))).status, 403);
  assertEquals((await fetch(req("/api/episodes?userId=user-1"))).status, 403);
  assertEquals((await fetch(req("/api/episodes?userId=ghost"))).status, 403);
});

Deno.test("episodes: another subscriber's userId is refused (audio-feed-nx3o)", async () => {
  const { fetch, stores } = await seededApp();
  await stores.metadata.putUser(makeUser({ id: "user-2", email: "two@example.com" }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "episode-2",
    userId: "user-2",
    sourceId: "stratechery",
    title: "Their Private Article",
    audioKey: "audio/user-2/direct/episode-2.mp3",
  }));

  const res = await fetch(req("/api/episodes?userId=user-2", {
    headers: { "x-feed-token": "token-user-1" },
  }));
  assertEquals(res.status, 403);
  const text = await res.text();
  assert(!text.includes("Their Private Article"), "no other subscriber's data may leak");
  assert(!text.includes("audio/user-2/"), "no other subscriber's audioKey may leak");
});

Deno.test("episodes: the token names the caller, so the listing is theirs", async () => {
  const { fetch, stores } = await seededApp();
  await stores.metadata.putUser(makeUser({ id: "user-2", email: "two@example.com" }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "episode-2",
    userId: "user-2",
    sourceId: "stratechery",
  }));

  // `userId` is optional, and when present it can only name the caller.
  for (const path of ["/api/episodes", "/api/episodes?userId=user-1"]) {
    const res = await fetch(req(path, { headers: { "x-feed-token": "token-user-1" } }));
    assertEquals(res.status, 200, path);
    const { episodes } = await res.json();
    assertEquals((episodes as Episode[]).map((e) => e.id), ["episode-1"], path);
  }
});

Deno.test("episodes: newest first, and an unknown mode is still refused", async () => {
  const { fetch, stores } = await seededApp();
  await stores.metadata.putEpisode(makeEpisode({
    id: "older",
    userId: "user-1",
    sourceId: "stratechery",
    createdAt: "2026-09-01T00:00:00.000Z",
  }));

  const ok = await fetch(req("/api/episodes?userId=user-1", {
    headers: { "x-feed-token": "token-user-1" },
  }));
  assertEquals(ok.status, 200);
  const { episodes } = await ok.json();
  assertEquals((episodes as Episode[]).map((e) => e.id), ["episode-1", "older"]);

  const bad = await fetch(req("/api/episodes?userId=user-1&mode=whistling", {
    headers: { "x-feed-token": "token-user-1" },
  }));
  assertEquals(bad.status, 404);
});

Deno.test("episodes: a not-yet-approved subscriber's token is refused", async () => {
  const { fetch } = await seededApp();
  const res = await fetch(req("/api/episodes?userId=pending-1", {
    headers: { "x-feed-token": "token-pending-1" },
  }));
  assertEquals(res.status, 403);
});

Deno.test("episodes: a same-site session may read; another site may not", async () => {
  const { fetch, stores } = await seededApp();
  const secret = await createSession(stores.metadata, "user-1");
  const cookie = { cookie: `${SESSION_COOKIE}=${secret}` };

  const sameSite = await fetch(req("/api/episodes", {
    headers: { ...cookie, "sec-fetch-site": "same-origin" },
  }));
  assertEquals(sameSite.status, 200);

  const crossSite = await fetch(req("/api/episodes", {
    headers: { ...cookie, "sec-fetch-site": "cross-site", origin: "https://evil.example" },
  }));
  assertEquals(crossSite.status, 403);

  // A present Origin that is not this origin is refused too (no Sec-Fetch-Site).
  const crossOrigin = await fetch(req("/api/episodes", {
    headers: { ...cookie, origin: "https://evil.example" },
  }));
  assertEquals(crossOrigin.status, 403);
});
