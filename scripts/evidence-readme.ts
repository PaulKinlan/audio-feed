/**
 * Marker-delimited generated regions for evidence READMEs (audio-feed-pluv).
 *
 * THE PROBLEM THIS EXISTS FOR. A proof regenerates its evidence README, and a human then curates that
 * same file - correcting copied values, adding criteria, recording why something was re-run. That is a
 * TWO-WRITER FILE by construction, and the second writer always loses: measured on
 * docs/evidence/audio-feed-r97/README.md, one run of its proof reduced a 36-line curated document to 4
 * lines (git numstat 2 insertions / 34 deletions), destroying the Debt note, the whole "Verified
 * Criteria" section and the recorded execution log - including a landed human correction.
 *
 * THE SHAPE: the generator writes only BETWEEN marker lines and everything outside them is preserved.
 * This is the idiom the repository already uses to share one client between surfaces -
 * src/routes/shell.ts slices src/assets/confirm-shared.js between "// #confirm-shared-begin" and
 * "// #confirm-shared-end" (audio-feed-0r0s) - so it is the house pattern rather than an invention.
 * Markers are HTML comments because evidence READMEs are markdown and these must not render.
 *
 * THE THREE PROPERTIES THE TEST PINS, because each one is a failure mode that has actually bitten:
 *  1. IDEMPOTENT - merging a generated body into a file that already contains it is a no-op, so a
 *     re-run cannot dirty a tracked file (the twin defect recorded in audio-feed-ifgw).
 *  2. OUTSIDE SURVIVES - anything a human wrote outside the region is byte-identical afterwards, which
 *     is the audio-feed-pluv hazard expressed at unit level.
 *  3. LOUD WHEN MALFORMED - absent, duplicated or reversed markers throw rather than guessing, matching
 *     confirmClientFromSource's behaviour of rejecting malformed sources loudly (audio-feed-0r0s).
 * Plus: a change INSIDE the region IS replaced, so generated values stay the generator's to state.
 *
 * NOTHING IS MIGRATED BY THIS MODULE. A README with no markers is rejected loudly rather than having
 * markers injected into it, so the generator's behaviour is unchanged until a README is deliberately
 * migrated - the migration is a separate, per-file decision. The FIRST generator wired to honour a
 * migrated README is writeEvidenceReadme in scripts/proof-helper.ts (audio-feed-i98g1: it now merges
 * into marker-delimited files instead of overwriting them, and still overwrites un-migrated ones).
 *
 * THE MATCHING RULE, AND ITS KNOWN LIMIT, STATED PLAINLY: a marker is a line that is EXACTLY the marker
 * text (surrounding whitespace ignored). That makes an inline mention in prose safe - a README can talk
 * about "<!-- #evidence-readme-generated-begin -->" mid-sentence. It CANNOT protect an exact copy of the
 * marker standing alone on a line, including inside a fenced example, because the text alone does not
 * say whether it is a fence or a marker and this module deliberately does not parse markdown. So a
 * README must never paste the marker alone on a line, and tests/evidence_readme_test.ts pins that limit
 * rather than pretending it away.
 */

/** Marker lines, matched as WHOLE LINES (the same rule shell.ts applies to #confirm-shared). */
export const GENERATED_BEGIN = "<!-- #evidence-readme-generated-begin -->";
export const GENERATED_END = "<!-- #evidence-readme-generated-end -->";

export interface GeneratedRegionSplit {
  /** Everything before the begin marker, including its newline. */
  before: string;
  /** The generated body, without either marker line. */
  generated: string;
  /** Everything after the end marker. */
  after: string;
}

function requireSingleMarker(lines: string[], marker: string): number {
  let first = -1;
  let count = 0;
  for (const [i, line] of lines.entries()) {
    if (line.trim() !== marker) continue;
    count += 1;
    if (first < 0) first = i;
  }
  if (count === 0) {
    throw new Error(
      `generated region: the ${marker} marker line is missing. A README is migrated to the ` +
        `marker-delimited shape deliberately, one file at a time - it is never injected automatically.`,
    );
  }
  if (count > 1) {
    throw new Error(
      `generated region: the ${marker} marker line appears ${count} times, so it does not ` +
        `delimit one region - refuse rather than guess which one is meant.`,
    );
  }
  return first;
}

/**
 * True when `text` carries either marker as a whole line, i.e. the README has been MIGRATED to the
 * two-writer shape. Deliberately does NOT validate the marker pair: a file with a begin marker but
 * no end marker is migrated-but-malformed, and callers must treat it as a generated-region file and
 * let splitGeneratedRegion throw LOUDLY rather than fall back to a whole-file overwrite - the silent
 * fallback would strip human prose exactly when the file needs protection most (audio-feed-i98g1).
 */
export function hasGeneratedRegion(text: string): boolean {
  return text.split("\n").some((line) =>
    line.trim() === GENERATED_BEGIN || line.trim() === GENERATED_END
  );
}

/**
 * Read an evidence README for a region merge, or null when it does not exist yet.
 *
 * WHY THE READ LIVES HERE AND NOT AT THE proof-helper CALL SITE (audio-feed-i98g1): the fast gate's
 * read-relation derivation follows a suite's imports ONE hop out, and it resolves a template read like
 * `Deno.readTextFile(`${dir}/README.md`)` to its static tail - so a read written in proof-helper.ts
 * lent EVERY proof-helper importer (14 suites) a "README.md" relation, and a change to the repo-root
 * README.md selected all of them (measured: the fixture in tests/fast_gate_subset_test.ts went from 3
 * to 17 suites). Passed a full path as a plain parameter, this call site resolves to nothing, and the
 * TRUE relations - docs/evidence files a suite really reads - keep driving the selection unchanged.
 */
export async function readEvidenceReadmeIfExists(
  readmePath: string,
): Promise<string | null> {
  return await Deno.readTextFile(readmePath).catch(() => null);
}

/** Split a README into the human prefix, the generated body and the human suffix. */
export function splitGeneratedRegion(text: string): GeneratedRegionSplit {
  const lines = text.split("\n");
  const begin = requireSingleMarker(lines, GENERATED_BEGIN);
  const end = requireSingleMarker(lines, GENERATED_END);
  if (end < begin) {
    throw new Error(
      `generated region: the end marker precedes the begin marker, so the region is empty or ` +
        `reversed - refuse rather than emit a README with the human text inside the generated area.`,
    );
  }
  return {
    // `before` excludes the begin marker line and `after` excludes the end marker line: the wrapper
    // emits those, so including them here would double them on every merge.
    before: begin === 0 ? "" : lines.slice(0, begin).join("\n") + "\n",
    generated: lines.slice(begin + 1, end).join("\n"),
    // The newline after the end marker is emitted ONLY when the committed file actually had one.
    // A README whose end marker is its last line and which has no final newline must round-trip with
    // NO final newline, or the first regeneration dirties a file it did not change - the byte-identity
    // pin would report an unstable file that is in fact identical (audio-feed-fied).
    after: lines.length > end + 1 ? "\n" + lines.slice(end + 1).join("\n") : "",
  };
}

/** Wrap a generated body in the markers, as a generator would emit it. */
export function wrapGeneratedRegion(generated: string): string {
  const body = generated.endsWith("\n") ? generated.slice(0, -1) : generated;
  return `${GENERATED_BEGIN}\n${body}\n${GENERATED_END}`;
}

/**
 * Merge a freshly generated body into an existing README, preserving everything outside the region.
 * Throws when the committed README is not marker-delimited (see splitGeneratedRegion).
 */
export function mergeGeneratedRegion(committed: string, generated: string): string {
  const { before, after } = splitGeneratedRegion(committed);
  return `${before}${wrapGeneratedRegion(generated)}${after}`;
}

/**
 * THE BYTE-IDENTITY PIN: true when re-running the generator against this README would leave it
 * unchanged. False means the committed file and the generator disagree - which is the state that must
 * never land silently.
 */
export function isRegenerationStable(committed: string, generated: string): boolean {
  return mergeGeneratedRegion(committed, generated) === committed;
}
