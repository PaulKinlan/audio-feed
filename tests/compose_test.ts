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
import { bytes, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig } from "../src/config.ts";
import type { ExtractedArticle } from "../src/ingest/url.ts";
import type { Stores } from "../src/config.ts";

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
    await fetch(req("/api/episodes?userId=user-1")),
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
