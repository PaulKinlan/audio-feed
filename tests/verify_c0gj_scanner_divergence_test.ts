/**
 * tests/verify_c0gj_scanner_divergence_test.ts
 *
 * Automated regression and equivalence test suite for the c0gj scanner divergence verification.
 * Exercises scripts/verify_c0gj_scanner_divergence.ts across all required corpus shapes.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { PINNED_REVISIONS } from "../scripts/verify_c0gj_scanner_divergence.ts";
import {
  buildFuzzCorpus,
  buildHandcraftedCorpus,
  evaluateCandidate,
  extractCodeBlocks_audit1,
  formatCodeForTts_audit1,
  formatCodeForTts_fixc0gj_3d32fc4,
  formatCodeForTts_main,
  verifyAgainstGitRefs,
} from "../scripts/verify_c0gj_scanner_divergence.ts";

Deno.test("c0gj divergence - verifyAgainstGitRefs validates implementations against git revisions", async () => {
  const verified = await verifyAgainstGitRefs();
  assertEquals(verified, true);
});

function refsContainingCommit(commit: string): string[] {
  const { success, stdout } = new Deno.Command("git", {
    args: ["for-each-ref", "--contains", commit, "--format=%(refname)"],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  if (!success) return [];
  return new TextDecoder()
    .decode(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

Deno.test("c0gj divergence - every pinned revision is contained in at least one ref (pin durability)", () => {
  const uncontained: string[] = [];
  for (const [key, pin] of Object.entries(PINNED_REVISIONS)) {
    if (refsContainingCommit(pin.commit).length === 0) {
      uncontained.push(
        `${key} -> ${pin.commit} (${pin.name}) is contained in NO ref`,
      );
    }
  }
  assertEquals(
    uncontained,
    [],
    "A pinned revision that no ref contains is a pin-by-object defect: it " +
      "resolves only while the object survives in a local store, so the harness " +
      "reads different bytes (or fails) in a fresh clone. Fix by pushing the " +
      "branch that holds the commit, or by repointing the pin at a contained " +
      "tip - not by relaxing this assertion.",
  );
});

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

Deno.test("c0gj divergence - fixc0gj Candidate B (3d32fc4) resolves 6-backtick runs but diverges on <pre><code no-gt here</pre>", () => {
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
