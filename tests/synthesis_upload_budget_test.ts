/**
 * Tests for audio-feed-aqms (the fix side; the repro of the incident itself lives in
 * synthesis_invocation_death_test.ts):
 *
 *  - The terminal upload preflight estimate scales with PAYLOAD SIZE, so a put that
 *    cannot finish inside the remaining budget is never started; the claim is
 *    yielded resumably and the NEXT tick - with a fresh budget - completes it.
 *  - An audio payload whose size-scaled estimate cannot fit even a fresh invocation
 *    budget fails TERMINALLY with a legible reason instead of livelocking on
 *    2-minute retries (or dying mid-put on a platform kill).
 *  - A timer heartbeat runs while the terminal stage is awaited: the claim is
 *    touched without a phase change, so `lastHeartbeat` advances during a slow put
 *    (which is what makes "still uploading" distinguishable from "died at the
 *    checkpoint" in the abandonment record), and no claim-lifecycle log events are
 *    produced by the heartbeat itself.
 */
import { assert, assertEquals } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { decodedFromWav, pcmToWav } from "../src/tts/gemini.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

function fakeAudio(byteLength: number, durationSeconds = 10): DecodedAudioResult {
  const wav = pcmToWav(new Uint8Array(byteLength), {
    sampleRate: 24000,
    numChannels: 1,
    bitsPerSample: 8,
  });
  return { ...decodedFromWav(wav), durationSeconds };
}

async function setupEnv(episodeId: string) {
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
      id: episodeId,
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

Deno.test("audio-feed-aqms: size-scaled upload preflight yields resumably; next tick with fresh budget completes", async () => {
  const episodeId = "ep-aqms-resume";
  const { ctx, stores } = await setupEnv(episodeId);

  // 20 KB at the assumed 10 bytes/ms = 2000ms estimate (floor 100ms does not dominate).
  // Budget 2500ms: a fresh invocation fits it (2500 - 100 flush > 2010), an invocation
  // that already spent 600ms on synthesis does not (1800 < 2010) and must refuse to
  // START the put and yield instead of dying inside it.
  const audio = fakeAudio(20_000);
  let putCalls = 0;
  const oldPut = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = (...args) => {
    putCalls++;
    return oldPut(...args);
  };
  let synthCalls = 0;
  const synth = () => {
    synthCalls++;
    if (synthCalls === 1) return new Promise<DecodedAudioResult>((r) => setTimeout(() => r(audio), 600));
    return Promise.resolve(audio);
  };

  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "aqms-resume-1",
    maxInvocationDurationMs: 2_500,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });
  assertEquals(putCalls, 0, "must NOT start a put whose size-scaled estimate cannot fit");
  assertEquals(r1.yielded.length, 1, "must yield the claim resumably");
  assertEquals(r1.ready.length, 0);

  const ep1 = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(ep1?.status, "pending");
  assertEquals(ep1?.phase, "audio_synthesized");

  // Next tick: fresh budget, synthesis served from the resume cache, put fits.
  const r2 = await runSynthesisBatch(ctx, synth, {
    owner: "aqms-resume-2",
    maxInvocationDurationMs: 2_500,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });
  assertEquals(putCalls, 1, "second tick uploads the audio");
  assertEquals(r2.ready.length, 1, "episode completes on the retry tick");
  const ep2 = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(ep2?.status, "ready");
});

Deno.test("audio-feed-aqms: payload that cannot fit even a fresh invocation budget fails terminally with a legible reason", async () => {
  const episodeId = "ep-aqms-neverfits";
  const { ctx, stores } = await setupEnv(episodeId);

  // 2 MB at 10 bytes/ms = 200s estimate, far over the 3s budget.
  const audio = fakeAudio(2_000_000);
  let putCalls = 0;
  const oldPut = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = (...args) => {
    putCalls++;
    return oldPut(...args);
  };
  const synth = () => Promise.resolve(audio);

  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "aqms-neverfits-1",
    maxInvocationDurationMs: 3_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });

  assertEquals(putCalls, 0, "no put may be started for an unfittable payload");
  assertEquals(r1.failed.length, 1, "must fail terminally, not yield or stall");
  assertEquals(r1.yielded.length, 0);
  const reason = r1.failed[0]?.error ?? "";
  assert(reason.includes("cannot fit the invocation budget"), `reason must name the cause: ${reason}`);
  assert(reason.includes("2"), `reason must name the payload size: ${reason}`);
  assert(reason.includes("MAX_INVOCATION_DURATION_MS"), `reason must name the knob: ${reason}`);

  const ep = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(ep?.status, "failed");
  assert((ep?.error ?? "").includes("cannot fit the invocation budget"));
});

Deno.test("audio-feed-aqms: timer heartbeat touches the claim during a slow terminal upload without phase changes", async () => {
  const episodeId = "ep-aqms-heartbeat";
  const { ctx, stores } = await setupEnv(episodeId);

  const audio = fakeAudio(1_000);
  const oldPut = stores.blobs.put.bind(stores.blobs);
  let putStartedAt = 0;
  stores.blobs.put = async (...args) => {
    putStartedAt = Date.now();
    await new Promise((r) => setTimeout(r, 2_200));
    return oldPut(...args);
  };

  // Record every phase-less touch (the heartbeat) and every lifecycle log append.
  const heartbeatTimes: number[] = [];
  const origTouch = stores.metadata.touchEpisodeClaim.bind(stores.metadata);
  stores.metadata.touchEpisodeClaim = (
    userId: string,
    episodeId: string,
    owner: string,
    update: { phase?: string; now?: string },
  ) => {
    if (!update.phase && update.now === undefined) heartbeatTimes.push(Date.now());
    return origTouch(userId, episodeId, owner, update);
  };

  const r1 = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    owner: "aqms-heartbeat-1",
    leaseMs: 4_000, // heartbeat interval = clamp(lease/4, 1s, 30s) = 1s
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });

  assertEquals(r1.ready.length, 1, "slow upload still completes within budget");
  const ep = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(ep?.status, "ready");

  // The heartbeat must have fired at least once strictly AFTER the put began, and
  // strictly BEFORE the put settled (it is the "worker alive mid-upload" signal).
  const putSettledAt = putStartedAt + 2_200;
  const midUpload = heartbeatTimes.filter((t) => t > putStartedAt + 50 && t < putSettledAt);
  assert(
    midUpload.length >= 1,
    `expected >=1 heartbeat during the upload, got ${JSON.stringify(heartbeatTimes)} (put ${putStartedAt}..${putSettledAt})`,
  );

  // Phase-less touches must not produce claim-lifecycle log events (noise guard):
  // the only lifecycle events in this flow are the phase transitions themselves
  // (claimed -> reading_article -> uploading_audio), never one per heartbeat.
  const lifecycleEvents = (await stores.metadata.listLogs({ limit: 1000 }))
    .filter((l) => (l as unknown as { type?: string }).type === "claim.lifecycle");
  const phases = lifecycleEvents.map((l) => (l as unknown as { phase?: string }).phase);
  assertEquals(
    phases.filter((p) => p === "uploading_audio").length,
    1,
    `uploading_audio must be logged once (phase transition), not per heartbeat: ${JSON.stringify(phases)}`,
  );
});
