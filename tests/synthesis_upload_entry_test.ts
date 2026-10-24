/**
 * The terminal upload's ENTRY record (audio-feed-amhn).
 *
 * WHY THIS FILE EXISTS. `markStage` records a stage on the way OUT, so a stage KILLED mid-flight
 * leaves no mark, which is the same shape as a stage that was never reached. That is what made the
 * 2026-10-14 outage take a night to locate: production showed thirteen `tts` marks, thirteen `verify`
 * marks and ONE `upload` mark while twelve episodes were being killed inside the terminal put, and the
 * missing marks could not distinguish "never reached" from "killed". The `synthesis.upload` record is
 * written BEFORE the put is awaited and carries the payload size being attempted - the one fact no
 * other record can supply, because `byteLength` is written only on completion.
 *
 * WHAT THESE TESTS DRIVE: the real path - a real episode, the real `runSynthesisBatch`, the memory
 * stores - rather than asserting that a helper was called, because the property at stake is what ends
 * up in the log store and WHERE it sits relative to the completion mark.
 */
import { assert, assertEquals } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { decodedFromWav, pcmToWav } from "../src/tts/gemini.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "https://audio.example.com",
  adminToken: "test-admin-token",
};

function fakeAudio(byteLength = 4_800, durationSeconds = 10): DecodedAudioResult {
  const wav = pcmToWav(new Uint8Array(byteLength), {
    sampleRate: 24000,
    numChannels: 1,
    bitsPerSample: 8,
  });
  return { ...decodedFromWav(wav), durationSeconds };
}

async function seedEpisode(id: string) {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: "user-1" }));
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "inbox",
      content: "First paragraph. Second paragraph.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id,
      userId: "user-1",
      sourceId: "inbox",
      articleId: "article-1",
      status: "pending",
      mode: "direct",
    }),
  );
  return { ctx: { config, stores }, stores };
}

type LogRecord = Awaited<ReturnType<Stores["metadata"]["listLogs"]>>[number];

Deno.test("amhn: the terminal upload records its ENTRY, with the bytes attempted, BEFORE the put completes", async () => {
  const id = "ep-amhn-entry";
  const { ctx, stores } = await seedEpisode(id);
  const audio = fakeAudio();
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    batchSize: 1,
    owner: "amhn-entry",
    maxAttempts: 1,
  });
  assertEquals(run.ready.length, 1, "the seeded episode must actually have been synthesized");

  const logs = await stores.metadata.listLogs();
  const entries = logs.filter((log) => log.type === "synthesis.upload");
  assertEquals(entries.length, 1, "entering the terminal put must leave exactly one entry record");
  const entry = entries[0]!;

  assertEquals(entry.phase, "entering");
  assertEquals(entry.severity, "info", "an entry is not a failure");
  assertEquals(entry.episodeId, id, "the episode must be on the ROOT field, where readers join");
  assert(
    (entry.message ?? "").includes("ENTERING"),
    "the message must say the put was ENTERED, so a reader does not have to infer it",
  );

  // THE FACT NO OTHER RECORD CARRIES, asserted against what was actually written rather than against
  // a constant: the size in the entry record must equal the size the completed episode ended up with.
  const stored = await stores.metadata.getEpisode("user-1", id);
  const attempted = entry.context?.bytesAttempted;
  assert(typeof attempted === "number", "the entry record must carry the byte count attempted");
  assert(attempted! > 0, "a synthesized episode's payload is not empty");
  assertEquals(
    attempted,
    stored?.byteLength,
    "the bytes ATTEMPTED must match the bytes actually written, so a failed attempt's size is a fact",
  );

  // audio-feed-g7s1: THE WORKER CALL SITE, PINNED INDEPENDENTLY OF THE STORAGE PLUMBING. Measured with
  // the reviewer's revert test: with `bytesAttempted: bytes.length` deleted from the worker's terminal
  // checkpoint, every row in this file AND in tests/claim_expiry_evidence_test.ts stays green while the
  // size silently stops reaching the abandonment and expiry records. Those rows cannot catch it - they
  // call `touchEpisodeClaim` directly, so they prove the store CAN carry the value and say nothing about
  // whether the worker ever passes it. This record is written by the WORKER's own checkpoint call, so
  // the assertion below fails the moment the worker stops passing the value, and only then.
  const terminalCheckpoint = logs.find(
    (log) => log.type === "claim.lifecycle" && log.phase === "uploading_audio",
  );
  assert(
    terminalCheckpoint,
    "the worker's terminal checkpoint must leave a claim.lifecycle record",
  );
  assertEquals(
    terminalCheckpoint.context?.bytesAttempted,
    attempted,
    "the size the worker CHECKPOINTED must reach the record, not merely be expressible by the store",
  );

  // THE WHOLE POINT, ASSERTED AS AN ORDER: the entry record exists, and it comes BEFORE the stage mark
  // that only a COMPLETED put can produce. If the put had been killed between them, the entry record
  // would still be there - that is the evidence the 2026-10-14 reconstruction had to infer.
  const invocations = logs.filter((log) => log.type === "synthesis.invocation");
  assertEquals(
    entry.correlationId,
    invocations[0]?.correlationId,
    "entry must attach to its invocation",
  );
  const uploadCompletion = logs.find(
    (log) => log.type === "synthesis.stage" && log.phase === "upload",
  );
  assert(uploadCompletion, "the successful path must still record the upload stage's completion");
  assert(
    entry.seq < uploadCompletion!.seq,
    "the entry record must precede the completion mark: that ordering is what survives a kill",
  );
  // huh4 IS NOT REGRESSED: the completion mark still carries the duration the entry record cannot.
  assert(
    (uploadCompletion!.durationMs ?? -1) >= 0,
    "the completion mark must still carry a real duration",
  );
});

Deno.test("amhn: the entry record is durable WHILE the PUT is in flight, not merely ordered before its mark", async () => {
  // REVIEW FINDING 3, AND IT IS THE ROW THAT PINS THE ACTUAL PROPERTY. Asserting `entry.seq <
  // completion.seq` would still pass if the record were written after a SUCCESSFUL put but before its
  // stage mark - so it pins an ordering, not the claim. This holds the blob put UNRESOLVED and reads the
  // store while the transfer is in flight: the record must already be there, which is the only shape that
  // survives a kill, because a kill gives the code no chance to write anything afterwards.
  const id = "ep-amhn-inflight";
  const { ctx, stores } = await seedEpisode(id);
  const audio = fakeAudio();
  const origPut = stores.blobs.put.bind(stores.blobs);
  let entered = false;
  let markEntered!: () => void;
  let release!: () => void;
  const enteredSignal = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  stores.blobs.put = async (key, data, opts) => {
    entered = true;
    markEntered();
    await held;
    return await origPut(key, data, opts);
  };

  const run = runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    batchSize: 1,
    owner: "amhn-inflight",
    maxAttempts: 1,
  });
  try {
    // Bounded, and it RESOLVES on timeout instead of rejecting so a regression fails an assertion rather
    // than hanging the suite.
    // 2s hang guard ceiling around in-memory batch execution reaching put hook: fails assertion on stall rather than timing out the runner.
    await Promise.race([
      enteredSignal,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    assert(entered, "the terminal put must be entered by this point");

    const during = await stores.metadata.listLogs();
    const entries = during.filter((log) => log.type === "synthesis.upload");
    assertEquals(
      entries.length,
      1,
      "the entering record must ALREADY be durable while the put is still in flight",
    );
    const attempted = entries[0]?.context?.bytesAttempted;
    assert(
      typeof attempted === "number" && attempted > 0,
      "and it must already carry the bytes attempted, which is the fact a kill would otherwise lose",
    );
    assertEquals(
      during.filter((log) => log.type === "synthesis.stage" && log.phase === "upload").length,
      0,
      "no completion mark can exist yet: the put has not returned",
    );
  } finally {
    release();
  }

  const result = await run;
  assertEquals(result.ready.length, 1, "the episode must still complete once the put is released");
});

Deno.test("amhn: an invocation that never reaches the terminal put writes no entry record (control)", async () => {
  // THE CONTROL, AND IT IS THE HALF THAT MAKES THE ROW ABOVE MEAN SOMETHING. If the entry record were
  // written per invocation rather than at the put, the row above would pass while the record stopped
  // locating anything - it would be present for failures that never reached the upload at all.
  const id = "ep-amhn-no-put";
  const { ctx, stores } = await seedEpisode(id);
  await runSynthesisBatch(
    ctx,
    () => {
      throw new Error("provider stalled inside the TTS stage");
    },
    { batchSize: 1, owner: "amhn-no-put", maxAttempts: 1 },
  );

  const logs = await stores.metadata.listLogs();
  assertEquals(
    logs.filter((log) => log.type === "synthesis.upload").length,
    0,
    "a run that died before the terminal put must not claim the put was entered",
  );
  assert(
    logs.some((log) => log.type === "synthesis.stage" && log.phase === "tts"),
    "the control must still be a real synthesis attempt, not an empty run",
  );
});
