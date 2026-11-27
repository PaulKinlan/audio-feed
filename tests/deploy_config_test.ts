/**
 * Verifies the Cloudflare Workers deployment config (`wrangler.jsonc`) stays pinned
 * to the real entrypoint, custom domain, D1 database, R2 bucket, and cron triggers.
 */

import { assert, assertEquals } from "@std/assert";

Deno.test("wrangler.jsonc pins entrypoint, audiofeed.app custom domain, D1, R2, and cron triggers", async () => {
  const raw = await Deno.readTextFile(new URL("../wrangler.jsonc", import.meta.url));
  const config = JSON.parse(raw);

  assertEquals(config.name, "audio-feed");
  assertEquals(config.main, "src/worker_entry.ts");
  assert(
    Array.isArray(config.routes) &&
      config.routes.some((r: { pattern?: string; custom_domain?: boolean }) =>
        r.pattern === "audiofeed.app" && r.custom_domain === true
      ),
    "wrangler.jsonc must route custom domain audiofeed.app",
  );
  assertEquals(config.vars?.PUBLIC_BASE_URL, "https://audiofeed.app");
  assertEquals(config.vars?.WEBAUTHN_RP_ID, "audiofeed.app");
  assert(
    Array.isArray(config.d1_databases) &&
      config.d1_databases.some((d: { binding?: string; database_name?: string }) =>
        d.binding === "DB" && d.database_name === "audio-feed"
      ),
    "wrangler.jsonc must bind D1 database audio-feed as DB",
  );
  assert(
    Array.isArray(config.r2_buckets) &&
      config.r2_buckets.some((b: { binding?: string; bucket_name?: string }) =>
        b.binding === "AUDIO_BUCKET" && b.bucket_name === "audio-feed"
      ),
    "wrangler.jsonc must bind R2 bucket audio-feed as AUDIO_BUCKET",
  );
  assertEquals(config.triggers?.crons, ["*/15 * * * *", "*/2 * * * *", "17 4 * * *"]);
});
