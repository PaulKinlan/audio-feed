/**
 * Entrypoint. Boots stores, mounts routes, serves.
 *
 * Deliberately thin: everything testable lives in `app.ts` and is exercised
 * without binding a port. This file only does the things that need a real
 * process — reading env, opening KV, calling `Deno.serve`.
 *
 * Owned by: audio-feed-0h8.
 */

import { createApp } from "./app.ts";
import { createHandlers } from "./compose.ts";
import { loadConfig, openStores } from "./config.ts";
import { createGeminiSynthesizer, startSynthesisWorker } from "./worker/synthesis.ts";

if (import.meta.main) {
  const config = loadConfig();
  const stores = await openStores();

  // audio-feed-agl: build the lane handlers, or every product route answers 501.
  const handlers = createHandlers({ config, stores });
  const { fetch } = createApp({ config, stores }, handlers);

  console.log(`[audio-feed] ${stores.describe} base=${config.publicBaseUrl}`);
  if (!config.geminiApiKey) {
    console.warn("[audio-feed] GEMINI_API_KEY unset — synthesis will be unavailable");
  }
  if (!config.adminToken) {
    console.warn("[audio-feed] ADMIN_TOKEN unset — admin approval routes are unusable");
  }

  // audio-feed-b3a: drain the ingest queue. Without a key there is nothing to
  // spend and nothing to do, so the worker simply does not start.
  const workerAbort = new AbortController();
  const worker = config.geminiApiKey
    ? startSynthesisWorker({ config, stores }, createGeminiSynthesizer({ config, stores }), {
      signal: workerAbort.signal,
      onTick: (result) => {
        if (result.ready.length || result.failed.length || result.deferred.length) {
          console.log(
            `[audio-feed] synthesis: ${result.ready.length} ready, ${result.failed.length} failed, ` +
              `${result.deferred.length} deferred (of ${result.considered})`,
          );
        }
        // Separate line, never folded into a success-shaped one: a tick that
        // reports "0 ready" while silently discarding paid work is exactly the
        // failure shape this whole change is about. The held-vs-lease numbers
        // make it actionable — they say how much too short the lease was, not
        // merely that it was (audio-feed-vfs / audio-feed-kiq).
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

  const server = Deno.serve({ port: config.port }, fetch);

  // Stop the worker before closing KV so no tick writes to a closed handle.
  const shutdown = async () => {
    workerAbort.abort();
    await worker?.stop();
    await server.shutdown();
    await stores.metadata.close();
  };
  Deno.addSignalListener("SIGINT", () => void shutdown());
  Deno.addSignalListener("SIGTERM", () => void shutdown());
}
