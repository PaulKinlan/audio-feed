/**
 * Comprehensive tests for Cross-Device Playback Sync (D1) + Synced Read-Along +
 * CORS-safe Web Audio Voice Boost / Trim Silence in `/listen/`.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import { MemoryBlobStore } from "../src/storage/memory.ts";
import { assetBody } from "../src/routes/assets.ts";
import {
  MAX_PLAYBACK_STATE_BYTES,
  PLAYBACK_STATE_READ_RATE,
} from "../src/routes/playback_state.ts";
import {
  findActiveCueIndex,
  mergePlaybackStates,
  parsePlaybackStatePatch,
  parseWebVtt,
} from "../src/playback_state.ts";
import {
  PLAYBACK_MAX_PLAYED,
  PLAYBACK_MAX_POSITIONS,
  PLAYBACK_MAX_QUEUE,
} from "../src/types.ts";
import { createTestD1 } from "./sqlite_d1.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { playerClient, playerData } from "./listen_client.ts";

const BASE = "https://audio.example.com";
const TOKEN_A = "sync-tok-alice";
const TOKEN_B = "sync-tok-bob";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

async function bootApp(customStores?: Stores) {
  const stores = customStores ?? memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-a", displayName: "Alice", status: "approved", feedToken: TOKEN_A }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-b", displayName: "Bob", status: "approved", feedToken: TOKEN_B }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-pending", status: "pending", feedToken: "sync-tok-pending" }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-rejected", status: "rejected", feedToken: "sync-tok-rejected" }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-suspended", status: "suspended", feedToken: "sync-tok-suspended" }),
  );
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores, ctx };
}

// ---------------------------------------------------------------------------
// 1. D1 Migration Idempotency & Concurrency
// ---------------------------------------------------------------------------

Deno.test("playback sync: migration 0002_playback_state.sql is idempotent and backs D1MetadataStore", async () => {
  const d1 = createTestD1();
  try {
    const migrationSql = readFileSync(
      new URL("../migrations/0002_playback_state.sql", import.meta.url),
      "utf8",
    );
    // Re-applying migration must succeed cleanly without destroying existing data.
    const store = new D1MetadataStore(d1);
    await store.putPlaybackState("u1", {
      positions: { "ep-1": { time: 95, duration: 300, updatedAt: 10_000 } },
      played: ["ep-0"],
      queue: ["ep-2"],
      playbackRate: 1.25,
      voiceBoost: true,
      trimSilence: false,
      updatedAt: 10_000,
    });

    await d1.exec(migrationSql);

    const after = await store.getPlaybackState("u1");
    assert(after !== null);
    assertEquals(after.positions["ep-1"], { time: 95, duration: 300, updatedAt: 10_000 });
    assertEquals(after.voiceBoost, true);

    // Concurrent device merges must not drop either device's episode progress or played set.
    const [m1, m2] = await Promise.all([
      store.mergePlaybackState("u1", {
        positions: { "ep-dev-1": { time: 45, updatedAt: 20_000 } },
        played: ["ep-done-1"],
        updatedAt: 20_000,
      }),
      store.mergePlaybackState("u1", {
        positions: { "ep-dev-2": { time: 180, updatedAt: 21_000 } },
        played: ["ep-done-2"],
        updatedAt: 21_000,
      }),
    ]);
    assert(m1 && m2);
    const finalState = await store.getPlaybackState("u1");
    assert(finalState !== null);
    assertEquals(finalState.positions["ep-dev-1"]?.time, 45);
    assertEquals(finalState.positions["ep-dev-2"]?.time, 180);
    assert(finalState.played.includes("ep-done-1"));
    assert(finalState.played.includes("ep-done-2"));
  } finally {
    d1.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Pure Merge Semantics, Validation, and Bounds
// ---------------------------------------------------------------------------

Deno.test("playback sync: conflict-free merge resolves newest-timestamp per episode, played union, and resets", () => {
  const initial = mergePlaybackStates(null, {
    positions: {
      "ep-1": { time: 100, duration: 500, updatedAt: 5_000 },
      "ep-2": { time: 200, duration: 400, updatedAt: 8_000 },
    },
    played: ["ep-old"],
    queue: ["ep-3", "ep-4"],
    queueUpdatedAt: 7_000,
    playbackRate: 1.5,
    voiceBoost: true,
    trimSilence: true,
    updatedAt: 8_000,
  });

  // Device B syncs with: newer ep-1 (10_000), stale ep-2 (6_000), explicit reset ep-2? No, stale!
  // Plus a newer explicit restart for ep-1 (time: 0 at 12_000) in a subsequent merge.
  const step2 = mergePlaybackStates(initial, {
    positions: {
      "ep-1": { time: 250, updatedAt: 10_000 },
      "ep-2": { time: 15, updatedAt: 6_000 },
      "ep-5": { time: 30, updatedAt: 9_000 },
    },
    played: ["ep-old", "ep-new"],
    queue: ["ep-stale-q"],
    queueUpdatedAt: 4_000,
    playbackRate: 0.75,
    voiceBoost: false,
    updatedAt: 6_000,
  });

  assertEquals(step2.positions["ep-1"], { time: 250, duration: 500, updatedAt: 10_000 });
  assertEquals(step2.positions["ep-2"], { time: 200, duration: 400, updatedAt: 8_000 });
  assertEquals(step2.positions["ep-5"], { time: 30, updatedAt: 9_000 });
  assertEquals(step2.played, ["ep-old", "ep-new"]);
  assertEquals(step2.queue, ["ep-3", "ep-4"], "stale queue edit must not clobber newer queue");
  assertEquals(step2.playbackRate, 1.5, "stale prefs must not clobber newer prefs");
  assertEquals(step2.voiceBoost, true);
  assertEquals(step2.trimSilence, true);

  // Newer explicit reset (time: 0) and newer prefs/queue win cleanly.
  const step3 = mergePlaybackStates(step2, {
    positions: {
      "ep-1": { time: 0, updatedAt: 15_000 },
    },
    queue: ["ep-9"],
    queueUpdatedAt: 15_000,
    playbackRate: 1.75,
    voiceBoost: false,
    updatedAt: 15_000,
  });
  assertEquals(step3.positions["ep-1"], { time: 0, duration: 500, updatedAt: 15_000 });
  assertEquals(step3.queue, ["ep-9"]);
  assertEquals(step3.playbackRate, 1.75);
  assertEquals(step3.voiceBoost, false);
});

Deno.test("playback sync: unhydrated & position-only syncs never clobber remote queue or newer prefs", () => {
  // Device A sets queue and audio prefs at T=15_000.
  const deviceA = mergePlaybackStates(null, {
    positions: { "ep-1": { time: 120, duration: 600, updatedAt: 15_000 } },
    played: ["ep-0"],
    queue: ["ep-a", "ep-b"],
    queueUpdatedAt: 15_000,
    prefsUpdatedAt: 15_000,
    playbackRate: 1.75,
    voiceBoost: true,
    trimSilence: true,
    updatedAt: 15_000,
  });

  // (a) Unhydrated Device B sends a position-only update at T=20_000 (omits queue & prefs).
  const afterUnhydrated = mergePlaybackStates(deviceA, {
    positions: { "ep-1": { time: 240, updatedAt: 20_000 } },
    played: ["ep-done-b"],
    updatedAt: 20_000,
  });
  assertEquals(afterUnhydrated.positions["ep-1"], { time: 240, duration: 600, updatedAt: 20_000 });
  assertEquals(afterUnhydrated.played, ["ep-0", "ep-done-b"]);
  assertEquals(afterUnhydrated.queue, ["ep-a", "ep-b"], "position-only sync must not wipe queue");
  assertEquals(afterUnhydrated.queueUpdatedAt, 15_000);
  assertEquals(afterUnhydrated.playbackRate, 1.75, "position-only sync must not wipe playbackRate");
  assertEquals(afterUnhydrated.voiceBoost, true, "position-only sync must not wipe voiceBoost");
  assertEquals(afterUnhydrated.trimSilence, true, "position-only sync must not wipe trimSilence");
  assertEquals(afterUnhydrated.prefsUpdatedAt, 15_000);

  // (b) Hydrated Device B (whose prefs/queue came from T=10_000) pauses at T=25_000 and sends a
  //     newer position (updatedAt: 25_000) alongside its stale prefs/queue from T=10_000.
  const afterStalePrefsWithNewPos = mergePlaybackStates(afterUnhydrated, {
    positions: { "ep-1": { time: 310, updatedAt: 25_000 } },
    queue: ["ep-old"],
    queueUpdatedAt: 10_000,
    prefsUpdatedAt: 10_000,
    playbackRate: 1.0,
    voiceBoost: false,
    trimSilence: false,
    updatedAt: 25_000,
  });
  assertEquals(
    afterStalePrefsWithNewPos.positions["ep-1"],
    { time: 310, duration: 600, updatedAt: 25_000 },
    "Device B newer position must still win",
  );
  assertEquals(
    afterStalePrefsWithNewPos.queue,
    ["ep-a", "ep-b"],
    "Device B newer position sync must not clobber Device A newer queue",
  );
  assertEquals(afterStalePrefsWithNewPos.queueUpdatedAt, 15_000);
  assertEquals(
    afterStalePrefsWithNewPos.playbackRate,
    1.75,
    "Device B newer position sync must not clobber Device A newer playbackRate",
  );
  assertEquals(
    afterStalePrefsWithNewPos.voiceBoost,
    true,
    "Device B newer position sync must not clobber Device A newer voiceBoost",
  );
  assertEquals(
    afterStalePrefsWithNewPos.trimSilence,
    true,
    "Device B newer position sync must not clobber Device A newer trimSilence",
  );
  assertEquals(afterStalePrefsWithNewPos.prefsUpdatedAt, 15_000);

  // (c) A fresh position-only sync at T=10_000 must not block an offline device's earlier
  //     explicit queue/prefs edit at T=5_000 from landing when server had no queue/prefs yet.
  const posOnlyFirst = mergePlaybackStates(null, {
    positions: { "ep-1": { time: 60, updatedAt: 10_000 } },
    updatedAt: 10_000,
  });
  const withEarlierOfflineEdits = mergePlaybackStates(posOnlyFirst, {
    queue: ["ep-offline"],
    queueUpdatedAt: 5_000,
    prefsUpdatedAt: 5_000,
    playbackRate: 1.25,
    voiceBoost: true,
    updatedAt: 10_000,
  });
  assertEquals(withEarlierOfflineEdits.queue, ["ep-offline"]);
  assertEquals(withEarlierOfflineEdits.queueUpdatedAt, 5_000);
  assertEquals(withEarlierOfflineEdits.playbackRate, 1.25);
  assertEquals(withEarlierOfflineEdits.voiceBoost, true);
  assertEquals(withEarlierOfflineEdits.prefsUpdatedAt, 5_000);

  // Explicit empty queue clear at T=30_000 must not be resurrected by a stale T=20_000 queue.
  const clearedQueue = mergePlaybackStates(afterStalePrefsWithNewPos, {
    queue: [],
    queueUpdatedAt: 30_000,
    updatedAt: 30_000,
  });
  assertEquals(clearedQueue.queue, []);
  assertEquals(clearedQueue.queueUpdatedAt, 30_000);
  const afterStaleResurrection = mergePlaybackStates(clearedQueue, {
    queue: ["ep-zombie"],
    queueUpdatedAt: 20_000,
    updatedAt: 35_000,
  });
  assertEquals(afterStaleResurrection.queue, []);
  assertEquals(afterStaleResurrection.queueUpdatedAt, 30_000);
});

Deno.test("playback sync: parsePlaybackStatePatch validates types, clamps rates, strips forbidden keys, and bounds collections", () => {
  assertEquals(parsePlaybackStatePatch(null), null);
  assertEquals(parsePlaybackStatePatch([]), null);
  assertEquals(parsePlaybackStatePatch("hello"), null);
  assertEquals(parsePlaybackStatePatch({ positions: "bad" }), null);
  assertEquals(parsePlaybackStatePatch({ played: "not-array" }), null);
  assertEquals(parsePlaybackStatePatch({ queue: 123 }), null);
  assertEquals(parsePlaybackStatePatch({ voiceBoost: "yes" }), null);
  assertEquals(parsePlaybackStatePatch({ trimSilence: 1 }), null);
  assertEquals(parsePlaybackStatePatch({ playbackRate: "fast" }), null);
  assertEquals(parsePlaybackStatePatch({ prefsUpdatedAt: "yesterday" }), null);
  assertEquals(parsePlaybackStatePatch({ prefsUpdatedAt: Number.POSITIVE_INFINITY }), null);

  // Prototype-pollution keys and absurdly long IDs are ignored safely.
  const hostile = JSON.parse(
    '{"positions":{"__proto__":{"time":10,"updatedAt":1},"constructor":{"time":10,"updatedAt":1},"good":{"time":42,"updatedAt":500}},"played":["__proto__","ok-1","ok-1"],"queue":["ok-q","ok-q"],"playbackRate":9.5}',
  );
  const parsed = parsePlaybackStatePatch(hostile, 1_000);
  assert(parsed !== null);
  assertEquals(Object.keys(parsed.positions ?? {}), ["good"]);
  assertEquals(parsed.played, ["ok-1"]);
  assertEquals(parsed.queue, ["ok-q"]);
  assertEquals(parsed.playbackRate, 3.0, "playbackRate must be clamped to PLAYBACK_MAX_RATE");

  // Envelope `{ state: { ... } }` is also accepted cleanly.
  const wrapped = parsePlaybackStatePatch({
    state: { positions: { "ep-w": { time: 12.34, updatedAt: 999 } }, updatedAt: 999 },
  });
  assert(wrapped !== null);
  assertEquals(wrapped.positions?.["ep-w"]?.time, 12.3);
});

// ---------------------------------------------------------------------------
// 3. HTTP Sync Routes: GET / POST /listen/:token/state
// ---------------------------------------------------------------------------

Deno.test("playback sync API: auth & approval gating returns uniform 404 with private, no-store", async () => {
  const { fetch } = await bootApp();

  const unknownGet = await fetch(new Request(`${BASE}/listen/unknown-tok/state`));
  assertEquals(unknownGet.status, 404);
  assertEquals(unknownGet.headers.get("cache-control"), "private, no-store");
  const unknownBody = await unknownGet.text();
  assertEquals(unknownBody, '{"error":"Unknown feed"}');

  for (const tok of ["sync-tok-pending", "sync-tok-rejected", "sync-tok-suspended"]) {
    const resGet = await fetch(new Request(`${BASE}/listen/${tok}/state`));
    assertEquals(resGet.status, 404);
    assertEquals(await resGet.text(), unknownBody, `GET must not disclose status for ${tok}`);

    const resPost = await fetch(
      new Request(`${BASE}/listen/${tok}/state`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ positions: { "ep-1": { time: 10, updatedAt: 1000 } } }),
      }),
    );
    assertEquals(resPost.status, 404);
    assertEquals(await resPost.text(), unknownBody, `POST must not disclose status for ${tok}`);
  }
});

Deno.test("playback sync API: GET/POST round-trip over D1, supporting both application/json and sendBeacon text/plain", async () => {
  const d1 = createTestD1();
  try {
    const stores: Stores = {
      metadata: new D1MetadataStore(d1),
      blobs: new MemoryBlobStore(),
      describe: "test-d1",
    };
    const { fetch } = await bootApp(stores);

    // Initial GET returns empty state with private, no-store.
    const emptyRes = await fetch(new Request(`${BASE}/listen/${TOKEN_A}/state`));
    assertEquals(emptyRes.status, 200);
    assertEquals(emptyRes.headers.get("cache-control"), "private, no-store");
    assertEquals(emptyRes.headers.get("x-robots-tag"), "noindex");
    const emptyJson = await emptyRes.json();
    assertEquals(emptyJson, {
      state: { positions: {}, played: [], queue: [], updatedAt: 0 },
    });

    // Device 1 posts application/json.
    const post1 = await fetch(
      new Request(`${BASE}/listen/${TOKEN_A}/state`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          origin: BASE,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          positions: { "ep-1": { time: 120, duration: 600, updatedAt: 10_000 } },
          played: ["ep-0"],
          queue: ["ep-2"],
          queueUpdatedAt: 10_000,
          playbackRate: 1.5,
          voiceBoost: true,
          trimSilence: false,
          updatedAt: 10_000,
        }),
      }),
    );
    assertEquals(post1.status, 200);
    assertEquals(post1.headers.get("cache-control"), "private, no-store");
    const body1 = await post1.json();
    assertEquals(body1.state.positions["ep-1"], { time: 120, duration: 600, updatedAt: 10_000 });
    assertEquals(body1.state.voiceBoost, true);

    // Device 2 flushes via navigator.sendBeacon (text/plain;charset=UTF-8).
    const post2 = await fetch(
      new Request(`${BASE}/listen/${TOKEN_A}/state`, {
        method: "POST",
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          origin: BASE,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          positions: {
            "ep-1": { time: 90, updatedAt: 9_000 }, // stale -> ignored
            "ep-3": { time: 45, updatedAt: 12_000 }, // new -> merged
          },
          played: ["ep-done"],
          trimSilence: true,
          updatedAt: 12_000,
        }),
      }),
    );
    assertEquals(post2.status, 200);
    const body2 = await post2.json();
    assertEquals(body2.state.positions["ep-1"].time, 120, "newer D1 timestamp must win");
    assertEquals(body2.state.positions["ep-3"].time, 45);
    assertEquals(body2.state.played, ["ep-0", "ep-done"]);
    assertEquals(body2.state.voiceBoost, true);
    assertEquals(body2.state.trimSilence, true);

    // Bob's state stays completely isolated from Alice's.
    const bobRes = await fetch(new Request(`${BASE}/listen/${TOKEN_B}/state`));
    assertEquals(bobRes.status, 200);
    const bobJson = await bobRes.json();
    assertEquals(bobJson.state.positions, {});
    assertEquals(bobJson.state.played, []);

    // Cross-device prefsUpdatedAt & queueUpdatedAt protection end-to-end over D1:
    // Device A saves newer prefs/queue at T=15_000; Device B posts a newer position at T=25_000
    // with stale prefsUpdatedAt/queueUpdatedAt (T=10_000) -> Device A's prefs/queue survive.
    const postDeviceA = await fetch(
      new Request(`${BASE}/listen/${TOKEN_A}/state`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({
          queue: ["ep-next-a"],
          queueUpdatedAt: 15_000,
          prefsUpdatedAt: 15_000,
          playbackRate: 2.0,
          voiceBoost: true,
          trimSilence: false,
          updatedAt: 15_000,
        }),
      }),
    );
    assertEquals(postDeviceA.status, 200);

    const postDeviceB = await fetch(
      new Request(`${BASE}/listen/${TOKEN_A}/state`, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", origin: BASE },
        body: JSON.stringify({
          positions: { "ep-1": { time: 400, updatedAt: 25_000 } },
          queue: ["ep-stale-b"],
          queueUpdatedAt: 10_000,
          prefsUpdatedAt: 10_000,
          playbackRate: 1.0,
          voiceBoost: false,
          trimSilence: true,
          updatedAt: 25_000,
        }),
      }),
    );
    assertEquals(postDeviceB.status, 200);
    const mergedAfterB = (await postDeviceB.json()).state;
    assertEquals(mergedAfterB.positions["ep-1"].time, 400);
    assertEquals(mergedAfterB.queue, ["ep-next-a"]);
    assertEquals(mergedAfterB.queueUpdatedAt, 15_000);
    assertEquals(mergedAfterB.playbackRate, 2.0);
    assertEquals(mergedAfterB.voiceBoost, true);
    assertEquals(mergedAfterB.trimSilence, false);
    assertEquals(mergedAfterB.prefsUpdatedAt, 15_000);

    // Unhydrated position-only POST at T=30_000 (omitting queue & prefs) also leaves them intact.
    const postUnhydrated = await fetch(
      new Request(`${BASE}/listen/${TOKEN_A}/state`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({
          positions: { "ep-1": { time: 450, updatedAt: 30_000 } },
          updatedAt: 30_000,
        }),
      }),
    );
    assertEquals(postUnhydrated.status, 200);
    const mergedAfterUnhydrated = (await postUnhydrated.json()).state;
    assertEquals(mergedAfterUnhydrated.positions["ep-1"].time, 450);
    assertEquals(mergedAfterUnhydrated.queue, ["ep-next-a"]);
    assertEquals(mergedAfterUnhydrated.playbackRate, 2.0);
    assertEquals(mergedAfterUnhydrated.prefsUpdatedAt, 15_000);
  } finally {
    d1.close();
  }
});

Deno.test("playback sync API: enforces 64 KiB body cap, content-type, invalid JSON 400, and cross-origin 403", async () => {
  const { fetch } = await bootApp();

  // Cross-origin browser POST refused 403 before touching storage.
  const crossOrigin = await fetch(
    new Request(`${BASE}/listen/${TOKEN_A}/state`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ positions: {} }),
    }),
  );
  assertEquals(crossOrigin.status, 403);

  // Origin: null with Sec-Fetch-Site: same-origin (no-referrer page) is allowed.
  const nullOriginSameSite = await fetch(
    new Request(`${BASE}/listen/${TOKEN_A}/state`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "null",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ played: ["ep-null-origin"], updatedAt: 5_000 }),
    }),
  );
  assertEquals(nullOriginSameSite.status, 200);

  // Unsupported media type -> 415.
  const badCt = await fetch(
    new Request(`${BASE}/listen/${TOKEN_A}/state`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data", origin: BASE },
      body: "{}",
    }),
  );
  assertEquals(badCt.status, 415);

  // Malformed JSON -> 400.
  const badJson = await fetch(
    new Request(`${BASE}/listen/${TOKEN_A}/state`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: "{not-json",
    }),
  );
  assertEquals(badJson.status, 400);

  // Declared oversized body (> 64 KiB) -> 413.
  const oversized = JSON.stringify({
    played: Array.from({ length: 4000 }, (_, i) => `episode-id-long-padding-${i}`),
  });
  assert(oversized.length > MAX_PLAYBACK_STATE_BYTES);
  const resDeclared = await fetch(
    new Request(`${BASE}/listen/${TOKEN_A}/state`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(oversized.length),
        origin: BASE,
      },
      body: oversized,
    }),
  );
  assertEquals(resDeclared.status, 413);

  // Streamed oversized body without Content-Length -> 413.
  const enc = new TextEncoder();
  const resStreamed = await fetch(
    new Request(`${BASE}/listen/${TOKEN_A}/state`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 80; i++) controller.enqueue(enc.encode("a".repeat(1024)));
          controller.close();
        },
      }),
    }),
  );
  assertEquals(resStreamed.status, 413);

  // Oversized collections inside < 64 KiB body are bounded cleanly.
  const manyPositions: Record<string, { time: number; updatedAt: number }> = {};
  for (let i = 0; i < PLAYBACK_MAX_POSITIONS + 20; i++) {
    manyPositions[`e${i}`] = { time: i, updatedAt: 100 + i };
  }
  const boundedRes = await fetch(
    new Request(`${BASE}/listen/${TOKEN_A}/state`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        positions: manyPositions,
        played: Array.from({ length: PLAYBACK_MAX_PLAYED + 20 }, (_, i) => `p${i}`),
        queue: Array.from({ length: PLAYBACK_MAX_QUEUE + 20 }, (_, i) => `q${i}`),
        updatedAt: 50_000,
      }),
    }),
  );
  assertEquals(boundedRes.status, 200);
  const boundedBody = await boundedRes.json();
  assertEquals(Object.keys(boundedBody.state.positions).length, PLAYBACK_MAX_POSITIONS);
  assertEquals(boundedBody.state.played.length, PLAYBACK_MAX_PLAYED);
  assertEquals(boundedBody.state.queue.length, PLAYBACK_MAX_QUEUE);
});

Deno.test("playback sync API: rate limits excessive reads with 429 and retry-after", async () => {
  const { fetch } = await bootApp();
  const info = { remoteAddr: { hostname: "203.0.113.42" } };
  let lastStatus = 200;
  let retryAfter: string | null = null;
  for (let i = 0; i <= PLAYBACK_STATE_READ_RATE.maxRequests; i++) {
    const res = await fetch(new Request(`${BASE}/listen/${TOKEN_A}/state`), info);
    lastStatus = res.status;
    retryAfter = res.headers.get("retry-after");
    await res.body?.cancel();
  }
  assertEquals(lastStatus, 429);
  assert(retryAfter !== null && Number(retryAfter) >= 1);
});

// ---------------------------------------------------------------------------
// 4. WebVTT Parser & Active Cue Highlight Helpers
// ---------------------------------------------------------------------------

Deno.test("synced read-along: WebVTT parser handles timestamps, voice tags, entities, comments, and active cue lookup", () => {
  const sampleVtt = `\uFEFFWEBVTT - Episode Transcript\r\n\r\nNOTE generated automatically\r\n\r\nSTYLE\r\n::cue { color: white; }\r\n\r\n1\r\n00:00:00.000 --> 00:00:12.500 align:start\r\n<v Alex>Welcome back to Audio Feed &amp; Friends!</v>\r\n\r\n2\r\n00:12.800 --> 00:25.000\r\n<v.host Sam>Today we cover <b>D1</b> &lt;sync&gt; &quot;tricks&quot;.</v>\r\n\r\n01:02:03.250 --> 01:02:15.000\r\nClosing paragraph without speaker tag.\r\n`;

  const cues = parseWebVtt(sampleVtt);
  assertEquals(cues.length, 3);
  assertEquals(cues[0], {
    start: 0,
    end: 12.5,
    speaker: "Alex",
    text: "Welcome back to Audio Feed & Friends!",
  });
  assertEquals(cues[1], {
    start: 12.8,
    end: 25,
    speaker: "Sam",
    text: 'Today we cover D1 <sync> "tricks".',
  });
  assertEquals(cues[2], {
    start: 3723.25,
    end: 3735,
    text: "Closing paragraph without speaker tag.",
  });

  // Active cue lookup: direct hits, short gap bridge, and out-of-range checks.
  assertEquals(findActiveCueIndex(cues, -1), -1);
  assertEquals(findActiveCueIndex(cues, 0), 0);
  assertEquals(findActiveCueIndex(cues, 12.4), 0);
  assertEquals(findActiveCueIndex(cues, 12.6), 0, "short inter-cue gap keeps previous cue steady");
  assertEquals(findActiveCueIndex(cues, 12.8), 1);
  assertEquals(findActiveCueIndex(cues, 3725), 2);
  assertEquals(findActiveCueIndex(cues, 4000), -1);
  assertEquals(findActiveCueIndex([], 5), -1);
});

Deno.test("synced read-along: shipped listen.js WebVTT helpers match canonical behavior", () => {
  const listenJs = assetBody("listen.js") ?? "";
  const startIdx = listenJs.indexOf("const VTT_TIMESTAMP_RE =");
  const endIdx = listenJs.indexOf("/** @param {boolean} follow */");
  assert(startIdx > 0 && endIdx > startIdx, "listen.js must define WebVTT helpers");
  const snippet = listenJs.slice(startIdx, endIdx);
  const extract = new Function(
    `${snippet}\nreturn { parseWebVtt, findActiveCueIndex };`,
  ) as () => {
    parseWebVtt: typeof parseWebVtt;
    findActiveCueIndex: typeof findActiveCueIndex;
  };
  const { parseWebVtt: clientParse, findActiveCueIndex: clientFind } = extract();

  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:05.000",
    "<v Host>Hello &amp; welcome</v>",
    "",
    "00:00:05.500 --> 00:00:10.000",
    "Second cue <script>ignored</script> text",
  ].join("\n");
  const cues = clientParse(vtt);
  assertEquals(cues.length, 2);
  assertEquals(cues[0], { start: 1, end: 5, speaker: "Host", text: "Hello & welcome" });
  assertEquals(cues[1], { start: 5.5, end: 10, text: "Second cue ignored text" });
  assertEquals(clientFind(cues, 0.2), -1);
  assertEquals(clientFind(cues, 2.0), 0);
  assertEquals(clientFind(cues, 5.2), 0);
  assertEquals(clientFind(cues, 7.0), 1);
});

// ---------------------------------------------------------------------------
// 5. /listen/:token Markup, CORS-safe Web Audio Guard, CSP & Asset Checks
// ---------------------------------------------------------------------------

Deno.test("listen page & assets: audioProcessingAvailable reflects blobStoreDirectUrlOrigin and obeys strict CSP", async () => {
  // Case A: Same-origin streaming store (R2 / Memory) -> audioProcessingAvailable = true.
  const { fetch, stores } = await bootApp();
  await stores.metadata.putSource(makeSource({ id: "s1", userId: "user-a", title: "Feed" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "a1", userId: "user-a", sourceId: "s1", title: "Ep", content: "Text." }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "e1",
      userId: "user-a",
      sourceId: "s1",
      articleId: "a1",
      status: "ready",
      audioKey: "audio/user-a/direct/e1.mp3",
      contentType: "audio/mpeg",
      byteLength: 1024,
      durationSeconds: 120,
    }),
  );

  const sameOriginRes = await fetch(new Request(`${BASE}/listen/${TOKEN_A}`));
  assertEquals(sameOriginRes.status, 200);
  const sameOriginHtml = await sameOriginRes.text();

  // Strict CSP invariants: no inline style attributes, no inline handlers, no crossorigin on <audio>.
  assert(!/\bstyle\s*=/i.test(sameOriginHtml), "listen HTML must have zero inline style attributes");
  assert(!/\bon[a-z]+\s*=/i.test(sameOriginHtml), "listen HTML must have zero inline event handlers");
  assertStringIncludes(sameOriginHtml, '<audio id="audio" preload="metadata"></audio>');
  const audioTag = /<audio\b[^>]*>/i.exec(sameOriginHtml)?.[0] ?? "";
  assert(audioTag.length > 0 && !audioTag.includes("crossorigin"), "<audio> must not set crossorigin attribute");

  // New UI controls present with accessible ARIA states.
  assertStringIncludes(sameOriginHtml, 'id="voiceBoostBtn"');
  assertStringIncludes(sameOriginHtml, 'id="trimSilenceBtn"');
  assertStringIncludes(sameOriginHtml, 'id="npAudioFxNote"');
  assertStringIncludes(sameOriginHtml, 'id="npFollowBtn"');
  assertStringIncludes(sameOriginHtml, 'aria-pressed="false"');

  const dataSameOrigin = playerData(sameOriginHtml) as { audioProcessingAvailable?: boolean };
  assertEquals(dataSameOrigin.audioProcessingAvailable, true);

  // Case B: Redirecting cross-origin store -> audioProcessingAvailable MUST be false
  // so Web Audio createMediaElementSource NEVER attaches and silences cross-origin audio!
  const redirectingStores = memoryStores();
  redirectingStores.blobs.url = (key) => Promise.resolve(`https://r2.example.com/${key}`);
  redirectingStores.blobs.directUrlOrigin = () => "https://r2.example.com";
  const { fetch: fetchRedirect } = await bootApp(redirectingStores);
  const redirectHtml = await (await fetchRedirect(new Request(`${BASE}/listen/${TOKEN_A}`))).text();
  const dataRedirect = playerData(redirectHtml) as { audioProcessingAvailable?: boolean };
  assertEquals(
    dataRedirect.audioProcessingAvailable,
    false,
    "redirecting cross-origin blob store must disable Web Audio processing to avoid silent playback",
  );

  // Asset bundle integrity & client safety checks.
  const client = await playerClient(fetch, BASE, sameOriginHtml);
  assert(!client.includes(".innerHTML"), "listen.js must never assign .innerHTML");
  assertStringIncludes(client, "navigator.sendBeacon");
  assertStringIncludes(client, '"/state"');
  assertStringIncludes(client, '"/transcript/"');
  assertStringIncludes(client, '"/article"');
  assertStringIncludes(client, "canAttachWebAudio");
  assertStringIncludes(client, "AUDIO_PROCESSING_AVAILABLE");
  assertStringIncludes(client, "isSameOriginAudioUrl");
  assertStringIncludes(client, "createDynamicsCompressor");
  assertStringIncludes(client, "createAnalyser");
  assertStringIncludes(client, "restoreBasePlaybackRate");
  assertStringIncludes(client, "payload.prefsUpdatedAt = prefsTs;");
  assertStringIncludes(client, "if (queueTs > 0 || upNextIds.length > 0)");
  assertStringIncludes(client, "if (prefsTs > 0)");
  assertStringIncludes(client, "remote.prefsUpdatedAt");

  // openNowPlaying must call showModal() BEFORE activateNpTab/loadReadAlong so cached Read-Along
  // cues see npDialog.open === true and scroll smoothly into view on sheet open.
  const openFnStart = client.indexOf("function openNowPlaying(");
  assert(openFnStart > 0, "listen.js must define openNowPlaying");
  const openFnBody = client.slice(openFnStart, client.indexOf("}", openFnStart) + 1);
  const showModalIdx = openFnBody.indexOf("npDialog.showModal()");
  const activateTabIdx = openFnBody.indexOf("activateNpTab(");
  const loadReadIdx = openFnBody.indexOf("loadReadAlong(");
  assert(
    showModalIdx > 0 && showModalIdx < activateTabIdx && showModalIdx < loadReadIdx,
    "openNowPlaying must open npDialog.showModal() before activateNpTab / loadReadAlong",
  );

  const css = assetBody("listen.css") ?? "";
  assertStringIncludes(css, ".np-audio-fx");
  assertStringIncludes(css, ".np-fx-toggle");
  assertStringIncludes(css, ".np-cue[data-active=\"true\"]");
  assertStringIncludes(css, ".np-follow-pill");
});
