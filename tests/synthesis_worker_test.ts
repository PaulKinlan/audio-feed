/**
 * Synthesis worker tests (audio-feed-b3a).
 *
 * Deterministic: synthesis is injected, so the loop, the retry policy, the
 * approval re-check and the status transitions are all exercised without
 * spending money. The last test is the payoff the whole project has been
 * missing — a queued article becomes an episode that a subscriber can actually
 * play — driven through the real dispatch function.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch, startSynthesisWorker } from "../src/worker/synthesis.ts";
import { GeminiTtsError, GeminiTtsTruncatedError } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { audioBlobKey } from "../src/types.ts";
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
async function queued(userOverrides = {}, sourceOverrides = {}) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved", ...userOverrides }));
  await stores.metadata.putSource(
    makeSource({ id: "inbox", userId: "user-1", ...sourceOverrides }),
  );
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
  // Every synthesis writes its own revision under the canonical scoping
  // (audio-feed-xsu): the episode's key is never the bare canonical path.
  assertMatch(
    episode?.audioKey ?? "",
    /^audio\/user-1\/direct\/episode-1-[0-9a-f-]+\.wav$/,
  );
  assertEquals(episode?.contentType, "audio/wav");
  assertEquals(episode?.byteLength, 524);
  assert(episode?.readyAt, "readyAt must be recorded: the feed sorts on it");
  assert(episode?.error === undefined, "a ready episode must not carry an error");

  // The bytes must actually be in the blob store, not just referenced.
  const blob = await stores.blobs.head(episode!.audioKey!);
  assertEquals(blob?.size, 524);
  assertEquals(blob?.contentType, "audio/wav");
});

Deno.test("the mode chooses the synthesis call and the source voices reach it", async () => {
  // The source now declares its own narrator. It used to inherit one from the
  // fixture's DEFAULT_VOICES stamp, so this asserted "Charon" while testing nothing
  // about a source choosing a voice - the assertion passed because of how the
  // fixture was built, not because of the behaviour under test (audio-feed-8pt).
  const { ctx } = await queued({}, { voices: { direct: "Fenrir" } });
  const seen: Array<{ mode: string; voice?: string }> = [];
  const spy: Synthesizer = ({ mode, source }) => {
    seen.push({ mode, voice: source?.voices.direct });
    return Promise.resolve(fakeAudio());
  };
  await runSynthesisBatch(ctx, spy);
  assertEquals(seen, [{ mode: "direct", voice: "Fenrir" }]);
});

Deno.test("a source with no chosen voice reaches the synthesizer as unspecified", async () => {
  // The other half: with the fixture now matching production, this is the shape a
  // real subscription produces, and the worker must see `undefined` rather than a
  // value the fixture invented. Resolution is the synthesizer's job (4xt/6ey), not
  // the fixture's.
  const { ctx } = await queued();
  const seen: Array<{ mode: string; voice?: string }> = [];
  const spy: Synthesizer = ({ mode, source }) => {
    seen.push({ mode, voice: source?.voices.direct });
    return Promise.resolve(fakeAudio());
  };
  await runSynthesisBatch(ctx, spy);
  assertEquals(seen, [{ mode: "direct", voice: undefined }]);
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
  assertEquals(await stores.blobs.head("audio/user-1/direct/episode-1.wav"), null);
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
async function starved(backlog = 5, approved = 2) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "suspended-1", email: "s@example.com", status: "suspended" }),
  );
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "article-1", userId: "user-1", sourceId: "inbox" }),
  );
  // The blocked backlog, created first with older timestamps so it is encountered first.
  for (let i = 0; i < backlog; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `blocked-${i}`,
        userId: "suspended-1",
        sourceId: "inbox",
        status: "pending",
        audioKey: undefined,
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    );
  }
  // Approved jobs behind it in the queue.
  for (let i = 0; i < approved; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `allowed-${i}`,
        userId: "user-1",
        sourceId: "inbox",
        articleId: "article-1",
        status: "pending",
        audioKey: undefined,
        createdAt: "2026-09-10T00:00:00.000Z",
      }),
    );
  }
  const ctx = { config, stores };
  return { ctx, stores };
}

Deno.test("a suspended user's backlog does not block an approved user's job", async () => {
  // 25 deferred jobs from suspended user + 3 approved jobs (audio-feed-bbb review finding)
  const { ctx, stores } = await starved(25, 3);
  let calls = 0;
  const run = await runSynthesisBatch(ctx, () => {
    calls++;
    return Promise.resolve(fakeAudio());
  }, { batchSize: 3 });

  // Must process all 3 approved jobs despite the 25 older deferred jobs!
  assertEquals(run.ready.length, 3, `all 3 approved jobs must run, got ${JSON.stringify(run)}`);
  assertEquals(calls, 3);
  assertEquals((await stores.metadata.getEpisode("user-1", "allowed-0"))?.status, "ready");
  assertEquals((await stores.metadata.getEpisode("user-1", "allowed-1"))?.status, "ready");
  assertEquals((await stores.metadata.getEpisode("user-1", "allowed-2"))?.status, "ready");
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

Deno.test("a large deferred backlog (50 jobs) pages with cursor in linear time and budget", async () => {
  const { ctx, stores } = await starved(50, 2);

  let listCalls = 0;
  const origList = stores.metadata.listPendingEpisodes.bind(stores.metadata);
  stores.metadata.listPendingEpisodes = (opts) => {
    listCalls++;
    return origList(opts);
  };

  let pointReads = 0;
  const origGet = stores.metadata.getEpisode.bind(stores.metadata);
  stores.metadata.getEpisode = (userId, id) => {
    pointReads++;
    return origGet(userId, id);
  };

  const started = Date.now();
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    batchSize: 2,
  });
  const elapsed = Date.now() - started;

  assertEquals(run.ready.length, 2, "approved jobs behind 50 deferred jobs must run");
  assertEquals((await stores.metadata.getEpisode("user-1", "allowed-0"))?.status, "ready");
  assert(run.deferred.length <= 2, "deferred report is capped at batchSize");

  // Shape-independent cost checks (audio-feed-7li item 3, audio-feed-2np):
  // 50 deferred + 2 approved = 52 total items. With CHUNK_SIZE = 25, exactly ceil(52 / 25) = 3 pages.
  assertEquals(
    listCalls,
    3,
    `paging must fetch exactly ceil(N / chunk) pages (expected 3, got ${listCalls})`,
  );
  // Point reads across all pages must touch only the 52 examined items (plus claim reads for the 2 approved),
  // proving that listPendingEpisodes touches only page items and does not scan the catalogue (audio-feed-2np).
  assertEquals(
    pointReads,
    53,
    `point reads must equal 52 examined items + 1 verification read (expected 53, got ${pointReads})`,
  );
  assert(elapsed < 500, `must complete quickly in linear time, took ${elapsed}ms`);
});

Deno.test("deferred backlog paging scales linearly across N and 2N jobs (audio-feed-7li)", async () => {
  // 25 deferred + 2 approved vs 50 deferred + 2 approved
  const first = await starved(25, 2);
  let firstCalls = 0;
  const origFirst = first.stores.metadata.listPendingEpisodes.bind(first.stores.metadata);
  first.stores.metadata.listPendingEpisodes = (opts) => {
    firstCalls++;
    return origFirst(opts);
  };
  await runSynthesisBatch(first.ctx, () => Promise.resolve(fakeAudio()), { batchSize: 2 });

  const second = await starved(50, 2);
  let secondCalls = 0;
  const origSecond = second.stores.metadata.listPendingEpisodes.bind(second.stores.metadata);
  second.stores.metadata.listPendingEpisodes = (opts) => {
    secondCalls++;
    return origSecond(opts);
  };
  await runSynthesisBatch(second.ctx, () => Promise.resolve(fakeAudio()), { batchSize: 2 });

  // 27 items -> ceil(27/25) = 2 calls
  // 52 items -> ceil(52/25) = 3 calls
  assertEquals(firstCalls, 2);
  assertEquals(secondCalls, 3);
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
  // listed oldest-first (FIFO), so allowed-0 and allowed-1 were attempted and allowed-5 stays pending.
  assertEquals((await stores.metadata.getEpisode("user-1", "allowed-5"))?.status, "pending");
});

Deno.test("queue order is FIFO cross-user by age, preventing a prolific user from starving older jobs", async () => {
  const stores: Stores = memoryStores();
  // User "hog" with a backlog queued on 2026-09-10
  await stores.metadata.putUser(makeUser({ id: "hog", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "hog" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "art-hog", userId: "hog", sourceId: "inbox" }),
  );
  for (let i = 0; i < 5; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `hog-${i}`,
        userId: "hog",
        sourceId: "inbox",
        articleId: "art-hog",
        status: "pending",
        createdAt: "2026-09-10T12:00:00.000Z",
      }),
    );
  }

  // User "waiter" with one episode queued earlier on 2026-09-01
  await stores.metadata.putUser(makeUser({ id: "waiter", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "waiter" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "art-waiter", userId: "waiter", sourceId: "inbox" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "waiter-oldest",
      userId: "waiter",
      sourceId: "inbox",
      articleId: "art-waiter",
      status: "pending",
      createdAt: "2026-09-01T12:00:00.000Z",
    }),
  );

  const ctx = { config, stores };
  const processedOrder: string[] = [];
  const run = await runSynthesisBatch(ctx, ({ episode }) => {
    processedOrder.push(episode.id);
    return Promise.resolve(fakeAudio());
  }, { batchSize: 3 });

  // Older job must be processed first!
  assertEquals(
    processedOrder[0],
    "waiter-oldest",
    "oldest job across users must be synthesised first",
  );
  assertEquals(run.ready.length, 3);
  assertEquals(
    (await stores.metadata.getEpisode("waiter", "waiter-oldest"))?.status,
    "ready",
  );
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

// ---------------------------------------------------------------------------
// audio-feed-vfs / audio-feed-kiq: exclusivity and recovery
//
// The store-level conformance suite proves the claim primitive is atomic. These
// prove the WORKER uses it — a correct primitive called in the wrong place
// still double-spends.
// ---------------------------------------------------------------------------

/** One approved user with `count` queued episodes. */
async function queuedMany(count: number) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "article-1", userId: "user-1", sourceId: "inbox" }),
  );
  for (let i = 0; i < count; i++) {
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
  return { ctx: { config, stores }, stores };
}

Deno.test("two workers racing one episode bill it exactly once", async () => {
  // The vfs measurement: before the claim, two concurrent batches over ONE
  // pending episode produced two paid synthesis calls. `server.ts` starts a
  // worker per process and Deploy runs several isolates, so this is the default
  // production topology, and the only symptom was the invoice.
  const { ctx, stores } = await queuedMany(1);

  let paid = 0;
  const synth: Synthesizer = async () => {
    paid++;
    await new Promise((r) => setTimeout(r, 20));
    return fakeAudio();
  };

  const [a, b] = await Promise.all([
    runSynthesisBatch(ctx, synth, { owner: "worker-a" }),
    runSynthesisBatch(ctx, synth, { owner: "worker-b" }),
  ]);

  assertEquals(paid, 1, "the same episode must never be billed twice");
  assertEquals(a.ready.length + b.ready.length, 1);
  assertEquals(a.skipped.length + b.skipped.length, 1, "the loser reports a skip, not a failure");
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-0"))?.status, "ready");
});

Deno.test("an episode held by another worker is never touched or failed", async () => {
  // Two independent layers stop this, and the test distinguishes them because
  // conflating them once cost a confusing red test:
  //
  //  1. GATHER filters it out — the `pending` query cannot see a `synthesizing`
  //     episode, and the `synthesizing` query drops anything inside a live
  //     lease. So it is never even a candidate, and `skipped` stays empty.
  //  2. The CLAIM would refuse it anyway. That is the layer that matters when
  //     two workers gather simultaneously and both see `pending` — exercised by
  //     the racing test above, and by the conformance suite directly.
  //
  // What must be true either way: nothing is spent, and a live job is NOT
  // marked failed while another worker is successfully synthesising it.
  const { ctx, stores } = await queuedMany(1);
  await stores.metadata.claimEpisode("user-1", "ep-0", {
    owner: "other-worker",
    now: new Date().toISOString(),
    leaseMs: 60_000,
    maxClaims: 3,
  });

  let paid = 0;
  const run = await runSynthesisBatch(ctx, () => {
    paid++;
    return Promise.resolve(fakeAudio());
  });

  assertEquals(paid, 0, "a held episode must not be synthesised");
  assertEquals(run.failed, [], "another worker's live job must never be marked failed");
  assertEquals(run.considered, 0, "a live lease is filtered before it costs budget");

  // Still owned by the other worker, still in flight, attempt count untouched.
  const episode = await stores.metadata.getEpisode("user-1", "ep-0");
  assertEquals(episode?.status, "synthesizing");
  assertEquals(episode?.claimedBy, "other-worker");
  assertEquals(episode?.attempts, 1, "a refused claim must not consume an attempt");
});

Deno.test("a crashed worker's episode is reclaimed once its lease expires", async () => {
  // The kiq measurement: a crash between the `synthesizing` write and the
  // terminal write stranded the episode permanently, because the queue only
  // ever listed `pending`. Three recovery ticks found nothing.
  const { ctx, stores } = await queuedMany(1);

  // A worker claims it and dies: the claim is stale, the episode never finished.
  await stores.metadata.claimEpisode("user-1", "ep-0", {
    owner: "dead-worker",
    now: new Date(Date.now() - 20 * 60_000).toISOString(),
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-0"))?.status, "synthesizing");

  const run = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "live-worker",
  });

  assertEquals(run.ready.length, 1, "an expired claim must be recovered, not stranded");
  const episode = await stores.metadata.getEpisode("user-1", "ep-0");
  assertEquals(episode?.status, "ready");
  assertEquals(episode?.claimedBy, "live-worker");
});

Deno.test("an episode stranded before leases existed is still recoverable", async () => {
  // Records written by the pre-claim worker have `synthesizing` and no
  // `claimedAt`. Refusing to reclaim them would leave exactly the episodes this
  // change exists to rescue stuck forever.
  const { ctx, stores } = await queuedMany(1);
  const episode = await stores.metadata.getEpisode("user-1", "ep-0");
  await stores.metadata.putEpisode({ ...episode!, status: "synthesizing" });

  const run = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()));

  assertEquals(run.ready.length, 1, "a legacy stranded episode must be picked up");
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-0"))?.status, "ready");
});

Deno.test("an episode inside a live lease is left alone", async () => {
  // The other half of recovery: reclaiming too eagerly is just vfs again, since
  // the first worker is still spending.
  const { ctx, stores } = await queuedMany(1);
  await stores.metadata.claimEpisode("user-1", "ep-0", {
    owner: "busy-worker",
    now: new Date().toISOString(),
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });

  let paid = 0;
  const run = await runSynthesisBatch(ctx, () => {
    paid++;
    return Promise.resolve(fakeAudio());
  });

  assertEquals(paid, 0, "a live lease must not be stolen mid-synthesis");
  assertEquals(run.ready, []);
  assertEquals((await stores.metadata.getEpisode("user-1", "ep-0"))?.claimedBy, "busy-worker");
});

Deno.test("a superseded worker discards its result instead of overwriting the winner", async () => {
  const { ctx, stores } = await queuedMany(1);

  // This worker's lease expires while it is synthesising, and another worker
  // takes over and finishes first.
  const run = await runSynthesisBatch(ctx, async () => {
    const episode = await stores.metadata.getEpisode("user-1", "ep-0");
    await stores.metadata.completeEpisode(
      {
        ...episode!,
        status: "ready",
        audioKey: "winner.wav",
        contentType: "audio/wav",
        byteLength: 999,
      },
      episode!.claimedBy!,
    );
    // Now the original claim is gone; this worker's own write must be refused.
    await stores.metadata.putEpisode({
      ...(await stores.metadata.getEpisode("user-1", "ep-0"))!,
      status: "synthesizing",
      claimedBy: "someone-else",
      claimedAt: new Date().toISOString(),
    });
    return fakeAudio();
  }, { owner: "slow-worker" });

  assertEquals(run.ready, [], "a superseded worker must not report success");
  assertEquals(run.superseded.length, 1, "the discarded work must be reported, not swallowed");
  // And it must be reported with enough detail to tune the lease.
  const entry = run.superseded[0]!;
  assert(entry.leaseMs > 0, "the lease in force must be reported");
  assert(entry.heldMs >= 0, "how long the claim was held must be reported");
});

Deno.test("a job that keeps crashing is abandoned rather than re-billed forever", async () => {
  // Lease recovery without a bound is perpetual motion for a poison input:
  // crash, expire, reclaim, crash, bill again. The counter is persisted because
  // an in-process one dies with the process it was counting.
  const { ctx, stores } = await queuedMany(1);

  let paid = 0;
  for (let tick = 1; tick <= 5; tick++) {
    await runSynthesisBatch(ctx, async () => {
      paid++;
      // "Crash": the claim is taken, the money is spent, nothing terminal is
      // written, and the lease is left to expire.
      const episode = await stores.metadata.getEpisode("user-1", "ep-0");
      await stores.metadata.putEpisode({
        ...episode!,
        claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      });
      throw new Error("isolate died");
    }, { maxAttempts: 1, maxClaims: 3, retryBaseDelayMs: 1 });
  }

  assert(paid <= 3, `a poison job must stop being billed, got ${paid} charges`);
  const episode = await stores.metadata.getEpisode("user-1", "ep-0");
  assertEquals(episode?.status, "failed", "an exhausted job must be visibly abandoned");
});

Deno.test("article content exceeding maxInputCharacters fails closed without spending (audio-feed-3hb)", async () => {
  const { ctx, stores } = await queued();
  // Article with 1,000 chars, limit set to 500
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      content: "A".repeat(1000),
    }),
  );

  let synthesized = false;
  const synth: Synthesizer = () => {
    synthesized = true;
    return Promise.resolve(fakeAudio());
  };

  const result = await runSynthesisBatch(ctx, synth, { maxInputCharacters: 500 });
  assertEquals(synthesized, false, "must fail closed before calling synthesis");
  assertEquals(result.failed.length, 1);
  assertStringIncludes(result.failed[0]!.error, "article content exceeds input limit");
  assertEquals(result.ready.length, 0);

  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(episode?.status, "failed");
  assertStringIncludes(episode?.error ?? "", "1000 > 500 chars");
});

Deno.test("synthesised audio blob key is the canonical scoping plus a per-attempt revision (audio-feed-3hb, -xsu)", async () => {
  const { ctx, stores } = await queued();
  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()));
  assertEquals(result.ready.length, 1);
  const canonical = audioBlobKey({ userId: "user-1", id: "episode-1", mode: "direct" }, "wav");
  assertEquals(canonical, "audio/user-1/direct/episode-1.wav");
  const audioKey = result.ready[0]!.audioKey!;
  // Same user/mode/name directory scoping, with the attempt's revision attached:
  // the bare canonical path is never written by a synthesis (audio-feed-xsu).
  assertEquals(
    audioKey.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/, ".wav"),
    canonical,
  );
  assert(audioKey !== canonical);
  assert(await stores.blobs.get(audioKey));
  assert(await stores.blobs.get(canonical) === null, "the bare canonical key stays unwritten");
});

Deno.test("a superseded FIRST synthesis deletes only its own blob — the winner's audio still fetches (audio-feed-xsu)", async () => {
  const { ctx, stores } = await queuedMany(1);
  const episode = await stores.metadata.getEpisode("user-1", "ep-0");
  // The winner ran first and its audio lives under the key a first synthesis used
  // to treat as its own: the deterministic, revision-less canonical key.
  const canonical = audioBlobKey(episode!, "wav");

  const run = await runSynthesisBatch(ctx, async () => {
    const current = await stores.metadata.getEpisode("user-1", "ep-0");
    // The winner is a real worker: it PUT its bytes, then committed the metadata.
    await stores.blobs.put(canonical, new Uint8Array(999).fill(7), { contentType: "audio/wav" });
    await stores.metadata.completeEpisode(
      {
        ...current!,
        status: "ready",
        audioKey: canonical,
        contentType: "audio/wav",
        byteLength: 999,
      },
      current!.claimedBy!,
    );
    // The winner's commit took the claim; this worker's own write must be refused.
    await stores.metadata.putEpisode({
      ...(await stores.metadata.getEpisode("user-1", "ep-0"))!,
      status: "synthesizing",
      claimedBy: "someone-else",
      claimedAt: new Date().toISOString(),
    });
    return fakeAudio();
  }, { owner: "slow-worker" });

  assertEquals(run.ready, [], "a superseded worker must not report success");
  assertEquals(run.superseded.length, 1);
  // THE ACCEPTANCE: the winner's enclosure still fetches afterwards. Before the
  // fix both workers wrote the canonical key and the loser's cleanup deleted the
  // winner's audio with it.
  const winnerBlob = await stores.blobs.get(canonical);
  assert(winnerBlob, "the winner's audio must still be in the blob store");
  assertEquals(winnerBlob.size, 999);
  // And the loser's own blob (a distinct, revisioned key) is what got cleaned up.
  const episodeAfter = await stores.metadata.getEpisode("user-1", "ep-0");
  assertEquals(episodeAfter?.audioKey, canonical, "the feed still points at the winner's audio");
});

Deno.test("a superseded worker whose cleanup delete fails records the orphan (audio-feed-owq)", async () => {
  const { ctx, stores } = await queuedMany(1);
  const episode = await stores.metadata.getEpisode("user-1", "ep-0");
  const canonical = audioBlobKey(episode!, "wav");

  // Every delete in this batch fails: the superseded worker's cleanup cannot
  // remove its blob, and the failure must be recorded, not swallowed.
  stores.blobs.delete = (_key: string) => Promise.reject(new Error("delete exploded"));

  const run = await runSynthesisBatch(ctx, async () => {
    const current = await stores.metadata.getEpisode("user-1", "ep-0");
    await stores.metadata.completeEpisode(
      {
        ...current!,
        status: "ready",
        audioKey: canonical,
        contentType: "audio/wav",
        byteLength: 999,
      },
      current!.claimedBy!,
    );
    await stores.metadata.putEpisode({
      ...(await stores.metadata.getEpisode("user-1", "ep-0"))!,
      status: "synthesizing",
      claimedBy: "someone-else",
      claimedAt: new Date().toISOString(),
    });
    return fakeAudio();
  }, { owner: "slow-worker" });

  assertEquals(run.superseded.length, 1);
  const orphans = await stores.metadata.listOrphanBlobs(100);
  assert(
    orphans.length >= 1,
    `a failed cleanup must land on the orphan list, got ${JSON.stringify(orphans)}`,
  );
  // The recorded key is the superseded worker's OWN blob, never the winner's.
  assert(
    orphans.every((key) => key !== canonical),
    `the winner's key must never be orphan-recorded, got ${JSON.stringify(orphans)}`,
  );
});

// ---------------------------------------------------------------------------
// audio-feed-15e — a regeneration must not jump the queue in front of new work
// ---------------------------------------------------------------------------

/**
 * The pending index is keyed by `createdAt`, and a requeued episode keeps its original
 * `createdAt` (correctly — it is the episode's date for the feed and for the player). The
 * consequence is that a "Regenerate all" after a prompt change puts every re-render ahead of
 * anything ingested afterwards, because the old episodes are all older. The subscriber's newest
 * article waits behind the entire backlog of work they asked for on episodes they can already hear.
 */
async function queuedBacklogWithNewArrival(regenerations: number) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "article-1", userId: "user-1", sourceId: "inbox" }),
  );
  // Six OLD ready episodes, then each is requeued — the real regenerate path, so the
  // `regenerating` flag and the original createdAt are set by production code, not by me.
  for (let i = 0; i < regenerations; i++) {
    await stores.metadata.putEpisode(makeEpisode({
      id: `regen-${i}`,
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "ready",
      audioKey: `audio/user-1/direct/regen-${i}.wav`,
      createdAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    }));
    await stores.metadata.requeueEpisode("user-1", `regen-${i}`);
  }
  // One genuinely new article, queued AFTER all of them.
  await stores.metadata.putArticle(
    makeArticle({ id: "article-new", userId: "user-1", sourceId: "inbox" }),
  );
  await stores.metadata.putEpisode(makeEpisode({
    id: "episode-new",
    userId: "user-1",
    sourceId: "inbox",
    articleId: "article-new",
    status: "pending",
    audioKey: undefined,
    createdAt: new Date(Date.UTC(2026, 8, 20)).toISOString(),
  }));
  return { ctx: { config, stores }, stores };
}

Deno.test("a newly ingested article is synthesised ahead of a backlog of regenerations (audio-feed-15e)", async () => {
  const { ctx } = await queuedBacklogWithNewArrival(6);
  const order: string[] = [];
  await runSynthesisBatch(ctx, ({ episode }) => {
    order.push(episode.id);
    return Promise.resolve(fakeAudio());
  }, { batchSize: 5 });

  assert(
    order.includes("episode-new"),
    `the new article must be served in this tick, not wait behind 6 re-renders; batch was [${order}]`,
  );
  assertEquals(order[0], "episode-new", "new work goes first within the batch");
});

Deno.test("regenerations still run when there is no new work (audio-feed-15e)", async () => {
  const { ctx } = await queuedBacklogWithNewArrival(6);
  // Remove the new arrival: the lane must not starve the backlog.
  const backlogOnly = await ctx.stores.metadata.getEpisode("user-1", "episode-new");
  assert(backlogOnly, "fixture: the new episode exists");
  await ctx.stores.metadata.deleteEpisode("user-1", "episode-new");

  const order: string[] = [];
  await runSynthesisBatch(ctx, ({ episode }) => {
    order.push(episode.id);
    return Promise.resolve(fakeAudio());
  }, { batchSize: 5 });

  assertEquals(order.length, 5, "with nothing new queued, regenerations fill the batch");
  assert(
    order.every((id) => id.startsWith("regen-")),
    `only regenerations should run; got [${order}]`,
  );
});

Deno.test("a regeneration keeps its date in the feed while it waits behind new work (audio-feed-15e)", async () => {
  const { stores } = await queuedBacklogWithNewArrival(2);
  const episode = await stores.metadata.getEpisode("user-1", "regen-0");
  assertEquals(
    episode?.createdAt,
    new Date(Date.UTC(2026, 8, 1)).toISOString(),
    "queue priority must not be smuggled in by re-dating the episode — createdAt is the episode's date",
  );
  assertEquals(episode?.regenerating, true);
});

// ---------------------------------------------------------------------------
// audio-feed-9mp: spend visibility & per-user daily episode budget
// ---------------------------------------------------------------------------

Deno.test("daily episode budget: user at budget has new episodes deferred with reason naming budget (audio-feed-9mp)", async () => {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "budget-user", status: "approved", dailyEpisodeBudget: 2 }),
  );
  await stores.metadata.putSource(makeSource({ id: "src", userId: "budget-user" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "art", userId: "budget-user", sourceId: "src" }),
  );
  for (let i = 0; i < 3; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-${i}`,
        userId: "budget-user",
        sourceId: "src",
        articleId: "art",
        status: "pending",
      }),
    );
  }
  const ctx = { config, stores };

  let synthesized = 0;
  const run = await runSynthesisBatch(ctx, () => {
    synthesized++;
    return Promise.resolve(fakeAudio());
  }, { batchSize: 5 });

  assertEquals(synthesized, 2, "exactly 2 episodes synthesized up to the budget");
  assertEquals(run.ready.length, 2);
  assertEquals(run.deferred.length, 1);
  assertStringIncludes(
    run.deferred[0]!.reason,
    "daily episode budget exceeded (limit: 2, used: 2)",
  );

  // The 3rd episode was NOT billed and remains pending
  const ep2 = await stores.metadata.getEpisode("budget-user", "ep-2");
  assertEquals(ep2?.status, "pending");
});

Deno.test("daily episode budget: resets on next UTC day and synthesizes previously deferred episode (audio-feed-9mp)", async () => {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "budget-user", status: "approved", dailyEpisodeBudget: 1 }),
  );
  await stores.metadata.putSource(makeSource({ id: "src", userId: "budget-user" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "art", userId: "budget-user", sourceId: "src" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-0",
      userId: "budget-user",
      sourceId: "src",
      articleId: "art",
      status: "pending",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-1",
      userId: "budget-user",
      sourceId: "src",
      articleId: "art",
      status: "pending",
    }),
  );
  const ctx = { config, stores };

  // Day 1: 2026-09-27T10:00:00.000Z
  const day1Ms = Date.parse("2026-09-27T10:00:00.000Z");
  const runDay1 = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    batchSize: 5,
    nowMs: day1Ms,
  });
  assertEquals(runDay1.ready.length, 1);
  assertEquals(runDay1.deferred.length, 1);

  // Day 2: 2026-09-28T00:00:05.000Z (after UTC midnight reset)
  const day2Ms = Date.parse("2026-09-28T00:00:05.000Z");
  const runDay2 = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    batchSize: 5,
    nowMs: day2Ms,
  });
  assertEquals(runDay2.ready.length, 1, "deferred episode picked up automatically on next UTC day");
  assertEquals(runDay2.deferred.length, 0);

  const ep1 = await stores.metadata.getEpisode("budget-user", "ep-1");
  assertEquals(ep1?.status, "ready");
});

Deno.test("daily episode budget: default undefined budget allows unlimited synthesis (audio-feed-9mp)", async () => {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "unlimited-user", status: "approved", dailyEpisodeBudget: undefined }),
  );
  await stores.metadata.putSource(makeSource({ id: "src", userId: "unlimited-user" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "art", userId: "unlimited-user", sourceId: "src" }),
  );
  for (let i = 0; i < 4; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-${i}`,
        userId: "unlimited-user",
        sourceId: "src",
        articleId: "art",
        status: "pending",
      }),
    );
  }
  const ctx = { config, stores };

  let count = 0;
  const run = await runSynthesisBatch(ctx, () => {
    count++;
    return Promise.resolve(fakeAudio());
  }, { batchSize: 5 });

  assertEquals(count, 4, "all 4 episodes synthesized with no budget ceiling");
  assertEquals(run.ready.length, 4);
  assertEquals(run.deferred.length, 0);
});

Deno.test("daily episode budget: unapproved or suspended user is still deferred with 'not authorized' (audio-feed-9mp)", async () => {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "suspended-user", status: "suspended", dailyEpisodeBudget: 10 }),
  );
  await stores.metadata.putSource(makeSource({ id: "src", userId: "suspended-user" }));
  await stores.metadata.putArticle(
    makeArticle({ id: "art", userId: "suspended-user", sourceId: "src" }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-0",
      userId: "suspended-user",
      sourceId: "src",
      articleId: "art",
      status: "pending",
    }),
  );
  const ctx = { config, stores };

  const run = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), { batchSize: 5 });
  assertEquals(run.ready.length, 0);
  assertEquals(run.deferred.length, 1);
  assertEquals(run.deferred[0]!.reason, "not authorized");
});
