/**
 * tests/c0gj_linear_complexity_test.ts
 *
 * Verifies linear complexity and equivalence of extractCodeBlocks / formatCodeForTts
 * for issue audio-feed-wqup (resolving audio-feed-c0gj).
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { extractCodeBlocks, formatCodeForTts } from "../src/tts/gemini.ts";
import {
  buildFuzzCorpus,
  buildHandcraftedCorpus,
  extractCodeBlocks_main,
  formatCodeForTts_main,
} from "../scripts/verify_c0gj_scanner_divergence.ts";

// ---------------------------------------------------------------------------
// Timing assertions (audio-feed-jeot).
//
// These tests used to assert, per step, that the MEAN of 10 or 20 wall-clock
// iterations was under 5.0x the previous step's mean. Two things were wrong with
// that, and neither was the implementation's fault:
//
//   * A mean of a handful of wall-clock iterations is not a property of the code,
//     it is a property of the machine at that moment. On a busy VM a co-tenant
//     suite inflates individual steps by 4-9x, and the SAME TREE then passes and
//     fails on different runs: measured 2026-10-13, 3/3 pass on a detached
//     origin/main worktree and 4/4 pass on the branch tree in the same window,
//     against a red 17.66x step in a gate that ran while another suite was live.
//     This file imports only src/tts/gemini.ts and the divergence harness, so the
//     delta under test could not have caused it.
//   * It could not have caught the quadratic it was written for. Doubling the
//     input costs 2x when linear and 4x when quadratic, so a 5.0x bound leaves a
//     margin of 1.25x against exactly the shape it guards - the pre-fix
//     implementation passes it. (The old comment said "far below quadratic 16x",
//     which is the ratio for quadrupling the input, not doubling it.)
//
// What does catch a quadratic is the ABSOLUTE bound, and that is what remains: the
// pre-fix `extractCodeBlocks_main` takes 5,531ms at 1.6M chars (audio-feed-wqup)
// against these 100-200ms floors - it misses by 27-55x, a margin no contention
// seen on this VM can close.
//
// So: the floors are kept and applied per size (floor x n/1.6M, linear scaling,
// which is what a linear implementation needs - the fixed implementation measures
// ~0.8ns/char, about 100x under the bound at every size), the mean is replaced by
// the MINIMUM of the iterations (a stall can move one iteration but not all of
// them), and the per-step ratio assertions are gone. The table is still printed as
// diagnostics and the ratio is printed with it; it is simply not asserted.
//
// The last test in this file is the NEGATIVE CONTROL: it applies these same bounds
// to the pre-fix quadratic implementation and asserts they FAIL it, so loosening
// the bounds to quiet a flaky gate cannot pass silently.
// ---------------------------------------------------------------------------
const TIMING_REFERENCE_CHARS = 1_600_000;
const TIMING_ITERS = 5;

/** This file's original absolute floor at 1.6M chars, scaled linearly to `chars`. */
function boundMs(chars: number, floorMs: number): number {
  return (floorMs * chars) / TIMING_REFERENCE_CHARS;
}

/** The minimum of `iters` measurements: contention can slow one run, not all of them. */
function minMs(
  fn: (text: string) => unknown,
  text: string,
  iters: number = TIMING_ITERS,
): number {
  fn(text); // warm up, excluded from the measurement
  let best = Infinity;
  for (let i = 0; i < iters; i++) {
    const started = performance.now();
    fn(text);
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/** Measures every size, prints the audit table, and asserts the absolute bound at each one. */
function assertWithinBounds(
  label: string,
  sizes: number[],
  makeText: (chars: number) => string,
  floorMs: number,
  fn: (text: string) => unknown = extractCodeBlocks,
): void {
  const timings = sizes.map((chars) => minMs(fn, makeText(chars)));
  console.log(
    `\n--- Complexity Table: ${label} (min of ${TIMING_ITERS}; ratio is diagnostic, NOT asserted) ---`,
  );
  for (let i = 0; i < sizes.length; i++) {
    const previous = i === 0 ? undefined : timings[i - 1]!;
    const ratio = previous === undefined || previous <= 0
      ? "baseline"
      : `${(timings[i]! / previous).toFixed(2)}x`;
    console.log(
      `  N=${sizes[i]!} chars: ${timings[i]!.toFixed(3)}ms (ratio vs previous: ${ratio}, ` +
        `bound ${boundMs(sizes[i]!, floorMs).toFixed(2)}ms)`,
    );
  }
  for (let i = 0; i < sizes.length; i++) {
    const bound = boundMs(sizes[i]!, floorMs);
    assert(
      timings[i]! < bound,
      `${label}: ${sizes[i]!} chars took ${timings[i]!.toFixed(3)}ms, expected < ${
        bound.toFixed(2)
      }ms (the ${floorMs}ms floor at 1.6M chars, scaled linearly)`,
    );
  }
}

Deno.test("c0gj - branch extractCodeBlocks and formatCodeForTts achieve 0 mismatches across full 10,090-input corpus", async () => {
  const handcrafted = buildHandcraftedCorpus();
  const fuzz1 = buildFuzzCorpus(3333, 101);
  const fuzz2 = buildFuzzCorpus(3333, 202);
  const fuzz3 = buildFuzzCorpus(3334, 303);
  const fullCorpus = [...handcrafted, ...fuzz1, ...fuzz2, ...fuzz3];

  let skipMismatches = 0;
  let explainMismatches = 0;
  let blockMismatches = 0;

  for (const item of fullCorpus) {
    const text = item.text;
    const expectedSkip = formatCodeForTts_main(text, "skip");
    const expectedExplain = formatCodeForTts_main(text, "explain");
    const expectedBlocks = extractCodeBlocks_main(text);

    const actualSkip = await formatCodeForTts(text, "skip");
    const actualExplain = await formatCodeForTts(
      text,
      "explain",
      (c) => `summary(${c})`,
    );
    const actualBlocks = extractCodeBlocks(text);

    if (actualSkip !== expectedSkip) skipMismatches++;
    if (actualExplain !== expectedExplain) explainMismatches++;
    const blocksMatch = actualBlocks.length === expectedBlocks.length &&
      actualBlocks.every((b, i) => {
        const exp = expectedBlocks[i];
        return (
          exp !== undefined &&
          b.index === exp.index &&
          b.full === exp.full &&
          b.code === exp.code
        );
      });
    if (!blocksMatch) blockMismatches++;
  }

  assertEquals(
    skipMismatches,
    0,
    "skip mode must have 0 mismatches across 10,090 corpus cases",
  );
  assertEquals(
    explainMismatches,
    0,
    "explain mode must have 0 mismatches across 10,090 corpus cases",
  );
  assertEquals(
    blockMismatches,
    0,
    "block AST must have 0 mismatches across 10,090 corpus cases",
  );
});

Deno.test("c0gj - divergent input <pre><code no-gt here</pre> strips to empty string and extracts code", async () => {
  const input = "<pre><code no-gt here</pre>";

  // 1. Skip mode: must strip markup completely
  const stripped = await formatCodeForTts(input, "skip");
  assertEquals(stripped, "");

  // 2. Extracted blocks: must match full block with raw code
  const blocks = extractCodeBlocks(input);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]!.full, "<pre><code no-gt here</pre>");
  assertEquals(blocks[0]!.code, "<code no-gt here");
  assertEquals(blocks[0]!.index, 0);

  // 3. Explain mode: must summarize the extracted code
  const explained = await formatCodeForTts(input, "explain", (c) => `explained(${c})`);
  assertEquals(explained, "Here is what that code does: explained(<code no-gt here)");
});

Deno.test("c0gj - <pre><code no-gt here</pre> some code </pre> with second closer matches full block", async () => {
  const input = "<pre><code no-gt here</pre> some code </pre>";

  const stripped = await formatCodeForTts(input, "skip");
  assertEquals(stripped, "");

  const blocks = extractCodeBlocks(input);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]!.full, input);
  assertEquals(blocks[0]!.code, "some code");
  assertEquals(blocks[0]!.index, 0);
});

Deno.test("c0gj - complexity: unterminated <pre followed by space stays linear", () => {
  // The unfixed quadratic implementation took 5,531ms at 1.6M chars (audio-feed-wqup).
  assertWithinBounds(
    "Unterminated <pre with space",
    [100000, 200000, 400000, 800000, 1600000],
    (chars) => "<pre ".repeat(chars / 5),
    100.0,
  );
});

Deno.test("c0gj - complexity: unclosed fences stay linear", () => {
  assertWithinBounds(
    "Unclosed Fence",
    [100000, 200000, 400000, 800000, 1600000],
    (chars) => "```\n" + "x".repeat(chars),
    200.0,
  );
});

Deno.test("c0gj - complexity: repeated unclosed <pre> stays linear", () => {
  assertWithinBounds(
    "Repeated Unclosed <pre>",
    [100000, 200000, 400000, 800000, 1600000],
    (chars) => "<pre>".repeat(chars / 5),
    200.0,
  );
});

Deno.test("c0gj - complexity: the bounds DISCRIMINATE - the pre-fix quadratic implementation fails them", () => {
  // The negative control for the three tests above, run every time rather than
  // recorded once: it puts `extractCodeBlocks_main` (the pre-fix implementation,
  // which is what these bounds exist to reject - audio-feed-wqup landed on this
  // file) through the SAME bound function at a size the quadratic can still
  // afford. If the bounds are ever loosened to quiet a flaky gate, the quadratic
  // stops failing them and this test goes red, which is the point.
  //
  // Measured on this VM 2026-10-13 (load 5.6-6.2), chars=12500 of "<pre ",
  // min of 5 for the fixed implementation and 1 for the quadratic:
  //   fixed      0.001-0.003ms   (bound here: 0.78ms)   -> passes with ~260x margin
  //   quadratic 39.6-46.3ms      (bound here: 0.78ms)   -> fails by ~51x
  // The 12.5k size is deliberate: at the 1.6M size the three tests above use, the
  // quadratic would need ~9 minutes for a single pass, so the control proves the
  // bound at a size it can afford instead of timing out.
  const chars = 12500;
  const text = "<pre ".repeat(chars / 5);
  const floorMs = 100.0; // the same floor as the first test above
  const bound = boundMs(chars, floorMs);

  const fixedMs = minMs(extractCodeBlocks, text);
  const quadraticMs = minMs(extractCodeBlocks_main, text, 1);
  console.log(
    `\n--- Negative control: bound ${bound.toFixed(2)}ms at ${chars} chars ---\n` +
      `  extractCodeBlocks (fixed)   ${fixedMs.toFixed(3)}ms  -> ${
        fixedMs < bound ? "PASSES" : "FAILS"
      } the bound\n` +
      `  extractCodeBlocks_main (quadratic) ${quadraticMs.toFixed(2)}ms  -> ${
        quadraticMs > bound ? "FAILS" : "PASSES"
      } the bound`,
  );

  assert(
    fixedMs < bound,
    `the fixed implementation took ${fixedMs.toFixed(3)}ms at ${chars} chars, expected < ${
      bound.toFixed(2)
    }ms`,
  );
  assert(
    quadraticMs > bound,
    `the pre-fix quadratic implementation took ${quadraticMs.toFixed(2)}ms at ${chars} chars, ` +
      `expected > ${bound.toFixed(2)}ms. These bounds no longer reject a quadratic, which is the ` +
      `acceptance audio-feed-wqup landed on. If the reference was legitimately made linear, ` +
      `replace it with a deliberately quadratic stand-in - do not delete this control.`,
  );
});
