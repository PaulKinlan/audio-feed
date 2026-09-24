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

  const server = Deno.serve({ port: config.port }, fetch);

  // Close KV on shutdown so a redeploy does not leave a dangling handle.
  const shutdown = async () => {
    await server.shutdown();
    await stores.metadata.close();
  };
  Deno.addSignalListener("SIGINT", () => void shutdown());
  Deno.addSignalListener("SIGTERM", () => void shutdown());
}
