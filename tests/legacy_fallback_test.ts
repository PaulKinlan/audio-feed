/**
 * Tests for read-path canonicalisation (audio-feed-hav3) and
 * legacy blob fallback in the audio route (audio-feed-rscz).
 *
 * Verifies:
 * 1. Read-path canonicalisation (audio-feed-hav3):
 *    - Feed adapter and listen page emit the canonical URL for episodes holding legacy flat keys.
 *    - Both emission sites agree on the derived URL.
 *    - Episodes already holding canonical keys emit without mutation.
 * 2. Legacy blob fallback (audio-feed-rscz):
 *    - GET /audio/<canonical-key> serves legacy flat blob when canonical is absent (200, correct bytes & type).
 *    - HEAD /audio/<canonical-key> reports legacy flat blob size and headers.
 *    - Range requests on fallback work (206, Content-Range, correct byte slice).
 *    - When BOTH canonical and legacy blobs exist, canonical is preferred.
 *    - When NEITHER exists, returns 404.
 *    - Direct flat-key requests (GET /audio/<flat-key>) still return 404 (whsl approval bypass closed).
 *    - Suspended / unapproved user requests fail closed with 403 on fallback.
 *    - Attacker cannot access victim's legacy blob via attacker's canonical URL.
 *    - Whole-object downloads are attributed to the canonical user.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";
import { enclosureUrl, toFeedEpisode } from "../src/feed/adapter.ts";
import { buildFeed } from "../src/feed/rss.ts";
import type { AppConfig } from "../src/config.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = {
  port: 8000,
  publicBaseUrl: BASE,
  adminToken: "admin-secret",
};

function setupTestApp(stores = memoryStores()) {
  const ctx = { config: CONFIG, stores };
  const app = createApp(ctx, createHandlers(ctx));
  return { ...app, stores, ctx };
}

// ---------------------------------------------------------------------------
// 1. Read-path canonicalisation tests (audio-feed-hav3)
// ---------------------------------------------------------------------------

Deno.test("hav3: feed adapter emits canonical enclosure URL for legacy flat-key episode", () => {
  const ep = makeEpisode({
    id: "ep-legacy-1",
    userId: "user-alpha",
    mode: "direct",
    status: "ready",
    audioKey: "legacy-track.wav",
    contentType: "audio/wav",
  });

  const feedEp = toFeedEpisode(ep, { publicBaseUrl: BASE });
  assert(feedEp !== null);
  assertEquals(
    feedEp.audioUrl,
    `${BASE}/audio/user-alpha/direct/ep-legacy-1.wav`,
    "feed adapter must emit canonical URL rather than legacy flat key",
  );

  const xml = buildFeed(
    {
      title: "Test Feed",
      selfUrl: `${BASE}/feed/token/test/direct.xml`,
      link: BASE,
      description: "Test description",
    },
    [feedEp],
  );
  assertStringIncludes(xml, `<enclosure url="${BASE}/audio/user-alpha/direct/ep-legacy-1.wav"`);
});

Deno.test("hav3: feed adapter and listen page agree on canonical URL for legacy flat keys", async () => {
  const stores = memoryStores();
  const user = makeUser({ id: "user-alpha", status: "approved" });
  await stores.metadata.putUser(user);

  const ep = makeEpisode({
    id: "ep-agreed-1",
    userId: "user-alpha",
    mode: "deepdive",
    status: "ready",
    audioKey: "audio/old-deepdive.mp3",
    contentType: "audio/mpeg",
  });
  await stores.metadata.putEpisode(ep);

  // 1. URL from feed adapter
  const feedEp = toFeedEpisode(ep, { publicBaseUrl: BASE });
  assert(feedEp !== null);
  const feedUrl = feedEp.audioUrl;
  assertEquals(feedUrl, `${BASE}/audio/user-alpha/deepdive/ep-agreed-1.mp3`);

  // 2. URL from listen page
  const { fetch } = await setupTestApp(stores);
  const res = await fetch(new Request(`${BASE}/listen/${user.feedToken}`));
  assertEquals(res.status, 200);
  const html = await res.text();

  assertStringIncludes(
    html,
    `${BASE}/audio/user-alpha/deepdive/ep-agreed-1.mp3`,
    "listen page must render the identical canonical URL",
  );

  // 3. enclosureUrl helper agreement
  assertEquals(enclosureUrl(BASE, ep), feedUrl);
});

Deno.test("hav3: episodes already holding canonical keys emit without change", () => {
  const ep = makeEpisode({
    id: "ep-canonical-1",
    userId: "user-alpha",
    mode: "direct",
    status: "ready",
    audioKey: "audio/user-alpha/direct/ep-canonical-1.mp3",
    contentType: "audio/mpeg",
  });

  const feedEp = toFeedEpisode(ep, { publicBaseUrl: BASE });
  assert(feedEp !== null);
  assertEquals(feedEp.audioUrl, `${BASE}/audio/user-alpha/direct/ep-canonical-1.mp3`);
});

// ---------------------------------------------------------------------------
// 2. Legacy blob fallback in audio route (audio-feed-rscz)
// ---------------------------------------------------------------------------
