/**
 * Shared conformance tests for `PlaybackStateRepository` (Memory & D1).
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { PLAYBACK_MAX_PLAYED, PLAYBACK_MAX_POSITIONS, PLAYBACK_MAX_QUEUE } from "../../../src/types.ts";

export function registerPlaybackStateCases(suite: MetadataHarness) {
  const { test } = suite;

  test("playbackState: returns null when absent and round-trips put/get per user", async (store) => {
    assertEquals(await store.getPlaybackState("user-a"), null);

    await store.putPlaybackState("user-a", {
      positions: { "ep-1": { time: 42.5, duration: 300, updatedAt: 1_000 } },
      played: ["ep-0"],
      queue: ["ep-2", "ep-3"],
      queueUpdatedAt: 1_000,
      playbackRate: 1.5,
      voiceBoost: true,
      trimSilence: false,
      updatedAt: 1_000,
    });

    const a = await store.getPlaybackState("user-a");
    assert(a !== null);
    assertEquals(a.positions["ep-1"], { time: 42.5, duration: 300, updatedAt: 1_000 });
    assertEquals(a.played, ["ep-0"]);
    assertEquals(a.queue, ["ep-2", "ep-3"]);
    assertEquals(a.playbackRate, 1.5);
    assertEquals(a.voiceBoost, true);
    assertEquals(a.trimSilence, false);
    assertEquals(await store.getPlaybackState("user-b"), null);
  });

  test("playbackState: mergePlaybackState resolves per-episode newest timestamp, played union, and LWW prefs", async (store) => {
    await store.mergePlaybackState("user-m", {
      positions: {
        "ep-1": { time: 120, duration: 600, updatedAt: 2_000 },
        "ep-2": { time: 50, updatedAt: 5_000 },
      },
      played: ["ep-a", "ep-b"],
      queue: ["ep-3"],
      queueUpdatedAt: 3_000,
      playbackRate: 1.25,
      voiceBoost: true,
      updatedAt: 5_000,
    });

    // Stale update for ep-2 (4_000 < 5_000), newer update for ep-1 (6_000 > 2_000),
    // new episode ep-4, union on played, older preference timestamp should not clobber newer.
    const merged = await store.mergePlaybackState("user-m", {
      positions: {
        "ep-1": { time: 240, updatedAt: 6_000 },
        "ep-2": { time: 10, updatedAt: 4_000 },
        "ep-4": { time: 75, updatedAt: 5_500 },
      },
      played: ["ep-b", "ep-c"],
      queue: ["ep-old"],
      queueUpdatedAt: 2_500,
      playbackRate: 2.0,
      trimSilence: true,
      updatedAt: 4_000,
    });

    assertEquals(merged.positions["ep-1"], { time: 240, duration: 600, updatedAt: 6_000 });
    assertEquals(merged.positions["ep-2"], { time: 50, updatedAt: 5_000 });
    assertEquals(merged.positions["ep-4"], { time: 75, updatedAt: 5_500 });
    assertEquals(merged.played, ["ep-a", "ep-b", "ep-c"]);
    assertEquals(merged.queue, ["ep-3"], "older queueUpdatedAt must not overwrite newer queue");
    assertEquals(merged.playbackRate, 1.25, "older updatedAt must not overwrite newer rate");
    assertEquals(merged.voiceBoost, true);
    assertEquals(merged.trimSilence, true, "unset preference is adopted even on older patch");

    const reread = await store.getPlaybackState("user-m");
    assertEquals(reread, merged);
  });

  test("playbackState: enforces entry caps on positions, played, and queue", async (store) => {
    const positions: Record<string, { time: number; updatedAt: number }> = {};
    for (let i = 0; i < PLAYBACK_MAX_POSITIONS + 30; i++) {
      positions[`ep-${i}`] = { time: i + 1, updatedAt: 10_000 + i };
    }
    const played = Array.from({ length: PLAYBACK_MAX_PLAYED + 40 }, (_, i) => `p-${i}`);
    const queue = Array.from({ length: PLAYBACK_MAX_QUEUE + 25 }, (_, i) => `q-${i}`);

    const saved = await store.mergePlaybackState("user-cap", {
      positions,
      played,
      queue,
      updatedAt: 99_999,
    });

    assertEquals(Object.keys(saved.positions).length, PLAYBACK_MAX_POSITIONS);
    assertEquals(saved.positions["ep-0"], undefined, "oldest position evicted");
    assert(saved.positions[`ep-${PLAYBACK_MAX_POSITIONS + 29}`] !== undefined, "newest kept");
    assertEquals(saved.played.length, PLAYBACK_MAX_PLAYED);
    assertEquals(saved.played[0], "p-40");
    assertEquals(saved.queue.length, PLAYBACK_MAX_QUEUE);
    assertEquals(saved.queue[0], "q-0");
  });
}
