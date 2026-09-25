/**
 * Entrypoint. Boots stores, mounts routes, serves.
 *
 * Deliberately thin: everything testable lives in `app.ts` and is exercised
 * without binding a port. This file only does the things that need a real
 * process — reading env, opening KV, calling `Deno.serve`.
 *
 * Owned by: audio-feed-0h8.
 */

import { type AppContext, createApp } from "./app.ts";
import { createHandlers } from "./compose.ts";
import { loadConfig, openStores } from "./config.ts";
import {
  createGeminiSynthesizer,
  startSynthesisWorker,
  type SynthesisWorkerHandle,
  type Synthesizer,
} from "./worker/synthesis.ts";
import { type FeedPollWorkerHandle, startFeedPollWorker } from "./ingest/feed.ts";
import type { Stores } from "./config.ts";
import { registerCronJobs } from "./cron.ts";

const isDeploy = Boolean(Deno.env.get("DENO_REGION") || Deno.env.get("DENO_DEPLOYMENT_ID"));

export interface BootstrapOptions {
  // Every option here carries a distinct failure mode, and the seam was nearly
  // narrowed on the assumption that four options was too many for one test. It is
  // not: dropping `synthesizer` makes the mutant this suite exists to catch
  // ESCAPE. Measured by audiofeed-opus on audio-feed-1kw - remove the worker's
  // `!deploy` gate with no synthesizer injected and all tests pass, because
  // `!deploy && synthesizer` and `synthesizer` both yield null, so the Deploy
  // assertion cannot observe a removed gate at all. The stub is the only thing
  // that forces the worker to exist on Deploy, which is what gives that test
  // teeth. Do not "simplify" any of the four without re-running that mutation.
  //
  //   isDeploy     - without it neither branch is reachable from a test at all
  //   synthesizer  - makes the WORKER gate observable (see above)
  //   port, stores - hermeticity: no fixed port another lane holds, no default
  //                  persistent KV opened by a test run
  /**
   * Override Deploy detection. Defaults to the environment check above.
   *
   * Injectable because the module-level const is evaluated once at load, so a
   * test could never exercise the `!isDeploy` gates without it (audio-feed-1kw).
   */
  isDeploy?: boolean;
  /** Bind an ephemeral port with 0. A test must never bind a fixed one. */
  port?: number;
  /** Injected stores. Defaults to the configured backend, which opens real KV. */
  stores?: Stores;
  /**
   * Injected synthesizer. Defaults to the env-derived one.
   *
   * Load-bearing, not convenience: pass a stub so the worker gate has an
   * observable effect on Deploy. Omitting it in a test silently weakens
   * "on Deploy, neither worker starts" to something that always passes.
   */
  synthesizer?: Synthesizer | null;
}

export interface BootstrapResult {
  server: Deno.HttpServer;
  fetch: (req: Request) => Promise<Response> | Response;
  ctx: AppContext;
  synthesizer: Synthesizer | null;
  /**
   * The two in-memory background workers. Both are NULL on Deno Deploy, where
   * Deno.cron owns background work (audio-feed-562). Exposed so the wiring is
   * checkable: before audio-feed-1kw they were local to bootstrap(), which is
   * why deleting both gates left all 432 tests green.
   */
  worker: SynthesisWorkerHandle | null;
  feedPoller: FeedPollWorkerHandle | null;
  /** The Deploy decision this process actually booted with. */
  isDeploy: boolean;
  shutdown: () => Promise<void>;
}

let bootstrapPromise: Promise<BootstrapResult> | null = null;

/**
 * Idempotent bootstrap accessor (audio-feed-ncf).
 * Guarantees bootstrap() runs at most once per isolate, avoiding duplicate
 * Deno.cron registrations and Port In Use errors during cold-start races.
 */
export function getBootstrap(): Promise<BootstrapResult> {
  return bootstrapPromise ??= bootstrap();
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  // Read the decision per call, not once at module load: that is what lets the
  // gates below be exercised at all (audio-feed-1kw).
  const deploy = options.isDeploy ?? isDeploy;
  const config = loadConfig();
  const stores = options.stores ?? await openStores();
  const ctx: AppContext = { config, stores };

  const synthesizer = options.synthesizer !== undefined
    ? options.synthesizer
    : config.geminiApiKey
    ? createGeminiSynthesizer(ctx)
    : null;

  // audio-feed-agl: build the lane handlers, or every product route answers 501.
  const handlers = createHandlers(ctx);
  const app = createApp(ctx, handlers);
  const serverFetch = app.fetch;

  console.log(
    `[audio-feed] ${stores.describe} base=${config.publicBaseUrl ?? "<derived from each request>"}`,
  );
  if (config.trustProxyHeaders) {
    console.warn(
      "[audio-feed] TRUST_PROXY_HEADERS is on — x-forwarded-host/proto are honoured. " +
        "Only correct behind a proxy that overwrites client-supplied values.",
    );
  }
  if (!config.geminiApiKey) {
    console.warn("[audio-feed] GEMINI_API_KEY unset — synthesis will be unavailable");
  }
  if (!config.adminToken) {
    console.warn("[audio-feed] ADMIN_TOKEN unset — admin approval routes are unusable");
  }

  // audio-feed-562: on Deno Deploy, isolates sleep between requests and background
  // processing is handled by native Deno.cron. Running setInterval in Deploy causes
  // concurrent poll/synthesis races when isolates are awake (polling lacks CAS/leases,
  // so concurrent polls duplicate articles and double synthesis spend).
  // In-memory workers run ONLY outside Deploy (!isDeploy).
  const workerAbort = new AbortController();
  const worker = !deploy && synthesizer
    ? startSynthesisWorker(ctx, synthesizer, {
      signal: workerAbort.signal,
      onTick: (result) => {
        if (result.ready.length || result.failed.length || result.deferred.length) {
          console.log(
            `[audio-feed] synthesis: ${result.ready.length} ready, ${result.failed.length} failed, ` +
              `${result.deferred.length} deferred (of ${result.considered})`,
          );
        }
        for (const { episodeId, heldMs, leaseMs } of result.superseded) {
          console.warn(
            `[audio-feed] synthesis: episode ${episodeId} superseded after ` +
              `${Math.round(heldMs / 1000)}s, lease was ${Math.round(leaseMs / 1000)}s — ` +
              `paid work discarded; raise leaseMs above the real synthesis time`,
          );
        }
      },
    })
    : null;

  const feedPollAbort = new AbortController();
  const feedPoller = !deploy
    ? startFeedPollWorker(ctx, {
      signal: feedPollAbort.signal,
      onTick: (result) => {
        console.log(
          `[audio-feed] feeds: polled ${result.polled}, queued ${result.queued}, failed ${result.failed}`,
        );
      },
    })
    : null;

  const server = Deno.serve({ port: options.port ?? config.port }, serverFetch);

  // Stop the worker before closing KV so no tick writes to a closed handle.
  const shutdown = async () => {
    workerAbort.abort();
    feedPollAbort.abort();
    await feedPoller?.stop();
    await worker?.stop();
    await server.shutdown();
    await stores.metadata.close();
  };

  try {
    Deno.addSignalListener("SIGINT", () => void shutdown());
    Deno.addSignalListener("SIGTERM", () => void shutdown());
  } catch {
    // Signals not supported in serverless/Deno Deploy environments.
  }

  return {
    server,
    fetch: serverFetch,
    ctx,
    synthesizer,
    worker,
    feedPoller,
    isDeploy: deploy,
    shutdown,
  };
}

// audio-feed-dsn / audio-feed-ncf: Native Deno.cron background jobs on Deno Deploy.
// Registered at module top-level for Deno Deploy static discovery and single registration.
registerCronJobs(async () => {
  const { ctx, synthesizer } = await getBootstrap();
  return { ctx, synthesizer };
});

if (import.meta.main || isDeploy) {
  await getBootstrap();
}

export default {
  async fetch(req: Request) {
    const { fetch } = await getBootstrap();
    return fetch(req);
  },
};
