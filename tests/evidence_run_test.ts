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
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  findNestedEvidence,
  parseOptions,
  readDeclaration,
  resolveBound,
  stripAnsi,
} from "../scripts/evidence-run.ts";

const EVIDENCE_RUN_SCRIPT = new URL("../scripts/evidence-run.ts", import.meta.url).pathname;

async function runTier(root: string, extraArgs: string[] = []): Promise<{
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
    await Deno.writeTextFile(join(testsDir, "my_suite_test.ts"), "// test\n");

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

    // Negative control: no executor annotation
    assertStringIncludes(
      res.stdout,
      "declared   docs/evidence/audio-feed-no-exec -> scripts/proof.ts\n",
    );

    // Inventory line notes unresolved executor
    assertStringIncludes(res.stdout, "1 unresolved executor(s)");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

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
    const resOverride = await runTier(tempDir, ["--timeout", "1"]);
    assertEquals(
      resOverride.code,
      1,
      "explicit --timeout 1 must override declared bound and exit 1",
    );
    assertStringIncludes(
      resOverride.stdout,
      "UNKNOWN (exceeded the 1s bound [flag]; raise --timeout to decide it)",
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
