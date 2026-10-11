/**
 * Tests for audio-feed-siv1:
 * - A claim dying before its terminal write leaves a recorded cause with phase, heartbeat, and attempt history.
 * - Abandonment after maxClaims persists why (reason + phase + attempt count) rather than "no claim recorded a cause".
 * - Resumption in deepdive mode preserves script turns so segment hashes match and retry resumes rather than restarts.
 * - completeEpisode is idempotent.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { createGeminiSynthesizer } from "../src/worker/synthesis.ts";
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
  // Verify that attempt 1's death and phase are preserved in the episode's error record
  assert(claim2.error?.includes("worker-1"));
  assert(claim2.error?.includes("synthesizing_segment_1_of_4"));
  assert(claim2.error?.includes("died before terminal write"));

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
  assertStringIncludes(error, "worker died before terminal write");
  assertStringIncludes(error, 'in phase "uploading_audio"');
  assertStringIncludes(error, "synthesizing_segment_1_of_4");
  assertStringIncludes(error, "synthesizing_segment_3_of_4");
  assertStringIncludes(error, "worker-1");
  assertStringIncludes(error, "worker-2");
  assertStringIncludes(error, "worker-3");
  assert(
    !error.includes("no claim recorded a cause"),
    "must never report 'no claim recorded a cause'",
  );
});

Deno.test("audio-feed-siv1: deepdive mode persists scriptTurns so retries resume without regenerating script", async () => {
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

  // Simulate isolate crash: Worker 1 died without calling completeEpisode.
  // Lease expires:
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
    "script generator must NOT be called again — script turns were reused",
  );
  assertEquals(clientDialogueCalls, 2);
});

Deno.test("audio-feed-siv1: completeEpisode is idempotent for the same owner and audio key", async () => {
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

  // Second identical call
  const write2 = await stores.metadata.completeEpisode(readyEpisode, "worker-idempotent");
  assertEquals(write2, true, "second identical completion must return true (idempotent)");

  // Different audio key
  const write3 = await stores.metadata.completeEpisode(
    { ...readyEpisode, audioKey: "audio/user-1/direct/episode-different.wav" },
    "worker-idempotent",
  );
  assertEquals(write3, false, "completion with different audio key must return false");
});
