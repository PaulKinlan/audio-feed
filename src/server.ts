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
import { allowedHostSet, isUnusableOrigin } from "./origin.ts";
import { type AppConfig, loadConfig, openStores } from "./config.ts";
import {
  createGeminiSynthesizer,
  startSynthesisWorker,
  type SynthesisWorkerHandle,
  type Synthesizer,
} from "./worker/synthesis.ts";
import { type FeedPollWorkerHandle, startFeedPollWorker } from "./ingest/feed.ts";
import type { Stores } from "./config.ts";
import { registerCronJobs } from "./cron.ts";
import { type AudioInventoryResult, inventoryLegacyAudioKeys } from "./storage/legacy_audio.ts";
import { screenErrorMessage, screenErrorName } from "./observability/error_screen.ts";
import { createLogger, isHighVolumeRoute, isObservabilityRoute, normaliseMethod } from "./log.ts";

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
  //   port         - omitting it binds config.port (8000). Measured by audiofeed-opus:
  //                    with 8000 held, rebinding is REFUSED with AddrInUse; at port 0 it
  //                    is accepted. A test that binds a fixed port does not merely risk
  //                    flakiness, it blocks whichever lane is already serving there -
  //                    and that lane cannot tell that a test is the cause.
  //                    (Their first check for this was not evidence: removing port: 0 and
  //                    seeing tests pass proved only that 8000 happened to be free.)
  //   stores       - NOT just hermeticity. Measured: openStores() with no kvPath opens
  //                    the DEFAULT persistent KV. opus wrote a marker, closed, reopened,
  //                    and the marker PERSISTED - so a test omitting this option writes
  //                    into the developer's own real store, and the writes outlive the
  //                    run. Naming the consequence rather than calling it isolation is
  //                    the point: "hermeticity" reads as nice-to-have, and nice-to-haves
  //                    are what gets deleted by the next person simplifying this list.
  //
  // Do not treat `port` and `stores` as the soft targets of that simplification either:
  // both were verified by mutation, not asserted, and neither can be caught by a passing
  // suite - a green run on a free port and an empty KV looks identical to a correct one.
  /**
   * Override Deploy detection. Defaults to the environment check above.
   *
   * Injectable because the module-level const is evaluated once at load, so a
   * test could never exercise the `!isDeploy` gates without it (audio-feed-1kw).
   */
  isDeploy?: boolean;
  /**
   * Port to serve on. Pass 0 in tests to bind ephemerally.
   *
   * Defaults to config.port (8000), which is a shared, contested resource on this
   * machine: a test that omits this can block another lane's live server, and that
   * lane has no way to discover a test was the cause.
   */
  port?: number;
  /**
   * Injected stores. Defaults to the configured backend.
   *
   * That default opens the persistent KV, and writes there SURVIVE the process - so a
   * test omitting this option is not merely non-hermetic, it mutates the developer's
   * real data store (audio-feed-wy1, measured by audiofeed-opus). Pass
   * `await openStores({ kvPath: ":memory:" })`.
   */
  stores?: Stores;
  /**
   * Injected synthesizer. Defaults to the env-derived one.
   *
   * Load-bearing, not convenience: pass a stub so the worker gate has an
   * observable effect on Deploy. Omitting it in a test silently weakens
   * "on Deploy, neither worker starts" to something that always passes.
   */
  synthesizer?: Synthesizer | null;
  /** Injected config overrides (audio-feed-bns). */
  config?: Partial<AppConfig>;
  /** Run legacy audio key inventory at boot (audio-feed-e6xb). Defaults to true. */
  inventory?: boolean;
}

export interface BootstrapResult {
  server: Deno.HttpServer;
  fetch: (
    req: Request,
    info?: { remoteAddr?: { hostname?: string } },
  ) => Promise<Response> | Response;
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
  /** Legacy audio key inventory promise (audio-feed-e6xb). */
  inventory?: Promise<AudioInventoryResult | null>;
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
  const config = { ...loadConfig(), ...options.config };
  if (options.port !== undefined) config.port = options.port;
  const stores = options.stores ?? await openStores();
  const ctx: AppContext = { config, stores };

  const synthesizer = options.synthesizer !== undefined
    ? options.synthesizer
    : config.geminiApiKey
    ? createGeminiSynthesizer(ctx)
    : null;

  // audio-feed-agl: build the lane handlers, or every product route answers 501.
  const handlers = createHandlers(ctx);
  // audio-feed-sw1r: an unhandled throw is caught by the ROUTER's fetchHandler, so the record is written
  // from the hook rather than from the try/catch below (which stays as defence in depth for a throw that
  // escapes this path). Class name AND the SCREENED message - never the raw message, which can quote the
  // request. The correlation id is minted per request below, so this hook does not have it; the route
  // pattern is recorded instead, which is a constant from the route table.
  const onUnhandledError = async (error: unknown, req: Request): Promise<void> => {
    await appLog.error(
      "http.request",
      `unhandled ${errorName(error)} on ${
        router.routePatternFor(
          new URL(req.url),
        )
      }`,
      {
        route: router.routePatternFor(new URL(req.url)),
        context: { error: errorName(error), errorMessage: screenErrorMessage(error) },
      },
    );
  };
  const app = createApp(ctx, handlers, onUnhandledError);
  // audio-feed-wzv9: the app's structured records, in one wrapper so no handler has to remember.
  // The correlation id is minted per request and echoed in a response header, so an operator
  // holding a failing request can find every record about it.
  const appFetch = app.fetch;
  // The route table the app dispatches with, so the request record can name a pattern instead of a
  // path. Looked up per request rather than carried on the Request: the app rebuilds requests
  // during canonical-host handling (audio-feed-wzv9, audio-feed-pwu4).
  const router = app.router;
  const appLog = createLogger({ sink: stores.metadata, process: "app" });
  // Only the class name of a throw, screened to KNOWN_ERROR_NAMES (audio-feed-z1gs), so an
  // attacker-chosen custom error name cannot reach a record.
  const errorName = (error: unknown): string => screenErrorName(error);
  const serverFetch = async (
    req: Request,
    info?: { remoteAddr?: { hostname?: string } },
  ): Promise<Response> => {
    const correlationId = crypto.randomUUID();
    const started = performance.now();
    // The ROUTE PATTERN the URL matches, never the path: a constant from the route table, so no
    // user-controlled byte can reach a record (audio-feed-wzv9, audio-feed-pwu4). A request that
    // matches nothing records a fixed marker rather than any raw path content.
    const route = router.routePatternFor(new URL(req.url));
    const durationMs = () => Math.round(performance.now() - started);
    try {
      const res = await appFetch(req, info);
      // A successful asset or enclosure fetch is deliberately not recorded — see
      // isHighVolumeAssetPath — because podcast clients hammer it and each line would cost a
      // write for nothing. Its failures still are.
      // Successes on the observability API are excluded too: recording them would make the store
      // grow every time it is read, so "nothing changed" could never be true (audio-feed-s2pi).
      const worthRecording = res.status >= 400 ||
        (!isHighVolumeRoute(route) && !isObservabilityRoute(route));
      if (worthRecording) {
        // AUDIT OF EVERY REQUEST-DERIVED FIELD IN THIS RECORD, since a path and then a method each
        // leaked a client-chosen string (audio-feed-pwu4, audio-feed-ao4s). The rule is that no
        // field derived from the request is logged raw:
        //   method   normalised through the methods this app serves, else "<other>" (ao4s)
        //   route    the registered pattern the URL matched, never the path (pwu4)
        //   status   a number the platform bounds to a valid HTTP code; it cannot carry a string
        //   durationMs  measured here, not taken from the request
        //   correlationId  minted here with randomUUID; an inbound header is never adopted, so a
        //              caller cannot choose the value that appears in a record
        //   error    only the error's CLASS NAME, below — a name from this codebase's own throw
        //            sites, never its message or stack, which can quote the request
        // Nothing else about the request is recorded: no headers, no query string, no body, no
        // client address. The invariant test fuzzes each of those surfaces independently.
        const method = normaliseMethod(req.method);
        const fields = {
          correlationId,
          route,
          durationMs: durationMs(),
          context: { method, status: res.status },
        };
        const line = `${method} ${route} -> ${res.status}`;
        if (res.status >= 500) await appLog.error("http.request", line, fields);
        else if (res.status >= 400) await appLog.warn("http.request", line, fields);
        else await appLog.event("http.request", line, fields);
      }
      const headers = new Headers(res.headers);
      headers.set("x-correlation-id", correlationId);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch (error) {
      // The error's NAME only in the main message. `failure()` now screens the thrown message
      // and stores a header-only stack without caller frames; this request record intentionally
      // stores no stack at all. The raw unhandled message can quote client-chosen request text,
      // so the separate context.errorMessage below is screened before it is recorded.
      await appLog.error("http.request", `unhandled ${errorName(error)} on ${route}`, {
        correlationId,
        route,
        durationMs: durationMs(),
        // The message is SCREENED, not truncated (audio-feed-sw1r): a length bound or a character filter
        // would only shorten a client-chosen string, so the stored value is drawn from a closed list of
        // phrases this codebase throws and the original is discarded. See src/observability/error_screen.ts;
        // the canary invariant test drives a request that THROWS with an attacker-chosen query string and
        // asserts the canary is absent from the whole durable record.
        context: { error: errorName(error), errorMessage: screenErrorMessage(error) },
      });
      throw error;
    }
  };

  console.log(
    `[audio-feed] ${stores.describe} base=${config.publicBaseUrl ?? "<derived from each request>"}`,
  );
  // One-time boot inventory of legacy flat audio keys (audio-feed-e6xb).
  // Informs operator of surviving legacy flat audio keys without blocking startup.
  // Strictly aggregate counts only — never logs user IDs or key fragments (audio-feed-tyxd).
  const inventory = options.inventory !== false
    ? inventoryLegacyAudioKeys(stores.metadata)
      .then((inv) => {
        if (inv.legacyCount > 0) {
          console.warn(
            `[audio-feed] legacy audio key inventory: found ${inv.legacyCount} legacy flat key(s) ` +
              `(${inv.canonicalCount} canonical, ${inv.totalEpisodesScanned} total episodes across ${inv.totalUsersScanned} user(s)). ` +
              `Shapes: flat=${inv.byShape.flat} audioPrefixed=${inv.byShape.audioPrefixed} nested=${inv.byShape.nested}. ` +
              `Extensions: wav=${inv.byExtension[".wav"]} mp3=${inv.byExtension[".mp3"]} other=${
                inv.byExtension["other"]
              }`,
          );
        } else {
          console.log(
            `[audio-feed] legacy audio key inventory: 0 legacy flat keys found ` +
              `(${inv.canonicalCount} canonical, ${inv.totalEpisodesScanned} total episodes across ${inv.totalUsersScanned} user(s))`,
          );
        }
        return inv;
      })
      .catch((err) => {
        console.warn(`[audio-feed] legacy audio key inventory failed: ${err}`);
        return null;
      })
    : undefined;

  if (config.trustProxyHeaders) {
    console.warn(
      "[audio-feed] TRUST_PROXY_HEADERS is on — x-forwarded-host/proto are honoured. " +
        "Only correct behind a proxy that overwrites client-supplied values.",
    );
  }
  // audio-feed-7lsy: the host gate configures itself. PUBLIC_BASE_URL's host is the accepted
  // one and the WebAuthn RP ID already comes from the same value, so the app does not need an
  // operator to type its own hostname into a second variable; ALLOWED_HOSTS only ADDS hosts
  // (staging, a custom domain). Saying so at boot is the point — the previous design was
  // correct but inert, which is indistinguishable from working.
  // audio-feed-ft74: a configured origin that cannot be parsed must not crash STARTUP. The earlier
  // version of this line called `new URL(...)` unguarded, so PUBLIC_BASE_URL=not-a-url killed boot with
  // a raw TypeError while only warning was appropriate. isUnusableOrigin already treats such a value as
  // unusable and the gate then refuses every non-loopback host, so the logging path says that instead
  // of throwing - bad configuration must never be fatal at boot, and never from a log statement.
  const configuredHost = config.publicBaseUrl && !isUnusableOrigin(config.publicBaseUrl)
    ? new URL(config.publicBaseUrl).hostname
    : null;
  // audio-feed-4x4t: EVERY branch here keys on the USABLE host set, never on the raw ALLOWED_HOSTS array,
  // and the four branches together cover every configuration state - so no configuration can be silent.
  // A list whose entries are all unusable - ["not a host", ""] - is non-empty but configures nothing;
  // keying on `.length` suppressed the warning and left the deployment refusing every non-loopback host
  // without a word, and the same `.length` test one branch down also suppressed the positive line for a
  // deployment that WAS working. Both are the same operator cost: an app that tells you nothing about
  // which hosts it will serve. allowedHostSet is the gate's own notion of "usable", exported for these
  // lines so the log and the gate cannot drift apart again.
  const usableHostCount = allowedHostSet(config).size;
  if (!configuredHost && usableHostCount === 0) {
    // audio-feed-3k2d: this state is the live outage of audio-feed-du8w — an unconfigured Deploy
    // deployment that answers every visitor with a refusal naming nothing they can fix. It stays a
    // warning rather than a thrown assertion because audio-feed-ft74 established that bad
    // configuration must never be fatal at boot (and a boot crash on Deploy can be rolled back to
    // the previous version, leaving the operator no diagnostic at all). What changed is the level on
    // a real deployment: this is error-level there, because the deployment cannot serve anyone, and
    // the line now says what the visitor actually gets (500 server_misconfigured, which names
    // PUBLIC_BASE_URL) instead of the stale 421 wording.
    const unconfiguredMessage =
      "[audio-feed] No usable PUBLIC_BASE_URL and no usable ALLOWED_HOSTS entry" +
      (deploy ? " on a Deploy deployment" : "") +
      (config.publicBaseUrl ? ` (${config.publicBaseUrl} is not a usable origin)` : "") +
      " — the host gate REFUSES every non-loopback host and answers 500 server_misconfigured, " +
      "naming this variable in the body, because a deployment that cannot name its own host must not " +
      "advertise the one a client sent. Set PUBLIC_BASE_URL to the public origin; ALLOWED_HOSTS only " +
      "adds extra hosts.";
    if (deploy) console.error(unconfiguredMessage);
    else console.warn(unconfiguredMessage);
  } else if (!configuredHost) {
    // ALLOWED_HOSTS alone still activates the gate. Previously this state logged nothing at all.
    console.log(
      `[audio-feed] Host gate: accepting ${usableHostCount} host(s) from ALLOWED_HOSTS. ` +
        `Set PUBLIC_BASE_URL to the public origin so the gate also pins one advertised origin.`,
    );
  } else if (usableHostCount === 1) {
    console.log(
      `[audio-feed] Host gate: accepting ${configuredHost} ` +
        `(from PUBLIC_BASE_URL). ALLOWED_HOSTS overrides/extends this list.`,
    );
  } else {
    console.log(
      `[audio-feed] Host gate: accepting ${configuredHost} (from PUBLIC_BASE_URL) ` +
        `plus ${usableHostCount - 1} extra host(s) from ALLOWED_HOSTS.`,
    );
  }
  if (!config.geminiApiKey) {
    console.warn("[audio-feed] GEMINI_API_KEY unset — synthesis will be unavailable");
  }
  if (!config.adminToken) {
    console.warn("[audio-feed] ADMIN_TOKEN unset — admin approval routes are unusable");
  } else if (config.adminToken.length < 16) {
    console.warn(
      `[audio-feed] WARNING: ADMIN_TOKEN is short (${config.adminToken.length} chars). ` +
        "A minimum of 16 characters (or a strong multi-word passphrase) is recommended.",
    );
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

  const server = Deno.serve(
    { port: options.port ?? config.port },
    (req, info) => serverFetch(req, info),
  );

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
    inventory,
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
  async fetch(req: Request, info?: { remoteAddr?: { hostname?: string } }) {
    const { fetch } = await getBootstrap();
    return fetch(req, info);
  },
};
