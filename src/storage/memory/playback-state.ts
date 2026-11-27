/**
 * Cross-device playback state repository (in-memory adapter).
 */

import type { PlaybackState } from "../../types.ts";
import {
  mergePlaybackStates,
  type PlaybackStatePatch,
  sanitizePlaybackState,
} from "../../playback_state.ts";
import type { MetadataStore, PlaybackStateRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";

export function createPlaybackStateRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): PlaybackStateRepository {
  return {
    getPlaybackState(userId: string): Promise<PlaybackState | null> {
      const found = state.playbackStates.get(userId);
      return Promise.resolve(found ? structuredClone(found) : null);
    },

    putPlaybackState(userId: string, next: PlaybackState): Promise<void> {
      const sanitized = sanitizePlaybackState(next);
      state.playbackStates.set(userId, structuredClone(sanitized));
      return Promise.resolve();
    },

    mergePlaybackState(userId: string, incoming: PlaybackStatePatch): Promise<PlaybackState> {
      const existing = state.playbackStates.get(userId) ?? null;
      const merged = mergePlaybackStates(existing, incoming);
      state.playbackStates.set(userId, structuredClone(merged));
      return Promise.resolve(structuredClone(merged));
    },
  };
}
