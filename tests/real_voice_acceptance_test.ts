/**
 * Offline pins for the real-voice upload acceptance command (audio-feed-9hfz9).
 *
 * The command itself spends money when run with --live, so its COST ARITHMETIC is
 * what needs deterministic coverage: the pricing schedule and its date boundary, the
 * worst-case bound, the per-1M estimate arithmetic, the one-segment smallness of the
 * embedded document, and — driven end to end in-process — that the command is DRY BY
 * DEFAULT: no flags means exit 0, a plan, and nothing spent. None of these tests
 * touch the network or the real synthesizer; that run is Paul's decision
 * (the bead's whole point).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  acceptancePrompt,
  AUDIO_TOKENS_PER_SECOND,
  DOCUMENT,
  estimateCost,
  HEURISTIC_BYTES_PER_TOKEN,
  main,
  parseArgs,
  ratesFor,
  type TtsRates,
  WORST_CASE,
} from "../scripts/real-voice-upload-acceptance.ts";
import { MAX_TTS_INPUT_BYTES, MAX_TTS_SEGMENTS } from "../src/tts/gemini.ts";
import { splitTextUnderByteBudget } from "../src/synthesis/limits.ts";

const PROMO: TtsRates = {
  inputPer1M: 0.5,
  outputPer1M: 9.0,
  schedule: "promotional (through 2026-12-31)",
};

Deno.test("pricing schedule switches on the documented 2027-01-01 boundary (audio-feed-9hfz9)", () => {
  const promo = ratesFor(new Date("2026-12-31T23:59:59Z"));
  assertEquals(promo.inputPer1M, 0.5, "last promotional day keeps promotional input pricing");
  assertEquals(promo.outputPer1M, 9.0, "and promotional audio-output pricing");
  const standard = ratesFor(new Date("2027-01-01T00:00:00Z"));
  assertEquals(standard.inputPer1M, 1.0, "standard input pricing from the boundary instant");
  assertEquals(standard.outputPer1M, 18.0, "and standard audio-output pricing");
});

function assertEqualsApprox(actual: number, expected: number, label: string) {
  assert(
    Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

Deno.test("estimate arithmetic is per-1M tokens, inputs and outputs summed (audio-feed-9hfz9)", () => {
  const e = estimateCost(1_000_000, 500_000, PROMO);
  assertEqualsApprox(e.inputUsd, 0.5, "1M input tokens at $0.50/1M");
  assertEqualsApprox(e.outputUsd, 4.5, "0.5M output tokens at $9.00/1M");
  assertEqualsApprox(e.totalUsd, 5.0, "parts sum");

  // The magnitudes the acceptance actually talks about: a few hundred tokens are
  // fractions of a cent — the printed number must not round that story away.
  const small = estimateCost(116, 200, PROMO);
  assertEqualsApprox(small.inputUsd, 116 / 1_000_000 * 0.5, "tiny input");
  assertEqualsApprox(small.outputUsd, 200 / 1_000_000 * 9.0, "tiny output");
  assert(small.totalUsd < 0.01, "a small document must cost well under a cent");
});

Deno.test("the worst case is the provider's own caps, ~$3.64 promotional (audio-feed-9hfz9)", () => {
  // The bound is built from the model caps the app enforces elsewhere.
  assertEquals(WORST_CASE.inputTokens, MAX_TTS_SEGMENTS * 8192);
  assertEquals(WORST_CASE.outputTokens, MAX_TTS_SEGMENTS * 16384);
  const worst = estimateCost(WORST_CASE.inputTokens, WORST_CASE.outputTokens, PROMO);
  assertEqualsApprox(worst.totalUsd, 196_608 / 1e6 * 0.5 + 393_216 / 1e6 * 9.0, "worst-case sum");
  assert(
    worst.totalUsd > 3 && worst.totalUsd < 4,
    `worst case sits near $3.64, got ${worst.totalUsd}`,
  );
});

Deno.test("the embedded document narrates as ONE small segment (audio-feed-9hfz9)", () => {
  // The command's cost story depends on this staying true: one segment, seconds of
  // audio. If the document grows past the budget the estimate changes shape and this
  // test must force a conscious decision, not let it drift.
  const prompt = acceptancePrompt();
  const segments = splitTextUnderByteBudget(prompt, MAX_TTS_INPUT_BYTES);
  assertEquals(segments.length, 1, "the acceptance document must be a single paid call");
  assert(
    new TextEncoder().encode(DOCUMENT).byteLength < MAX_TTS_INPUT_BYTES,
    "the raw document itself stays under one segment's byte budget",
  );
});

Deno.test("the audio-token conversion is Google's documented 25 per second (audio-feed-9hfz9)", () => {
  // Observed cost DERIVES output tokens from measured duration at this rate; if the
  // documented rate changes upstream, this constant is the single place to update.
  assertEquals(AUDIO_TOKENS_PER_SECOND, 25);
  const sixtySeconds = estimateCost(0, 60 * AUDIO_TOKENS_PER_SECOND, PROMO);
  assertEqualsApprox(
    sixtySeconds.outputUsd,
    1500 / 1e6 * 9.0,
    "a minute of audio at the documented rate",
  );
});

Deno.test("flags parse exactly: nothing is live or destructive by default (audio-feed-9hfz9)", () => {
  assertEquals(
    parseArgs([]),
    { live: false, cleanup: false },
    "bare invocation is dry and keeps everything",
  );
  assertEquals(parseArgs(["--live"]), { live: true, cleanup: false });
  assertEquals(parseArgs(["--cleanup"]), { live: false, cleanup: true });
  assertEquals(parseArgs(["--live", "--cleanup"]), { live: true, cleanup: true });
});

Deno.test("DRY BY DEFAULT: a bare run exits 0, plans, and prints both cost marks (audio-feed-9hfz9)", async () => {
  // Drives main() for real — the dry path reads no env, opens no connections, and
  // starts no worker, so this is the acceptance of the acceptance: an accidental run
  // without --live does nothing but print.
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg?: unknown) => {
    logs.push(String(msg));
  };
  let code: number;
  try {
    code = await main([]);
  } finally {
    console.log = origLog;
  }
  assertEquals(code, 0, "a dry run is a successful run");
  const out = logs.join("\n");
  assertStringIncludes(out, "DRY RUN", "the very first line must say nothing was spent");
  assertStringIncludes(out, "--live", "and must show how to make it real");
  assertStringIncludes(out, "ESTIMATE", "the pre-call estimate is printed even dry");
  assertStringIncludes(out, "WORST CASE", "the honest bound is printed even dry");
  assertMatch(
    out,
    /promotional \(through 2026-12-31\)|standard \(from 2027-01-01\)/,
    "the schedule is printed by name, so a stale rate cannot pass silently",
  );
  assertStringIncludes(
    out,
    "direct (single voice)",
    "the mode is stated: deepdive's paid script stage is not exercised",
  );
  assert(
    !logs.some((l) => l.includes("ACCEPTANCE PASSED")),
    "dry mode must not claim the real acceptance passed",
  );
});

Deno.test("the dry heuristic is the committed live measurement, labelled as heuristic (audio-feed-9hfz9)", () => {
  // 47,044 bytes -> 10,512 provider tokens (u60a evidence) ≈ 4.476 bytes/token; the
  // constant exists so the dry number is grounded in this repo's own measurement
  // rather than folklore, and so the live countTokens replacement is visibly a refinement.
  assert(HEURISTIC_BYTES_PER_TOKEN > 4 && HEURISTIC_BYTES_PER_TOKEN < 5);
});
