/**
 * Native Deno.cron background jobs for Deno Deploy (audio-feed-dsn).
 *
 * Background: Deno Deploy isolates sleep when no HTTP requests arrive,
 * so in-memory setInterval loops (startFeedPollWorker / startSynthesisWorker)
 * pause when idle.
 *
 * Deno.cron jobs run on a global schedule in the cloud regardless of HTTP traffic:
 * 1. audio-feed-poll-feeds: runs every 15 minutes to poll due RSS/Atom feeds ("*\/15 * * * *").
 * 2. audio-feed-synthesis: runs every 2 minutes to drain the pending synthesis queue ("*\/2 * * * *").
 */

import type { AppContext } from "./app.ts";
import { runFeedPollBatch } from "./ingest/feed.ts";
import {
  createGeminiSynthesizer,
  runSynthesisBatch,
  type Synthesizer,
} from "./worker/synthesis.ts";

export type ContextProvider =
  | AppContext
  | (() => Promise<{ ctx: AppContext; synthesizer?: Synthesizer | null }>);

export interface CronRegistration {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
}

/**
 * Outcome of a registration attempt (audio-feed-2j5).
 *
 * This used to be `CronRegistration[]`, and `[]` meant at least three different
 * things: "this runtime has no Deno.cron", "there was nothing to register", and
 * "registration already happened". The first of those was the silent one - a
 * deployment where background polling never runs looked exactly like a healthy one,
 * because the function returned an empty array and said nothing.
 *
 * `ok` plus `reason` makes absence distinguishable; `jobs` is kept so a caller can
 * still assert which names and schedules were registered.
 */
export interface CronRegistrationResult {
  ok: boolean;
  registered: number;
  /** Set only when ok is false, so "unsupported" is never read as "nothing to do". */
  reason?: "cron-unavailable";
  jobs: CronRegistration[];
}

export function registerCronJobs(
  contextOrProvider: ContextProvider,
  deps: {
    cron?: (name: string, schedule: string, handler: () => Promise<void>) => void;
    synthesizer?: Synthesizer;
  } = {},
): CronRegistrationResult {
  const globalDeno = (globalThis as unknown as {
    Deno?: {
      cron?: (name: string, schedule: string, handler: () => Promise<void>) => void;
    };
  }).Deno;

  const cronFn = deps.cron ??
    (typeof globalDeno?.cron === "function" ? globalDeno.cron.bind(globalDeno) : null);

  if (!cronFn) {
    // Loud, and actionable: name the runtime condition and the consequence, rather
    // than returning [] and letting a deployment believe background work is running.
    // Does NOT throw - local dev and the test suite run without --unstable-cron and
    // must keep starting (coord's decision on audio-feed-2j5).
    console.warn(
      "[audio-feed] Deno.cron is unavailable in this runtime; background cron jobs not scheduled",
    );
    return { ok: false, registered: 0, reason: "cron-unavailable", jobs: [] };
  }

  const registrations: CronRegistration[] = [];

  const resolveContext = async (): Promise<
    { ctx: AppContext; synthesizer: Synthesizer | null }
  > => {
    if (typeof contextOrProvider === "function") {
      const res = await contextOrProvider();
      return {
        ctx: res.ctx,
        synthesizer: res.synthesizer ??
          (res.ctx.config.geminiApiKey ? createGeminiSynthesizer(res.ctx) : null),
      };
    }
    const ctx = contextOrProvider;
    const synthesizer = deps.synthesizer ??
      (ctx.config.geminiApiKey ? createGeminiSynthesizer(ctx) : null);
    return { ctx, synthesizer };
  };

  // 1. Poll feeds every 15 minutes
  const pollJob: CronRegistration = {
    name: "audio-feed-poll-feeds",
    schedule: "*/15 * * * *",
    handler: async () => {
      try {
        const { ctx } = await resolveContext();
        const result = await runFeedPollBatch(ctx);
        console.log(
          `[audio-feed] cron feeds: polled ${result.polled}, queued ${result.queued}, failed ${result.failed}`,
        );
      } catch (err) {
        console.error("[audio-feed] cron feeds error:", err);
      }
    },
  };
  cronFn(pollJob.name, pollJob.schedule, pollJob.handler);
  registrations.push(pollJob);

  // 2. Synthesize queue every 2 minutes
  const isStaticUnconfigured = typeof contextOrProvider !== "function" &&
    !contextOrProvider.config.geminiApiKey && !deps.synthesizer;

  if (!isStaticUnconfigured) {
    const synthJob: CronRegistration = {
      name: "audio-feed-synthesis",
      schedule: "*/2 * * * *",
      handler: async () => {
        try {
          const { ctx, synthesizer } = await resolveContext();
          if (!synthesizer) return;
          const result = await runSynthesisBatch(ctx, synthesizer);
          if (result.ready.length || result.failed.length || result.deferred.length) {
            console.log(
              `[audio-feed] cron synthesis: ${result.ready.length} ready, ${result.failed.length} failed, ` +
                `${result.deferred.length} deferred (of ${result.considered})`,
            );
          }
          for (const { episodeId, heldMs, leaseMs } of result.superseded) {
            console.warn(
              `[audio-feed] cron synthesis: episode ${episodeId} superseded after ` +
                `${Math.round(heldMs / 1000)}s, lease was ${Math.round(leaseMs / 1000)}s — ` +
                `paid work discarded; raise leaseMs above the real synthesis time`,
            );
          }
        } catch (err) {
          console.error("[audio-feed] cron synthesis error:", err);
        }
      },
    };
    cronFn(synthJob.name, synthJob.schedule, synthJob.handler);
    registrations.push(synthJob);
  }

  return {
    ok: true,
    registered: registrations.length,
    jobs: registrations,
  };
}
