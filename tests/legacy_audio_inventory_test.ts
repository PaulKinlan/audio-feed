/**
 * Tests for read-only legacy flat audio key inventory (audio-feed-e6xb).
 *
 * Verifies:
 * 1. isCanonicalAudioKey classification (4-part and 3-part canonical vs legacy flat).
 * 2. Key stem and path redaction for safe logging (audio-feed-2qgb).
 * 3. Inventory scanning across Memory and KV metadata stores.
 * 4. Paging and bounding over large catalogues in KV.
 * 5. Privacy guarantees: neither raw userIds nor unmasked path segments leak in boot logs or CLI output.
 * 6. Strictly read-only behaviour (zero mutations performed).
 * 7. Integration with server bootstrap boot-time inventory.
 */

import { assert, assertEquals } from "@std/assert";
import { memoryStores, openStores } from "../src/config.ts";
import {
  hashIdentifier,
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

Deno.test("redactSampleKey: masks all interior path components and filename tokens (audio-feed-2qgb)", () => {
  assertEquals(redactSampleKey("legacy.wav"), "[token].wav");
  assertEquals(redactSampleKey("audio/ready.wav"), "audio/[token].wav");
  assertEquals(redactSampleKey("private/account/secret.mp3"), "[path]/[path]/[token].mp3");
  assertEquals(redactSampleKey("a/b/c/d/track.wav"), "[path]/[path]/[path]/[path]/[token].wav");
  assertEquals(redactSampleKey(""), "");
});

Deno.test("hashIdentifier: produces stable, non-reversible 8-char hex hash", async () => {
  const h1 = await hashIdentifier("user-12345");
  const h2 = await hashIdentifier("user-12345");
  const h3 = await hashIdentifier("user-67890");

  assertEquals(h1, h2, "same input must yield same hash");
  assertEquals(h1.length, 8);
  assert(/^[0-9a-f]{8}$/.test(h1));
  assert(h1 !== h3, "different inputs must yield different hashes");
  assert(!h1.includes("user"), "hash must not contain cleartext input");
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
    inv.legacySamples.some((s) => s.extension === ".wav" && s.maskedKey === "[token].wav"),
  );
  assert(
    inv.legacySamples.some((s) => s.extension === ".mp3" && s.maskedKey === "audio/[token].mp3"),
  );

  // Strictly read-only assertion: stored episode records must remain unchanged
  const ep1 = await stores.metadata.getEpisode("user-1", "ep-legacy-1");
  assertEquals(ep1?.audioKey, "legacy-track-1.wav", "inventory must be strictly read-only");
  const ep2 = await stores.metadata.getEpisode("user-2", "ep-legacy-2");
  assertEquals(ep2?.audioKey, "audio/ready-2.mp3", "inventory must be strictly read-only");
});

// ---------------------------------------------------------------------------
// 3. Privacy leak prevention test (audio-feed-2qgb)
// ---------------------------------------------------------------------------

Deno.test("inventory: samples redact full userId and path components completely (audio-feed-2qgb)", async () => {
  const stores = memoryStores();
  const SENSITIVE_USER_ID = "private-user@example.test";
  const SENSITIVE_PATH = "private/account/secret.mp3";

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

  // Assert neither the raw userId nor any nested path component appears in the JSON output
  assert(!serialized.includes(SENSITIVE_USER_ID), "raw userId must NOT appear in inventory output");
  assert(!serialized.includes("private"), "'private' path segment must NOT appear in output");
  assert(!serialized.includes("account"), "'account' path segment must NOT appear in output");
  assert(!serialized.includes("secret"), "'secret' token must NOT appear in output");

  // Verify safe structure of sample
  assertEquals(inv.legacySamples.length, 1);
  const sample = inv.legacySamples[0]!;
  assertEquals(sample.shape, "nested");
  assertEquals(sample.segmentCount, 3);
  assertEquals(sample.extension, ".mp3");
  assertEquals(sample.maskedKey, "[path]/[path]/[token].mp3");
  assert(/^[0-9a-f]{8}$/.test(sample.userHash), "userHash must be 8-char hex");
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
// 5. Server boot integration test
// ---------------------------------------------------------------------------

Deno.test("bootstrap: runs legacy audio key inventory at boot and logs redacted samples safely (audio-feed-2qgb)", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  const SENSITIVE_USER_ID = "boot-private-subscriber@corp.internal";
  const SENSITIVE_KEY = "internal/vault/secret-track.mp3";

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

    const serialized = JSON.stringify(inv);
    assert(!serialized.includes(SENSITIVE_USER_ID), "boot output must NOT leak raw userId");
    assert(!serialized.includes("internal"), "boot output must NOT leak internal path");
    assert(!serialized.includes("vault"), "boot output must NOT leak vault path");
    assert(!serialized.includes("secret-track"), "boot output must NOT leak secret filename");
  } finally {
    await booted.shutdown();
  }
});
