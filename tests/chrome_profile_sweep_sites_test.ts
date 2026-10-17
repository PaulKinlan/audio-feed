/**
 * audio-feed-qmcf: Chrome profile & suite temp directory creation sites must go through
 * the project's profile creation helper (`createTempChromeProfile`), rather than invoking
 * raw `Deno.makeTempDir` directly.
 *
 * Background:
 * The profile sweep covers profiles created through `createTempChromeProfile` / `withChrome`.
 * Four call sites created directories with direct `Deno.makeTempDir` outside the helper:
 *   (1) scripts/landing-tooltip-browser-proof.ts (prefix "audiofeed-proof-3xq-4c-")
 *   (2) tests/observability_agent_poll_test.ts   (prefix "audiofeed-agent-test-", runs in gate suite)
 *   (3) scripts/exww-mutants.ts                  (prefix "exww-mutants-")
 *   (4) scripts/verify_s3uk_real_browser.ts     (passed NO prefix at all)
 *
 * This test asserts the property:
 * - Each site must allocate its profile/temp directory via `createTempChromeProfile`
 * - No site may allocate an un-prefixed profile (Case 4 defect)
 * - Every allocated prefix must be separator-terminated (`-`) conforming to the sweep boundary
 * - Cleanup must use the helper's retry-capable `cleanup()` rather than swallowing removal errors
 *
 * Scratch isolation:
 * As mandated, never touches the live `/tmp/audiofeed-*` pile. Every directory operation is aimed at a scratch
 * root handed to the helper AS AN ARGUMENT (audio-feed-oyf3g) rather than by redirecting the process-global
 * TMPDIR - under `deno test --parallel` that redirect captured other modules' temp dirs into this sandbox and
 * deleted them with it.
 */
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { createTempChromeProfile } from "../scripts/proof-helper.ts";
import { firstArgument, maskNonCode } from "../scripts/source-mask.ts";

export interface SiteAudit {
  file: string;
  source: string;
  directMakeTempDirMatches: string[];
  usesHelper: boolean;
  prefix: string | null;
  hasUnprefixedAllocation: boolean;
  hasSeparatorTerminatedPrefix: boolean;
  usesCleanupHelper: boolean;
}

export function auditSource(source: string, relativePath: string): SiteAudit {
  // audio-feed-qmcf: Mask comments and string interiors before scanning.
  // A helper call or import named inside a comment or string is not a call (lesson from
  // scripts/evidence-census.ts: "a write call NAMED inside a comment or a string is not a call").
  // Offsets are strictly preserved by maskNonCode so character ranges map 1:1 between masked and raw text.
  const masked = maskNonCode(source);

  /**
   * Match direct Deno.makeTempDir calls.
   *
   * DECLARED LIMITATION (audio-feed-qmcf, following scripts/evidence-census.ts rule):
   * This regex `/Deno\.makeTempDir\s*\(([^)]*)\)/g` stops at the FIRST close-paren `)`.
   * Consequently:
   * 1. A call with a nested paren, for example `Deno.makeTempDir({ prefix: f(x) })`, has its
   *    argument text truncated at the first `)` (inside `f(x)`), reading `{ prefix: f(x` rather
   *    than the full options object.
   * 2. A call whose argument is spread across lines or formatted with interior expressions may be
   *    read differently than expected.
   *
   * Shapes covered:
   * - Standard direct invocations with flat literal options or no options:
   *   `Deno.makeTempDir()`, `Deno.makeTempDir({})`, and `Deno.makeTempDir({ prefix: "..." })`.
   * Shapes not covered:
   * - Nested parentheses within the argument list (e.g. function calls, sub-expressions).
   *
   * This limitation is declared rather than left unstated, adhering to the census's rule
   * (scripts/evidence-census.ts): an unstated hole in a scanner is worse than a stated one.
   * In this repository's audited sites, all direct allocations follow flat literal shapes.
   */
  const directMatches: string[] = [];
  const makeTempDirRegex = /Deno\.makeTempDir\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = makeTempDirRegex.exec(masked)) !== null) {
    // Read the corresponding raw slice for informative assertion error messages
    directMatches.push(source.slice(m.index, m.index + m[0].length));
  }

  // Check if it imports / calls createTempChromeProfile in real code (masked text)
  const usesHelper = /createTempChromeProfile\s*\(/.test(masked) &&
    /import\s+[^;]*createTempChromeProfile[^;]*from/.test(masked);

  // Extract prefix passed to createTempChromeProfile:
  // Locate the call in MASKED text so that comments and string literals cannot supply it.
  // Then read the argument literal at that offset using firstArgument (which balances parens).
  let prefix: string | null = null;
  const helperCallRegex = /createTempChromeProfile\s*\(/g;
  let helperMatch: RegExpExecArray | null;
  while ((helperMatch = helperCallRegex.exec(masked)) !== null) {
    const openParenIndex = helperMatch.index + helperMatch[0].length - 1;
    const rawArg = firstArgument(masked, source, openParenIndex);
    if (rawArg) {
      const trimmed = rawArg.trim();
      const stringMatch = trimmed.match(/^["']([^"']+)["']$/);
      if (stringMatch && prefix === null) {
        prefix = stringMatch[1] ?? null;
      }
    }
  }

  // Detect un-prefixed makeTempDir: Deno.makeTempDir() or Deno.makeTempDir({}) without prefix
  const hasUnprefixedAllocation = directMatches.some((call) => {
    const inside = call.replace(/^Deno\.makeTempDir\s*\(/, "").replace(/\)$/, "").trim();
    const maskedInside = maskNonCode(inside);
    return maskedInside.length === 0 || maskedInside === "{}" || !maskedInside.includes("prefix");
  });

  const hasSeparatorTerminatedPrefix = prefix !== null && prefix.endsWith("-");

  // Check if cleanup helper is wired into the finally block / teardown in real code (masked text)
  const usesCleanupHelper = /await\s+cleanup\s*\(\s*\)/.test(masked) ||
    /await\s+active(?:Scratch)?Cleanup\s*\(\s*\)/.test(masked) ||
    /cleanupFn\s*\(/.test(masked);

  return {
    file: relativePath,
    source,
    directMakeTempDirMatches: directMatches,
    usesHelper,
    prefix,
    hasUnprefixedAllocation,
    hasSeparatorTerminatedPrefix,
    usesCleanupHelper,
  };
}

export async function auditCallSite(relativePath: string): Promise<SiteAudit> {
  const fileUrl = new URL(`../${relativePath}`, import.meta.url);
  const source = await Deno.readTextFile(fileUrl);
  return auditSource(source, relativePath);
}

export function applyMutant(
  source: string,
  anchor: string,
  replacement: string,
): { mutated: string; occurrences: number; applied: boolean } {
  let occurrences = 0;
  let idx = 0;
  while ((idx = source.indexOf(anchor, idx)) !== -1) {
    occurrences++;
    idx += anchor.length;
  }
  if (occurrences !== 1) {
    throw new Error(
      `Anchor expected exactly once, found ${occurrences}: ${JSON.stringify(anchor)}`,
    );
  }
  const mutated = source.replace(anchor, replacement);
  return { mutated, occurrences, applied: true };
}

/**
 * Run the standard suite of site property assertions on an audit.
 * Used by call site checks and negative tests to assert conformance / failure.
 */
export function assertSiteConforms(audit: SiteAudit): void {
  assert(
    audit.usesHelper,
    `${audit.file} must allocate Chrome profile through createTempChromeProfile, found direct calls: ${
      JSON.stringify(audit.directMakeTempDirMatches)
    }`,
  );
  assert(
    audit.hasSeparatorTerminatedPrefix,
    `${audit.file} prefix '${audit.prefix}' must be separator-terminated ('-') for sweep boundary`,
  );
  assert(
    audit.usesCleanupHelper,
    `${audit.file} must use cleanup() on teardown for retry-safe profile removal`,
  );
  assertEquals(
    audit.directMakeTempDirMatches.length,
    0,
    `${audit.file} must not call raw Deno.makeTempDir directly`,
  );
  assertFalse(
    audit.hasUnprefixedAllocation,
    `${audit.file} has un-prefixed Deno.makeTempDir allocation; no prefix-scoped rule can sweep un-prefixed profiles!`,
  );
}

// ---------------------------------------------------------------------------------------------
// Call site property checks
// ---------------------------------------------------------------------------------------------

Deno.test("audio-feed-qmcf: (1) scripts/landing-tooltip-browser-proof.ts creates profile through helper", async () => {
  const audit = await auditCallSite("scripts/landing-tooltip-browser-proof.ts");
  assertSiteConforms(audit);
});

Deno.test("audio-feed-qmcf: (2) tests/observability_agent_poll_test.ts creates suite temp dir through helper", async () => {
  const audit = await auditCallSite("tests/observability_agent_poll_test.ts");
  assert(
    audit.usesHelper,
    `${audit.file} withTempDir must allocate through createTempChromeProfile to enable sweep and safe cleanup`,
  );
  assert(
    audit.hasSeparatorTerminatedPrefix,
    `${audit.file} prefix '${audit.prefix}' must be separator-terminated ('-')`,
  );
  assert(
    audit.usesCleanupHelper,
    `${audit.file} withTempDir must use cleanup() on teardown for retry-safe directory removal`,
  );
  assertFalse(
    audit.directMakeTempDirMatches.some((m) => m.includes("audiofeed-agent-test-")),
    `${audit.file} must not allocate audiofeed-agent-test- via raw Deno.makeTempDir`,
  );
});

Deno.test("audio-feed-qmcf: (3) scripts/exww-mutants.ts buildScratch creates scratch dir through helper", async () => {
  const audit = await auditCallSite("scripts/exww-mutants.ts");
  assertSiteConforms(audit);
});

Deno.test("audio-feed-qmcf: (4) scripts/verify_s3uk_real_browser.ts eliminates un-prefixed profile and uses helper", async () => {
  const audit = await auditCallSite("scripts/verify_s3uk_real_browser.ts");
  assertSiteConforms(audit);
});

// ---------------------------------------------------------------------------------------------
// Negative tests proving that comments and string literals cannot satisfy the audit (masking)
// ---------------------------------------------------------------------------------------------

Deno.test("audio-feed-qmcf: negative: helper mention inside COMMENT fails check", () => {
  const commentSource = `
// import { createTempChromeProfile } from "../scripts/proof-helper.ts";
// const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-comment-");
// await cleanup();

export async function run() {
  const profileDir = await Deno.makeTempDir({ prefix: "audiofeed-comment-" });
  return profileDir;
}
`;
  // Without masking, unmasked scanning would falsely satisfy usesHelper and extract prefix
  const rawUsesHelper = /createTempChromeProfile\s*\(/.test(commentSource) &&
    /import\s+[^;]*createTempChromeProfile[^;]*from/.test(commentSource);
  assert(rawUsesHelper, "confirms the unmasked defect: raw source falsely satisfied usesHelper");

  const audit = auditSource(commentSource, "synthetic-comment-site.ts");
  assertFalse(audit.usesHelper, "helper in comment must NOT satisfy usesHelper");
  assertEquals(audit.prefix, null, "helper in comment must NOT supply prefix");
  assertFalse(
    audit.hasSeparatorTerminatedPrefix,
    "prefix in comment cannot be separator-terminated",
  );
  assertEquals(audit.directMakeTempDirMatches.length, 1);

  // Load-bearing failure assertion: proves it reddens specifically on usesHelper
  const expectedMsg =
    'synthetic-comment-site.ts must allocate Chrome profile through createTempChromeProfile, found direct calls: ["Deno.makeTempDir({ prefix: \\"audiofeed-comment-\\" })"]';
  const err = assertThrows(
    () => assertSiteConforms(audit),
    Error,
    expectedMsg,
  );
  assertEquals(err.message, expectedMsg);
});

Deno.test("audio-feed-qmcf: negative: helper call inside STRING literal fails check", () => {
  const stringSource = `
const example = 'import { createTempChromeProfile } from "../scripts/proof-helper.ts"; const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-string-"); await cleanup();';

export async function run() {
  const profileDir = await Deno.makeTempDir({ prefix: "audiofeed-string-" });
  return profileDir;
}
`;
  // Without masking, unmasked scanning would falsely satisfy usesHelper and extract prefix
  const rawUsesHelper = /createTempChromeProfile\s*\(/.test(stringSource) &&
    /import\s+[^;]*createTempChromeProfile[^;]*from/.test(stringSource);
  assert(rawUsesHelper, "confirms the unmasked defect: raw source falsely satisfied usesHelper");

  const audit = auditSource(stringSource, "synthetic-string-site.ts");
  assertFalse(audit.usesHelper, "helper in string literal must NOT satisfy usesHelper");
  assertEquals(audit.prefix, null, "helper in string literal must NOT supply prefix");
  assertFalse(audit.hasSeparatorTerminatedPrefix, "prefix in string literal cannot supply prefix");
  assertEquals(audit.directMakeTempDirMatches.length, 1);

  // Load-bearing failure assertion: proves it reddens specifically on usesHelper
  const expectedMsg =
    'synthetic-string-site.ts must allocate Chrome profile through createTempChromeProfile, found direct calls: ["Deno.makeTempDir({ prefix: \\"audiofeed-string-\\" })"]';
  const err = assertThrows(
    () => assertSiteConforms(audit),
    Error,
    expectedMsg,
  );
  assertEquals(err.message, expectedMsg);
});

Deno.test("audio-feed-qmcf: negative: landing-tooltip with helper in comment fails check", async () => {
  const fileUrl = new URL("../scripts/landing-tooltip-browser-proof.ts", import.meta.url);
  const source = await Deno.readTextFile(fileUrl);
  const anchor =
    'const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-proof-3xq-4c-");';
  const mutant = applyMutant(
    source,
    anchor,
    '// const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-proof-3xq-4c-");\nconst PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-3xq-4c-" });',
  );
  assertEquals(mutant.occurrences, 1, "mutant anchor must appear exactly once");
  assertEquals(mutant.applied, true, "mutant must prove it applied");

  const audit = auditSource(mutant.mutated, "scripts/landing-tooltip-browser-proof.ts");
  assertFalse(audit.usesHelper, "commented-out helper must NOT satisfy usesHelper");
  assertEquals(audit.prefix, null, "commented-out helper must NOT supply prefix");
  assertFalse(audit.hasSeparatorTerminatedPrefix, "prefix must be null");
  assertEquals(audit.directMakeTempDirMatches.length, 1);

  const expectedMsg =
    'scripts/landing-tooltip-browser-proof.ts must allocate Chrome profile through createTempChromeProfile, found direct calls: ["Deno.makeTempDir({ prefix: \\"audiofeed-proof-3xq-4c-\\" })"]';
  const err = assertThrows(
    () => assertSiteConforms(audit),
    Error,
    expectedMsg,
  );
  assertEquals(err.message, expectedMsg);
});

// ---------------------------------------------------------------------------------------------
// Mutants proving that each site's property check is load-bearing
// ---------------------------------------------------------------------------------------------

Deno.test("audio-feed-qmcf: mutant M1 reverts landing-tooltip to raw makeTempDir -> fails check", async () => {
  const fileUrl = new URL("../scripts/landing-tooltip-browser-proof.ts", import.meta.url);
  const source = await Deno.readTextFile(fileUrl);
  const anchor =
    'const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-proof-3xq-4c-");';
  const mutant = applyMutant(
    source,
    anchor,
    'const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-3xq-4c-" });',
  );
  assertEquals(mutant.occurrences, 1, "mutant M1 anchor must appear exactly once");
  assertEquals(mutant.applied, true, "mutant M1 must prove it applied");

  const audit = auditSource(mutant.mutated, "scripts/landing-tooltip-browser-proof.ts");
  assertEquals(
    audit.directMakeTempDirMatches.length > 0,
    true,
    "M1 correctly reddens direct makeTempDir check",
  );
});

Deno.test("audio-feed-qmcf: mutant M2 reverts observability-agent withTempDir to raw makeTempDir -> fails check", async () => {
  const fileUrl = new URL("../tests/observability_agent_poll_test.ts", import.meta.url);
  const source = await Deno.readTextFile(fileUrl);
  const anchor =
    // audio-feed-oyf3g: the anchor tracks the CONVERTED source (the root is now passed in), while the mutation
    // target stays a raw makeTempDir - so M2 still proves the audit reddens a direct allocation for this prefix.
    'const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-agent-test-", root);';
  const mutant = applyMutant(
    source,
    anchor,
    'const profileDir = await Deno.makeTempDir({ prefix: "audiofeed-agent-test-" });',
  );
  assertEquals(mutant.occurrences, 1, "mutant M2 anchor must appear exactly once");
  assertEquals(mutant.applied, true, "mutant M2 must prove it applied");

  const audit = auditSource(mutant.mutated, "tests/observability_agent_poll_test.ts");
  assertEquals(
    audit.directMakeTempDirMatches.some((m) => m.includes("audiofeed-agent-test-")),
    true,
    "M2 correctly reddens direct audiofeed-agent-test- allocation check",
  );
});

Deno.test("audio-feed-qmcf: mutant M3 reverts exww-mutants buildScratch to raw makeTempDir -> fails check", async () => {
  const fileUrl = new URL("../scripts/exww-mutants.ts", import.meta.url);
  const source = await Deno.readTextFile(fileUrl);
  const anchor = 'const allocated = await createTempChromeProfile("exww-mutants-");';
  const mutant = applyMutant(
    source,
    anchor,
    'const dir = await Deno.makeTempDir({ prefix: "exww-mutants-" });',
  );
  assertEquals(mutant.occurrences, 1, "mutant M3 anchor must appear exactly once");
  assertEquals(mutant.applied, true, "mutant M3 must prove it applied");

  const audit = auditSource(mutant.mutated, "scripts/exww-mutants.ts");
  assertEquals(
    audit.directMakeTempDirMatches.length > 0,
    true,
    "M3 correctly reddens direct makeTempDir check",
  );
});

Deno.test("audio-feed-qmcf: mutant M4 reverts verify_s3uk to un-prefixed makeTempDir() -> fails check", async () => {
  const fileUrl = new URL("../scripts/verify_s3uk_real_browser.ts", import.meta.url);
  const source = await Deno.readTextFile(fileUrl);
  const anchor =
    'const { profileDir: profile, cleanup } = await createTempChromeProfile("audiofeed-s3uk-");';
  const mutant = applyMutant(
    source,
    anchor,
    "const profile = await Deno.makeTempDir();",
  );
  assertEquals(mutant.occurrences, 1, "mutant M4 anchor must appear exactly once");
  assertEquals(mutant.applied, true, "mutant M4 must prove it applied");

  const audit = auditSource(mutant.mutated, "scripts/verify_s3uk_real_browser.ts");
  assertEquals(
    audit.hasUnprefixedAllocation,
    true,
    "M4 correctly reddens un-prefixed allocation check",
  );
});

// ---------------------------------------------------------------------------------------------
// Scratch TMPDIR sweep & lifecycle demonstration
// ---------------------------------------------------------------------------------------------

Deno.test("audio-feed-qmcf: helper contract creates separator-terminated profile in scratch and cleans up", async () => {
  const scratch = await Deno.makeTempDir({ prefix: "qmcf-scratch-" });

  // THE ROOT IS HANDED IN, NOT PUT IN THE ENVIRONMENT (audio-feed-oyf3g): redirecting the process-global
  // TMPDIR under `deno test --parallel` captured other modules' temp dirs into this scratch directory and
  // deleted them with it. Passing the root to createTempChromeProfile keeps the reclaim sweep inside this
  // sandbox (so a real /tmp is never swept) and puts the profile here - the name contract asserted below is
  // unaffected, because it reads the BASENAME, not the location.
  try {
    const prefixes = [
      "audiofeed-proof-3xq-4c-",
      "audiofeed-agent-test-",
      "exww-mutants-",
      "audiofeed-s3uk-",
    ];

    for (const prefix of prefixes) {
      assert(prefix.endsWith("-"), `prefix '${prefix}' must end with '-' for separator boundary`);
      const { profileDir, cleanup } = await createTempChromeProfile(prefix, scratch);

      const basename = profileDir.split("/").pop()!;
      assert(
        basename.startsWith(prefix),
        `dir name '${basename}' must start with prefix '${prefix}'`,
      );
      const tail = basename.slice(prefix.length);
      assert(tail.length > 0, `tail must not be empty`);
      assertFalse(tail.includes("-"), `tail '${tail}' must be separator-free (no '-')`);

      // Verify directory exists
      const stat = await Deno.stat(profileDir);
      assert(stat.isDirectory, `profile dir must exist as directory`);

      // Cleanup
      await cleanup();
      let gone = false;
      try {
        await Deno.stat(profileDir);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) gone = true;
      }
      assert(gone, `profile dir must be removed after cleanup()`);
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});
