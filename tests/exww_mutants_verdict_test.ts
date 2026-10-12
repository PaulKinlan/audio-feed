/**
 * audio-feed-l6b6: a run killed by a bound is UNKNOWN, and the CLI used to count it as an expected red.
 *
 * THE DEFECT THIS PINS, found in review of audio-feed-dynb by rev-46 and reproduced in its own words: the
 * mapped suite checked `timedOut`, and the seven-row CLI accepted any non-zero exit -
 *
 *     const asExpected = outcome.code !== 0 && expectedSeen && soleRedOk;   // scripts/exww-mutants.ts:474
 *
 * - so a row that was KILLED BY THE BOUND counted as "as expected (red on the named check)" as long as it had
 * printed the expected FAIL line first. That reconstitutes the false green the row exists to prevent, in the
 * path a human runs when they are trying to find out what happened. `runProofIn` also omitted 143 (SIGTERM)
 * from its unknown set, so a `timeout` that escalated would have read as an ordinary non-zero exit.
 *
 * WHAT IS ASSERTED HERE, AND WHY IT IS A NEGATIVE CONTROL RATHER THAN A RESTATEMENT: every case RUNS a stub
 * proof with a known exit code, so the timeout input is produced rather than assumed. The stub prints the
 * exact FAIL line the row expects - the false-green shape - and the assertion is that the interpretation is
 * `unknown`, not that some function returns a constant. A test that only asserted the happy path would pass
 * on the broken code as well.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  interpretRun,
  isUnknownExit,
  runProofIn,
  summarise,
  UNKNOWN_EXIT_CODES,
} from "../scripts/exww-mutants.ts";

const NEEDLE = "image is 640x473 for a clip of 1280x946";
const SCRATCH_PREFIX = "l6b6-verdict-";

/** A tree whose "proof" is a stub that prints the expected FAIL line and then exits with `code`. */
async function withStubProof(
  code: number,
  body: (outcome: Awaited<ReturnType<typeof runProofIn>>) => Promise<void> | void,
  { emitFail = true }: { emitFail?: boolean } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: SCRATCH_PREFIX });
  try {
    await Deno.mkdir(`${dir}/scripts`, { recursive: true });
    await Deno.mkdir(`${dir}/docs/evidence/audio-feed-exww`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/scripts/exww-live-claims-browser-proof.ts`,
      `console.log("PASS something trivial");\n` +
        // A clean run prints no FAIL line at all - `green` requires BOTH exit 0 and no failures, and a fixture
        // that always printed one would have tested the wrong thing while looking like it tested this.
        (emitFail
          ? `console.log("FAIL ${NEEDLE} at scale 0.5, so it should be 1280x946");\n`
          : "") +
        `Deno.exit(${code});\n`,
    );
    await body(await runProofIn(dir, 60_000));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("audio-feed-l6b6: the fleet's unknown set is 124/137/143, and 143 was the one omitted", () => {
  assertEquals([...UNKNOWN_EXIT_CODES], [124, 137, 143]);
  for (const code of [124, 137, 143]) assert(isUnknownExit(code), `exit ${code} is a bound kill`);
  for (const code of [0, 1, 2, 130]) {
    assert(!isUnknownExit(code), `exit ${code} is not a bound kill`);
  }
});

Deno.test("audio-feed-l6b6: a row killed by the bound is UNKNOWN even when it printed the expected red first", async () => {
  // 143 is the case the review named, and it is the sharpest one: SIGTERM.
  for (const code of [124, 137, 143]) {
    await withStubProof(code, (outcome) => {
      assertEquals(outcome.code, code);
      assert(outcome.timedOut, `exit ${code} must be classified as a bound kill`);
      assertStringIncludes(outcome.failures.join("\n"), NEEDLE);
      // THE OLD RULE, reconstructed: it accepted exactly this outcome as an expected red.
      const oldRule = outcome.code !== 0 && outcome.failures.some((f) => f.includes(NEEDLE));
      assert(
        oldRule,
        "the stub must reproduce the shape the old rule accepted, or this test proves nothing",
      );
      const judged = interpretRun(outcome, { kind: "detector", expect: [NEEDLE] });
      assertEquals(
        judged.verdict,
        "unknown",
        `exit ${code} with the named red present must be UNKNOWN, not an expected detector red: ${judged.detail}`,
      );
      assertStringIncludes(judged.detail, "bound");
    });
  }
});

Deno.test("audio-feed-l6b6: a baseline killed by the bound is UNKNOWN rather than a FAIL", async () => {
  await withStubProof(124, (outcome) => {
    const judged = interpretRun(outcome, { kind: "green" });
    assertEquals(judged.verdict, "unknown", "a killed baseline is unknown, not a failed one");
  });
});

Deno.test("audio-feed-l6b6: the rule still works when it should - an inside-the-bound red, a green baseline, and the directions that must stay unexpected", async () => {
  await withStubProof(1, (outcome) => {
    assertEquals(
      interpretRun(outcome, { kind: "detector", expect: [NEEDLE] }).verdict,
      "red on the named check",
      "a non-zero exit INSIDE the bound with the named red is still the expected detector outcome",
    );
    assertEquals(
      interpretRun(outcome, { kind: "detector", expect: ["a check that never fires"] }).verdict,
      "unexpected",
      "a red that is not the named one is not the row's red",
    );
    assertEquals(
      interpretRun(outcome, { kind: "detector", expect: [NEEDLE], soleRed: ["only this one"] })
        .verdict,
      "unexpected",
      "sole-red is enforced through the same interpretation",
    );
  });
  await withStubProof(0, (outcome) => {
    assertEquals(interpretRun(outcome, { kind: "green" }).verdict, "green", "a clean run is green");
    assertEquals(
      interpretRun(outcome, { kind: "detector", expect: [NEEDLE] }).verdict,
      "unexpected",
      "a mutant that does not redden the proof is unexpected, not green",
    );
  }, { emitFail: false });
  await withStubProof(0, (outcome) => {
    assertEquals(
      interpretRun(outcome, { kind: "green" }).verdict,
      "unexpected",
      "exit 0 WITH a FAIL line is not a clean green run: both halves are required",
    );
  });
});

Deno.test("audio-feed-l6b6: the CLI's three-way summary counts by VERDICT, not by display string", () => {
  // THE CLERICAL BUG THIS PINS, which happened in this fix: the record held the enum and the counter compared
  // display strings, so a `green` baseline counted as unexpected and the CLI went RED with every row correct.
  const full = summarise([
    { verdict: "green" }, // the baseline
    { verdict: "red on the named check" },
    { verdict: "red on the named check" },
  ]);
  assertEquals(
    full,
    { expected: 3, unknown: 0, unexpected: 0 },
    "a green baseline is EXPECTED, not unexpected",
  );

  assertEquals(
    summarise([{ verdict: "green" }, { verdict: "unknown" }, { verdict: "unexpected" }]),
    { expected: 1, unknown: 1, unexpected: 1 },
    "a bound kill is counted as UNKNOWN, separately from both as-expected and unexpected",
  );
  assertEquals(
    summarise([{ verdict: "inapplicable" }, { verdict: "failed to run" }]),
    { expected: 0, unknown: 0, unexpected: 2 },
    "a moved anchor and a row that never ran are both harness-RED, neither is a pass and neither is unknown",
  );
});
