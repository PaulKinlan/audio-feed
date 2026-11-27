/**
 * Tests for RSS ETag/304 conditional caching and Podcasting 2.0 WebVTT transcripts
 * (`<podcast:transcript>` + `GET /feed/:token/transcript/:episodeId`).
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { computeEtag, ifNoneMatchMatches } from "../src/feed/etag.ts";
import { toFeedEpisode } from "../src/feed/adapter.ts";
import { buildMasterFeed, buildSourceFeed } from "../src/feed/rss.ts";
import {
  buildTranscriptCues,
  buildTranscriptJsonDocument,
  escapeVttText,
  formatVttTimestamp,
  generateEpisodeWebVtt,
  renderWebVtt,
} from "../src/synthesis/transcript.ts";
import { TRANSCRIPT_RATE_LIMIT } from "../src/routes/transcript.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig } from "../src/config.ts";
import type { UserStatus } from "../src/types.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = {
  port: 8000,
  publicBaseUrl: BASE,
  adminToken: "admin-secret-token",
};

function bootApp() {
  const stores = memoryStores();
  const ctx = { config: CONFIG, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores, ctx };
}

/** Validate basic W3C WebVTT structure: header, HH:MM:SS.mmm timings, monotonicity, no bare `-->`. */
function parseAndValidateVtt(vtt: string): Array<{
  start: string;
  end: string;
  startSec: number;
  endSec: number;
  payload: string;
}> {
  assert(vtt.startsWith("WEBVTT\n"), `WebVTT must start with WEBVTT header, got: ${vtt.slice(0, 32)}`);
  const blocks = vtt.trim().split(/\n\n+/);
  assertEquals(blocks[0], "WEBVTT");

  const tsRe = /^(\d{2,}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/;
  const cues: Array<{
    start: string;
    end: string;
    startSec: number;
    endSec: number;
    payload: string;
  }> = [];

  let prevEnd = 0;
  for (const block of blocks.slice(1)) {
    const lines = block.split("\n");
    assert(lines.length >= 2, `WebVTT cue block must have timing and payload: ${block}`);
    const timing = lines[0]!;
    const match = tsRe.exec(timing);
    assert(match !== null, `Invalid WebVTT timing line: ${timing}`);

    const startMin = Number(match[2]);
    const startSecPart = Number(match[3]);
    const endMin = Number(match[6]);
    const endSecPart = Number(match[7]);
    assert(startMin < 60 && startSecPart < 60, `Invalid start clock field in ${timing}`);
    assert(endMin < 60 && endSecPart < 60, `Invalid end clock field in ${timing}`);

    const startSec = Number(match[1]) * 3600 + startMin * 60 + startSecPart + Number(match[4]) / 1000;
    const endSec = Number(match[5]) * 3600 + endMin * 60 + endSecPart + Number(match[8]) / 1000;
    assert(endSec > startSec, `Cue end must exceed start: ${timing}`);
    assert(startSec >= prevEnd - 0.0001, `Cue start (${startSec}) overlapped previous end (${prevEnd})`);
    prevEnd = endSec;

    const payload = lines.slice(1).join("\n");
    assert(payload.trim().length > 0, "Cue payload must be non-empty");
    assert(!payload.includes("-->"), `Cue payload must not contain raw '-->': ${payload}`);
    cues.push({
      start: timing.split(" --> ")[0]!,
      end: timing.split(" --> ")[1]!,
      startSec,
      endSec,
      payload,
    });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// 1. ETag & If-None-Match RFC 9110 unit tests
// ---------------------------------------------------------------------------

Deno.test("ETag helper supports strong/weak tags, comma-separated lists, and wildcard", async () => {
  const strong = await computeEtag("hello");
  const weak = await computeEtag("hello", { weak: true });
  assert(strong.startsWith('"') && strong.endsWith('"'), `expected strong ETag, got ${strong}`);
  assert(weak.startsWith('W/"') && weak.endsWith('"'), `expected weak ETag, got ${weak}`);
  assertEquals(weak, `W/${strong}`);

  assertEquals(ifNoneMatchMatches(strong, strong), true);
  assertEquals(ifNoneMatchMatches(weak, strong), true);
  assertEquals(ifNoneMatchMatches(strong, weak), true);
  assertEquals(ifNoneMatchMatches(weak, weak), true);
  assertEquals(ifNoneMatchMatches(`"other", ${weak}, "third"`, strong), true);
  assertEquals(ifNoneMatchMatches(`"has,comma", ${strong}`, weak), true);
  assertEquals(ifNoneMatchMatches("*", strong), true);
  assertEquals(ifNoneMatchMatches('"other", W/"different"', strong), false);
  assertEquals(ifNoneMatchMatches("", strong), false);
  assertEquals(ifNoneMatchMatches(null, strong), false);
  // Unquoted or lowercase w/ are not valid RFC 9110 entity-tags.
  assertEquals(ifNoneMatchMatches(strong.slice(1, -1), strong), false);
  assertEquals(ifNoneMatchMatches(`w/${strong}`, strong), false);
});

// ---------------------------------------------------------------------------
// 2. WebVTT formatting & all 3 transcript generation modes
// ---------------------------------------------------------------------------

Deno.test("WebVTT timestamp formatting and text escaping handle boundary cases", () => {
  assertEquals(formatVttTimestamp(0), "00:00:00.000");
  assertEquals(formatVttTimestamp(-12), "00:00:00.000");
  assertEquals(formatVttTimestamp(Number.NaN), "00:00:00.000");
  assertEquals(formatVttTimestamp(59.9999), "00:01:00.000");
  assertEquals(formatVttTimestamp(3661.25), "01:01:01.250");

  const escaped = escapeVttText("A & B --> <script>alert(1)</script>\n\nSecond\u0000line");
  assertEquals(escaped, "A &amp; B --&gt; &lt;script&gt;alert(1)&lt;/script&gt;\nSecondline");
  assert(!escaped.includes("\n\n"));
  assert(!escaped.includes("-->"));
});

Deno.test("Case A (deepdive): WebVTT preserves speaker voice tags and allocates time proportionally", () => {
  const transcript = [
    "Alex: Welcome back to the show.",
    "Sam: Thanks Alex! Today we are unpacking how Cloudflare Workflows checkpoint every single synthesis step durably across retries without repeating any paid API calls.",
    "Alex: Right, and you can read more at https://developers.cloudflare.com/workflows/ for the full architecture.",
  ].join("\n\n");

  const vtt = generateEpisodeWebVtt({
    mode: "deepdive",
    durationSeconds: 60,
    transcript,
  });

  const cues = parseAndValidateVtt(vtt);
  assertEquals(cues.length, 3);
  assertEquals(cues[0]!.start, "00:00:00.000");
  assertEquals(cues[cues.length - 1]!.end, "00:01:00.000");
  assertStringIncludes(cues[0]!.payload, "<v Alex>Welcome back to the show.</v>");
  assertStringIncludes(cues[1]!.payload, "<v Sam>");
  assertStringIncludes(cues[2]!.payload, "<v Alex>");
  assertStringIncludes(cues[2]!.payload, "https://developers.cloudflare.com/workflows/");

  // Middle turn has ~5x the UTF-8 length of turn 1, so its allocated duration must be much longer.
  const dur0 = cues[0]!.endSec - cues[0]!.startSec;
  const dur1 = cues[1]!.endSec - cues[1]!.startSec;
  assert(dur1 > dur0 * 3, `expected proportional timing, got dur0=${dur0} dur1=${dur1}`);

  // Lightweight JSON cue helper matches and carries speaker metadata.
  const jsonDoc = buildTranscriptJsonDocument({
    mode: "deepdive",
    durationSeconds: 60,
    transcript,
  });
  assertEquals(jsonDoc.version, "1.0");
  assertEquals(jsonDoc.durationSeconds, 60);
  assertEquals(jsonDoc.cues.length, 3);
  assertEquals(jsonDoc.cues[0]!.speaker, "Alex");
  assertEquals(jsonDoc.cues[1]!.speaker, "Sam");

  // Long speaker turn (>18s and >240 chars) splits cleanly into multiple <v Speaker> cues.
  const longTurn = Array.from(
    { length: 6 },
    (_, i) =>
      `Point ${i + 1} explores durable workflow checkpointing, deterministic step replay, and automatic retries under transient network failures.`,
  ).join(" ");
  const longVtt = generateEpisodeWebVtt({
    mode: "deepdive",
    durationSeconds: 90,
    scriptTurns: [
      { speaker: "Élodie", text: longTurn },
      { speaker: "Sam", text: "That makes complete sense." },
    ],
  });
  const longCues = parseAndValidateVtt(longVtt);
  assert(longCues.length >= 3, `expected long turn to sub-split, got ${longCues.length} cues`);
  assertStringIncludes(longCues[0]!.payload, "<v Élodie>");
  assertStringIncludes(longCues[longCues.length - 1]!.payload, "<v Sam>That makes complete sense.</v>");
});

Deno.test("Case B (direct + chapters): cues align accurately to heading and auto-part chapter boundaries", () => {
  const articleText = [
    "Opening remarks introducing distributed audio pipelines and why durability matters for long articles.",
    "## Queue Architecture",
    "Queues decouple RSS ingestion from synthesis so every feed polls independently. Dead letter queues capture malformed feeds without stalling healthy subscriptions.",
    "## Streaming Uploads",
    "Multipart uploads stream fixed-size chunks directly into R2 object storage so peak worker memory stays bounded well below isolate limits.",
  ].join("\n\n");

  const chapters = [
    { startTime: 0, title: "Introduction" },
    { startTime: 42, title: "Queue Architecture" },
    { startTime: 107, title: "Streaming Uploads" },
  ];

  const cues = buildTranscriptCues({
    mode: "direct",
    durationSeconds: 165,
    chapters,
    articleText,
  });
  const vtt = renderWebVtt(cues);
  const parsed = parseAndValidateVtt(vtt);

  assertEquals(parsed[0]!.start, "00:00:00.000");
  assertEquals(parsed[parsed.length - 1]!.end, "00:02:45.000");

  // Exact chapter boundaries must appear as cue start times with the right text.
  const queueCue = cues.find((c) => c.chapterTitle === "Queue Architecture");
  const uploadCue = cues.find((c) => c.chapterTitle === "Streaming Uploads");
  assert(queueCue, "must emit cues for Queue Architecture chapter");
  assert(uploadCue, "must emit cues for Streaming Uploads chapter");
  assertEquals(queueCue.startTime, 42);
  assertEquals(uploadCue.startTime, 107);
  assertStringIncludes(vtt, "00:00:42.000 -->");
  assertStringIncludes(vtt, "00:01:47.000 -->");

  // Auto-part chapters (headings not verbatim in article text) still align to chapter timestamps.
  const longProse = Array.from(
    { length: 12 },
    (_, i) =>
      `Sentence ${i + 1} discusses the operational trade-offs of edge compute pipelines and caching strategies in detail.`,
  ).join(" ");
  const autoCues = buildTranscriptCues({
    mode: "direct",
    durationSeconds: 360,
    chapters: [
      { startTime: 0, title: "Introduction" },
      { startTime: 180, title: "Part 2" },
    ],
    articleText: longProse,
  });
  const autoParsed = parseAndValidateVtt(renderWebVtt(autoCues));
  assert(
    autoParsed.some((c) => Math.abs(c.startSec - 180) < 0.01),
    "auto-part chapter boundary at 180s must align with a cue start",
  );
  assertEquals(autoParsed[autoParsed.length - 1]!.end, "00:06:00.000");
});

Deno.test("Case C (legacy without chapters): splits prose into readable ~10-15s cues across duration", () => {
  const sentences = Array.from(
    { length: 18 },
    (_, i) =>
      `Paragraph sentence number ${i + 1} explains an important detail about podcasting standards and client caching behavior.`,
  );
  const articleText = [
    sentences.slice(0, 6).join(" "),
    sentences.slice(6, 12).join(" "),
    sentences.slice(12, 18).join(" "),
  ].join("\n\n");

  const vtt = generateEpisodeWebVtt({
    mode: "direct",
    durationSeconds: 120,
    articleText,
  });
  const cues = parseAndValidateVtt(vtt);

  // 120s / ~12s per cue -> roughly 8 to 14 readable cues.
  assert(cues.length >= 6 && cues.length <= 16, `expected ~10 cues for 120s audio, got ${cues.length}`);
  assertEquals(cues[0]!.start, "00:00:00.000");
  assertEquals(cues[cues.length - 1]!.end, "00:02:00.000");
  for (const cue of cues) {
    const dur = cue.endSec - cue.startSec;
    assert(dur >= 3 && dur <= 25, `cue duration (${dur.toFixed(2)}s) should stay in a readable range`);
    assert(cue.payload.length <= 320, `cue text should stay readable, got ${cue.payload.length} chars`);
  }

  // Fallback when durationSeconds and articleText are missing (legacy record with only description).
  const fallbackVtt = generateEpisodeWebVtt({
    mode: "direct",
    description: "Legacy summary of an older episode whose article body was pruned.",
  });
  const fallbackCues = parseAndValidateVtt(fallbackVtt);
  assertEquals(fallbackCues.length, 1);
  assertStringIncludes(fallbackCues[0]!.payload, "Legacy summary");
});

// ---------------------------------------------------------------------------
// 3. Transcript HTTP route: GET /feed/:token/transcript/:episodeId[.vtt]
// ---------------------------------------------------------------------------

Deno.test("GET /feed/:token/transcript/:episodeId serves WebVTT, optional .vtt, ETag/304, and enforces auth/isolation", async () => {
  const { fetch, stores } = bootApp();

  const alice = makeUser({ id: "u-alice", status: "approved", feedToken: "tok-alice" });
  const bob = makeUser({ id: "u-bob", status: "approved", feedToken: "tok-bob" });
  await stores.metadata.putUser(alice);
  await stores.metadata.putUser(bob);

  const unapprovedStatuses: UserStatus[] = ["pending", "suspended", "rejected"];
  for (const status of unapprovedStatuses) {
    await stores.metadata.putUser(
      makeUser({ id: `u-${status}`, status, feedToken: `tok-${status}` }),
    );
  }

  await stores.metadata.putSource(
    makeSource({ id: "blog", userId: alice.id, title: "Edge Notes", modes: ["direct", "deepdive"] }),
  );
  await stores.metadata.putArticle(
    makeArticle({
      id: "art-1",
      userId: alice.id,
      sourceId: "blog",
      title: "Workers Caching",
      content: "Intro text.\n\n## ETag Validation\n\nConditional requests save bandwidth.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-direct",
      userId: alice.id,
      sourceId: "blog",
      articleId: "art-1",
      mode: "direct",
      status: "ready",
      durationSeconds: 90,
      chapters: [
        { startTime: 0, title: "Introduction" },
        { startTime: 35, title: "ETag Validation" },
      ],
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-deep",
      userId: alice.id,
      sourceId: "blog",
      articleId: "art-1",
      mode: "deepdive",
      status: "ready",
      durationSeconds: 45,
      transcript: "Alex: Hello listeners.\n\nSam: Let's dive into conditional caching.",
    }),
  );

  // 1. Accepts both `.vtt` suffix and bare episodeId identically.
  const resWithExt = await fetch(
    new Request(`${BASE}/feed/${alice.feedToken}/transcript/ep-direct.vtt`),
  );
  assertEquals(resWithExt.status, 200);
  assertEquals(resWithExt.headers.get("content-type"), "text/vtt; charset=utf-8");
  assertEquals(resWithExt.headers.get("cache-control"), "private, max-age=3600");
  assertEquals(resWithExt.headers.get("x-robots-tag"), "noindex");
  assertEquals(resWithExt.headers.get("x-content-type-options"), "nosniff");

  const etag = resWithExt.headers.get("etag");
  assert(
    etag !== null && etag.startsWith('"') && etag.endsWith('"') && !etag.startsWith("W/"),
    `transcript must return a strong quoted ETag, got: ${etag}`,
  );
  const bodyWithExt = await resWithExt.text();
  const cuesWithExt = parseAndValidateVtt(bodyWithExt);
  assert(cuesWithExt.some((c) => Math.abs(c.startSec - 35) < 0.01));

  const resBare = await fetch(new Request(`${BASE}/feed/${alice.feedToken}/transcript/ep-direct`));
  assertEquals(resBare.status, 200);
  assertEquals(resBare.headers.get("etag"), etag);
  assertEquals(await resBare.text(), bodyWithExt);

  // 2. Deepdive episode emits speaker voice tags.
  const deepRes = await fetch(new Request(`${BASE}/feed/${alice.feedToken}/transcript/ep-deep.vtt`));
  assertEquals(deepRes.status, 200);
  const deepBody = await deepRes.text();
  parseAndValidateVtt(deepBody);
  assertStringIncludes(deepBody, "<v Alex>Hello listeners.</v>");
  assertStringIncludes(deepBody, "<v Sam>Let's dive into conditional caching.</v>");

  // 3. Conditional GET with If-None-Match (exact, weak W/, comma list, wildcard) -> 304.
  for (const inm of [etag, `W/${etag}`, `"stale", ${etag}`, "*"]) {
    const res304 = await fetch(
      new Request(`${BASE}/feed/${alice.feedToken}/transcript/ep-direct.vtt`, {
        headers: { "if-none-match": inm },
      }),
    );
    assertEquals(res304.status, 304, `expected 304 for If-None-Match: ${inm}`);
    assertEquals(res304.headers.get("etag"), etag);
    assertEquals(res304.headers.get("cache-control"), "private, max-age=3600");
    assertEquals(res304.headers.get("x-robots-tag"), "noindex");
    assertEquals(await res304.text(), "");
  }

  // 4. Non-matching If-None-Match -> 200 with full body.
  const resMismatch = await fetch(
    new Request(`${BASE}/feed/${alice.feedToken}/transcript/ep-direct.vtt`, {
      headers: { "if-none-match": '"not-matching"' },
    }),
  );
  assertEquals(resMismatch.status, 200);
  assertEquals(await resMismatch.text(), bodyWithExt);

  // 5. Updating episode transcript invalidates ETag.
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-deep",
      userId: alice.id,
      sourceId: "blog",
      articleId: "art-1",
      mode: "deepdive",
      status: "ready",
      durationSeconds: 50,
      transcript: "Alex: Updated intro.\n\nSam: Updated commentary.",
    }),
  );
  const updatedDeepRes = await fetch(
    new Request(`${BASE}/feed/${alice.feedToken}/transcript/ep-deep.vtt`, {
      headers: { "if-none-match": deepRes.headers.get("etag")! },
    }),
  );
  assertEquals(updatedDeepRes.status, 200);
  assertNotEquals(updatedDeepRes.headers.get("etag"), deepRes.headers.get("etag"));
  assertStringIncludes(await updatedDeepRes.text(), "<v Alex>Updated intro.</v>");

  // 6. Auth & uniform 404 refusals (unknown token, unapproved users, unknown episode, cross-tenant).
  const unknownRes = await fetch(
    new Request(`${BASE}/feed/no-such-token/transcript/ep-direct.vtt`, {
      headers: { "if-none-match": "*" },
    }),
  );
  assertEquals(unknownRes.status, 404);
  const unknownBody = await unknownRes.text();

  for (const status of unapprovedStatuses) {
    const res = await fetch(
      new Request(`${BASE}/feed/tok-${status}/transcript/ep-direct.vtt`, {
        headers: { "if-none-match": "*" },
      }),
    );
    assertEquals(res.status, 404, `${status} user must receive uniform 404, never 304/403`);
    assertEquals(await res.text(), unknownBody);
  }

  // Cross-tenant isolation: Bob cannot read Alice's episode transcript.
  const crossTenant = await fetch(
    new Request(`${BASE}/feed/${bob.feedToken}/transcript/ep-direct.vtt`),
  );
  assertEquals(crossTenant.status, 404);

  // Unknown episode ID & bare `.vtt` with empty id.
  const missingEp = await fetch(
    new Request(`${BASE}/feed/${alice.feedToken}/transcript/does-not-exist.vtt`),
  );
  assertEquals(missingEp.status, 404);
  const emptyIdExt = await fetch(
    new Request(`${BASE}/feed/${alice.feedToken}/transcript/.vtt`),
  );
  assertEquals(emptyIdExt.status, 404);

  // HEAD request works via GET handler and preserves headers.
  const headRes = await fetch(
    new Request(`${BASE}/feed/${alice.feedToken}/transcript/ep-direct.vtt`, { method: "HEAD" }),
  );
  assertEquals(headRes.status, 200);
  assertEquals(headRes.headers.get("content-type"), "text/vtt; charset=utf-8");
  assertEquals(headRes.headers.get("etag"), etag);
});

Deno.test("GET /feed/:token/transcript/:episodeId enforces sliding-window rate limiting", async () => {
  const { fetch, stores } = bootApp();
  const user = makeUser({ id: "u-rl", status: "approved", feedToken: "tok-rl" });
  await stores.metadata.putUser(user);
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-rl",
      userId: user.id,
      status: "ready",
      description: "Rate limited transcript.",
    }),
  );

  const client = { remoteAddr: { hostname: "203.0.113.42" } };
  for (let i = 0; i < TRANSCRIPT_RATE_LIMIT.maxRequests; i++) {
    const res = await fetch(
      new Request(`${BASE}/feed/${user.feedToken}/transcript/ep-rl.vtt`),
      client,
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
  }

  const limited = await fetch(
    new Request(`${BASE}/feed/${user.feedToken}/transcript/ep-rl.vtt`),
    client,
  );
  assertEquals(limited.status, 429);
  assert(Number(limited.headers.get("retry-after")) >= 1);
  assertEquals(limited.headers.get("cache-control"), "no-store");
});

// ---------------------------------------------------------------------------
// 4. RSS XML <podcast:transcript> projection & emission
// ---------------------------------------------------------------------------

Deno.test("toFeedEpisode and RSS builders emit <podcast:transcript> with xmlns:podcast", () => {
  const stored = makeEpisode({
    id: "ep-tx-1",
    userId: "user-1",
    sourceId: "stratechery",
    status: "ready",
    audioKey: "audio/user-1/direct/ep-tx-1.mp3",
    byteLength: 2048,
    contentType: "audio/mpeg",
  });

  const withoutToken = toFeedEpisode(stored, { publicBaseUrl: BASE });
  assert(withoutToken);
  assertEquals(withoutToken.transcriptUrl, undefined);

  const withToken = toFeedEpisode(stored, { publicBaseUrl: BASE, feedToken: "tok-123" });
  assert(withToken);
  assertEquals(withToken.transcriptUrl, `${BASE}/feed/tok-123/transcript/ep-tx-1.vtt`);

  const sourceXml = buildSourceFeed({
    origin: BASE,
    token: "tok-123",
    source: { id: "stratechery", title: "Stratechery" },
    kind: "direct",
    episodes: [withToken],
  });
  assertStringIncludes(sourceXml, 'xmlns:podcast="https://podcastindex.org/namespace/1.0"');
  assertStringIncludes(
    sourceXml,
    `<podcast:transcript url="${BASE}/feed/tok-123/transcript/ep-tx-1.vtt" type="text/vtt"/>`,
  );

  const masterXml = buildMasterFeed({
    origin: BASE,
    token: "tok-123",
    episodes: [withToken],
  });
  assertStringIncludes(masterXml, 'xmlns:podcast="https://podcastindex.org/namespace/1.0"');
  assertStringIncludes(
    masterXml,
    `<podcast:transcript url="${BASE}/feed/tok-123/transcript/ep-tx-1.vtt" type="text/vtt"/>`,
  );
});

// ---------------------------------------------------------------------------
// 5. RSS ETag & If-None-Match (304 Not Modified) on master & per-source feeds
// ---------------------------------------------------------------------------

Deno.test("Master and per-source RSS feeds emit <podcast:transcript>, deterministic ETags, and 304 Not Modified while preserving security headers", async () => {
  const { fetch, stores } = bootApp();

  const user = makeUser({
    id: "u-feed",
    displayName: "Paul",
    status: "approved",
    feedToken: "tok-feed-etag",
  });
  const pending = makeUser({
    id: "u-feed-pending",
    status: "pending",
    feedToken: "tok-feed-pending",
  });
  await stores.metadata.putUser(user);
  await stores.metadata.putUser(pending);
  await stores.metadata.putSource(
    makeSource({
      id: "src-1",
      userId: user.id,
      title: "Systems Blog",
      modes: ["direct", "deepdive"],
    }),
  );

  // 1. Empty feed still has a deterministic ETag and returns 304 on repeat poll.
  const empty1 = await fetch(new Request(`${BASE}/feed/${user.feedToken}/master.xml`));
  assertEquals(empty1.status, 200);
  const emptyEtag = empty1.headers.get("etag");
  assert(emptyEtag && emptyEtag.length > 4, "empty master feed must still emit an ETag");
  assertEquals(empty1.headers.get("cache-control"), "private, no-store");
  assertEquals(empty1.headers.get("x-robots-tag"), "noindex");
  await empty1.body?.cancel();

  const empty304 = await fetch(
    new Request(`${BASE}/feed/${user.feedToken}/master.xml`, {
      headers: { "if-none-match": emptyEtag },
    }),
  );
  assertEquals(empty304.status, 304);
  assertEquals(empty304.headers.get("etag"), emptyEtag);
  assertEquals(empty304.headers.get("cache-control"), "private, no-store");
  assertEquals(empty304.headers.get("x-robots-tag"), "noindex");
  assertEquals(await empty304.text(), "");

  // 2. Adding a ready episode changes the ETag (200) and emits <podcast:transcript>.
  await stores.metadata.putArticle(
    makeArticle({
      id: "art-feed-1",
      userId: user.id,
      sourceId: "src-1",
      content: "First article body for transcript verification.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-feed-1",
      userId: user.id,
      sourceId: "src-1",
      sourceTitle: "Systems Blog",
      articleId: "art-feed-1",
      mode: "direct",
      status: "ready",
      audioKey: `audio/${user.id}/direct/ep-feed-1.mp3`,
      byteLength: 4096,
      durationSeconds: 120,
      readyAt: "2026-10-01T10:00:00.000Z",
    }),
  );

  const masterAfterAdd = await fetch(
    new Request(`${BASE}/feed/${user.feedToken}/master.xml`, {
      headers: { "if-none-match": emptyEtag },
    }),
  );
  assertEquals(masterAfterAdd.status, 200);
  const masterEtag1 = masterAfterAdd.headers.get("etag");
  assert(masterEtag1 && masterEtag1 !== emptyEtag, "adding an episode must change the feed ETag");
  assertEquals(masterAfterAdd.headers.get("cache-control"), "private, no-store");
  assertEquals(masterAfterAdd.headers.get("x-robots-tag"), "noindex");

  const masterXml = await masterAfterAdd.text();
  const expectedTranscriptUrl = `${BASE}/feed/${user.feedToken}/transcript/ep-feed-1.vtt`;
  assertStringIncludes(
    masterXml,
    `<podcast:transcript url="${expectedTranscriptUrl}" type="text/vtt"/>`,
  );

  // Following the emitted <podcast:transcript> URL returns valid WebVTT.
  const followedVttRes = await fetch(new Request(expectedTranscriptUrl));
  assertEquals(followedVttRes.status, 200);
  assertEquals(followedVttRes.headers.get("content-type"), "text/vtt; charset=utf-8");
  parseAndValidateVtt(await followedVttRes.text());

  // 3. Matching If-None-Match variants (exact, strong form, comma list) return 304 on master.xml.
  const strippedStrong = masterEtag1.startsWith("W/") ? masterEtag1.slice(2) : masterEtag1;
  for (const inm of [masterEtag1, strippedStrong, `"old-tag", ${masterEtag1}`]) {
    const res304 = await fetch(
      new Request(`${BASE}/feed/${user.feedToken}/master.xml`, {
        headers: { "if-none-match": inm },
      }),
    );
    assertEquals(res304.status, 304, `master feed must return 304 for If-None-Match: ${inm}`);
    assertEquals(res304.headers.get("etag"), masterEtag1);
    assertEquals(res304.headers.get("cache-control"), "private, no-store");
    assertEquals(res304.headers.get("x-robots-tag"), "noindex");
    assertEquals(await res304.text(), "");
  }

  // 4. Per-source feeds: direct.xml & deepdive.xml have distinct ETags and return 304 independently.
  const directRes = await fetch(new Request(`${BASE}/feed/${user.feedToken}/src-1/direct.xml`));
  assertEquals(directRes.status, 200);
  const directEtag1 = directRes.headers.get("etag");
  assert(directEtag1 && directEtag1 !== masterEtag1);
  assertEquals(directRes.headers.get("cache-control"), "private, no-store");
  const directXml = await directRes.text();
  assertStringIncludes(
    directXml,
    `<podcast:transcript url="${expectedTranscriptUrl}" type="text/vtt"/>`,
  );

  const direct304 = await fetch(
    new Request(`${BASE}/feed/${user.feedToken}/src-1/direct.xml`, {
      headers: { "if-none-match": directEtag1 },
    }),
  );
  assertEquals(direct304.status, 304);
  assertEquals(direct304.headers.get("etag"), directEtag1);
  assertEquals(direct304.headers.get("cache-control"), "private, no-store");
  assertEquals(await direct304.text(), "");

  // Adding a deepdive episode invalidates master.xml and deepdive.xml, NOT direct.xml!
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-feed-2",
      userId: user.id,
      sourceId: "src-1",
      sourceTitle: "Systems Blog",
      articleId: "art-feed-1",
      mode: "deepdive",
      status: "ready",
      audioKey: `audio/${user.id}/deepdive/ep-feed-2.mp3`,
      byteLength: 8192,
      durationSeconds: 240,
      transcript: "Alex: Deepdive opening.\n\nSam: Great point.",
      readyAt: "2026-10-01T11:00:00.000Z",
    }),
  );

  const directStill304 = await fetch(
    new Request(`${BASE}/feed/${user.feedToken}/src-1/direct.xml`, {
      headers: { "if-none-match": directEtag1 },
    }),
  );
  assertEquals(directStill304.status, 304, "deepdive addition must not invalidate direct.xml ETag");

  const masterChanged = await fetch(
    new Request(`${BASE}/feed/${user.feedToken}/master.xml`, {
      headers: { "if-none-match": masterEtag1 },
    }),
  );
  assertEquals(masterChanged.status, 200);
  const masterEtag2 = masterChanged.headers.get("etag");
  assertNotEquals(masterEtag2, masterEtag1);
  await masterChanged.body?.cancel();

  // 5. Source metadata rename invalidates both master.xml and per-source ETag.
  await stores.metadata.putSource(
    makeSource({
      id: "src-1",
      userId: user.id,
      title: "Systems Blog Renamed",
      modes: ["direct", "deepdive"],
    }),
  );
  const directAfterRename = await fetch(
    new Request(`${BASE}/feed/${user.feedToken}/src-1/direct.xml`, {
      headers: { "if-none-match": directEtag1 },
    }),
  );
  assertEquals(directAfterRename.status, 200);
  assertNotEquals(directAfterRename.headers.get("etag"), directEtag1);
  assertStringIncludes(await directAfterRename.text(), "Systems Blog Renamed — Direct Read");

  const masterAfterRename = await fetch(
    new Request(`${BASE}/feed/${user.feedToken}/master.xml`, {
      headers: { "if-none-match": masterEtag2! },
    }),
  );
  assertEquals(masterAfterRename.status, 200);
  assertNotEquals(masterAfterRename.headers.get("etag"), masterEtag2);
  await masterAfterRename.body?.cancel();

  // 6. Unapproved and unknown tokens NEVER receive 304 even with If-None-Match: *.
  for (const tok of ["unknown-tok", pending.feedToken]) {
    const m = await fetch(
      new Request(`${BASE}/feed/${tok}/master.xml`, { headers: { "if-none-match": "*" } }),
    );
    assertEquals(m.status, 404);
    const s = await fetch(
      new Request(`${BASE}/feed/${tok}/src-1/direct.xml`, { headers: { "if-none-match": "*" } }),
    );
    assertEquals(s.status, 404);
  }
});
