/**
 * Tests for scripts/evidence-run.ts (audio-feed-c0ft).
 *
 * Verifies both fixes for the false-green defect class in the evidence tier:
 * 1. Walk: Explicit refusal of nested evidence directories (fail-closed if any
 *    subdirectory of docs/evidence carries a README).
 * 2. Zero-assertion script: Refusal of scripts that exit 0 without asserting anything
 *    (empty output, or missing PASS/OK marker when Asserts: is declared).
 *
 * Both fixes carry mandatory negative controls (audio-feed-t9w1).
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  collect,
  EVIDENCE_RECORDS_ENFORCED,
  findNestedEvidence,
  hashEvidenceDir,
  parseOptions,
  readDeclaration,
  readRunRecord,
  RECORD_FILE,
  RECORD_MAX_AGE_DAYS,
  referencesProofInCode,
  resolveBound,
  shaIsAncestor,
  stripAnsi,
  validateRunRecord,
} from "../scripts/evidence-run.ts";
import type { RunRecord } from "../scripts/evidence-run.ts";

const EVIDENCE_RUN_SCRIPT = new URL("../scripts/evidence-run.ts", import.meta.url).pathname;

async function runTier(
  root: string,
  extraArgs: string[] = [],
  env?: Record<string, string>,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--unstable-kv",
      EVIDENCE_RUN_SCRIPT,
      "--root",
      root,
      ...extraArgs,
    ],
    ...(env ? { env: { ...Deno.env.toObject(), ...env } } : {}),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("readDeclaration parses Script, Asserts, and Capture admissions", () => {
  const readmeAsserts = `
# Title
- Script: scripts/proof.ts
- Asserts: first claim; second claim
`;
  const info1 = readDeclaration(readmeAsserts);
  assertEquals(info1.declared, "scripts/proof.ts");
  assertEquals(info1.isCapture, false);
  assertEquals(info1.asserts, "first claim; second claim");
  assertEquals(info1.executedBy, null);

  const readmeCapture = `
# Title
- Script: \`scripts/capture_proof.ts\`
- Capture: no assertions. Just writes data.
`;
  const info2 = readDeclaration(readmeCapture);
  assertEquals(info2.declared, "scripts/capture_proof.ts");
  assertEquals(info2.isCapture, true);
  assertEquals(info2.executedBy, null);

  const readmeUndeclared = `
# Title with no script
`;
  const info3 = readDeclaration(readmeUndeclared);
  assertEquals(info3.declared, null);
  assertEquals(info3.executedBy, null);
});

Deno.test("readDeclaration parses Executed by field (audio-feed-4oe2)", () => {
  const readmePlain = `
# Title
- Script: scripts/proof.ts
- Executed by: tests/outbox_proof_test.ts
- Asserts: first claim
`;
  const infoPlain = readDeclaration(readmePlain);
  assertEquals(infoPlain.declared, "scripts/proof.ts");
  assertEquals(infoPlain.executedBy, "tests/outbox_proof_test.ts");

  const readmeBackticks = `
# Title
- Script: scripts/proof.ts
- Executed by: \`tests/outbox_proof_test.ts\`
- Asserts: first claim
`;
  const infoBackticks = readDeclaration(readmeBackticks);
  assertEquals(infoBackticks.executedBy, "tests/outbox_proof_test.ts");

  const readmeQuotes = `
# Title
- Script: scripts/proof.ts
- Executed by: "tests/outbox_proof_test.ts"
- Asserts: first claim
`;
  const infoQuotes = readDeclaration(readmeQuotes);
  assertEquals(infoQuotes.executedBy, "tests/outbox_proof_test.ts");

  // Negative direction: absence leaves executedBy as null
  const readmeNoExec = `
# Title
- Script: scripts/proof.ts
- Asserts: first claim
`;
  const infoNoExec = readDeclaration(readmeNoExec);
  assertEquals(infoNoExec.executedBy, null);
});

Deno.test("stripAnsi removes ANSI escape codes so \\bPASS\\b matches colored output", () => {
  const colored = "\x1b[32mPASS\x1b[0m  test passed";
  assertEquals(/\bPASS\b/.test(colored), false); // Without strip, \w precedes P
  assertEquals(/\bPASS\b/.test(stripAnsi(colored)), true); // With strip, matches cleanly
});

Deno.test("findNestedEvidence: flat directories return empty; nested README is detected", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "c0ft-walk-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(join(evidenceRoot, "top-level"), { recursive: true });
    await Deno.writeTextFile(join(evidenceRoot, "top-level", "README.md"), "# Top level");

    // Positive control: flat structure has 0 nested
    const flat = await findNestedEvidence(evidenceRoot);
    assertEquals(flat, []);

    // Negative control: nested directory with undeclared README MUST return false/detected
    const nestedDir = join(evidenceRoot, "top-level", "nested-child");
    await Deno.mkdir(nestedDir, { recursive: true });
    await Deno.writeTextFile(join(nestedDir, "README.md"), "# Nested child");

    const found = await findNestedEvidence(evidenceRoot);
    assertEquals(found, [nestedDir]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("NEGATIVE CONTROL 1 (Walk Refusal): nested directory with undeclared README is refused (exit 1)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "c0ft-neg1-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    const scriptsDir = join(tempDir, "scripts");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.writeTextFile(join(scriptsDir, "proof.ts"), "console.log('PASS test');");

    // Flat valid directory
    await Deno.mkdir(join(evidenceRoot, "audio-feed-valid"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-valid", "README.md"),
      "- Script: scripts/proof.ts\n- Asserts: something\n",
    );

    // Nested directory with undeclared README
    const nested = join(evidenceRoot, "nested-group", "hidden-proof");
    await Deno.mkdir(nested, { recursive: true });
    await Deno.writeTextFile(join(nested, "README.md"), "# Undeclared nested evidence\n");

    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "tier must fail on nested evidence directory");
    assertStringIncludes(
      res.stderr,
      "nested evidence directory is forbidden: docs/evidence/nested-group/hidden-proof",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("NEGATIVE CONTROL 2 (Walk Refusal): nested directory with declared README is refused (exit 1)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "c0ft-neg2-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    const scriptsDir = join(tempDir, "scripts");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.writeTextFile(join(scriptsDir, "proof.ts"), "console.log('PASS test');");

    // Nested directory with declared README
    const nested = join(evidenceRoot, "group", "my-proof");
    await Deno.mkdir(nested, { recursive: true });
    await Deno.writeTextFile(
      join(nested, "README.md"),
      "- Script: scripts/proof.ts\n- Asserts: claim\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "tier must refuse nested declared proof");
    assertStringIncludes(
      res.stderr,
      "nested evidence directory is forbidden: docs/evidence/group/my-proof",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("puhh create-and-assert-refusal: symlinked nested evidence is refused", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "puhh-symlink-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    const target = join(tempDir, "outside-evidence");
    await Deno.mkdir(join(evidenceRoot, "group"), { recursive: true });
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, "README.md"), "# Linked evidence\n");
    await Deno.symlink(target, join(evidenceRoot, "group", "linked"), { type: "dir" });
    await Deno.mkdir(join(evidenceRoot, "valid"));
    await Deno.mkdir(join(tempDir, "scripts"));
    await Deno.writeTextFile(join(tempDir, "scripts", "proof.ts"), "console.log('PASS');\n");
    await Deno.writeTextFile(
      join(evidenceRoot, "valid", "README.md"),
      "- Script: scripts/proof.ts\n- Asserts: claim\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 1);
    assertStringIncludes(
      res.stderr,
      "symlinked evidence path is forbidden: docs/evidence/group/linked",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("puhh: top-level symlink is refused rather than skipped", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "puhh-top-symlink-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    const target = join(tempDir, "outside-evidence");
    await Deno.mkdir(evidenceRoot, { recursive: true });
    await Deno.mkdir(target);
    await Deno.symlink(target, join(evidenceRoot, "linked"), { type: "dir" });
    const res = await runTier(tempDir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "symlinked evidence path is forbidden: docs/evidence/linked");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("gzxr: nested refusal outranks declaration debt but reports both", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "gzxr-both-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(join(evidenceRoot, "debt"), { recursive: true });
    await Deno.writeTextFile(join(evidenceRoot, "debt", "README.md"), "# No script\n");
    await Deno.mkdir(join(evidenceRoot, "valid"));
    await Deno.mkdir(join(tempDir, "scripts"));
    await Deno.writeTextFile(join(tempDir, "scripts", "proof.ts"), "console.log('PASS');\n");
    await Deno.writeTextFile(
      join(evidenceRoot, "valid", "README.md"),
      "- Script: scripts/proof.ts\n- Asserts: claim\n",
    );
    const nested = join(evidenceRoot, "valid", "nested");
    await Deno.mkdir(nested);
    await Deno.writeTextFile(join(nested, "README.md"), "# Nested\n");

    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "refusal is a failure; exit 2 requires every proof to pass");
    assertStringIncludes(
      res.stderr,
      "nested evidence directory is forbidden: docs/evidence/valid/nested",
    );
    assertStringIncludes(res.stdout, "debt: docs/evidence/debt declares no proof");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("01k7: declaration debt names the directory and why; a declared tree has no debt line", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "01k7-debt-" });
  try {
    const evidenceDir = join(tempDir, "docs", "evidence", "audio-feed-undeclared");
    const readme = join(evidenceDir, "README.md");
    const validDir = join(tempDir, "docs", "evidence", "audio-feed-valid");
    await Deno.mkdir(evidenceDir, { recursive: true });
    await Deno.mkdir(validDir);
    await Deno.mkdir(join(tempDir, "scripts"));
    await Deno.writeTextFile(join(tempDir, "scripts", "proof.ts"), "console.log('PASS proof');\n");
    await Deno.writeTextFile(
      join(tempDir, "scripts", "second.ts"),
      "console.log('PASS second');\n",
    );
    await Deno.writeTextFile(join(validDir, "README.md"), "- Script: scripts/proof.ts\n");
    await Deno.writeTextFile(readme, "# Evidence without a Script line\n");

    const undeclared = await runTier(tempDir);
    assertEquals(undeclared.code, 2, "a passing proof does not erase declaration debt");
    assertEquals(
      undeclared.stdout.split("\n").filter((line) => line.startsWith("[evidence] debt:")),
      [
        "[evidence] debt: docs/evidence/audio-feed-undeclared declares no proof " +
        "(no '- Script:' line in its README)",
      ],
    );

    await Deno.writeTextFile(readme, "- Script: scripts/second.ts\n- Asserts: proof passes\n");
    const declared = await runTier(tempDir);
    assertEquals(declared.code, 0, "the declared proof must run and pass");
    assertStringIncludes(declared.stdout, "ok   docs/evidence/audio-feed-undeclared");
    assertEquals(
      declared.stdout.split("\n").filter((line) => line.startsWith("[evidence] debt:")),
      [],
      "a fully declared tree must not report declaration debt",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("NEGATIVE CONTROL 3 (Zero Assertions): script exiting 0 with EMPTY output fails (exit 1)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "c0ft-neg3-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    const scriptsDir = join(tempDir, "scripts");
    await Deno.mkdir(scriptsDir, { recursive: true });

    // Script exits 0 without printing anything
    await Deno.writeTextFile(join(scriptsDir, "silent.ts"), "// Exits 0 silently\n");

    await Deno.mkdir(join(evidenceRoot, "audio-feed-silent"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-silent", "README.md"),
      "- Script: scripts/silent.ts\n- Asserts: silent assertion\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "tier must fail when proof exits 0 with empty output");
    assertStringIncludes(res.stdout, "FAIL docs/evidence/audio-feed-silent");
    assertStringIncludes(res.stdout, "EMPTY OUTPUT");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("NEGATIVE CONTROL 4 (Zero Assertions): script exiting 0 without PASS or OK marker fails (exit 1)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "c0ft-neg4-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    const scriptsDir = join(tempDir, "scripts");
    await Deno.mkdir(scriptsDir, { recursive: true });

    // Script prints dummy text and exits 0, but makes no assertions
    await Deno.writeTextFile(
      join(scriptsDir, "no_assert.ts"),
      "console.log('computed some numbers');\n",
    );

    await Deno.mkdir(join(evidenceRoot, "audio-feed-noassert"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-noassert", "README.md"),
      "- Script: scripts/no_assert.ts\n- Asserts: numbers are correct\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "tier must fail when script produces no PASS or OK assertion marker");
    assertStringIncludes(res.stdout, "FAIL docs/evidence/audio-feed-noassert");
    assertStringIncludes(
      res.stdout,
      "ZERO ASSERTIONS: declared Asserts requires a PASS or OK assertion marker",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("asyl: nonempty output without Asserts or Capture needs no assertion marker", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "asyl-no-asserts-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence", "plain");
    await Deno.mkdir(evidenceRoot, { recursive: true });
    await Deno.mkdir(join(tempDir, "scripts"));
    await Deno.writeTextFile(
      join(tempDir, "scripts", "plain.ts"),
      "console.log('computed numbers');\n",
    );
    await Deno.writeTextFile(join(evidenceRoot, "README.md"), "- Script: scripts/plain.ts\n");

    const res = await runTier(tempDir);
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "ok   docs/evidence/plain");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("POSITIVE CONTROLS: passing proof scripts (PASS, OK, Capture, and ANSI PASS)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "c0ft-pos-" });
  try {
    const evidenceRoot = join(tempDir, "docs", "evidence");
    const scriptsDir = join(tempDir, "scripts");
    await Deno.mkdir(scriptsDir, { recursive: true });

    // 1. Script with standard PASS
    await Deno.writeTextFile(join(scriptsDir, "pass.ts"), "console.log('PASS test passed');\n");
    await Deno.mkdir(join(evidenceRoot, "audio-feed-pass"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-pass", "README.md"),
      "- Script: scripts/pass.ts\n- Asserts: claim\n",
    );

    // 2. Script with OK (like repro_u2ve / repro_b6nr)
    await Deno.writeTextFile(join(scriptsDir, "ok.ts"), "console.log('OK: bound held');\n");
    await Deno.mkdir(join(evidenceRoot, "audio-feed-ok"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-ok", "README.md"),
      "- Script: scripts/ok.ts\n- Asserts: claim\n",
    );

    // 3. Script with ANSI-colored PASS (like verify_3asd, tokens, etc.)
    await Deno.writeTextFile(
      join(scriptsDir, "ansi.ts"),
      "console.log('\\x1b[32mPASS\\x1b[0m colored check');\n",
    );
    await Deno.mkdir(join(evidenceRoot, "audio-feed-ansi"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-ansi", "README.md"),
      "- Script: scripts/ansi.ts\n- Asserts: claim\n",
    );

    // 4. Capture script with - Capture: no assertions (like repro_tts_failure_bp6r)
    await Deno.writeTextFile(join(scriptsDir, "capture.ts"), "console.log('wrote repro.json');\n");
    await Deno.mkdir(join(evidenceRoot, "audio-feed-capture"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-capture", "README.md"),
      "- Script: scripts/capture.ts\n- Capture: no assertions\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 0, "all positive control proofs must pass");
    assertStringIncludes(res.stdout, "ok   docs/evidence/audio-feed-pass");
    assertStringIncludes(res.stdout, "ok   docs/evidence/audio-feed-ok");
    assertStringIncludes(res.stdout, "ok   docs/evidence/audio-feed-ansi");
    assertStringIncludes(res.stdout, "ok   docs/evidence/audio-feed-capture");
    assertStringIncludes(res.stdout, "every declared proof passed on this tree (4 proof(s))");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("evidence-run --list shows [executed by: ...] for declared executor and flags unresolved executor (audio-feed-4oe2)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "4oe2-list-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const testsDir = join(tempDir, "tests");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.mkdir(testsDir, { recursive: true });

    await Deno.writeTextFile(join(scriptsDir, "proof.ts"), "console.log('PASS ok');\n");
    // audio-feed-zmwa1: a valid executor must REFERENCE the proof, not merely exist.
    // audio-feed-377of: the reference must be in CODE - a path constant the suite uses to spawn the
    // proof - because a comment naming the proof executes nothing and bought silence for free.
    await Deno.writeTextFile(
      join(testsDir, "my_suite_test.ts"),
      'const proofPath = new URL("../scripts/proof.ts", import.meta.url);\n',
    );

    // Valid executor
    await Deno.mkdir(join(evidenceRoot, "audio-feed-valid"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-valid", "README.md"),
      "- Script: scripts/proof.ts\n- Executed by: tests/my_suite_test.ts\n- Asserts: claim\n",
    );

    // Stale / missing executor
    await Deno.mkdir(join(evidenceRoot, "audio-feed-stale"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-stale", "README.md"),
      "- Script: scripts/proof.ts\n- Executed by: tests/ghost_test.ts\n- Asserts: claim\n",
    );

    // No executor declared (negative control)
    await Deno.mkdir(join(evidenceRoot, "audio-feed-no-exec"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-no-exec", "README.md"),
      "- Script: scripts/proof.ts\n- Asserts: claim\n",
    );

    const res = await runTier(tempDir, ["--list"]);
    assertEquals(res.code, 0);

    // Valid executor line
    assertStringIncludes(
      res.stdout,
      "declared   docs/evidence/audio-feed-valid -> scripts/proof.ts [executed by: tests/my_suite_test.ts]",
    );

    // Stale executor line
    assertStringIncludes(
      res.stdout,
      "declared   docs/evidence/audio-feed-stale -> scripts/proof.ts [UNRESOLVED EXECUTOR: tests/ghost_test.ts]",
    );

    // Negative control: no executor annotation; the record annotation for a fresh fixture is
    // ` [no record]` (audio-feed-h22ml: --list annotates records, never fails on them).
    assertStringIncludes(
      res.stdout,
      "declared   docs/evidence/audio-feed-no-exec -> scripts/proof.ts [no record]",
    );

    // Inventory line notes unresolved executor
    assertStringIncludes(res.stdout, "1 unresolved executor(s)");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("a proof whose README declares a RESOLVED - Executed by: suite is NOT executed directly by the runner (audio-feed-opqvh)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "opqvh-suite-owned-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const testsDir = join(tempDir, "tests");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.mkdir(testsDir, { recursive: true });

    // The proof prints this marker ONLY if it is spawned. If the runner honours the declared
    // suite ownership it never runs, so the marker must be absent from the tier's output while
    // the skip is named - the pair is the evidence both directions. The suite REFERENCES the
    // proof (audio-feed-zmwa1: ownership must be visible in the suite's own text), and since
    // audio-feed-377of that reference must be CODE: the suite's own spawn target, not a comment.
    await Deno.writeTextFile(
      join(scriptsDir, "proof.ts"),
      `console.log("PASS executed directly by the runner");\n`,
    );
    await Deno.writeTextFile(
      join(testsDir, "owning_suite_test.ts"),
      'const proofPath = new URL("../scripts/proof.ts", import.meta.url).pathname;\n',
    );

    await Deno.mkdir(join(evidenceRoot, "audio-feed-owned"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-owned", "README.md"),
      "- Script: scripts/proof.ts\n- Executed by: tests/owning_suite_test.ts\n- Asserts: claim\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 0);
    assertStringIncludes(
      res.stdout,
      "SKIP docs/evidence/audio-feed-owned -> scripts/proof.ts " +
        "(suite-owned: executed by tests/owning_suite_test.ts; not run directly)",
    );
    assertEquals(
      res.stdout.includes("ok   docs/evidence/audio-feed-owned"),
      false,
      "a suite-owned proof must not get a run verdict: the runner did not execute it",
    );
    assertEquals(
      res.stdout.includes("executed directly by the runner"),
      false,
      "the proof's own output must be absent: the runner never spawned it",
    );
    assertStringIncludes(res.stdout, "1 suite-owned");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test(
  "NEGATIVE CONTROL (Unlinked Executor): a declared suite that never references the proof refuses the run (audio-feed-zmwa1)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "zmwa1-unlinked-" });
    try {
      const scriptsDir = join(tempDir, "scripts");
      const testsDir = join(tempDir, "tests");
      const evidenceRoot = join(tempDir, "docs", "evidence");
      await Deno.mkdir(scriptsDir, { recursive: true });
      await Deno.mkdir(testsDir, { recursive: true });

      // The suite EXISTS but its text never mentions scripts/proof.ts - exactly the fixture shape
      // that used to silence the proof. The runner must refuse loudly, not skip and not execute.
      await Deno.writeTextFile(
        join(scriptsDir, "proof.ts"),
        `console.log("PASS executed directly by the runner");\n`,
      );
      await Deno.writeTextFile(
        join(testsDir, "owning_suite_test.ts"),
        "// unrelated suite: exercises a module with no connection to any proof\n",
      );

      await Deno.mkdir(join(evidenceRoot, "audio-feed-zmwa1"), { recursive: true });
      await Deno.writeTextFile(
        join(evidenceRoot, "audio-feed-zmwa1", "README.md"),
        "- Script: scripts/proof.ts\n- Executed by: tests/owning_suite_test.ts\n- Asserts: claim\n",
      );

      const res = await runTier(tempDir);
      assertEquals(res.code, 1, "an unlinked executor must refuse the run, not honour the skip");
      assertStringIncludes(
        res.stderr,
        "[evidence] FAIL docs/evidence/audio-feed-zmwa1 -> scripts/proof.ts " +
          "(UNLINKED EXECUTOR: tests/owning_suite_test.ts has no code reference to scripts/proof.ts - " +
          "the suite must name the proof path in an import or string literal, not in a comment or a bare basename)",
      );
      assertStringIncludes(
        res.stderr,
        "[evidence] RED: 1 declared executor(s) never reference the proof they are declared to own",
      );
      assertEquals(
        res.stdout.includes("SKIP docs/evidence/audio-feed-zmwa1"),
        false,
        "an unlinked executor must not be honoured as a skip: existence alone is not ownership",
      );
      assertEquals(
        res.stdout.includes("executed directly by the runner"),
        false,
        "an unlinked executor must not silently execute the proof either: the declaration says the suite owns it",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

/**
 * audio-feed-377of: THE LINKAGE RULE, TIGHTENED - a cosmetic comment must not be able to buy a skip.
 *
 * The unit rows below pin the RULE in both directions, and they are written against the two shapes
 * that review measured on fleet/executor-link 01576e93: a comment naming the proof (executes nothing)
 * and a bare basename (matches an unrelated file). The tier rows that follow prove the same two
 * shapes end to end, through the CLI, because a rule that only the unit rows can see is not a tier.
 */
Deno.test("referencesProofInCode accepts a quoted path in code and rejects a comment or a bare basename (audio-feed-377of)", () => {
  assert(
    referencesProofInCode(
      'import { deriveLadderConstants } from "../scripts/exww-attempt-measure.ts";\n',
      "scripts/exww-attempt-measure.ts",
    ),
    "an import specifier naming the proof path is the canonical code reference",
  );
  assert(
    referencesProofInCode(
      'const proofPath = new URL("../scripts/outbox-proof.ts", import.meta.url).pathname;\n',
      "scripts/outbox-proof.ts",
    ),
    "a string literal naming the proof path is a code reference",
  );
  assert(
    referencesProofInCode('const same = "./scripts/outbox-proof.ts";\n', "scripts/outbox-proof.ts"),
    "a ./ prefixed relative path is the same file and must link",
  );
  assertEquals(
    referencesProofInCode(
      "// owning suite: spawns scripts/outbox-proof.ts out-of-process and asserts its PASS marker\n",
      "scripts/outbox-proof.ts",
    ),
    false,
    "a comment naming the proof executes nothing: one cosmetic comment must not silence the tier",
  );
  assertEquals(
    referencesProofInCode(
      '/* spawns "../scripts/outbox-proof.ts" per the audit */\nconst x = 1;\n',
      "scripts/outbox-proof.ts",
    ),
    false,
    "a QUOTED path inside a well-formed block comment is still a comment, not code",
  );
  assertEquals(
    referencesProofInCode('const target = "outbox-proof.ts";\n', "scripts/outbox-proof.ts"),
    false,
    "a bare basename is not the declared path and can match an unrelated file",
  );
  assertEquals(
    referencesProofInCode(
      'const target = "other/scripts/outbox-proof.ts";\n',
      "scripts/outbox-proof.ts",
    ),
    false,
    "a longer path that merely ends in the declared path is a different file",
  );
});

Deno.test("the two real suite-owned declarations still LINK after the tightening (audio-feed-377of)", async () => {
  const root = fromFileUrl(new URL("../", import.meta.url));
  const { declarations } = await collect({
    list: true,
    timeoutMs: 300_000,
    root,
    explicitTimeout: false,
  });
  const expected = [
    {
      dir: "docs/evidence/audio-feed-8u4x1",
      declared: "scripts/exww-attempt-measure.ts",
      executedBy: "tests/exww_mutants_test.ts",
    },
    {
      dir: "docs/evidence/audio-feed-np5",
      declared: "scripts/outbox-proof.ts",
      executedBy: "tests/outbox_proof_test.ts",
    },
  ];
  for (const want of expected) {
    const declaration = declarations.find((d) => d.dir === want.dir);
    assert(declaration, `the real tree must still declare ${want.dir}`);
    assertEquals(declaration.declared, want.declared);
    assertEquals(declaration.executedBy, want.executedBy);
    assertEquals(
      declaration.executorReferencesProof,
      true,
      `${want.executedBy} names ${want.declared} in code, so the tightened rule must still link it ` +
        `- if this row fails the DECLARATION needs fixing, not the rule`,
    );
  }
});

Deno.test(
  "NEGATIVE CONTROL (Cosmetic Comment): a suite that names the proof only in a comment refuses (audio-feed-377of)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "377of-comment-only-" });
    try {
      const scriptsDir = join(tempDir, "scripts");
      const testsDir = join(tempDir, "tests");
      const evidenceRoot = join(tempDir, "docs", "evidence");
      await Deno.mkdir(scriptsDir, { recursive: true });
      await Deno.mkdir(testsDir, { recursive: true });

      // THIS IS THE ROW THE TIGHTENING EXISTS FOR. The suite's comment names the proof, which the
      // first linkage rule accepted, and the suite executes nothing: one cosmetic comment bought a
      // SKIP for a proof nobody ran.
      await Deno.writeTextFile(
        join(scriptsDir, "proof.ts"),
        `console.log("PASS executed directly by the runner");\n`,
      );
      await Deno.writeTextFile(
        join(testsDir, "owning_suite_test.ts"),
        "// owning suite: spawns scripts/proof.ts out-of-process and asserts its PASS marker\n",
      );

      await Deno.mkdir(join(evidenceRoot, "audio-feed-377of"), { recursive: true });
      await Deno.writeTextFile(
        join(evidenceRoot, "audio-feed-377of", "README.md"),
        "- Script: scripts/proof.ts\n- Executed by: tests/owning_suite_test.ts\n- Asserts: claim\n",
      );

      const res = await runTier(tempDir);
      assertEquals(res.code, 1, "a comment is not ownership: the tier must refuse, not skip");
      assertStringIncludes(
        res.stderr,
        "[evidence] FAIL docs/evidence/audio-feed-377of -> scripts/proof.ts " +
          "(UNLINKED EXECUTOR: tests/owning_suite_test.ts has no code reference to scripts/proof.ts - " +
          "the suite must name the proof path in an import or string literal, not in a comment or a bare basename)",
      );
      assertEquals(
        res.stdout.includes("SKIP docs/evidence/audio-feed-377of"),
        false,
        "a comment-only reference must not be honoured as a skip",
      );
      assertEquals(
        res.stdout.includes("executed directly by the runner"),
        false,
        "and it must not be silently executed either: the declaration says the suite owns it",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "NEGATIVE CONTROL (Bare Basename): a suite naming only the proof's basename refuses (audio-feed-377of)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "377of-basename-" });
    try {
      const scriptsDir = join(tempDir, "scripts");
      const testsDir = join(tempDir, "tests");
      const evidenceRoot = join(tempDir, "docs", "evidence");
      await Deno.mkdir(scriptsDir, { recursive: true });
      await Deno.mkdir(testsDir, { recursive: true });

      // A bare basename is a DIFFERENT file's name as often as the proof's: `proof.ts` exists in
      // three directories of this repository. Naming it without the path used to link.
      await Deno.writeTextFile(
        join(scriptsDir, "proof.ts"),
        `console.log("PASS executed directly by the runner");\n`,
      );
      await Deno.writeTextFile(
        join(testsDir, "owning_suite_test.ts"),
        'const unrelated = "proof.ts";\n',
      );

      await Deno.mkdir(join(evidenceRoot, "audio-feed-basename"), { recursive: true });
      await Deno.writeTextFile(
        join(evidenceRoot, "audio-feed-basename", "README.md"),
        "- Script: scripts/proof.ts\n- Executed by: tests/owning_suite_test.ts\n- Asserts: claim\n",
      );

      const res = await runTier(tempDir);
      assertEquals(res.code, 1, "a bare basename must refuse the run, not honour the skip");
      assertStringIncludes(
        res.stderr,
        "[evidence] FAIL docs/evidence/audio-feed-basename -> scripts/proof.ts " +
          "(UNLINKED EXECUTOR: tests/owning_suite_test.ts has no code reference to scripts/proof.ts - " +
          "the suite must name the proof path in an import or string literal, not in a comment or a bare basename)",
      );
      assertEquals(
        res.stdout.includes("SKIP docs/evidence/audio-feed-basename"),
        false,
        "a basename is not the proof path: it must not buy a skip",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test("NEGATIVE CONTROL (Unresolved Executor): missing declared executor fails evidence-run (audio-feed-4oe2)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "4oe2-run-fail-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.writeTextFile(join(scriptsDir, "proof.ts"), "console.log('PASS claim');\n");

    // Stale executor naming nonexistent test file
    await Deno.mkdir(join(evidenceRoot, "audio-feed-stale"), { recursive: true });
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-stale", "README.md"),
      "- Script: scripts/proof.ts\n- Executed by: tests/ghost_test.ts\n- Asserts: claim\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "missing executor must fail the run");
    assertStringIncludes(
      res.stderr,
      "[evidence] FAIL docs/evidence/audio-feed-stale -> executor tests/ghost_test.ts (UNRESOLVED EXECUTOR: not a file)",
    );
    assertStringIncludes(
      res.stderr,
      "[evidence] RED: 1 declared executor(s) do not exist; refusing run - stale executor declarations must be fixed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readDeclaration parses valid - Timeout: variants (audio-feed-kphw)", () => {
  const readmeNumeric = `
# Title
- Script: scripts/proof.ts
- Timeout: 600
- Asserts: claim
`;
  const info1 = readDeclaration(readmeNumeric);
  assertEquals(info1.declared, "scripts/proof.ts");
  assertEquals(info1.timeoutSec, 600);
  assertEquals(info1.rawTimeout, "600");
  assertEquals(info1.timeoutMalformed, false);

  const readmeSecondsSuffix = `
# Title
- Script: scripts/proof.ts
- Timeout: 600s
`;
  const info2 = readDeclaration(readmeSecondsSuffix);
  assertEquals(info2.timeoutSec, 600);
  assertEquals(info2.timeoutMalformed, false);

  const readmeQuotes = `
# Title
- Script: scripts/proof.ts
- Timeout: "350"
`;
  const info3 = readDeclaration(readmeQuotes);
  assertEquals(info3.timeoutSec, 350);
  assertEquals(info3.timeoutMalformed, false);

  const readmeBackticks = `
# Title
- Script: scripts/proof.ts
- Timeout: \`120.5\`
`;
  const info4 = readDeclaration(readmeBackticks);
  assertEquals(info4.timeoutSec, 120.5);
  assertEquals(info4.timeoutMalformed, false);

  // Negative control: absence leaves timeoutSec as null, not malformed
  const readmeNoTimeout = `
# Title
- Script: scripts/proof.ts
`;
  const info5 = readDeclaration(readmeNoTimeout);
  assertEquals(info5.timeoutSec, null);
  assertEquals(info5.rawTimeout, null);
  assertEquals(info5.timeoutMalformed, false);
});

Deno.test("readDeclaration identifies malformed - Timeout: declarations (audio-feed-kphw)", () => {
  const malformedCases = [
    { text: "- Timeout: invalid", raw: "invalid" },
    { text: "- Timeout: -10", raw: "-10" },
    { text: "- Timeout: 0", raw: "0" },
    { text: "- Timeout: 0.5", raw: "0.5" },
    { text: "- Timeout: 0.0004", raw: "0.0004" },
    { text: "- Timeout:", raw: "" },
    { text: "- Timeout: NaN", raw: "NaN" },
  ];

  for (const c of malformedCases) {
    const readme = `# Title\n- Script: scripts/proof.ts\n${c.text}\n`;
    const info = readDeclaration(readme);
    assertEquals(
      info.timeoutMalformed,
      true,
      `expected '${c.text}' to be flagged malformed`,
    );
    assertEquals(info.timeoutSec, null);
    assertEquals(info.rawTimeout, c.raw);
  }
});

Deno.test("readDeclaration ignores - Timeout: and - Script: inside fenced markdown code blocks (audio-feed-kphw)", () => {
  const readme = `
# Title
Example proof setup:
\`\`\`markdown
- Script: scripts/fenced_proof.ts
- Timeout: 600
- Asserts: claim
\`\`\`
Actual declaration outside fence:
- Script: scripts/real_proof.ts
- Timeout: 45
`;
  const info = readDeclaration(readme);
  assertEquals(info.declared, "scripts/real_proof.ts");
  assertEquals(info.timeoutSec, 45);
  assertEquals(info.rawTimeout, "45");

  // Pure example readme with only fenced declarations
  const docOnly = `
# Documentation
\`\`\`
- Script: scripts/doc_example.ts
- Timeout: 600
\`\`\`
`;
  const docInfo = readDeclaration(docOnly);
  assertEquals(docInfo.declared, null);
  assertEquals(docInfo.timeoutSec, null);
  assertEquals(docInfo.rawTimeout, null);
  assertEquals(docInfo.timeoutMalformed, false);
});

Deno.test("explicit --timeout flag overrides declared README bound with [flag] provenance (audio-feed-kphw)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "kphw-flag-overrides-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.mkdir(join(evidenceRoot, "audio-feed-long"), { recursive: true });

    // Script parks until killed by timeout; large safety bound ensures the timeout kill is the only exit path (audio-feed-8bwnx)
    await Deno.writeTextFile(
      join(scriptsDir, "proof.ts"),
      `await new Promise((r) => setTimeout(r, 120_000));\nconsole.log("PASS finished");\n`,
    );

    // Declares Timeout: 5, while operator passes --timeout 1.
    // Explicit --timeout 1 MUST OVERRIDE declared 5s, killing the parked proof at 1s with [flag] provenance.
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-long", "README.md"),
      "- Script: scripts/proof.ts\n- Timeout: 5\n- Asserts: finished\n",
    );

    const res = await runTier(tempDir, ["--timeout", "1"]);
    assertEquals(res.code, 1, "explicit --timeout 1 must override declared bound and exit 1");
    assertStringIncludes(
      res.stdout,
      "UNKNOWN (exceeded the 1s bound [flag]; raise --timeout to decide it)",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveBound reports provenance for flag, declared, and default (audio-feed-kphw)", () => {
  // Case 1: Flag supplied explicitly overrides declaration
  const optionsWithFlag = parseOptions(["--timeout", "10"]);
  assertEquals(optionsWithFlag.explicitTimeout, true);
  assertEquals(optionsWithFlag.timeoutMs, 10_000);
  const bound1 = resolveBound(optionsWithFlag, {
    dir: "docs/evidence/test",
    declared: "scripts/proof.ts",
    exists: true,
    isCapture: false,
    asserts: null,
    executedBy: null,
    timeoutMs: 60_000,
  });
  assertEquals(bound1.provenance, "flag");
  assertEquals(bound1.timeoutMs, 10_000);
  assertEquals(bound1.boundSec, 10);

  // Case 2: Flag not supplied; README declaration overrides built-in default
  const optionsNoFlag = parseOptions([]);
  assertEquals(optionsNoFlag.explicitTimeout, false);
  assertEquals(optionsNoFlag.timeoutMs, 300_000);
  const bound2 = resolveBound(optionsNoFlag, {
    dir: "docs/evidence/test",
    declared: "scripts/proof.ts",
    exists: true,
    isCapture: false,
    asserts: null,
    executedBy: null,
    timeoutMs: 60_000,
  });
  assertEquals(bound2.provenance, "declared");
  assertEquals(bound2.timeoutMs, 60_000);
  assertEquals(bound2.boundSec, 60);

  // Case 3: Flag not supplied and no declaration; built-in default is used
  const bound3 = resolveBound(optionsNoFlag, {
    dir: "docs/evidence/test",
    declared: "scripts/proof.ts",
    exists: true,
    isCapture: false,
    asserts: null,
    executedBy: null,
    timeoutMs: undefined,
  });
  assertEquals(bound3.provenance, "default");
  assertEquals(bound3.timeoutMs, 300_000);
  assertEquals(bound3.boundSec, 300);
});

Deno.test("missing declaration with explicit flag reports [flag] provenance (audio-feed-kphw)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "kphw-default-provenance-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.mkdir(join(evidenceRoot, "audio-feed-undeclared"), { recursive: true });

    // Script parks until killed by timeout; large safety bound ensures the timeout kill is the only exit path (audio-feed-4ltgn)
    await Deno.writeTextFile(
      join(scriptsDir, "proof.ts"),
      `await new Promise((r) => setTimeout(r, 120_000));\nconsole.log("PASS finished");\n`,
    );

    // No Timeout declared in README
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-undeclared", "README.md"),
      "- Script: scripts/proof.ts\n- Asserts: finished\n",
    );

    // Global bound of 1s passed via flag will kill the 1.5s proof -> UNKNOWN with [flag] provenance
    const res = await runTier(tempDir, ["--timeout", "1"]);
    assertEquals(res.code, 1, "exceeded flag bound must report UNKNOWN / exit 1");
    assertStringIncludes(
      res.stdout,
      "UNKNOWN (exceeded the 1s bound [flag]; raise --timeout to decide it)",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("declared bound exceedance reports [declared] provenance (audio-feed-kphw)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "kphw-declared-provenance-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.mkdir(join(evidenceRoot, "audio-feed-tight"), { recursive: true });

    // Script parks until killed by timeout; large safety bound ensures the timeout kill is the only exit path (audio-feed-nszl8)
    await Deno.writeTextFile(
      join(scriptsDir, "proof.ts"),
      `await new Promise((r) => setTimeout(r, 120_000));\nconsole.log("PASS finished");\n`,
    );

    // README declares tight 2s bound
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-tight", "README.md"),
      "- Script: scripts/proof.ts\n- Timeout: 2\n- Asserts: finished\n",
    );

    // Run without --timeout flag; declared 2s bound must kill it -> [declared] provenance
    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "exceeded declared bound must report UNKNOWN / exit 1");
    assertStringIncludes(
      res.stdout,
      "UNKNOWN (exceeded the 2s bound [declared]; raise --timeout to decide it)",
    );

    // Negative control per reviewer finding P1(a)/P1(b): explicit --timeout 1 overrides declared 2s bound
    // with shorter timeout, killing the parked proof at 1s with [flag] provenance. Proves the requested
    // value was applied (not default 300s, not declared 2s) while keeping the child blocked without timing delays.
    //
    // The bound/provenance line is asserted BEFORE the exit code on purpose (audio-feed-p4snp): an
    // exit-code-first assertion fires before the bound is ever compared, so when the --timeout value is
    // discarded while the flag is still accepted the red names only the exit code and hides which bound
    // actually ran. Bound first makes that red name the effective bound and its provenance.
    const resOverride = await runTier(tempDir, ["--timeout", "1"]);
    assertStringIncludes(
      resOverride.stdout,
      "UNKNOWN (exceeded the 1s bound [flag]; raise --timeout to decide it)",
    );
    assertEquals(
      resOverride.code,
      1,
      "explicit --timeout 1 must override declared bound and exit 1",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("malformed - Timeout: in scriptless README refuses run (exit 1) rather than debt exit 2 (audio-feed-kphw)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "kphw-scriptless-bad-timeout-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.mkdir(join(evidenceRoot, "audio-feed-passing"), { recursive: true });
    await Deno.mkdir(join(evidenceRoot, "audio-feed-unfinished"), { recursive: true });

    // Passing proof
    await Deno.writeTextFile(
      join(scriptsDir, "proof.ts"),
      `console.log("PASS ok");\n`,
    );
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-passing", "README.md"),
      "- Script: scripts/proof.ts\n- Asserts: ok\n",
    );

    // Unfinished directory has NO - Script: line, but has a malformed - Timeout:
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-unfinished", "README.md"),
      "# Unfinished Proof\n- Timeout: invalid-timeout\n",
    );

    const res = await runTier(tempDir);
    assertEquals(
      res.code,
      1,
      "malformed timeout in scriptless README must exit 1 (refusal), not exit 2 (debt)",
    );
    assertStringIncludes(
      res.stderr,
      "[evidence] FAIL docs/evidence/audio-feed-unfinished -> timeout 'invalid-timeout' (UNRESOLVED TIMEOUT: expected positive number of seconds)",
    );
    assertStringIncludes(
      res.stderr,
      "[evidence] RED: 1 declared timeout(s) are malformed; refusing run - malformed timeout declarations must be fixed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("parseOptions rejects sub-second --timeout flag (< 1s) (audio-feed-kphw)", () => {
  assertThrows(
    () => parseOptions(["--timeout", "0.5"]),
    Error,
    "--timeout needs a positive number of seconds (>= 1)",
  );
  assertThrows(
    () => parseOptions(["--timeout", "0"]),
    Error,
    "--timeout needs a positive number of seconds (>= 1)",
  );
});

Deno.test("sub-second - Timeout: (< 1s) is refused as UNRESOLVED TIMEOUT (audio-feed-kphw)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "kphw-subsecond-refused-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.mkdir(join(evidenceRoot, "audio-feed-subsecond"), { recursive: true });

    await Deno.writeTextFile(
      join(scriptsDir, "proof.ts"),
      `console.log("PASS ok");\n`,
    );

    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-subsecond", "README.md"),
      "- Script: scripts/proof.ts\n- Timeout: 0.5\n- Asserts: ok\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "sub-second timeout must exit 1 (refusal)");
    assertStringIncludes(
      res.stderr,
      "[evidence] FAIL docs/evidence/audio-feed-subsecond -> timeout '0.5' (UNRESOLVED TIMEOUT: expected positive number of seconds)",
    );
    assertStringIncludes(
      res.stderr,
      "[evidence] RED: 1 declared timeout(s) are malformed; refusing run - malformed timeout declarations must be fixed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("malformed - Timeout: is an UNRESOLVED failure (exit 1) refusing the run (audio-feed-kphw)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "kphw-malformed-refused-" });
  try {
    const scriptsDir = join(tempDir, "scripts");
    const evidenceRoot = join(tempDir, "docs", "evidence");
    await Deno.mkdir(scriptsDir, { recursive: true });
    await Deno.mkdir(join(evidenceRoot, "audio-feed-bad-timeout"), { recursive: true });

    await Deno.writeTextFile(
      join(scriptsDir, "proof.ts"),
      `console.log("PASS ok");\n`,
    );

    // README carries malformed Timeout
    await Deno.writeTextFile(
      join(evidenceRoot, "audio-feed-bad-timeout", "README.md"),
      "- Script: scripts/proof.ts\n- Timeout: unparseable-garbage\n- Asserts: ok\n",
    );

    const res = await runTier(tempDir);
    assertEquals(res.code, 1, "malformed timeout must exit 1 (refusal)");
    assertStringIncludes(
      res.stderr,
      "[evidence] FAIL docs/evidence/audio-feed-bad-timeout -> timeout 'unparseable-garbage' (UNRESOLVED TIMEOUT: expected positive number of seconds)",
    );
    assertStringIncludes(
      res.stderr,
      "[evidence] RED: 1 declared timeout(s) are malformed; refusing run - malformed timeout declarations must be fixed",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

/**
 * audio-feed-h22ml — THE RUN.JSON RECORD TIER, under test.
 *
 * The fabrication matrix below walks every state a record can be in and asserts the named failure
 * for each, through the real CLI against a scratch root (`--root`, the tier's own mechanism), plus
 * exit 0 for the honest state. The scratch root is a REAL git repository because staleness is
 * `git merge-base --is-ancestor`, and it carries an ORPHAN commit so the foreign-sha row exercises
 * the true not-an-ancestor path rather than a malformed-sha one.
 */

async function gitRun(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "piped" });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

/**
 * A scratch evidence tree with one trivial proof that writes a DETERMINISTIC artefact (stable
 * sha256 across runs), declared in a README, inside a real one-commit git repository that also
 * carries an orphan `ghost` commit (a valid commit that is NOT an ancestor of HEAD).
 */
async function makeRecordScratch(): Promise<{
  root: string;
  dirAbs: string;
  ghostSha: string;
  cleanup(): Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "h22ml-" });
  const dirAbs = join(root, "docs", "evidence", "h22ml-scratch");
  await Deno.mkdir(dirAbs, { recursive: true });
  await Deno.mkdir(join(root, "scripts"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "scripts", "trivial-proof.ts"),
    `const dir = new URL("../docs/evidence/h22ml-scratch/", import.meta.url);\n` +
      `await Deno.writeTextFile(new URL("repro.json", dir), JSON.stringify({ n: 1 }));\n` +
      `console.log("PASS trivial proof");\n`,
  );
  await Deno.writeTextFile(
    join(dirAbs, "README.md"),
    "- Script: scripts/trivial-proof.ts\n- Asserts: the trivial proof passes\n",
  );
  const seedSteps = [
    ["init"],
    ["config", "user.email", "fleet@example.invalid"],
    ["config", "user.name", "fleet"],
    ["add", "-A"],
    ["commit", "-m", "seed"],
  ];
  for (const args of seedSteps) {
    const res = await gitRun(root, args);
    assertEquals(res.code, 0, `git ${args.join(" ")} must succeed: ${res.stderr}`);
  }
  const seedSha = (await gitRun(root, ["rev-parse", "HEAD"])).stdout;
  for (
    const args of [["checkout", "--orphan", "ghost"], ["commit", "-m", "ghost"], [
      "checkout",
      seedSha,
    ]]
  ) {
    const res = await gitRun(root, args);
    assertEquals(res.code, 0, `git ${args.join(" ")} must succeed: ${res.stderr}`);
  }
  const ghostSha = (await gitRun(root, ["rev-parse", "ghost"])).stdout;
  assertEquals(
    /^[0-9a-f]{40}$/.test(ghostSha),
    true,
    "the ghost commit must be a real 40-hex commit",
  );
  return { root, dirAbs, ghostSha, cleanup: () => Deno.remove(root, { recursive: true }) };
}

function expectOk(read: Awaited<ReturnType<typeof readRunRecord>>): RunRecord {
  if (read.state !== "ok") throw new Error(`record must parse; got state ${read.state}`);
  return read.record;
}

async function mutateRecord(dirAbs: string, patch: Partial<RunRecord>): Promise<void> {
  const record = expectOk(await readRunRecord(dirAbs));
  await Deno.writeTextFile(
    join(dirAbs, RECORD_FILE),
    JSON.stringify({ ...record, ...patch }, null, 2) + "\n",
  );
}

Deno.test(
  "FABRICATION MATRIX (audio-feed-h22ml): missing record / foreign sha / 31-day-old / exit 1 / marker false / tampered artefact each name their failure; the honest state exits 0",
  async () => {
    const h = await makeRecordScratch();
    try {
      // SEED: one honest tier run writes the record the matrix then fabricates against.
      const seed = await runTier(h.root);
      assertEquals(seed.code, 0, `seed run must pass: ${seed.stdout}\n${seed.stderr}`);
      assertStringIncludes(seed.stdout, "has no run.json yet (seed phase");
      const seeded = expectOk(await readRunRecord(h.dirAbs));
      assertEquals(seeded.exit, 0);
      assertEquals(seeded.marker, true);

      // THE HONEST STATE: exit 0, no incidents, and the rewritten record is well-formed.
      const honest = await runTier(h.root);
      assertEquals(honest.code, 0, `honest state must exit 0: ${honest.stdout}\n${honest.stderr}`);
      assertStringIncludes(honest.stdout, "ok   docs/evidence/h22ml-scratch");
      assertEquals(honest.stdout.includes("record incident"), false);
      const fresh = expectOk(await readRunRecord(h.dirAbs));
      assertEquals(fresh.exit, 0);
      assertEquals(fresh.marker, true);
      assertEquals(fresh.bound.provenance, "default");
      assertEquals(fresh.bound.ms, 300_000);
      assertEquals(/^[0-9a-f]{40}$/.test(fresh.sha), true, "sha must be 40-hex HEAD");
      assertEquals(Object.keys(fresh.artefacts), ["repro.json"]);
      assert(fresh.artefacts["repro.json"]!.startsWith("sha256:"));
      assert(Number.isNaN(Date.parse(fresh.startedAt)) === false, "startedAt must be ISO");
      assert(Number.isNaN(Date.parse(fresh.endedAt)) === false, "endedAt must be ISO");
      assertEquals(fresh.script, "scripts/trivial-proof.ts");

      // MISSING RECORD. Amendment 1: the missing-record incident is ARMED only behind
      // EVIDENCE_RECORDS_ENFORCED; while unarmed the tier seeds silently (this branch asserts the
      // behaviour that matches the constant, and the armed validator is pinned by its own row).
      await Deno.remove(join(h.dirAbs, RECORD_FILE));
      const missing = await runTier(h.root);
      if (EVIDENCE_RECORDS_ENFORCED) {
        assertEquals(missing.code, 1, "armed: a missing record is a named failure");
        assertStringIncludes(
          missing.stdout,
          "RECORD MISSING: no run.json in docs/evidence/h22ml-scratch",
        );
        assertStringIncludes(missing.stdout, "a claimed run must leave a checkable record");
      } else {
        assertEquals(missing.code, 0, "unarmed: a missing record seeds silently (amendment 1)");
        assertStringIncludes(
          missing.stdout,
          "has no run.json yet (seed phase: writing one this run)",
        );
      }
      assertEquals(
        expectOk(await readRunRecord(h.dirAbs)).exit,
        0,
        "the run must still leave a record",
      );

      // FOREIGN SHA: a real commit that is not an ancestor of HEAD is visibly stale.
      await mutateRecord(h.dirAbs, { sha: h.ghostSha });
      const foreign = await runTier(h.root);
      assertEquals(foreign.code, 1, "a foreign sha must exit 1");
      assertStringIncludes(
        foreign.stdout,
        `sha ${h.ghostSha} is not in HEAD's history (sha not in history)`,
      );
      assertStringIncludes(foreign.stdout, "1 record incident(s)");

      // 31-DAY-OLD endedAt: over the 30-day freshness bound.
      await mutateRecord(h.dirAbs, {
        endedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      });
      const old = await runTier(h.root);
      assertEquals(old.code, 1, "a 31-day-old record must exit 1");
      assertStringIncludes(old.stdout, "is 31 days old (bound: 30 days)");

      // BOUNDARY: 29 days is inside the bound and must NOT incident (exit 0).
      await mutateRecord(h.dirAbs, {
        endedAt: new Date(Date.now() - 29 * 86_400_000).toISOString(),
      });
      const young = await runTier(h.root);
      assertEquals(young.code, 0, `a 29-day-old record is inside the bound: ${young.stdout}`);

      // RECORDED EXIT 1: the record says the last actual run failed.
      await mutateRecord(h.dirAbs, { exit: 1 });
      const failedRecord = await runTier(h.root);
      assertEquals(failedRecord.code, 1);
      assertStringIncludes(failedRecord.stdout, "records exit 1 (not a clean exit");

      // MARKER FALSE: the record says the last run asserted nothing.
      await mutateRecord(h.dirAbs, { marker: false });
      const unasserted = await runTier(h.root);
      assertEquals(unasserted.code, 1);
      assertStringIncludes(unasserted.stdout, "records marker false");

      // TAMPERED ARTEFACT: on-disk content no longer matches the recorded hash.
      await Deno.writeTextFile(join(h.dirAbs, "repro.json"), JSON.stringify({ n: 2 }));
      const tampered = await runTier(h.root);
      assertEquals(tampered.code, 1);
      assertStringIncludes(
        tampered.stdout,
        "RECORD TAMPERED: docs/evidence/h22ml-scratch artefact repro.json hash mismatch",
      );

      // UNPARSEABLE RECORD: a record that cannot be read cannot be believed.
      await Deno.writeTextFile(join(h.dirAbs, RECORD_FILE), "not json at all");
      const unparseable = await runTier(h.root);
      assertEquals(unparseable.code, 1);
      assertStringIncludes(
        unparseable.stdout,
        "RECORD UNPARSEABLE: docs/evidence/h22ml-scratch/run.json does not parse",
      );
      assertEquals(
        expectOk(await readRunRecord(h.dirAbs)).exit,
        0,
        "the run rewrites a parseable record",
      );
    } finally {
      await h.cleanup();
    }
  },
);

Deno.test(
  "the armed missing-record validator names the incident; the unarmed one is silent (audio-feed-h22ml amendment 1)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "h22ml-armed-" });
    try {
      const ctx = {
        root: tempDir,
        dir: "docs/evidence/x",
        recordsEnforced: false,
        historyCheckable: false,
      };
      assertEquals(
        await validateRunRecord({ state: "missing" }, ctx),
        [],
        "unarmed: a missing record is not an incident",
      );
      const armed = await validateRunRecord({ state: "missing" }, {
        ...ctx,
        recordsEnforced: true,
      });
      assertEquals(armed.length, 1);
      assertStringIncludes(armed[0]!, "RECORD MISSING");
      assertStringIncludes(armed[0]!, "a claimed run must leave a checkable record");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "124 and 137 stay distinct from a clean exit and from each other in the record incidents (audio-feed-h22ml)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "h22ml-bound-" });
    try {
      const dirAbs = join(tempDir, "docs", "evidence", "x");
      await Deno.mkdir(dirAbs, { recursive: true });
      const ctx = {
        root: tempDir,
        dir: "docs/evidence/x",
        recordsEnforced: false,
        historyCheckable: false,
      };
      const now = new Date().toISOString();
      const base = {
        script: "scripts/p.ts",
        sha: "",
        bound: { ms: 300_000, provenance: "default" as const },
        startedAt: now,
        endedAt: now,
        artefacts: {},
      };
      for (const code of [124, 137, 1]) {
        const incidents = await validateRunRecord(
          { state: "ok", record: { ...base, exit: code, marker: false } },
          ctx,
        );
        assert(
          incidents.some((incident) => incident.includes(`records exit ${code}`)),
          `exit ${code} must be named in its own incident, got: ${incidents.join(" | ")}`,
        );
        assert(incidents.some((incident) => incident.includes("marker false")));
      }
      const clean = await validateRunRecord(
        { state: "ok", record: { ...base, exit: 0, marker: true } },
        ctx,
      );
      assertEquals(
        clean.filter((incident) => incident.includes("exit")),
        [],
        "a clean exit must produce no exit incident",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "shaIsAncestor fails closed: malformed and unknown shas are unverifiable, never ancestors (audio-feed-h22ml)",
  async () => {
    const root = fromFileUrl(new URL("../", import.meta.url));
    const malformed = await shaIsAncestor(root, "not-a-sha");
    assertEquals(malformed.state, "unverifiable");
    const unknown = await shaIsAncestor(root, "f".repeat(40));
    assertEquals(
      unknown.state,
      "unverifiable",
      "an unknown-but-well-formed sha must not read as an ancestor",
    );
  },
);

Deno.test(
  "hashEvidenceDir covers nested files and excludes README.md and run.json (audio-feed-h22ml)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "h22ml-hash-" });
    try {
      await Deno.mkdir(join(tempDir, "assets"), { recursive: true });
      await Deno.writeTextFile(join(tempDir, "README.md"), "excluded");
      await Deno.writeTextFile(join(tempDir, RECORD_FILE), "excluded");
      await Deno.writeTextFile(join(tempDir, "repro.json"), '{"n":1}\n');
      await Deno.writeTextFile(join(tempDir, "assets", "shot.txt"), "pixels");
      const artefacts = await hashEvidenceDir(tempDir);
      assertEquals(Object.keys(artefacts).sort(), ["assets/shot.txt", "repro.json"]);
      assertEquals(artefacts["repro.json"]!.startsWith("sha256:"), true);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "CENSUS ROW (audio-feed-h22ml): every declared evidence dir carries a parseable run.json",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const root = fromFileUrl(new URL("../", import.meta.url));
    const { declarations } = await collect({
      list: true,
      timeoutMs: 300_000,
      root,
      explicitTimeout: false,
    });
    // Suite-owned proofs are executed by their suite and UNRESOLVED declarations never resolve:
    // both are exempt from the record rules rather than permanently red (audio-feed-h22ml).
    const required = declarations.filter((d) => d.exists && d.executedBy === null);
    assert(required.length > 40, "the real tree must still carry its declared evidence dirs");
    const missing: string[] = [];
    const bad: string[] = [];
    for (const declaration of required) {
      const read = await readRunRecord(join(root, declaration.dir));
      if (read.state === "missing") missing.push(declaration.dir);
      else if (read.state === "unparseable") bad.push(`${declaration.dir}: ${read.error}`);
    }
    assertEquals(
      bad,
      [],
      `every EXISTING record must parse, armed or not: ${bad.join("; ")}`,
    );
    if (!EVIDENCE_RECORDS_ENFORCED) {
      // SEED GATE (amendment 1): the full-tree seed has not landed yet, so this row is gated behind
      // the same constant that arms the missing-record rule; it asserts fully once that commit lands.
      console.log(
        `[h22ml census] seed pending: ${missing.length}/${required.length} declared dirs have no ${RECORD_FILE} ` +
          `(row arms with EVIDENCE_RECORDS_ENFORCED; ${RECORD_MAX_AGE_DAYS}-day freshness is a run-path rule only)`,
      );
      return;
    }
    assertEquals(
      missing,
      [],
      `someone deleted the records - every declared evidence dir must carry a parseable ${RECORD_FILE}: ` +
        missing.join(", "),
    );
  },
);

Deno.test(
  "AMENDMENT 2: --list exits 0 on record state even when git cannot be run at all (audio-feed-h22ml)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "h22ml-nogit-" });
    try {
      const dirAbs = join(tempDir, "docs", "evidence", "h22ml-nogit");
      await Deno.mkdir(dirAbs, { recursive: true });
      await Deno.mkdir(join(tempDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(join(tempDir, "scripts", "proof.ts"), 'console.log("PASS");\n');
      await Deno.writeTextFile(
        join(dirAbs, "README.md"),
        "- Script: scripts/proof.ts\n- Asserts: nothing; this row is about the inventory path\n",
      );
      // A record whose sha can never be checked because there is no git to check it with. Without
      // the no-throw gitCapture this made --list CRASH (non-zero) merely for holding a record, which
      // is the one thing amendment 2 forbids of the inventory path.
      await Deno.writeTextFile(
        join(dirAbs, RECORD_FILE),
        JSON.stringify(
          {
            script: "scripts/proof.ts",
            sha: "a".repeat(40),
            bound: { ms: 300_000, provenance: "default" },
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            exit: 0,
            marker: true,
            artefacts: {},
          },
          null,
          2,
        ) + "\n",
      );
      const res = await runTier(tempDir, ["--list"], { PATH: "" });
      assertEquals(res.code, 0, `--list must exit 0 with no git: ${res.stdout}\n${res.stderr}`);
      assertStringIncludes(
        res.stdout,
        `records are written but not history-checked under ${tempDir} (no git HEAD)`,
      );
      assertStringIncludes(res.stdout, "declared   docs/evidence/h22ml-nogit -> scripts/proof.ts");
      assertStringIncludes(res.stdout, "it exits 0 and runs nothing");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);
