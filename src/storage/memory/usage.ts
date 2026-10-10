/**
 * Operational counters: enclosure requests and synthesis spend.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import type { SynthesisCounts } from "../../types.ts";
import { utcDayKey } from "../../types.ts";
import { type DownloadCounts, type MetadataStore } from "../mod.ts";
import type { UsageRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";

export function createUsageRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): UsageRepository {
  return {
    // -- operational stats (audio-feed-ndc) ------------------------------------

    recordDownload(userId: string | null): Promise<void> {
      state.downloadTotal++;
      if (userId) {
        state.downloadsByUser.set(userId, (state.downloadsByUser.get(userId) ?? 0) + 1);
      }
      return Promise.resolve();
    },
    getDownloadCounts(): Promise<DownloadCounts> {
      const perUser = [...state.downloadsByUser.entries()]
        .map(([userId, count]) => ({ userId, count }))
        .sort((a, b) => b.count - a.count);
      return Promise.resolve({ total: state.downloadTotal, perUser });
    },
    // Synthesis stats & budget tracking (audio-feed-9mp)
    recordSynthesis(userId: string, bytes: number, at = new Date()): Promise<void> {
      const day = utcDayKey(at);
      state.synthesisTotal++;
      state.synthesisTotalBytes += bytes;
      const userTotal = state.synthesisByUser.get(userId) ?? { count: 0, bytes: 0 };
      state.synthesisByUser.set(userId, {
        count: userTotal.count + 1,
        bytes: userTotal.bytes + bytes,
      });
      const dayKey = `${userId}:${day}`;
      state.synthesisByUserAndDay.set(dayKey, (state.synthesisByUserAndDay.get(dayKey) ?? 0) + 1);
      return Promise.resolve();
    },
    getSynthesisCounts(today = utcDayKey()): Promise<SynthesisCounts> {
      const perUser = [...state.synthesisByUser.entries()]
        .map(([userId, data]) => ({
          userId,
          count: data.count,
          bytes: data.bytes,
          todayCount: state.synthesisByUserAndDay.get(`${userId}:${today}`) ?? 0,
        }))
        .sort((a, b) => b.count - a.count);
      return Promise.resolve({
        total: state.synthesisTotal,
        totalBytes: state.synthesisTotalBytes,
        perUser,
      });
    },
    getUserDailySynthesisCount(userId: string, day: string): Promise<number> {
      return Promise.resolve(state.synthesisByUserAndDay.get(`${userId}:${day}`) ?? 0);
    },
  };
}
