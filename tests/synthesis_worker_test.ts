/**
 * Synthesis worker tests (audio-feed-b3a).
 *
 * Deterministic: synthesis is injected, so the loop, the retry policy, the
 * approval re-check and the status transitions are all exercised without
 * spending money. The last test is the payoff the whole project has been
 * missing — a queued article becomes an episode that a subscriber can actually
 * play — driven through the real dispatch function.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch, startSynthesisWorker } from "../src/worker/synthesis.ts";
import { GeminiTtsError, GeminiTtsTruncatedError } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { Synthesizer } from "../src/worker/synthesis.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

/** A tiny but genuinely decodable WAV-shaped payload (RIFF header + PCM). */
function fakeAudio(bytes = 480): DecodedAudioResult {
  const raw = new Uint8Array(44 + bytes);
  raw.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  raw.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  raw.set([0x64, 0x61, 0x74, 0x61], 36); // data
  return {
    rawBytes: raw,
    mimeType: "audio/wav",
    format: "wav",
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    durationSeconds: 2,
    finishReason: "STOP",
    truncated: false,
    toWav: () => raw,
  };
}

/** An app with one approved user and one queued episode ready to synthesise. */
async function queued(userOverrides = {}) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved", ...userOverrides }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "article-1", userId: "user-1", sourceId: "inbox" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "pending",
      mode: "direct",
      audioKey: undefined,
    }),
  );
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { ctx, stores, fetch };
}

Deno.test("a queued episode is synthesised, stored and marked ready", async () => {
  const { ctx, stores } = await queued();
  let calls = 0;
  const result = await runSynthesisBatch(ctx, () => {
    calls++;
    return Promise.resolve(fakeAudio());
  });

  assertEquals(calls, 1);
  assertEquals(result.considered, 1);
  assertEquals(result.failed, []);
  assertEquals(result.deferred, []);

  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(episode?.status, "ready");
  assertEquals(episode?.audioKey, "episode-1.wav");
  assertEquals(episode?.contentType, "audio/wav");
  assertEquals(episode?.byteLength, 524);
  assert(episode?.readyAt, "readyAt must be recorded: the feed sorts on it");
  assert(episode?.error === undefined, "a ready episode must not carry an error");

  // The bytes must actually be in the blob store, not just referenced.
  const blob = await stores.blobs.head("episode-1.wav");
  assertEquals(blob?.size, 524);
  assertEquals(blob?.contentType, "audio/wav");
});

Deno.test("the mode chooses the synthesis call and the source voices reach it", async () => {
  const { ctx } = await queued();
  const seen: Array<{ mode: string; voice?: string }> = [];
  const spy: Synthesizer = ({ mode, source }) => {
    seen.push({ mode, voice: source?.voices.direct });
    return Promise.resolve(fakeAudio());
  };
  await runSynthesisBatch(ctx, spy);
  assertEquals(seen, [{ mode: "direct", voice: "Charon" }]);
});

Deno.test("a transient failure is retried, and a later attempt wins", async () => {
  const { ctx, stores } = await queued();
  let attempts = 0;
  const flaky: Synthesizer = () => {
    attempts++;
    if (attempts < 3) {
      // 429 is transient: the client retries these internally too.
      return Promise.reject(new GeminiTtsError("rate limited", 429));
    }
    return Promise.resolve(fakeAudio());
  };

  const result = await runSynthesisBatch(ctx, flaky, { retryBaseDelayMs: 1 });
  assertEquals(attempts, 3);
  assertEquals(result.ready.length, 1);
  assertEquals((await stores.metadata.getEpisode("user-1", "episode-1"))?.status, "ready");
});

Deno.test("attempts are bounded and a poison job ends up failed, not billed forever", async () => {
  const { ctx, stores } = await queued();
  let attempts = 0;
  const flaky: Synthesizer = () => {
    attempts++;
    return Promise.reject(new GeminiTtsError("still rate limited", 503));
  };

  const result = await runSynthesisBatch(ctx, flaky, { maxAttempts: 2, retryBaseDelayMs: 1 });
  assertEquals(attempts, 2, "must stop at maxAttempts");
  assertEquals(result.failed.length, 1);
  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(episode?.status, "failed");
  assertStringIncludes(episode?.error ?? "", "still rate limited");
  // Nothing was stored for a failed job.
  assertEquals(await stores.blobs.head("episode-1.wav"), null);
});

Deno.test("a permanent failure is not retried at all", async () => {
  const { ctx, stores } = await queued();
  let attempts = 0;
  const bad: Synthesizer = () => {
    attempts++;
    return Promise.reject(new GeminiTtsError("bad request", 400));
  };
  await runSynthesisBatch(ctx, bad, { maxAttempts: 5, retryBaseDelayMs: 1 });
  assertEquals(attempts, 1, "a 400 cannot be fixed by retrying");
  assertEquals(
    (await stores.metadata.getEpisode("user-1", "episode-1"))?.status,
    "failed",
  );
});

Deno.test("truncated audio is a permanent failure, never published", async () => {
  const { ctx, stores } = await queued();
  const truncated: Synthesizer = () =>
    Promise.reject(new GeminiTtsTruncatedError("MAX_TOKENS", fakeAudio()));
  await runSynthesisBatch(ctx, truncated, { retryBaseDelayMs: 1 });
  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(episode?.status, "failed");
  assertStringIncludes(episode?.error ?? "", "incomplete");
});

Deno.test("an unapproved user's job is deferred without spending", async () => {
  const { ctx, stores } = await queued({ status: "suspended" });
  let calls = 0;
  const result = await runSynthesisBatch(ctx, () => {
    calls++;
    return Promise.resolve(fakeAudio());
  });

  assertEquals(calls, 0, "a suspended user must not reach the paid API");
  assertEquals(result.deferred.length, 1);
  assertStringIncludes(result.deferred[0]!.reason, "not authorized");
  // Deferred, not failed: the job survives so re-approval can pick it up.
  assertEquals((await stores.metadata.getEpisode("user-1", "episode-1"))?.status, "pending");
});

Deno.test("ready episodes are not synthesised twice", async () => {
  const { ctx, stores } = await queued();
  await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()));
  let second = 0;
  const again = await runSynthesisBatch(ctx, () => {
    second++;
    return Promise.resolve(fakeAudio());
  });
  assertEquals(second, 0);
  assertEquals(again.considered, 0);
  assertEquals((await stores.metadata.getEpisode("user-1", "episode-1"))?.status, "ready");
});

Deno.test("a missing article fails the job with a readable reason", async () => {
  const stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putEpisode(
    makeEpisode({ id: "episode-1", userId: "user-1", status: "pending", audioKey: undefined }),
  );
  const ctx = { config, stores };
  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()));
  assertEquals(result.failed.length, 1);
  assertStringIncludes(result.failed[0]!.error, "article record is missing");
});

Deno.test("the loop runs a tick, stops on abort, and never dies on a bad tick", async () => {
  const { ctx, stores } = await queued();
  let ticks = 0;
  const worker = startSynthesisWorker(
    ctx,
    () => {
      ticks++;
      return Promise.resolve(fakeAudio());
    },
    { intervalMs: 10 },
  );
  await new Promise((r) => setTimeout(r, 60));
  await worker.stop();
  assert(ticks >= 1, `expected at least one tick, got ${ticks}`);
  const afterStop = ticks;
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(ticks, afterStop, "no ticks after stop()");
  assertEquals((await stores.metadata.getEpisode("user-1", "episode-1"))?.status, "ready");

  // A throwing tick must not kill the loop. Fresh stores, because the episode
  // above is ready now and a ready episode is (correctly) never retried.
  const { ctx: failingCtx } = await queued();
  const abort = new AbortController();
  const failTicks = { n: 0 };
  const fragile = startSynthesisWorker(
    failingCtx,
    () => Promise.reject(new Error("transport down")),
    {
      intervalMs: 10,
      signal: abort.signal,
      maxAttempts: 1,
      onTick: () => {
        failTicks.n++;
      },
    },
  );
  await new Promise((r) => setTimeout(r, 60));
  abort.abort();
  await fragile.stop();
  // The episode is marked failed on the first tick (correctly — no retry spend),
  // so repeated SYNTHESIS attempts are not the signal here: surviving TICKS are.
  assert(failTicks.n >= 2, `the loop must keep ticking after a failing tick, got ${failTicks.n}`);
});

// ---------------------------------------------------------------------------
// The payoff: a queued article becomes audio a subscriber can play
// ---------------------------------------------------------------------------

Deno.test("END TO END: ingest queues it, the worker synthesises it, the feed publishes it", async () => {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", status: "approved", feedToken: "token-user-1" }),
  );
  const ctx = { config, stores };
  const { fetch } = createApp(
    ctx,
    createHandlers(ctx, {
      // The article fetch is the only network call in this path.
      fetchArticle: () =>
        Promise.resolve({
          url: "https://example.com/aggregation",
          title: "The Aggregation Theory of Everything",
          author: "Ben Thompson",
          publishedAt: "2026-09-01T00:00:00.000Z",
          lead: "A lead.",
          body: "Aggregation theory explains why platforms win.",
        }),
    }),
  );

  // 1. A subscriber's article is ingested...
  const ingest = await fetch(
    new Request(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-feed-token": "token-user-1" },
      body: JSON.stringify({ url: "https://example.com/aggregation", mode: "direct" }),
    }),
  );
  assertEquals(ingest.status, 202);
  const job = await ingest.json();
  assertEquals(job.status, "queued");

  // 2. ...the worker turns it into audio...
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()));
  assertEquals(run.ready.length, 1, "the queued job must be synthesised");
  assertEquals(run.failed, []);

  // 3. ...and the feed a subscriber already has now carries it, playable.
  const feedRes = await fetch(new Request(`${BASE}/feed/token-user-1/master.xml`));
  assertEquals(feedRes.status, 200);
  const xml = await feedRes.text();
  assertStringIncludes(xml, "The Aggregation Theory of Everything");
  const enclosure = xml.match(/<enclosure url="([^"]+)" length="(\d+)" type="([^"]+)"/);
  assert(enclosure, "the new episode must advertise an enclosure");
  assertEquals(enclosure[3], "audio/wav");
  assertEquals(Number(enclosure[2]), 524);
  const enclosureUrl = enclosure[1]!;

  const audio = await fetch(new Request(enclosureUrl));
  assertEquals(audio.status, 200);
  assertEquals((await audio.bytes()).length, 524);
  // Seeking is how a podcast client resumes; the enclosure must support it.
  const ranged = await fetch(new Request(enclosureUrl, { headers: { range: "bytes=0-99" } }));
  assertEquals(ranged.status, 206);
  assertStringIncludes(ranged.headers.get("content-range") ?? "", "bytes 0-99/524");

  // The episode id the worker reported is the one the feed published.
  assertStringIncludes(xml, `<guid isPermaLink="false">${job.episodeId}</guid>`);
});

// ---------------------------------------------------------------------------
// audio-feed-d4b: a suspended user's backlog must not starve everyone else
// ---------------------------------------------------------------------------

/** A suspended user with a backlog, inserted FIRST so their jobs are scanned first. */
async function starved(backlog = 5) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "suspended-1", email: "s@example.com", status: "suspended" }),
  );
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "article-1", userId: "user-1", sourceId: "inbox" }),
  );
  // The blocked backlog, created first so it is encountered first.
  for (let i = 0; i < backlog; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `blocked-${i}`,
        userId: "suspended-1",
        sourceId: "inbox",
        status: "pending",
        audioKey: undefined,
      }),
    );
  }
  // One approved job behind it in the queue.
  for (let i = 0; i < 2; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `allowed-${i}`,
        userId: "user-1",
        sourceId: "inbox",
        articleId: "article-1",
        status: "pending",
        audioKey: undefined,
      }),
    );
  }
  const ctx = { config, stores };
  return { ctx, stores };
}

Deno.test("a suspended user's backlog does not block an approved user's job", async () => {
  const { ctx, stores } = await starved();
  let calls = 0;
  const run = await runSynthesisBatch(ctx, () => {
    calls++;
    return Promise.resolve(fakeAudio());
  });

  // The regression: this used to be ready=0 deferred=5, every tick, forever.
  assert(run.ready.length > 0, `approved work must still run, got ${JSON.stringify(run)}`);
  assertEquals(calls, run.ready.length);
  assertEquals((await stores.metadata.getEpisode("user-1", "allowed-0"))?.status, "ready");
  // The blocked backlog is reported and preserved, not destroyed.
  assert(run.deferred.length > 0, "the suspended backlog must be reported as deferred");
  assertEquals((await stores.metadata.getEpisode("suspended-1", "blocked-0"))?.status, "pending");
});

Deno.test("deferred jobs never consume the attempt budget", async () => {
  const { ctx, stores } = await starved(5);
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()));

  // batchSize 2: both attempts went to approved work, none to the blocked backlog.
  assertEquals(run.ready.length, 2, JSON.stringify(run));
  assert(run.deferred.length >= 2, "the suspended user's jobs are still reported");
  assertEquals((await stores.metadata.getEpisode("user-1", "allowed-1"))?.status, "ready");
});

Deno.test("the batch budget still bounds synthesis work", async () => {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "article-1", userId: "user-1", sourceId: "inbox" }),
  );
  for (let i = 0; i < 6; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `allowed-${i}`,
        userId: "user-1",
        sourceId: "inbox",
        articleId: "article-1",
        status: "pending",
        audioKey: undefined,
      }),
    );
  }
  const ctx = { config, stores };
  let calls = 0;
  const run = await runSynthesisBatch(ctx, () => {
    calls++;
    return Promise.resolve(fakeAudio());
  }, { batchSize: 2 });
  // Deferred work is free; approved work is bounded by the batch budget.
  assertEquals(calls, 2, "batchSize 2 must bound synthesis calls to 2");
  assertEquals(run.ready.length, 2);
  // The rest stays pending for the next tick rather than being dropped. Episodes are
  // listed newest-first, so the two newest were the ones attempted.
  assertEquals((await stores.metadata.getEpisode("user-1", "allowed-0"))?.status, "pending");
});

Deno.test("a suspension landing mid-tick stops the remaining spend", async () => {
  // The window audio-feed-opus identified: one tick can run ~50s at real synthesis
  // speed, so approval must be re-read immediately before spending, not only at
  // gather time. Here the user is suspended while their FIRST episode synthesises.
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "article-1", userId: "user-1", sourceId: "inbox" }),
  );
  for (let i = 0; i < 2; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-${i}`,
        userId: "user-1",
        sourceId: "inbox",
        articleId: "article-1",
        status: "pending",
        audioKey: undefined,
      }),
    );
  }
  const ctx = { config, stores };

  let calls = 0;
  const run = await runSynthesisBatch(ctx, async () => {
    calls++;
    // The admin suspends the user while the first episode is being synthesised.
    const user = await stores.metadata.getUser("user-1");
    await stores.metadata.putUser({ ...user!, status: "suspended" });
    return fakeAudio();
  }, { batchSize: 5 });

  assertEquals(calls, 1, "the second episode must not be synthesised after the suspension");
  assertEquals(run.ready.length, 1);
  assert(
    run.deferred.length >= 1,
    `the remaining episode must be deferred, got ${JSON.stringify(run)}`,
  );
  // The un-synthesised episode survives as pending so re-approval can serve it.
  const statuses = await Promise.all(
    ["ep-0", "ep-1"].map(async (id) => (await stores.metadata.getEpisode("user-1", id))?.status),
  );
  assert(
    statuses.includes("pending"),
    `expected one episode left pending, got ${statuses.join(",")}`,
  );
});
