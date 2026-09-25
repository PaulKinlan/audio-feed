/**
 * Operational stats recording (audio-feed-ndc).
 *
 * One helper, used by both the Deno.cron handlers and the admin manual
 * triggers, so a run looks the same in the history however it was started. The
 * alternative — instrumenting four call sites by hand — is how two of them end
 * up recording different fields and the dashboard quietly lies about one.
 *
 * Owned by: audio-feed-ndc.
 */

import type { AppContext } from "./app.ts";
import type { RunKind, RunRecord, RunTrigger } from "./storage/mod.ts";

/** Short, sortable, collision-resistant enough for a 50-entry history. */
function newRunId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Run `work`, then record what happened — including when it throws.
 *
 * A failed run is the one an operator most needs to see, so the error is part
 * of the record and the exception is re-thrown afterwards: recording must not
 * change the caller's control flow, only observe it.
 *
 * Recording failures are swallowed by the store adapters. A diagnostic write
 * must never be the reason a poll or a synthesis batch reports failure.
 */
export async function recordRun<T>(
  ctx: AppContext,
  kind: RunKind,
  trigger: RunTrigger,
  work: () => Promise<T>,
  summarise: (result: T) => Omit<RunRecord, "id" | "kind" | "trigger" | "startedAt" | "durationMs">,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = await work();
    await ctx.stores.metadata.recordRun({
      id: newRunId(),
      kind,
      trigger,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      ...summarise(result),
    });
    return result;
  } catch (error) {
    await ctx.stores.metadata.recordRun({
      id: newRunId(),
      kind,
      trigger,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      error: String((error as Error)?.message ?? error),
    });
    throw error;
  }
}
