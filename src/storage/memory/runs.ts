/**
 * Background-job history for the admin dashboard.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import {
  compareRunsNewestFirst,
  type MetadataStore,
  RUN_HISTORY_LIMIT,
  RUN_KINDS,
  type RunRecord,
} from "../mod.ts";
import type { RunRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";

export function createRunsRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): RunRepository {
  return {
    /** Newest first, bounded on write per job — the same contract the KV adapter honours. */
    recordRun(record: RunRecord): Promise<void> {
      // A run of idle ticks is kept as one row, the latest, as in the KV adapter
      // (audio-feed-0ob). #runs is newest first, so find() gets the job's newest.
      const newest = state.runs.find((r) => r.kind === record.kind);
      if (
        record.idle && newest?.idle &&
        Date.parse(newest.startedAt) <= Date.parse(record.startedAt)
      ) {
        state.runs.splice(state.runs.indexOf(newest), 1);
      }
      state.runs.push(structuredClone(record));
      state.runs.sort(compareRunsNewestFirst);
      // Per job (audio-feed-ct1): a busy job must not evict a quiet one's history.
      const sameJob = state.runs.filter((r) => r.kind === record.kind);
      for (const stale of sameJob.slice(RUN_HISTORY_LIMIT)) {
        state.runs.splice(state.runs.indexOf(stale), 1);
      }
      return Promise.resolve();
    },
    listRuns(
      limit = RUN_HISTORY_LIMIT * RUN_KINDS.length,
      kind?: RunRecord["kind"],
    ): Promise<RunRecord[]> {
      // Scope BEFORE slicing: filtering after a slice is how a job that records often crowds out
      // the job being asked about (audio-feed-506m).
      const all = kind ? state.runs.filter((run) => run.kind === kind) : state.runs;
      return Promise.resolve(all.slice(0, limit).map((r) => structuredClone(r)));
    },
  };
}
