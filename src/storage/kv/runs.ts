/**
 * Background-job history for the admin dashboard.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { MetadataStore, RunRecord, RunRepository } from "../mod.ts";
import type { KvCore } from "./core.ts";
import { compareRunsNewestFirst, RUN_HISTORY_LIMIT, RUN_KINDS } from "../mod.ts";
import { descendingKey } from "./core.ts";

export function createRunsRepository(core: KvCore, _host: () => MetadataStore): RunRepository {
  return {
    /**
     * Newest-first key under the job's own prefix, then prune that job past the
     * limit.
     *
     * Bounded on WRITE rather than on read: an unbounded history reads cheaply
     * today and is a multi-megabyte scan a year in, which is the audio-feed-att
     * failure. The prune costs one bounded list per run, and runs are minutes
     * apart.
     *
     * Keyed and pruned PER JOB (audio-feed-ct1). Under one shared ["run"] prefix
     * the synthesis cron's idle ticks evicted every feed poll within about 100
     * minutes.
     */
    async recordRun(record: RunRecord): Promise<void> {
      try {
        const job = ["run", record.kind];
        const key = [...job, descendingKey(record.startedAt, record.id)];
        if (record.idle) {
          // A run of idle ticks is kept as one row, the latest (audio-feed-0ob). When
          // the job's newest row is an idle tick that started no later, swap this
          // one in for it: the history does not grow, so there is nothing to prune,
          // and the write reads one entry instead of the job's whole history.
          for await (const newest of core.kv.list<RunRecord>({ prefix: job }, { limit: 1 })) {
            if (
              newest.value?.idle &&
              Date.parse(newest.value.startedAt) <= Date.parse(record.startedAt)
            ) {
              const swap = core.kv.atomic().check(newest).delete(newest.key).set(key, record);
              // If the row changed underneath us, fall through to an ordinary insert.
              if ((await swap.commit()).ok) return;
            }
          }
        }
        await core.kv.set(key, record);
        // Drop anything past the limit. `list` is ascending over descending keys,
        // so everything after the first RUN_HISTORY_LIMIT entries is older.
        let seen = 0;
        for await (const entry of core.kv.list<RunRecord>({ prefix: job })) {
          seen++;
          if (seen > RUN_HISTORY_LIMIT) await core.kv.delete(entry.key);
        }
      } catch {
        // History is diagnostic. Losing a record must not fail the run it describes.
      }
    },
    /** Every job's newest-first history, merged; `kind` scopes it to one job (see RunRepository). */
    async listRuns(
      limit = RUN_HISTORY_LIMIT * RUN_KINDS.length,
      kind?: RunRecord["kind"],
    ): Promise<RunRecord[]> {
      const out: RunRecord[] = [];
      for (const job of kind ? [kind] : RUN_KINDS) {
        for await (const entry of core.kv.list<RunRecord>({ prefix: ["run", job] }, { limit })) {
          if (entry.value) out.push(entry.value);
        }
      }
      return out.sort(compareRunsNewestFirst).slice(0, limit);
    },
  };
}
