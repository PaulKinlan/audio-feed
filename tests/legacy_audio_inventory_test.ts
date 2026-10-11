/**
 * Tests for legacy flat audio key inventory and migration helper (audio-feed-e6xb).
 *
 * Verifies:
 * 1. isCanonicalAudioKey and canonicalizeAudioKey logic.
 * 2. Key stem redaction for safe logging.
 * 3. Inventory scanning across Memory and KV metadata stores.
 * 4. Safe dry-run default migration (no mutations without apply: true).
 * 5. Explicit apply migration (rewrites audioKey, copies blobs, idempotent).
 * 6. Integration with server bootstrap boot-time inventory.
 */

import { assert, assertEquals } from "@std/assert";
import { memoryStores, openStores } from "../src/config.ts";
import {
  canonicalizeAudioKey,
  inventoryLegacyAudioKeys,
  isCanonicalAudioKey,
  migrateLegacyAudioKeys,
  redactSampleKey,
} from "../src/storage/legacy_audio.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { bootstrap } from "../src/server.ts";

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

// ---------------------------------------------------------------------------
// 1. Unit tests: key classification and canonicalization
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

Deno.test("canonicalizeAudioKey: produces canonical keys idempotently", () => {
  const epDirect = makeEpisode({
    id: "ep-1",
    userId: "user-1",
    mode: "direct",
    audioKey: "legacy.mp3",
  });
  assertEquals(canonicalizeAudioKey(epDirect), "audio/user-1/direct/legacy.mp3");

  const epPrefixed = makeEpisode({
    id: "ep-2",
    userId: "user-1",
    mode: "deepdive",
    audioKey: "audio/ready.wav",
  });
  assertEquals(canonicalizeAudioKey(epPrefixed), "audio/user-1/deepdive/ready.wav");

  const epAlreadyCanonical = makeEpisode({
    id: "ep-3",
    userId: "user-1",
    mode: "direct",
    audioKey: "audio/user-1/direct/canonical.mp3",
  });
  assertEquals(canonicalizeAudioKey(epAlreadyCanonical), "audio/user-1/direct/canonical.mp3");

  const epTrimmed = makeEpisode({
    id: "ep-4",
    userId: "user-1",
    mode: "direct",
    audioKey: "user-1/direct/canonical.mp3",
  });
  assertEquals(canonicalizeAudioKey(epTrimmed), "audio/user-1/direct/canonical.mp3");
});

Deno.test("redactSampleKey: masks inner tokens while preserving shape and extension", () => {
  assertEquals(redactSampleKey("legacy.wav"), "le**cy.wav");
  assertEquals(redactSampleKey("audio/ready.wav"), "audio/re**dy.wav");
  assertEquals(redactSampleKey("secret-uuid-123456789.mp3"), "se******89.mp3");
  assertEquals(redactSampleKey("a.mp3"), "*.mp3");
});

// ---------------------------------------------------------------------------
// 2. Inventory tests on Memory and KV stores
// ---------------------------------------------------------------------------

Deno.test("inventoryLegacyAudioKeys: reports accurate counts on Memory store", async () => {
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
});

Deno.test("inventoryLegacyAudioKeys: pages through large KV store catalogue", async () => {
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
  } finally {
    await stores.metadata.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Migration helper tests: dry-run default, explicit apply, idempotency
// ---------------------------------------------------------------------------

Deno.test("migrateLegacyAudioKeys: dry-run default makes NO store mutations", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-legacy",
      userId: "user-1",
      mode: "direct",
      audioKey: "old-track.mp3",
    }),
  );

  // Run with NO options (default dryRun: true)
  const dryResult = await migrateLegacyAudioKeys(stores.metadata);
  assertEquals(dryResult.dryRun, true);
  assertEquals(dryResult.legacyFound, 1);
  assertEquals(dryResult.migrated, 0);
  assertEquals(dryResult.plan.length, 1);
  assertEquals(dryResult.plan[0]?.oldKey, "old-track.mp3");
  assertEquals(dryResult.plan[0]?.newKey, "audio/user-1/direct/old-track.mp3");

  // Verify stored episode is UNCHANGED
  const ep = await stores.metadata.getEpisode("user-1", "ep-legacy");
  assertEquals(ep?.audioKey, "old-track.mp3", "dry-run must not mutate store");
});

Deno.test("migrateLegacyAudioKeys: apply=true rewrites keys and copies blobs idempotently (Memory)", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.blobs.put("legacy-item.wav", AUDIO_BYTES, { contentType: "audio/wav" });
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-1",
      userId: "user-1",
      mode: "direct",
      audioKey: "legacy-item.wav",
    }),
  );

  // 1. Apply migration
  const applyResult = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: stores.blobs,
  });

  assertEquals(applyResult.dryRun, false);
  assertEquals(applyResult.legacyFound, 1);
  assertEquals(applyResult.migrated, 1);
  assertEquals(applyResult.blobCopies, 1);
  assertEquals(applyResult.errors.length, 0);

  // Verify episode record updated in store
  const updatedEp = await stores.metadata.getEpisode("user-1", "ep-1");
  assertEquals(updatedEp?.audioKey, "audio/user-1/direct/legacy-item.wav");

  // Verify blob copied to new canonical key
  const newBlob = await stores.blobs.get("audio/user-1/direct/legacy-item.wav");
  assert(newBlob !== null, "blob must be copied to canonical key");
  assertEquals(await new Response(newBlob.body).bytes(), AUDIO_BYTES);

  // Verify old blob remains intact for backward compatibility
  const oldBlob = await stores.blobs.get("legacy-item.wav");
  assert(oldBlob !== null, "old blob remains intact");

  // 2. IDEMPOTENCY: running apply again produces 0 mutations
  const repeatResult = await migrateLegacyAudioKeys(stores.metadata, {
    apply: true,
    blobs: stores.blobs,
  });

  assertEquals(repeatResult.dryRun, false);
  assertEquals(repeatResult.legacyFound, 0);
  assertEquals(repeatResult.migrated, 0);
  assertEquals(repeatResult.blobCopies, 0);
  assertEquals(repeatResult.skippedAlreadyCanonical, 1);
});

Deno.test("migrateLegacyAudioKeys: apply=true executes cleanly on KV store", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  try {
    await stores.metadata.putUser(makeUser({ id: "user-kv", status: "approved" }));
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-flat-1",
        userId: "user-kv",
        mode: "direct",
        audioKey: "flat-1.mp3",
      }),
    );
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-flat-2",
        userId: "user-kv",
        mode: "deepdive",
        audioKey: "audio/flat-2.wav",
      }),
    );
    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-canonical",
        userId: "user-kv",
        mode: "direct",
        audioKey: "audio/user-kv/direct/ok.mp3",
      }),
    );

    // Dry-run first
    const dry = await migrateLegacyAudioKeys(stores.metadata);
    assertEquals(dry.dryRun, true);
    assertEquals(dry.legacyFound, 2);
    assertEquals(dry.migrated, 0);

    // Apply
    const applied = await migrateLegacyAudioKeys(stores.metadata, { apply: true });
    assertEquals(applied.dryRun, false);
    assertEquals(applied.legacyFound, 2);
    assertEquals(applied.migrated, 2);

    // Verify KV store records
    const ep1 = await stores.metadata.getEpisode("user-kv", "ep-flat-1");
    assertEquals(ep1?.audioKey, "audio/user-kv/direct/flat-1.mp3");

    const ep2 = await stores.metadata.getEpisode("user-kv", "ep-flat-2");
    assertEquals(ep2?.audioKey, "audio/user-kv/deepdive/flat-2.wav");

    // Idempotent repeat
    const repeat = await migrateLegacyAudioKeys(stores.metadata, { apply: true });
    assertEquals(repeat.legacyFound, 0);
    assertEquals(repeat.migrated, 0);
    assertEquals(repeat.skippedAlreadyCanonical, 3);
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
