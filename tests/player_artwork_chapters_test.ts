/**
 * End-to-end tests for:
 *   - Phase A: Tabbed `/account` workspace, status/source/search filters, collapsible errors
 *   - Phase B: Full Podcast Player on `/listen/` (Media Session raster PNG + next/prev +
 *     chapterInfo, Continue Listening, Up Next queue, Sleep Timer, Now Playing sheet, Read Along)
 *   - Phase C: Procedural raster PNG artwork, R2-cached `/feed/:token/art/*`, Podcasting 2.0
 *     JSON Chapters `/feed/:token/chapters/:id.json`, RSS `<itunes:image>` & `<podcast:chapters>`,
 *     and `og:image` / heading extraction.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { extractArticle } from "../src/ingest/url.ts";
import { getAppIconPng, renderCoverPng } from "../src/artwork/png.ts";
import { sniffRasterImage } from "../src/artwork/generate.ts";
import {
  buildChaptersFromSegments,
  extractArticleHeadings,
  splitNarrationIntoChapteredSegments,
} from "../src/synthesis/chapters.ts";
import { assetBody } from "../src/routes/assets.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

const BASE = "https://audiofeed.app";

function bootApp() {
  const stores = memoryStores();
  const ctx = {
    config: { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret-token-long" },
    stores,
  };
  const handlers = createHandlers(ctx);
  const { fetch } = createApp(ctx, handlers);
  return { fetch, stores, ctx };
}

Deno.test("Phase C: renderCoverPng and getAppIconPng generate valid 512x512 PNG images", async () => {
  const icon = await getAppIconPng();
  assertEquals(sniffRasterImage(icon)?.contentType, "image/png");
  const view = new DataView(icon.buffer, icon.byteOffset, icon.byteLength);
  assertEquals(view.getUint32(16, false), 512, "PNG width must be 512");
  assertEquals(view.getUint32(20, false), 512, "PNG height must be 512");

  const cover = await renderCoverPng({
    seed: "source:stratechery",
    title: "Stratechery",
    mode: "deepdive",
    size: 256,
  });
  assertEquals(sniffRasterImage(cover)?.contentType, "image/png");
  const coverView = new DataView(cover.buffer, cover.byteOffset, cover.byteLength);
  assertEquals(coverView.getUint32(16, false), 256);
  assertEquals(coverView.getUint32(20, false), 256);
});

Deno.test("Phase C: extractArticle extracts og:image and section headings", () => {
  const html = `<!doctype html><html><head>
    <title>Building Reliable Systems</title>
    <meta property="og:image" content="/images/cover.png">
  </head><body><article>
    <h1>Building Reliable Systems</h1>
    <p>This opening paragraph explains the background and why reliability matters for modern distributed services and audio pipelines.</p>
    <h2>Queue Architecture</h2>
    <p>Queues decouple producers from consumers so each feed polls inside an isolated worker with automatic retries and dead letter queues.</p>
    <h2>Streaming Uploads</h2>
    <p>Multipart uploads stream small fixed-size buffers straight to object storage so memory usage stays bounded regardless of duration.</p>
  </article></body></html>`;

  const extracted = extractArticle(html, "https://example.com/posts/reliable");
  assertEquals(extracted.imageUrl, "https://example.com/images/cover.png");
  assertEquals(extracted.headings, ["Queue Architecture", "Streaming Uploads"]);
});

Deno.test("Phase C: chapter splitting aligns timestamps to heading segments and auto-parts long unheaded audio", () => {
  const prompt = [
    "Intro paragraph about the article.",
    "Queue Architecture",
    "Details on queue architecture and isolation.",
    "Streaming Uploads",
    "Details on streaming multipart uploads.",
  ].join("\n\n");

  const segs = splitNarrationIntoChapteredSegments(
    prompt,
    extractArticleHeadings(prompt, ["Queue Architecture", "Streaming Uploads"]),
    2000,
  );
  assertEquals(segs.length, 3);
  assertEquals(segs[0]!.heading, undefined);
  assertEquals(segs[1]!.heading, "Queue Architecture");
  assertEquals(segs[2]!.heading, "Streaming Uploads");

  const chapters = buildChaptersFromSegments([
    { heading: segs[0]!.heading, durationSeconds: 42 },
    { heading: segs[1]!.heading, durationSeconds: 65 },
    { heading: segs[2]!.heading, durationSeconds: 58 },
  ]);
  assertEquals(chapters, [
    { startTime: 0, title: "Introduction" },
    { startTime: 42, title: "Queue Architecture" },
    { startTime: 107, title: "Streaming Uploads" },
  ]);

  // Long unheaded audio (> 4 min) gets automatic Part chapters
  const autoChapters = buildChaptersFromSegments([
    { durationSeconds: 100 },
    { durationSeconds: 100 },
    { durationSeconds: 100 },
    { durationSeconds: 100 },
    { durationSeconds: 100 },
  ]);
  assert(autoChapters.length >= 2, "long unheaded audio should get auto part markers");
  assertEquals(autoChapters[0], { startTime: 0, title: "Introduction" });
});

Deno.test("Phase C: /icon.png, /feed/:token/art/*, /feed/:token/chapters/*, /listen/:token/episodes/:id/article, and RSS tags work end-to-end", async () => {
  const { fetch, stores } = bootApp();
  const user = makeUser({ id: "u-art", status: "approved", feedToken: "tok-art-123" });
  const pendingUser = makeUser({ id: "u-pend", status: "pending", feedToken: "tok-pend-456" });
  await stores.metadata.putUser(user);
  await stores.metadata.putUser(pendingUser);
  await stores.metadata.putSource(
    makeSource({ id: "blog1", userId: user.id, title: "Tech Dispatch", modes: ["direct"] }),
  );
  await stores.metadata.putArticle(
    makeArticle({
      id: "art-1",
      userId: user.id,
      sourceId: "blog1",
      url: "https://example.com/dispatch-1",
      title: "Cloudflare Architecture",
      author: "Jane Doe",
      content: "Paragraph one of the article.\n\nParagraph two with deeper insights.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-1",
      userId: user.id,
      sourceId: "blog1",
      sourceTitle: "Tech Dispatch",
      articleId: "art-1",
      mode: "direct",
      status: "ready",
      title: "Cloudflare Architecture",
      audioKey: `audio/${user.id}/direct/ep-1.wav`,
      byteLength: 4096,
      durationSeconds: 185,
      chapters: [
        { startTime: 0, title: "Introduction" },
        { startTime: 70, title: "Workflows" },
      ],
    }),
  );

  // 1. /icon.png
  const iconRes = await fetch(new Request(`${BASE}/icon.png`));
  assertEquals(iconRes.status, 200);
  assertEquals(iconRes.headers.get("content-type"), "image/png");
  const iconBytes = new Uint8Array(await iconRes.arrayBuffer());
  assertEquals(sniffRasterImage(iconBytes)?.ext, "png");

  // 2. /manifest.json includes raster PNG icon
  const manifestRes = await fetch(new Request(`${BASE}/manifest.json`));
  assertEquals(manifestRes.status, 200);
  const manifest = await manifestRes.json();
  assert(
    manifest.icons.some((i: { src: string; type: string }) =>
      i.src === "/icon.png" && i.type === "image/png"
    ),
    "manifest.json must include raster /icon.png",
  );

  // 3. Token-gated artwork routes (master, source, episode) + unapproved refusal
  for (const target of ["master.png", "source-blog1.png", "episode-ep-1.png"]) {
    const res = await fetch(new Request(`${BASE}/feed/${user.feedToken}/art/${target}`));
    assertEquals(res.status, 200, target);
    assertEquals(res.headers.get("content-type"), "image/png", target);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals(sniffRasterImage(bytes)?.ext, "png", target);
  }
  assertEquals(
    (await fetch(new Request(`${BASE}/feed/${pendingUser.feedToken}/art/master.png`))).status,
    404,
  );
  assertEquals(
    (await fetch(new Request(`${BASE}/feed/bad-token/art/master.png`))).status,
    404,
  );

  // 4. Podcasting 2.0 JSON Chapters route
  const chapRes = await fetch(new Request(`${BASE}/feed/${user.feedToken}/chapters/ep-1.json`));
  assertEquals(chapRes.status, 200);
  assertStringIncludes(chapRes.headers.get("content-type") ?? "", "application/json+chapters");
  const chapJson = await chapRes.json();
  assertEquals(chapJson, {
    version: "1.2.0",
    chapters: [
      { startTime: 0, title: "Introduction" },
      { startTime: 70, title: "Workflows" },
    ],
  });

  // 5. In-app Read Along route
  const readRes = await fetch(
    new Request(`${BASE}/listen/${user.feedToken}/episodes/ep-1/article`),
  );
  assertEquals(readRes.status, 200);
  const readJson = await readRes.json();
  assertEquals(readJson.title, "Cloudflare Architecture");
  assertEquals(readJson.paragraphs, [
    "Paragraph one of the article.",
    "Paragraph two with deeper insights.",
  ]);
  assertEquals(readJson.chapters.length, 2);

  // 6. Master RSS and Per-Source RSS emit channel + item <itunes:image> and <podcast:chapters>
  const masterRss = await (await fetch(new Request(`${BASE}/feed/${user.feedToken}/master.xml`)))
    .text();
  assertStringIncludes(masterRss, `<itunes:image href="${BASE}/feed/${user.feedToken}/art/master.png"/>`);
  assertStringIncludes(masterRss, `<itunes:image href="${BASE}/feed/${user.feedToken}/art/episode-ep-1.png"/>`);
  assertStringIncludes(
    masterRss,
    `<podcast:chapters url="${BASE}/feed/${user.feedToken}/chapters/ep-1.json" type="application/json+chapters"/>`,
  );

  const sourceRss = await (
    await fetch(new Request(`${BASE}/feed/${user.feedToken}/blog1/direct.xml`))
  ).text();
  assertStringIncludes(
    sourceRss,
    `<itunes:image href="${BASE}/feed/${user.feedToken}/art/source-blog1.png"/>`,
  );
  assertStringIncludes(
    sourceRss,
    `<podcast:chapters url="${BASE}/feed/${user.feedToken}/chapters/ep-1.json" type="application/json+chapters"/>`,
  );
});

Deno.test("Phase A & B: /account renders 4-tab workspace and /listen renders full podcast player with artwork, chapters, queue, sleep timer, and Media Session", async () => {
  const { fetch, stores } = bootApp();
  const user = makeUser({ id: "u-ui", status: "approved", feedToken: "tok-ui-789" });
  await stores.metadata.putUser(user);
  await stores.metadata.putSource(makeSource({ id: "s1", userId: user.id, title: "Source One" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "a1", userId: user.id, sourceId: "s1", title: "Ep One", content: "Body." }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "e1",
      userId: user.id,
      sourceId: "s1",
      sourceTitle: "Source One",
      articleId: "a1",
      status: "ready",
      audioKey: `audio/${user.id}/direct/e1.wav`,
      byteLength: 2048,
      durationSeconds: 300,
      chapters: [
        { startTime: 0, title: "Intro" },
        { startTime: 120, title: "Deep Analysis" },
      ],
    }),
  );

  // /account tabbed workspace
  const session = await createSession(stores.metadata, user.id);
  const accRes = await fetch(
    new Request(`${BASE}/account`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }),
  );
  assertEquals(accRes.status, 200);
  const accHtml = await accRes.text();
  assertStringIncludes(accHtml, 'role="tablist"');
  assertStringIncludes(accHtml, 'id="tab-episodes"');
  assertStringIncludes(accHtml, 'id="tab-add"');
  assertStringIncludes(accHtml, 'id="tab-feeds"');
  assertStringIncludes(accHtml, 'id="tab-settings"');
  assertStringIncludes(accHtml, 'data-filter-status="failed"');
  assertStringIncludes(accHtml, 'id="epFilterSource"');
  assertStringIncludes(accHtml, 'id="epFilterQuery"');

  // /listen/:token full podcast player
  const listenRes = await fetch(new Request(`${BASE}/listen/${user.feedToken}`));
  assertEquals(listenRes.status, 200);
  const listenHtml = await listenRes.text();
  assertStringIncludes(listenHtml, '<link rel="apple-touch-icon" href="/icon.png">');
  assertStringIncludes(listenHtml, 'id="continueSection"');
  assertStringIncludes(listenHtml, 'data-listen-filter="unplayed"');
  assertStringIncludes(listenHtml, 'id="nowPlayingDialog"');
  assertStringIncludes(listenHtml, 'id="sleepBtn"');
  assertStringIncludes(listenHtml, 'id="chapterTicks"');
  assertStringIncludes(listenHtml, 'id="npChaptersList"');
  assertStringIncludes(listenHtml, 'id="npQueueList"');
  assertStringIncludes(listenHtml, 'id="npReadBody"');
  assertStringIncludes(listenHtml, `/feed/${user.feedToken}/art/episode-e1.png`);
  assertStringIncludes(listenHtml, "Deep Analysis");

  // listen.js Media Session uses raster PNG artwork, chapterInfo, previoustrack, nexttrack
  const listenJs = assetBody("listen.js") ?? "";
  assertStringIncludes(listenJs, 'type: "image/png"');
  assertStringIncludes(listenJs, "chapterInfo");
  assertStringIncludes(listenJs, "previoustrack");
  assertStringIncludes(listenJs, "nexttrack");
});
