/**
 * Tests for read-only legacy flat audio key inventory (audio-feed-e6xb).
 *
 * Verifies:
 * 1. isCanonicalAudioKey classification (4-part and 3-part canonical vs legacy flat).
 * 2. Whitelist-based extension categorization and structural shape categorization.
 * 3. Inventory scanning across Memory and KV metadata stores.
 * 4. Paging and bounding over large catalogues in KV.
 * 5. Complete privacy protection (audio-feed-2qgb, audio-feed-tyxd):
 *    Strictly aggregate counts only; zero user IDs, key tokens, or arbitrary suffixes
 *    appear in serialized inventory results or boot logs.
 * 6. Strictly read-only behaviour (zero mutations performed).
 * 7. Integration with server bootstrap boot-time inventory.
 */

import { assert, assertEquals } from "@std/assert";
import { memoryStores, openStores } from "../src/config.ts";
import {
  categorizeExtension,
  categorizeShape,
  inventoryLegacyAudioKeys,
  isCanonicalAudioKey,
} from "../src/storage/legacy_audio.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { bootstrap } from "../src/server.ts";

// ---------------------------------------------------------------------------
// 1. Unit tests: key classification, extension whitelist, and shape
// ---------------------------------------------------------------------------

Deno.test("isCanonicalAudioKey: identifies canonical keys and rejects legacy flat keys", () => {
  const ep = { userId: "user-1", mode: "direct" as const };

  // 4-segment canonical
  assertEquals(isCanonicalAudioKey("audio/user-1/direct/ep-1.mp3", ep), true);
  assertEquals(isCanonicalAudioKey("audio/user-1/direct/ep-1.wav", ep), true);
  assertEquals(
    isCanonicalAudioKey("audio/user-1/deepdive/ep-1.mp3", { ...ep, mode: "deepdive" }),
    true,
  );

  // 3-segment route-trimmed canonical
  assertEquals(isCanonicalAudioKey("user-1/direct/ep-1.mp3", ep), true);

  // Mismatched user or mode
  assertEquals(isCanonicalAudioKey("audio/other-user/direct/ep-1.mp3", ep), false);
  assertEquals(isCanonicalAudioKey("audio/user-1/deepdive/ep-1.mp3", ep), false);

  // Legacy flat keys
  assertEquals(isCanonicalAudioKey("legacy.mp3", ep), false);
  assertEquals(isCanonicalAudioKey("episode-1.wav", ep), false);
  assertEquals(isCanonicalAudioKey("audio/ready.wav", ep), false);
  assertEquals(isCanonicalAudioKey("audio/legacy.mp3", ep), false);

  // Invalid extensions or forbidden prefixes
  assertEquals(isCanonicalAudioKey("audio/user-1/direct/ep-1.txt", ep), false);
  assertEquals(isCanonicalAudioKey("audio-segments/user-1/direct/ep-1.mp3", ep), false);
  assertEquals(isCanonicalAudioKey("voice-samples/user-1/direct/ep-1.mp3", ep), false);
});

Deno.test("categorizeExtension: strictly whitelists safe extensions and buckets arbitrary suffixes into 'other' (audio-feed-tyxd)", () => {
  assertEquals(categorizeExtension("track.wav"), ".wav");
  assertEquals(categorizeExtension("track.mp3"), ".mp3");
  assertEquals(categorizeExtension("track.m4a"), ".m4a");
  assertEquals(categorizeExtension("track.ogg"), ".ogg");
  assertEquals(categorizeExtension("track.webm"), ".webm");

  // Hostile / user-controlled suffixes bucketed into "other" — no arbitrary strings retained
  assertEquals(categorizeExtension("track.sensitive-2026"), "other");
  assertEquals(categorizeExtension("track.leak-token"), "other");
  assertEquals(categorizeExtension("track"), "none");
});

Deno.test("categorizeShape: classifies keys into fixed coarse categories", () => {
  assertEquals(categorizeShape("legacy.wav"), "flat");
  assertEquals(categorizeShape("audio/ready.wav"), "audioPrefixed");
  assertEquals(categorizeShape("private/account/secret.mp3"), "nested");
  assertEquals(categorizeShape("audio/u/direct/ep.wav"), "nested");
});

// ---------------------------------------------------------------------------
// 2. Inventory tests on Memory store (strictly read-only)
// ---------------------------------------------------------------------------

Deno.test("inventoryLegacyAudioKeys: reports accurate counts on Memory store without mutating records", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putUser(makeUser({ id: "user-2", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "src-1", userId: "user-1" }));

  // Empty inventory
  const emptyInv = await inventoryLegacyAudioKeys(stores.metadata);
  assertEquals(emptyInv.totalUsersScanned, 2);
  assertEquals(emptyInv.totalEpisodesScanned, 0);
  assertEquals(emptyInv.legacyCount, 0);

  // Add mixed episodes
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-canonical",
      userId: "user-1",
      audioKey: "audio/user-1/direct/canonical.mp3",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-legacy-1",
      userId: "user-1",
      audioKey: "legacy-track-1.wav",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-legacy-2",
      userId: "user-2",
      audioKey: "audio/ready-2.mp3",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-pending",
      userId: "user-2",
      status: "pending",
      audioKey: undefined,
    }),
  );

  const inv = await inventoryLegacyAudioKeys(stores.metadata);
  assertEquals(inv.totalUsersScanned, 2);
  assertEquals(inv.totalEpisodesScanned, 4);
  assertEquals(inv.episodesWithAudioKey, 3);
  assertEquals(inv.canonicalCount, 1);
  assertEquals(inv.legacyCount, 2);

  assertEquals(inv.byShape.flat, 1);
  assertEquals(inv.byShape.audioPrefixed, 1);
  assertEquals(inv.byShape.nested, 0);

  assertEquals(inv.byExtension[".wav"], 1);
  assertEquals(inv.byExtension[".mp3"], 1);
  assertEquals(inv.byExtension["other"], 0);

  // Strictly read-only assertion: stored episode records must remain unchanged
  const ep1 = await stores.metadata.getEpisode("user-1", "ep-legacy-1");
  assertEquals(ep1?.audioKey, "legacy-track-1.wav", "inventory must be strictly read-only");
  const ep2 = await stores.metadata.getEpisode("user-2", "ep-legacy-2");
  assertEquals(ep2?.audioKey, "audio/ready-2.mp3", "inventory must be strictly read-only");
});

// ---------------------------------------------------------------------------
// 3. Complete leak prevention test: zero user IDs, key fragments, or arbitrary suffixes (audio-feed-tyxd)
// ---------------------------------------------------------------------------

Deno.test("inventory: zero userIds, key fragments, or arbitrary suffixes leak into output (audio-feed-2qgb, audio-feed-tyxd)", async () => {
  const stores = memoryStores();
  const SENSITIVE_USER_ID = "private-user@example.test";
  const SENSITIVE_PATH = "private/account/track.sensitive-2026";

  await stores.metadata.putUser(makeUser({ id: SENSITIVE_USER_ID, status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-secret-123",
      userId: SENSITIVE_USER_ID,
      audioKey: SENSITIVE_PATH,
    }),
  );

  const inv = await inventoryLegacyAudioKeys(stores.metadata);
  const serialized = JSON.stringify(inv);

  // Assert strictly aggregate counts
  assertEquals(inv.legacyCount, 1);
  assertEquals(inv.byShape.nested, 1);
  assertEquals(inv.byExtension.other, 1);
  assertEquals(inv.byExtension[".wav"], 0);
  assertEquals(inv.byExtension[".mp3"], 0);

  // Assert complete absence of ANY sensitive string
  assert(!serialized.includes(SENSITIVE_USER_ID), "raw userId must NOT appear anywhere in output");
  assert(!serialized.includes("private"), "'private' substring must NOT appear in output");
  assert(!serialized.includes("account"), "'account' substring must NOT appear in output");
  assert(!serialized.includes("track"), "'track' substring must NOT appear in output");
  assert(!serialized.includes("sensitive-2026"), "hostile suffix must NOT appear in output");
  assert(!serialized.includes("secret"), "'secret' token must NOT appear in output");
});

// ---------------------------------------------------------------------------
// 4. Inventory tests on KV store (paging across multiple batches)
// ---------------------------------------------------------------------------

Deno.test("inventoryLegacyAudioKeys: pages through large KV store catalogue without mutating records", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  try {
    await stores.metadata.putUser(makeUser({ id: "user-kv", status: "approved" }));

    // Seed 105 episodes across multiple pages (limit 100)
    for (let i = 0; i < 105; i++) {
      await stores.metadata.putEpisode(
        makeEpisode({
          id: `ep-${i.toString().padStart(3, "0")}`,
          userId: "user-kv",
          audioKey: i < 5 ? `legacy-${i}.mp3` : `audio/user-kv/direct/ep-${i}.mp3`,
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        }),
      );
    }

    const inv = await inventoryLegacyAudioKeys(stores.metadata);
    assertEquals(inv.totalUsersScanned, 1);
    assertEquals(inv.totalEpisodesScanned, 105);
    assertEquals(inv.canonicalCount, 100);
    assertEquals(inv.legacyCount, 5);
    assertEquals(inv.byShape.flat, 5);
    assertEquals(inv.byExtension[".mp3"], 5);

    // Strictly read-only assertion: records remain unchanged in KV
    const sampleEp = await stores.metadata.getEpisode("user-kv", "ep-000");
    assertEquals(sampleEp?.audioKey, "legacy-0.mp3", "KV store must not be mutated by inventory");
  } finally {
    await stores.metadata.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Server boot integration test
// ---------------------------------------------------------------------------

Deno.test("bootstrap: runs legacy audio key inventory at boot with zero leakage (audio-feed-tyxd)", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  const SENSITIVE_USER_ID = "boot-private-subscriber@corp.internal";
  const SENSITIVE_KEY = "internal/vault/secret-track.leak-token-999";

  await stores.metadata.putUser(makeUser({ id: SENSITIVE_USER_ID, status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-boot-legacy",
      userId: SENSITIVE_USER_ID,
      audioKey: SENSITIVE_KEY,
    }),
  );

  const booted = await bootstrap({
    port: 0,
    stores,
    isDeploy: true, // avoid background workers
  });

  try {
    assert(booted.inventory !== undefined, "booted result must expose inventory promise");
    const inv = await booted.inventory;
    assert(inv !== null);
    assertEquals(inv.totalUsersScanned, 1);
    assertEquals(inv.legacyCount, 1);
    assertEquals(inv.byShape.nested, 1);
    assertEquals(inv.byExtension.other, 1);

    const serialized = JSON.stringify(inv);
    assert(!serialized.includes(SENSITIVE_USER_ID), "boot output must NOT leak raw userId");
    assert(!serialized.includes("internal"), "boot output must NOT leak internal path");
    assert(!serialized.includes("vault"), "boot output must NOT leak vault path");
    assert(!serialized.includes("secret-track"), "boot output must NOT leak secret filename");
    assert(!serialized.includes("leak-token"), "boot output must NOT leak hostile suffix");
  } finally {
    await booted.shutdown();
  }
});
