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

  const write1 = await stores.metadata.completeEpisode(readyEpisode, "worker-idempotent");
  assertEquals(write1, true);

  // Second identical call by the SAME worker
  const write2 = await stores.metadata.completeEpisode(readyEpisode, "worker-idempotent");
  assertEquals(
    write2,
    true,
    "second identical completion by same owner must return true (idempotent)",
  );

  // Another worker attempting completion must be refused
  const writeOther = await stores.metadata.completeEpisode(readyEpisode, "worker-other");
  assertEquals(writeOther, false, "completion by another worker must return false (superseded)");

  // Different audio key by original worker must be refused
  const write3 = await stores.metadata.completeEpisode(
    { ...readyEpisode, audioKey: "audio/user-1/direct/episode-different.wav" },
    "worker-idempotent",
  );
  assertEquals(write3, false, "completion with different audio key must return false");
});
