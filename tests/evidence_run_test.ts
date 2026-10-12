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
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { findNestedEvidence, readDeclaration, stripAnsi } from "../scripts/evidence-run.ts";

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

  const readmeCapture = `
# Title
- Script: \`scripts/capture_proof.ts\`
- Capture: no assertions. Just writes data.
`;
  const info2 = readDeclaration(readmeCapture);
  assertEquals(info2.declared, "scripts/capture_proof.ts");
  assertEquals(info2.isCapture, true);

  const readmeUndeclared = `
# Title with no script
`;
  const info3 = readDeclaration(readmeUndeclared);
  assertEquals(info3.declared, null);
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
