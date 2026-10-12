/**
 * Tests for audio-feed-siv1:
 * - A claim dying before its terminal write leaves a recorded cause with phase, heartbeat, and attempt history.
 * - Abandonment after maxClaims persists why (reason + phase + attempt count) rather than "no claim recorded a cause".
 * - Resumption in deepdive mode preserves script turns so segment hashes match and retry resumes rather than restarts
 *   (both across separate claims and within the same claim's retry loop).
 * - completeEpisode is idempotent for the same owner and audio key, but rejects other callers.
 * - Cached script turns are cleared when an episode completes or is requeued for regeneration.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { decodedFromWav, GeminiTtsClient, pcmToWav } from "../src/tts/gemini.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import {
  isInvocationBudgetAbort,
  runManagedTurns,
  SynthesisYieldError,
  withInvocationBudget,
} from "../src/synthesis/limits.ts";

Deno.test("audio-feed-o74y/a7i9: a REJECTED billing write must not mark the episode ready", async () => {
  // The acceptance for audio-feed-o74y: reverting the a7i9 fix (replacing the awaited billing write with
  // `.catch(() => {})`) must FAIL this case. The trigger is an ASYNCHRONOUS rejection from the billing write,
  // because that is the shape a swallow catches - a synchronous throw from a malformed timestamp still
  // rejects, which is why the conformance case for that payload cannot pin this fix.
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "e1",
    userId: "user-1",
    sourceId: "inbox",
    status: "synthesizing",
    claimedBy: "worker-a",
  }));

  const store = stores.metadata;
  const original = store.recordSynthesis.bind(store);
  let calls = 0;
  store.recordSynthesis = () => {
    calls++;
    return Promise.reject(new Error("billing store is down"));
  };

  const billing = { byteLength: 500 };
  const ready = {
    ...(await store.getEpisode("user-1", "e1"))!,
    status: "ready" as const,
    audioKey: "e1.wav",
    contentType: "audio/wav",
  };
  try {
    let threw = false;
    try {
      await store.completeEpisode(ready, "worker-a", billing);
    } catch {
      threw = true;
    }
    assertEquals(
      calls,
      1,
      "the billing write must be ATTEMPTED before the episode is marked ready",
    );
    assertEquals(
      threw,
      true,
      "a completion whose billing write rejected must reject, not return true",
    );
    assertEquals(
      (await store.getEpisode("user-1", "e1"))?.status,
      "synthesizing",
      "an episode must NOT be marked ready when its billing was not recorded",
    );
  } finally {
    store.recordSynthesis = original;
  }

  // Anti-vacuity: with the billing write working again the SAME completion succeeds - otherwise the
  // assertions above would pass against a store that simply refuses every completion.
  const wrote = await store.completeEpisode(ready, "worker-a", billing);
  assertEquals(wrote, true);
  assertEquals((await store.getEpisode("user-1", "e1"))?.status, "ready");
});

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

function fakeAudio(durationSeconds = 10): DecodedAudioResult {
  const pcm = new Uint8Array(64);
  const wav = pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
  return {
    ...decodedFromWav(wav),
    durationSeconds,
  };
}

async function setupEnv() {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "inbox",
      content: "First paragraph. Second paragraph. Third paragraph.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "pending",
      mode: "direct",
    }),
  );
  const ctx = { config, stores };
  return { ctx, stores };
}

Deno.test("audio-feed-siv1: claim dying before terminal write persists phase, reason, and attempt count across retries and abandonment", async () => {
  const { stores } = await setupEnv();

  // Attempt 1: Worker 1 claims, touches progress up to segment 1, then isolate is killed mid-synthesis (no completeEpisode!)
  const claim1 = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-1",
    now: "2026-10-11T14:00:00.000Z",
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claim1);
  await stores.metadata.touchEpisodeClaim("user-1", "episode-1", "worker-1", {
    phase: "synthesizing_segment_1_of_4",
    now: "2026-10-11T14:02:00.000Z",
  });
  // Simulate isolate death: worker vanishes without calling completeEpisode.

  // Attempt 2: 15 minutes later, Worker 2 claims expired claim
  const claim2 = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-2",
    now: "2026-10-11T14:15:00.000Z",
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claim2);
  assertEquals(claim2.attempts, 2);
  // Verify that attempt 1's expiry and phase are preserved in the episode's error record
  assert(claim2.error?.includes("worker-1"));
  assert(claim2.error?.includes("synthesizing_segment_1_of_4"));
  assert(claim2.error?.includes("lease expired without terminal write"));
  assert(!claim2.error?.includes("died"));

  // Worker 2 advances to segment 3, then isolate is killed again
  await stores.metadata.touchEpisodeClaim("user-1", "episode-1", "worker-2", {
    phase: "synthesizing_segment_3_of_4",
    now: "2026-10-11T14:18:00.000Z",
  });

  // Attempt 3: 15 minutes later, Worker 3 claims expired claim
  const claim3 = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-3",
    now: "2026-10-11T14:30:00.000Z",
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claim3);
  assertEquals(claim3.attempts, 3);
  assert(claim3.error?.includes("worker-1"));
  assert(claim3.error?.includes("worker-2"));
  assert(claim3.error?.includes("synthesizing_segment_3_of_4"));
  assert(claim3.error?.includes("lease expired without terminal write"));

  // Worker 3 advances to uploading_audio, then isolate dies
  await stores.metadata.touchEpisodeClaim("user-1", "episode-1", "worker-3", {
    phase: "uploading_audio",
    now: "2026-10-11T14:32:00.000Z",
  });

  // Attempt 4: 15 minutes later, lease expired and attempts > maxClaims (3)
  const claim4 = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-4",
    now: "2026-10-11T14:45:00.000Z",
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assertEquals(claim4, null, "4th claim must be refused and abandoned");

  // Inspect the abandoned episode
  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  assert(episode);
  assertEquals(episode.status, "failed");
  assertEquals(episode.phase, "uploading_audio");
  assertEquals(episode.lastHeartbeat, "2026-10-11T14:32:00.000Z");

  // Must persist WHY: reason + phase + attempt count
  const error = episode.error ?? "";
  assertStringIncludes(error, "abandoned after 3 attempts");
  assertStringIncludes(error, "claim lease expired without terminal write");
  assertStringIncludes(error, 'in phase "uploading_audio"');
  assertStringIncludes(error, "synthesizing_segment_1_of_4");
  assertStringIncludes(error, "synthesizing_segment_3_of_4");
  assertStringIncludes(error, "worker-1");
  assertStringIncludes(error, "worker-2");
  assertStringIncludes(error, "worker-3");
  assert(!error.includes("died"), "must never assert death when only lease expired");
  assert(
    !error.includes("no claim recorded a cause"),
    "must never report 'no claim recorded a cause'",
  );
});

Deno.test("audio-feed-kd5r: live heartbeat near lease expiry is reported as lease expiry, not worker death", async () => {
  const { stores } = await setupEnv();

  // Claim at 14:00:00Z with 15-minute lease (900000ms)
  const claim1 = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-live",
    now: "2026-10-11T14:00:00.000Z",
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claim1);

  // Active heartbeat 1 second before lease expiry at 14:14:59Z
  const touched = await stores.metadata.touchEpisodeClaim("user-1", "episode-1", "worker-live", {
    phase: "synthesizing_segment_2_of_4",
    now: "2026-10-11T14:14:59.000Z",
  });
  assertEquals(touched, true, "live worker successfully heartbeats before expiry");

  // At 14:15:00Z, lease expires and another worker claims
  const claim2 = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-other",
    now: "2026-10-11T14:15:00.000Z",
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claim2);
  assertEquals(claim2.attempts, 2);

  // Assert recorded cause reports observed facts: lease expiry, last heartbeat, last phase
  // MUST NOT assert death
  const err = claim2.error ?? "";
  assertStringIncludes(err, "lease expired without terminal write");
  assertStringIncludes(err, 'phase "synthesizing_segment_2_of_4"');
  assertStringIncludes(err, "last heartbeat 2026-10-11T14:14:59.000Z");
  assertStringIncludes(err, "worker state unknown");
  assert(!err.includes("died"), "must not assert worker death for active heartbeat");
});

Deno.test("audio-feed-siv1: deepdive mode persists scriptTurns so retries resume without regenerating script (across claims and within claim)", async () => {
  const { ctx, stores } = await setupEnv();

  // Create deepdive episode
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-deepdive",
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "pending",
      mode: "deepdive",
    }),
  );

  let scriptCalls = 0;
  const mockScriptGenerator = () => {
    scriptCalls++;
    return Promise.resolve({
      turns: [
        { speaker: "Alex", text: "Welcome to deep dive." },
        { speaker: "Sam", text: "Glad to be here." },
      ],
      sources: [],
      counterarguments: [],
      researchSummary: "",
    });
  };

  let clientDialogueCalls = 0;
  const mockClient = new GeminiTtsClient({
    apiKey: "dummy-key",
  });
  mockClient.synthesizeDialogue = () => {
    clientDialogueCalls++;
    return Promise.resolve(fakeAudio());
  };
  mockClient.synthesizeNarration = () => Promise.resolve(fakeAudio());

  // Attempt 1: Worker 1 claims ep-deepdive
  const claim1 = await stores.metadata.claimEpisode("user-1", "ep-deepdive", {
    owner: "worker-1",
    now: new Date().toISOString(),
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claim1);

  const synthWorker1 = createGeminiSynthesizer(ctx, {
    scriptGenerator: mockScriptGenerator,
    client: mockClient,
  });

  const article = (await stores.metadata.getArticle("user-1", "article-1"))!;
  const source = await stores.metadata.getSource("user-1", "inbox");

  // Worker 1 runs synthesis, which generates the script and persists scriptTurns:
  await synthWorker1({
    article,
    source,
    episode: claim1,
    mode: "deepdive",
    leaseMs: 15 * 60_000,
  });

  assertEquals(scriptCalls, 1, "script generator should be called on first attempt");
  assertEquals(clientDialogueCalls, 1, "client synthesizeDialogue should be called");

  const stored1 = await stores.metadata.getEpisode("user-1", "ep-deepdive");
  assert(stored1);
  assert(stored1.scriptTurns);
  assertEquals(stored1.scriptTurns.length, 2);
  assertEquals(stored1.scriptTurns[0]?.speaker, "Alex");

  // Simulate lease expiry so episode can be retried by Worker 2
  await stores.metadata.putEpisode({
    ...stored1,
    claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  });

  // Attempt 2: Worker 2 claims the expired claim
  const claim2 = await stores.metadata.claimEpisode("user-1", "ep-deepdive", {
    owner: "worker-2",
    now: new Date().toISOString(),
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claim2);
  assertEquals(claim2.scriptTurns?.length, 2, "reclaimed episode retains persisted scriptTurns");

  const synthWorker2 = createGeminiSynthesizer(ctx, {
    scriptGenerator: mockScriptGenerator,
    client: mockClient,
  });

  // Worker 2 synthesizes
  await synthWorker2({
    article,
    source,
    episode: claim2,
    mode: "deepdive",
    leaseMs: 15 * 60_000,
  });

  assertEquals(
    scriptCalls,
    1,
    "script generator must NOT be called again — script turns were reused across claims",
  );
  assertEquals(clientDialogueCalls, 2);

  // Now test retry within the SAME claim:
  let inClaimTtsCalls = 0;
  mockClient.synthesizeDialogue = () => {
    inClaimTtsCalls++;
    if (inClaimTtsCalls === 1) {
      // First attempt fails transiently
      throw new Error("transient network blip");
    }
    return Promise.resolve(fakeAudio());
  };

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-deepdive-retry",
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "pending",
      mode: "deepdive",
    }),
  );

  const retrySynth = createGeminiSynthesizer(ctx, {
    scriptGenerator: mockScriptGenerator,
    client: mockClient,
  });

  const res = await runSynthesisBatch(ctx, retrySynth, {
    owner: "worker-batch-retry",
    maxAttempts: 2,
    retryBaseDelayMs: 1,
  });

  // ep-deepdive-retry should succeed on attempt 2
  const readyBatchEp = res.ready.find((r) => r.episodeId === "ep-deepdive-retry");
  assert(readyBatchEp, "episode should be ready after in-claim retry");
  // scriptCalls was 1 from before, now 2 from first attempt of ep-deepdive-retry, and NOT 3 on attempt 2!
  assertEquals(
    scriptCalls,
    2,
    "script generator was called once for ep-deepdive-retry and reused on in-claim retry",
  );
  assertEquals(inClaimTtsCalls, 2, "TTS was called twice (initial blip + successful retry)");

  // Verify ready record clears scriptTurns so it does not leak into future regenerations
  const completed = await stores.metadata.getEpisode("user-1", "ep-deepdive-retry");
  assertEquals(completed?.status, "ready");
  assertEquals(completed?.scriptTurns, undefined, "completed episode clears scriptTurns");

  // Requeueing for regeneration also keeps scriptTurns undefined
  const requeued = await stores.metadata.requeueEpisode("user-1", "ep-deepdive-retry");
  assertEquals(requeued?.status, "pending");
  assertEquals(requeued?.scriptTurns, undefined, "requeued episode has no stale scriptTurns");

  // Cancelling regeneration or failing back to ready also clears scriptTurns
  await stores.metadata.touchEpisodeClaim("user-1", "ep-deepdive-retry", "worker-batch-retry", {
    scriptTurns: [{ speaker: "Alex", text: "temp" }],
  });
  await stores.metadata.cancelRegeneration("user-1", "ep-deepdive-retry");
  const cancelled = await stores.metadata.getEpisode("user-1", "ep-deepdive-retry");
  assertEquals(cancelled?.status, "ready");
  assertEquals(cancelled?.scriptTurns, undefined, "cancelled regeneration clears scriptTurns");
});

Deno.test("audio-feed-siv1: completeEpisode is idempotent for the same owner and audio key, but rejects other callers", async () => {
  const { stores } = await setupEnv();

  const claimed = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-idempotent",
    now: new Date().toISOString(),
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claimed);

  const readyEpisode = {
    ...claimed,
    status: "ready" as const,
    audioKey: "audio/user-1/direct/episode-1.wav",
    byteLength: 1234,
    contentType: "audio/wav",
  };

  const write1 = await stores.metadata.completeEpisode(
    readyEpisode,
    "worker-idempotent",
    { byteLength: 1234 },
  );
  assertEquals(write1, true);

  // Second identical call by the SAME worker
  const write2 = await stores.metadata.completeEpisode(
    readyEpisode,
    "worker-idempotent",
    { byteLength: 1234 },
  );
  assertEquals(
    write2,
    true,
    "second identical completion by same owner must return true (idempotent)",
  );

  // Another worker attempting completion must be refused
  const writeOther = await stores.metadata.completeEpisode(
    readyEpisode,
    "worker-other",
    { byteLength: 1234 },
  );
  assertEquals(writeOther, false, "completion by another worker must return false (superseded)");

  // Different audio key by original worker must be refused
  const write3 = await stores.metadata.completeEpisode(
    { ...readyEpisode, audioKey: "audio/user-1/direct/episode-different.wav" },
    "worker-idempotent",
    { byteLength: 1234 },
  );
  assertEquals(write3, false, "completion with different audio key must return false");
});

Deno.test("audio-feed-2m5z: (a) rejecting checkpoint at script_generated fails visibly and does not call TTS", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");
  let scriptCalls = 0;
  let dialogueCalls = 0;

  const mockScriptGenerator = () => {
    scriptCalls++;
    return Promise.resolve({
      turns: [
        { speaker: "Alex", text: "Turn 1" },
        { speaker: "Sam", text: "Turn 2" },
      ],
      sources: [],
      counterarguments: [],
      researchSummary: "",
    });
  };

  const mockClient = new GeminiTtsClient({
    apiKey: "dummy-key",
  });
  mockClient.synthesizeDialogue = () => {
    dialogueCalls++;
    return Promise.resolve(fakeAudio());
  };

  // Intercept touchEpisodeClaim on metadata store to reject at script_generated
  const origTouch = stores.metadata.touchEpisodeClaim.bind(stores.metadata);
  stores.metadata.touchEpisodeClaim = (userId, episodeId, owner, update) => {
    if (update.phase === "script_generated") {
      return Promise.reject(new Error("KV store write failed"));
    }
    return origTouch(userId, episodeId, owner, update);
  };

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-reject-test",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      mode: "deepdive",
      status: "pending",
    }),
  );

  const synth = createGeminiSynthesizer(ctx, {
    scriptGenerator: mockScriptGenerator,
    client: mockClient,
  });

  const batch = await runSynthesisBatch(ctx, synth, {
    owner: "worker-reject",
    maxClaims: 3,
    maxAttempts: 1,
  });

  assertEquals(scriptCalls, 1, "script generator was called");
  assertEquals(dialogueCalls, 0, "TTS MUST NOT be called when checkpoint write rejects");
  assertEquals(batch.failed.length, 1, "batch reports failure");
  const failedError = batch.failed[0]?.error ?? "";
  assertStringIncludes(
    failedError,
    'claim checkpoint failed at phase "script_generated"',
  );
  assertStringIncludes(failedError, "KV store write failed");

  // In-memory scriptTurns must not have leaked into stored episode
  const ep = await stores.metadata.getEpisode("user-1", "ep-reject-test");
  assertEquals(
    ep?.scriptTurns,
    undefined,
    "failed checkpoint must not leave scriptTurns persisted",
  );
});

Deno.test("audio-feed-2m5z: (b) false-returning (lost ownership) checkpoint at script_generated aborts claim and does not call TTS", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");
  let scriptCalls = 0;
  let dialogueCalls = 0;

  const mockScriptGenerator = () => {
    scriptCalls++;
    return Promise.resolve({
      turns: [
        { speaker: "Alex", text: "Turn 1" },
        { speaker: "Sam", text: "Turn 2" },
      ],
      sources: [],
      counterarguments: [],
      researchSummary: "",
    });
  };

  const mockClient = new GeminiTtsClient({
    apiKey: "dummy-key",
  });
  mockClient.synthesizeDialogue = () => {
    dialogueCalls++;
    return Promise.resolve(fakeAudio());
  };

  // Intercept touchEpisodeClaim to simulate lost ownership (returns false) at script_generated
  const origTouch = stores.metadata.touchEpisodeClaim.bind(stores.metadata);
  stores.metadata.touchEpisodeClaim = (userId, episodeId, owner, update) => {
    if (update.phase === "script_generated") {
      return Promise.resolve(false);
    }
    return origTouch(userId, episodeId, owner, update);
  };

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-lost-test",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      mode: "deepdive",
      status: "pending",
    }),
  );

  const synth = createGeminiSynthesizer(ctx, {
    scriptGenerator: mockScriptGenerator,
    client: mockClient,
  });

  const batch = await runSynthesisBatch(ctx, synth, {
    owner: "worker-lost",
    maxClaims: 3,
    maxAttempts: 1,
  });

  assertEquals(scriptCalls, 1, "script generator was called");
  assertEquals(dialogueCalls, 0, "TTS MUST NOT be called when ownership is lost at checkpoint");
  assertEquals(batch.superseded.length, 1, "batch reports superseded");
  assertEquals(batch.superseded[0]?.episodeId, "ep-lost-test");
});

Deno.test("audio-feed-2m5z: (c) good checkpoint at script_generated still proceeds to TTS", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");
  let scriptCalls = 0;
  let dialogueCalls = 0;

  const mockScriptGenerator = () => {
    scriptCalls++;
    return Promise.resolve({
      turns: [
        { speaker: "Alex", text: "Turn 1" },
        { speaker: "Sam", text: "Turn 2" },
      ],
      sources: [],
      counterarguments: [],
      researchSummary: "",
    });
  };

  const mockClient = new GeminiTtsClient({
    apiKey: "dummy-key",
  });
  mockClient.synthesizeDialogue = () => {
    dialogueCalls++;
    return Promise.resolve(fakeAudio());
  };

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-good-test",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      mode: "deepdive",
      status: "pending",
    }),
  );

  const synth = createGeminiSynthesizer(ctx, {
    scriptGenerator: mockScriptGenerator,
    client: mockClient,
  });

  const batch = await runSynthesisBatch(ctx, synth, {
    owner: "worker-good",
    maxClaims: 3,
    maxAttempts: 1,
  });

  assertEquals(scriptCalls, 1, "script generator was called");
  assertEquals(dialogueCalls, 1, "TTS was called after successful checkpoint");
  assertEquals(batch.ready.length, 1, "batch completed successfully");
});

Deno.test("audio-feed-vqu4: long synthesis completes across multiple bounded ticks with no lost stage or duplicate spend", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  let scriptCalls = 0;
  const textChunk = (id: number) => `Segment ${id} `.repeat(500);
  const mockScriptGenerator = () => {
    scriptCalls++;
    return Promise.resolve({
      turns: [
        { speaker: "Alex", text: textChunk(1) },
        { speaker: "Sam", text: textChunk(2) },
        { speaker: "Alex", text: textChunk(3) },
        { speaker: "Sam", text: textChunk(4) },
        { speaker: "Alex", text: textChunk(5) },
        { speaker: "Sam", text: textChunk(6) },
      ],
      sources: [],
      counterarguments: [],
      researchSummary: "",
    });
  };

  let dialogueCalls = 0;
  const mockClient = new GeminiTtsClient({
    apiKey: "dummy-key",
  });
  // Mock sendRequest so real synthesizeDialogue runs through batching and runManagedTurns
  mockClient.sendRequest = () => {
    dialogueCalls++;
    return Promise.resolve(fakeAudio());
  };

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-multi-tick",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      mode: "deepdive",
      status: "pending",
    }),
  );

  const synth = createGeminiSynthesizer(ctx, {
    scriptGenerator: mockScriptGenerator,
    client: mockClient,
  });

  // --- TICK 1: budget of 2 segments per invocation ---
  const batch1 = await runSynthesisBatch(ctx, synth, {
    owner: "worker-tick-1",
    maxClaims: 3,
    maxSegmentsPerInvocation: 2,
  });

  assertEquals(batch1.ready.length, 0, "tick 1 should not complete episode");
  assertEquals(batch1.yielded.length, 1, "tick 1 should yield");
  assertEquals(batch1.yielded[0]?.episodeId, "ep-multi-tick");
  assertEquals(batch1.yielded[0]?.completedTurns, 2);
  assertEquals(batch1.yielded[0]?.totalTurns, 6);
  assertEquals(scriptCalls, 1, "script generated in tick 1");
  assertEquals(dialogueCalls, 2, "2 segments synthesized in tick 1");

  const epAfterTick1 = await stores.metadata.getEpisode("user-1", "ep-multi-tick");
  assert(epAfterTick1);
  assertEquals(epAfterTick1.status, "pending", "status returned to pending for next tick");
  assertEquals(epAfterTick1.phase, "synthesized_2_of_6");
  assertEquals(epAfterTick1.attempts, 0, "attempts reset to 0 after clean yield");
  assert(epAfterTick1.scriptTurns, "scriptTurns preserved across ticks");

  // --- TICK 2: next cron tick resumes, does 2 more segments ---
  const batch2 = await runSynthesisBatch(ctx, synth, {
    owner: "worker-tick-2",
    maxClaims: 3,
    maxSegmentsPerInvocation: 2,
  });

  assertEquals(batch2.ready.length, 0, "tick 2 should not complete episode");
  assertEquals(batch2.yielded.length, 1, "tick 2 should yield");
  assertEquals(batch2.yielded[0]?.completedTurns, 4);
  assertEquals(scriptCalls, 1, "script was NOT re-generated in tick 2 (reused!)");
  assertEquals(dialogueCalls, 4, "total 4 segments synthesized across ticks 1 & 2");

  const epAfterTick2 = await stores.metadata.getEpisode("user-1", "ep-multi-tick");
  assert(epAfterTick2);
  assertEquals(epAfterTick2.status, "pending");
  assertEquals(epAfterTick2.phase, "synthesized_4_of_6");
  assertEquals(epAfterTick2.attempts, 0);

  // --- TICK 3: final tick completes remaining 2 segments and commits ready ---
  const batch3 = await runSynthesisBatch(ctx, synth, {
    owner: "worker-tick-3",
    maxClaims: 3,
    maxSegmentsPerInvocation: 2,
  });

  assertEquals(batch3.ready.length, 1, "tick 3 should finish episode");
  assertEquals(batch3.yielded.length, 0, "tick 3 should not yield");
  assertEquals(scriptCalls, 1, "script was NEVER re-generated");
  assertEquals(dialogueCalls, 6, "all 6 segments synthesized exactly once (no duplicates!)");

  const epFinal = await stores.metadata.getEpisode("user-1", "ep-multi-tick");
  assert(epFinal);
  assertEquals(epFinal.status, "ready");
  assertEquals(epFinal.phase, "ready");
  assert(epFinal.audioKey, "ready episode has audioKey");
  assert(epFinal.byteLength && epFinal.byteLength > 0);
  assertEquals(epFinal.error, undefined);

  // Assert blob store holds the final assembled audio
  const finalBlob = await stores.blobs.get(epFinal.audioKey);
  assert(finalBlob, "final audio blob exists in blob store");
});

Deno.test("audio-feed-9wqt: (1) reviewer repro: preflight check yields BEFORE turn 2 starts (turns recorded = 1, not 2)", async () => {
  let ms = 0;
  const turns: Array<{ startedAt: number; duration: number }> = [];

  let yieldError: unknown = null;
  try {
    await runManagedTurns({
      segments: [44, 20, 5],
      maxTurns: 3,
      request: (duration: number) => {
        turns.push({ startedAt: ms, duration });
        ms += duration;
        return Promise.resolve(duration);
      },
      stitch: (parts: number[]) => parts,
      // Preflight decision: does remaining budget fit next turn (20ms) + flush margin (5ms)?
      // Here max budget is 45ms. After turn 1 (44ms), remaining is 1ms < 25ms -> should yield!
      shouldYield: () => {
        const remaining = 45 - ms;
        return remaining < 20 + 5;
      },
    });
  } catch (e) {
    yieldError = e;
  }

  assert(yieldError instanceof SynthesisYieldError, "must throw SynthesisYieldError");
  assertEquals(yieldError.completedTurns, 1, "completed turns must be 1");
  assertEquals(turns.length, 1, "turn 2 MUST NOT have started (preflight abort!)");
  assertEquals(turns[0], { startedAt: 0, duration: 44 });
  assertEquals(ms, 44, "clock must be 44ms, NOT 64ms (turn 2 was never executed!)");
});

Deno.test("audio-feed-9wqt: (2) first turn exceeds budget: preflight yields before turn 1 starts (0 turns, 0 paid calls)", async () => {
  let ms = 0;
  const turns: Array<{ startedAt: number; duration: number }> = [];

  let yieldError: unknown = null;
  try {
    await runManagedTurns({
      segments: [30, 20],
      maxTurns: 2,
      request: (duration: number) => {
        turns.push({ startedAt: ms, duration });
        ms += duration;
        return Promise.resolve(duration);
      },
      stitch: (parts: number[]) => parts,
      // Budget is 20ms. Required for turn 1 is 30ms + 5ms = 35ms. 20 < 35 -> yields immediately!
      shouldYield: () => {
        const remaining = 20 - ms;
        return remaining < 30 + 5;
      },
    });
  } catch (e) {
    yieldError = e;
  }

  assert(yieldError instanceof SynthesisYieldError);
  assertEquals(yieldError.completedTurns, 0, "completed turns must be 0");
  assertEquals(turns.length, 0, "no turn was started (0 paid calls!)");
  assertEquals(ms, 0, "no duration elapsed");
});

Deno.test("audio-feed-9wqt: (3) short work still completes in one invocation", async () => {
  let ms = 0;
  const turns: Array<{ startedAt: number; duration: number }> = [];

  const result = await runManagedTurns({
    segments: [5, 5, 5],
    maxTurns: 3,
    request: (duration: number) => {
      turns.push({ startedAt: ms, duration });
      ms += duration;
      return Promise.resolve(duration);
    },
    stitch: (parts: number[]) => parts,
    // Budget 45ms. Each turn is 5ms + 5ms margin = 10ms. 45ms easily fits all three turns!
    shouldYield: () => {
      const remaining = 45 - ms;
      return remaining < 5 + 5;
    },
  });

  assertEquals(result, [5, 5, 5], "all 3 turns completed and stitched");
  assertEquals(turns.length, 3, "all 3 turns executed");
  assertEquals(ms, 15, "total duration was 15ms");
});

Deno.test("audio-feed-vvwb: a stage that would take longer than the budget is aborted at the budget deadline and yields with progress checkpointed", async () => {
  const { ctx, stores } = await setupEnv();

  let scriptCalls = 0;
  let simulatedMs = 1;
  const originalNow = performance.now;
  performance.now = () => simulatedMs;

  try {
    const synth = createGeminiSynthesizer(ctx, {
      flushMarginMs: 5,
      estimatedTurnDurationMs: 10,
      scriptGenerator: (_input, options) => {
        scriptCalls++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            simulatedMs += 200;
            resolve({
              turns: [{ speaker: "Alex" as const, text: "Hello" }],
              sources: [],
              counterarguments: [],
              researchSummary: "",
            });
          }, 200);

          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            simulatedMs = 40;
            reject(new Error("aborted by deadline"));
          });
        });
      },
    });

    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-budget-abort",
        userId: "user-1",
        articleId: "article-1",
        sourceId: "inbox",
        status: "pending",
        mode: "deepdive",
      }),
    );

    const result = await runSynthesisBatch(ctx, synth, {
      owner: "worker-budget-test",
      maxInvocationDurationMs: 45,
      flushMarginMs: 5,
      estimatedTurnDurationMs: 10,
    });

    assertEquals(result.yielded.length, 1, "must yield cleanly");
    assert(simulatedMs <= 45, `elapsed (${simulatedMs}) must be <= budget (45)`);
    const ep = await stores.metadata.getEpisode("user-1", "ep-budget-abort");
    assertEquals(ep?.status, "pending", "episode must be pending for next tick");
    assertEquals(ep?.attempts, 1, "zero-progress yield must preserve attempt count");
  } finally {
    performance.now = originalNow;
  }
});

Deno.test("audio-feed-vvwb: script generated at budget limit checkpoints scriptTurns and yields before dialogue", async () => {
  const { ctx, stores } = await setupEnv();

  let scriptCalls = 0;
  let simulatedMs = 1;
  const originalNow = performance.now;
  performance.now = () => simulatedMs;

  try {
    const synth = createGeminiSynthesizer(ctx, {
      scriptGenerator: () => {
        scriptCalls++;
        simulatedMs += 40_000;
        return Promise.resolve({
          turns: [
            { speaker: "Alex" as const, text: "Turn 1" },
            { speaker: "Sam" as const, text: "Turn 2" },
          ],
          sources: [],
          counterarguments: [],
          researchSummary: "",
        });
      },
    });

    await stores.metadata.putEpisode(
      makeEpisode({
        id: "ep-script-checkpoint-yield",
        userId: "user-1",
        articleId: "article-1",
        sourceId: "inbox",
        status: "pending",
        mode: "deepdive",
      }),
    );

    const result1 = await runSynthesisBatch(ctx, synth, {
      owner: "worker-tick-1",
      maxInvocationDurationMs: 45_000,
    });

    assertEquals(result1.yielded.length, 1, "must yield cleanly");
    const epAfterTick1 = await stores.metadata.getEpisode("user-1", "ep-script-checkpoint-yield");
    assertEquals(epAfterTick1?.status, "pending");
    assertEquals(epAfterTick1?.phase, "synthesized_0_of_2");
    assertEquals(epAfterTick1?.scriptTurns?.length, 2, "scriptTurns must be durably checkpointed!");
    assertEquals(epAfterTick1?.attempts, 0);

    // Tick 2: fresh tick resumes, skips script generation entirely!
    simulatedMs = 1;
    await runSynthesisBatch(ctx, synth, {
      owner: "worker-tick-2",
      maxInvocationDurationMs: 45_000,
      maxSegmentsPerInvocation: 2,
    });

    assertEquals(scriptCalls, 1, "scriptGenerator must NOT be called in Tick 2 (resumed from KV!)");
  } finally {
    performance.now = originalNow;
  }
});

Deno.test("audio-feed-q7zy: (a) budget-aborted TTS turn yields cleanly to pending with attempts 0 (not failed)", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-budget-abort-tts",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "direct",
    }),
  );

  let paidCalls = 0;
  const client = new GeminiTtsClient({
    apiKey: "dummy",
    timeoutRetries: 0,
    fetchFn: (_url, init) => {
      paidCalls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  });

  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: null,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });

  const result = await runSynthesisBatch(ctx, synth, {
    owner: "worker-budget-tts",
    maxAttempts: 2,
    maxInvocationDurationMs: 100,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });

  assertEquals(paidCalls, 1, "TTS call was initiated");
  assertEquals(result.failed.length, 0, "must NOT fail episode on budget abort");
  assertEquals(result.yielded.length, 1, "must report episode as yielded");

  const ep = await stores.metadata.getEpisode("user-1", "ep-budget-abort-tts");
  assertEquals(ep?.status, "pending", "episode must remain pending for next tick");
  assertEquals(ep?.attempts, 1, "attempt count is preserved for uncommitted yield");
  assert(ep?.phase?.startsWith("synthesized_"), "phase must indicate progress or yield");
});

Deno.test("audio-feed-q7zy: (b) genuine provider error still fails with its reason", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-genuine-provider-error",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "direct",
    }),
  );

  const client = new GeminiTtsClient({
    apiKey: "dummy",
    timeoutRetries: 0,
    fetchFn: () => {
      // Real 500 error from upstream provider
      return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
    },
  });

  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: null,
  });

  const result = await runSynthesisBatch(ctx, synth, {
    owner: "worker-genuine-err",
    maxAttempts: 1,
  });

  assertEquals(result.yielded.length, 0, "genuine error must not yield");
  assertEquals(result.failed.length, 1, "genuine error must fail episode");
  assertStringIncludes(result.failed[0]?.error ?? "", "500", "error must describe provider error");

  const ep = await stores.metadata.getEpisode("user-1", "ep-genuine-provider-error");
  assertEquals(ep?.status, "failed", "episode status must be failed");
  assertStringIncludes(ep?.error ?? "", "500");
});

Deno.test("audio-feed-q7zy: (c) budget abort on script stage yields cleanly to pending with attempts 0", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-budget-abort-script",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "deepdive",
    }),
  );

  let scriptCalls = 0;
  const slowScriptGenerator = (_input: unknown, options?: { signal?: AbortSignal }) => {
    scriptCalls++;
    return new Promise<{
      turns: { speaker: "Alex" | "Sam"; text: string }[];
      sources: [];
      counterarguments: [];
      researchSummary: "";
    }>((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason ?? new Error("aborted")),
        { once: true },
      );
    });
  };

  const client = new GeminiTtsClient({ apiKey: "dummy" });

  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: slowScriptGenerator,
    flushMarginMs: 5,
    estimatedTurnDurationMs: 1,
  });

  const result = await runSynthesisBatch(ctx, synth, {
    owner: "worker-budget-script",
    maxAttempts: 2,
    maxInvocationDurationMs: 100,
    flushMarginMs: 5,
    estimatedTurnDurationMs: 1,
  });

  assertEquals(scriptCalls, 1, "script generator was called");
  assertEquals(result.failed.length, 0, "script budget abort must NOT fail episode");
  assertEquals(result.yielded.length, 1, "script budget abort must yield");

  const ep = await stores.metadata.getEpisode("user-1", "ep-budget-abort-script");
  assertEquals(ep?.status, "pending", "episode must remain pending for next tick");
  assertEquals(ep?.attempts, 1, "zero-progress yield must preserve attempt count");
});

Deno.test("audio-feed-zni7: (b) provider AbortError enters retry/failure lifecycle and fails episode (no livelock)", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-provider-aborterror",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "direct",
    }),
  );

  let calls = 0;
  const providerAbortSynth = () => {
    calls++;
    throw new DOMException("provider terminated connection", "AbortError");
  };

  // Run batch with maxAttempts: 1
  const result = await runSynthesisBatch(ctx, providerAbortSynth, {
    owner: "worker-provider-abort",
    maxAttempts: 1,
    maxInvocationDurationMs: 45_000,
  });

  assertEquals(calls, 1, "synthesizer was called");
  assertEquals(result.yielded.length, 0, "provider AbortError must NOT yield as budget");
  assertEquals(result.failed.length, 1, "provider AbortError must fail the episode");
  assertStringIncludes(result.failed[0]?.error ?? "", "provider terminated connection");

  const ep = await stores.metadata.getEpisode("user-1", "ep-provider-aborterror");
  assertEquals(ep?.status, "failed", "episode status must be failed");
  assertStringIncludes(ep?.error ?? "", "provider terminated connection");

  // Subsequent tick must NOT re-pick the failed episode
  const result2 = await runSynthesisBatch(ctx, providerAbortSynth, {
    owner: "worker-provider-abort-tick2",
    maxAttempts: 1,
    maxInvocationDurationMs: 45_000,
  });
  assertEquals(result2.failed.length, 0);
  assertEquals(result2.yielded.length, 0);
  assertEquals(calls, 1, "failed episode must not be picked up again");
});

Deno.test("audio-feed-zni7: (c) claim lease abort takes failure lifecycle and does not livelock", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-lease-abort",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "direct",
    }),
  );

  const client = new GeminiTtsClient({
    apiKey: "dummy",
    fetchFn: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      }),
  });

  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: null,
  });

  // Short leaseMs triggers leaseSignal abort
  const result = await runSynthesisBatch(ctx, synth, {
    owner: "worker-lease-abort",
    leaseMs: 60_050, // leaves ~50ms remainingMs before leaseExpiry minus 60s
    maxAttempts: 1,
  });

  assertEquals(result.yielded.length, 0, "lease abort must NOT yield as budget");
  assertEquals(result.failed.length, 1, "lease abort must fail episode");
  assertStringIncludes(result.failed[0]?.error ?? "", "lease expired");

  const ep = await stores.metadata.getEpisode("user-1", "ep-lease-abort");
  assertEquals(ep?.status, "failed");
});

Deno.test("audio-feed-fsr3: (a) repeated script budget aborts advance attempts and fail episode without livelocking", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-fsr3-stall",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "deepdive",
    }),
  );

  let scriptCalls = 0;
  const slowScriptGenerator = (_input: unknown, options?: { signal?: AbortSignal }) => {
    scriptCalls++;
    return new Promise<{
      turns: { speaker: "Alex" | "Sam"; text: string }[];
      sources: [];
      counterarguments: [];
      researchSummary: "";
    }>((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason ?? new Error("aborted")),
        { once: true },
      );
    });
  };

  const client = new GeminiTtsClient({ apiKey: "dummy" });
  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: slowScriptGenerator,
    flushMarginMs: 5,
    estimatedTurnDurationMs: 10,
  });

  // Tick 1 with maxAttempts: 2 -> yields, advances attempts to 1
  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "worker-fsr3-1",
    maxInvocationDurationMs: 100,
    flushMarginMs: 5,
    estimatedTurnDurationMs: 10,
    maxAttempts: 2,
  });
  assertEquals(r1.yielded.length, 1);
  assertEquals(r1.failed.length, 0);
  const ep1 = await stores.metadata.getEpisode("user-1", "ep-fsr3-stall");
  assertEquals(ep1?.status, "pending");
  assertEquals(ep1?.attempts, 1, "zero-progress yield must preserve attempt count");

  // Tick 2 with maxAttempts: 2 -> attempts exhausted without progress, must FAIL
  const r2 = await runSynthesisBatch(ctx, synth, {
    owner: "worker-fsr3-2",
    maxInvocationDurationMs: 100,
    flushMarginMs: 5,
    estimatedTurnDurationMs: 10,
    maxAttempts: 2,
  });
  assertEquals(r2.yielded.length, 0, "must not yield indefinitely");
  assertEquals(r2.failed.length, 1, "must fail after maxAttempts zero-progress yields");
  const ep2 = await stores.metadata.getEpisode("user-1", "ep-fsr3-stall");
  assertEquals(ep2?.status, "failed", "episode must terminate as failed");
  assertStringIncludes(ep2?.error ?? "", "exceeded");
  assertEquals(scriptCalls, 2, "script was called on each attempt");
});

Deno.test("audio-feed-o88z: repeated uncommitted TTS budget aborts advance attempts each tick, cap paidCalls <= maxAttempts, and fail", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-o88z-stall",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "direct",
    }),
  );

  let paidCalls = 0;
  const client = new GeminiTtsClient({
    apiKey: "dummy",
    timeoutRetries: 0,
    fetchFn: (_url, init) => {
      paidCalls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  });

  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: null,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });

  // Tick 1: yields with attempts=1
  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "repro-1",
    maxAttempts: 2,
    maxInvocationDurationMs: 100,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(r1.yielded.length, 1);
  assertEquals(r1.failed.length, 0);
  const ep1 = await stores.metadata.getEpisode("user-1", "ep-o88z-stall");
  assertEquals(ep1?.status, "pending");
  assertEquals(ep1?.attempts, 1, "attempts must advance to 1 on uncommitted yield");

  // Tick 2: reaches maxAttempts (2) with zero progress -> fails!
  const r2 = await runSynthesisBatch(ctx, synth, {
    owner: "repro-2",
    maxAttempts: 2,
    maxInvocationDurationMs: 100,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(r2.yielded.length, 0);
  assertEquals(r2.failed.length, 1);
  const ep2 = await stores.metadata.getEpisode("user-1", "ep-o88z-stall");
  assertEquals(ep2?.status, "failed");
  assertEquals(ep2?.attempts, 2, "attempts must be 2");

  // Tick 3: failed episode is not picked up, paidCalls remains bounded
  const r3 = await runSynthesisBatch(ctx, synth, {
    owner: "repro-3",
    maxAttempts: 2,
    maxInvocationDurationMs: 100,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(r3.yielded.length, 0);
  assertEquals(r3.failed.length, 0);
  assertEquals(paidCalls, 2, "paidCalls must be strictly bounded <= maxAttempts");
});

Deno.test("audio-feed-dv4p: (a) terminal upload preflight yields before slow upload starts when remaining budget is insufficient", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-dv4p-preflight",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "direct",
    }),
  );

  const oldPut = stores.blobs.put.bind(stores.blobs);
  let putCalls = 0;
  stores.blobs.put = async (...args) => {
    putCalls++;
    await new Promise((r) => setTimeout(r, 135));
    return oldPut(...args);
  };

  const wav = pcmToWav(new Uint8Array(64), { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
  const synth = () => Promise.resolve(decodedFromWav(wav));

  const start = performance.now();
  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "upload-probe-1",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    flushMarginMs: 5,
  });
  const elapsed = performance.now() - start;

  // THE PROPERTY is the line below: preflight REFUSED before any put was attempted
  // (putCalls === 0 — an order fact, not a clock). The elapsed literal was a second,
  // load-sensitive way of saying the same thing (audio-feed-y2ex); it stays only as a
  // deliberately wide sanity bound so scheduler noise cannot flip this test.
  assert(
    elapsed < 2_000,
    `elapsed (${elapsed}ms) sanity bound — putCalls === 0 is the assertion`,
  );
  assertEquals(r1.ready.length, 0, "must not finish ready past budget");
  assertEquals(r1.yielded.length, 1, "must preflight yield before upload");
  assertEquals(putCalls, 0, "blobs.put must not have been called due to preflight yield");

  const ep1 = await stores.metadata.getEpisode("user-1", "ep-dv4p-preflight");
  assertEquals(ep1?.status, "pending");
  assertEquals(ep1?.phase, "upload_retry");

  // Tick 2: restore fast blobs.put; tick completes within normal budget
  stores.blobs.put = oldPut;
  const r2 = await runSynthesisBatch(ctx, synth, {
    owner: "upload-probe-2",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(r2.ready.length, 1, "subsequent tick completes upload");
  assertEquals(r2.yielded.length, 0);

  const ep2 = await stores.metadata.getEpisode("user-1", "ep-dv4p-preflight");
  assertEquals(ep2?.status, "ready");
});

Deno.test("audio-feed-dv4p: (b) terminal upload in flight aborts at invocation deadline without exceeding budget", async () => {
  const { ctx, stores } = await setupEnv();
  await stores.metadata.deleteEpisode("user-1", "episode-1");

  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-dv4p-inflight",
      userId: "user-1",
      articleId: "article-1",
      sourceId: "inbox",
      status: "pending",
      mode: "direct",
    }),
  );

  const oldPut = stores.blobs.put.bind(stores.blobs);
  let putCalls = 0;
  let putSettledAt = 0;
  let putAborted = 0;
  let putSettlement: Promise<unknown> = Promise.resolve();
  stores.blobs.put = (...args) => {
    putCalls++;
    const attempt = (async () => {
      try {
        await new Promise((r) => setTimeout(r, 135));
        return await oldPut(...args);
      } catch (error) {
        // THE ORDER FACT this test pins: the deadline aborted the transfer WHILE IT WAS
        // IN FLIGHT. The elapsed clock below is only a wide sanity bound (audio-feed-y2ex:
        // order/property first, wall-clock literals last).
        if ((args[2] as { signal?: AbortSignal } | undefined)?.signal?.aborted) putAborted++;
        throw error;
      } finally {
        putSettledAt = performance.now();
      }
    })();
    putSettlement = attempt;
    return attempt;
  };

  const wav = pcmToWav(new Uint8Array(64), { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
  const synth = () => Promise.resolve(decodedFromWav(wav));

  const start = performance.now();
  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "upload-probe-inflight-1",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 10, // Allows preflight to pass (10 + 5 < 80)
    flushMarginMs: 5,
  });
  const elapsed = performance.now() - start;
  // The aborted transfer may still be settling when the batch yields (that is the point);
  // await it so the counts below are facts, not races.
  await putSettlement.catch(() => {});

  // THE PROPERTY (audio-feed-y2ex cure, applied because this test flaked twice under
  // load): the budget aborted the put BEFORE it settled — a statement about ORDER, not
  // milliseconds. The batch's yield decision preceded the transfer's settlement, the
  // transfer ended BECAUSE of the deadline, and it DID end (no zombie left running).
  assertEquals(putCalls, 1, "blobs.put was started");
  assertEquals(putAborted, 1, "the deadline must abort the in-flight transfer");
  assert(
    elapsed < putSettledAt - start,
    "the batch must yield while the transfer is still in flight (order, not ms)",
  );
  // Sanity bound only — deliberately WIDE (2s against an 80ms budget) so scheduler noise
  // on a loaded 2-vCPU box cannot flip this test; the order assertions above are the test.
  assert(
    elapsed < 2_000,
    `elapsed (${elapsed}ms) sanity bound — the order assertions above are the test`,
  );
  assertEquals(r1.ready.length, 0, "must not finish ready past budget");
  assertEquals(r1.yielded.length, 1, "must abort upload and yield claim");

  const ep1 = await stores.metadata.getEpisode("user-1", "ep-dv4p-inflight");
  assertEquals(ep1?.status, "pending");
  assertEquals(ep1?.phase, "upload_retry");

  // Tick 2: restore fast blobs.put; tick completes within normal budget
  stores.blobs.put = oldPut;
  const r2 = await runSynthesisBatch(ctx, synth, {
    owner: "upload-probe-inflight-2",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(r2.ready.length, 1, "subsequent tick completes upload");
  assertEquals(r2.yielded.length, 0);

  const ep2 = await stores.metadata.getEpisode("user-1", "ep-dv4p-inflight");
  assertEquals(ep2?.status, "ready");
});

Deno.test("withInvocationBudget: enforces preflight, deadline derivation, provenance, and typed outcomes across all stages", async () => {
  const stages = ["script_generation", "dialogue_tts", "narration_tts", "upload_terminal_audio"];

  for (const stageName of stages) {
    // 1. Preflight refusal: available budget (100 - 0 - 20 = 80ms) < worstCaseEstimate (100ms)
    const preflightOutcome = await withInvocationBudget({
      name: stageName,
      budget: { maxDurationMs: 100, startTimeMonotonicMs: performance.now() },
      flushMarginMs: 20,
      worstCaseEstimateMs: 100,
      fn: () => Promise.resolve("never called"),
    });
    assertEquals(preflightOutcome.kind, "budget-yield");
    if (preflightOutcome.kind === "budget-yield") {
      assert(isInvocationBudgetAbort(preflightOutcome.error));
      assertStringIncludes(preflightOutcome.error.message, "preflight refused");
      assertStringIncludes(preflightOutcome.error.message, stageName);
    }

    // 2. In-flight deadline enforcement: timeout derived from remaining budget (50 - 5 = 45ms)
    //
    // audio-feed-flkk: this used to assert `inFlightElapsed < 80` - a wall-clock figure with 35ms of
    // headroom over the derived 45ms deadline, which made the check a statement about the MACHINE
    // rather than about the behaviour. MEASURED over 200 iterations of this exact race on a loaded
    // 2-vCPU box (load average 3.4 while 110 suites were gating): p50 45.75ms, p90 99.92ms, max
    // 110.78ms, and 35/200 (17.5%) at or above 80ms - so the suite failed up to 2 runs in 4 while the
    // deadline enforcement it guards was working. Because gate verdicts are cached per tree, a false
    // FAIL here is inherited by every lane that touches this tree.
    //
    // What the assertion is FOR is that the deadline PREEMPTS the stage instead of waiting for it,
    // and that is observable without assuming how fast the box is: the stage's own work takes 200ms,
    // so an abort observed WHILE IT IS STILL RUNNING - and therefore under 200ms - is the invariant.
    // The old assertion had this backwards: it could pass while the wrapper waited for the stage
    // (any elapsed under 80ms was accepted, and one over 200ms was only rejected by accident).
    // The derivation itself is now pinned exactly, from the abort message, which nothing checked
    // before: 45ms = 50ms budget - 5ms flush margin, and the machine cannot move that number.
    let stageCompleted = false;
    const inFlightStart = performance.now();
    const inFlightOutcome = await withInvocationBudget({
      name: stageName,
      budget: { maxDurationMs: 50, startTimeMonotonicMs: performance.now() },
      flushMarginMs: 5,
      worstCaseEstimateMs: 10,
      fn: async (_signal) => {
        await new Promise((r) => setTimeout(r, 200));
        stageCompleted = true;
        return "too slow";
      },
    });
    const inFlightElapsed = performance.now() - inFlightStart;
    assert(
      !stageCompleted,
      `stage ${stageName} must abort while the stage is STILL RUNNING: the abort was observed only ` +
        `after the stage's own 200ms of work had completed`,
    );
    assert(
      inFlightElapsed < 200,
      `stage ${stageName} must abort before the stage's own work (200ms) finishes, not wait for it ` +
        `(${inFlightElapsed}ms)`,
    );
    assertEquals(inFlightOutcome.kind, "budget-yield");
    if (inFlightOutcome.kind === "budget-yield") {
      assert(isInvocationBudgetAbort(inFlightOutcome.error));
      assertStringIncludes(inFlightOutcome.error.message, "deadline");
      // THE DERIVATION, checked exactly. The lower bound is not machine speed: it allows up to 5ms of
      // budget to have been spent entering the call (measured 0ms across 200 iterations - the
      // reported value was 45 every time). A deadline taken from the wrong term - maxDurationMs, or
      // the remaining budget without the flush margin - lands outside 40..45 and reddens.
      const derivedDeadline = Number(
        inFlightOutcome.error.message.match(/deadline \((\d+)ms\) exceeded/)?.[1] ?? NaN,
      );
      assert(
        Number.isFinite(derivedDeadline) && derivedDeadline >= 40 && derivedDeadline <= 45,
        `stage ${stageName} must derive its deadline from the remaining budget (50ms budget - 5ms ` +
          `flush margin = 45ms): the abort reported ${derivedDeadline}ms`,
      );
      assertStringIncludes(inFlightOutcome.error.message, stageName);
    }

    // 3. Normal fast completion: returns typed completed outcome
    const normalOutcome = await withInvocationBudget({
      name: stageName,
      budget: { maxDurationMs: 500, startTimeMonotonicMs: performance.now() },
      flushMarginMs: 5,
      worstCaseEstimateMs: 10,
      fn: () => Promise.resolve(`done-${stageName}`),
    });
    assertEquals(normalOutcome.kind, "completed");
    if (normalOutcome.kind === "completed") {
      assertEquals(normalOutcome.value, `done-${stageName}`);
    }

    // 4. Genuine error: returns typed error outcome without misclassifying as budget yield
    const errorOutcome = await withInvocationBudget({
      name: stageName,
      budget: { maxDurationMs: 500, startTimeMonotonicMs: performance.now() },
      flushMarginMs: 5,
      worstCaseEstimateMs: 10,
      fn: () => Promise.reject(new Error(`provider_failure_in_${stageName}`)),
    });
    assertEquals(errorOutcome.kind, "error");
    if (errorOutcome.kind === "error") {
      assertStringIncludes(
        String((errorOutcome.error as Error).message),
        `provider_failure_in_${stageName}`,
      );
    }
  }
});

Deno.test("audio-feed-mv1d: terminal metadata write is bounded by invocation budget and yields cleanly", async () => {
  const { ctx, stores } = await setupEnv();
  const oldComplete = stores.metadata.completeEpisode.bind(stores.metadata);
  let completeSettledAt = 0;
  stores.metadata.completeEpisode = async (...args) => {
    try {
      await new Promise((r) => setTimeout(r, 140));
      return await oldComplete(...args);
    } finally {
      completeSettledAt = performance.now();
    }
  };
  const started = performance.now();
  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-upload-commit",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  const yieldReturnedAt = performance.now();
  const elapsed = yieldReturnedAt - started;
  // THE ORDER PROPERTY (audio-feed-y2ex cure): the budget-yield decision PRECEDED the
  // metadata write's settlement — the write was still in flight when its deadline fired,
  // which is the bounded-yield fact. A wall-clock literal here flaked under load; the
  // elapsed bound below is a deliberately wide sanity check (2s against an 80ms budget),
  // not the assertion.
  assert(
    completeSettledAt === 0 || yieldReturnedAt < completeSettledAt,
    "the yield must be decided while the terminal write is still in flight (order, not ms)",
  );
  assert(
    elapsed < 2_000,
    `elapsed (${elapsed}ms) sanity bound — the order assertion above is the test`,
  );
  assertEquals(
    result.ready.length,
    0,
    "must not return ready when terminal commit cannot complete in budget",
  );
  assertEquals(result.yielded.length, 1, "must cleanly yield claim");
  const ep = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(ep?.status, "pending");
});

Deno.test("audio-feed-fsbk: timed-out upload cleanup cleans blob when put settles and records orphan", async () => {
  const { ctx, stores } = await setupEnv();
  const oldPut = stores.blobs.put.bind(stores.blobs);
  let startedKey = "";
  stores.blobs.put = async (...args) => {
    startedKey = args[0];
    await new Promise((r) => setTimeout(r, 135));
    return oldPut(...args);
  };
  const r = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-upload-race",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(r.yielded.length, 1);
  // Verify orphan record is retained in KV immediately at yield while put is in flight
  const orphanAtYield = await stores.metadata.listOrphanBlobs(10);
  assert(
    orphanAtYield.includes(startedKey),
    "orphan record must be retained in KV while put is in flight",
  );

  // Wait for background delayed put to finish (135ms) + hook execution
  await new Promise((r) => setTimeout(r, 160));
  const staleBlob = await stores.blobs.get(startedKey);
  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(staleBlob, null, "timed-out put must be cleaned up on settlement without lingering");
  assertEquals(episode?.status, "pending");
});

Deno.test("audio-feed-y0da: timeout during delayed return from completeEpisode does not delete committed blob", async () => {
  const { ctx, stores } = await setupEnv();
  const complete = stores.metadata.completeEpisode.bind(stores.metadata);
  stores.metadata.completeEpisode = async (...args) => {
    const result = await complete(...args);
    // Simulate delay during completeEpisode return exceeding remaining budget
    await new Promise((resolve) => setTimeout(resolve, 140));
    return result;
  };
  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-terminal-race",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 190));
  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(episode?.status, "ready", "committed episode must remain ready");
  assert(episode?.audioKey, "ready episode must have audioKey");
  const blob = await stores.blobs.get(episode.audioKey!);
  assert(blob !== null, "committed blob must never be deleted by timeout abort");
  assertEquals(result.ready.length, 1, "batch must report episode as ready when commit won");
});

Deno.test("audio-feed-y0da (reverse): timeout abort yields claim atomically before delayed commit can win (never ready with deleted audio)", async () => {
  const { ctx, stores } = await setupEnv();
  const complete = stores.metadata.completeEpisode.bind(stores.metadata);
  stores.metadata.completeEpisode = async (...args) => {
    // Simulate delay BEFORE completeEpisode commits
    await new Promise((resolve) => setTimeout(resolve, 140));
    return await complete(...args);
  };
  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-terminal-race-pre-commit",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 190));
  const episode = await stores.metadata.getEpisode("user-1", "episode-1");
  // The abort won the atomic transition: episode must be pending, not ready!
  assertEquals(
    episode?.status,
    "pending",
    "episode must not become ready when abort won atomic transition",
  );
  assertEquals(result.ready.length, 0, "batch must not report episode as ready when abort won");
  if (episode?.audioKey) {
    const blob = await stores.blobs.get(episode.audioKey);
    assertEquals(blob, null, "aborted staging blob must be cleaned up");
  }
});

Deno.test("audio-feed-uecw: synthesis accounting is recorded as part of terminal completion", async () => {
  const { ctx, stores } = await setupEnv();
  const put = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 45));
    return put(...args);
  };
  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-tail-skip",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(result.ready.length, 1, "episode must be completed ready");
  const today = new Date().toISOString().slice(0, 10);
  const count = await stores.metadata.getDailySynthesisCount(today);
  assertEquals(count, 1, "daily synthesis count must be recorded as part of terminal path");
});

Deno.test("audio-feed-uecw: terminal completion commits episode ready and billing counters in a single atomic transaction", async () => {
  const { ctx, stores } = await setupEnv();
  const today = new Date().toISOString().slice(0, 10);
  const initialCount = await stores.metadata.getDailySynthesisCount(today);
  assertEquals(initialCount, 0, "initial count zero");

  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-atomic-billing",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(result.ready.length, 1, "episode completed ready");

  const count = await stores.metadata.getDailySynthesisCount(today);
  assertEquals(
    count,
    1,
    "daily synthesis count must be credited atomically with episode completion",
  );

  // A superseded attempt cannot increment counters
  const ep = await stores.metadata.getEpisode("user-1", "episode-1");
  assert(ep);
  const superseded = await stores.metadata.completeEpisode(
    ep,
    "superseded-worker",
    { byteLength: 500 },
  );
  assertEquals(superseded, false, "superseded worker write must fail");
  const countAfterSuperseded = await stores.metadata.getDailySynthesisCount(today);
  assertEquals(countAfterSuperseded, 1, "failed completion must never increment billing counters");
});

Deno.test("audio-feed-n8wk: concurrent heartbeat during abort does not leak uncommitted blob", async () => {
  const { ctx, stores } = await setupEnv();
  let stagingKey = "";
  const oldPut = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = async (...args) => {
    stagingKey = args[0];
    await new Promise((resolve) => setTimeout(resolve, 135));
    return oldPut(...args);
  };

  // Simulate CAS failure during cleanupOnAbort (audio-feed-22ui)
  stores.metadata.yieldEpisodeClaim = (..._args) => {
    return Promise.resolve(false);
  };

  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-heartbeat-race",
    maxInvocationDurationMs: 80,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });

  assertEquals(result.yielded.length, 1);
  // Verify that despite yield CAS failure, cleanupOnAbort checked durable state:
  // Since episode was NOT ready, it deleted the uncommitted blob and recorded orphan in KV (no leak!)
  const orphanBlobs = await stores.metadata.listOrphanBlobs(10);
  assert(
    orphanBlobs.includes(stagingKey),
    "orphan record must be written to KV even when yield CAS fails",
  );
});

Deno.test("audio-feed-mkkb: idempotent completeEpisode replay never double charges", async () => {
  const { ctx, stores } = await setupEnv();
  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-idempotent-accounting",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(result.ready.length, 1);
  const today = new Date().toISOString().slice(0, 10);
  const initialCount = await stores.metadata.getDailySynthesisCount(today);
  assertEquals(initialCount, 1, "initial charge recorded");

  const ep = await stores.metadata.getEpisode("user-1", "episode-1");
  assert(ep?.audioKey);

  // Re-invoking completeEpisode idempotently for the same owner and audioKey must not increment counters
  const replayed = await stores.metadata.completeEpisode(
    ep,
    "review-idempotent-accounting",
    { byteLength: ep.byteLength ?? 100 },
  );
  assertEquals(replayed, true, "idempotent completion must return true");

  const countAfterReplay = await stores.metadata.getDailySynthesisCount(today);
  assertEquals(countAfterReplay, 1, "idempotent completion replay must never double charge");
});

Deno.test("audio-feed-g5bi: error in terminal_persistence after completeEpisode does not delete committed blob", async () => {
  const { ctx, stores } = await setupEnv();
  // Simulate completeEpisode succeeding, but subsequent logic inside fn throwing
  const origComplete = stores.metadata.completeEpisode.bind(stores.metadata);
  stores.metadata.completeEpisode = async (...args) => {
    const _res = await origComplete(...args);
    throw new Error("simulated post-commit failure inside terminal_persistence");
  };

  const result = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), {
    owner: "review-g5bi-error",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });

  assertEquals(result.ready.length, 1, "episode must be reported ready");
  const ep = await stores.metadata.getEpisode("user-1", "episode-1");
  assertEquals(ep?.status, "ready");
  assert(ep?.audioKey);
  const blob = await stores.blobs.get(ep.audioKey);
  assert(blob !== null, "committed blob must never be deleted by error handler");

  const today = new Date().toISOString().slice(0, 10);
  const count = await stores.metadata.getDailySynthesisCount(today);
  assertEquals(count, 1, "atomic billing committed with completeEpisode");
});
