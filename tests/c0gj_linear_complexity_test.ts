/**
 * tests/c0gj_linear_complexity_test.ts
 *
 * Verifies linear complexity and equivalence of extractCodeBlocks / formatCodeForTts
 * for issue audio-feed-wqup (resolving audio-feed-c0gj).
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { extractCodeBlocks, formatCodeForTts } from "../src/tts/gemini.ts";

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

Deno.test("c0gj - complexity: growth ratio on unterminated <pre followed by space is linear", () => {
  const sizes = [100000, 200000, 400000, 800000, 1600000];
  const timings: number[] = [];
  const ratios: number[] = [];

  for (let i = 0; i < sizes.length; i++) {
    const n = sizes[i]!;
    const text = "<pre ".repeat(n / 5);

    // Warm up
    extractCodeBlocks(text);

    const iters = 20;
    const start = performance.now();
    for (let it = 0; it < iters; it++) {
      extractCodeBlocks(text);
    }
    const avgMs = (performance.now() - start) / iters;
    timings.push(avgMs);

    if (i > 0) {
      const prevMs = timings[i - 1]!;
      const ratio = prevMs > 0 ? avgMs / prevMs : 1.0;
      ratios.push(ratio);
    }
  }

  // Log growth table for audit
  console.log("\n--- Complexity Table: Unterminated <pre with space ---");
  for (let i = 0; i < sizes.length; i++) {
    const ratioStr = i === 0 ? "baseline" : `${ratios[i - 1]!.toFixed(2)}x`;
    console.log(
      `  N=${sizes[i]!} chars: ${timings[i]!.toFixed(3)}ms (ratio vs previous: ${ratioStr})`,
    );
  }

  // 1.6M chars must take less than 100ms (unfixed quadratic code took 5,531ms)
  assert(
    timings[timings.length - 1]! < 100.0,
    `1.6M chars took ${timings[timings.length - 1]!}ms, expected < 100ms`,
  );
});

Deno.test("c0gj - complexity: growth ratio on unclosed fences roughly doubles per step", () => {
  const sizes = [100000, 200000, 400000, 800000, 1600000];
  const timings: number[] = [];
  const ratios: number[] = [];

  for (let i = 0; i < sizes.length; i++) {
    const n = sizes[i]!;
    const text = "```\n" + "x".repeat(n);

    // Warm up
    extractCodeBlocks(text);

    const iters = 10;
    const start = performance.now();
    for (let it = 0; it < iters; it++) {
      extractCodeBlocks(text);
    }
    const avgMs = (performance.now() - start) / iters;
    timings.push(avgMs);

    if (i > 0) {
      const prevMs = timings[i - 1]!;
      const ratio = prevMs > 0 ? avgMs / prevMs : 1.0;
      ratios.push(ratio);
    }
  }

  console.log("\n--- Complexity Table: Unclosed Fence ---");
  for (let i = 0; i < sizes.length; i++) {
    const ratioStr = i === 0 ? "baseline" : `${ratios[i - 1]!.toFixed(2)}x`;
    console.log(
      `  N=${sizes[i]!} chars: ${timings[i]!.toFixed(3)}ms (ratio vs previous: ${ratioStr})`,
    );
  }

  // 1.6M chars must take less than 200ms
  assert(
    timings[timings.length - 1]! < 200.0,
    `1.6M chars took ${timings[timings.length - 1]!}ms, expected < 200ms`,
  );

  // Each doubling roughly doubles cost (ratio under 5.0x, far below quadratic 16x)
  for (const r of ratios) {
    assert(
      r < 5.0,
      `Growth ratio ${r.toFixed(2)} indicates super-linear explosion`,
    );
  }
});

Deno.test("c0gj - complexity: growth ratio on repeated unclosed <pre> roughly doubles per step", () => {
  const sizes = [100000, 200000, 400000, 800000, 1600000];
  const timings: number[] = [];
  const ratios: number[] = [];

  for (let i = 0; i < sizes.length; i++) {
    const n = sizes[i]!;
    const text = "<pre>".repeat(n / 5);

    // Warm up
    extractCodeBlocks(text);

    const iters = 10;
    const start = performance.now();
    for (let it = 0; it < iters; it++) {
      extractCodeBlocks(text);
    }
    const avgMs = (performance.now() - start) / iters;
    timings.push(avgMs);

    if (i > 0) {
      const prevMs = timings[i - 1]!;
      const ratio = prevMs > 0 ? avgMs / prevMs : 1.0;
      ratios.push(ratio);
    }
  }

  console.log("\n--- Complexity Table: Repeated Unclosed <pre> ---");
  for (let i = 0; i < sizes.length; i++) {
    const ratioStr = i === 0 ? "baseline" : `${ratios[i - 1]!.toFixed(2)}x`;
    console.log(
      `  N=${sizes[i]!} chars: ${timings[i]!.toFixed(3)}ms (ratio vs previous: ${ratioStr})`,
    );
  }

  // 1.6M chars must take less than 200ms
  assert(
    timings[timings.length - 1]! < 200.0,
    `1.6M chars took ${timings[timings.length - 1]!}ms, expected < 200ms`,
  );

  // Each doubling roughly doubles cost (ratio under 5.0x, far below quadratic 16x)
  for (const r of ratios) {
    assert(
      r < 5.0,
      `Growth ratio ${r.toFixed(2)} indicates super-linear explosion`,
    );
  }
});
