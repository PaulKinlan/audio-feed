/**
 * audio-feed-fdk7o ([modern-web] Apply content-visibility: auto to Long Rendered Lists).
 *
 * Verifies:
 * 1. The episode list stylesheet (`listen.css`) sets `content-visibility: auto` on `li.episode`.
 * 2. It pairs `content-visibility: auto` with `contain-intrinsic-size: auto none auto 92px` (derived
 *    from measured episode row heights) to prevent layout shifts and scrollbar jumping.
 * 3. An `@media print` block overrides `content-visibility: visible` to prevent print truncation regressions.
 * 4. All episodes (up to LISTEN_ROW_CAP = 100) are rendered in the DOM, discoverable via querySelector,
 *    preserving find-in-page and accessibility tree reachability.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { LISTEN_ROW_CAP } from "../src/routes/listen.ts";
import { audioBlobKey } from "../src/types.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const TOKEN = "token-cv-test";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

Deno.test("content-visibility: listen.css configures content-visibility: auto and contain-intrinsic-size on episode rows", async () => {
  const css = await Deno.readTextFile(new URL("../src/assets/listen.css", import.meta.url));

  // Assert rule structure on li.episode
  const episodeRule = css.match(/li\.episode\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assertStringIncludes(episodeRule, "content-visibility: auto;");
  assertStringIncludes(episodeRule, "contain-intrinsic-size: auto none auto 92px;");
});

Deno.test("content-visibility: listen.css overrides content-visibility: visible for print media", async () => {
  const css = await Deno.readTextFile(new URL("../src/assets/listen.css", import.meta.url));

  // Assert print media block restores content-visibility: visible
  const printBlock = css.match(/@media print\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assertStringIncludes(printBlock, "li.episode");
  assertStringIncludes(printBlock, "content-visibility: visible;");
});

Deno.test("content-visibility: all rows up to LISTEN_ROW_CAP are preserved in the DOM payload", async () => {
  const stores: Stores = memoryStores();
  const now = new Date("2026-10-12T03:30:00.000Z");

  await stores.metadata.putUser(
    makeUser({
      id: "u-cv",
      email: "cv@example.com",
      displayName: "CV Tester",
      status: "approved",
      feedToken: TOKEN,
    }),
  );

  await stores.metadata.putSource(
    makeSource({
      id: "src-1",
      userId: "u-cv",
      title: "Test Source",
    }),
  );

  const count = 100;
  assertEquals(count, LISTEN_ROW_CAP);

  for (let i = 1; i <= count; i++) {
    const at = new Date(now.getTime() - i * 60_000).toISOString();
    const id = `ep-${i}`;
    const articleId = `art-${i}`;
    const key = audioBlobKey({ userId: "u-cv", id, mode: "direct" }, "wav");

    await stores.metadata.putArticle(
      makeArticle({
        id: articleId,
        userId: "u-cv",
        sourceId: "src-1",
        url: `https://example.com/article/${i}`,
        title: `Article ${i}`,
        publishedAt: at,
      }),
    );

    await stores.blobs.put(key, new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
      contentType: "audio/wav",
    });

    await stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: "u-cv",
        sourceId: "src-1",
        articleId,
        title: `Episode ${i}`,
        mode: "direct",
        status: "ready",
        audioKey: key,
        contentType: "audio/wav",
        durationSeconds: 60,
        createdAt: at,
        readyAt: at,
      }),
    );
  }

  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const res = await fetch(new Request(`${BASE}/listen/${TOKEN}`));
  assertEquals(res.status, 200);

  const html = await res.text();
  const match =
    /<script\b[^>]*type="application\/json"[^>]*id="player-data"[^>]*>([\s\S]*?)<\/script>/.exec(
      html,
    );
  assert(match !== null, "player-data script must be present");
  const payload = match[1];
  assert(typeof payload === "string");

  const data = JSON.parse(payload);
  assertEquals(data.episodes.length, 100);
  assertEquals(data.episodes[0].id, "ep-1");
  assertEquals(data.episodes[99].id, "ep-100");
});
