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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("audio-feed-avgc: completed PUT after budget yield survives and retry commits that same blob without another PUT", async () => {
  const episodeId = "ep-avgc-late-put";
  const { ctx, stores } = await setupEnv(episodeId);
  const audio = fakeAudio(1_024);
  const oldPut = stores.blobs.put.bind(stores.blobs);
  const keys: string[] = [];
  let settled: Promise<unknown> = Promise.resolve();
  stores.blobs.put = (key, body, opts) => {
    keys.push(key);
    // Model an atomic server-side PUT that finishes after the client aborts:
    // the local connection closed, but the complete object exists in storage.
    settled = new Promise((resolve, reject) => {
      setTimeout(
        () => oldPut(key, body, { contentType: opts?.contentType }).then(resolve, reject),
        250,
      );
    });
    return settled as ReturnType<typeof oldPut>;
  };

  const first = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    owner: "avgc-upload-1",
    maxInvocationDurationMs: 150,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(first.yielded.length, 1, "the budget must yield before the delayed PUT settles");
  assertEquals(keys.length, 1, "the first tick started exactly one PUT");
  await settled;
  const existing = await stores.blobs.head(keys[0]!);
  assertEquals(existing?.size, audio.rawBytes.length, "completed upload must survive the yield");
  assertEquals((await stores.metadata.getEpisode("user-1", episodeId))?.phase, "upload_retry");

  const second = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    owner: "avgc-upload-2",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(second.ready.length, 1, "the next fresh tick commits the retained blob");
  assertEquals(keys.length, 1, "retry must not PUT again, even under a new key");
  assertEquals(second.ready[0]?.audioKey, keys[0], "ready audio reuses the first attempt's key");
  assert(await stores.blobs.head(keys[0]!), "the published object is still present");

  // The observability contract must distinguish a real upload from verified
  // reuse and from never reaching the terminal stage. Bind each mark to its
  // invocation rather than assuming an ordering of returned log records.
  const logs = await stores.metadata.listLogs({ limit: 100 });
  const invocations = logs.filter((log) =>
    log.type === "synthesis.invocation" && log.phase === "started"
  );
  const stages = logs.filter((log) => log.type === "synthesis.stage");
  assertEquals(invocations.length, 2, "both attempts must have observable invocation starts");
  const uploaded = stages.find((log) => log.phase === "upload");
  assert(uploaded?.correlationId, "the first invocation must mark its actual PUT");
  const reused = invocations.find((log) => log.correlationId !== uploaded.correlationId);
  assert(reused?.correlationId, "the second invocation must have a distinct correlation ID");
  assert(
    stages.some((log) => log.phase === "verify" && log.correlationId === uploaded.correlationId),
    "first invocation verifies absence before uploading",
  );
  assert(
    stages.some((log) => log.phase === "verify" && log.correlationId === reused.correlationId),
    "retry verifies the stored bytes before reusing",
  );
  assertEquals(
    stages.some((log) => log.phase === "upload" && log.correlationId === reused.correlationId),
    false,
    "verified reuse must never be misreported as another upload",
  );
});

Deno.test("audio-feed-avgc: absent object after an aborted PUT retries under the same key", async () => {
  const episodeId = "ep-avgc-aborted-put";
  const { ctx, stores } = await setupEnv(episodeId);
  const audio = fakeAudio(1_024);
  const oldPut = stores.blobs.put.bind(stores.blobs);
  const keys: string[] = [];
  stores.blobs.put = (key, body, opts) => {
    keys.push(key);
    if (keys.length > 1) return oldPut(key, body, opts);
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
    });
  };
  const first = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    owner: "avgc-absent-1",
    maxInvocationDurationMs: 150,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(first.yielded.length, 1);
  assertEquals(keys.length, 1);
  assertEquals(await stores.blobs.head(keys[0]!), null, "aborted whole PUT left no object");
  const second = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    owner: "avgc-absent-2",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(second.ready.length, 1);
  assertEquals(
    keys,
    [keys[0], keys[0]],
    "retry reuses the stable key even when a new PUT is needed",
  );
});

Deno.test("audio-feed-avgc: equal-sized but different stored bytes are not reused or overwritten", async () => {
  const episodeId = "ep-avgc-mismatched-put";
  const { ctx, stores } = await setupEnv(episodeId);
  const audio = fakeAudio(1_024);
  const oldPut = stores.blobs.put.bind(stores.blobs);
  let stagingKey = "";
  let puts = 0;
  let settled: Promise<unknown> = Promise.resolve();
  stores.blobs.put = (key, body, opts) => {
    stagingKey = key;
    puts++;
    settled = new Promise((resolve, reject) => {
      setTimeout(
        () => oldPut(key, body, { contentType: opts?.contentType }).then(resolve, reject),
        250,
      );
    });
    return settled as ReturnType<typeof oldPut>;
  };
  const first = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    owner: "avgc-mismatch-1",
    maxInvocationDurationMs: 150,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(first.yielded.length, 1);
  await settled;
  const wrong = new Uint8Array(audio.rawBytes);
  wrong[wrong.length - 1] = wrong[wrong.length - 1]! ^ 1; // HEAD alone would falsely accept it
  await oldPut(stagingKey, wrong, { contentType: "audio/wav" });
  const second = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    owner: "avgc-mismatch-2",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 1,
    flushMarginMs: 5,
  });
  assertEquals(second.ready.length, 0, "mismatched bytes must never become published audio");
  assertEquals(
    second.failed.length,
    1,
    "corrupt staged key fails visibly instead of retrying forever",
  );
  assertEquals(puts, 1, "a mismatched existing key must not be overwritten");
  assertEquals((await stores.blobs.head(stagingKey))?.size, wrong.length);
});

Deno.test("audio-feed-aqms: size-scaled upload preflight yields resumably; next tick with fresh budget completes", async () => {
  const episodeId = "ep-aqms-resume";
  const { ctx, stores } = await setupEnv(episodeId);

  // 15 MB at the assumed 10_000 B/ms = 1500ms estimate (floor 100ms does not
  // dominate). Budget 2500ms: a fresh invocation fits it (2500 - 100 flush >
  // 1510), an invocation that already spent 1200ms on synthesis does not
  // (1200 < 1510) and must refuse to START the put and yield instead of dying
  // inside it.
  const audio = fakeAudio(15_000_000);
  let putCalls = 0;
  const oldPut = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = (...args) => {
    putCalls++;
    return oldPut(...args);
  };
  let synthCalls = 0;
  const synth = () => {
    synthCalls++;
    if (synthCalls === 1) {
      return new Promise<DecodedAudioResult>((r) => setTimeout(() => r(audio), 1_200));
    }
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
  assertEquals(ep1?.phase, "upload_retry");
  assertEquals(ep1?.uploadRetry, 1, "uploadRetry counter is incremented to 1 (audio-feed-lqd6)");

  // The retry churn is operator-visible in the claim history: one lifecycle
  // record per interrupted upload, naming the cause (coord landing condition).
  const retryEvents = (await stores.metadata.listLogs({ limit: 100 }))
    .filter((l) => (l as unknown as { type?: string; phase?: string }).type === "claim.lifecycle")
    .filter((l) => (l as unknown as { phase?: string }).phase === "upload_retry");
  assertEquals(retryEvents.length, 1, "interrupted upload writes a claim-history record");
  assertStringIncludes(
    (retryEvents[0] as unknown as { message?: string }).message ?? "",
    "terminal upload interrupted by invocation budget",
  );
  assertStringIncludes(
    (retryEvents[0] as unknown as { message?: string }).message ?? "",
    "retry 1/3",
  );

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
  assertEquals(ep2?.uploadRetry, undefined, "uploadRetry cleared on completion");
});

Deno.test("audio-feed-aqms: payload that cannot fit even a fresh invocation budget fails terminally with a legible reason", async () => {
  const episodeId = "ep-aqms-neverfits";
  const { ctx, stores } = await setupEnv(episodeId);

  // 20 MB at 10_000 B/ms = 2000ms byte-scaled estimate, over the 1000ms budget
  // even before the flush margin: no invocation at this budget can ever upload it.
  const audio = fakeAudio(20_000_000);
  let putCalls = 0;
  const oldPut = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = (...args) => {
    putCalls++;
    return oldPut(...args);
  };
  const synth = () => Promise.resolve(audio);

  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "aqms-neverfits-1",
    maxInvocationDurationMs: 1_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });

  assertEquals(putCalls, 0, "no put may be started for an unfittable payload");
  assertEquals(r1.failed.length, 1, "must fail terminally, not yield or stall");
  assertEquals(r1.yielded.length, 0);
  const reason = r1.failed[0]?.error ?? "";
  assert(
    reason.includes("cannot fit the invocation budget"),
    `reason must name the cause: ${reason}`,
  );
  assert(reason.includes("bytes at the assumed"), `reason must name the payload: ${reason}`);
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
    `expected >=1 heartbeat during the upload, got ${
      JSON.stringify(heartbeatTimes)
    } (put ${putStartedAt}..${putSettledAt})`,
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
    `uploading_audio must be logged once (phase transition), not per heartbeat: ${
      JSON.stringify(phases)
    }`,
  );
});

Deno.test("audio-feed-lqd6: repeated terminal upload budget aborts advance uploadRetry counter and fail terminally upon exceeding maxUploadRetries", async () => {
  const episodeId = "ep-lqd6-retry-cap";
  const { ctx, stores } = await setupEnv(episodeId);

  // 15 MB audio. Fresh window is 2500ms - 100ms flush = 2400ms.
  // Slow put takes 2200ms of an 1800ms budget, so every upload attempt is aborted at the deadline.
  const audio = fakeAudio(15_000_000);
  const oldPut = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = async (...args) => {
    // Hang until aborted by the signal
    const signal = args[2]?.signal;
    if (signal?.aborted) throw signal.reason;
    await new Promise<void>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return oldPut(...args);
  };
  const synth = () => Promise.resolve(audio);

  // Configure maxUploadRetries = 2.
  // Tick 1: upload 1 interrupted -> retry 1 recorded (uploadRetry = 1)
  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "lqd6-worker-1",
    maxUploadRetries: 2,
    maxInvocationDurationMs: 1_800,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });
  assertEquals(r1.yielded.length, 1, "tick 1 yields resumably");
  assertEquals(r1.failed.length, 0);
  const ep1 = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(ep1?.status, "pending");
  assertEquals(ep1?.phase, "upload_retry");
  assertEquals(ep1?.uploadRetry, 1);
  assertEquals(ep1?.attempts, 0, "attempts reset to 0 on progress yield");

  // Tick 2: upload 2 (1st retry) interrupted -> retry 2 recorded (uploadRetry = 2)
  const r2 = await runSynthesisBatch(ctx, synth, {
    owner: "lqd6-worker-2",
    maxUploadRetries: 2,
    maxInvocationDurationMs: 1_800,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });
  assertEquals(r2.yielded.length, 1, "tick 2 yields resumably");
  assertEquals(r2.failed.length, 0);
  const ep2 = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(ep2?.status, "pending");
  assertEquals(ep2?.phase, "upload_retry");
  assertEquals(ep2?.uploadRetry, 2);
  assertEquals(ep2?.attempts, 0);

  // Tick 3: upload 3 (2nd retry) interrupted -> next retry would be 3 > 2 (exceeds cap)!
  // Must fail TERMINALLY with legible error naming bytes, duration, and the knob.
  const r3 = await runSynthesisBatch(ctx, synth, {
    owner: "lqd6-worker-3",
    maxUploadRetries: 2,
    maxInvocationDurationMs: 1_800,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });
  assertEquals(r3.yielded.length, 0, "tick 3 must NOT yield again");
  assertEquals(r3.failed.length, 1, "tick 3 fails terminally upon exceeding retry cap");
  const failedError = r3.failed[0]?.error ?? "";
  assertStringIncludes(failedError, "terminal audio upload exceeded retry cap (2)");
  assertStringIncludes(failedError, "bytes repeatedly interrupted by invocation budget");
  assertStringIncludes(failedError, "assumed 10000 bytes/ms");
  assertStringIncludes(failedError, "raise MAX_INVOCATION_DURATION_MS or MAX_UPLOAD_RETRIES");
  assertStringIncludes(failedError, "(audio-feed-lqd6)");

  const ep3 = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(ep3?.status, "failed");
  assertEquals(ep3?.error, failedError);

  // Tick 4: queue is now empty because episode is failed; no infinite churn!
  const r4 = await runSynthesisBatch(ctx, synth, {
    owner: "lqd6-worker-4",
    maxUploadRetries: 2,
    maxInvocationDurationMs: 1_800,
  });
  assertEquals(r4.ready.length, 0);
  assertEquals(r4.yielded.length, 0);
  assertEquals(r4.failed.length, 0, "no more churn; episode stays failed");
});

Deno.test("audio-feed-lqd6: lost claim when exceeding retry cap reports superseded rather than failed (P1 review finding)", async () => {
  const episodeId = "ep-lqd6-lost-claim";
  const { ctx, stores } = await setupEnv(episodeId);

  const audio = fakeAudio(15_000_000);
  const synth = () => Promise.resolve(audio);

  // Put episode with uploadRetry already at cap (2)
  const ep = await stores.metadata.getEpisode("user-1", episodeId);
  assert(ep);
  await stores.metadata.putEpisode({ ...ep, uploadRetry: 2 });

  // Mock completeEpisode to fail (lost ownership / concurrent worker won)
  const origComplete = stores.metadata.completeEpisode.bind(stores.metadata);
  stores.metadata.completeEpisode = ((
    episode: Parameters<typeof origComplete>[0],
    owner: string,
    ...args: unknown[]
  ) => {
    if (episode.status === "failed") {
      // Simulate lost claim
      return Promise.resolve(false);
    }
    // deno-lint-ignore no-explicit-any
    return (origComplete as any)(episode, owner, ...args);
  }) as typeof origComplete;

  // Upload aborts at deadline, retry cap exceeded, but completeEpisode fails
  const oldPut = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = async (...args) => {
    const signal = args[2]?.signal;
    if (signal?.aborted) throw signal.reason;
    await new Promise<void>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return oldPut(...args);
  };

  const r = await runSynthesisBatch(ctx, synth, {
    owner: "lqd6-lost-worker",
    maxUploadRetries: 2,
    maxInvocationDurationMs: 1_800,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
  });

  assertEquals(r.failed.length, 0, "must NOT report failed when terminal write did not succeed");
  assertEquals(r.superseded.length, 1, "must report superseded when terminal write was refused");
});
