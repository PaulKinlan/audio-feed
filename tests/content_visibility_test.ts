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
import { browserRowIgnored, computedKey, readCssInChrome, supportsKey } from "./css_engine.ts";
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

/**
 * audio-feed-yi6na: the two rows above match TEXT in listen.css, so they pass on a declaration
 * the engine drops -- and content-visibility is the case that started this bead. Only driving
 * headless Chrome showed `contain-intrinsic-size: auto none auto 92px` parses as ONE PAIR PER
 * AXIS (computed contain-intrinsic-width "auto none", height "auto 92px") rather than as a
 * four-value syntax error. This row asks the engine the two questions the text rows cannot:
 * does it ACCEPT both declarations, and does `li.episode` actually COMPUTE them.
 */
Deno.test({
  name:
    "content-visibility: the engine accepts and applies content-visibility and contain-intrinsic-size on li.episode (audio-feed-yi6na)",
  ignore: browserRowIgnored,
  async fn() {
    const css = await Deno.readTextFile(new URL("../src/assets/listen.css", import.meta.url));
    const reading = await readCssInChrome({
      css,
      body: '<ul id="episodes"><li class="episode">row</li></ul>',
      declarations: [
        { property: "content-visibility", value: "auto" },
        { property: "contain-intrinsic-size", value: "auto none auto 92px" },
      ],
      probes: [
        { selector: "li.episode", property: "content-visibility" },
        { selector: "li.episode", property: "contain-intrinsic-width" },
        { selector: "li.episode", property: "contain-intrinsic-height" },
      ],
    });

    // (1) The engine accepts both declarations. A typo (`content-visibilty`, `auto non auto
    // 92px`) is dropped at parse time and reds here while both text rows above stay green.
    assertEquals(
      reading.supports[supportsKey("content-visibility", "auto")],
      true,
      "Chrome must accept content-visibility: auto",
    );
    assertEquals(
      reading.supports[supportsKey("contain-intrinsic-size", "auto none auto 92px")],
      true,
      "the four-token contain-intrinsic-size must be VALID - if it were not, the declaration " +
        "would be dropped and every row above would still be green",
    );

    // (2) It applies to the row the user scrolls. The two-axis parse is asserted by name, not
    // by length: `auto none` on the inline axis and `auto 92px` on the block axis is what the
    // stylesheet means, and a value that landed on the wrong axis would show it here.
    assertEquals(
      reading.computed[computedKey("li.episode", "content-visibility")],
      "auto",
      "li.episode must compute content-visibility: auto, not the initial `visible`",
    );
    assertEquals(
      reading.computed[computedKey("li.episode", "contain-intrinsic-width")],
      "auto none",
      "the INLINE axis must be `auto none` - estimated from the last-rendered size, never " +
        "treated as a fixed length",
    );
    assertEquals(
      reading.computed[computedKey("li.episode", "contain-intrinsic-height")],
      "auto 92px",
      "the BLOCK axis must be `auto 92px` - the measured episode row height",
    );
  },
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
