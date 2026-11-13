import {
  assert,
  assertEquals,
  AssertionError,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join, normalize } from "@std/path";
import {
  deriveReadRelationReport,
  discoverFullGateTestFiles,
  isFastGateSelectable,
} from "../scripts/test-selection.ts";

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
      assertContractFileExists(suite, `as a suite for ${pattern} in tests/contracts.json`);
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
    .replace(/\/\*[\s\S]*?\*[/]/g, "")
    .replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");
}

export interface ExerciseResult {
  exercises: boolean;
  reason: string;
}

interface SourceSpan {
  start: number;
  end: number;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Index just past the string or template literal that opens at `at` (a quote character). Template
 * substitutions are treated as opaque text: this scanner walks past a literal, it never evaluates one.
 */
function skipQuotedLiteral(code: string, at: number): number {
  const quote = code[at];
  let index = at + 1;
  while (index < code.length) {
    const char = code[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index++;
  }
  return code.length;
}

/**
 * End of the statement-level expression starting at `start`: the first `;`, or a closing bracket that
 * belongs to an enclosing scope, outside brackets and literals.
 */
function expressionEnd(code: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < code.length) {
    const char = code[index]!;
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuotedLiteral(code, index);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return index;
      depth--;
    } else if (char === ";" && depth === 0) {
      return index;
    }
    index++;
  }
  return code.length;
}

/**
 * The span of a function defined IN THIS SUITE (arrow/`function`/`const` binding), or null when the
 * name resolves to an import - a callee this file does not define cannot be inspected for a read.
 */
function functionDefinitionSpan(code: string, name: string): SourceSpan | null {
  const escaped = escapeRegExp(name);
  const binding = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=;]+)?=`).exec(code);
  if (binding) {
    return {
      start: binding.index,
      end: expressionEnd(code, binding.index + binding[0].length),
    };
  }
  const declaration = new RegExp(`\\bfunction\\s+${escaped}\\s*(?:<[^>(]*>)?\\(`).exec(code);
  if (declaration) {
    const bodyStart = code.indexOf("{", declaration.index + declaration[0].length);
    if (bodyStart !== -1) {
      return { start: declaration.index, end: expressionEnd(code, bodyStart) };
    }
  }
  return null;
}

interface CallSite extends SourceSpan {
  callee: string;
  argsStart: number;
  argsEnd: number;
}

/** Every `name( ... )` call with a plain identifier callee, with the span of its argument list. */
function callSites(code: string): CallSite[] {
  const sites: CallSite[] = [];
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(code)) !== null) {
    const argsStart = match.index + match[0].length;
    const argsEnd = expressionEnd(code, argsStart);
    sites.push({ callee: match[1]!, start: match.index, end: argsEnd, argsStart, argsEnd });
  }
  return sites;
}

/** The trimmed top-level arguments of one call. */
function callArguments(code: string, site: CallSite): string[] {
  const args: string[] = [];
  let depth = 0;
  let argStart = site.argsStart;
  let index = site.argsStart;
  while (index < site.argsEnd) {
    const char = code[index]!;
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuotedLiteral(code, index);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
    } else if (char === "," && depth === 0) {
      args.push(code.slice(argStart, index).trim());
      argStart = index + 1;
    }
    index++;
  }
  const last = code.slice(argStart, site.argsEnd).trim();
  if (last.length > 0) args.push(last);
  return args;
}

/**
 * The stem half of the parameterised-read rule (audio-feed-ami7x round 2): the declared fixture's stem
 * counts only when it is passed as an ARGUMENT to a call that also carries the fixture's URL template -
 * either in the same argument list, or in the definition body of the callee being called. A stem
 * literal sitting in an unrelated string (`assertStringIncludes(body, "article")`) is a coincidental
 * mention, not a use: it names no file the suite reads.
 */
function stemArgumentFeedsFixtureTemplate(
  code: string,
  stem: string,
  templates: (SourceSpan & { text: string })[],
): { template: string; via: string } | null {
  const stemLiterals = new Set([`"${stem}"`, `'${stem}'`, `\`${stem}\``]);
  for (const site of callSites(code)) {
    if (!callArguments(code, site).some((arg) => stemLiterals.has(arg))) continue;
    const sameCall = templates.find((t) => t.start >= site.argsStart && t.end <= site.argsEnd);
    if (sameCall) {
      return {
        template: sameCall.text,
        via: `as an argument of ${site.callee}(...) beside the read of that template`,
      };
    }
    const definition = functionDefinitionSpan(code, site.callee);
    if (!definition) continue;
    const inDefinition = templates.find(
      (t) => t.start >= definition.start && t.end <= definition.end,
    );
    if (inDefinition) {
      return {
        template: inDefinition.text,
        via:
          `as the argument of ${site.callee}("${stem}"), whose own definition reads that template`,
      };
    }
  }
  return null;
}

/**
 * Validates that a suite genuinely exercises the declared target.
 *
 * Genuine exercise requires either:
 * 1. An import specifier (static or dynamic) that resolves to the target path.
 * 2. A legitimate text read (e.g. readTextFile / Deno.readTextFile) or subprocess
 *    execution (Deno.Command) targeting the exact path or relative URL resolving to it.
 * 3. An asset helper call (e.g. assetUrl / assetBody / namedStylesheet) referencing
 *    the asset, or a link tag whose href names the asset.
 *
 * A string literal that merely NAMES the asset path is NOT accepted on its own (audio-feed-jdvgt):
 * `const unused = "src/assets/admin.css"` exercises nothing, so accepting it let a suite validate
 * against an asset it never reads. Every accepted form above carries a USE - an import specifier, a
 * read, a URL construction, an asset helper call or a link tag - and a bare literal carries none.
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

  // 2b. A PARAMETERISED read helper (audio-feed-ami7x): a fixture whose name is substituted into ONE
  // helper never spells its exact path as a literal, so every branch above is blind to the read.
  // `tests/ingest_test.ts` holds
  //   const fixture = (name: string) => Deno.readTextFile(new URL(`./fixtures/${name}.html`, import.meta.url));
  // and calls it as `fixture("hero-figure")`.
  //
  // Accepted only when BOTH halves carry a use, because either alone names no file (audio-feed-jdvgt):
  //   (i)  a text read or a Deno.Command call over a template URL whose literal prefix resolves to the
  //        declared file's DIRECTORY and whose literal suffix is its EXTENSION, and
  //   (ii) the declared file's STEM passed as an ARGUMENT to a call whose argument list or whose own
  //        definition body carries that template - the parameter the helper substitutes.
  // A template over another directory, a template with another extension, or a stem literal with no
  // such read is rejected: a name is not a use, and a template with no stem names nothing in particular.
  // The stem must be an ARGUMENT, not any literal anywhere (audio-feed-ami7x round 2): a file-global
  // search accepted `assertStringIncludes(body, "article")` as proof that article.html was read, so a
  // suite that loaded its fixtures through a helper plus any stray mention of the name validated.
  const declaredBase = declaredPath.split("/").pop() ?? "";
  const declaredStem = declaredBase.replace(/\.[^./]+$/, "");
  const declaredExt = declaredBase.slice(declaredStem.length);
  const declaredDir = normalize(dirname(declaredPath)).replace(/\/+$/, "");
  const templateReadRe = /new\s+URL\s*\(\s*`([^`]*)`\s*,\s*import\.meta\.url\s*\)/g;
  const fixtureTemplates: (SourceSpan & { text: string })[] = [];
  if (hasReadTextFile || hasCommand) {
    while ((match = templateReadRe.exec(code)) !== null) {
      const template = match[1] ?? "";
      const interpolationAt = template.indexOf("${");
      if (interpolationAt === -1) continue;
      const interpolationEnd = template.indexOf("}", interpolationAt);
      if (interpolationEnd === -1) continue;
      const literalPrefix = template.slice(0, interpolationAt);
      const literalSuffix = template.slice(interpolationEnd + 1);
      if (normalize(join(suiteDir, literalPrefix)).replace(/\/+$/, "") !== declaredDir) continue;
      if (literalSuffix !== declaredExt) continue;
      fixtureTemplates.push({
        start: match.index,
        end: match.index + match[0].length,
        text: template,
      });
    }
  }
  if (fixtureTemplates.length > 0) {
    const linked = stemArgumentFeedsFixtureTemplate(code, declaredStem, fixtureTemplates);
    if (linked) {
      return {
        exercises: true,
        reason:
          `reads target through the parameterised URL template \`${linked.template}\` (literal prefix resolves to ${declaredDir}, suffix ${declaredExt}) with the stem "${declaredStem}" passed ${linked.via}`,
      };
    }
  }

  // 3. Asset helper calls and link tags:
  // Accept asset helpers (assetUrl("..."), assetBody("..."), namedStylesheet("..."))
  // as well as link tags whose href names the asset. A literal that only names the path is not a
  // use, and is rejected (audio-feed-jdvgt).
  const baseName = declaredPath.split("/").pop() ?? "";
  const isAsset = declaredPath.startsWith("src/assets/") || declaredPath.startsWith("assets/");

  const assetHelperRe =
    /\b(?:(?:[a-zA-Z0-9_$]+\.)?assetUrl|assetBody|namedStylesheet)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = assetHelperRe.exec(code)) !== null) {
    const assetSpec = match[1];
    if (assetSpec === baseName || assetSpec === declaredPath) {
      return {
        exercises: true,
        reason: `references target asset via helper call: ${match[0]}`,
      };
    }
  }

  if (isAsset) {
    const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linkTagRe = new RegExp(
      `<link\\b[^>]*href=['"\`][^'"\`]*${escapedBaseName}[^'"\`]*['"\`]`,
      "i",
    );
    if (linkTagRe.test(code)) {
      return {
        exercises: true,
        reason: `references target asset via link tag in code`,
      };
    }
  }

  return {
    exercises: false,
    reason:
      `suite neither imports "${declaredPath}" nor references it in readTextFile/Deno.Command/asset helpers/link tags (a bare string literal naming the path, and a comment-only mention, do not qualify)`,
  };
}

export interface GitResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[]) => Promise<GitResult>;

const runGit: GitRunner = async (args) => {
  const output = await new Deno.Command("git", { args }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    success: output.success,
    code: output.code,
    stdout: decode(output.stdout),
    stderr: decode(output.stderr),
  };
};

export interface ChangedFilesProbe {
  changedFiles: Set<string>;
  /** True when `origin/main` was unusable and `git diff HEAD` supplied the diff instead. */
  usedHeadFallback: boolean;
}

/**
 * Collects the files this branch changed against upstream main, plus working-tree changes.
 *
 * `git diff origin/main...HEAD` needs a FETCHED `origin/main`, and an unfetched or isolated checkout
 * must not red the whole contracts suite, so a missing ref falls back to `git diff HEAD`. That
 * fallback only sees UNCOMMITTED work: on a clean committed tree it is empty, and an empty changed
 * set let the changed-scripts check below pass while examining nothing. So a fallback that finds no
 * changed file at all FAILS loudly (audio-feed-jdvgt) - "no changes found" is not the same claim as
 * "clean", and only the second one means this check had nothing to look at.
 */
export async function collectChangedFiles(run: GitRunner = runGit): Promise<ChangedFilesProbe> {
  // Fail loudly on any git failure - never swallow errors or skip silently.
  const statusOutput = await run(["status", "--porcelain"]);
  assert(
    statusOutput.success,
    `git status --porcelain failed (code ${statusOutput.code}): ${statusOutput.stderr}`,
  );

  // Fleet-break vector: `git diff origin/main...HEAD` requires `origin/main` to exist locally.
  // In an unfetched repository or shallow/isolated checkout where `origin/main` is missing,
  // this would red the whole contracts suite unless handled. We attempt `origin/main...HEAD` first
  // to detect branch changes against upstream main, then fall back to `HEAD` (which always exists
  // locally) and name `git fetch origin` as the repair.
  let originErr = "";
  let usedHeadFallback = false;
  let diffOutput = await run(["diff", "--name-only", "origin/main...HEAD"]);
  if (!diffOutput.success) {
    originErr = diffOutput.stderr.trim();
    usedHeadFallback = true;
    diffOutput = await run(["diff", "--name-only", "HEAD"]);
    assert(
      diffOutput.success,
      `git diff origin/main...HEAD failed (${originErr}; run "git fetch origin main" to heal) and fallback git diff HEAD also failed: ${diffOutput.stderr}`,
    );
  }

  const changedFiles = new Set<string>();

  // 1. Files modified/added on branch against origin/main:
  const diffLines = diffOutput.stdout.trim().split("\n").filter(Boolean);
  for (const file of diffLines) {
    changedFiles.add(file.trim());
  }

  // 2. Working tree / index changes including untracked additions (??):
  const statusLines = statusOutput.stdout.trim().split("\n").filter(Boolean);
  for (const statusLine of statusLines) {
    const rawPayload = statusLine.slice(2).trim();
    const filePath = rawPayload.includes(" -> ") ? rawPayload.split(" -> ")[1]!.trim() : rawPayload;
    const cleanPath = filePath.replace(/^"(.*)"$/, "$1");
    if (cleanPath) changedFiles.add(cleanPath);
  }

  // The fallback diff only shows UNCOMMITTED work, so an empty result is what a clean committed
  // branch and an unusable comparison both look like. Refuse to report that as a pass.
  assert(
    !usedHeadFallback || changedFiles.size > 0,
    `git diff origin/main...HEAD failed (${originErr}; run "git fetch origin" to heal) and the ` +
      `fallback git diff HEAD found no changed files at all: an empty fallback diff cannot be told ` +
      `apart from a clean tree, so the changed-scripts check would pass without examining anything. ` +
      `This is a FAILURE, not a pass (audio-feed-jdvgt) — fetch origin/main and re-run.`,
  );

  return { changedFiles, usedHeadFallback };
}

Deno.test("coverage-contract.json is valid, targets real files and suites, and suites genuinely exercise targets (audio-feed-c0oh9)", () => {
  const contract = loadCoverageContract();
  assert(Object.keys(contract).length > 0, "coverage-contract.json must not be empty");

  for (const [declaredPath, suites] of Object.entries(contract)) {
    assert(declaredPath.length > 0, "declared path must be non-empty");
    assertContractFileExists(
      declaredPath,
      `by .fleet/coverage-contract.json (mapped to ${suites.join(", ")})`,
    );

    assert(
      Array.isArray(suites) && suites.length > 0,
      `declared path ${declaredPath} must map to non-empty suite array`,
    );

    for (const suite of suites) {
      assert(suite.startsWith("tests/"), `suite ${suite} must start with tests/`);
      assertContractFileExists(
        suite,
        `as a suite for ${declaredPath} in .fleet/coverage-contract.json`,
      );

      const result = suiteExercisesTarget(suite, declaredPath);
      assert(
        result.exercises,
        `declared mapping for ${declaredPath} points to suite ${suite}, but ${suite} does not genuinely exercise ${declaredPath}: ${result.reason}`,
      );
    }
  }
});

Deno.test("coverage contract validator rejects a suite that merely mentions the target in a comment (audio-feed-c0oh9)", () => {
  // Load-bearing negative tests:
  // Note: the matchers in suiteExercisesTarget are syntax-anchored (requiring import/read/call syntax).
  // Therefore, a prose mention inside a comment (e.g. "// rule moved to src/assets/admin.css")
  // evaluates to false even if comment stripping were completely deleted.
  // To make comment stripping genuinely load-bearing, the negative assertions must test
  // syntax-bearing comments (commented-out imports, reads, or assetUrl calls) that WOULD pass
  // the syntax matchers if comment stripping were omitted or buggy, but are correctly rejected
  // when comments are stripped.

  // 1. Commented-out import (would pass import regex without comment stripping):
  const commentedImportSource = `
    import { assert } from "@std/assert";
    // import { createCwvHandler } from "../src/routes/cwv.ts";
    Deno.test("unrelated test", () => {
      assert(true);
    });
  `;
  const commentedImportResult = suiteExercisesTarget(
    "tests/unrelated_test.ts",
    "src/routes/cwv.ts",
    commentedImportSource,
  );
  assertEquals(
    commentedImportResult.exercises,
    false,
    "a suite with only a commented-out import specifier must be rejected (load-bearing)",
  );

  // 2. Commented-out multi-line Deno.readTextFile (would pass readTextFile regex without comment stripping):
  const commentedReadSource = `
    /*
     * const css = await Deno.readTextFile("src/assets/admin.css");
     */
    export function helper() { return true; }
  `;
  const commentedReadResult = suiteExercisesTarget(
    "tests/another_test.ts",
    "src/assets/admin.css",
    commentedReadSource,
  );
  assertEquals(
    commentedReadResult.exercises,
    false,
    "a suite with only a block-commented readTextFile must be rejected (load-bearing)",
  );

  // 3. Commented-out assetUrl call (would pass assetUrl regex without comment stripping):
  const commentedAssetSource = `
    // const url = assetUrl("admin.css");
    export function dummy() { return false; }
  `;
  const commentedAssetResult = suiteExercisesTarget(
    "tests/asset_dummy_test.ts",
    "src/assets/admin.css",
    commentedAssetSource,
  );
  assertEquals(
    commentedAssetResult.exercises,
    false,
    "a suite with only a commented-out assetUrl call must be rejected (load-bearing)",
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

  const genuineAssetSource = `
    const url = assetUrl("admin.css");
  `;
  const genuineAssetResult = suiteExercisesTarget(
    "tests/admin_asset_test.ts",
    "src/assets/admin.css",
    genuineAssetSource,
  );
  assertEquals(
    genuineAssetResult.exercises,
    true,
    "a suite with a genuine assetUrl helper call must pass",
  );

  const genuineLinkTagSource = `
    assertStringIncludes(html, \`<link rel="stylesheet" href="\${assetUrl("admin.css")}">\`);
  `;
  const genuineLinkTagResult = suiteExercisesTarget(
    "tests/admin_ui_test.ts",
    "src/assets/admin.css",
    genuineLinkTagSource,
  );
  assertEquals(
    genuineLinkTagResult.exercises,
    true,
    "a suite with a genuine link tag reference must pass",
  );
});

Deno.test("coverage contract validator accepts a path string only when the code USES it (audio-feed-jdvgt)", () => {
  // NEGATIVE row, and the reason this tightening is falsifiable: before audio-feed-jdvgt the
  // exact-path branch accepted ANY string literal naming the asset, so this suite validated as
  // exercising src/assets/admin.css while reading nothing at all.
  const bareLiteralResult = suiteExercisesTarget(
    "tests/bare_literal_test.ts",
    "src/assets/admin.css",
    `const unused = "src/assets/admin.css";`,
  );
  assertEquals(
    bareLiteralResult.exercises,
    false,
    "a bare unused string literal naming the asset must be rejected",
  );

  // The relative spelling of the same naming is rejected too - it is still only a literal.
  const bareRelativeLiteralResult = suiteExercisesTarget(
    "tests/bare_relative_literal_test.ts",
    "src/assets/listen.css",
    `const unused = "../src/assets/listen.css";`,
  );
  assertEquals(
    bareRelativeLiteralResult.exercises,
    false,
    "a bare unused relative string literal naming the asset must be rejected",
  );

  // POSITIVE CONTROLS: the same literal counts only when the code acts on it - a read, an asset
  // helper, or a link tag.
  const readResult = suiteExercisesTarget(
    "tests/reads_the_asset_test.ts",
    "src/assets/admin.css",
    `const css = await Deno.readTextFile("src/assets/admin.css");`,
  );
  assertEquals(readResult.exercises, true, "a literal that is READ must pass");

  const helperResult = suiteExercisesTarget(
    "tests/helpers_the_asset_test.ts",
    "src/assets/admin.css",
    `const url = assetUrl("admin.css");`,
  );
  assertEquals(helperResult.exercises, true, "a literal passed to an asset helper must pass");

  const linkTagResult = suiteExercisesTarget(
    "tests/links_the_asset_test.ts",
    "src/assets/admin.css",
    `assertStringIncludes(html, \`<link rel="stylesheet" href="\${assetUrl("admin.css")}">\`);`,
  );
  assertEquals(linkTagResult.exercises, true, "a literal inside a link tag must pass");
});

/**
 * Targets excluded from strict automated recall enforcement in .fleet/coverage-contract.json.
 *
 * Exact recall requires that every suite exercising a target is mapped in the contract.
 * Targets are excluded only with a specific, reviewable rationale:
 * 1. Coarse directory prefix relations (src/, scripts/, tests/) are already excluded repository-wide
 *    because whole-tree scans (throw-site sweeps, CSP header audits, census counts) do not test individual files.
 * 2. Shared/hub routes (src/routes/listen.ts, src/routes/account_api.ts, src/routes/pwa.ts): imported across
 *    many routes and tests; the contract maps only the dedicated/primary handler suite.
 * 3. Broad UI assets (src/assets/listen.js, src/assets/listen.css): linked by multiple UI test suites; the contract
 *    pins the primary feature/spec suites rather than every UI test that renders the app shell.
 * 4. Secondary proof observers (scripts/*-proof.ts): primarily executed by tests/proof_cdp_test.ts; secondary
 *    references in specialized assertion helpers are omitted to avoid over-selection.
 * 5. Multi-test development utilities (scripts/source-mask.ts, scripts/test-selection.ts): foundational test
 *    tooling exercising-set is wide across the test-selection test family.
 *
 * Every reason carries a `secondary:` clause naming, by full test path, exactly the derived exercising suites
 * that the contract deliberately leaves unmapped (audio-feed-if6w0). That clause is the checkable half of the
 * rationale: validateRecallExclusionReasons re-derives the exercising set and reds when a named suite stopped
 * exercising the target, when a new exercising suite is unnamed, and when an exclusion is no longer justified at
 * all - so an exclusion whose rationale evaporated has to be removed rather than inherited forever. Prose counts
 * ("9 secondary suites", "5 primary suites") are deliberately gone: they were unverifiable, and the named list
 * says the same thing in a form the test can check.
 */
export const RECALL_EXCLUSIONS: Record<string, string> = {
  "src/routes/pwa.ts":
    "route handler mapped through its primary suite tests/listen_test.ts; tests/share_target_test.ts imports it for one share-target assertion and is deliberately left unmapped; secondary: tests/share_target_test.ts",
  "src/routes/listen.ts":
    "core route handler mapped through its primary suite tests/listen_reads_test.ts; the shared-app UI suites below import it only to have the app shell render and are deliberately left unmapped; secondary: tests/anchor_positioning_test.ts, tests/content_visibility_test.ts, tests/dialog_closedby_test.ts, tests/listen_activity_test.ts, tests/listen_landing_asset_test.ts, tests/listen_read_limit_test.ts, tests/share_test.ts, tests/sticky_scroll_state_test.ts, tests/tokens_test.ts",
  "src/routes/account_api.ts":
    "route handler mapped through its primary suite tests/auth_body_cap_test.ts; the auth-adjacent suites below import it for their own subject and are deliberately left unmapped; secondary: tests/auth_login_options_limit_test.ts, tests/lockout_order_test.ts",
  "src/assets/listen.js":
    "shared asset linked by its mapped feature suites and by tests/listen_test.ts, which renders the app shell rather than the asset's own behaviour, and is deliberately left unmapped; secondary: tests/listen_test.ts",
  "src/assets/listen.css":
    "shared stylesheet linked by its mapped feature suites and by the UI suites below, which render the app shell rather than the stylesheet's own behaviour, and are deliberately left unmapped; secondary: tests/assets_test.ts, tests/dialog_closedby_test.ts, tests/select_test.ts, tests/sticky_scroll_state_test.ts, tests/tokens_test.ts, tests/view_transitions_test.ts",
  "scripts/exww-live-claims-browser-proof.ts":
    "browser proof executed by the mapped harness tests/proof_cdp_test.ts; tests/exww_mutants_verdict_test.ts only reads its verdict and is deliberately left unmapped; secondary: tests/exww_mutants_verdict_test.ts",
  "scripts/landing-tooltip-browser-proof.ts":
    "browser proof executed by the mapped harness tests/proof_cdp_test.ts; tests/chrome_profile_sweep_sites_test.ts only names it in a sweep and is deliberately left unmapped; secondary: tests/chrome_profile_sweep_sites_test.ts",
  "scripts/passkey-provider-browser-proof.ts":
    "browser proof executed by the mapped harness tests/proof_cdp_test.ts; tests/proof_helper_test.ts only references it from an auxiliary harness and is deliberately left unmapped; secondary: tests/proof_helper_test.ts",
  "scripts/verify_main_l7m1_e2e.ts":
    "browser proof executed by the mapped harness tests/proof_cdp_test.ts; tests/l7m1_proof_test.ts only checks its unit-level pieces and is deliberately left unmapped; secondary: tests/l7m1_proof_test.ts",
  "scripts/verify_s3uk_real_browser.ts":
    "browser proof executed by the mapped harness tests/proof_cdp_test.ts; tests/chrome_profile_sweep_sites_test.ts only names it in a sweep and is deliberately left unmapped; secondary: tests/chrome_profile_sweep_sites_test.ts",
  "scripts/source-mask.ts":
    "shared utility imported by the mapped suites tests/source_mask_test.ts and tests/fast_check_test.ts and by the census/sweep suites below, which only read generated masks and are deliberately left unmapped; secondary: tests/chrome_profile_sweep_sites_test.ts, tests/evidence_census_test.ts, tests/prompt_census_test.ts",
  "scripts/test-selection.ts":
    "test selection core module mapped through its primary suites tests/source_scanner_test.ts and tests/evidence_census_test.ts; the specialised relation/scanner suites below import it to exercise one scanner each and are deliberately left unmapped; secondary: tests/bare_name_relation_test.ts, tests/dynamic_regexp_population_test.ts, tests/evidence_run_test.ts, tests/fast_gate_subset_test.ts, tests/read_relation_hints_test.ts, tests/spawn_relation_test.ts, tests/strip_comments_unterminated_test.ts, tests/verify_script_ledger_test.ts",
};

/**
 * Derives all test suites that genuinely exercise the given target.
 * Suites whose exercise is purely self-referential contract testing (tests/contracts_test.ts) are excluded.
 */
export function deriveExercisingSuitesForTarget(
  target: string,
  allSuites: readonly string[],
  suiteSources?: Map<string, string>,
): string[] {
  const result: string[] = [];
  for (const suite of allSuites) {
    if (suite === "tests/contracts_test.ts") continue;
    const source = suiteSources?.get(suite);
    if (suiteExercisesTarget(suite, target, source).exercises) {
      result.push(suite);
    }
  }
  return result.sort();
}

/**
 * Parses the `secondary:` clause of a recall-exclusion reason (audio-feed-if6w0).
 *
 * The clause is the machine-checkable half of the rationale: it names, by full test path, the exercising suites
 * the contract deliberately leaves unmapped. A reason without it is unverifiable, not merely terse.
 */
export function parseRecallSecondarySuites(reason: string): string[] | null {
  const match = /\bsecondary:\s*([^;]+)\s*$/.exec(reason.trim());
  if (!match?.[1]) return null;
  return match[1]
    .split(",")
    .map((suite) => suite.trim())
    .filter((suite) => suite.length > 0);
}

/** Any full test path named anywhere in a reason's prose, `secondary:` clause included. */
const RECALL_REASON_TEST_PATH = /\btests\/[A-Za-z0-9_.\-/]+_test\.ts\b/g;

/**
 * Validates that every recall exclusion's REASON still holds (audio-feed-if6w0).
 *
 * The older audit only caught an excluded target leaving the contract. It could not catch an exclusion whose
 * rationale evaporated - e.g. every suite that used to import src/routes/listen.ts moves on, the exclusion stays,
 * and a target full recall could now cover is out of the strict set forever. This re-derives the exercising set
 * per exclusion and reds when:
 * 1. the reason has no `secondary:` clause, so nothing about it can be checked;
 * 2. no exercising suite is left unmapped - the exclusion is unjustified and must be removed;
 * 3. the reason names a suite that does not (or no longer) exercise the target;
 * 4. an exercising, unmapped suite is not named by the reason.
 * All four are collected and reported together so one run says everything that drifted.
 */
export function validateRecallExclusionReasons(
  contract: ContractMapping,
  allSuites: readonly string[],
  exclusions: Record<string, string> = RECALL_EXCLUSIONS,
  suiteSources?: Map<string, string>,
): void {
  const failures: string[] = [];
  for (const [target, reason] of Object.entries(exclusions)) {
    const exercising = deriveExercisingSuitesForTarget(target, allSuites, suiteSources);
    const mapped = contract[target] ?? [];
    const derivedSecondary = exercising.filter((suite) => !mapped.includes(suite));
    const namedSecondary = parseRecallSecondarySuites(reason);

    if (namedSecondary === null) {
      failures.push(
        `unverifiable recall exclusion: ${target}'s reason has no "secondary:" clause naming the suites it leaves unmapped, so nothing checks the exclusion is still needed: "${reason}" (audio-feed-if6w0)`,
      );
      continue;
    }
    if (derivedSecondary.length === 0) {
      // The strongest form of evaporating rationale: nothing is left unmapped, so the exclusion is dead weight.
      // The reason's own claims are repeated here so the failure names what stopped exercising it, not just the
      // target - a bare "remove it" would not say which citation went stale.
      const vanishedNames = namedSecondary.filter((suite) => !exercising.includes(suite));
      failures.push(
        `stale recall exclusion: ${target} is no longer justified - every suite that exercises it (${
          exercising.join(", ") || "none"
        }) is already mapped in the contract, so remove it from RECALL_EXCLUSIONS (audio-feed-if6w0)` +
          (vanishedNames.length > 0
            ? `; the reason still names ${vanishedNames.join(", ")}, which no longer exercises it`
            : ""),
      );
      continue;
    }

    const staleNames = namedSecondary.filter((suite) => !exercising.includes(suite));
    if (staleNames.length > 0) {
      failures.push(
        `stale recall exclusion: ${target}'s reason names ${
          staleNames.join(", ")
        }, which no longer exercises it (derived exercising suites: ${
          exercising.join(", ")
        }) - restate the reason or remove the exclusion (audio-feed-if6w0)`,
      );
    }
    const unnamedSecondary = derivedSecondary.filter((suite) => !namedSecondary.includes(suite));
    if (unnamedSecondary.length > 0) {
      failures.push(
        `incomplete recall exclusion: ${target}'s reason does not name ${
          unnamedSecondary.join(", ")
        }, which exercises it and is left unmapped - map it in the contract or name it in the reason (audio-feed-if6w0)`,
      );
    }
    const proseStale = [...reason.matchAll(RECALL_REASON_TEST_PATH)]
      .map((match) => match[0]!)
      .filter((suite) => !exercising.includes(suite) && !staleNames.includes(suite));
    if (proseStale.length > 0) {
      failures.push(
        `stale recall exclusion: ${target}'s reason also names ${
          [...new Set(proseStale)].join(", ")
        }, which does not exercise it (derived exercising suites: ${
          exercising.join(", ")
        }) (audio-feed-if6w0)`,
      );
    }
  }
  assert(failures.length === 0, failures.join("\n"));
}

/**
 * Validates that coverage contract satisfies RECALL: every suite that genuinely exercises an unexcluded
 * target must be present in that target's mapped suite array.
 *
 * Soundness (checked above) ensures that every mapped suite genuinely exercises the target (mapped ⊆ exercising).
 * Recall (checked here) ensures that every genuine reader is mapped in the contract (exercising ⊆ mapped).
 * Together, they guarantee that the coverage contract cannot be silently narrowed (audio-feed-5v4uf).
 */
export function validateCoverageContractRecall(
  contract: ContractMapping,
  allSuites: readonly string[],
  exclusions: Record<string, string> = RECALL_EXCLUSIONS,
  suiteSources?: Map<string, string>,
): void {
  for (const [target, mappedSuites] of Object.entries(contract)) {
    if (target in exclusions) continue;
    const exercising = deriveExercisingSuitesForTarget(target, allSuites, suiteSources);
    const missing = exercising.filter((s) => !mappedSuites.includes(s));
    assert(
      missing.length === 0,
      `recall failure: ${target} is genuinely exercised by ${
        missing.join(", ")
      }, but the coverage contract does not map them (audio-feed-5v4uf)`,
    );
  }
}

let cachedSuiteSources: Map<string, string> | null = null;
async function getSuiteSources(allSuites: readonly string[]): Promise<Map<string, string>> {
  if (cachedSuiteSources) return cachedSuiteSources;
  const sources = new Map<string, string>();
  for (const suite of allSuites) {
    if (suite === "tests/contracts_test.ts") continue;
    const source = await Deno.readTextFile(new URL(`../${suite}`, import.meta.url));
    sources.set(suite, stripComments(source));
  }
  cachedSuiteSources = sources;
  return sources;
}

Deno.test("coverage-contract.json enforces recall: unexcluded targets map all of their real exercising suites (audio-feed-5v4uf)", async () => {
  const coverageContract = loadCoverageContract();
  const root = new URL("../", import.meta.url).pathname;
  const allSuites = await discoverFullGateTestFiles(root);
  const suiteSources = await getSuiteSources(allSuites);

  // 1. Audit exclusions: every entry in RECALL_EXCLUSIONS must be a declared target in coverage-contract.json.
  for (const target of Object.keys(RECALL_EXCLUSIONS)) {
    assert(
      target in coverageContract,
      `stale recall exclusion: ${target} is in RECALL_EXCLUSIONS but not in coverage-contract.json`,
    );
  }

  // 1b. And every exclusion's REASON must still hold against the exercising sets derived from the tree
  // (audio-feed-if6w0), not just the target still being in the contract.
  validateRecallExclusionReasons(coverageContract, allSuites, RECALL_EXCLUSIONS, suiteSources);

  // 2. Validate recall across all unexcluded targets in the real contract:
  validateCoverageContractRecall(coverageContract, allSuites, RECALL_EXCLUSIONS, suiteSources);

  // Count unexcluded targets to verify the test did not pass vacuously:
  const unexcludedTargets = Object.keys(coverageContract).filter(
    (target) => !(target in RECALL_EXCLUSIONS),
  );
  assert(
    unexcludedTargets.length >= 40,
    `expected at least 40 unexcluded targets covered by recall, found ${unexcludedTargets.length}`,
  );
  assert(
    unexcludedTargets.includes("src/assets/admin.css"),
    "src/assets/admin.css must be subject to automated recall validation",
  );
});

Deno.test("recall exclusions are re-checked against the exercising set their reason names (audio-feed-if6w0)", () => {
  // Synthetic tree so each rule can be falsified without touching the repository's own suites.
  const suites = ["tests/main_test.ts", "tests/secondary_test.ts"];
  const exercisingSources = new Map<string, string>([
    ["tests/main_test.ts", `import { handle } from "../src/x.ts";`],
    ["tests/secondary_test.ts", `import { handle } from "../src/x.ts";`],
  ]);
  const contract: ContractMapping = { "src/x.ts": ["tests/main_test.ts"] };
  const holdingReason =
    "core module mapped through its primary suite tests/main_test.ts; tests/secondary_test.ts uses it too and is deliberately left unmapped; secondary: tests/secondary_test.ts";

  // POSITIVE CONTROL: the reason's claims all hold, so nothing throws.
  validateRecallExclusionReasons(
    contract,
    suites,
    { "src/x.ts": holdingReason },
    exercisingSources,
  );

  // NEGATIVE 1: the reason names a suite that does not exercise the target. Before audio-feed-if6w0 this was
  // accepted - the string was only asserted non-empty - so an exclusion could cite proof that did not exist.
  assertThrows(
    () =>
      validateRecallExclusionReasons(
        contract,
        suites,
        {
          "src/x.ts": holdingReason.replace(
            "secondary: tests/secondary_test.ts",
            "secondary: tests/other_test.ts",
          ),
        },
        exercisingSources,
      ),
    AssertionError,
    "names tests/other_test.ts, which no longer exercises it",
    "a reason naming a suite that does not exercise the target must be rejected naming it",
  );

  // NEGATIVE 2: the named secondary suite stops importing the target, so its exercise evaporates. The exclusion
  // now rests on a reason that is no longer true, which is exactly the drift the bead is about.
  const evaporatedSources = new Map(exercisingSources);
  evaporatedSources.set("tests/secondary_test.ts", `import { other } from "../src/y.ts";`);
  assertThrows(
    () =>
      validateRecallExclusionReasons(
        contract,
        suites,
        { "src/x.ts": holdingReason },
        evaporatedSources,
      ),
    AssertionError,
    "names tests/secondary_test.ts, which no longer exercises it",
    "a secondary suite that stops importing the target must red the exclusion that cites it",
  );

  // NEGATIVE 3: a reason with no `secondary:` clause cannot be checked at all, so it is rejected outright.
  assertThrows(
    () =>
      validateRecallExclusionReasons(
        contract,
        suites,
        { "src/x.ts": "shared module imported by several suites" },
        exercisingSources,
      ),
    AssertionError,
    'unverifiable recall exclusion: src/x.ts\'s reason has no "secondary:" clause',
    "a reason that names no suites must be rejected as unverifiable",
  );

  // NEGATIVE 4: every exercising suite is mapped, so the exclusion is not justified at all - it has to be
  // removed, which is the state the bead says must never persist silently.
  assertThrows(
    () =>
      validateRecallExclusionReasons(
        { "src/x.ts": ["tests/main_test.ts", "tests/secondary_test.ts"] },
        suites,
        { "src/x.ts": holdingReason },
        exercisingSources,
      ),
    AssertionError,
    "stale recall exclusion: src/x.ts is no longer justified - every suite that exercises it (tests/main_test.ts, tests/secondary_test.ts) is already mapped",
    "an exclusion whose every exercising suite is mapped must be rejected as stale",
  );

  // NEGATIVE 5: an exercising, unmapped suite the reason does not name - a new suite importing the target - is
  // reported too, so the reason cannot silently go out of date as the tree grows.
  const grownSuites = [...suites, "tests/newcomer_test.ts"];
  const grownSources = new Map(exercisingSources);
  grownSources.set("tests/newcomer_test.ts", `import { handle } from "../src/x.ts";`);
  assertThrows(
    () =>
      validateRecallExclusionReasons(
        contract,
        grownSuites,
        { "src/x.ts": holdingReason },
        grownSources,
      ),
    AssertionError,
    "does not name tests/newcomer_test.ts, which exercises it and is left unmapped",
    "a new exercising suite must be named by the reason or mapped in the contract",
  );
});

Deno.test("coverage contract recall validator rejects narrowed mappings and allows supersets (audio-feed-5v4uf)", async () => {
  const coverageContract = loadCoverageContract();
  const root = new URL("../", import.meta.url).pathname;
  const allSuites = await discoverFullGateTestFiles(root);
  const suiteSources = await getSuiteSources(allSuites);

  // NEGATIVE PROOF 1: narrowing src/assets/admin.css from 3 suites to 1 suite (dropping admin_asset_test and admin_ui_test)
  // must FAIL, naming src/assets/admin.css and the missing suites.
  const narrowedAdminContract: ContractMapping = {
    ...coverageContract,
    "src/assets/admin.css": ["tests/anchor_positioning_test.ts"],
  };

  assertThrows(
    () => {
      validateCoverageContractRecall(
        narrowedAdminContract,
        allSuites,
        RECALL_EXCLUSIONS,
        suiteSources,
      );
    },
    AssertionError,
    "src/assets/admin.css is genuinely exercised by tests/admin_asset_test.ts, tests/admin_ui_test.ts, but the coverage contract does not map them",
    "narrowing src/assets/admin.css from 3 suites to 1 must be rejected naming the target and missing suites",
  );

  // NEGATIVE PROOF 2: dropping an exercising suite from a fixture target (e.g. tests/fixtures/checker_pass_child.ts)
  // must also FAIL, naming the fixture target and missing suite.
  const narrowedFixtureContract: ContractMapping = {
    ...coverageContract,
    "tests/fixtures/checker_pass_child.ts": [],
  };

  assertThrows(
    () => {
      validateCoverageContractRecall(
        narrowedFixtureContract,
        allSuites,
        RECALL_EXCLUSIONS,
        suiteSources,
      );
    },
    AssertionError,
    "tests/fixtures/checker_pass_child.ts is genuinely exercised by tests/proof_helper_test.ts, but the coverage contract does not map them",
    "dropping an exercising suite from a fixture must be rejected naming the target and missing suite",
  );

  // POSITIVE PROOF (superset allowed by recall rule):
  // The recall rule requires that all genuine readers are mapped (no omissions).
  // Adding an extra suite to a mapping preserves recall (all exercising suites remain mapped).
  // Note: Unsound additions are forbidden by the separate soundness check (line 599).
  const supersetContract: ContractMapping = {
    ...coverageContract,
    "src/assets/admin.css": [
      ...coverageContract["src/assets/admin.css"]!,
      "tests/non_exercising_superset_test.ts",
    ],
  };

  // Must NOT throw under recall validation:
  validateCoverageContractRecall(
    supersetContract,
    allSuites,
    RECALL_EXCLUSIONS,
    suiteSources,
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
      assertContractFileExists(
        suite,
        `as a suite for the required proof script ${script} in .fleet/coverage-contract.json`,
      );
      const result = suiteExercisesTarget(suite, script);
      assert(
        result.exercises,
        `required proof script ${script} mapped to ${suite}, but ${suite} does not genuinely exercise it: ${result.reason}`,
      );
    }
  }

  // Dynamic check: detect any changed or untracked scripts under scripts/ via git status --porcelain
  // and git diff. Fail loudly when the comparison could not run at all (audio-feed-jdvgt).
  const { changedFiles } = await collectChangedFiles();

  const contracts = loadContracts();
  for (const file of changedFiles) {
    if (!file.startsWith("scripts/") || (!file.endsWith(".ts") && !file.endsWith(".sh"))) {
      continue;
    }
    const stem = file.split("/").pop()!.replace(/\.(ts|sh)$/, "");
    const normalizedStem = stem.replace(/-/g, "_");
    const directTestNames = directTestFileNames();
    const hasDirectTest = directTestNames.has(`${stem}_test.ts`) ||
      directTestNames.has(`${normalizedStem}_test.ts`);
    const hasContractEntry = file in coverageContract || file in contracts;
    assert(
      hasDirectTest || hasContractEntry,
      `changed file ${file} under scripts/ has no direct test and no entry in .fleet/coverage-contract.json (audio-feed-c0oh9)`,
    );
  }
});

Deno.test("fixture coverage: the template-read rule needs a read over the fixture directory AND the stem as a call argument feeding that template (audio-feed-ami7x)", () => {
  // The rule this pins is the one that lets tests/ingest_test.ts validate against
  // tests/fixtures/hero-figure.html, so each half is load-bearing on its own and is tested that way.
  // Every NEGATIVE row below is a shape that a file-global stem search (round 1) wrongly accepted.
  const template = (body: string) =>
    `const fixture = (name: string) =>\n  Deno.readTextFile(new URL(\`./fixtures/\${name}.html\`, import.meta.url));\n${body}`;

  // NEGATIVE: the template read with no stem literal - the suite substitutes SOME fixture name and
  // says nothing about which one, so it cannot be evidence for a particular file.
  assertEquals(
    suiteExercisesTarget(
      "tests/ingest_test.ts",
      "tests/fixtures/hero-figure.html",
      template(`const other = await fixture(await pickName());`),
    ).exercises,
    false,
    "a template read with no stem literal must not validate a fixture",
  );

  // NEGATIVE: the stem as a lone literal with no template read over the fixture directory.
  assertEquals(
    suiteExercisesTarget(
      "tests/ingest_test.ts",
      "tests/fixtures/hero-figure.html",
      `const template = "./fixtures/\${name}.html"; const name = "hero-figure";`,
    ).exercises,
    false,
    "a stem literal with no read call must not validate a fixture",
  );

  // NEGATIVE: the template resolves under a DIFFERENT directory, so the read names another tree.
  assertEquals(
    suiteExercisesTarget(
      "tests/ingest_test.ts",
      "tests/fixtures/hero-figure.html",
      `const fixture = (name: string) =>\n  Deno.readTextFile(new URL(\`./elsewhere/\${name}.html\`, import.meta.url));\n` +
        `const page = await fixture("hero-figure");`,
    ).exercises,
    false,
    "a template read outside the fixture directory must not validate a fixture",
  );

  // POSITIVE: the shape tests/ingest_test.ts really has - one helper, the stem passed to it.
  assertEquals(
    suiteExercisesTarget(
      "tests/ingest_test.ts",
      "tests/fixtures/hero-figure.html",
      template(`const page = await fixture("hero-figure");`),
    ).exercises,
    true,
    "a template read over tests/fixtures plus the stem literal must validate",
  );

  // NEGATIVE (audio-feed-ami7x round 2): the suite reads its fixtures through the helper, and the
  // declared stem appears ONLY inside an unrelated string - an assertion message here. A file-global
  // search for the stem accepted exactly this as proof that article.html had been read.
  assertEquals(
    suiteExercisesTarget(
      "tests/ingest_test.ts",
      "tests/fixtures/article.html",
      template(
        `const page = await fixture("paywall");\nassertStringIncludes(page, "article");`,
      ),
    ).exercises,
    false,
    "a stem literal appearing only in an unrelated string must not validate a fixture",
  );

  // NEGATIVE: the stem IS a call argument, but the callee's own definition reads another tree - the
  // argument position is only load-bearing when the template it feeds is the declared one.
  assertEquals(
    suiteExercisesTarget(
      "tests/ingest_test.ts",
      "tests/fixtures/hero-figure.html",
      template(
        `const loadJson = (name: string) =>\n  Deno.readTextFile(new URL(\`./data/\${name}.json\`, import.meta.url));\n` +
          `const page = await loadJson("hero-figure");`,
      ),
    ).exercises,
    false,
    "a stem passed to a helper that reads another template must not validate",
  );

  // POSITIVE: argument-position matching on ONE call - the template and the stem are arguments of the
  // same call, so no helper definition has to be inspected.
  assertEquals(
    suiteExercisesTarget(
      "tests/ingest_test.ts",
      "tests/fixtures/hero-figure.html",
      template(
        `const readFixture = (url: URL, name: string) => Deno.readTextFile(url);\n` +
          `const page = await readFixture(new URL(\`./fixtures/\${name}.html\`, import.meta.url), "hero-figure");`,
      ),
    ).exercises,
    true,
    "the template and the stem as arguments of one call must validate",
  );
});

Deno.test("a changed fixture that no longer exists is a deletion, not an unhandled stat throw (audio-feed-ami7x)", () => {
  // `Deno.statSync` THROWS NotFound for a deleted path instead of returning `isFile: false`, so the
  // deletion exemption has to read the throw as absence. Before (audio-feed-ami7x round 2) deleting any
  // fixture reddened the whole contracts suite with `error: NotFound` instead of being exempt.
  // The present case names THIS file, not a fixture: deleting a fixture is the very operation under
  // test, so a fixture here would make the proof impossible to run on the fixture it names.
  assertEquals(
    existsOnDisk("tests/contracts_test.ts"),
    true,
    "a path that exists must read as present",
  );
  assertEquals(
    existsOnDisk("tests/fixtures/deleted-fixture-probe.html"),
    false,
    "a deleted fixture must read as absent, not throw",
  );
  assertEquals(existsOnDisk("tests/fixtures"), false, "a directory is not a file");
});

Deno.test("a declared path that no longer exists is reported by name, not as a raw stat throw (audio-feed-nmh3v)", () => {
  // The SAME throw existsOnDisk() reads as absence above, asked by the CONTRACT-VALIDATION path, which used
  // to call `Deno.statSync` directly: deleting a mapped fixture exited with
  // `error: NotFound: ... stat '.../tests/fixtures/checker_pass_child.ts'` instead of naming the entry.
  // This row pins both directions of the contract question - a missing declared path FAILS by name (it is
  // not exempted as a deletion), and a present one does not red a healthy tree.
  assertThrows(
    () =>
      assertContractFileExists(
        "tests/fixtures/deleted-fixture-probe.html",
        "by .fleet/coverage-contract.json (mapped to tests/contracts_test.ts)",
      ),
    AssertionError,
    "tests/fixtures/deleted-fixture-probe.html is declared by .fleet/coverage-contract.json (mapped to tests/contracts_test.ts) but does not exist on disk",
    "a missing declared path must be an assertion naming the entry, not a NotFound throw",
  );
  assertContractFileExists("tests/contracts_test.ts", "by this row");
});

Deno.test("the direct-test probe keeps the tests/ directory relation the derivation reads (audio-feed-nmh3v)", async () => {
  // ROUND 2 of this bead, and the reason this row exists: routing the direct-test probe through a helper
  // PARAMETER kept every assertion green and silently dropped the `tests/` directory relation this suite
  // carries - 180 -> 179 keys on the full tree, with nothing in the diff to see. It is a real relation, not a
  // literal to preserve: which files exist in tests/ is exactly what answers "is there a direct test for
  // this script?", so a change under tests/ has to keep selecting this suite. Pinned here so the next
  // refactor of that probe has to red a row instead of quietly narrowing the gate.
  const root = new URL("../", import.meta.url).pathname;
  const report = await deriveReadRelationReport(root, ["tests/contracts_test.ts"]);
  assert(
    report.relations.get("tests/")?.includes("tests/contracts_test.ts"),
    `the direct-test probe must keep the tests/ directory relation, saw: ${
      [...report.relations.keys()].sort().join(", ")
    }`,
  );
});

/**
 * audio-feed-ami7x: fixtures are where behaviour several suites SPAWN lives, and the coverage contract
 * mapped scripts/ and assets but nothing under tests/fixtures. The host gate's independent oracle
 * (`remote/check-coverage.py`, `find_candidate_tests_for_file`) has no import edge to follow into a child
 * process: it matches by test-name stem, by an import reference, by an execute-shaped call naming a
 * LITERAL, or by a contract entry. tests/fixtures/invocation_death_child.ts matched none of those, so a
 * run that executed the very suite spawning it still reported the changed fixture as "unmapped"
 * (measured on fleet/starve-abort, audio-feed-zpyx0: "2 unmapped changed file(s):
 * tests/fixtures/invocation_death_child.ts, tests/fixtures/invocation_death_window.ts"). The contract
 * entry is the only declared edge that oracle reads, so a changed fixture must carry one.
 *
 * THE CENSUS, and how it is kept from going stale: `report.executedRelations` is the same derivation the
 * fast gate's selector uses ("which suites SPAWN which paths"), printed per fixture by
 *   deno run --allow-read --allow-run=git /tmp/fixture-census/census.ts
 * (16 fixtures on disk: 5 executed and derived - the four checker/chrome children and
 * invocation_death_child.ts - 2 executed in shapes the derivation cannot follow, 6 read as data by one
 * suite, invocation_clock.ts imported by five, ingest-browser.html read only by a manual harness).
 * Deriving the executed half rather than listing it means a NEW spawned fixture reds here without anyone
 * remembering this file.
 */
const SPAWN_FORMS_THE_RESOLVER_CANNOT_FOLLOW: Record<string, { suites: string[]; why: string }> = {
  "tests/fixtures/fake_chrome.sh": {
    suites: ["tests/proof_helper_test.ts"],
    why:
      "passed as launchChrome's `binary:` option (tests/proof_helper_test.ts:1357,1364), not as a Deno.Command args element, so no execute relation is derived",
  },
  "tests/fixtures/bd_stub.sh": {
    suites: ["tests/bd_durability_check_test.ts"],
    why:
      "Deno.copyFile'd into a scratch dir as `bd` and run there (tests/bd_durability_check_test.ts:22,61), so the copy is a READ of the source and the spawn happens on the copy",
  },
};

/**
 * Fixtures whose ONLY reader is a harness `deno test` never discovers. Naming a suite here would be a
 * claim the gate cannot keep, so the gap is declared and PROVED instead: the harness must exist, must
 * read the fixture, and must not be selectable by the fast gate.
 */
const NO_GATED_SUITE_READS: Record<string, { harness: string; why: string }> = {
  "tests/fixtures/ingest-browser.html": {
    harness: "tests/ingest_browser.ts",
    why:
      "only tests/ingest_browser.ts reads it - a manual acceptance harness started by hand (docs/ingest.md) that deno test never discovers",
  },
};

Deno.test("every fixture a suite spawns is declared in .fleet/coverage-contract.json, and every changed fixture is mapped (audio-feed-ami7x)", async () => {
  const coverageContract = loadCoverageContract();
  const report = await deriveReadRelationReport();

  // (a) THE EXECUTED CENSUS: derived spawns plus the two shapes the derivation cannot follow.
  const executed = new Map<string, string[]>();
  for (const [path, suites] of report.executedRelations) {
    if (path.startsWith("tests/fixtures/")) executed.set(path, suites);
  }
  for (const [path, form] of Object.entries(SPAWN_FORMS_THE_RESOLVER_CANNOT_FOLLOW)) {
    assert(
      !executed.has(path),
      `${path} IS now derived as executed, so its hand-written entry in SPAWN_FORMS_THE_RESOLVER_CANNOT_FOLLOW is stale: delete it and let the derivation speak (${form.why})`,
    );
    executed.set(path, form.suites);
  }
  assert(
    executed.size >= 7,
    `the executed-fixture census found ${executed.size} fixture(s), fewer than the 7 the census measured - ` +
      `a spawned fixture has dropped out of BOTH the derivation and the hand list: ${
        [...executed.keys()].join(", ")
      }`,
  );
  for (const [path, suites] of executed) {
    const declared = coverageContract[path];
    assert(
      declared !== undefined,
      `fixture ${path} is EXECUTED by ${
        suites.join(", ")
      } but has no entry in .fleet/coverage-contract.json, so a change to it is reported unmapped unless a suite happens to mention it (audio-feed-ami7x)`,
    );
    for (const suite of suites) {
      assert(
        declared!.includes(suite),
        `fixture ${path} is executed by ${suite}, but the contract maps it to ${
          declared!.join(", ")
        } - the entry must name the suite that spawns it`,
      );
    }
  }

  // (b) A CHANGED FIXTURE MUST BE DECLARED. A fixture that no longer exists is a deletion: its entry is
  // removed, not required, and demanding one would make deleting a fixture impossible. The absence is
  // read from the disk, and `Deno.statSync` THROWS NotFound rather than returning a false `isFile` for a
  // deleted path - so the stat must be guarded, or deleting any fixture reds this suite with an
  // unhandled throw instead of being exempt (audio-feed-ami7x round 2).
  const { changedFiles } = await collectChangedFiles();
  for (const file of changedFiles) {
    if (!file.startsWith("tests/fixtures/")) continue;
    if (!existsOnDisk(file)) continue;
    const excluded = NO_GATED_SUITE_READS[file];
    if (excluded) {
      assert(
        !report.relations.has(file) && !report.executedRelations.has(file),
        `${file} is declared as having NO gated reader, but the derived relation names one: relations=${
          (report.relations.get(file) ?? []).join(", ") || "none"
        }, executed=${
          (report.executedRelations.get(file) ?? []).join(", ") || "none"
        } - map it in the contract instead of excluding it`,
      );
      continue;
    }
    assert(
      file in coverageContract,
      `changed fixture ${file} has no entry in .fleet/coverage-contract.json (audio-feed-ami7x): the host gate's oracle cannot follow a spawn, so an undeclared fixture change is reported unmapped even when its suite ran. Map it to the suite(s) that genuinely spawn or read it, or declare its lack of a gated reader in NO_GATED_SUITE_READS with the harness that owns it`,
    );
  }

  // (c) EACH DECLARED GAP IS PROVED, not merely asserted: the harness exists, really reads the fixture,
  // and is a file the fast gate cannot select (so no contract entry could name it honestly).
  for (const [path, { harness, why }] of Object.entries(NO_GATED_SUITE_READS)) {
    assert(
      !(path in coverageContract),
      `${path} declares no gated reader but has a contract entry`,
    );
    assert(
      existsOnDisk(harness),
      `the harness named for ${path} must exist on disk: ${harness}`,
    );
    assert(
      !isFastGateSelectable(harness),
      `${harness} IS selectable by the fast gate, so ${path} can be mapped honestly - remove the exclusion (${why})`,
    );
    const reads = suiteExercisesTarget(harness, path);
    assert(
      reads.exercises,
      `the harness named for ${path} does not read it either: ${reads.reason} - the fixture then has no reader at all and the exclusion is not the reason`,
    );
  }
});

/**
 * Whether a repo-relative path is a file on disk. A missing path is `false` - the throw `statSync`
 * raises for it IS the deletion signal - while any other error (a permission or a broken checkout)
 * propagates, so an unreadable tree cannot be mistaken for a deletion and quietly exempted.
 */
function existsOnDisk(relativePath: string): boolean {
  try {
    return Deno.statSync(new URL(`../${relativePath}`, import.meta.url)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * The directory a direct test for a `scripts/` file lives in, named ONCE.
 *
 * audio-feed-nmh3v round 2: this const is also the reference the DERIVED READ RELATION needs. The direct-test
 * probe used to hold two `new URL(`../tests/<stem>_test.ts`, import.meta.url)` candidates, and the derivation
 * read the `../tests/` prefix of that template as a directory relation (`tests/` <- this suite) - which is
 * what selects this suite when anything under tests/ changes. Routing the probe through a helper PARAMETER
 * hid that literal (a parameter is not a path), so the relation went with it: 180 -> 179 keys on the full
 * tree, invisible in the diff. Naming the directory here and READING it says the same thing in a form the
 * derivation can see, and it says it truthfully: the set of files in tests/ is what answers "is there a
 * direct test for this script?".
 */
const DIRECT_TEST_DIR = new URL("../tests/", import.meta.url);

/**
 * The file names in DIRECT_TEST_DIR, listed once per run. One listing answers the direct-test question for
 * every changed script, where the probe it replaces stat'd two candidate paths per script and swallowed a
 * permission error as "no direct test". A missing tests/ directory is not a NotFound to absorb here - it is
 * the tree being wrong, so the throw propagates.
 */
let directTestFileNamesCache: Set<string> | null = null;
function directTestFileNames(): Set<string> {
  if (directTestFileNamesCache) return directTestFileNamesCache;
  const names = new Set<string>();
  for (const entry of Deno.readDirSync(DIRECT_TEST_DIR)) {
    if (entry.isFile) names.add(entry.name);
  }
  directTestFileNamesCache = names;
  return names;
}

/**
 * audio-feed-nmh3v: a path a CONTRACT declares must exist, asserted by name.
 *
 * The declaration question is not the deletion question answered by `existsOnDisk` on the changed-fixture
 * path. There, an absent file is a tidy-up and nothing needs exercising. Here the file is what the
 * declaration POINTS AT: a missing one makes the entry stale, so it is a FAILURE that names the entry - and a
 * bare `Deno.statSync` cannot say that, because it throws `NotFound` before any assertion can run. That is
 * exactly what deleting tests/fixtures/checker_pass_child.ts produced before this helper existed:
 *
 *   error: NotFound: No such file or directory (os error 2): stat '.../tests/fixtures/checker_pass_child.ts'
 *
 * The raw throw is neither a skip nor an exemption: it names an os error instead of the contract entry, so a
 * reader cannot tell whether the contract, the file or the suite is wrong.
 */
function assertContractFileExists(relativePath: string, declaredBy: string): void {
  assert(
    existsOnDisk(relativePath),
    `${relativePath} is declared ${declaredBy} but does not exist on disk: the declaration and the file ` +
      `have to move together, so this is a FAILURE naming the entry, not a skip. Delete the declaration ` +
      `together with the file, or restore the file (audio-feed-nmh3v)`,
  );
}

function fakeGit(byArgs: Record<string, GitResult>): GitRunner {
  return (args) => {
    const key = args.join(" ");
    const result = byArgs[key];
    if (result === undefined) throw new Error(`unexpected git call: ${key}`);
    return Promise.resolve(result);
  };
}

Deno.test("changed-files probe: an empty HEAD fallback is a failure, not a clean tree (audio-feed-jdvgt)", async () => {
  const ok = (stdout: string): GitResult => ({ success: true, code: 0, stdout, stderr: "" });
  const noOriginMain: GitResult = {
    success: false,
    code: 128,
    stdout: "",
    stderr: "fatal: ambiguous argument 'origin/main...HEAD': unknown revision",
  };

  // NEGATIVE row: origin/main is unusable AND the fallback sees nothing (a clean committed tree).
  // Before this fix that produced an empty changed set and the changed-scripts check passed having
  // examined nothing.
  await assertRejects(
    () =>
      collectChangedFiles(fakeGit({
        "status --porcelain": ok(""),
        "diff --name-only origin/main...HEAD": noOriginMain,
        "diff --name-only HEAD": ok(""),
      })),
    Error,
    "This is a FAILURE, not a pass (audio-feed-jdvgt)",
  );

  // POSITIVE control: the same fallback with uncommitted work still reports what changed, so the
  // guard rejects only the vacuous case.
  const untracked = await collectChangedFiles(fakeGit({
    "status --porcelain": ok("?? scripts/new-proof.ts\n"),
    "diff --name-only origin/main...HEAD": noOriginMain,
    "diff --name-only HEAD": ok(""),
  }));
  assertEquals(
    untracked.usedHeadFallback,
    true,
    "the missing origin/main must select the fallback",
  );
  assertEquals([...untracked.changedFiles], ["scripts/new-proof.ts"]);

  // POSITIVE control: when origin/main IS usable, an empty diff is a real "nothing changed on this
  // branch" and stays a pass.
  const clean = await collectChangedFiles(fakeGit({
    "status --porcelain": ok(""),
    "diff --name-only origin/main...HEAD": ok(""),
  }));
  assertEquals(clean.usedHeadFallback, false);
  assertEquals(clean.changedFiles.size, 0, "a usable origin/main diff may legitimately be empty");

  // And a branch diff against origin/main still enumerates its files.
  const changed = await collectChangedFiles(fakeGit({
    "status --porcelain": ok(""),
    "diff --name-only origin/main...HEAD": ok("scripts/a.ts\nsrc/b.ts\n"),
  }));
  assertEquals([...changed.changedFiles].sort(), ["scripts/a.ts", "src/b.ts"]);
});

Deno.test("docs/speed.md load-bearing figures follow stated derivation rules (audio-feed-0l7tc)", async () => {
  const content = await Deno.readTextFile(new URL("../docs/speed.md", import.meta.url));
  const normalized = content.replace(/\r?\n/g, " ");

  // 1. CHECK_TIMEOUT derivation rule
  const runsMatch = normalized.match(/window holds TEN full-gate runs — ([^—]+) seconds —/);
  assert(runsMatch !== null, "docs/speed.md must list full-gate runs for CHECK_TIMEOUT derivation");
  const runs = [...runsMatch[1]!.matchAll(/\b(\d+)\b/g)].map((m) => parseInt(m[1]!, 10));
  assertEquals(runs.length, 10, "expected 10 full-gate runs in the sample window");
  const observedMax = Math.max(...runs);
  assertStringIncludes(
    normalized,
    `from the observed max ${observedMax} s`,
    `prose must state observed max ${observedMax} s`,
  );
  const computedHeadroom = Math.ceil(observedMax * 1.1);
  assertStringIncludes(
    normalized,
    `gives ${computedHeadroom} s`,
    `prose must state ceil(observed_max × 1.1) gives ${computedHeadroom} s`,
  );
  const computedDefault = Math.ceil(computedHeadroom / 100) * 100;
  const defaultMatch = normalized.match(/\*\*CHECK_TIMEOUT default = (\d+) s\*\*/);
  assert(defaultMatch !== null, "docs/speed.md must define CHECK_TIMEOUT default");
  assertEquals(
    parseInt(defaultMatch[1]!, 10),
    computedDefault,
    `CHECK_TIMEOUT default must equal ceil(headroom / 100) * 100 (${computedDefault})`,
  );

  // 2. CHECK_FAST_TIMEOUT bound rule
  const fastProseMatch = normalized.match(/### Fast-gate bound: `CHECK_FAST_TIMEOUT` is (\d+) s/);
  assert(fastProseMatch !== null, "docs/speed.md must state CHECK_FAST_TIMEOUT prose bound");
  const shellDefaultMatch = normalized.match(/CHECK_FAST_TIMEOUT=\$\{CHECK_FAST_TIMEOUT:-(\d+)\}/);
  assert(
    shellDefaultMatch !== null,
    "docs/speed.md must state shell default for CHECK_FAST_TIMEOUT",
  );
  const fastProse = parseInt(fastProseMatch[1]!, 10);
  const shellDefault = parseInt(shellDefaultMatch[1]!, 10);
  assertEquals(
    fastProse,
    shellDefault,
    "CHECK_FAST_TIMEOUT prose bound must match shell default fallback",
  );
  assert(fastProse > 0, "CHECK_FAST_TIMEOUT must be positive");

  // 3. 4x wall time contention rule
  assertStringIncludes(
    normalized,
    "Gate wall time cannot detect a cost regression below roughly 4x",
    "docs/speed.md must state the 4x wall time detection threshold",
  );
  const fourXStart = content.indexOf(
    "### Gate wall time cannot detect a cost regression below roughly 4x",
  );
  assert(fourXStart !== -1, "docs/speed.md must have 4x wall time section");
  const fourXEnd = content.indexOf("\n### ", fourXStart + 1);
  const fourXSection = fourXEnd !== -1
    ? content.slice(fourXStart, fourXEnd)
    : content.slice(fourXStart);

  const tableRows = [
    ...fourXSection.matchAll(/\|\s*\d+m\d+s\s*\((\d+)\)\s*\|\s*(\d+)\s*\|/g),
  ].map((m) => ({
    testSec: parseInt(m[1]!, 10),
    runSec: parseInt(m[2]!, 10),
  }));
  assert(
    tableRows.length >= 4,
    "expected at least 4 runs in the 4x spread table",
  );
  const testSecs = tableRows.map((r) => r.testSec);
  const runSecs = tableRows.map((r) => r.runSec);
  const testRatio = Math.max(...testSecs) / Math.min(...testSecs);
  const runRatio = Math.max(...runSecs) / Math.min(...runSecs);
  // Only the floor is principled: the section's claim is one-sided (wall time cannot detect a cost
  // regression BELOW roughly 4x), so a spread under 4x is what contradicts the section. The
  // ceiling is a sanity bound for the current four-row table, not a claim derived from that
  // premise -- a wider spread is a measured fact, not a doc inconsistency.
  const WALL_SPREAD_FLOOR = 4.0;
  const CURRENT_TABLE_SPREAD_CEILING = 5.0;
  const clearsDetectionFloor = (ratio: number) =>
    ratio >= WALL_SPREAD_FLOOR && ratio < CURRENT_TABLE_SPREAD_CEILING;
  assert(
    clearsDetectionFloor(testRatio),
    `doc self-consistency: deno test duration spread must clear the section's ${WALL_SPREAD_FLOOR}x ` +
      `detection floor (sanity ceiling ${CURRENT_TABLE_SPREAD_CEILING}x for the current table), ` +
      `got ${testRatio.toFixed(2)}x`,
  );
  assert(
    clearsDetectionFloor(runRatio),
    `doc self-consistency: run_s duration spread must clear the section's ${WALL_SPREAD_FLOOR}x ` +
      `detection floor (sanity ceiling ${CURRENT_TABLE_SPREAD_CEILING}x for the current table), ` +
      `got ${runRatio.toFixed(2)}x`,
  );

  // 4. Test duration sum extraction rule (audio-feed-t7ri4). The section is located by its bead id
  // and its numbers are read by shape, so no sentence template can let a wrong pair skip the check.
  const beadAt = content.indexOf("audio-feed-t7ri4");
  assert(
    beadAt !== -1,
    "docs/speed.md must carry the audio-feed-t7ri4 section (2x wall move on an unchanged suite set)",
  );
  const t7ri4HeadingAt = content.lastIndexOf("\n### ", beadAt);
  assert(t7ri4HeadingAt !== -1, "audio-feed-t7ri4 must sit under its own section heading");
  const t7ri4NextHeadingAt = content.indexOf("\n### ", t7ri4HeadingAt + 1);
  const t7ri4Section =
    (t7ri4NextHeadingAt === -1
      ? content.slice(t7ri4HeadingAt)
      : content.slice(t7ri4HeadingAt, t7ri4NextHeadingAt)).replace(/\r?\n/g, " ");

  assertStringIncludes(
    t7ri4Section,
    "ANSI escape sequences stripped",
    "audio-feed-t7ri4 section must state the extraction rule: ANSI escape sequences stripped",
  );
  assertStringIncludes(
    t7ri4Section,
    "both milliseconds and seconds formats included",
    "audio-feed-t7ri4 section must state the extraction rule: both ms and s formats included",
  );
  assertStringIncludes(
    t7ri4Section,
    "failed and ignored tests excluded",
    "audio-feed-t7ri4 section must state the extraction rule: failed and ignored tests excluded",
  );
  assert(
    t7ri4Section.includes("------- output -------") &&
      t7ri4Section.includes("capture blocks included"),
    "audio-feed-t7ri4 section must state the extraction rule: capture blocks included",
  );

  // The sums are read by shape, not by sentence: every decimal-second value in the section that is
  // quoted for a run (the value, then the `287 s` / `583 s` run it belongs to, within one short
  // clause) is a candidate, and the tightest candidate per run is that run's stated sum. The
  // withdrawn 80.1 / 79.8 pair, if quoted, is quoted for no run, so it cannot satisfy the claim.
  const SUM_ATTACHMENT_WINDOW = 30;
  const runRefs = [...t7ri4Section.matchAll(/\b(287|583) s\b/g)].map((m) => ({
    run: m[1]!,
    at: m.index!,
  }));
  assert(
    runRefs.length >= 2,
    "audio-feed-t7ri4 section must name both runs it sums (the 287 s and the 583 s run)",
  );
  const durationSums = [...t7ri4Section.matchAll(/\b(\d+\.\d+) s\b/g)].map((m) => ({
    value: parseFloat(m[1]!),
    at: m.index!,
  }));
  const attachedSums = durationSums
    .map((candidate) => {
      const runRef = runRefs.find((ref) =>
        ref.at > candidate.at && ref.at - candidate.at <= SUM_ATTACHMENT_WINDOW
      );
      return runRef ? { ...candidate, run: runRef.run, gap: runRef.at - candidate.at } : null;
    })
    .filter((candidate) => candidate !== null)
    .sort((a, b) => a.gap - b.gap);
  const claimedSums = new Set<number>();
  const sumForRun = (run: string) => {
    const match = attachedSums.find((candidate) =>
      candidate.run === run && !claimedSums.has(candidate.at)
    );
    if (match) claimedSums.add(match.at);
    return match;
  };
  const sum287 = sumForRun("287");
  const sum583 = sumForRun("583");
  assert(
    sum287 !== undefined && sum583 !== undefined,
    "audio-feed-t7ri4 section must quote its per-test duration sums for both the 287 s and the " +
      "583 s run (a section that quotes no pair fails here; absence is not a skip)",
  );
  const sumsRatio = sum583.value / sum287.value;
  // The section states in-body duration grew ~2.3x under its own rule against a ~2.0x wall move;
  // 2.2-2.4 is that stated 2.3x with rounding room, and a flat pair (the withdrawn 80.1 / 79.8)
  // lands nowhere near it.
  assert(
    sumsRatio >= 2.2 && sumsRatio <= 2.4,
    `doc self-consistency: the section's own sums (${sum287.value} s / ${sum583.value} s) must ` +
      `grow ~2.3x, tracking the ~2.0x wall move it reports; got ${sumsRatio.toFixed(2)}x`,
  );
  if (t7ri4Section.includes("80.1 s vs 79.8 s")) {
    assert(
      t7ri4Section.includes("withdrawn") &&
        t7ri4Section.includes("omitted the captured output blocks"),
      "withdrawn 80.1 vs 79.8 sum must be labelled withdrawn and as omitting capture blocks",
    );
  }
});
