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

/**
 * Short and collision-resistant enough for a job's 50-entry history. Not
 * time-ordered: runs sort by `startedAt`, and the id only breaks a tie.
 */
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
 * Recording failures are swallowed HERE, not left to the adapters.
 *
 * The comment above this function used to claim the adapters did it, and that
 * was false in both directions — measured, not reasoned about:
 *
 *   work SUCCEEDS + recording fails -> threw "kv unavailable": a healthy poll
 *                                      reported failure because a diagnostic
 *                                      write failed.
 *   work THROWS   + recording fails -> threw "kv unavailable" instead of
 *                                      "feed fetch timed out": the diagnostic
 *                                      REPLACED the diagnosis, which is the
 *                                      worse of the two.
 *
 * The KV adapter does swallow internally, so this looked fine while KV was the
 * only thing anyone tried. That is precisely why the guard belongs at the one
 * place all four call sites pass through, rather than depending on every future
 * adapter remembering.
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

  /** Write the history entry, and never let that write escape. */
  const remember = async (extra: Partial<RunRecord>) => {
    try {
      await ctx.stores.metadata.recordRun({
        id: newRunId(),
        kind,
        trigger,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        ...extra,
      });
    } catch (recordingError) {
      // Deliberately only logged. The run itself already happened; losing its
      // history entry is a smaller harm than reporting a failure that did not
      // occur, or masking one that did.
      console.error(`[audio-feed] could not record ${kind} run history:`, recordingError);
    }
  };

  let result: T;
  try {
    result = await work();
  } catch (error) {
    await remember({ error: String((error as Error)?.message ?? error) });
    // The WORK's error, always. Rethrown after the recording attempt, and the
    // recording cannot substitute its own.
    throw error;
  }

  await remember(summarise(result));
  return result;
}
