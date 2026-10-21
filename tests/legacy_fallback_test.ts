/**
 * Tests for read-path canonicalisation (audio-feed-hav3) and
 * legacy blob fallback in the audio route (audio-feed-rscz).
 *
 * Verifies:
 * 1. Read-path canonicalisation (audio-feed-hav3):
 *    - Feed adapter and listen page emit the canonical URL for episodes holding legacy flat keys.
 *    - Both emission sites agree on the derived URL.
 *    - Episodes already holding canonical keys emit without mutation.
 * 2. Legacy blob fallback (audio-feed-rscz):
 *    - GET /audio/<canonical-key> serves legacy flat blob when canonical is absent (200, correct bytes & type).
 *    - HEAD /audio/<canonical-key> reports legacy flat blob size and headers.
 *    - Range requests on fallback work (206, Content-Range, correct byte slice).
 *    - When BOTH canonical and legacy blobs exist, canonical is preferred.
 *    - When NEITHER exists, returns 404.
 *    - Direct flat-key requests (GET /audio/<flat-key>) still return 404 (whsl approval bypass closed).
 *    - Suspended / unapproved user requests fail closed with the identical 404 as a nonexistent object on fallback (audio-feed-7kdhb).
 *    - Attacker cannot access victim's legacy blob via attacker's canonical URL.
 *    - Whole-object downloads are attributed to the canonical user.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { memoryStores, openStores } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";
import { enclosureUrl, toFeedEpisode } from "../src/feed/adapter.ts";
import { buildFeed } from "../src/feed/rss.ts";
import { isAllowedAudioKey } from "../src/routes/audio.ts";
import { clearLegacyKeyIndexCache, getLegacyKeyUniqueOwner } from "../src/storage/legacy_audio.ts";
import type { AppConfig } from "../src/config.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = {
  port: 8000,
  publicBaseUrl: BASE,
  adminToken: "admin-secret",
};

const LEGACY_BYTES = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
const CANONICAL_BYTES = new Uint8Array([100, 101, 102, 103]);

function setupTestApp(stores = memoryStores()) {
  const ctx = { config: CONFIG, stores };
  const app = createApp(ctx, createHandlers(ctx));
  return { ...app, stores, ctx };
}

// ---------------------------------------------------------------------------
// 1. Read-path canonicalisation tests (audio-feed-hav3)
// ---------------------------------------------------------------------------

Deno.test("hav3: feed adapter emits canonical enclosure URL for legacy flat-key episode", () => {
  const ep = makeEpisode({
    id: "ep-legacy-1",
    userId: "user-alpha",
    mode: "direct",
    status: "ready",
    audioKey: "legacy-track.wav",
    contentType: "audio/wav",
  });

  const feedEp = toFeedEpisode(ep, { publicBaseUrl: BASE });
  assert(feedEp !== null);
  assertEquals(
    feedEp.audioUrl,
    `${BASE}/audio/user-alpha/direct/ep-legacy-1.wav`,
    "feed adapter must emit canonical URL rather than legacy flat key",
  );

  const xml = buildFeed(
    {
      title: "Test Feed",
      selfUrl: `${BASE}/feed/token/test/direct.xml`,
      link: BASE,
      description: "Test description",
    },
    [feedEp],
  );
  assertStringIncludes(xml, `<enclosure url="${BASE}/audio/user-alpha/direct/ep-legacy-1.wav"`);
});

Deno.test("hav3: feed adapter and listen page agree on canonical URL for legacy flat keys", async () => {
  const stores = memoryStores();
  const user = makeUser({ id: "user-alpha", status: "approved" });
  await stores.metadata.putUser(user);

  const ep = makeEpisode({
    id: "ep-agreed-1",
    userId: "user-alpha",
    mode: "deepdive",
    status: "ready",
    audioKey: "audio/old-deepdive.mp3",
    contentType: "audio/mpeg",
  });
  await stores.metadata.putEpisode(ep);

  // 1. URL from feed adapter
  const feedEp = toFeedEpisode(ep, { publicBaseUrl: BASE });
  assert(feedEp !== null);
  const feedUrl = feedEp.audioUrl;
  assertEquals(feedUrl, `${BASE}/audio/user-alpha/deepdive/ep-agreed-1.mp3`);

  // 2. URL from listen page
  const { fetch } = await setupTestApp(stores);
  const res = await fetch(new Request(`${BASE}/listen/${user.feedToken}`));
  assertEquals(res.status, 200);
  const html = await res.text();

  assertStringIncludes(
    html,
    `${BASE}/audio/user-alpha/deepdive/ep-agreed-1.mp3`,
    "listen page must render the identical canonical URL",
  );

  // 3. enclosureUrl helper agreement
  assertEquals(enclosureUrl(BASE, ep), feedUrl);
});

Deno.test("hav3: episodes already holding canonical keys emit without change", () => {
  const ep = makeEpisode({
    id: "ep-canonical-1",
    userId: "user-alpha",
    mode: "direct",
    status: "ready",
    audioKey: "audio/user-alpha/direct/ep-canonical-1.mp3",
    contentType: "audio/mpeg",
  });

  const feedEp = toFeedEpisode(ep, { publicBaseUrl: BASE });
  assert(feedEp !== null);
  assertEquals(feedEp.audioUrl, `${BASE}/audio/user-alpha/direct/ep-canonical-1.mp3`);
});

// ---------------------------------------------------------------------------
// 2. Legacy blob fallback in audio route (audio-feed-rscz, audio-feed-7y8f, audio-feed-ni04)
// ---------------------------------------------------------------------------

Deno.test("rscz: GET serves legacy blob when canonical blob is absent (200, correct bytes and type)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));

  // Store episode with legacy flat key in metadata
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-legacy-audio",
      userId: "user-1",
      mode: "direct",
      status: "ready",
      audioKey: "legacy-recording.wav",
      contentType: "audio/wav",
    }),
  );

  // Store blob ONLY under legacy key
  await stores.blobs.put("legacy-recording.wav", LEGACY_BYTES, { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores);

  // Request canonical URL
  const res = await fetch(new Request(`${BASE}/audio/user-1/direct/ep-legacy-audio.wav`));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "audio/wav");
  assertEquals(res.headers.get("accept-ranges"), "bytes");
  assertEquals(Number(res.headers.get("content-length")), LEGACY_BYTES.byteLength);

  const bodyBytes = new Uint8Array(await res.arrayBuffer());
  assertEquals(bodyBytes, LEGACY_BYTES);

  // Verify download was attributed to user-1
  const counts = await stores.metadata.getDownloadCounts();
  assertEquals(counts.total, 1);
  assertEquals(counts.perUser, [{ userId: "user-1", count: 1 }]);
});

Deno.test("rscz: HEAD reports legacy blob size and headers when canonical is absent", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-head",
      userId: "user-1",
      mode: "direct",
      status: "ready",
      audioKey: "head-track.mp3",
      contentType: "audio/mpeg",
    }),
  );
  await stores.blobs.put("head-track.mp3", LEGACY_BYTES, { contentType: "audio/mpeg" });

  const { fetch } = setupTestApp(stores);

  const res = await fetch(
    new Request(`${BASE}/audio/user-1/direct/ep-head.mp3`, { method: "HEAD" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "audio/mpeg");
  assertEquals(res.headers.get("accept-ranges"), "bytes");
  assertEquals(Number(res.headers.get("content-length")), LEGACY_BYTES.byteLength);
});

Deno.test("rscz: Range requests succeed on legacy blob fallback (206, Content-Range)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-range",
      userId: "user-1",
      mode: "direct",
      status: "ready",
      audioKey: "seekable.wav",
      contentType: "audio/wav",
    }),
  );
  await stores.blobs.put("seekable.wav", LEGACY_BYTES, { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores);

  const res = await fetch(
    new Request(`${BASE}/audio/user-1/direct/ep-range.wav`, {
      headers: { range: "bytes=2-5" },
    }),
  );
  assertEquals(res.status, 206);
  assertEquals(res.headers.get("content-range"), `bytes 2-5/${LEGACY_BYTES.byteLength}`);
  assertEquals(res.headers.get("accept-ranges"), "bytes");

  const slice = new Uint8Array(await res.arrayBuffer());
  assertEquals(slice, LEGACY_BYTES.subarray(2, 6));
});

Deno.test("rscz: prefers canonical blob when BOTH canonical and legacy blobs exist", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-both",
      userId: "user-1",
      mode: "direct",
      status: "ready",
      audioKey: "old-audio.wav",
      contentType: "audio/wav",
    }),
  );

  // Put legacy blob
  await stores.blobs.put("old-audio.wav", LEGACY_BYTES, { contentType: "audio/wav" });

  // Also put canonical blob
  await stores.blobs.put("audio/user-1/direct/ep-both.wav", CANONICAL_BYTES, {
    contentType: "audio/wav",
  });

  const { fetch } = setupTestApp(stores);

  const res = await fetch(new Request(`${BASE}/audio/user-1/direct/ep-both.wav`));
  assertEquals(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertEquals(bytes, CANONICAL_BYTES, "must serve canonical bytes when both exist");
});

Deno.test("rscz: returns 404 when NEITHER canonical nor legacy blob exists", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-ghost",
      userId: "user-1",
      mode: "direct",
      status: "ready",
      audioKey: "nonexistent.wav",
    }),
  );

  const { fetch } = setupTestApp(stores);

  const res = await fetch(new Request(`${BASE}/audio/user-1/direct/ep-ghost.wav`));
  assertEquals(res.status, 404);
});

Deno.test("rscz: direct flat-key request returns 404 (no approval bypass)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("legacy-direct.wav", LEGACY_BYTES, { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores);

  // Direct requests to flat keys must 404 per audio-feed-whsl
  assertEquals(isAllowedAudioKey("legacy-direct.wav"), false);
  const resGet = await fetch(new Request(`${BASE}/audio/legacy-direct.wav`));
  assertEquals(resGet.status, 404);

  const resHead = await fetch(
    new Request(`${BASE}/audio/legacy-direct.wav`, { method: "HEAD" }),
  );
  assertEquals(resHead.status, 404);
});

Deno.test("rscz: fails closed with the same 404 as a nonexistent object when user is not approved (audio-feed-7kdhb)", async () => {
  const stores = memoryStores();
  // Suspended user
  await stores.metadata.putUser(makeUser({ id: "suspended-user", status: "suspended" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-suspended",
      userId: "suspended-user",
      mode: "direct",
      status: "ready",
      audioKey: "suspended-track.wav",
      contentType: "audio/wav",
    }),
  );
  await stores.blobs.put("suspended-track.wav", LEGACY_BYTES, { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores);

  // Reference: a genuinely nonexistent object for the same user.
  const refRes = await fetch(new Request(`${BASE}/audio/suspended-user/direct/nonexistent.wav`));
  assertEquals(refRes.status, 404);
  const refBody = await refRes.text();

  const res = await fetch(new Request(`${BASE}/audio/suspended-user/direct/ep-suspended.wav`));
  assertEquals(
    res.status,
    404,
    "must enforce the user approval gate on fallback without disclosing existence",
  );
  assertEquals(await res.text(), refBody, "must be indistinguishable from a nonexistent object");
});

Deno.test("rscz: attacker cannot reach victim's legacy blob via attacker canonical URL", async () => {
  const stores = memoryStores();
  // Victim has legacy blob
  await stores.metadata.putUser(makeUser({ id: "victim", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-secret",
      userId: "victim",
      mode: "direct",
      status: "ready",
      audioKey: "secret-leak.wav",
      contentType: "audio/wav",
    }),
  );
  await stores.blobs.put("secret-leak.wav", LEGACY_BYTES, { contentType: "audio/wav" });

  // Attacker is approved user
  await stores.metadata.putUser(makeUser({ id: "attacker", status: "approved" }));

  const { fetch } = setupTestApp(stores);

  // Attacker asks for canonical URL under attacker's user ID with victim's episode id
  const res = await fetch(new Request(`${BASE}/audio/attacker/direct/ep-secret.wav`));
  assertEquals(res.status, 404, "attacker cannot resolve victim legacy blob");
});

Deno.test("rscz/65lf: ambiguous flat keys shared by multiple episodes fail closed with 404 (audio-feed-65lf)", async () => {
  const stores = memoryStores();
  for (const id of ["alice", "bob"]) {
    await stores.metadata.putUser(makeUser({ id, status: "approved" }));
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-" + id,
        userId: id,
        mode: "direct",
        status: "ready",
        audioKey: "shared.wav",
        contentType: "audio/wav",
      }),
    );
  }
  // Store Bob's bytes in the shared legacy blob
  await stores.blobs.put("shared.wav", new Uint8Array([66, 79, 66]), { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores);

  // Alice requests her canonical URL: must NOT return Bob's bytes! Must 404!
  const resAlice = await fetch(new Request(`${BASE}/audio/alice/direct/ep-alice.wav`));
  assertEquals(resAlice.status, 404, "ambiguous flat key must fail closed for Alice");

  // Bob requests his canonical URL: must also 404 due to ambiguous ownership!
  const resBob = await fetch(new Request(`${BASE}/audio/bob/direct/ep-bob.wav`));
  assertEquals(resBob.status, 404, "ambiguous flat key must fail closed for Bob");
});

Deno.test("rscz/65lf: uniquely-owned flat key succeeds while ambiguous key in same store fails closed", async () => {
  const stores = memoryStores();
  // Alice and Bob share "shared.wav"
  for (const id of ["alice", "bob"]) {
    await stores.metadata.putUser(makeUser({ id, status: "approved" }));
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-" + id,
        userId: id,
        mode: "direct",
        status: "ready",
        audioKey: "shared.wav",
        contentType: "audio/wav",
      }),
    );
  }
  // Charlie has a globally unique flat key
  await stores.metadata.putUser(makeUser({ id: "charlie", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-charlie",
      userId: "charlie",
      mode: "direct",
      status: "ready",
      audioKey: "charlie-unique.wav",
      contentType: "audio/wav",
    }),
  );
  await stores.blobs.put("shared.wav", new Uint8Array([66, 79, 66]), { contentType: "audio/wav" });
  await stores.blobs.put("charlie-unique.wav", new Uint8Array([67, 72, 65]), {
    contentType: "audio/wav",
  });

  const { fetch } = setupTestApp(stores);

  // Alice: 404
  const resAlice = await fetch(new Request(`${BASE}/audio/alice/direct/ep-alice.wav`));
  assertEquals(resAlice.status, 404);

  // Charlie: 200 with Charlie's bytes
  const resCharlie = await fetch(new Request(`${BASE}/audio/charlie/direct/ep-charlie.wav`));
  assertEquals(resCharlie.status, 200);
  const bytes = new Uint8Array(await resCharlie.arrayBuffer());
  assertEquals(bytes, new Uint8Array([67, 72, 65]));
});

Deno.test("ni04: newly colliding tenant blob written after cache population never leaks across tenants (audio-feed-ni04)", async () => {
  for (const kind of ["memory", "kv"] as const) {
    const stores = kind === "memory" ? memoryStores() : await openStores({ kvPath: ":memory:" });
    try {
      const { fetch } = setupTestApp(stores);

      const putTenant = async (id: string) => {
        await stores.metadata.putUser(makeUser({ id, status: "approved" }));
        await stores.metadata.putEpisode(
          makeEpisode({
            id: `ep-${id}`,
            userId: id,
            mode: "direct",
            status: "ready",
            audioKey: "shared.wav",
            contentType: "audio/wav",
          }),
        );
      };

      const getTenant = async (id: string): Promise<[number, number[]]> => {
        const r = await fetch(new Request(`${BASE}/audio/${id}/direct/ep-${id}.wav`));
        return [r.status, Array.from(new Uint8Array(await r.arrayBuffer()))];
      };

      // 1. Alice is initially the unique owner of shared.wav -> serves [65] and populates cache
      await putTenant("alice");
      await stores.blobs.put("shared.wav", new Uint8Array([65]), { contentType: "audio/wav" });
      assertEquals(await getTenant("alice"), [200, [65]], `initial unique Alice fetch (${kind})`);

      // 2. Within the 60s TTL window, Bob writes a colliding episode referencing shared.wav
      //    and overwrites shared.wav with Bob's bytes [66, 79, 66]
      await putTenant("bob");
      await stores.blobs.put("shared.wav", new Uint8Array([66, 79, 66]), {
        contentType: "audio/wav",
      });

      // 3. Both Alice and Bob must fail closed with 404; Bob's bytes [66, 79, 66] must NEVER leak
      const [aliceStatus, aliceBody] = await getTenant("alice");
      assertEquals(aliceStatus, 404, `Alice must be refused after collision (${kind})`);
      assert(
        !(aliceBody.length === 3 && aliceBody[0] === 66 && aliceBody[1] === 79 &&
          aliceBody[2] === 66),
        "Bob bytes must never leak through Alice canonical URL",
      );

      const [bobStatus] = await getTenant("bob");
      assertEquals(bobStatus, 404, `Bob must also be refused after collision (${kind})`);

      assertEquals(
        await getLegacyKeyUniqueOwner(stores.metadata, "shared.wav"),
        null,
        "owner lookup must report null on newly colliding key",
      );
      clearLegacyKeyIndexCache(stores.metadata);
    } finally {
      await stores.metadata.close?.();
    }
  }
});

Deno.test("7y8f: flat-key historical episode emits canonical enclosure URL that resolves 200 via fallback while direct flat key 404s (audio-feed-7y8f)", async () => {
  const stores = memoryStores();
  const user = makeUser({ id: "user-hist", status: "approved" });
  await stores.metadata.putUser(user);

  const ep = makeEpisode({
    id: "ep-hist-1",
    userId: "user-hist",
    mode: "direct",
    status: "ready",
    audioKey: "episode-1.wav",
    contentType: "audio/wav",
  });
  await stores.metadata.putEpisode(ep);
  await stores.blobs.put("episode-1.wav", LEGACY_BYTES, { contentType: "audio/wav" });

  const { fetch } = setupTestApp(stores);

  // 1. Feed adapter emits canonical URL
  const feed = toFeedEpisode(ep, { publicBaseUrl: BASE });
  assert(feed !== null);
  assertEquals(feed.audioUrl, `${BASE}/audio/user-hist/direct/ep-hist-1.wav`);

  // 2. Direct flat key remains disallowed at the route gate
  assertEquals(isAllowedAudioKey("episode-1.wav"), false);
  const directFlatRes = await fetch(new Request(`${BASE}/audio/episode-1.wav`));
  assertEquals(directFlatRes.status, 404);

  // 3. The emitted enclosure URL resolves 200 with the episode's audio bytes
  const canonicalRes = await fetch(new Request(feed.audioUrl));
  assertEquals(canonicalRes.status, 200);
  assertEquals(new Uint8Array(await canonicalRes.arrayBuffer()), LEGACY_BYTES);
});
