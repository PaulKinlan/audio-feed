/**
 * Admin subscriber management tests (audio-feed-e3n).
 *
 * Verifies feed inspection, adding/removing feeds for subscribers,
 * feed token rotation, and auto-load behavior.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { renderAdminPage } from "../src/routes/admin.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Sample Feed</title>
  <link>https://example.com</link>
  <item>
    <title>Post 1</title>
    <link>https://example.com/post-1</link>
    <pubDate>Mon, 01 Sep 2026 06:00:00 +0000</pubDate>
    <description>First post description.</description>
  </item>
</channel></rss>`;

function app(deps = {}) {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const handlers = createHandlers(ctx, {
    feedTransport: () =>
      Promise.resolve(
        new Response(RSS_SAMPLE, {
          status: 200,
          headers: { "content-type": "application/rss+xml; charset=utf-8" },
        }),
      ),
    fetchArticle: (url) =>
      Promise.resolve({
        url,
        title: "Article Title",
        author: "Author",
        publishedAt: "2026-09-01T06:00:00.000Z",
        lead: "Lead",
        body: "Article body text.",
      }),
    ...deps,
  });
  const { fetch } = createApp(ctx, handlers);
  return { fetch, stores, ctx };
}

Deno.test("GET /api/admin/users/:id/sources lists feeds for subscriber", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({
      id: "source-1",
      userId: "user-1",
      title: "My Blog",
      feedUrl: "https://example.com/feed.xml",
      modes: ["direct"],
    }),
  );

  // Refused without token
  const unauth = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`),
  );
  assertEquals(unauth.status, 401);

  // Allowed with token
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.feedToken, "tok-1");
  assertEquals(body.sources.length, 1);
  assertEquals(body.sources[0]?.title, "My Blog");
  assertEquals(body.sources[0]?.feedPaths, ["/feed/tok-1/source-1/direct.xml"]);

  // Unknown user 404
  const unknown = await fetch(
    new Request(`${BASE}/api/admin/users/ghost/sources`, {
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(unknown.status, 404);
});

Deno.test("POST /api/admin/users/:id/sources subscribes user and queues posts", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "admin-secret",
      },
      body: JSON.stringify({
        feedUrl: "https://example.com/feed.xml",
        title: "Added by Admin",
        modes: ["deepdive"],
      }),
    }),
  );

  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.source.title, "Added by Admin");
  assertEquals(body.source.modes, ["deepdive"]);
  assertEquals(body.poll.queued, 1);
  assertEquals(body.feedPaths, [`/feed/tok-1/${body.source.id}/deepdive.xml`]);

  // Stored in metadata
  const sources = await stores.metadata.listSources("user-1");
  assertEquals(sources.length, 1);
  assertEquals(sources[0]?.title, "Added by Admin");

  // Ingested episode exists
  const episodes = await stores.metadata.listEpisodes({ userId: "user-1" });
  assertEquals(episodes.length, 1);
  assertEquals(episodes[0]?.mode, "deepdive");
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId removes subscriber feed", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-1", userId: "user-1", title: "To Remove" }),
  );

  assertEquals((await stores.metadata.listSources("user-1")).length, 1);

  // Missing token 401
  const unauth = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-1`, {
      method: "DELETE",
    }),
  );
  assertEquals(unauth.status, 401);

  // Delete with token
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-1`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.deleted, "src-1");
  assertEquals(body.cascaded, false);

  assertEquals((await stores.metadata.listSources("user-1")).length, 0);

  // Second delete returns 404
  const notFound = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-1`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(notFound.status, 404);
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId default retains ready episodes with attribution and cancels pending (audio-feed-ap6)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-1", userId: "user-1", title: "Stratechery" }),
  );
  // 1 ready episode with audio
  await stores.blobs.put("audio/ready.wav", new Uint8Array([1, 2, 3]), {
    contentType: "audio/wav",
  });
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-ready",
      userId: "user-1",
      sourceId: "src-1",
      sourceTitle: "Stratechery",
      status: "ready",
      audioKey: "audio/ready.wav",
      title: "An Article",
    }),
  );
  // 1 pending episode
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-pending",
      userId: "user-1",
      sourceId: "src-1",
      sourceTitle: "Stratechery",
      status: "pending",
      audioKey: undefined,
      title: "Pending Article",
    }),
  );

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-1`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.deleted, "src-1");
  assertEquals(body.cascaded, false);
  assertEquals(body.retainedEpisodes, 1);
  assertEquals(body.cancelledPending, 1);

  // Source is gone
  assertEquals(await stores.metadata.getSource("user-1", "src-1"), null);

  // Pending episode was cancelled
  assertEquals(await stores.metadata.getEpisode("user-1", "ep-pending"), null);

  // Ready episode was retained and audio still served
  const readyEp = await stores.metadata.getEpisode("user-1", "ep-ready");
  assert(readyEp);
  assertEquals(readyEp.status, "ready");
  assert(await stores.blobs.get("audio/ready.wav"));

  // Master feed syndicates retained episode and preserves Stratechery prefix
  const masterRes = await fetch(new Request(`${BASE}/feed/tok-1/master.xml`));
  assertEquals(masterRes.status, 200);
  const xml = await masterRes.text();
  assertStringIncludes(xml, "<title>Stratechery: An Article</title>");
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId with ?cascade=true purges episodes and blobs (audio-feed-ap6)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-purge", userId: "user-1", title: "Purge Me" }),
  );
  await stores.blobs.put("audio/purge.wav", new Uint8Array([4, 5, 6]), {
    contentType: "audio/wav",
  });
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-purge",
      userId: "user-1",
      sourceId: "src-purge",
      sourceTitle: "Purge Me",
      status: "ready",
      audioKey: "audio/purge.wav",
      title: "Gone Forever",
    }),
  );

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-purge?cascade=true`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.deleted, "src-purge");
  assertEquals(body.cascaded, true);
  assertEquals(body.deletedEpisodes, 1);
  assertEquals(body.deletedBlobs, 1);

  // Source is gone
  assertEquals(await stores.metadata.getSource("user-1", "src-purge"), null);
  // Episode is gone
  assertEquals(await stores.metadata.getEpisode("user-1", "ep-purge"), null);
  // Blob is deleted
  assertEquals(await stores.blobs.get("audio/purge.wav"), null);

  // Master feed no longer has the episode
  const masterRes = await fetch(new Request(`${BASE}/feed/tok-1/master.xml`));
  assertEquals(masterRes.status, 200);
  const xml = await masterRes.text();
  assertEquals(xml.includes("Gone Forever"), false);
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId drains >1000 episodes without truncation (audio-feed-7ve)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-huge", userId: "user-1", title: "Huge Source" }),
  );

  // Seed 1,050 pending episodes
  for (let i = 0; i < 1050; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-huge-${i}`,
        userId: "user-1",
        sourceId: "src-huge",
        status: "pending",
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      }),
    );
  }

  // Verify all 1,050 are stored
  assertEquals(
    (await stores.metadata.listEpisodes({
      userId: "user-1",
      sourceId: "src-huge",
      limit: Number.MAX_SAFE_INTEGER,
    })).length,
    1050,
  );

  // Default delete should cancel ALL 1,050 pending episodes in batches without truncation
  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-huge`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.deleted, "src-huge");
  assertEquals(body.cascaded, false);
  assertEquals(body.cancelledPending, 1050);
  assertEquals(body.retainedEpisodes, 0);

  // Ensure 0 episodes remain
  assertEquals(
    (await stores.metadata.listEpisodes({
      userId: "user-1",
      sourceId: "src-huge",
      limit: Number.MAX_SAFE_INTEGER,
    })).length,
    0,
  );
  assertEquals((await stores.metadata.listPendingEpisodes()).episodes.length, 0);
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId aborts loop on persistent delete failure via progress guard (audio-feed-des)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-stub", userId: "user-1", title: "Stub Source" }),
  );
  for (let i = 0; i < 5; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-stub-${i}`,
        userId: "user-1",
        sourceId: "src-stub",
        status: "pending",
      }),
    );
  }

  // Stub deleteEpisode to always fail (return false)
  let calls = 0;
  stores.metadata.deleteEpisode = () => {
    calls++;
    return Promise.resolve(false);
  };

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-stub`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(body.incomplete, true);
  assertEquals(body.cancelledPending, 0); // 0 confirmed removals
  // Loop terminates after consecutive identical passes (10 calls: 2 passes * 5 episodes)
  assertEquals(calls, 10);
  // Source is NOT deleted when incomplete
  assert(await stores.metadata.getSource("user-1", "src-stub"));
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId drains mixed/transient failure without abandoning remaining episodes (audio-feed-4qj)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-mixed", userId: "user-1", title: "Mixed Source" }),
  );

  // Seed 250 pending episodes
  for (let i = 0; i < 250; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-mixed-${i}`,
        userId: "user-1",
        sourceId: "src-mixed",
        status: "pending",
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      }),
    );
  }

  // First 100 delete calls fail (transient failure on first batch pass)
  let calls = 0;
  const originalDelete = stores.metadata.deleteEpisode.bind(stores.metadata);
  stores.metadata.deleteEpisode = (userId: string, id: string) => {
    calls++;
    if (calls <= 100) return Promise.resolve(false);
    return originalDelete(userId, id);
  };

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-mixed`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.deleted, "src-mixed");
  // All 250 episodes are successfully cancelled and drained
  assertEquals(body.cancelledPending, 250);

  // Source is deleted
  assertEquals(await stores.metadata.getSource("user-1", "src-mixed"), null);
  // Zero episodes remain
  assertEquals(
    (await stores.metadata.listEpisodes({
      userId: "user-1",
      sourceId: "src-mixed",
      limit: Number.MAX_SAFE_INTEGER,
    })).length,
    0,
  );
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId incomplete path only counts pending/synthesizing, not retained ready (audio-feed-mf5)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-inc", userId: "user-1", title: "Incomplete Source" }),
  );

  // 3 pending episodes
  for (let i = 0; i < 3; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-pend-${i}`,
        userId: "user-1",
        sourceId: "src-inc",
        status: "pending",
      }),
    );
  }
  // 20 ready episodes
  for (let i = 0; i < 20; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-ready-${i}`,
        userId: "user-1",
        sourceId: "src-inc",
        status: "ready",
        audioKey: `audio/key-${i}.wav`,
      }),
    );
  }

  // Stub deleteEpisode to always fail
  stores.metadata.deleteEpisode = () => Promise.resolve(false);

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-inc`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(body.incomplete, true);
  // Must report only the 3 pending episodes that failed to cancel, NOT 23!
  assertEquals(body.remainingEpisodes, 3);
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId cascade counts distinct deletedBlobs on retry (audio-feed-mf5)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-cas", userId: "user-1", title: "Cascade Source" }),
  );

  // 5 ready episodes with blobs
  for (let i = 0; i < 5; i++) {
    const key = `audio/blob-${i}.wav`;
    await stores.blobs.put(key, new Uint8Array([1]), { contentType: "audio/wav" });
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-cas-${i}`,
        userId: "user-1",
        sourceId: "src-cas",
        status: "ready",
        audioKey: key,
      }),
    );
  }

  // Each episode fails delete once, forcing a second retry pass
  const attempts = new Map<string, number>();
  const originalDelete = stores.metadata.deleteEpisode.bind(stores.metadata);
  stores.metadata.deleteEpisode = (userId: string, id: string) => {
    const count = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, count);
    if (count === 1) return Promise.resolve(false);
    return originalDelete(userId, id);
  };

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-cas?cascade=true`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.deletedEpisodes, 5);
  // deletedBlobs must report 5 distinct keys deleted, NOT 10!
  assertEquals(body.deletedBlobs, 5);
  assertEquals(body.failedBlobs, 0);
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId backfills sourceTitle on legacy retained episodes (audio-feed-rkf)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-legacy", userId: "user-1", title: "Legacy Source" }),
  );

  // Legacy episode with undefined sourceTitle
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-leg",
      userId: "user-1",
      sourceId: "src-legacy",
      sourceTitle: undefined,
      status: "ready",
      audioKey: "audio/leg.wav",
      title: "Old Article",
    }),
  );

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-legacy`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);

  // Stored episode now has backfilled sourceTitle
  const updatedEp = await stores.metadata.getEpisode("user-1", "ep-leg");
  assert(updatedEp);
  assertEquals(updatedEp.sourceTitle, "Legacy Source");

  // Master feed syndicates with attribution
  const masterRes = await fetch(new Request(`${BASE}/feed/tok-1/master.xml`));
  assertEquals(masterRes.status, 200);
  const xml = await masterRes.text();
  assertStringIncludes(xml, "<title>Legacy Source: Old Article</title>");
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId backfills >1000 legacy episodes without truncation (audio-feed-c9q)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-huge-legacy", userId: "user-1", title: "Huge Legacy" }),
  );

  // Seed 1,200 legacy ready episodes without sourceTitle
  for (let i = 0; i < 1200; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-leg-${i}`,
        userId: "user-1",
        sourceId: "src-huge-legacy",
        sourceTitle: undefined,
        status: "ready",
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      }),
    );
  }

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-huge-legacy`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.retainedEpisodes, 1200);

  // Verify all 1,200 episodes have sourceTitle backfilled
  const episodes = await stores.metadata.listEpisodes({
    userId: "user-1",
    sourceId: "src-huge-legacy",
    limit: Number.POSITIVE_INFINITY,
  });
  assertEquals(episodes.length, 1200);
  const missingSourceTitle = episodes.filter((ep) => !ep.sourceTitle);
  assertEquals(missingSourceTitle.length, 0);
});

Deno.test("DELETE /api/admin/users/:id/sources/:sourceId does not resurrect concurrently deleted episodes during backfill (audio-feed-hvn)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );
  await stores.metadata.putSource(
    makeSource({ id: "src-cas-test", userId: "user-1", title: "CAS Test" }),
  );

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-to-delete",
      userId: "user-1",
      sourceId: "src-cas-test",
      sourceTitle: undefined,
      status: "ready",
    }),
  );

  // Intercept listEpisodes: right after listEpisodes returns, delete the episode before backfill runs
  const originalList = stores.metadata.listEpisodes.bind(stores.metadata);
  stores.metadata.listEpisodes = async (query) => {
    const list = await originalList(query);
    if (query.status === "ready") {
      // Simulate concurrent deletion by user
      await stores.metadata.deleteEpisode("user-1", "ep-to-delete");
    }
    return list;
  };

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-cas-test`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);

  // Episode must NOT be resurrected by backfill!
  assertEquals(await stores.metadata.getEpisode("user-1", "ep-to-delete"), null);
});

Deno.test("POST /api/admin/users/:id/rotate-token rotates feed token and revokes old capability", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "old-token" }),
  );

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/rotate-token`, {
      method: "POST",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(body.feedToken, "must return new feedToken");
  assert(body.feedToken !== "old-token", "must generate a new token");

  // Old token is revoked
  assertEquals(await stores.metadata.getUserByFeedToken("old-token"), null);
  // New token resolves
  assertEquals(
    (await stores.metadata.getUserByFeedToken(body.feedToken))?.id,
    "user-1",
  );
});

Deno.test("admin console page renders subscriber management section and auto-loads on refresh", () => {
  const html = renderAdminPage({
    publicBaseUrl: "https://audio.example.com",
    adminConfigured: true,
  });

  assertStringIncludes(html, 'id="manageSection"');
  assertStringIncludes(html, 'id="manageDetails"');
  assertStringIncludes(html, 'id="manageFeedUrl"');
  assertStringIncludes(html, 'id="rotateManageToken"');
  assertStringIncludes(html, 'id="manageSourcesBody"');
  assertStringIncludes(html, 'id="addSourceForm"');
  assertStringIncludes(html, 'id="subFeedUrl"');
  assertStringIncludes(html, 'id="subFeedMode"');

  // Favicon (audio-feed-2dt)
  assertStringIncludes(html, '<link rel="icon"');
  // The confirmation guards are NOT asserted here. `assertStringIncludes(html,
  // "confirm(")` passed even when the dialogs' return values were discarded, so
  // clicking Cancel deleted the feed anyway (audio-feed-05b). They are driven
  // for real in tests/admin_confirm_test.ts, which watches for the request.

  // Auto-load on refresh: script calls loadUsers() when stored token is found
  assertStringIncludes(html, 'sessionStorage.getItem("audio-feed-admin-token")');
  assertStringIncludes(html, "loadUsers();");
  // Enter key support on password input
  assertStringIncludes(html, 'e.key === "Enter"');
});

Deno.test("POST /api/admin/users/:id/sources with all-invalid modes returns 400", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "tok-1" }),
  );

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "admin-secret",
      },
      body: JSON.stringify({
        feedUrl: "https://example.com/feed.xml",
        modes: ["nonsense", "invalid"],
      }),
    }),
  );

  assertEquals(res.status, 400);
  const body = await res.json();
  assertStringIncludes(body.error, "valid audio mode is required");
});

Deno.test("list-sourced user in openManage populates feedToken from sources response and master feed returns 200", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({
      id: "user-1",
      email: "paul@example.com",
      status: "approved",
      feedToken: "tok-12345",
    }),
  );

  // 1. listUsers returns redacted user without feedToken
  const listRes = await fetch(
    new Request(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(listRes.status, 200);
  const listBody = await listRes.json();
  const listUser = listBody.users[0];
  assertEquals(listUser.id, "user-1");
  assertEquals(listUser.feedToken, undefined, "list must not leak feedToken");

  // 2. Fetching user sources returns feedToken for management panel
  const sourcesRes = await fetch(
    new Request(`${BASE}/api/admin/users/${listUser.id}/sources`, {
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(sourcesRes.status, 200);
  const sourcesBody = await sourcesRes.json();
  assertEquals(sourcesBody.feedToken, "tok-12345", "sources must return feedToken for management");

  // 3. The computed master feed URL resolves to 200 OK
  const feedRes = await fetch(
    new Request(`${BASE}/feed/${sourcesBody.feedToken}/master.xml`),
  );
  assertEquals(feedRes.status, 200, "master feed URL must resolve 200");
});

Deno.test("cascade clears failedBlobs when a retry succeeds (audio-feed-37p)", async () => {
  // The c9q item 4 fix (failedBlobKeys.delete on a successful retry) had NO test
  // that could fail without it: the only failedBlobs assertion lived in a test where
  // blobs.delete never fails, so failedBlobs was trivially 0 either way. This test
  // makes the failure real and then makes the retry succeed.
  const { fetch, stores } = app();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(
    makeSource({ id: "src-blob", userId: "user-1", title: "Blob Source" }),
  );

  const keys: string[] = [];
  for (let i = 0; i < 5; i++) {
    const key = `audio/blobfail-${i}.wav`;
    keys.push(key);
    await stores.blobs.put(key, new Uint8Array([1]), { contentType: "audio/wav" });
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-blobfail-${i}`,
        userId: "user-1",
        sourceId: "src-blob",
        status: "ready",
        audioKey: key,
      }),
    );
  }

  // The episode delete fails once per episode, which is what keeps the episode in
  // the next listing and therefore forces the second pass.
  const episodeAttempts = new Map<string, number>();
  const originalEpisodeDelete = stores.metadata.deleteEpisode.bind(stores.metadata);
  stores.metadata.deleteEpisode = (userId: string, id: string) => {
    const count = (episodeAttempts.get(id) ?? 0) + 1;
    episodeAttempts.set(id, count);
    if (count === 1) return Promise.resolve(false);
    return originalEpisodeDelete(userId, id);
  };

  // Every blob delete rejects on its FIRST attempt for each key and succeeds after.
  const blobAttempts = new Map<string, number>();
  const originalBlobDelete = stores.blobs.delete.bind(stores.blobs);
  stores.blobs.delete = (key: string) => {
    const count = (blobAttempts.get(key) ?? 0) + 1;
    blobAttempts.set(key, count);
    if (count === 1) return Promise.reject(new Error("transient blob delete failure"));
    return originalBlobDelete(key);
  };

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-blob?cascade=true`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();

  // The failure path must actually have run, or this test proves nothing: each key
  // was attempted twice, meaning the first attempt failed as intended.
  assertEquals(blobAttempts.size, 5, "every blob must have been attempted");
  for (const key of keys) {
    assert(
      (blobAttempts.get(key) ?? 0) >= 2,
      `${key} must have failed once and been retried (attempts: ${blobAttempts.get(key)})`,
    );
  }

  assertEquals(body.ok, true);
  assertEquals(body.deletedEpisodes, 5);
  assertEquals(body.deletedBlobs, 5);
  // The regression: without failedBlobKeys.delete() on the successful retry, this
  // reports 5 — deleted and failed at the same time, and the storage is clean.
  assertEquals(body.failedBlobs, 0);
  for (const key of keys) {
    assertEquals(await stores.blobs.head(key), null, `${key} must be gone from the store`);
  }
});

Deno.test("cascade reports blobs it could not delete, and leaves them in place (audio-feed-6pn)", async () => {
  // The 37p test guards the FALSE POSITIVE on failedBlobs (a retry that succeeds must
  // clear the key). This is the false NEGATIVE, and it is the costlier direction: a
  // counter that can never be non-zero reports "nothing leaked" while the blobs sit
  // orphaned and billed. Opus measured that deleting failedBlobKeys.add() entirely
  // left the whole suite green, because every failedBlobs assertion asserted zero.
  const { fetch, stores } = app();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(
    makeSource({ id: "src-leak", userId: "user-1", title: "Leaking Source" }),
  );

  const keys: string[] = [];
  for (let i = 0; i < 4; i++) {
    const key = `audio/leak-${i}.wav`;
    keys.push(key);
    await stores.blobs.put(key, new Uint8Array([1]), { contentType: "audio/wav" });
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-leak-${i}`,
        userId: "user-1",
        sourceId: "src-leak",
        status: "ready",
        audioKey: key,
      }),
    );
  }

  // The blob store is down for deletes: every attempt fails, persistently.
  const attempts = new Map<string, number>();
  stores.blobs.delete = (key: string) => {
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    return Promise.reject(new Error("blob store unavailable"));
  };

  const res = await fetch(
    new Request(`${BASE}/api/admin/users/user-1/sources/src-leak?cascade=true`, {
      method: "DELETE",
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();

  // The failure path ran for every key, or this test proves nothing.
  assertEquals(attempts.size, 4, "every blob delete must have been attempted");

  // The episodes still go, so the source is removed and no synthesis is pending.
  assertEquals(body.deletedEpisodes, 4);
  // And the operator is TOLD about the orphaned blobs, which is the whole point:
  // reported as neither deleted nor silently ignored.
  assertEquals(body.deletedBlobs, 0);
  assertEquals(body.failedBlobs, 4);
  for (const key of keys) {
    assert(
      await stores.blobs.head(key) !== null,
      `${key} should still be in the store — it leaked`,
    );
  }
});
