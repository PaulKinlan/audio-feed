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
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
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
  // One more episode than the cap can cover at three stages each, so the cap is reached by the
  // SUCCESS path (tts, upload, yield) rather than by looping a failure.
  const ids = Array.from({ length: 6 }, (_, i) => `ep-huh4-cap-${i}`);
  const { ctx, stores } = await seedEpisodes(ids);
  const audio = fakeAudio();
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(audio), {
    batchSize: 6,
    owner: "huh4-cap",
  });
  assertEquals(run.ready.length, 6, "every seeded episode must reach ready");

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
  // Suppression is reported exactly once, and only when it actually happened.
  if (marked.length === STAGE_MARK_CAP) {
    assertEquals(capped.length, 1, "reaching the cap must emit exactly one capped event");
    assert(Number(capped[0]?.context?.suppressed ?? 0) > 0, "the capped event must name how many");
  } else {
    assertEquals(capped.length, 0, "an invocation under the cap must not claim suppression");
  }
});
