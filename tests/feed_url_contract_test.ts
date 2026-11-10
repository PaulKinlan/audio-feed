/**
 * Round-trip contract test for feed URLs (audio-feed-tww).
 *
 * The bug: the generator embedded `/feed/<source>/direct.xml` and
 * `/feed/master.xml` while the router served `/feed/:token/...`, so every URL a
 * generated feed advertised answered 404 — a one-way contract broken on the way
 * out. This test asserts the two halves agree by taking the URL out of the feed
 * it just built and fetching that exact path from the app.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { buildMasterFeed, buildSourceFeed } from "../src/feed/rss.ts";
import { rotateFeedToken } from "../src/auth/users.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const TOKEN = "feed-token-1";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE };

async function app() {
  const stores: Stores = memoryStores();
  // On this base the capability IS the user id (compose's loader prefers a
  // `feedToken` field when present). audio-feed-ruw adds the real `feedToken` and
  // removes the id fallback; the rebase switches this line to
  // `makeUser({ id: "user-1", feedToken: TOKEN })` and adds the case that a user
  // id must NOT work as a token.
  await stores.metadata.putUser(
    makeUser({ id: "user-1", feedToken: TOKEN, status: "approved" }),
  );
  await stores.metadata.putSource(makeSource({ id: "stratechery", userId: "user-1" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "stratechery",
      status: "ready",
      audioKey: "episode-1.mp3",
      byteLength: 10,
      contentType: "audio/mpeg",
      createdAt: "2026-09-01T00:00:00.000Z",
      readyAt: "2026-09-01T00:05:00.000Z",
    }),
  );
  await stores.blobs.put("episode-1.mp3", new Uint8Array(10), { contentType: "audio/mpeg" });
  const { fetch } = createApp({ config, stores }, createHandlers({ config, stores }));
  return fetch;
}

const selfLink = (xml: string) => xml.match(/<atom:link href="([^"]+)" rel="self"/)?.[1] ?? null;

Deno.test("the URL a feed advertises is the URL the router serves", async () => {
  const fetch = await app();

  // Take the self-link straight out of the served master feed...
  const masterXml = await (await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`))).text();
  const masterSelf = selfLink(masterXml);
  assert(masterSelf, "the master feed must advertise a self link");
  assertEquals(masterSelf, `${BASE}/feed/${TOKEN}/master.xml`);
  // ...and follow it verbatim, as a podcast client would.
  const followed = await fetch(new Request(masterSelf));
  assertEquals(followed.status, 200, `${masterSelf} must resolve`);

  // Same for the per-source feed.
  const sourceXml = await (await fetch(new Request(`${BASE}/feed/${TOKEN}/stratechery/direct.xml`)))
    .text();
  const sourceSelf = selfLink(sourceXml);
  assert(sourceSelf, "the per-source feed must advertise a self link");
  assertEquals(sourceSelf, `${BASE}/feed/${TOKEN}/stratechery/direct.xml`);
  assertEquals((await fetch(new Request(sourceSelf))).status, 200);
});

Deno.test("the builders and the router agree on the shape", async () => {
  const fetch = await app();
  // Built by the generator, not fetched: this is the half that used to be wrong.
  const built = buildSourceFeed({
    origin: BASE,
    token: TOKEN,
    source: { id: "stratechery", title: "Stratechery" },
    kind: "direct",
    episodes: [{
      guid: "episode-1",
      title: "An Article",
      pubDate: "2026-09-01T00:05:00.000Z",
      audioUrl: `${BASE}/audio/episode-1.mp3`,
    }],
  });
  const builtSelf = selfLink(built);
  assertEquals(builtSelf, `${BASE}/feed/${TOKEN}/stratechery/direct.xml`);
  assertEquals((await fetch(new Request(builtSelf!))).status, 200);

  const builtMaster = buildMasterFeed({
    origin: BASE,
    token: TOKEN,
    episodes: [{
      guid: "episode-1",
      title: "An Article",
      pubDate: "2026-09-01T00:05:00.000Z",
      audioUrl: `${BASE}/audio/episode-1.mp3`,
      sourceId: "stratechery",
    }],
  });
  const builtMasterSelf = selfLink(builtMaster);
  assertEquals(builtMasterSelf, `${BASE}/feed/${TOKEN}/master.xml`);
  assertEquals((await fetch(new Request(builtMasterSelf!))).status, 200);
});

Deno.test("a token that would rewrite the path cannot", async () => {
  const fetch = await app();
  // Percent-encoded, so a hostile token cannot escape /feed/:token/.
  assertEquals(
    (await fetch(new Request(`${BASE}/feed/${encodeURIComponent("a/../b")}/master.xml`))).status,
    404,
  );
  assertStringIncludes(
    buildMasterFeed({ origin: BASE, token: "a/../b", episodes: [] }),
    "/feed/a%2F..%2Fb/master.xml",
  );
});

Deno.test("the fixture script's token shape matches the router", () => {
  // scripts/gen-fixtures.ts advertises FEED_TOKEN; the shape it builds must be
  // the one registered above, which is what the builders guarantee.
  const xml = buildMasterFeed({ origin: BASE, token: "local-dev-token", episodes: [] });
  assertEquals(selfLink(xml), `${BASE}/feed/local-dev-token/master.xml`);
});

Deno.test(
  "audio-feed-3wenc: enclosure URLs survive feed-token rotation while old feed URL fails",
  async () => {
    const stores: Stores = memoryStores();
    await stores.metadata.putUser(
      makeUser({ id: "user-1", feedToken: TOKEN, status: "approved" }),
    );
    await stores.metadata.putSource(
      makeSource({ id: "stratechery", userId: "user-1" }),
    );
    const canonicalKey = "user-1/direct/episode-1.mp3";
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "episode-1",
        userId: "user-1",
        sourceId: "stratechery",
        mode: "direct",
        status: "ready",
        audioKey: canonicalKey,
        byteLength: audioBytes.length,
        contentType: "audio/mpeg",
        createdAt: "2026-09-01T00:00:00.000Z",
        readyAt: "2026-09-01T00:05:00.000Z",
      }),
    );
    await stores.blobs.put(`audio/${canonicalKey}`, audioBytes, {
      contentType: "audio/mpeg",
    });
    const { fetch } = createApp({ config, stores }, createHandlers({ config, stores }));

    // 1. Before rotation: feed XML advertises the canonical enclosure URL.
    const initialFeedRes = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`));
    assertEquals(initialFeedRes.status, 200);
    const initialXml = await initialFeedRes.text();
    const enclosureMatch = initialXml.match(/<enclosure url="([^"]+)"/);
    assert(enclosureMatch?.[1], "feed XML must contain an enclosure URL");
    const oldEnclosureUrl = enclosureMatch[1];
    assertEquals(oldEnclosureUrl, `${BASE}/audio/${canonicalKey}`);

    // Pre-rotation enclosure fetch succeeds.
    const preRotateRes = await fetch(new Request(oldEnclosureUrl));
    assertEquals(preRotateRes.status, 200);
    assertEquals(new Uint8Array(await preRotateRes.bytes()), audioBytes);

    // 2. Rotate the feed token.
    const rotatedUser = await rotateFeedToken(stores.metadata, "user-1");
    const newToken = rotatedUser.feedToken;
    assert(newToken !== TOKEN, "token must rotate");

    // 3. Stale feed URL fails with uniform 404 (Unknown feed doctrine).
    const staleFeedRes = await fetch(new Request(`${BASE}/feed/${TOKEN}/master.xml`));
    assertEquals(staleFeedRes.status, 404);
    const staleFeedBody = await staleFeedRes.json();
    assertEquals(staleFeedBody, { error: "Unknown feed" });

    // 4. New feed URL resolves 200 and advertises the enclosure URL.
    const newFeedRes = await fetch(new Request(`${BASE}/feed/${newToken}/master.xml`));
    assertEquals(newFeedRes.status, 200);
    const newXml = await newFeedRes.text();
    const newEnclosureMatch = newXml.match(/<enclosure url="([^"]+)"/);
    assert(newEnclosureMatch?.[1], "new feed XML must contain an enclosure URL");
    const newEnclosureUrl = newEnclosureMatch[1];
    assertEquals(newEnclosureUrl, oldEnclosureUrl);

    // 5. Observable contract pinned:
    // After rotation, old enclosure URL does X (200 OK, audio bytes).
    // New enclosure URL does Y (200 OK, audio bytes).
    // Mutant: If rotation re-minted or invalidated enclosure URLs (or gated /audio
    // on the current feedToken), oldEnclosureUrl would 404 instead of 200.
    const oldAudioRes = await fetch(new Request(oldEnclosureUrl));
    assertEquals(oldAudioRes.status, 200, "old enclosure URL must survive feed-token rotation");
    assertEquals(new Uint8Array(await oldAudioRes.bytes()), audioBytes);

    const newAudioRes = await fetch(new Request(newEnclosureUrl));
    assertEquals(newAudioRes.status, 200, "new enclosure URL must resolve and serve audio");
    assertEquals(new Uint8Array(await newAudioRes.bytes()), audioBytes);

    // 6. Contrast with suspension: the server-side kill switch for audio access
    // is account suspension, which halts enclosure serving with 404 "Unknown audio object".
    await stores.metadata.putUser({ ...rotatedUser, status: "suspended" });
    const suspendedRes = await fetch(new Request(oldEnclosureUrl));
    assertEquals(suspendedRes.status, 404, "suspension stops enclosure URL access");
  },
);
