/**
 * Tests for audio-feed-preturn (P0: episodes permanently failing with
 * "Synthesis yielded before paid turn 1 ... claim 3/3; zero durable progress across all claims").
 *
 * The loop: a claim whose pre-turn window (slow script/store work) eats most of the 90s
 * invocation budget reaches the pre-turn preflight with less than turnEstimate + flushMargin
 * remaining, and the refusal is counted as a FAILED ATTEMPT because no durable progress
 * exists. Three ticks later the episode is permanently failed without a single paid TTS turn
 * ever being attempted. The fix: a yield raised before THIS CLAIM initiated any paid turn is
 * a pure refusal — it spent nothing, so it must not consume the claims cap. Claims that DID
 * initiate paid turns and still yield with zero progress keep burning attempts exactly as
 * audio-feed-zrkn specified (pinned by the second row: the cap is NOT weakened).
 */
import { assert, assertEquals } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { createGeminiSynthesizer, runSynthesisBatch } from "../src/worker/synthesis.ts";
import { decodedFromWav, GeminiTtsClient, pcmToWav } from "../src/tts/gemini.ts";
import type { DecodedAudioResult, SynthesisOptions } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { controlledInvocationClock } from "./fixtures/invocation_clock.ts";
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

/** The synthesizer's narration input type is structural; only the fields below are read. */
type NarrationInput = Parameters<GeminiTtsClient["synthesizeNarration"]>[0];

/**
 * A client whose pre-turn stage burns `burnMs` of the invocation clock BEFORE the first
 * resume.prepare — the "slow script generation" shape. The preflight inside the real
 * wrappedResume.prepare then refuses with the exact production symptom
 * ("remaining budget ~27s < required 50s") before any paid turn.
 */
function slowPreTurnClient(time: ReturnType<typeof controlledInvocationClock>, burnMs: number) {
  return {
    async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
      await time.advance(burnMs);
      await options.resume?.prepare("segment-1", "voice-a");
      // Never reached when the preflight refuses; on a fresh budget this is the paid turn.
      return fakeAudio();
    },
  };
}

/** A healthy client: preflight passes, the paid turn "succeeds". */
function healthyClient() {
  return {
    async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
      await options.resume?.prepare("segment-1", "voice-a");
      return fakeAudio();
    },
  };
}

Deno.test(
  "audio-feed-preturn: three pre-turn refusals must not permanently fail an episode that never initiated a paid turn; a healthy fourth tick completes it",
  async () => {
    const { ctx, stores } = await setupEnv();
    const time = controlledInvocationClock();
    const synth = createGeminiSynthesizer(ctx, {
      client: slowPreTurnClient(time, 63_000) as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const batchOpts = {
      maxInvocationDurationMs: 90_000,
      clock: time.clock,
    };

    // Ticks 1-3: each fresh 90s invocation burns 63s pre-turn, the preflight refuses at
    // ~27s remaining (< 50s required) — Paul's exact symptom, claim N/3.
    for (let tick = 1; tick <= 3; tick++) {
      const result = await runSynthesisBatch(ctx, synth, {
        owner: `worker-preturn-${tick}`,
        ...batchOpts,
      });
      assertEquals(result.yielded.length, 1, `tick ${tick} must yield, not fail`);
    }

    const afterThree = await stores.metadata.getEpisode("user-1", "episode-1");
    assert(afterThree, "episode must exist after three refusal ticks");
    assertEquals(
      afterThree.status,
      "pending",
      "a claim that never initiated a paid turn must not consume the claims cap; " +
        "three refusals must leave the episode resumable, not permanently failed",
    );
    assertEquals(
      afterThree.attempts ?? 0,
      0,
      "a pure pre-turn refusal spent nothing, so the attempt counter must stay 0",
    );
    assert(
      !(afterThree.error ?? "").includes("zero durable progress"),
      "the episode must never reach the zero-progress terminal state: " + afterThree.error,
    );

    // Tick 4 with a healthy provider: full 90s budget, turn 1 proceeds, episode completes.
    const healthy = createGeminiSynthesizer(ctx, {
      client: healthyClient() as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const tick4 = await runSynthesisBatch(ctx, healthy, {
      owner: "worker-preturn-4",
      ...batchOpts,
    });
    assertEquals(tick4.ready.length, 1, "a healthy tick must complete the refused episode");
    const done = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(done?.status, "ready");
  },
);

Deno.test(
  "audio-feed-preturn: the cap is NOT weakened — a claim that initiated paid turns and yields with zero progress still exhausts at 3/3",
  async () => {
    const { ctx, stores } = await setupEnv();
    const time = controlledInvocationClock();
    let call = 0;
    const spendingThenFailingClient = {
      async synthesizeNarration(_input: NarrationInput, options: SynthesisOptions) {
        call++;
        if (call % 2 === 1) {
          // Attempt 1 of the claim: preflight passes, the paid turn IS initiated, then the
          // provider burns 80s and fails transiently (500 → retryable, isPermanent false).
          await options.resume?.prepare("segment-1", "voice-a");
          await time.advance(80_000);
          throw Object.assign(new Error("provider exploded"), { status: 500 });
        }
        // Attempt 2 of the claim: only 10s remain; the preflight refuses before turn 1 of
        // this attempt — but the claim DID spend, so the refusal is not a pure refusal.
        await options.resume?.prepare("segment-1", "voice-a");
        return fakeAudio();
      },
    };
    const synth = createGeminiSynthesizer(ctx, {
      client: spendingThenFailingClient as unknown as GeminiTtsClient,
      scriptGenerator: null,
    });
    const batchOpts = {
      maxInvocationDurationMs: 90_000,
      clock: time.clock,
    };

    for (let tick = 1; tick <= 3; tick++) {
      const result = await runSynthesisBatch(ctx, synth, {
        owner: `worker-spend-${tick}`,
        ...batchOpts,
      });
      assertEquals(
        result.failed.length,
        tick === 3 ? 1 : 0,
        `tick ${tick}: real spend with zero progress must burn attempts (audio-feed-zrkn)`,
      );
    }

    const exhausted = await stores.metadata.getEpisode("user-1", "episode-1");
    assertEquals(exhausted?.status, "failed", "real spend with zero progress must still cap out");
    assert(
      (exhausted?.error ?? "").includes("zero durable progress across all claims"),
      "terminal reason must name the exhaustion: " + exhausted?.error,
    );
  },
);
