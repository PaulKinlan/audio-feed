/**
 * tests/verify_c0gj_scanner_divergence_test.ts
 *
 * Automated regression and equivalence test suite for the c0gj scanner divergence verification.
 * Exercises scripts/verify_c0gj_scanner_divergence.ts across all required corpus shapes.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  buildFuzzCorpus,
  buildHandcraftedCorpus,
  evaluateCandidate,
  extractCodeBlocks_audit1,
  formatCodeForTts_audit1,
  formatCodeForTts_fixc0gj_3d32fc4,
  formatCodeForTts_fixc0gj_9f18cc1,
  formatCodeForTts_main,
} from "../scripts/verify_c0gj_scanner_divergence.ts";

Deno.test("c0gj divergence - handcrafted corpus covers all 12 required categories", () => {
  const corpus = buildHandcraftedCorpus();
  const categories = new Set(corpus.map((c) => c.category));

  const requiredCategories = [
    "repo-fixture",
    "fence-inside-fence",
    "six-backtick-runs",
    "crlf",
    "unclosed-at-eof",
    "tag-punctuation",
    "pre-attributes",
    "exact-delimiter-length",
    "scale-shapes",
    "empty-block",
    "fence-at-boundary",
    "no-code",
  ];

  for (const cat of requiredCategories) {
    assert(
      categories.has(cat),
      `Corpus must include required category: ${cat}`,
    );
  }
  assert(corpus.length >= 80, "Handcrafted corpus must have at least 80 cases");
});

Deno.test("c0gj divergence - audit1 (f70e3fa) achieves 0 mismatches across handcrafted corpus", () => {
  const corpus = buildHandcraftedCorpus();
  const result = evaluateCandidate(
    "audit1",
    "fleet/audit1@f70e3fa",
    corpus,
    formatCodeForTts_audit1,
    extractCodeBlocks_audit1,
  );

  assertEquals(result.skipDivergences, 0, "skip mode must have 0 mismatches");
  assertEquals(
    result.explainDivergences,
    0,
    "explain mode must have 0 mismatches",
  );
  assertEquals(result.blockDivergences, 0, "block AST must have 0 mismatches");
  assertEquals(result.totalDistinctDifferingInputs, 0);
});

Deno.test("c0gj divergence - audit1 (f70e3fa) achieves 0 mismatches across deterministic fuzz corpus", () => {
  const fuzz = buildFuzzCorpus(1000, 42);
  const result = evaluateCandidate(
    "audit1",
    "fleet/audit1@f70e3fa",
    fuzz,
    formatCodeForTts_audit1,
    extractCodeBlocks_audit1,
  );

  assertEquals(
    result.totalDistinctDifferingInputs,
    0,
    "audit1 must have 0 mismatches across 1000 fuzz cases",
  );
});

Deno.test("c0gj divergence - fixc0gj v1 (9f18cc1) diverges on solitary 6-backtick runs and leaves markup in text", () => {
  // Solitary 6 backticks
  const sixTicks = "``````";
  const expectedSkip = formatCodeForTts_main(sixTicks, "skip");
  const actualSkip = formatCodeForTts_fixc0gj_9f18cc1(sixTicks, "skip");
  assertEquals(expectedSkip, "");
  assertEquals(
    actualSkip,
    "``````",
    "fixc0gj v1 leaves solitary 6 backticks unstripped",
  );

  // Six backticks with abc
  const sixTicksAbc = "``````abc";
  assertEquals(formatCodeForTts_main(sixTicksAbc, "skip"), "abc");
  assertEquals(
    formatCodeForTts_fixc0gj_9f18cc1(sixTicksAbc, "skip"),
    "``````abc",
  );

  // Six backticks with \ntail
  const sixTicksTail = "``````\ntail";
  assertEquals(formatCodeForTts_main(sixTicksTail, "skip"), "tail");
  assertEquals(
    formatCodeForTts_fixc0gj_9f18cc1(sixTicksTail, "skip"),
    "``````\ntail",
  );
});

Deno.test("c0gj divergence - fixc0gj v2 (3d32fc4) resolves 6-backtick runs but diverges on <pre><code no-gt here</pre>", () => {
  // Resolved 6-backtick runs
  assertEquals(formatCodeForTts_fixc0gj_3d32fc4("``````", "skip"), "");
  assertEquals(formatCodeForTts_fixc0gj_3d32fc4("``````abc", "skip"), "abc");
  assertEquals(formatCodeForTts_fixc0gj_3d32fc4("``````\ntail", "skip"), "tail");

  // Remaining divergence on malformed code tag swallowing </pre>
  const malformed = "<pre><code no-gt here</pre>";
  const expected = formatCodeForTts_main(malformed, "skip");
  const actual = formatCodeForTts_fixc0gj_3d32fc4(malformed, "skip");
  assertEquals(expected, "");
  assertEquals(actual, "<pre><code no-gt here</pre>");
});
