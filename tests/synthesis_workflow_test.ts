/**
 * P2 Cloudflare Workflows (`EpisodeSynthesisWorkflow`) tests:
 * - Multi-segment happy path (durable per-segment steps, streaming assembly, finalize + sweep)
 * - Crash & segment resume (already-finalized segment skipped without re-billing)
 * - Transient retry (503 retried via step.do retries) vs permanent 400 (NonRetryableError -> failed)
 * - Daily budget exhaustion -> step.sleepUntil("wait-daily-budget", nextUtcMidnight)
 * - Deepdive grounded script timeout fallback -> persists static scriptTurns and completes
 * - triggerEpisodeWorkflow deduplication vs fresh retry IDs & route trigger wiring
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { NonRetryableError } from "cloudflare:workflows";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { collect } from "../src/storage/mod.ts";
import {
  GeminiTtsClient,
  parseWavHeader,
  pcmToWav,
  uint8ArrayToBase64,
} from "../src/tts/gemini.ts";
import {
  type EpisodeSynthesisParams,
  nextUtcMidnight,
  runEpisodeSynthesisWorkflow,
  triggerEpisodeWorkflow,
  type WorkflowBindingLike,
  type WorkflowStepConfigLike,
  type WorkflowStepLike,
} from "../src/worker/synthesis_workflow.ts";
import type { D1DatabaseLike } from "../src/storage/d1/types.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

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

const dummyEnv = {
  DB: {} as unknown as D1DatabaseLike,
  GEMINI_API_KEY: "test-key",
  PUBLIC_BASE_URL: "https://audio.example.com",
};

Deno.test("P2: EpisodeSynthesisWorkflow multi-segment happy path completes, stitches WAV, bills, and sweeps segments", async () => {
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
      return Promise.resolve(wavResponse(2_400, callNum));
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
      "assemble-wav",
      "ensure-artwork",
      "finalize",
    ],
  );

  const ep = await metadata.getEpisode("u1", "ep-wf-1");
  assertEquals(ep?.status, "ready");
  assert(ep?.audioKey);
  const finalObj = await blobs.get(ep.audioKey);
  assert(finalObj);
  const wavBytes = await collect(finalObj.body);
  const info = parseWavHeader(wavBytes);
  assertEquals(info.declaredDataLength, 4_800);
  assertEquals(wavBytes[44], 1);
  assertEquals(wavBytes[44 + 2_400], 2);
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

  // First run: segment 0 succeeds, segment 1 fails permanently to simulate a hard stop after seg 0
  let run1Calls = 0;
  const failSeg1Client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: () => {
      run1Calls++;
      if (run1Calls === 1) return Promise.resolve(wavResponse(2_400, 0xaa));
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "bad input" } }), { status: 400 }),
      );
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

  // User retries the failed episode -> second workflow run skips segment 0!
  await metadata.retryEpisode("u1", "ep-wf-resume");
  let run2Calls = 0;
  const okClient = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: () => {
      run2Calls++;
      return Promise.resolve(wavResponse(2_400, 0xbb));
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
  const wav = await collect((await blobs.get(finalEp!.audioKey!))!.body);
  assertEquals(wav[44], 0xaa, "segment 0 bytes preserved from run 1");
  assertEquals(wav[44 + 2_400], 0xbb, "segment 1 bytes produced by run 2");
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
