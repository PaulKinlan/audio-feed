/**
 * Operational counters: enclosure requests and synthesis spend.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { SynthesisCounts } from "../../types.ts";
import type { DownloadCounts, MetadataStore, UsageRepository } from "../mod.ts";
import type { KvCore } from "./core.ts";
import { utcDayKey } from "../../types.ts";

export function createUsageRepository(core: KvCore, _host: () => MetadataStore): UsageRepository {
  return {
    /**
     * `.sum()` on a `KvU64`, not read-then-write.
     *
     * Measured on this runtime: 200 concurrent read-modify-writes landed 1 of
     * 200; 200 atomic sums landed all 200. `/audio/:key+` is the route podcast
     * clients hammer, so the naive form would undercount by orders of magnitude
     * exactly when the number matters.
     */
    async recordDownload(userId: string | null): Promise<void> {
      try {
        const tx = core.kv.atomic().sum(["download_total"], 1n);
        if (userId) tx.sum(["download_by_user", userId], 1n);
        await tx.commit();
      } catch {
        // A counter is not worth failing a download for. The episode still plays.
      }
    },
    async getDownloadCounts(): Promise<DownloadCounts> {
      const total = await core.kv.get<Deno.KvU64>(["download_total"]);
      const perUser: { userId: string; count: number }[] = [];
      for await (const entry of core.kv.list<Deno.KvU64>({ prefix: ["download_by_user"] })) {
        const userId = entry.key[1];
        if (typeof userId !== "string" || !entry.value) continue;
        perUser.push({ userId, count: Number(entry.value.value) });
      }
      perUser.sort((a, b) => b.count - a.count);
      return { total: Number(total.value?.value ?? 0n), perUser };
    },
    // Synthesis stats & budget tracking (audio-feed-9mp, audio-feed-akm)
    async recordSynthesis(userId: string, bytes: number, at = new Date()): Promise<void> {
      const day = utcDayKey(at);
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tx = core.kv.atomic()
            .sum(["synthesis_total"], 1n)
            .sum(["synthesis_total_bytes"], BigInt(bytes))
            .sum(["synthesis_by_user", userId], 1n)
            .sum(["synthesis_bytes_by_user", userId], BigInt(bytes))
            .sum(["synthesis_daily", userId, day], 1n);
          const res = await tx.commit();
          if (res.ok) return;
          lastError = new Error(`atomic commit failed (attempt ${attempt + 1}/3)`);
        } catch (err) {
          lastError = err;
        }
      }
      console.error(
        `[audio-feed] recordSynthesis failed for user ${userId} (${bytes} bytes):`,
        lastError,
      );
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
    async getSynthesisCounts(today = utcDayKey()): Promise<SynthesisCounts> {
      const [totalEntry, bytesEntry] = await Promise.all([
        core.kv.get<Deno.KvU64>(["synthesis_total"]),
        core.kv.get<Deno.KvU64>(["synthesis_total_bytes"]),
      ]);
      const perUser: { userId: string; count: number; bytes: number; todayCount: number }[] = [];
      for await (const entry of core.kv.list<Deno.KvU64>({ prefix: ["synthesis_by_user"] })) {
        const userId = entry.key[1];
        if (typeof userId !== "string" || !entry.value) continue;
        const [userBytes, todayEntry] = await Promise.all([
          core.kv.get<Deno.KvU64>(["synthesis_bytes_by_user", userId]),
          core.kv.get<Deno.KvU64>(["synthesis_daily", userId, today]),
        ]);
        perUser.push({
          userId,
          count: Number(entry.value.value),
          bytes: Number(userBytes.value?.value ?? 0n),
          todayCount: Number(todayEntry.value?.value ?? 0n),
        });
      }
      perUser.sort((a, b) => b.count - a.count);
      return {
        total: Number(totalEntry.value?.value ?? 0n),
        totalBytes: Number(bytesEntry.value?.value ?? 0n),
        perUser,
      };
    },
    async getUserDailySynthesisCount(userId: string, day: string): Promise<number> {
      const entry = await core.kv.get<Deno.KvU64>(["synthesis_daily", userId, day]);
      return Number(entry.value?.value ?? 0n);
    },
  };
}
