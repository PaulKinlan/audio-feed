import { assert, assertEquals } from "@std/assert";
import { dirname, join, normalize } from "@std/path";

const CONTRACTS_PATH = new URL("./contracts.json", import.meta.url).pathname;

interface ContractMapping {
  [pattern: string]: string[];
}

function loadContracts(): ContractMapping {
  const content = Deno.readTextFileSync(CONTRACTS_PATH);
  return JSON.parse(content) as ContractMapping;
}

Deno.test("contracts.json is valid and targets real suites", () => {
  const contracts = loadContracts();
  assert(Object.keys(contracts).length > 0, "contracts.json must not be empty");

  for (const [pattern, suites] of Object.entries(contracts)) {
    assert(pattern.length > 0, "pattern must be non-empty");
    assert(
      Array.isArray(suites) && suites.length > 0,
      `pattern ${pattern} must map to non-empty suite array`,
    );
    for (const suite of suites) {
      assert(suite.startsWith("tests/"), `suite ${suite} must start with tests/`);
      const fullPath = new URL(`../${suite}`, import.meta.url).pathname;
      const stat = Deno.statSync(fullPath);
      assert(stat.isFile, `suite ${suite} must exist on disk`);
    }
  }
});

Deno.test("contracts.json covers audio-feed-2i3y and audio-feed-ey8i storage subsystem mappings", () => {
  const contracts = loadContracts();

  // audio-feed-2i3y: scripts/exww-section-measures.ts and proof
  assertEquals(
    contracts["scripts/exww-section-measures.ts"],
    ["tests/exww_band_floor_test.ts"],
    "exww section measures must map to exww_band_floor_test",
  );
  assertEquals(
    contracts["scripts/exww-live-claims-browser-proof.ts"],
    ["tests/exww_mutants_test.ts"],
    "exww live claims proof must map to exww_mutants_test",
  );

  assertEquals(
    contracts["src/storage/kv.ts"],
    ["tests/storage_test.ts"],
    "src/storage/kv.ts must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/kv/**"],
    ["tests/storage_test.ts"],
    "src/storage/kv/** must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/memory.ts"],
    ["tests/storage_test.ts"],
    "src/storage/memory.ts must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/memory/**"],
    ["tests/storage_test.ts"],
    "src/storage/memory/** must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/mod.ts"],
    ["tests/storage_test.ts"],
    "src/storage/mod.ts must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/log_shape.ts"],
    ["tests/storage_test.ts"],
    "src/storage/log_shape.ts must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/s3.ts"],
    ["tests/s3_abort_socket_test.ts"],
    "src/storage/s3.ts must map to S3 suite, NOT storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/legacy_audio.ts"],
    ["tests/legacy_audio_inventory_test.ts"],
    "src/storage/legacy_audio.ts must map to legacy_audio_inventory_test.ts",
  );
  assertEquals(
    contracts["src/storage/episode_events.ts"],
    ["tests/admin_observability_test.ts"],
    "src/storage/episode_events.ts must map to admin_observability_test.ts",
  );
  assertEquals(
    contracts["src/storage/bounded.ts"],
    ["tests/synthesis_unsigned_write_test.ts"],
    "src/storage/bounded.ts must map to synthesis_unsigned_write_test.ts",
  );
  assertEquals(
    contracts["tests/conformance/**"],
    ["tests/storage_test.ts"],
    "tests/conformance/** must map to tests/storage_test.ts",
  );
});

// ---------------------------------------------------------------------------------------------
// audio-feed-byuy: the `check-coverage.py` acceptance test that lived here is DELETED, not fixed.
//
// Why: its subject was never this repository. It executed
// /home/exedev/fleet/remote/check-coverage.py by absolute path and asserted that script's own JSON
// output (two-sided mapping, the omitted hint, unmapped), using tests/contracts.json only as its
// input. That made the suite's meaning depend on the machine it ran on: anywhere without that exact
// host layout it returned early and passed WITHOUT checking anything, and on a fleet VM it reddened
// this repo whenever the host tree changed for the host's own reasons (fleet-bv0md: that file is
// edited in place and already cites lines of this repo's tests).
//
// The half of the contract this repo owns is still checked here, above: every entry of
// tests/contracts.json is asserted by name - including the glob keys `src/storage/kv/**`,
// `src/storage/memory/**` and `tests/conformance/**` - and every suite each entry names is asserted
// to exist on disk.
//
// The consumer's half belongs to the suite that owns the script, which has it:
// ~/fleet/tests/check-coverage.test.sh (45 assertions over its own generated fixture repos,
// including the two-sided mapping, the omitted hint and unmapped reporting).
//
// GAP, named rather than left silent: that host suite has no glob/fnmatch case, so "the classifier
// expands a `**` key from this repo's contracts.json" is now checked nowhere. It belongs host-side,
// in ~/fleet/tests/check-coverage.test.sh fed by a fixture contracts file - not here, by reading
// another repository's script from this repo's suite.
// ---------------------------------------------------------------------------------------------

const COVERAGE_CONTRACT_PATH =
  new URL("../.fleet/coverage-contract.json", import.meta.url).pathname;

function loadCoverageContract(): ContractMapping {
  const content = Deno.readTextFileSync(COVERAGE_CONTRACT_PATH);
  return JSON.parse(content) as ContractMapping;
}

/**
 * Strips single-line and multi-line comments from JavaScript/TypeScript source,
 * preserving strings (including protocol URLs like http://).
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");
}

export interface ExerciseResult {
  exercises: boolean;
  reason: string;
}

/**
 * Validates that a suite genuinely exercises the declared target.
 *
 * Genuine exercise requires either:
 * 1. An import specifier (static or dynamic) that resolves to the target path.
 * 2. A legitimate text read (e.g. readTextFile / Deno.readTextFile) or subprocess
 *    execution (Deno.Command) targeting the exact path or relative URL resolving to it.
 *
 * Bare substring occurrences (such as a filename mentioned only in a comment or docstring)
 * are strictly rejected.
 */
export function suiteExercisesTarget(
  suitePath: string,
  declaredPath: string,
  customSuiteSource?: string,
): ExerciseResult {
  const suiteDir = dirname(suitePath);
  const suiteSource = customSuiteSource ??
    Deno.readTextFileSync(new URL(`../${suitePath}`, import.meta.url).pathname);
  const code = stripComments(suiteSource);

  // 1. Static or dynamic import specifier resolving to declaredPath
  const importSpecifiers: string[] = [];
  const staticImportRe = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = staticImportRe.exec(code)) !== null) {
    if (match[1]) importSpecifiers.push(match[1]);
  }
  const dynamicImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRe.exec(code)) !== null) {
    if (match[1]) importSpecifiers.push(match[1]);
  }

  for (const spec of importSpecifiers) {
    const resolved = normalize(join(suiteDir, spec));
    if (resolved === declaredPath) {
      return {
        exercises: true,
        reason: `import specifier "${spec}" resolves to target`,
      };
    }
  }

  // 2. Legitimate text reads or Command execution of exact path:
  // Where a suite legitimately reads the file as text (such as browser proofs or assets),
  // accept readTextFile/Deno.readTextFile or Command execution of the exact path or relative URL.
  const hasReadTextFile = /\b(?:Deno\.)?readTextFile(?:Sync)?\b/.test(code);
  const hasCommand = /\b(?:Deno\.)?Command\b/.test(code);

  const directReadRe = /\b(?:Deno\.)?readTextFile(?:Sync)?\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = directReadRe.exec(code)) !== null) {
    const readPath = match[1];
    if (!readPath) continue;
    if (
      readPath === declaredPath ||
      normalize(join(suiteDir, readPath)) === declaredPath
    ) {
      return {
        exercises: true,
        reason: `reads target as text via readTextFile("${readPath}")`,
      };
    }
  }

  const urlRe = /new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
  while ((match = urlRe.exec(code)) !== null) {
    const urlSpec = match[1];
    if (!urlSpec) continue;
    const resolved = normalize(join(suiteDir, urlSpec));
    if (resolved === declaredPath) {
      if (hasReadTextFile) {
        return {
          exercises: true,
          reason: `reads target as text via URL "${urlSpec}"`,
        };
      }
      if (hasCommand) {
        return {
          exercises: true,
          reason: `executes target via Deno.Command with URL "${urlSpec}"`,
        };
      }
      return {
        exercises: true,
        reason: `resolves target URL "${urlSpec}" in executable code`,
      };
    }
  }

  return {
    exercises: false,
    reason:
      `suite neither imports "${declaredPath}" nor references it in readTextFile/Deno.Command (comment-only mentions do not qualify)`,
  };
}

Deno.test("coverage-contract.json is valid, targets real files and suites, and suites genuinely exercise targets (audio-feed-c0oh9)", () => {
  const contract = loadCoverageContract();
  assert(Object.keys(contract).length > 0, "coverage-contract.json must not be empty");

  for (const [declaredPath, suites] of Object.entries(contract)) {
    assert(declaredPath.length > 0, "declared path must be non-empty");
    const targetStat = Deno.statSync(new URL(`../${declaredPath}`, import.meta.url).pathname);
    assert(targetStat.isFile, `declared path ${declaredPath} must exist on disk`);

    assert(
      Array.isArray(suites) && suites.length > 0,
      `declared path ${declaredPath} must map to non-empty suite array`,
    );

    for (const suite of suites) {
      assert(suite.startsWith("tests/"), `suite ${suite} must start with tests/`);
      const suiteStat = Deno.statSync(new URL(`../${suite}`, import.meta.url).pathname);
      assert(suiteStat.isFile, `suite ${suite} must exist on disk`);

      const result = suiteExercisesTarget(suite, declaredPath);
      assert(
        result.exercises,
        `declared mapping for ${declaredPath} points to suite ${suite}, but ${suite} does not genuinely exercise ${declaredPath}: ${result.reason}`,
      );
    }
  }
});

Deno.test("coverage contract validator rejects a suite that merely mentions the target in a comment (audio-feed-c0oh9)", () => {
  // Real repository case: tests/admin_ui_test.ts merely mentions src/assets/admin.css in a comment:
  // "Resolved through the link, not the inline <style>: this rule moved to src/assets/admin.css in..."
  const realCommentMention = suiteExercisesTarget(
    "tests/admin_ui_test.ts",
    "src/assets/admin.css",
  );
  assertEquals(
    realCommentMention.exercises,
    false,
    "tests/admin_ui_test.ts must be rejected for src/assets/admin.css because it only mentions it in a comment",
  );

  // Synthetic single-line comment case:
  const singleLineCommentSource = `
    import { assert } from "@std/assert";
    // Manifest mention: src/compose/feeds.ts
    Deno.test("unrelated test", () => {
      assert(true);
    });
  `;
  const singleLineResult = suiteExercisesTarget(
    "tests/unrelated_test.ts",
    "src/compose/feeds.ts",
    singleLineCommentSource,
  );
  assertEquals(
    singleLineResult.exercises,
    false,
    "a suite with only a single-line comment mention must be rejected",
  );

  // Synthetic multi-line comment case:
  const multiLineCommentSource = `
    /*
     * Coverage declaration: scripts/proof-latency-budgets.ts
     * Comment-only mention in block comment
     */
    export function helper() { return true; }
  `;
  const multiLineResult = suiteExercisesTarget(
    "tests/another_test.ts",
    "scripts/proof-latency-budgets.ts",
    multiLineCommentSource,
  );
  assertEquals(
    multiLineResult.exercises,
    false,
    "a suite with only a multi-line comment mention must be rejected",
  );

  // Positive controls to prove genuine exercise is accepted:
  const genuineImportSource = `
    import { createCwvHandler } from "../src/routes/cwv.ts";
  `;
  const genuineImportResult = suiteExercisesTarget(
    "tests/observability_cwv_test.ts",
    "src/routes/cwv.ts",
    genuineImportSource,
  );
  assertEquals(
    genuineImportResult.exercises,
    true,
    "a suite with a real import specifier must pass",
  );

  const genuineReadSource = `
    const css = await Deno.readTextFile("src/assets/admin.css");
  `;
  const genuineReadResult = suiteExercisesTarget(
    "tests/anchor_positioning_test.ts",
    "src/assets/admin.css",
    genuineReadSource,
  );
  assertEquals(
    genuineReadResult.exercises,
    true,
    "a suite with a genuine Deno.readTextFile call must pass",
  );
});

Deno.test("coverage-contract.json covers required browser proof scripts and changed scripts under scripts/ (audio-feed-c0oh9)", async () => {
  const coverageContract = loadCoverageContract();
  const REQUIRED_PROOF_SCRIPTS = [
    "scripts/proof-latency-budgets.ts",
    "scripts/bootstrap-browser-proof.ts",
    "scripts/playback-csp-browser-proof.ts",
    "scripts/bootstrap-refusal-browser-proof.ts",
    "scripts/bd-durability-check.sh",
  ];

  for (const script of REQUIRED_PROOF_SCRIPTS) {
    assert(
      script in coverageContract,
      `required proof script ${script} must have an entry in .fleet/coverage-contract.json`,
    );
    const suites = coverageContract[script];
    assert(
      Array.isArray(suites) && suites.length > 0,
      `required proof script ${script} must map to a non-empty suite array`,
    );
    for (const suite of suites!) {
      assert(suite.startsWith("tests/"), `suite ${suite} must start with tests/`);
      const suiteStat = Deno.statSync(new URL(`../${suite}`, import.meta.url).pathname);
      assert(suiteStat.isFile, `suite ${suite} for ${script} must exist on disk`);
      const result = suiteExercisesTarget(suite, script);
      assert(
        result.exercises,
        `required proof script ${script} mapped to ${suite}, but ${suite} does not genuinely exercise it: ${result.reason}`,
      );
    }
  }

  // Dynamic check: detect any changed or untracked scripts under scripts/ via git status --porcelain and git diff.
  // Fail loudly on any git failure - never swallow errors or skip silently.
  const statusOutput = await new Deno.Command("git", {
    args: ["status", "--porcelain"],
  }).output();
  assert(
    statusOutput.success,
    `git status --porcelain failed (code ${statusOutput.code}): ${
      new TextDecoder().decode(statusOutput.stderr)
    }`,
  );

  const diffOutput = await new Deno.Command("git", {
    args: ["diff", "--name-only", "origin/main...HEAD"],
  }).output();
  assert(
    diffOutput.success,
    `git diff origin/main...HEAD failed (code ${diffOutput.code}): ${
      new TextDecoder().decode(diffOutput.stderr)
    }`,
  );

  const changedFiles = new Set<string>();

  // 1. Files modified/added on branch against origin/main:
  const diffLines = new TextDecoder().decode(diffOutput.stdout).trim().split("\n").filter(Boolean);
  for (const file of diffLines) {
    changedFiles.add(file.trim());
  }

  // 2. Working tree / index changes including untracked additions (??):
  const statusLines = new TextDecoder().decode(statusOutput.stdout).trim().split("\n").filter(
    Boolean,
  );
  for (const statusLine of statusLines) {
    const rawPayload = statusLine.slice(2).trim();
    const filePath = rawPayload.includes(" -> ") ? rawPayload.split(" -> ")[1]!.trim() : rawPayload;
    const cleanPath = filePath.replace(/^"(.*)"$/, "$1");
    if (cleanPath) changedFiles.add(cleanPath);
  }

  const contracts = loadContracts();
  for (const file of changedFiles) {
    if (!file.startsWith("scripts/") || (!file.endsWith(".ts") && !file.endsWith(".sh"))) {
      continue;
    }
    const stem = file.split("/").pop()!.replace(/\.(ts|sh)$/, "");
    const normalizedStem = stem.replace(/-/g, "_");
    const directTest1 = new URL(`../tests/${stem}_test.ts`, import.meta.url).pathname;
    const directTest2 = new URL(`../tests/${normalizedStem}_test.ts`, import.meta.url).pathname;
    let hasDirectTest = false;
    try {
      hasDirectTest = Deno.statSync(directTest1).isFile;
    } catch {
      try {
        hasDirectTest = Deno.statSync(directTest2).isFile;
      } catch {
        hasDirectTest = false;
      }
    }
    const hasContractEntry = file in coverageContract || file in contracts;
    assert(
      hasDirectTest || hasContractEntry,
      `changed file ${file} under scripts/ has no direct test and no entry in .fleet/coverage-contract.json (audio-feed-c0oh9)`,
    );
  }
});
