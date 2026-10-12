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
 * Scratch TMPDIR isolation:
 * As mandated, never touches the live `/tmp/audiofeed-*` pile; all directory operations use scratch.
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { createTempChromeProfile } from "../scripts/proof-helper.ts";

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
  // Match direct Deno.makeTempDir calls
  const directMatches: string[] = [];
  const makeTempDirRegex = /Deno\.makeTempDir\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = makeTempDirRegex.exec(source)) !== null) {
    directMatches.push(m[0]);
  }

  // Check if it imports / calls createTempChromeProfile
  const usesHelper = /createTempChromeProfile\s*\(/.test(source) &&
    /import\s+[^;]*createTempChromeProfile[^;]*from/.test(source);

  // Extract prefix passed to createTempChromeProfile if any
  let prefix: string | null = null;
  const helperCallMatch = source.match(/createTempChromeProfile\s*\(\s*(["'])([^"']+)\1\s*\)/);
  if (helperCallMatch) {
    prefix = helperCallMatch[2] ?? null;
  }

  // Detect un-prefixed makeTempDir: Deno.makeTempDir() or Deno.makeTempDir({}) without prefix
  const hasUnprefixedAllocation = directMatches.some((call) => {
    const inside = call.replace(/^Deno\.makeTempDir\s*\(/, "").replace(/\)$/, "").trim();
    return inside.length === 0 || inside === "{}" || !inside.includes("prefix");
  });

  const hasSeparatorTerminatedPrefix = prefix !== null && prefix.endsWith("-");

  // Check if cleanup helper is wired into the finally block / teardown
  const usesCleanupHelper = /await\s+cleanup\s*\(\s*\)/.test(source) ||
    /await\s+active(?:Scratch)?Cleanup\s*\(\s*\)/.test(source) ||
    /cleanupFn\s*\(/.test(source);

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

// ---------------------------------------------------------------------------------------------
// Call site property checks
// ---------------------------------------------------------------------------------------------

Deno.test("audio-feed-qmcf: (1) scripts/landing-tooltip-browser-proof.ts creates profile through helper", async () => {
  const audit = await auditCallSite("scripts/landing-tooltip-browser-proof.ts");
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
  assert(
    audit.usesHelper,
    `${audit.file} buildScratch must allocate scratch tree through createTempChromeProfile to enable stale sweep`,
  );
  assert(
    audit.hasSeparatorTerminatedPrefix,
    `${audit.file} prefix '${audit.prefix}' must be separator-terminated ('-')`,
  );
  assertEquals(
    audit.directMakeTempDirMatches.length,
    0,
    `${audit.file} must not call raw Deno.makeTempDir directly`,
  );
});

Deno.test("audio-feed-qmcf: (4) scripts/verify_s3uk_real_browser.ts eliminates un-prefixed profile and uses helper", async () => {
  const audit = await auditCallSite("scripts/verify_s3uk_real_browser.ts");
  assertFalse(
    audit.hasUnprefixedAllocation,
    `${audit.file} has un-prefixed Deno.makeTempDir allocation; no prefix-scoped rule can sweep un-prefixed profiles!`,
  );
  assert(
    audit.usesHelper,
    `${audit.file} must allocate Chrome profile through createTempChromeProfile`,
  );
  assert(
    audit.hasSeparatorTerminatedPrefix,
    `${audit.file} prefix '${audit.prefix}' must be separator-terminated ('-') conforming to sweep boundary`,
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
    'const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-agent-test-");';
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
  const originalTmp = Deno.env.get("TMPDIR");
  const scratch = await Deno.makeTempDir({ prefix: "qmcf-scratch-" });
  Deno.env.set("TMPDIR", scratch);

  try {
    const prefixes = [
      "audiofeed-proof-3xq-4c-",
      "audiofeed-agent-test-",
      "exww-mutants-",
      "audiofeed-s3uk-",
    ];

    for (const prefix of prefixes) {
      assert(prefix.endsWith("-"), `prefix '${prefix}' must end with '-' for separator boundary`);
      const { profileDir, cleanup } = await createTempChromeProfile(prefix);

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
    if (originalTmp === undefined) Deno.env.delete("TMPDIR");
    else Deno.env.set("TMPDIR", originalTmp);
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});
