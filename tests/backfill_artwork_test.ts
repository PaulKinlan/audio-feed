/**
 * Tests for `scripts/backfill-artwork.ts` (Issue #55):
 * - CLI argument parsing (dry-run by default, --remote/--local, --apply, --limit, --concurrency, --use-gemini)
 * - `parseWranglerJson` stripping Wrangler spinner, warning, and trailing banner chrome
 * - Optimistic D1 CAS SQL generation (`--command` vs `> 32 KiB` `--file` fallback) and real SQLite D1 execution
 * - Exact `episodeArtworkKey` / `ensureEpisodeArtwork` conventions & end-to-end `src/routes/artwork.ts` serving
 * - SSRF-safe `og:image` scraping (private IP, redirect-to-private-IP, non-HTML, timeout fallback -> procedural PNG)
 * - Optional `--use-gemini` opt-in & fallback behavior
 * - Bounded concurrency, idempotency, CAS conflict handling, per-episode failure isolation, and zero deletions
 */

import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { artworkBlobKey, sniffRasterImage } from "../src/artwork/generate.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import { MemoryBlobStore } from "../src/storage/memory.ts";
import { collect } from "../src/storage/mod.ts";
import {
  type ArtworkEpisodeCandidate,
  backfillArtworkCandidates,
  buildArtworkUpdateSql,
  buildD1ExecuteArgs,
  buildMissingArtworkQuerySql,
  buildR2PutArgs,
  createCapturingBlobStore,
  createSafePublicFetch,
  DEFAULT_BACKFILL_CONCURRENCY,
  discoverArticleOgImage,
  episodeArtworkKey,
  extractOgImageFromHtml,
  MAX_BACKFILL_CONCURRENCY,
  parseArtworkCandidateRow,
  parseBackfillArtworkArgs,
  parseWranglerJson,
  type RawArtworkCandidateRow,
  resolveCandidateArtwork,
  SQL_COMMAND_INLINE_LIMIT_BYTES,
  summarizeArtworkCandidates,
} from "../scripts/backfill-artwork.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { createTestD1 } from "./sqlite_d1.ts";

/** Minimal valid JPEG bytes (passes `sniffRasterImage`: FF D8 FF + >= 12 bytes). */
function fakeJpegBytes(seed = 0x11): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, seed, 0x00, 0xff, 0xd9,
  ]);
}

/** Minimal valid WebP bytes (passes `sniffRasterImage`: RIFF....WEBP + >= 12 bytes). */
function fakeWebpBytes(seed = 0x22): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, seed,
  ]);
}

/** Minimal valid PNG bytes (passes `sniffRasterImage`: 89 50 4E 47 0D 0A 1A 0A + >= 12 bytes). */
function fakePngBytes(seed = 0x33): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, seed,
  ]);
}

Deno.test("backfill-artwork CLI: defaults to safe local dry-run and parses all flags cleanly", () => {
  const defaults = parseBackfillArtworkArgs([]);
  assertEquals(defaults, {
    dbName: "audio-feed",
    bucketName: "audio-feed",
    target: "local",
    apply: false,
    limit: undefined,
    concurrency: DEFAULT_BACKFILL_CONCURRENCY,
    useGemini: false,
    scrapeOg: true,
  });

  const remoteDryRun = parseBackfillArtworkArgs(["--remote"]);
  assertEquals(remoteDryRun.target, "remote");
  assertEquals(remoteDryRun.apply, false);

  const custom = parseBackfillArtworkArgs([
    "--remote",
    "--apply",
    "--limit",
    "15",
    "--concurrency",
    "6",
    "--use-gemini",
    "--no-scrape-og",
    "--db",
    "custom-db",
    "--bucket",
    "custom-bucket",
  ]);
  assertEquals(custom, {
    dbName: "custom-db",
    bucketName: "custom-bucket",
    target: "remote",
    apply: true,
    limit: 15,
    concurrency: 6,
    useGemini: true,
    scrapeOg: false,
  });

  // Inline `=` forms, clamping, invalid values ignored, --dry-run overrides earlier --apply
  const inline = parseBackfillArtworkArgs([
    "--apply",
    "--dry-run",
    "--limit=25",
    "--concurrency=999",
    "--db=db2",
    "--bucket=b2",
  ]);
  assertEquals(inline.apply, false);
  assertEquals(inline.limit, 25);
  assertEquals(inline.concurrency, MAX_BACKFILL_CONCURRENCY);
  assertEquals(inline.dbName, "db2");
  assertEquals(inline.bucketName, "b2");

  const invalidNumbers = parseBackfillArtworkArgs(["--limit", "0", "--concurrency", "-4"]);
  assertEquals(invalidNumbers.limit, undefined);
  assertEquals(invalidNumbers.concurrency, DEFAULT_BACKFILL_CONCURRENCY);
});

Deno.test("backfill-artwork: parseWranglerJson strips spinner, bracketed warnings, and trailing banner chrome", () => {
  assertEquals(parseWranglerJson<Array<{ ok: boolean }>>('[{"ok":true}]'), [{ ok: true }]);

  const withSpinner = [
    " ⛅️ wrangler 4.169.0",
    "────────────────────",
    "🌀 Executing on remote database audio-feed (dec55b22):",
    "🌀 To execute on your local development database, remove the --remote flag.",
    "🚣 Executed 1 command in 0.42ms",
    "[",
    '  { "results": [{ "id": "ep-1" }], "meta": { "changes": 1 } }',
    "]",
  ].join("\n");
  const parsedSpinner = parseWranglerJson<Array<{ results: Array<{ id: string }> }>>(withSpinner);
  assertEquals(parsedSpinner[0]?.results[0]?.id, "ep-1");

  // Banner lines containing `[update available]` / `[WARN]` must NOT prematurely break parsing.
  const withBracketNoise = [
    "⛅️ wrangler 4.169.0 [update available]",
    "[WARN] Telemetry notice",
    '[{"meta":{"changes":1}}]',
    "⛅️ Run npm i wrangler@latest to update.",
  ].join("\n");
  const parsedNoise = parseWranglerJson<Array<{ meta: { changes: number } }>>(withBracketNoise);
  assertEquals(parsedNoise[0]?.meta.changes, 1);

  // Single-line carriage-return spinner prefix without newline before `[`.
  const singleLine = '\r⠋ Executing... [{"meta":{"changes":1}}]';
  assertEquals(
    parseWranglerJson<Array<{ meta: { changes: number } }>>(singleLine)[0]?.meta.changes,
    1,
  );

  assertThrows(() => parseWranglerJson("🌀 Executing... failed without JSON"), SyntaxError);
});

Deno.test("backfill-artwork: buildArtworkUpdateSql builds CAS SQL, escapes quotes, switches to --file > 32 KiB, and rejects unsafe keys", () => {
  const ep = makeEpisode({
    id: "ep-quote",
    userId: "u-1",
    title: "O'Reilly's Guide to Cloudflare D1 & R2",
    description: "It's fast and safe.",
    status: "ready",
  });
  const key = episodeArtworkKey("u-1", "ep-quote", "png");
  assertEquals(key, artworkBlobKey("u-1", "episode", "ep-quote", "png"));
  assertEquals(key, "art/u-1/episode/ep-quote.png");

  const cas = buildArtworkUpdateSql(
    { userId: "u-1", id: "ep-quote", version: 3, episode: ep },
    key,
  );
  assertEquals(cas.nextVersion, 4);
  assertEquals(cas.useFile, false);
  assertEquals(cas.updatedEpisode.artworkKey, key);
  assertStringIncludes(cas.sql, "UPDATE episodes SET version = 4, data = '");
  assertStringIncludes(cas.sql, "O''Reilly''s Guide");
  assertStringIncludes(cas.sql, "WHERE user_id = 'u-1' AND id = 'ep-quote' AND version = 3;");

  // CLI args use `--command` when <= 32 KiB and `--file` when > 32 KiB.
  const cmdArgs = buildD1ExecuteArgs({
    dbName: "audio-feed",
    target: "remote",
    sql: cas.sql,
    useFile: cas.useFile,
  });
  assert(cmdArgs.includes("--command"));
  assert(!cmdArgs.includes("--file"));

  const hugeEpisode = makeEpisode({
    id: "ep-huge",
    userId: "u-1",
    transcript: "A".repeat(SQL_COMMAND_INLINE_LIMIT_BYTES + 4096),
    status: "ready",
  });
  const hugeCas = buildArtworkUpdateSql(
    { userId: "u-1", id: "ep-huge", version: 1, episode: hugeEpisode },
    episodeArtworkKey("u-1", "ep-huge", "jpg"),
  );
  assertEquals(hugeCas.useFile, true);
  const fileArgs = buildD1ExecuteArgs({
    dbName: "audio-feed",
    target: "remote",
    sql: hugeCas.sql,
    sqlFilePath: "/tmp/ep-huge.sql",
    useFile: hugeCas.useFile,
  });
  assert(fileArgs.includes("--file"));
  assert(fileArgs.includes("/tmp/ep-huge.sql"));
  assert(!fileArgs.includes("--command"));

  // R2 put args match exact Wrangler CLI shape.
  const r2Args = buildR2PutArgs({
    bucketName: "audio-feed",
    artworkKey: key,
    filePath: "/tmp/ep-quote.png",
    contentType: "image/png",
    target: "remote",
  });
  assertEquals(r2Args, [
    "r2",
    "object",
    "put",
    "audio-feed/art/u-1/episode/ep-quote.png",
    "--file",
    "/tmp/ep-quote.png",
    "--content-type",
    "image/png",
    "--remote",
  ]);

  // Safety guards reject path traversal keys and invalid versions.
  assertThrows(() =>
    buildArtworkUpdateSql(
      { userId: "u-1", id: "ep-1", version: 1, episode: ep },
      "art/../secret.png",
    )
  );
  assertThrows(() =>
    buildArtworkUpdateSql(
      { userId: "u-1", id: "ep-1", version: -1, episode: ep },
      key,
    )
  );
});

Deno.test("backfill-artwork: D1 query + CAS SQL execute accurately against real SQLite D1 schema and are idempotent", async () => {
  const d1 = createTestD1();
  const store = new D1MetadataStore(d1);
  try {
    const user = makeUser({ id: "u-d1", status: "approved", feedToken: "tok-d1" });
    await store.putUser(user);
    await store.putSource(
      makeSource({
        id: "src-1",
        userId: user.id,
        title: "Engineering Notes",
        siteUrl: "https://eng.example.com",
        feedUrl: "https://eng.example.com/rss.xml",
        imageUrl: "https://eng.example.com/logo.png",
      }),
    );
    await store.putArticle(
      makeArticle({
        id: "art-1",
        userId: user.id,
        sourceId: "src-1",
        url: "https://eng.example.com/post-1",
        title: "Post One",
        imageUrl: "https://eng.example.com/hero-1.jpg",
        content: "Body text that should not be pulled by the lightweight backfill SELECT.",
      }),
    );
    await store.putArticle(
      makeArticle({
        id: "art-2",
        userId: user.id,
        sourceId: "inbox",
        url: "https://blog.example.org/pre-phase-c",
        title: "Pre-Phase-C Post",
        content: "Older article with no imageUrl yet.",
      }),
    );

    // 1. Ready episode without artworkKey (joined with article + source)
    await store.putEpisode(
      makeEpisode({
        id: "ep-needs-1",
        userId: user.id,
        sourceId: "src-1",
        sourceTitle: "Engineering Notes",
        articleId: "art-1",
        status: "ready",
        title: "O'Reilly's Post One",
        createdAt: "2026-11-20T10:00:00.000Z",
        audioKey: "audio/u-d1/direct/ep-needs-1.mp3",
        contentType: "audio/mpeg",
      }),
    );
    // 2. Ready episode without artworkKey in synthetic `inbox` source (no sources row!)
    await store.putEpisode(
      makeEpisode({
        id: "ep-needs-2",
        userId: user.id,
        sourceId: "inbox",
        sourceTitle: "Send to Audio",
        articleId: "art-2",
        status: "ready",
        title: "Pre-Phase-C Post",
        createdAt: "2026-11-21T10:00:00.000Z",
        audioKey: "audio/u-d1/direct/ep-needs-2.mp3",
        contentType: "audio/mpeg",
      }),
    );
    // 3. Ready episode ALREADY having artworkKey -> must NOT be selected
    await store.putEpisode(
      makeEpisode({
        id: "ep-has-art",
        userId: user.id,
        sourceId: "src-1",
        articleId: "art-1",
        status: "ready",
        artworkKey: "art/u-d1/episode/ep-has-art.png",
        createdAt: "2026-11-22T10:00:00.000Z",
        audioKey: "audio/u-d1/direct/ep-has-art.mp3",
        contentType: "audio/mpeg",
      }),
    );
    // 4. Pending episode without artworkKey -> must NOT be selected
    await store.putEpisode(
      makeEpisode({
        id: "ep-pending",
        userId: user.id,
        sourceId: "src-1",
        articleId: "art-1",
        status: "pending",
        createdAt: "2026-11-23T10:00:00.000Z",
      }),
    );

    const selectSql = buildMissingArtworkQuerySql();
    const res = await d1.prepare(selectSql).all<RawArtworkCandidateRow>();
    const candidates = res.results.map(parseArtworkCandidateRow);

    assertEquals(candidates.map((c) => c.id), ["ep-needs-2", "ep-needs-1"]);
    const c1 = candidates.find((c) => c.id === "ep-needs-1")!;
    const c2 = candidates.find((c) => c.id === "ep-needs-2")!;
    assertEquals(c1.article?.imageUrl, "https://eng.example.com/hero-1.jpg");
    assertEquals(c1.source?.title, "Engineering Notes");
    assertEquals(c1.source?.siteUrl, "https://eng.example.com");
    assertEquals(c1.source?.feedUrl, "https://eng.example.com/rss.xml");
    assertEquals(c2.article?.url, "https://blog.example.org/pre-phase-c");
    assertEquals(c2.article?.imageUrl, undefined);
    assertEquals(c2.source, null);

    const summary = summarizeArtworkCandidates(candidates);
    assertEquals(summary, {
      count: 2,
      withArticleImageUrl: 1,
      eligibleForOgScrape: 1,
      withSourceImageUrl: 0,
      proceduralFallbackOnly: 0,
    });

    // Apply CAS update for c1 directly in real SQLite D1
    const key1 = episodeArtworkKey(c1.userId, c1.id, "jpg");
    const cas1 = buildArtworkUpdateSql(c1, key1);
    const update1 = await d1.prepare(cas1.sql).run();
    assertEquals(update1.meta.changes, 1);

    // Re-running stale CAS SQL must affect 0 rows (optimistic lock holds!)
    const staleUpdate = await d1.prepare(cas1.sql).run();
    assertEquals(staleUpdate.meta.changes, 0);

    // Stored episode preserves all fields + apostrophes and now carries `artworkKey`.
    const reloaded = await store.getEpisode(user.id, c1.id);
    assert(reloaded !== null);
    assertEquals(reloaded.artworkKey, key1);
    assertEquals(reloaded.title, "O'Reilly's Post One");
    assertEquals(reloaded.audioKey, "audio/u-d1/direct/ep-needs-1.mp3");

    // Re-running SELECT now returns ONLY the remaining episode (`ep-needs-2`)!
    const afterRes = await d1.prepare(selectSql).all<RawArtworkCandidateRow>();
    assertEquals(afterRes.results.map((r) => r.id), ["ep-needs-2"]);

    // LIMIT clause works cleanly
    const limitedRes = await d1.prepare(buildMissingArtworkQuerySql(1)).all<RawArtworkCandidateRow>();
    assertEquals(limitedRes.results.length, 1);
  } finally {
    d1.close();
  }
});

Deno.test("backfill-artwork: SSRF-safe og:image extraction rejects private/metadata URLs, unsafe redirects, and non-HTML", async () => {
  // Pure HTML extraction resolves relative URLs and skips private/unsafe meta tags.
  const htmlMixed = `<!doctype html><html><head>
    <meta property="og:image" content="http://127.0.0.1/secret.png">
    <meta name="twitter:image" content="/assets/hero.webp">
  </head><body></body></html>`;
  assertEquals(
    extractOgImageFromHtml(htmlMixed, "https://news.example.com/posts/2026"),
    "https://news.example.com/assets/hero.webp",
  );

  // Rejects javascript:, data:, metadata IP, non-standard ports, and .internal hosts.
  const htmlAllUnsafe = `<!doctype html><html><head>
    <meta property="og:image" content="javascript:alert(1)">
    <meta property="og:image:secure_url" content="http://169.254.169.254/latest/meta-data/">
    <meta name="twitter:image" content="https://example.com:8443/img.png">
    <meta property="twitter:image" content="https://secret.internal/img.png">
  </head></html>`;
  assertEquals(extractOgImageFromHtml(htmlAllUnsafe, "https://news.example.com/post"), null);

  // Private / loopback / metadata / upload:// article URLs must NEVER invoke transport.
  let transportCalls = 0;
  const countingFetch: typeof fetch = async () => {
    transportCalls++;
    return new Response("<html></html>", { headers: { "content-type": "text/html" } });
  };
  for (const blocked of [
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/internal",
    "http://localhost/post",
    "http://svc.internal/post",
    "upload://local-doc.pdf",
  ]) {
    const found = await discoverArticleOgImage(blocked, { fetchFn: countingFetch });
    assertEquals(found, null, `must reject ${blocked}`);
  }
  assertEquals(transportCalls, 0, "SSRF guard must reject before any outbound request");

  // Redirect from public URL -> private metadata IP must be blocked before following hop 2!
  const visited: string[] = [];
  const redirectFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    visited.push(url);
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
  };
  assertEquals(
    await discoverArticleOgImage("https://public.example.com/redir", { fetchFn: redirectFetch }),
    null,
  );
  assertEquals(visited, ["https://public.example.com/redir"]);

  // Non-HTML content-type (PDF) is ignored cleanly.
  const pdfFetch: typeof fetch = async () =>
    new Response("%PDF-1.7...", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  assertEquals(
    await discoverArticleOgImage("https://public.example.com/paper.pdf", { fetchFn: pdfFetch }),
    null,
  );

  // Timeout / network failure is swallowed cleanly (returns null, never throws).
  const failingFetch: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  assertEquals(
    await discoverArticleOgImage("https://public.example.com/down", { fetchFn: failingFetch }),
    null,
  );

  // Public redirect updates base URL for relative `og:image`, and gzip transport decompresses cleanly.
  const gzippedHtml = await new Response(
    new Blob([
      '<!doctype html><html><head><meta property="og:image" content="../hero.jpg"></head><body>body</body></html>',
    ]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  const discoveredAfterRedirect = await discoverArticleOgImage("https://news.example.com/short", {
    transport: async (url) => {
      if (url.href === "https://news.example.com/short") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://articles.example.com/2026/11/story.html" },
        });
      }
      return new Response(gzippedHtml, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
        },
      });
    },
  });
  assertEquals(discoveredAfterRedirect, "https://articles.example.com/2026/hero.jpg");

  // `createSafePublicFetch` follows public redirects and refuses redirects to private IPs.
  const jpeg = fakeJpegBytes(0x88);
  const safeFetch = createSafePublicFetch(async (url) => {
    if (url.href === "https://cdn.example.com/start.jpg") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://images.example.com/final.jpg" },
      });
    }
    if (url.href === "https://images.example.com/final.jpg") {
      return new Response(jpeg, {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": String(jpeg.byteLength) },
      });
    }
    if (url.href === "https://cdn.example.com/ssrf") {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal.jpg" },
      });
    }
    return new Response(null, { status: 404 });
  });
  const okImg = await safeFetch("https://cdn.example.com/start.jpg");
  assertEquals(okImg.status, 200);
  assertEquals(new Uint8Array(await okImg.arrayBuffer()), jpeg);
  await assertRejects(() => safeFetch("https://cdn.example.com/ssrf"));
});

Deno.test("backfill-artwork: resolveCandidateArtwork integrates ensureEpisodeArtwork across og:image, Gemini opt-in, procedural PNG, and idempotency", async () => {
  const jpeg = fakeJpegBytes(0x44);
  const webp = fakeWebpBytes(0x55);
  const png = fakePngBytes(0x66);

  // 1. Pre-Phase-C article (no article.imageUrl) -> scrapes og:image -> fetches WebP -> stores .webp key
  const blobs1 = new MemoryBlobStore();
  const calls1: string[] = [];
  const fetch1: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls1.push(url);
    if (url === "https://blog.example.com/old-article") {
      return new Response(
        `<!doctype html><html><head><meta property="og:image" content="/img/lead.webp"></head><body>Hi</body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (url === "https://blog.example.com/img/lead.webp") {
      return new Response(webp, { status: 200, headers: { "content-type": "image/webp" } });
    }
    return new Response("Not Found", { status: 404 });
  };

  const candOg: ArtworkEpisodeCandidate = {
    userId: "u-art",
    id: "ep-og",
    version: 1,
    episode: makeEpisode({ id: "ep-og", userId: "u-art", sourceId: "s1", status: "ready" }),
    article: { url: "https://blog.example.com/old-article", title: "Old Article" },
    source: { title: "Example Blog" },
  };

  const resOg = await resolveCandidateArtwork(candOg, {
    blobs: blobs1,
    scrapeOg: true,
    useGemini: false,
    fetchFn: fetch1,
  });
  assertEquals(resOg.status, "generated");
  assertEquals(resOg.artworkKey, "art/u-art/episode/ep-og.webp");
  assertEquals(resOg.contentType, "image/webp");
  assertEquals(resOg.scrapedOgImageUrl, "https://blog.example.com/img/lead.webp");
  assertEquals(resOg.bytes, webp);
  assertEquals(calls1, [
    "https://blog.example.com/old-article",
    "https://blog.example.com/img/lead.webp",
  ]);
  const stored1 = await blobs1.get(resOg.artworkKey);
  assert(stored1 !== null);
  assertEquals(await collect(stored1.body), webp);

  // Idempotency: re-running on an episode whose artworkKey is already set + in blobs skips!
  const callsBeforeSkip = calls1.length;
  const skipped = await resolveCandidateArtwork(
    { ...candOg, episode: { ...candOg.episode, artworkKey: resOg.artworkKey } },
    { blobs: blobs1, fetchFn: fetch1 },
  );
  assertEquals(skipped, {
    status: "skipped",
    artworkKey: "art/u-art/episode/ep-og.webp",
    reason: "already-has-artwork",
  });
  assertEquals(calls1.length, callsBeforeSkip);

  // 2. Fallback to procedural studio PNG when og:image fails AND --use-gemini is OFF (even if key set!)
  let geminiHit = 0;
  const fetchFail: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiHit++;
    }
    return new Response("error", { status: 503 });
  };
  const candProcedural: ArtworkEpisodeCandidate = {
    userId: "u-art",
    id: "ep-proc",
    version: 2,
    episode: makeEpisode({
      id: "ep-proc",
      userId: "u-art",
      sourceId: "s1",
      sourceTitle: "Weekly Dispatch",
      title: "Systems Design",
      mode: "deepdive",
      status: "ready",
    }),
    article: { url: "https://offline.example.com/post", title: "Systems Design" },
    source: { title: "Weekly Dispatch" },
  };
  const resProc = await resolveCandidateArtwork(candProcedural, {
    scrapeOg: true,
    useGemini: false,
    geminiApiKey: "fake-key-must-not-be-used",
    fetchFn: fetchFail,
  });
  assertEquals(geminiHit, 0, "Gemini must NOT be called unless --use-gemini is enabled");
  assertEquals(resProc.status, "generated");
  assertEquals(resProc.artworkKey, "art/u-art/episode/ep-proc.png");
  assertEquals(resProc.contentType, "image/png");
  assertEquals(sniffRasterImage(resProc.bytes)?.ext, "png");
  const view = new DataView(resProc.bytes.buffer, resProc.bytes.byteOffset, resProc.bytes.byteLength);
  assertEquals(view.getUint32(16, false), 512);
  assertEquals(view.getUint32(20, false), 512);

  // 3. Opt-in `--use-gemini` + `GEMINI_API_KEY` calls Gemini when no article image is available.
  const b64Png = Buffer.from(png).toString("base64");
  const fetchGemini: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(":generateContent")) {
      geminiHit++;
      assertEquals(init?.method, "POST");
      return Response.json({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: "image/png", data: b64Png } }],
          },
        }],
      });
    }
    return new Response("<html><head></head></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  const resGemini = await resolveCandidateArtwork(candProcedural, {
    scrapeOg: true,
    useGemini: true,
    geminiApiKey: "test-gemini-key",
    fetchFn: fetchGemini,
  });
  assertEquals(geminiHit, 1);
  assertEquals(resGemini.status, "generated");
  assertEquals(resGemini.artworkKey, "art/u-art/episode/ep-proc.png");
  assertEquals(resGemini.bytes, png);

  // 4. Existing `article.imageUrl` takes priority without scraping article HTML.
  const fetchedUrls: string[] = [];
  const fetchDirectImg: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchedUrls.push(url);
    return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  const candDirect: ArtworkEpisodeCandidate = {
    userId: "u-art",
    id: "ep-direct",
    version: 1,
    episode: makeEpisode({ id: "ep-direct", userId: "u-art", status: "ready" }),
    article: {
      url: "https://site.example.com/story",
      imageUrl: "https://cdn.example.com/story.jpg",
    },
    source: null,
  };
  const resDirect = await resolveCandidateArtwork(candDirect, {
    scrapeOg: true,
    useGemini: false,
    fetchFn: fetchDirectImg,
  });
  assertEquals(resDirect.status, "generated");
  assertEquals(resDirect.artworkKey, "art/u-art/episode/ep-direct.jpg");
  assertEquals(resDirect.contentType, "image/jpeg");
  assertEquals(fetchedUrls, ["https://cdn.example.com/story.jpg"]);
});

Deno.test("backfill-artwork: backfilled blobs and D1 records are served cleanly by GET /feed/:token/art/episode-:id.png", async () => {
  const d1 = createTestD1();
  const metadata = new D1MetadataStore(d1);
  const blobs = new MemoryBlobStore();
  try {
    const user = makeUser({ id: "u-serve", status: "approved", feedToken: "tok-serve-99" });
    await metadata.putUser(user);
    await metadata.putEpisode(
      makeEpisode({
        id: "ep-serve-jpg",
        userId: user.id,
        sourceId: "inbox",
        sourceTitle: "Send to Audio",
        articleId: "art-serve",
        status: "ready",
        audioKey: "audio/u-serve/direct/ep-serve-jpg.mp3",
        contentType: "audio/mpeg",
      }),
    );

    const rows = (await d1.prepare(buildMissingArtworkQuerySql()).all<RawArtworkCandidateRow>())
      .results
      .map(parseArtworkCandidateRow);
    assertEquals(rows.length, 1);

    const jpeg = fakeJpegBytes(0x77);
    const candidate: ArtworkEpisodeCandidate = {
      ...rows[0]!,
      article: {
        url: "https://example.com/serve-story",
        imageUrl: "https://cdn.example.com/serve-story.jpg",
      },
    };

    const run = await backfillArtworkCandidates(
      [candidate],
      parseBackfillArtworkArgs(["--local", "--apply"]),
      {
        fetchFn: async () =>
          new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
        uploadArtwork: async ({ artworkKey, bytes, contentType }) => {
          await blobs.put(artworkKey, bytes, { contentType });
        },
        commitEpisodeArtwork: async ({ sql }) => {
          const res = await d1.prepare(sql).run();
          return (res.meta.changes ?? 0) === 1;
        },
        log: () => {},
      },
    );
    assertEquals(run.updated, 1);
    assertEquals(run.failed, 0);

    // Serve through the real app route `src/routes/artwork.ts`!
    const ctx = {
      config: { port: 8000, publicBaseUrl: "https://audiofeed.app", adminToken: "secret" },
      stores: { metadata, blobs, describe: "d1+memory" },
    };
    const { fetch } = createApp(ctx, createHandlers(ctx));
    const artRes = await fetch(
      new Request(`https://audiofeed.app/feed/${user.feedToken}/art/episode-ep-serve-jpg.png`),
    );
    assertEquals(artRes.status, 200);
    assertEquals(artRes.headers.get("content-type"), "image/jpeg");
    assertEquals(new Uint8Array(await artRes.arrayBuffer()), jpeg);
  } finally {
    d1.close();
  }
});

Deno.test("backfill-artwork: orchestration enforces dry-run safety, bounded concurrency, CAS conflicts, error isolation, and zero deletions", async () => {
  // Capturing blob store structurally forbids deletions.
  const capturing = createCapturingBlobStore();
  await assertRejects(() => capturing.blobs.delete("art/u/episode/e.png"), Error, "never delete");

  const candidates: ArtworkEpisodeCandidate[] = Array.from({ length: 5 }, (_, i) => ({
    userId: "u-batch",
    id: `ep-${i + 1}`,
    version: 1,
    episode: makeEpisode({
      id: `ep-${i + 1}`,
      userId: "u-batch",
      sourceId: "inbox",
      title: `Episode ${i + 1}`,
      status: "ready",
      // Make ep-5 already have artworkKey to test idempotent skipping inside orchestration
      ...(i === 4 ? { artworkKey: "art/u-batch/episode/ep-5.png" } : {}),
    }),
    article: null,
    source: null,
  }));

  // 1. Dry-run performs ZERO uploads and ZERO D1 writes.
  let uploads = 0;
  let commits = 0;
  const dryRun = await backfillArtworkCandidates(
    candidates,
    parseBackfillArtworkArgs(["--remote"]),
    {
      uploadArtwork: async () => {
        uploads++;
      },
      commitEpisodeArtwork: async () => {
        commits++;
        return true;
      },
      log: () => {},
    },
  );
  assertEquals(dryRun.dryRun, true);
  assertEquals(uploads, 0);
  assertEquals(commits, 0);

  // 2. Apply mode honors concurrency=2, isolates ep-3 upload error, handles ep-4 CAS conflict, skips ep-5.
  let inFlight = 0;
  let maxInFlight = 0;
  const applyRes = await backfillArtworkCandidates(
    candidates,
    parseBackfillArtworkArgs(["--remote", "--apply", "--concurrency", "2"]),
    {
      uploadArtwork: async ({ candidate }) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        if (candidate.id === "ep-3") {
          throw new Error("simulated R2 transient error");
        }
      },
      commitEpisodeArtwork: async ({ candidate }) => {
        if (candidate.id === "ep-4") return false; // simulated concurrent CAS version mismatch
        return true;
      },
      log: () => {},
      warn: () => {},
      error: () => {},
    },
  );

  assertEquals(applyRes.dryRun, false);
  assert(maxInFlight <= 2, `concurrency cap violated: maxInFlight=${maxInFlight}`);
  assertEquals(applyRes.updated, 2); // ep-1, ep-2
  assertEquals(applyRes.failed, 1); // ep-3
  assertEquals(applyRes.casConflicts, 1); // ep-4
  assertEquals(applyRes.skipped, 1); // ep-5
  assertEquals(applyRes.outcomes.map((o) => `${o.id}:${o.status}`), [
    "ep-1:updated",
    "ep-2:updated",
    "ep-3:failed",
    "ep-4:cas-conflict",
    "ep-5:skipped",
  ]);
});
