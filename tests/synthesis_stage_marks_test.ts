/**
 * Stage-level marks inside a synthesis invocation (audio-feed-huh4).
 *
 * WHY THIS FILE EXISTS AND WHAT IT PROVES. A stage used to announce its phase on ENTRY and nothing
 * until the next one, so a stalled TTS call and slow honest work were the same shape in the store.
 * These tests drive the REAL path - a real episode, the real runSynthesisBatch, the memory stores -
 * rather than asserting that a helper was called, because the property at stake is what ends up in
 * the log store:
 *
 *  1. a stage that THROWS is still marked (the finally, which is the case most worth having);
 *  2. marks carry the invocation's correlationId, so a stage attaches to its invocation;
 *  3. the count is BOUNDED, because the store is a shared time-windowed log and an uncapped mark
 *     would scale with batch size times retry count.
 *
 * Test 2 deliberately seeds one episode MORE than the cap can cover, so the cap is exercised by the
 * success path rather than by looping a failure, and the suppressed count is asserted to be reported
 * rather than silently dropped.
 */
import { assert, assertEquals } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { decodedFromWav, pcmToWav } from "../src/tts/gemini.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { defaultStageMarkCap, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "https://audio.example.com",
  adminToken: "test-admin-token",
};

/** The cap, restated here so the assertion is against the promise and not against the code. */
const STAGE_MARK_CAP = 15;

function fakeAudio(byteLength = 4_800, durationSeconds = 10): DecodedAudioResult {
  const wav = pcmToWav(new Uint8Array(byteLength), {
    sampleRate: 24000,
    numChannels: 1,
    bitsPerSample: 8,
  });
  return { ...decodedFromWav(wav), durationSeconds };
}

async function seedEpisodes(episodeIds: string[]) {
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
  for (const id of episodeIds) {
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
  }
  return { ctx: { config, stores }, stores };
}

type LogRecord = Awaited<ReturnType<Stores["metadata"]["listLogs"]>>[number];

function stageMarks(logs: LogRecord[]) {
  return logs.filter((log) => log.type === "synthesis.stage");
}

Deno.test("audio-feed-huh4: a throwing stage is still marked, and the mark attaches to its invocation", async () => {
  const { ctx, stores } = await seedEpisodes(["ep-huh4-throw"]);
  const run = await runSynthesisBatch(
    ctx,
    () => {
      throw new Error("provider stalled inside the TTS stage");
    },
    { batchSize: 1, owner: "huh4-throw", maxAttempts: 1 },
  );

  const logs = await stores.metadata.listLogs();
  const invocation = logs.filter((log) => log.type === "synthesis.invocation");
  const marks = stageMarks(logs).filter((log) => log.phase !== "capped");

  // The point of the finally: the stage that died is the one whose duration is most worth having.
  assert(marks.length > 0, "a stage that threw must still leave a mark");
  assertEquals(marks[0]?.phase, "tts");
  assert((marks[0]?.durationMs ?? -1) >= 0, "a marked duration must be a real non-negative number");
  assertEquals(
    marks[0]?.correlationId,
    invocation[0]?.correlationId,
    "a stage mark must attach to the invocation it happened in",
  );
  assertEquals(run.considered, 1, "the seeded episode must actually have been considered");
});

Deno.test("audio-feed-huh4: stage marks are capped, and the cap is reported rather than silently dropped", async () => {
  // NINE EPISODES, AND THE NUMBER IS THE POINT (audio-feed-9pvk): a SUCCESSFUL episode emits THREE
  // stage marks - tts, verify and upload - because the yield mark is only reached when the invocation
  // budget aborts. Nine episodes x three stages = twenty-seven, which exceeds the fifteen cap by twelve.
  //
  // THIS HEADER WAS TWO-STAGE ONCE AND THE HISTORY IS KEPT ON PURPOSE (audio-feed-gyzx). It was written
  // when the successful path was TWO marks - tts and upload - and said "nine x two = eighteen, which
  // exceeds the cap by three". audio-feed-avgc then added the `verify` mark, so the PROSE went stale
  // while the CONTROL below stayed correct, because the control derives from successfulPathStages rather
  // than from a number written here. The assertion could not go stale; the comment could, and did.
  //
  // THE SIX-EPISODE SEED IS HISTORICAL TOO: it assumed three stages each and would have been eighteen,
  // but on the two-stage path it produced TWELVE - under the fifteen cap - so the cap assertions were
  // never reached and this row proved nothing about the cap at all.
  //
  // THE PER-EPISODE MARK COUNT COMES FROM A TEST-OWNED LIST OF STAGE NAMES, and both halves of that are
  // deliberate.
  //
  // WHY A LIST RATHER THAN A BARE INTEGER: an integer cannot distinguish "the code changed" from "the
  // assumption is wrong". audio-feed-avgc added the `verify` mark, and a bare count of 2 failed LOUDLY ON
  // THE MAIN THIS BRANCH WAS GOING TO LAND ON, which is the expensive version of correct. A list forces a
  // VISIBLE TEST EDIT when the stage set moves, and that edit is what a reviewer sees in the diff.
  //
  // WHY NOT DERIVED FROM src/worker/synthesis.ts: deriving it from the code under test would make this row
  // unable to detect a MISSING mark, which is the defect it exists to catch. The literal IS the control.
  //
  // THE THREE ARE THE MARKS ON A SUCCESSFUL PATH. `yield` is EXCLUDED because it is the CONDITIONAL
  // budget-yield path, which is exactly why this count was two before avgc and three after it.
  // Sites: markStage("tts", ...), markStage("verify", ...), markStage("upload", ...) in
  // src/worker/synthesis.ts.
  const successfulPathStages = ["tts", "verify", "upload"] as const;
  const marksPerSuccessfulEpisode = successfulPathStages.length;
  const ids = Array.from({ length: 9 }, (_, i) => `ep-huh4-cap-${i}`);
  const { ctx, stores } = await seedEpisodes(ids);
  const audio = fakeAudio();
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    batchSize: 9,
    owner: "huh4-cap",
    stageMarkCap: STAGE_MARK_CAP,
  });
  assertEquals(run.ready.length, 9, "every seeded episode must reach ready");

  const logs = await stores.metadata.listLogs();
  const invocation = logs.filter((log) => log.type === "synthesis.invocation");
  const all = stageMarks(logs);
  const capped = all.filter((log) => log.phase === "capped");
  const marked = all.filter((log) => log.phase !== "capped");

  assert(marked.length > 0, "a successful invocation must produce stage marks");
  assert(
    marked.length <= STAGE_MARK_CAP,
    `stage marks must stay bounded: got ${marked.length}, cap ${STAGE_MARK_CAP}`,
  );
  // Every mark is correlated and carries a duration, including across episodes in one batch.
  for (const mark of marked) {
    assertEquals(mark.correlationId, invocation[0]?.correlationId);
    assert((mark.durationMs ?? -1) >= 0);
  }
  /**
   * THE CAP MUST BE SHOWN TO BITE (audio-feed-9pvk). The old form of this row BRANCHED on whether the
   * cap had been reached, asserting "no suppression" in the else arm - so at six episodes it took the
   * else arm, asserted something true and vacuous, and proved nothing about the cap at all. A floor
   * that is only observed is not a floor. These assertions cannot pass unless the run genuinely
   * executed more stages than the cap allows.
   */
  assertEquals(marked.length, STAGE_MARK_CAP, "a batch that exceeds the cap must fill it exactly");
  assertEquals(capped.length, 1, "reaching the cap must emit exactly one capped event");
  const suppressed = Number(capped[0]?.context?.suppressed ?? 0);
  // THE EXACT COUNT, DERIVED rather than hardcoded: the suppression that must be named is every stage
  // execution beyond the cap, and that depends on how many marks a successful episode emits. Asserting
  // the derived value is what makes this a control - it cannot pass at 0 (with no cap nothing is
  // suppressed, so 0 is never the expected count) and it cannot pass at a miscounted 1 (the expectation
  // is 9 * marksPerSuccessfulEpisode - STAGE_MARK_CAP, which is not 1) - while the derivation from ONE
  // named assumption means a change to the stage set produces a failure that names the line to update
  // instead of a stale constant.
  const expectedSuppressed = 9 * marksPerSuccessfulEpisode - STAGE_MARK_CAP;
  assertEquals(
    suppressed,
    expectedSuppressed,
    `with ${marksPerSuccessfulEpisode} marks per successful episode (${
      successfulPathStages.join(", ")
    }), nine episodes exceed the cap by ${expectedSuppressed}: if a stage was added or removed, update successfulPathStages (audio-feed-9pvk)`,
  );
  /**
   * THE CONTROL, CORRECTED AFTER REVIEW (audio-feed-9pvk). The first version asserted
   * marked.length + suppressed > STAGE_MARK_CAP and called itself a negative control. IT WAS A
   * TAUTOLOGY: once marked.length === STAGE_MARK_CAP is asserted above, that expression reduces to
   * suppressed > 0, which the line above already asserts, so it added no verification at all - and it
   * still PASSED with the cap removed from src/worker/synthesis.ts, because a run with no cap emits no
   * capped event and therefore has suppressed = 0, which satisfies marked.length + 0 > STAGE_MARK_CAP
   * on its own. A control that cannot detect the absence of the thing it controls for is not a control.
   *
   * The EXACT accounting is what bites: the suppressed count must equal every execution beyond the cap,
   * which is nine episodes x marksPerSuccessfulEpisode minus the cap. Remove the cap and suppressed is 0,
   * which fails; mis-count the suppressions and the equality fails; reach the cap only by accident and
   * the first line fails.
   */
  assertEquals(
    marked.length + suppressed,
    9 * marksPerSuccessfulEpisode,
    "kept + suppressed must account for every stage execution: episodes x marksPerSuccessfulEpisode",
  );

  // audio-feed-938b: reaching the cap must name WHICH episodes and stages were suppressed
  const suppressedStages = capped[0]?.context?.suppressedStages as
    | Record<string, number>
    | undefined;
  const suppressedEpisodes = capped[0]?.context?.suppressedEpisodes as
    | string[]
    | undefined;
  assert(suppressedStages, "capped event must carry suppressedStages breakdown");
  assert(suppressedEpisodes, "capped event must carry suppressedEpisodes list");

  const unsuppressedIds = ids.slice(0, 5);
  const expectedSuppressedIds = ids.slice(5);
  assertEquals(
    suppressedEpisodes,
    expectedSuppressedIds,
    "suppressedEpisodes must exactly match the episodes that ran after cap was exhausted",
  );
  for (const id of unsuppressedIds) {
    assert(
      !suppressedEpisodes.includes(id),
      `unsuppressed episode ${id} must not appear in suppressedEpisodes`,
    );
  }
  assertEquals(
    suppressedStages,
    { tts: 4, verify: 4, upload: 4 },
    "suppressedStages must record exact count per suppressed stage",
  );
  assertEquals(
    Object.values(suppressedStages).reduce((a, b) => a + b, 0),
    expectedSuppressed,
    "sum of suppressedStages must equal total suppressed",
  );
});

Deno.test("audio-feed-938b: production default stage mark cap formula and cron invocation override invariant", async () => {
  // Tier 1 (Production Default Invariant):
  // Sized to cover batchSize episodes across all four stages (tts, verify, upload, yield)
  // with a production minimum floor of 25.
  assertEquals(defaultStageMarkCap(1), 25);
  assertEquals(defaultStageMarkCap(5), 25);
  assertEquals(defaultStageMarkCap(6), 25);
  assertEquals(defaultStageMarkCap(7), 28);
  assertEquals(defaultStageMarkCap(8), 32);
  assertEquals(defaultStageMarkCap(10), 40);

  // Assert cron invocation passes no stageMarkCap override:
  const cronSource = await Deno.readTextFile(new URL("../src/cron.ts", import.meta.url));
  assert(
    cronSource.includes("runSynthesisBatch(ctx, synthesizer)"),
    "cron synthesis run must pass no stageMarkCap override",
  );
});

Deno.test("audio-feed-938b: default production cap accommodates standard 6-episode batch without premature suppression", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `ep-938b-default-${i}`);
  const { ctx } = await seedEpisodes(ids);
  const audio = fakeAudio();
  // Standard 6-episode batch using the default cap formula (Math.max(25, 6 * 4) = 25):
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    batchSize: 6,
    owner: "938b-default",
  });
  assertEquals(run.ready.length, 6, "all 6 episodes must reach ready");

  const logs = await ctx.stores.metadata.listLogs();
  const all = stageMarks(logs);
  const capped = all.filter((log) => log.phase === "capped");
  const marked = all.filter((log) => log.phase !== "capped");

  // 6 episodes x 3 stages (tts, verify, upload) = 18 marks <= 25 default cap:
  assertEquals(marked.length, 18, "all 18 stage marks must be emitted under the default cap");
  assertEquals(
    capped.length,
    0,
    "default cap must not prematurely suppress a standard 6-episode batch",
  );
});
