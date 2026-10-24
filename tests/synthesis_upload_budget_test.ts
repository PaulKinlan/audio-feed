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
import { runSynthesisBatch, TERMINAL_STAGING_MARKER_HASH } from "../src/worker/synthesis.ts";
import { decodedFromWav, pcmToWav } from "../src/tts/gemini.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { InvocationClock } from "../src/synthesis/limits.ts";
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
/**
 * A budget clock the test owns (audio-feed-lpusp; the krrws/on12e fake-clock mechanism,
 * inlined locally so this bead's gate stays FOCUSED - a shared tests/*.ts helper would
 * trigger the full-suite fallback, which cannot fit its bound under the current CPU
 * steal). Consolidate onto tests/fixtures/invocation_clock.ts when audio-feed-on12e
 * lands. `now()` never moves and timers never fire until `advance()` moves them; the row
 * decides where every deadline lands.
 */
function controlledInvocationClock(startMs = 1_000_000) {
  let nowMs = startMs;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const clock: InvocationClock = {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const timer = { at: nowMs + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  return {
    clock,
    get nowMs() {
      return nowMs;
    },
    async advance(ms: number): Promise<void> {
      const target = nowMs + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        nowMs = Math.max(nowMs, due.at);
        due.fn();
        for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      nowMs = target;
    },
  };
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
  // audio-feed-lpusp: the injected budget clock - tick 1's refusal and tick 2's upload
  // become decisions on a timeline the test owns (see the synth stub below).
  const time = controlledInvocationClock();
  const synth = () => {
    synthCalls++;
    if (synthCalls === 1) {
      // audio-feed-lpusp: the first call's delay used to be 1,200 REAL ms, and the
      // row's two ticks measured REMAINING budget on the real clock - so on a loaded
      // host pre-stage work alone consumed tick 2's fresh budget before the put started
      // (putCalls 0 vs 'second tick uploads the audio', the union-gate red). Now the
      // delay is an advance of the injected budget clock: tick 1's remaining shrinks by
      // decision (the size-vs-remaining preflight refuses deterministically), and tick
      // 2's fresh invocation starts with the clock effectively unmoved.
      return new Promise<DecodedAudioResult>((r) =>
        setTimeout(() => {
          time.advance(1_200).then(() => r(audio));
        }, 0)
      );
    }
    return Promise.resolve(audio);
  };

  const r1 = await runSynthesisBatch(ctx, synth, {
    owner: "aqms-resume-1",
    maxInvocationDurationMs: 2_500,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 100,
    flushMarginMs: 100,
    clock: time.clock,
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
    clock: time.clock,
  });
  assertEquals(putCalls, 1, "second tick uploads the audio");
  assertEquals(r2.ready.length, 1, "episode completes on the retry tick");
  const ep2 = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(ep2?.status, "ready");
  assertEquals(ep2?.uploadRetry, undefined, "uploadRetry cleared on completion");
});

Deno.test("audio-feed-wnv8: a terminal PUT whose invocation deadline already expired is SKIPPED, and the skip carries the deadline and the observed time", async () => {
  // ACCEPTANCE, WITH THE EXPECTED FAILURE SIGNATURE NAMED IN ADVANCE. This test asserts BEHAVIOUR (a PUT
  // that is not made) and not a record alone. With the fix reverted - the abort check removed and the
  // PUT attempted as before - the FIRST assertion to fail is
  // "THE BEHAVIOUR: a PUT whose invocation deadline had already passed must not be attempted",
  // reported as expected 0 against an actual 1 on `putCalls`. The control at the end of this test still
  // passes in that state (a healthy invocation performs its PUT, writes `entering`, and writes no skip
  // record), which is what makes the red evidence about the new decision rather than about a broken
  // terminal path.
  const episodeId = "ep-wnv8-expired-deadline";
  const { ctx, stores } = await setupEnv(episodeId);
  const audio = fakeAudio(1_024);
  let putCalls = 0;
  const realPut = stores.blobs.put.bind(stores.blobs);
  stores.blobs.put = (...args) => {
    putCalls++;
    return realPut(...args);
  };

  // PARK THE WINDOW RATHER THAN RACE IT: the deadline expires inside the durable reservation of the
  // terminal staging key - the slowest await between the last abort check and the transfer. Holding it
  // open until the test releases it makes the expiry deterministic instead of a sleep that has to be
  // longer than the budget. Only the TERMINAL reservation is parked; per-segment reservations during
  // synthesis run normally.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realReserve = stores.metadata.reserveSynthesisSegment.bind(stores.metadata);
  let parked = 0;
  stores.metadata.reserveSynthesisSegment = async (...args: Parameters<typeof realReserve>) => {
    const segment = args[2] as { textHash?: string } | undefined;
    if (segment?.textHash === TERMINAL_STAGING_MARKER_HASH) {
      parked++;
      await gate;
    }
    return await realReserve(...args);
  };

  type Row = {
    type?: string;
    phase?: string;
    severity?: string;
    message?: string;
    context?: Record<string, unknown>;
  };
  const readLogs = async () => (await stores.metadata.listLogs({ limit: 200 })) as unknown as Row[];
  // A BOUNDED wait for the resumed worker to finish writing, so the assertion sees the real store rather
  // than a sleep long enough to be believed. The bound stays (2s is ~100x a KV write), but the EXPIRY IS
  // LOUD (audio-feed-5mwy). It used to `return rows` and let the assertions below interpret whatever the
  // short list implied, which cost two things: a record that was never written and a machine that was too
  // slow produced the SAME failure text, and the negative assertion below - no `entering` record for a
  // refused PUT - was vacuously TRUE on an empty list. A wait that gives up quietly can therefore read as
  // coverage without asserting anything. Same shape as the poll in tests/view_transitions_test.ts: throw,
  // and name both what was expected and what was seen.
  const untilSettled = async (
    done: (rows: Row[]) => boolean,
    waitingFor: string,
  ): Promise<Row[]> => {
    const budgetMs = 2_000;
    const limit = Date.now() + budgetMs;
    let rows = await readLogs();
    while (!done(rows)) {
      if (Date.now() > limit) {
        const phases = [...new Set(rows.map((row) => row.phase).filter((p) => p !== undefined))];
        throw new Error(
          `the store did not settle within ${budgetMs}ms while waiting for ${waitingFor}: read ` +
            `${rows.length} record(s), phases seen ${
              JSON.stringify(phases)
            }. A missing record and a ` +
            `loaded machine must not look alike - re-run on an idle VM before reading this as a product ` +
            `defect (audio-feed-5mwy).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows = await readLogs();
    }
    return rows;
  };

  const running = runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    owner: "wnv8-expired-1",
    maxInvocationDurationMs: 500,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 10,
    flushMarginMs: 5,
  });
  const result = await running;
  assertEquals(parked, 1, "the terminal reservation is the await the deadline expires inside");
  release();
  const logs = await untilSettled(
    (rows) => rows.some((row) => row.phase === "skipped"),
    "the resumed worker to write the synthesis.upload|skipped record",
  );

  // (1) THE BEHAVIOUR. This is the assertion the acceptance names, and it is about a decision rather
  // than a record: the doomed transfer is never handed to the storage layer.
  assertEquals(
    putCalls,
    0,
    "THE BEHAVIOUR: a PUT whose invocation deadline had already passed must not be attempted",
  );

  // (2) THE RECORD. A skip with no trace would be the silence this bead exists to end, and the two
  // numbers are what make it auditable: the deadline it was measured against and the time it observed.
  const skip = logs.find((row) => row.type === "synthesis.upload" && row.phase === "skipped");
  assert(
    skip,
    "the skip must be RECORDED, not silent: a skipped attempt and a never-attempted one must not look alike",
  );
  assertEquals(skip.severity, "warn", "a terminal upload abandoned to the deadline is a finding");
  assertEquals(skip.context?.deadlineMs, 500, "the invocation deadline it was measured against");
  const observed = skip.context?.observedMs as number | undefined;
  assert(
    typeof observed === "number" && observed >= 400,
    `observedMs must show the invocation had nearly spent its budget when the check ran (got ${observed})`,
  );
  // WHAT HAD ALREADY FIRED, by name, and the fact that matters more than the arithmetic: a stage's own
  // cutoff is the budget minus its flush margin (`flushMarginMs`), so observedMs can legitimately sit a
  // few milliseconds BELOW deadlineMs here. The abort reason is what makes this a skip.
  assertEquals(
    skip.context?.abortReason,
    "InvocationBudgetAbortError",
    "the record names the deadline that had already fired",
  );
  assertEquals(
    typeof skip.context?.bytesAttempted === "number" && skip.context.bytesAttempted > 0,
    true,
    "and what it was about to send",
  );
  assertStringIncludes(skip.message ?? "", "synthesis upload SKIPPED");
  assertStringIncludes(skip.message ?? "", "the invocation had already aborted");
  assertStringIncludes(skip.message ?? "", "InvocationBudgetAbortError");

  // (3) THE JOINT SIGNATURE KEEPS ITS MEANING: no `entering` record for a PUT that was never attempted,
  // so `entering` still means bytes were handed to storage (the read amhn depends on).
  assertEquals(
    logs.filter((row) => row.type === "synthesis.upload" && row.phase === "entering").length,
    0,
    "an `entering` record must not be written for an attempt that was refused",
  );

  // The claim is yielded resumably, exactly as the aborted transfer would have left it: this decision
  // changes what is attempted, not how a spent invocation ends.
  assertEquals(result.yielded.length, 1, "the claim yields rather than being abandoned");
  const episode = await stores.metadata.getEpisode("user-1", episodeId);
  assertEquals(episode?.status, "pending");
  assertEquals(episode?.phase, "upload_retry");

  // (4) CONTROL THAT PASSES - a deadline that has NOT expired performs the transfer, writes `entering`,
  // and writes no skip record. Without this the assertions above could be satisfied by a terminal path
  // that simply no longer works.
  const healthyId = "ep-wnv8-healthy";
  const healthy = await setupEnv(healthyId);
  let healthyPuts = 0;
  const realHealthyPut = healthy.stores.blobs.put.bind(healthy.stores.blobs);
  healthy.stores.blobs.put = (...args) => {
    healthyPuts++;
    return realHealthyPut(...args);
  };
  const completed = await runSynthesisBatch(healthy.ctx, () => Promise.resolve(fakeAudio(1_024)), {
    owner: "wnv8-healthy-1",
    maxInvocationDurationMs: 10_000,
    estimatedTurnDurationMs: 1,
    estimatedUploadDurationMs: 10,
    flushMarginMs: 5,
  });
  const healthyLogs = (await healthy.stores.metadata.listLogs({ limit: 200 })) as unknown as Row[];
  assertEquals(healthyPuts, 1, "CONTROL: a healthy invocation still performs its transfer");
  assertEquals(
    healthyLogs.filter((row) => row.type === "synthesis.upload" && row.phase === "entering").length,
    1,
    "CONTROL: `entering` is still written when an attempt IS made",
  );
  assertEquals(
    healthyLogs.filter((row) => row.phase === "skipped").length,
    0,
    "CONTROL: nothing is skipped when nothing expires",
  );
  assertEquals(completed.ready.length, 1, "CONTROL: and the episode completes");
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
