/**
 * Cloudflare Workers entrypoint for audio-feed.
 *
 * Serves HTTP traffic via `fetch()` and runs the three background jobs via
 * Cloudflare Cron Triggers in `scheduled()`:
 *   - `*\/15 * * * *`: poll due RSS/Atom feeds
 *   - `*\/2 * * * *`:  drain the pending synthesis queue
 *   - `17 4 * * *`:    enforce log retention
 */

import { type AppContext, createApp } from "./app.ts";
import {
  DEFAULT_LOG_RETENTION_DAYS,
  loadConfig,
  openD1Stores,
} from "./config.ts";
import { listDueFeedSources, pollFeedSource, runFeedPollBatch } from "./ingest/feed.ts";
import {
  emailIngestAddress,
  ingestEmailMessage,
  MAX_EMAIL_BYTES,
  parseEmailRecipient,
} from "./ingest/email.ts";
import { createHandlers } from "./compose.ts";
import { screenErrorForLogging } from "./observability/error_screen.ts";
import { recordRun } from "./stats.ts";
import { runScheduledBriefings } from "./worker/briefing.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "./worker/synthesis.ts";
import {
  type EpisodeSynthesisParams,
  EpisodeSynthesisWorkflow,
  triggerEpisodeWorkflow,
  WORKFLOW_CLAIM_LEASE_MS,
  type WorkflowBindingLike,
} from "./worker/synthesis_workflow.ts";
import type { D1DatabaseLike } from "./storage/d1/types.ts";
import type { R2BucketLike } from "./storage/r2.ts";
import type { EnvReader } from "./tts/gemini.ts";

export { emailIngestAddress, EpisodeSynthesisWorkflow };

export interface ForwardableEmailMessageLike {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface FeedPollQueueMessage {
  userId: string;
  sourceId: string;
}

export interface QueueBindingLike<T = unknown> {
  send(body: T): Promise<void>;
  sendBatch(messages: Iterable<{ body: T }>): Promise<void>;
}

export interface WorkerEnv {
  DB: D1DatabaseLike;
  AUDIO_BUCKET?: R2BucketLike;
  EPISODE_WORKFLOW?: WorkflowBindingLike<EpisodeSynthesisParams>;
  FEED_POLL_QUEUE?: QueueBindingLike<FeedPollQueueMessage>;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  PUBLIC_BASE_URL?: string;
  ALLOWED_HOSTS?: string;
  TRUST_PROXY_HEADERS?: string;
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_RELATED_ORIGINS?: string;
  GEMINI_API_KEY?: string;
  GEMINI_API_BASE_URL?: string;
  TTS_TIMEOUT_MS?: string;
  DEFAULT_VOICE?: string;
  DEFAULT_DAILY_EPISODE_BUDGET?: string;
  GLOBAL_DAILY_EPISODE_BUDGET?: string;
  MAX_SEGMENTS_PER_INVOCATION?: string;
  MAX_INVOCATION_DURATION_MS?: string;
  MAX_UPLOAD_RETRIES?: string;
  ADMIN_TOKEN?: string;
  AUDIOFEED_OBSERVABILITY_KEY?: string;
  LOG_RETENTION_DAYS?: string;
  NOTIFY_OUTBOX_ENABLED?: string;
  STORAGE_ENDPOINT?: string;
  STORAGE_BUCKET?: string;
  STORAGE_ACCESS_KEY_ID?: string;
  STORAGE_SECRET_ACCESS_KEY?: string;
  STORAGE_REGION?: string;
  STORAGE_PUBLIC_BASE_URL?: string;
  GIT_COMMIT_SHA?: string;
  [key: string]: unknown;
}

function makeEnvReader(env: WorkerEnv): EnvReader {
  return {
    get(key: string): string | undefined {
      if (key === "CF_VERSION_ID") {
        return env.CF_VERSION_METADATA?.id;
      }
      const value = env[key];
      return typeof value === "string" ? value : undefined;
    },
  };
}

function buildAppContext(env: WorkerEnv): AppContext {
  const reader = makeEnvReader(env);
  const config = loadConfig(reader);
  const stores = openD1Stores(env.DB, reader, env.AUDIO_BUCKET);
  const workflowBinding = env.EPISODE_WORKFLOW;
  return {
    config,
    stores,
    env: reader,
    ...(workflowBinding
      ? {
        triggerSynthesis: (episodeId, userId, opts) =>
          triggerEpisodeWorkflow(workflowBinding, episodeId, userId, opts),
      }
      : {}),
  };
}

async function runScheduledFeedPoll(ctx: AppContext, env?: WorkerEnv): Promise<void> {
  if (env?.FEED_POLL_QUEUE) {
    try {
      const due = await listDueFeedSources(ctx, { limit: 1000 });
      // Cloudflare Queues sendBatch accepts at most 100 messages per call.
      for (let start = 0; start < due.length; start += 100) {
        const chunk = due.slice(start, start + 100);
        await env.FEED_POLL_QUEUE.sendBatch(
          chunk.map((source) => ({
            body: { userId: source.userId, sourceId: source.id },
          })),
        );
      }
      console.log(`[audio-feed] cron feeds: enqueued ${due.length} due source(s) to FEED_POLL_QUEUE`);
      await ctx.stores.metadata.appendLog({
        time: new Date().toISOString(),
        severity: "info",
        type: "feed.poll",
        message: `cron feeds: enqueued ${due.length} due source(s) to queue`,
        process: "cron",
        job: "audio-feed-poll-feeds",
        context: { enqueued: due.length },
      });
    } catch (err) {
      console.error("[audio-feed] cron feeds fan-out error:", err);
      try {
        await ctx.stores.metadata.appendLog({
          time: new Date().toISOString(),
          severity: "error",
          type: "feed.poll",
          message: `cron feeds fan-out error: ${(err as Error)?.message ?? String(err)}`,
          process: "cron",
          job: "audio-feed-poll-feeds",
          stack: (err as Error)?.stack,
        });
      } catch {
        // ignore logging failure
      }
    }
    return;
  }

  try {
    const result = await recordRun(
      ctx,
      "feed-poll",
      "cron",
      () => runFeedPollBatch(ctx),
      (r) => ({
        polled: r.polled,
        queued: r.queued,
        failed: r.failed,
        errors: r.errors,
      }),
    );
    console.log(
      `[audio-feed] cron feeds: polled ${result.polled}, queued ${result.queued}, failed ${result.failed}`,
    );
    await ctx.stores.metadata.appendLog({
      time: new Date().toISOString(),
      severity: result.failed > 0 ? "warn" : "info",
      type: "feed.poll",
      message:
        `cron feeds: polled ${result.polled}, queued ${result.queued}, failed ${result.failed}`,
      process: "cron",
      job: "audio-feed-poll-feeds",
      context: {
        polled: result.polled,
        queued: result.queued,
        failed: result.failed,
        errors: result.errors,
      },
    });
  } catch (err) {
    console.error("[audio-feed] cron feeds error:", err);
    try {
      await ctx.stores.metadata.appendLog({
        time: new Date().toISOString(),
        severity: "error",
        type: "feed.poll",
        message: `cron feeds error: ${(err as Error)?.message ?? String(err)}`,
        process: "cron",
        job: "audio-feed-poll-feeds",
        stack: (err as Error)?.stack,
      });
    } catch {
      // ignore logging failure
    }
  }
}

async function runScheduledSynthesis(ctx: AppContext, env?: WorkerEnv): Promise<void> {
  if (!ctx.config.geminiApiKey) return;
  if (env?.EPISODE_WORKFLOW) {
    // Lightweight safety net when Cloudflare Workflows is bound: trigger durable
    // per-episode workflows for any pending episodes that haven't been started yet.
    try {
      const { episodes } = await ctx.stores.metadata.listPendingEpisodes({
        limit: 25,
        leaseMs: WORKFLOW_CLAIM_LEASE_MS,
      });
      for (const ep of episodes) {
        // If already owned by an active Workflow instance (e.g. a fresh retry run
        // or a step currently in exponential backoff), never spawn a duplicate.
        if (
          ep.status === "synthesizing" &&
          ep.claimedBy?.startsWith("workflow-") &&
          typeof env.EPISODE_WORKFLOW.get === "function"
        ) {
          const activeId = ep.claimedBy.slice("workflow-".length);
          try {
            const inst = await env.EPISODE_WORKFLOW.get(activeId);
            const st = inst.status ? (await inst.status()).status : "running";
            if (st === "running" || st === "queued" || st === "waiting" || st === "paused") {
              continue;
            }
          } catch {
            // Fall through to trigger a replacement workflow if lookup fails.
          }
        }
        try {
          await triggerEpisodeWorkflow(env.EPISODE_WORKFLOW, ep.id, ep.userId);
        } catch (err) {
          console.warn(
            `[audio-feed] cron workflow trigger failed for episode ${ep.id}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error("[audio-feed] cron workflow sweep error:", err);
    }
    return;
  }
  try {
    const synthesizer = createGeminiSynthesizer(ctx);
    const result = await recordRun(
      ctx,
      "synthesis",
      "cron",
      () => runSynthesisBatch(ctx, synthesizer),
      (r) => ({
        ready: r.ready.length,
        failed: r.failed.length,
        deferred: r.deferred.length,
        errors: r.failed.length > 0
          ? r.failed.slice(0, 10).map((f) =>
            f.title
              ? `Episode ${f.episodeId} ("${f.title}"): ${f.error}`
              : `Episode ${f.episodeId}: ${f.error}`
          )
          : undefined,
      }),
      (r) => r.ready.length === 0 && r.failed.length === 0 && r.yielded.length === 0,
    );
    if (
      result.ready.length || result.failed.length || result.deferred.length ||
      result.yielded.length
    ) {
      console.log(
        `[audio-feed] cron synthesis: ${result.ready.length} ready, ${result.failed.length} failed, ` +
          `${result.deferred.length} deferred, ${result.yielded.length} yielded (of ${result.considered})`,
      );
    }
    for (const { episodeId, heldMs, leaseMs } of result.superseded) {
      console.warn(
        `[audio-feed] cron synthesis: episode ${episodeId} superseded after ` +
          `${Math.round(heldMs / 1000)}s, lease was ${Math.round(leaseMs / 1000)}s`,
      );
    }
  } catch (err) {
    console.error("[audio-feed] cron synthesis error:", err);
  }
}

async function runScheduledBriefingsIfDue(
  ctx: AppContext,
  scheduledTime?: number,
): Promise<void> {
  const now = typeof scheduledTime === "number" && Number.isFinite(scheduledTime)
    ? new Date(scheduledTime)
    : new Date();
  // Piggyback on the */15 feed-poll cron during the first 15-minute window of each UTC hour
  // without adding another Cloudflare Cron Trigger slot.
  if (now.getUTCMinutes() >= 15) return;
  try {
    const result = await runScheduledBriefings(ctx, now);
    if (result.considered > 0) {
      console.log(
        `[audio-feed] cron briefings: considered=${result.considered}, queued=${result.queued}, ` +
          `empty=${result.empty}, skipped=${result.skipped}, failed=${result.failed}`,
      );
      await ctx.stores.metadata.appendLog({
        time: new Date().toISOString(),
        severity: result.failed > 0 ? "warn" : "info",
        type: "briefing.scheduled",
        message:
          `cron briefings: considered=${result.considered}, queued=${result.queued}, ` +
          `empty=${result.empty}, skipped=${result.skipped}, failed=${result.failed}`,
        process: "cron",
        job: "audio-feed-briefings",
        context: {
          considered: result.considered,
          queued: result.queued,
          empty: result.empty,
          skipped: result.skipped,
          failed: result.failed,
          ...(result.errors.length > 0 ? { errors: result.errors } : {}),
        },
      });
    }
  } catch (err) {
    console.error("[audio-feed] cron briefings error:", err);
    try {
      await ctx.stores.metadata.appendLog({
        time: new Date().toISOString(),
        severity: "error",
        type: "briefing.scheduled",
        message: `cron briefings error: ${(err as Error)?.message ?? String(err)}`,
        process: "cron",
        job: "audio-feed-briefings",
        stack: (err as Error)?.stack,
      });
    } catch {
      // ignore logging failure
    }
  }
}

async function runScheduledLogRetention(ctx: AppContext): Promise<void> {
  try {
    const days = ctx.config.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
    if (days <= 0) {
      console.log("[audio-feed] cron log retention: disabled (LOG_RETENTION_DAYS=0)");
      return;
    }
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pruned = await ctx.stores.metadata.pruneLogs(before);
    await ctx.stores.metadata.appendLog({
      time: new Date().toISOString(),
      severity: "info",
      type: "observability.retention",
      message: `pruned ${pruned} log record(s) older than ${days} day(s)`,
      process: "cron",
      job: "log-retention",
      context: { pruned, retentionDays: days },
    });
    console.log(`[audio-feed] cron log retention: pruned ${pruned} record(s)`);
  } catch (err) {
    console.error("[audio-feed] cron log retention error:", err);
  }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    _execCtx: ExecutionContext,
  ): Promise<Response> {
    const ctx = buildAppContext(env);
    const handlers = createHandlers(ctx);
    const app = createApp(ctx, handlers, async (error, req) => {
      console.error("[audio-feed] unhandled request error:", error);
      try {
        await ctx.stores.metadata.appendLog({
          time: new Date().toISOString(),
          severity: "error",
          type: "http.unhandled",
          message: (error as Error)?.message ?? String(error),
          process: "app",
          route: new URL(req.url).pathname,
          stack: (error as Error)?.stack,
        });
      } catch {
        // ignore logging failure
      }
    });

    // Cloudflare always injects the authoritative client IP in `cf-connecting-ip`.
    // Passing it as `remoteAddr` prevents spoofed `x-forwarded-for` headers from
    // rotating rate-limit buckets even when `TRUST_PROXY_HEADERS` is off.
    const cfIp = request.headers.get("cf-connecting-ip") ?? undefined;
    return await app.fetch(request, cfIp ? { remoteAddr: { hostname: cfIp } } : undefined);
  },

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    execCtx: ExecutionContext,
  ): Promise<void> {
    const ctx = buildAppContext(env);
    const work = (async () => {
      switch (controller.cron) {
        case "*/15 * * * *":
          await runScheduledFeedPoll(ctx, env);
          await runScheduledBriefingsIfDue(ctx, controller.scheduledTime);
          break;
        case "*/2 * * * *":
          await runScheduledSynthesis(ctx, env);
          break;
        case "17 4 * * *":
          await runScheduledLogRetention(ctx);
          break;
        default:
          // Allow manual trigger fallback in `wrangler dev --test-scheduled`
          await runScheduledFeedPoll(ctx, env);
          await runScheduledBriefingsIfDue(ctx, controller.scheduledTime);
          await runScheduledSynthesis(ctx, env);
          break;
      }
    })();
    execCtx.waitUntil(work);
    await work;
  },

  async queue(
    batch: MessageBatch<FeedPollQueueMessage>,
    env: WorkerEnv,
    _execCtx: ExecutionContext,
  ): Promise<void> {
    const ctx = buildAppContext(env);
    for (const msg of batch.messages) {
      try {
        const { userId, sourceId } = msg.body;
        const source = await ctx.stores.metadata.getSource(userId, sourceId);
        if (!source || !source.feedUrl) {
          msg.ack();
          continue;
        }
        const poll = await pollFeedSource(ctx, source);
        console.log(
          `[audio-feed] queue feed poll "${source.title || source.id}": queued=${poll.queued}, skipped=${poll.skipped}, failed=${poll.failed}${poll.notModified ? " (304)" : ""}`,
        );
        msg.ack();
      } catch (err) {
        console.error("[audio-feed] queue feed poll failed:", err);
        msg.retry();
      }
    }
  },

  async email(
    message: ForwardableEmailMessageLike,
    env: WorkerEnv,
    _execCtx: ExecutionContext,
  ): Promise<void> {
    // Enforce the 2 MiB size cap and recipient syntax BEFORE reading `message.raw` or querying D1.
    if (typeof message.rawSize === "number" && message.rawSize > MAX_EMAIL_BYTES) {
      message.setReject("Message exceeds the 2 MiB size limit.");
      return;
    }
    if (!parseEmailRecipient(message.to)) {
      message.setReject("Invalid recipient address.");
      return;
    }

    const ctx = buildAppContext(env);
    try {
      const result = await ingestEmailMessage(ctx, {
        to: message.to,
        from: message.from,
        raw: message.raw,
        rawSize: message.rawSize,
        headers: message.headers,
      });

      if (!result.ok) {
        if (result.reject) {
          message.setReject(result.reason);
        }
        console.warn(`[audio-feed] email ingest rejected (${result.code})`);
        return;
      }

      if (result.deduplicated) {
        console.log(
          `[audio-feed] email ingest deduplicated for user ${result.userId} (article ${result.articleId})`,
        );
      } else {
        console.log(
          `[audio-feed] email ingest queued episode ${result.episodeId} for user ${result.userId} (mode=${result.mode})`,
        );
      }
    } catch (err) {
      // Transient/internal error: do NOT call setReject (avoid permanent SMTP bounce) and
      // never log raw recipient addresses, headers, or feed tokens.
      const screened = screenErrorForLogging(err);
      console.error(`[audio-feed] email ingest error: ${screened.message}`);
      throw err;
    }
  },
};
