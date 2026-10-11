/**
 * Tests for read-only legacy flat audio key inventory (audio-feed-e6xb).
 *
 * Verifies:
 * 1. isCanonicalAudioKey classification (4-part and 3-part canonical vs legacy flat).
 * 2. Key stem redaction for safe logging.
 * 3. Inventory scanning across Memory and KV metadata stores.
 * 4. Paging and bounding over large catalogues in KV.
 * 5. Strictly read-only behaviour (zero mutations performed).
 * 6. Integration with server bootstrap boot-time inventory.
 */

import { assert, assertEquals } from "@std/assert";
import { memoryStores, openStores } from "../src/config.ts";
import {
  inventoryLegacyAudioKeys,
  isCanonicalAudioKey,
  redactSampleKey,
} from "../src/storage/legacy_audio.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { bootstrap } from "../src/server.ts";

// ---------------------------------------------------------------------------
// 1. Unit tests: key classification and redaction
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

Deno.test("redactSampleKey: masks inner tokens while preserving shape and extension", () => {
  assertEquals(redactSampleKey("legacy.wav"), "le**cy.wav");
  assertEquals(redactSampleKey("audio/ready.wav"), "audio/re**dy.wav");
  assertEquals(redactSampleKey("secret-uuid-123456789.mp3"), "se******89.mp3");
  assertEquals(redactSampleKey("a.mp3"), "*.mp3");
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

  const inv = await inventoryLegacyAudioKeys(stores.metadata, { maxSamples: 5 });
  assertEquals(inv.totalUsersScanned, 2);
  assertEquals(inv.totalEpisodesScanned, 4);
  assertEquals(inv.episodesWithAudioKey, 3);
  assertEquals(inv.canonicalCount, 1);
  assertEquals(inv.legacyCount, 2);
  assertEquals(inv.legacySamples.length, 2);

  // Samples are redacted
  assert(
    inv.legacySamples.some((s) => s.episodeId === "ep-legacy-1" && s.redactedKey.includes(".wav")),
  );
  assert(
    inv.legacySamples.some((s) => s.episodeId === "ep-legacy-2" && s.redactedKey.includes(".mp3")),
  );

  // Strictly read-only assertion: stored episode records must remain unchanged
  const ep1 = await stores.metadata.getEpisode("user-1", "ep-legacy-1");
  assertEquals(ep1?.audioKey, "legacy-track-1.wav", "inventory must be strictly read-only");
  const ep2 = await stores.metadata.getEpisode("user-2", "ep-legacy-2");
  assertEquals(ep2?.audioKey, "audio/ready-2.mp3", "inventory must be strictly read-only");
});

// ---------------------------------------------------------------------------
// 3. Inventory tests on KV store (paging across multiple batches)
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

    const inv = await inventoryLegacyAudioKeys(stores.metadata, { maxSamples: 3 });
    assertEquals(inv.totalUsersScanned, 1);
    assertEquals(inv.totalEpisodesScanned, 105);
    assertEquals(inv.canonicalCount, 100);
    assertEquals(inv.legacyCount, 5);
    assertEquals(inv.legacySamples.length, 3, "maxSamples option bounds samples collected");

    // Strictly read-only assertion: records remain unchanged in KV
    const sampleEp = await stores.metadata.getEpisode("user-kv", "ep-000");
    assertEquals(sampleEp?.audioKey, "legacy-0.mp3", "KV store must not be mutated by inventory");
  } finally {
    await stores.metadata.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Server boot integration test
// ---------------------------------------------------------------------------

Deno.test("bootstrap: runs legacy audio key inventory at boot and exposes promise", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  await stores.metadata.putUser(makeUser({ id: "boot-user", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-boot-legacy",
      userId: "boot-user",
      audioKey: "boot-legacy.mp3",
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
    assertEquals(inv.legacySamples[0]?.episodeId, "ep-boot-legacy");
  } finally {
    await booted.shutdown();
  }
});
