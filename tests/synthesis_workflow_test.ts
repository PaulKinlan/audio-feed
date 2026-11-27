/**
 * P2 Cloudflare Workflows (`EpisodeSynthesisWorkflow`) tests:
 * - Multi-segment happy path (parallel durable steps, MP3 assembly + concurrent artwork, finalize + sweep)
 * - Crash & segment resume (already-finalized segment skipped without re-billing)
 * - Transient retry (503 retried via step.do retries) vs permanent 400 (NonRetryableError -> failed)
 * - Daily budget exhaustion -> step.sleepUntil("wait-daily-budget", nextUtcMidnight)
 * - Parallel TTS batching (bounded concurrency = 3, deterministic ordering, concurrent artwork + assembly)
 * - Padding-aligned chapter timestamps (0.25s inter-segment silence reflected accurately in chapters)
 * - Real D1 (SQLite) parallel batch CAS safety + point-lookup reservation optimization
 * - triggerEpisodeWorkflow deduplication vs fresh retry IDs
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { NonRetryableError } from "cloudflare:workflows";
import { D1MetadataStore } from "../src/storage/d1.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { collect } from "../src/storage/mod.ts";
import { inspectMp3Stream } from "../src/storage/mp3_assembly.ts";
import {
  GeminiTtsClient,
  pcmToWav,
  uint8ArrayToBase64,
} from "../src/tts/gemini.ts";
import {
  type EpisodeSynthesisParams,
  nextUtcMidnight,
  runEpisodeSynthesisWorkflow,
  triggerEpisodeWorkflow,
  TTS_SEGMENT_BATCH_CONCURRENCY,
  type WorkflowBindingLike,
  type WorkflowStepConfigLike,
  type WorkflowStepLike,
} from "../src/worker/synthesis_workflow.ts";
import type { D1DatabaseLike } from "../src/storage/d1/types.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { createTestD1 } from "./sqlite_d1.ts";

interface RecordedStep {
  name: string;
  config?: WorkflowStepConfigLike;
  attempts: number;
}

function createFakeWorkflowStep(opts: { onSleepUntil?: (date: Date) => void } = {}): {
  step: WorkflowStepLike;
  steps: RecordedStep[];
  sleeps: Array<{ name: string; at: Date }>;
} {
  const steps: RecordedStep[] = [];
  const sleeps: Array<{ name: string; at: Date }> = [];

  const step: WorkflowStepLike = {
    async do<T>(
      name: string,
      configOrFn: WorkflowStepConfigLike | (() => Promise<T>),
      maybeFn?: () => Promise<T>,
    ): Promise<T> {
      const config = typeof configOrFn === "function" ? undefined : configOrFn;
      const fn = typeof configOrFn === "function" ? configOrFn : maybeFn!;
      const maxAttempts = (config?.retries?.limit ?? 0) + 1;
      const rec: RecordedStep = { name, config, attempts: 0 };
      steps.push(rec);

      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        rec.attempts = attempt;
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (err instanceof NonRetryableError) {
            throw err;
          }
          if (attempt >= maxAttempts) {
            throw err;
          }
        }
      }
      throw lastErr;
    },
    async sleepUntil(name: string, timestamp: Date | number): Promise<void> {
      const at = timestamp instanceof Date ? timestamp : new Date(timestamp);
      sleeps.push({ name, at });
      opts.onSleepUntil?.(at);
    },
  };

  return { step, steps, sleeps };
}

function wavResponse(pcmByteLength: number, fillByte: number): Response {
  const wav = pcmToWav(new Uint8Array(pcmByteLength).fill(fillByte));
  return new Response(
    JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{ inlineData: { mimeType: "audio/wav", data: uint8ArrayToBase64(wav) } }],
        },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function toneWavResponse(durationSeconds: number, freqHz = 260): Response {
  const sr = 24_000;
  const samples = Math.round(sr * durationSeconds);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    const s = Math.round(10_000 * Math.sin((2 * Math.PI * freqHz * i) / sr));
    view.setInt16(i * 2, s, true);
  }
  const wav = pcmToWav(pcm, { sampleRate: sr, numChannels: 1, bitsPerSample: 16 });
  return new Response(
    JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{ inlineData: { mimeType: "audio/wav", data: uint8ArrayToBase64(wav) } }],
        },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const dummyEnv = {
  DB: {} as unknown as D1DatabaseLike,
  GEMINI_API_KEY: "test-key",
  PUBLIC_BASE_URL: "https://audio.example.com",
};

Deno.test("P2: EpisodeSynthesisWorkflow multi-segment happy path completes, encodes MP3, bills, and sweeps segments", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));
  const body = [
    "Part one: " + "workflows persist every segment durably across retries. ".repeat(28),
    "Part two: " + "streaming assembly stitches segments without blowing Worker RAM. ".repeat(28),
  ].join("\n\n");
  await metadata.putArticle(
    makeArticle({ id: "a1", userId: "u1", sourceId: "inbox", title: "WF Test", content: body }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-1",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "direct",
    }),
  );

  let callNum = 0;
  const ttsClient = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: () => {
      callNum++;
      return Promise.resolve(toneWavResponse(2.0, 220 + callNum * 60));
    },
  });

  const { step, steps } = createFakeWorkflowStep();
  const result = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-1", userId: "u1" }, instanceId: "inst-1" },
    step,
    { metadata, blobs, ttsClient, scriptGenerator: null },
  );

  assertEquals(result.status, "ready");
  assertEquals(callNum, 2);
  assertEquals(
    steps.map((s) => s.name),
    [
      "authorize-and-claim",
      "prepare-plan",
      "tts-segment-0",
      "tts-segment-1",
      "assemble-audio",
      "ensure-artwork",
      "finalize",
    ],
  );

  const ep = await metadata.getEpisode("u1", "ep-wf-1");
  assertEquals(ep?.status, "ready");
  assertEquals(ep?.contentType, "audio/mpeg");
  assert(ep?.audioKey?.endsWith(".mp3"), `expected .mp3 audioKey, got ${ep?.audioKey}`);
  assertEquals(ep?.durationSeconds, 4.25, "2 x 2.0s segments + 1 x 0.25s inter-segment gap");
  assert(ep?.artworkKey, "ensure-artwork must run concurrently and attach artworkKey");

  const finalObj = await blobs.get(ep.audioKey!);
  assert(finalObj);
  assertEquals(finalObj.contentType, "audio/mpeg");
  const mp3Bytes = await collect(finalObj.body);
  const inspected = inspectMp3Stream(mp3Bytes);
  assertEquals(inspected.valid, true, "assembled episode must be valid MPEG Layer III");
  assertEquals(inspected.bitrateKbps, 64);
  assertEquals(inspected.sampleRate, 24_000);
  assertEquals(inspected.channels, 1);
  const rawWavBytes = 44 + 2 * 2.0 * 24_000 * 2;
  assert(
    rawWavBytes / mp3Bytes.byteLength >= 5.0,
    `expected significant MP3 compression vs WAV (${rawWavBytes} -> ${mp3Bytes.byteLength})`,
  );
  assertEquals((await metadata.listSynthesisSegments("u1", "ep-wf-1")).length, 0);
});

Deno.test("P2: EpisodeSynthesisWorkflow resumes after crash and skips already-finalized segment 0", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));
  const body = [
    "Part one: " + "workflows persist every segment durably across retries. ".repeat(28),
    "Part two: " + "streaming assembly stitches segments without blowing Worker RAM. ".repeat(28),
  ].join("\n\n");
  await metadata.putArticle(
    makeArticle({ id: "a1", userId: "u1", sourceId: "inbox", title: "Resume Test", content: body }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-resume",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "direct",
    }),
  );

  // First run: segment 0 succeeds while segment 1 fails permanently in the same parallel batch;
  // Promise.allSettled must allow segment 0 to finish persisting before marking failed.
  let run1Calls = 0;
  const failSeg1Client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: async (_input, init) => {
      run1Calls++;
      const reqBody = String(init?.body ?? "");
      if (reqBody.includes("Part one:")) {
        // Deliberately finish slightly slower than segment 1's immediate 400!
        await new Promise((r) => setTimeout(r, 15));
        return toneWavResponse(1.0, 220);
      }
      return new Response(JSON.stringify({ error: { message: "bad input" } }), { status: 400 });
    },
  });

  const { step: step1 } = createFakeWorkflowStep();
  await assertRejects(() =>
    runEpisodeSynthesisWorkflow(
      dummyEnv,
      { payload: { episodeId: "ep-wf-resume", userId: "u1" }, instanceId: "inst-crash" },
      step1,
      { metadata, blobs, ttsClient: failSeg1Client, scriptGenerator: null },
    )
  );
  assertEquals(run1Calls, 2);
  const failedEp = await metadata.getEpisode("u1", "ep-wf-resume");
  assertEquals(failedEp?.status, "failed");
  const persistedSegs = (await metadata.listSynthesisSegments("u1", "ep-wf-resume")).filter(
    (s) => s.finalized,
  );
  assertEquals(persistedSegs.length, 1, "segment 0 must remain finalized after segment 1 failure");
  const seg0SavedKey = persistedSegs[0]!.audioKey;
  assert(await blobs.head(seg0SavedKey), "segment 0 blob from run 1 must still exist in blob store");

  // User retries the failed episode -> second workflow run skips segment 0!
  await metadata.retryEpisode("u1", "ep-wf-resume");
  let run2Calls = 0;
  const okClient = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: () => {
      run2Calls++;
      return Promise.resolve(toneWavResponse(1.0, 330));
    },
  });
  const { step: step2 } = createFakeWorkflowStep();
  const res2 = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-resume", userId: "u1" }, instanceId: "inst-recover" },
    step2,
    { metadata, blobs, ttsClient: okClient, scriptGenerator: null },
  );
  assertEquals(res2.status, "ready");
  assertEquals(run2Calls, 1, "segment 0 was already finalized; only segment 1 should call Gemini");

  const finalEp = await metadata.getEpisode("u1", "ep-wf-resume");
  assertEquals(finalEp?.contentType, "audio/mpeg");
  assert(finalEp?.audioKey?.endsWith(".mp3"));
  assertEquals(finalEp?.durationSeconds, 2.25);
  const mp3 = await collect((await blobs.get(finalEp!.audioKey!))!.body);
  assertEquals(inspectMp3Stream(mp3).valid, true);
  assertEquals(await blobs.head(seg0SavedKey), null, "swept segment 0 blob after finalize");
});

Deno.test("P2: transient 503 retries inside step.do and succeeds; permanent 400 fails immediately via NonRetryableError", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));
  await metadata.putArticle(
    makeArticle({ id: "a1", userId: "u1", sourceId: "inbox", title: "Retry", content: "Short text." }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-retry",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "direct",
    }),
  );

  let calls = 0;
  const flakyClient = new GeminiTtsClient({
    apiKey: "test-key",
    retryOn: "none",
    fetchFn: () => {
      calls++;
      if (calls <= 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }),
        );
      }
      return Promise.resolve(wavResponse(1_200, 0x55));
    },
  });

  const { step, steps } = createFakeWorkflowStep();
  const res = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-retry", userId: "u1" }, instanceId: "inst-503" },
    step,
    { metadata, blobs, ttsClient: flakyClient, scriptGenerator: null },
  );
  assertEquals(res.status, "ready");
  assertEquals(calls, 3);
  const segStep = steps.find((s) => s.name === "tts-segment-0");
  assertEquals(segStep?.attempts, 3, "503 must retry inside step.do");

  // Permanent 400 throws NonRetryableError on attempt 1 (no wasted retries)
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-400",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "direct",
    }),
  );
  let badCalls = 0;
  const badClient = new GeminiTtsClient({
    apiKey: "test-key",
    retryOn: "none",
    fetchFn: () => {
      badCalls++;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "invalid voice" } }), { status: 400 }),
      );
    },
  });
  const { step: badStep, steps: badSteps } = createFakeWorkflowStep();
  const err = await assertRejects(() =>
    runEpisodeSynthesisWorkflow(
      dummyEnv,
      { payload: { episodeId: "ep-wf-400", userId: "u1" }, instanceId: "inst-400" },
      badStep,
      { metadata, blobs, ttsClient: badClient, scriptGenerator: null },
    )
  );
  assert(err instanceof NonRetryableError);
  assertEquals(badCalls, 1, "permanent 400 must not retry");
  assertEquals(badSteps.find((s) => s.name === "tts-segment-0")?.attempts, 1);
  const failed = await metadata.getEpisode("u1", "ep-wf-400");
  assertEquals(failed?.status, "failed");
  assertStringIncludes(failed?.error ?? "", "invalid voice");
});

Deno.test("P2: daily budget exhaustion sleeps until next UTC midnight via step.sleepUntil then completes", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved", dailyEpisodeBudget: 1 }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));
  await metadata.putArticle(
    makeArticle({ id: "a1", userId: "u1", sourceId: "inbox", title: "Budget", content: "Hello." }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-budget",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a1",
      status: "pending",
      mode: "direct",
    }),
  );

  let currentNowMs = Date.parse("2026-11-27T18:30:00.000Z");
  // Exhaust today's 1-episode budget
  await metadata.recordSynthesis("u1", 1000, new Date(currentNowMs));

  const { step, sleeps } = createFakeWorkflowStep({
    onSleepUntil: (wakeAt) => {
      currentNowMs = wakeAt.getTime();
    },
  });
  const ttsClient = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: () => Promise.resolve(wavResponse(1_200, 0x42)),
  });

  const res = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-budget", userId: "u1" }, instanceId: "inst-budget" },
    step,
    { metadata, blobs, ttsClient, scriptGenerator: null, now: () => currentNowMs },
  );
  assertEquals(res.status, "ready");
  assertEquals(sleeps.length, 1);
  assertEquals(sleeps[0]!.name, "wait-daily-budget");
  assertEquals(sleeps[0]!.at.toISOString(), "2026-11-28T00:00:00.000Z");
  assertEquals(nextUtcMidnight(Date.parse("2026-11-27T18:30:00.000Z")).toISOString(), "2026-11-28T00:00:00.000Z");
});

Deno.test("P2: triggerEpisodeWorkflow deduplicates running instances and creates fresh unique IDs on retry", async () => {
  const created: Array<{ id: string; params: EpisodeSynthesisParams }> = [];
  const statuses = new Map<string, string>();

  const binding: WorkflowBindingLike<EpisodeSynthesisParams> = {
    async create(opts) {
      const id = opts!.id!;
      if (statuses.has(id)) {
        throw new Error(`Workflow instance "${id}" already exists`);
      }
      statuses.set(id, "running");
      created.push({ id, params: opts!.params! });
      return { id };
    },
    async get(id) {
      return {
        id,
        status: () => Promise.resolve({ status: statuses.get(id) ?? "unknown" }),
      };
    },
  };

  // First enqueue creates deterministic id `ep-ep1`
  await triggerEpisodeWorkflow(binding, "ep1", "u1");
  assertEquals(created.length, 1);
  assertEquals(created[0]!.id, "ep-ep1");

  // Duplicate trigger while still running is an idempotent no-op
  await triggerEpisodeWorkflow(binding, "ep1", "u1");
  assertEquals(created.length, 1);

  // Explicit retry (`fresh: true`) creates a brand new unique ID `ep-ep1-r...`
  await triggerEpisodeWorkflow(binding, "ep1", "u1", { fresh: true });
  assertEquals(created.length, 2);
  assert(created[1]!.id.startsWith("ep-ep1-r"), `expected fresh retry id, got ${created[1]!.id}`);

  // If the original deterministic instance terminated/errored, a subsequent cron safety-net trigger creates a recovery ID
  statuses.set("ep-ep1", "errored");
  await triggerEpisodeWorkflow(binding, "ep1", "u1");
  assertEquals(created.length, 3);
  assert(created[2]!.id.startsWith("ep-ep1-"));
});

Deno.test("P2: EpisodeSynthesisWorkflow parallelizes TTS in bounded batches of 3, runs artwork concurrently with assembly, and preserves segment order", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));

  // 7 heading-delimited segments -> batches [0,1,2], [3,4,5], [6]
  const sectionTitles = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
  const content = [
    "Marker-0: Opening introduction setting up the parallel synthesis pipeline.",
    ...sectionTitles.map((title, idx) =>
      `## ${title}\n\nMarker-${idx + 1}: Distinct spoken content for section ${title}.`
    ),
  ].join("\n\n");
  await metadata.putArticle(
    makeArticle({
      id: "a-par",
      userId: "u1",
      sourceId: "inbox",
      title: "Parallel Batching Test",
      content,
    }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-par",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a-par",
      status: "pending",
      mode: "direct",
    }),
  );

  // Track exact concurrency and resolve out-of-order within each batch (first slower than third).
  let inFlight = 0;
  let maxInFlight = 0;
  const startedOrder: number[] = [];
  const completedOrder: number[] = [];
  let totalCalls = 0;

  const ttsClient = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: async (_input, init) => {
      totalCalls++;
      const reqBody = String(init?.body ?? "");
      const m = /Marker-(\d+):/.exec(reqBody);
      assert(m, `expected Marker-N in request body: ${reqBody.slice(0, 120)}`);
      const secNum = Number(m[1]);
      startedOrder.push(secNum);
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Earlier index in each batch takes longer so completion order is deliberately reversed!
      const delayMs = (TTS_SEGMENT_BATCH_CONCURRENCY - (secNum % TTS_SEGMENT_BATCH_CONCURRENCY)) * 12;
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      completedOrder.push(secNum);
      // Distinct durations (16s, 18s, 20s, 22s, 24s, 26s, 28s) so chapter timestamps
      // mathematically prove deterministic [0..6] ordering despite out-of-order completion!
      return toneWavResponse(16 + secNum * 2, 200 + secNum * 30);
    },
  });

  // Track whether assemble-audio and ensure-artwork actually overlap in flight!
  let stage4InFlight = 0;
  let stage4MaxConcurrent = 0;
  const activeStage4Steps = new Set<string>();
  const { step: baseStep, steps } = createFakeWorkflowStep();
  const instrumentedStep: WorkflowStepLike = {
    async do<T>(
      name: string,
      configOrFn: WorkflowStepConfigLike | (() => Promise<T>),
      maybeFn?: () => Promise<T>,
    ): Promise<T> {
      const fn = typeof configOrFn === "function" ? configOrFn : maybeFn!;
      const config = typeof configOrFn === "function" ? undefined : configOrFn;
      const wrapped = async (): Promise<T> => {
        if (name === "assemble-audio" || name === "ensure-artwork") {
          activeStage4Steps.add(name);
          stage4InFlight++;
          if (stage4InFlight > stage4MaxConcurrent) stage4MaxConcurrent = stage4InFlight;
          await new Promise((r) => setTimeout(r, 15));
        }
        try {
          return await fn();
        } finally {
          if (name === "assemble-audio" || name === "ensure-artwork") {
            stage4InFlight--;
          }
        }
      };
      return config ? baseStep.do(name, config, wrapped) : baseStep.do(name, wrapped);
    },
    sleepUntil: (name, ts) => baseStep.sleepUntil(name, ts),
  };

  const res = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-par", userId: "u1" }, instanceId: "inst-par" },
    instrumentedStep,
    { metadata, blobs, ttsClient, scriptGenerator: null },
  );

  assertEquals(res.status, "ready");
  assertEquals(totalCalls, 7);
  assertEquals(
    maxInFlight,
    TTS_SEGMENT_BATCH_CONCURRENCY,
    "peak TTS concurrency must equal TTS_SEGMENT_BATCH_CONCURRENCY (3)",
  );
  // Batch 0 [0,1,2] must complete before Batch 1 [3,4,5] starts, and Batch 1 before [6]
  assertEquals(
    startedOrder.slice(0, 3).sort((a, b) => a - b),
    [0, 1, 2],
  );
  assertEquals(
    startedOrder.slice(3, 6).sort((a, b) => a - b),
    [3, 4, 5],
  );
  assertEquals(startedOrder[6], 6);
  // Verify out-of-order completion occurred inside batch 0 (2 finished before 0)
  assert(
    completedOrder.indexOf(2) < completedOrder.indexOf(0),
    `expected segment 2 to finish before segment 0 in parallel batch, got ${JSON.stringify(completedOrder)}`,
  );
  // Verify assemble-audio and ensure-artwork ran concurrently!
  assertEquals(stage4MaxConcurrent, 2, "assemble-audio and ensure-artwork must overlap concurrently");
  assert(activeStage4Steps.has("assemble-audio") && activeStage4Steps.has("ensure-artwork"));

  const ep = await metadata.getEpisode("u1", "ep-wf-par");
  assertEquals(ep?.status, "ready");
  assertEquals(ep?.contentType, "audio/mpeg");
  assert(ep?.audioKey?.endsWith(".mp3"));
  // Speech = 16+18+20+22+24+26+28 = 154.0s + 6 gaps * 0.25s = 155.50s
  assertEquals(ep?.durationSeconds, 155.5);
  // Exact chapter starts prove segments stayed in strict [0,1,2,3,4,5,6] order:
  // 0, 16.25->16, 34.5->35, 54.75->55, 77.0->77, 101.25->101, 127.5->128
  assertEquals(ep?.chapters, [
    { startTime: 0, title: "Introduction" },
    { startTime: 16, title: "Alpha" },
    { startTime: 35, title: "Beta" },
    { startTime: 55, title: "Gamma" },
    { startTime: 77, title: "Delta" },
    { startTime: 101, title: "Epsilon" },
    { startTime: 128, title: "Zeta" },
  ]);
  const mp3Bytes = await collect((await blobs.get(ep!.audioKey!))!.body);
  assertEquals(inspectMp3Stream(mp3Bytes).valid, true);
  assertEquals(steps.filter((s) => s.name.startsWith("tts-segment-")).length, 7);
});

Deno.test("P2: EpisodeSynthesisWorkflow chapters accurately account for 0.25s inter-segment padding", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1" }));

  const content = [
    "Intro paragraph establishing the thesis of this engineering deep dive.",
    "## Architecture Overview",
    "This section explains the streaming audio architecture in detail.",
    "## Compression Benchmarks",
    "This section measures the sixfold reduction from WAV to 64 kbps MP3.",
    "## Operational Rollout",
    "This final section summarizes deployment and monitoring checks.",
  ].join("\n\n");

  await metadata.putArticle(
    makeArticle({
      id: "a-chap",
      userId: "u1",
      sourceId: "inbox",
      title: "Chapter Timing",
      content,
    }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-chap",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a-chap",
      status: "pending",
      mode: "direct",
    }),
  );

  // Each of the 4 chaptered segments returns exactly 20.00 seconds of audio.
  // With 0.25s padding between segments:
  //   seg 0: starts 0.00s  -> Chapter 0 ("Introduction") = 0
  //   seg 1: starts 20.25s -> Chapter 1 ("Architecture Overview") = Math.round(20.25) = 20
  //   seg 2: starts 40.50s -> Chapter 2 ("Compression Benchmarks") = Math.round(40.50) = 41 (vs 40 without padding!)
  //   seg 3: starts 60.75s -> Chapter 3 ("Operational Rollout") = Math.round(60.75) = 61 (vs 60 without padding!)
  //   total: 80.75s
  const ttsClient = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: () => Promise.resolve(toneWavResponse(20.0, 240)),
  });

  const { step } = createFakeWorkflowStep();
  const res = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-chap", userId: "u1" }, instanceId: "inst-chap" },
    step,
    { metadata, blobs, ttsClient, scriptGenerator: null },
  );

  assertEquals(res.status, "ready");
  const ep = await metadata.getEpisode("u1", "ep-wf-chap");
  assertEquals(ep?.contentType, "audio/mpeg");
  assertEquals(ep?.durationSeconds, 80.75);
  assertEquals(ep?.chapters, [
    { startTime: 0, title: "Introduction" },
    { startTime: 20, title: "Architecture Overview" },
    { startTime: 41, title: "Compression Benchmarks" },
    { startTime: 61, title: "Operational Rollout" },
  ]);
});

Deno.test("P2: real D1 (SQLite) handles 6-segment parallel batches with zero CAS races and zero listSynthesisSegments scans on fresh runs", async () => {
  const d1 = createTestD1();
  const metadata = new D1MetadataStore(d1);
  const blobs = new MemoryBlobStore();

  try {
    await metadata.putUser(makeUser({ id: "u-d1", status: "approved" }));
    await metadata.putSource(makeSource({ id: "inbox", userId: "u-d1" }));
    const body = [
      "Opening summary paragraph for the SQLite D1 parallel workflow test.",
      ...Array.from({ length: 5 }, (_, i) =>
        `## Part ${i + 2}\n\nDurable sqlite parallel batch test content block ${i + 2}.`
      ),
    ].join("\n\n");
    await metadata.putArticle(
      makeArticle({ id: "a-d1", userId: "u-d1", sourceId: "inbox", title: "D1 Parallel", content: body }),
    );
    await metadata.putEpisode(
      makeEpisode({
        id: "ep-wf-d1",
        userId: "u-d1",
        sourceId: "inbox",
        articleId: "a-d1",
        status: "pending",
        mode: "direct",
      }),
    );

    // Count listSynthesisSegments calls: fresh Stage 3 must use point-lookup reserveSynthesisSegment
    // with ZERO listSynthesisSegments scans (only 1 call total during Stage 5 sweep!).
    let listSegCalls = 0;
    const origList = metadata.listSynthesisSegments.bind(metadata);
    metadata.listSynthesisSegments = (uid, eid) => {
      listSegCalls++;
      return origList(uid, eid);
    };

    let ttsCalls = 0;
    const ttsClient = new GeminiTtsClient({
      apiKey: "test-key",
      fetchFn: async () => {
        ttsCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return toneWavResponse(0.8, 220 + ttsCalls * 20);
      },
    });

    const { step } = createFakeWorkflowStep();
    const res = await runEpisodeSynthesisWorkflow(
      dummyEnv,
      { payload: { episodeId: "ep-wf-d1", userId: "u-d1" }, instanceId: "inst-d1-par" },
      step,
      { metadata, blobs, ttsClient, scriptGenerator: null },
    );

    assertEquals(res.status, "ready");
    assertEquals(ttsCalls, 6);
    assertEquals(
      listSegCalls,
      1,
      "fresh 6-segment workflow must only call listSynthesisSegments once (during finalize sweep), not per segment",
    );

    const ep = await metadata.getEpisode("u-d1", "ep-wf-d1");
    assertEquals(ep?.status, "ready");
    assertEquals(ep?.contentType, "audio/mpeg");
    assert(ep?.audioKey?.endsWith(".mp3"));
    assertEquals((await origList("u-d1", "ep-wf-d1")).length, 0);
    const mp3 = await collect((await blobs.get(ep!.audioKey!))!.body);
    assertEquals(inspectMp3Stream(mp3).valid, true);
  } finally {
    d1.close();
  }
});
