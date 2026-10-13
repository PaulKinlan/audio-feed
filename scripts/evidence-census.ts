/**
 * audio-feed-t9w1 — the evidence census predicate, and its negative controls.
 *
 * WHY THIS EXISTS. The predicate that counted "which scripts produce evidence"
 * matched the PRESENCE OF A STRING, and it fired four times on scripts that
 * write nothing: twice on a bead id in the source (once in the body, once in a
 * header comment) and twice on scripts that drive a real browser and assert
 * real results but commit nothing. Every one of those four was a FALSE POSITIVE,
 * and a 31-of-31 check against real directories could not see any of them,
 * because it asked "does this predicate MISS?" and never "does it fire when it
 * should not?". A predicate validated only on positive examples is not
 * validated.
 *
 * SO THE PREDICATE'S INPUT IS NOT "the script names a docs/evidence directory"
 * but "the script WRITES one": the FIRST argument of a write call, IN CODE
 * POSITION, that resolves into docs/evidence. A mention elsewhere in the file — a
 * comment, a bead id, a localStorage key, a route — is not evidence of a write,
 * and a read is not a write. An evidence slice is defined by what it COMMITS.
 *
 * audio-feed-ehon NARROWED THE DERIVATION TWICE, because the first version passed
 * its tests while still counting three shapes that write nothing: the id in a
 * write's PAYLOAD (`writeTextFile("/tmp/report.txt", "...docs/evidence/audio-feed-abcd")`),
 * a call written inside a COMMENT, and a call written inside a STRING. The
 * payload is now excluded by taking the first argument only, and the other two by
 * scanning a masked copy of the source — maskNonCode(), in scripts/source-mask.ts. Each is pinned by a
 * test, and each is a MENTION rather than a write, which is the honest word.
 *
 * DEPTH OF RESOLUTION, DECLARED RATHER THAN GLOSSED: one level of module-scope
 * literal substitution, which is the shape this repository actually uses —
 * `const OUT = new URL("../docs/evidence/audio-feed-ep1/", import.meta.url)`
 * followed by `Deno.writeFile(OUT + "01-x.png", bytes)`. A write whose target is
 * assembled at runtime is REPORTED as unresolved rather than dropped in silence.
 */

/**
 * The call sites that can write into the tree. Reads are deliberately absent.
 *
 * `evidenceHelper` marks the repo's own evidence writers, whose CONTRACT is to
 * write an evidence slice: `writeEvidenceReadme({ dir: "audio-feed-xxxx" })`
 * names the slice and the helper resolves it, so a bare id there is a write
 * target. A generic `Deno.write*` gets no such credit - its target must resolve
 * into docs/evidence itself, which is what separates a write from a mention.
 */

import { argumentRange, maskNonCode } from "./source-mask.ts";
export const WRITE_CALLS: readonly {
  pattern: RegExp;
  evidenceHelper: boolean;
  /**
   * WHICH ARGUMENT CARRIES THE TARGET, PER DENO'S OWN SIGNATURES, and this is a
   * per-entry answer rather than a default (audio-feed-vex8, vac2's finding):
   *   Deno.writeTextFile(path, data)  -> 1
   *   Deno.writeFile(path, data)      -> 1
   *   Deno.mkdir(path)                -> 1
   *   Deno.copyFile(fromPath, toPath) -> 2   <-- the DESTINATION is what is written
   *   writeEvidenceReadme(options)    -> 1
   *   writeEvidencePng(options)       -> 1
   * "THE TARGET IS ARGUMENT 1" WAS NOT TRUE OF EVERY ENTRY IN THIS SET. copyFile's
   * target is its SECOND argument, so resolving argument 1 dropped an explicitly
   * listed write call ENTIRELY - a false negative on a WRITER, which is invisible,
   * where the mention false positives this file was built to fix are merely
   * over-reporting and visible. A test iterates THIS TABLE and asserts that every
   * entry has a sample (tests/evidence_census_test.ts), so a call cannot be added
   * here without its target argument being stated and exercised.
   *
   * CORRECTED TWICE, AND THE SECOND CORRECTION IS WHY THIS PARAGRAPH IS KEPT AT ALL
   * (audio-feed-vex8, after rev-46 retracted a PASS over it): this text first declared rename OUT
   * of the set with "eleven files call rename and ZERO of their destinations are under the evidence
   * prefix". That number came from a FOUR-LINE GREP CONTEXT WINDOW around each call, WHICH CANNOT
   * SEE a destination that arrives as a constant, a variable or a helper.
   *
   * RE-DERIVED FROM THE CODE, WITH THE METHOD NAMED SO IT CAN BE REPEATED: for each script calling
   * rename, take the second argument's raw text, substitute module-level constants defined in that
   * same file ONE LEVEL, then test for the evidence prefix. MEASURED: 7 OF THE 11 CALLERS rename
   * into evidence - csp-nonce-browser-proof, listen-browser-proof, tokens-browser-proof,
   * verify_3asd_bookmarklet_browser, verify_dfbu_pagehide_browser, verify_main_l7m1_e2e and
   * voice-audition-browser-proof. A twelfth file matches a textual scan and is THIS ONE: its own
   * header prose spells a rename call, so a CALL IN A COMMENT IS INPUT TO A SCANNER - the same
   * lesson as a path in a comment, and the thing that caught this paragraph being wrong.
   *
   * AND ONE CALLER IS AN EVIDENCE WRITER THE STATIC NUMBER DOES NOT COVER: the compressor renames
   * to its own `path` parameter, fed by an evidence enumeration at runtime, so it is not among the 7
   * and is a real rewriter all the same. rename is IN the table below with the same per-entry target
   * argument as copyFile.
   *
   * TWO INSTRUMENTS, TWO NUMBERS, AND THE REVIEW'S IS THE STRONGER ONE - SO IT IS CREDITED RATHER
   * THAN QUIETLY UNDERSHOT: the static method above yields 7 of 11; the review that found this
   * (audio-feed-t5lb) read the call sites and puts it at 10 of 11, with only observability-agent-poll
   * outside. The difference is exactly the destinations that arrive through a VARIABLE this method
   * does not resolve - which is why my number is a LOWER BOUND and is stated as one. THE SCOPE
   * ASSERTED HERE IS THEREFORE "AT LEAST 8 OF 11 STATICALLY DEMONSTRABLE, 10 OF 11 BY THE REVIEW'S
   * READING" - not zero, and not a number inherited from anyone.
   *
   * AND THE AGGREGATE COULD NOT HAVE CAUGHT ANY OF IT AND CANNOT CONFIRM THE FIX: writer
   * directories are 36 before and after, and the compressor is credited by nothing before and
   * after, because those scripts also write through other calls. A number that holds while a defect
   * is present is not a control - the per-site credit is.
   */
  targetArgument: number;
}[] = [
  { pattern: /\bwriteEvidenceReadme\s*\(/g, evidenceHelper: true, targetArgument: 1 },
  { pattern: /\bwriteEvidencePng\s*\(/g, evidenceHelper: true, targetArgument: 1 },
  { pattern: /\bDeno\.writeTextFile\s*\(/g, evidenceHelper: false, targetArgument: 1 },
  { pattern: /\bDeno\.writeFile\s*\(/g, evidenceHelper: false, targetArgument: 1 },
  { pattern: /\bDeno\.mkdir\s*\(/g, evidenceHelper: false, targetArgument: 1 },
  { pattern: /\bDeno\.copyFile\s*\(/g, evidenceHelper: false, targetArgument: 2 },
  // THE Sync FAMILY, ADDED BECAUSE MEASURING "THE REST OF THE SET" FOUND IT MISSING (there is one
  // writeTextFileSync call in the tree today, in a test whose target is not evidence, so no number
  // moves - but a script writing evidence synchronously was simply invisible to this predicate).
  { pattern: /\bDeno\.writeTextFileSync\s*\(/g, evidenceHelper: false, targetArgument: 1 },
  { pattern: /\bDeno\.writeFileSync\s*\(/g, evidenceHelper: false, targetArgument: 1 },
  { pattern: /\bDeno\.mkdirSync\s*\(/g, evidenceHelper: false, targetArgument: 1 },
  { pattern: /\bDeno\.copyFileSync\s*\(/g, evidenceHelper: false, targetArgument: 2 },
  // `Deno.rename(oldPath, newPath)` CREATES ITS SECOND ARGUMENT, so it is a write with the same shape as
  // copyFile - and it was previously declared OUT of this set on a wrong measurement (see above).
  { pattern: /\bDeno\.rename\s*\(/g, evidenceHelper: false, targetArgument: 2 },
];

/** The directory every evidence slice lives under. Required in a write target. */
export const EVIDENCE_PREFIX = "docs/evidence";

const ID_RE = /audio-feed-[a-z0-9]+/g;

/** Extract `audio-feed-<id>` tokens, or [] when the text carries none. */
export function idsIn(text: string): string[] {
  return [...new Set(text.match(ID_RE) ?? [])];
}

/** The properties of an evidence helper that NAME THE SLICE, from its own option types. */
const TARGET_PROPERTIES: readonly string[] = ["dir", "path"];

/**
 * THE PART OF A FIRST ARGUMENT THAT NAMES THE TARGET (audio-feed-vex8, and this is
 * the half a depth-aware comma scan ALONE gets wrong).
 *
 * An object literal names the slice through ONE property - `dir` in this
 * repository's helpers (`EvidenceReadmeOptions { dir: string; title: string;
 * script?: string; ... }`) - and its OTHER properties are PROSE: titles, bead ids
 * carried for cross-reference, notes. Scanning the whole object therefore credits a
 * script with writing beads it merely mentions, and that is measured rather than
 * argued: with the whole object as the target, 26 directories came back on the real
 * tree that the previous version had correctly excluded (audio-feed-0jp and
 * audio-feed-ktn from an account proof that writes audio-feed-8fc and merely lists
 * those two in `bead:`/`also:` fields, and 24 more of the same shape).
 *
 * So: an object literal resolves to the value of its target property, and anything
 * that is not an object literal is its own target. The list is the helpers' own
 * option names rather than a guess about shapes, and an object with no such property
 * falls back to the whole argument rather than to nothing - a MISS would be the
 * silent direction.
 */
export function targetWithin(masked: string, raw: string, start: number, end: number): string {
  const region = masked.slice(start, end);
  if (!region.trimStart().startsWith("{")) return raw.slice(start, end);
  const bodyStart = start + region.indexOf("{") + 1;
  let depth = 0;
  let propStart = bodyStart;
  const consider = (a: number, b: number): string | null => {
    const property = raw.slice(a, b);
    const name = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(property);
    if (!name) return null;
    const key = name[1] ?? name[2] ?? name[3] ?? "";
    if (!TARGET_PROPERTIES.includes(key)) return null;
    return property.slice(name[0].length);
  };
  for (let i = bodyStart; i <= end; i++) {
    const ch = masked[i] ?? "}";
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0) {
        const found = consider(propStart, i);
        if (found !== null) return found; // the object's own closing brace
        break;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      const found = consider(propStart, i);
      if (found !== null) return found;
      propStart = i + 1;
    }
  }
  return raw.slice(start, end);
}

/**
 * The balanced argument text of the call whose `(` is at `open` (the index of
 * the opening paren), or null when the parens never close. String and template
 * literals are skipped so a paren inside a string cannot end the call early.
 */
export function callArguments(source: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i++; i < source.length && source[i] !== quote; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Module-scope bindings whose value names an evidence directory. One level only:
 * `const OUT = <literal, or new URL(<literal>, import.meta.url).pathname>`.
 */
export function evidenceBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const re = /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*([^\n;]+)/gm;
  for (const match of source.matchAll(re)) {
    const name = match[1]!;
    const value = match[2]!;
    if (!value.includes(EVIDENCE_PREFIX)) continue;
    bindings.set(name, value);
  }
  return bindings;
}

/** Does `text` (with one level of identifier substitution) name an evidence dir? */
export function resolveTarget(
  text: string,
  bindings: Map<string, string>,
): { ids: string[]; text: string } {
  let resolvedText = text;
  for (const [name, value] of bindings) {
    if (new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(resolvedText)) {
      resolvedText += ` ${value}`;
    }
  }
  return { ids: idsIn(resolvedText), text: resolvedText };
}

export interface ScriptCensus {
  /** The evidence directories this script writes, in the order first seen. */
  writes: string[];
  /**
   * The `audio-feed-*` TOKENS the script merely names - a bead id in a header,
   * a localStorage key, a route - and never writes. Tokens rather than bead ids
   * on purpose: `audio-feed-token` and `audio-feed-positions` are keys, and both
   * shapes are mentions, so the field reports exactly what it matched.
   */
  mentions: string[];
  /** Write calls whose target is an evidence path with no literal id in reach. */
  runtimeAssembled: string[];
  /** audio-feed-t5lb: write calls whose target could not be resolved at all. */
  unresolvedWrites: string[];
}

/**
 * Census one script's SOURCE. `mentions` is the field that catches the four
 * false positives this bead was filed about: a script that names a directory
 * and writes nothing is a probe, not an evidence slice.
 */
/**
 * audio-feed-t9w1: WHICH WRITES MAY BE CREDITED AS EVIDENCE DIRECTORIES.
 *
 * `writers` is built from ids found in source, so an id named in a write call but with NO directory on
 * disk used to be credited as one - the false credit found on `verify_s3uk_real_browser.ts`. On the
 * real tree that no longer reproduces (measured: 36 credited, 0 without a directory), but the CENSUS
 * HAD NO CASE THAT WOULD DETECT THE FALSE CREDIT IF IT WERE REINTRODUCED - every one of its cases built
 * a real directory, so the predicate's false branch was never evaluated. That gap is independent of
 * whether the original red still fires, and it is what this function and its case close.
 *
 * Exported and pure so the decision can be tested WITHOUT a filesystem: the caller reads the disk, this
 * decides. Reverting it (crediting everything, as the pre-fix code did) is the mutation that must
 * redden the case - the mutant for this bead IS the old behaviour, so there is no edit to invent.
 */
export function splitCreditedWrites(
  writers: Record<string, string[]>,
  onDisk: Set<string>,
): { credited: Record<string, string[]>; writesWithoutDirectory: Record<string, string[]> } {
  const credited: Record<string, string[]> = {};
  const writesWithoutDirectory: Record<string, string[]> = {};
  for (const id of Object.keys(writers)) {
    if (onDisk.has(id)) credited[id] = writers[id]!;
    else writesWithoutDirectory[id] = writers[id]!;
  }
  return { credited, writesWithoutDirectory };
}

export function censusSource(source: string): ScriptCensus {
  const bindings = evidenceBindings(source);
  const writes: string[] = [];
  const runtimeAssembled: string[] = [];
  // audio-feed-t5lb: a write call whose target is NOT RESOLVED AT ALL is not the same fact as one
  // resolved to a non-evidence path, and the difference is the whole defect. `if (!inEvidence)` used
  // to send both through the same door, so a script whose destination arrives through a parameter or
  // helper was left with no write AND was then described as writing no evidence directory - a
  // positive claim about a real writer, produced by an absence of resolution. `scripts/evidence-compress.ts`
  // is that case (`compressOne` renames a palette-converted temp over its evidence PNG).
  const unresolvedWrites: string[] = [];

  // THE MASKED SOURCE IS WHAT IS SCANNED (audio-feed-ehon): a call written inside a comment or a
  // string is not a call site, and the raw source made both look like one.
  const masked = maskNonCode(source);
  for (const { pattern, evidenceHelper, targetArgument } of WRITE_CALLS) {
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      // ...and only the FIRST argument is the target. Every other argument is data, which is how a
      // payload naming docs/evidence made a script that writes to /tmp look like a writer. WITHIN
      // that argument, an object literal names the slice through its target property and its other
      // properties are prose (audio-feed-vex8) - see targetWithin.
      // THE TARGET ARGUMENT IS PER CALL SHAPE (audio-feed-vex8): copyFile writes its SECOND
      // argument, so assuming argument 1 dropped that write call entirely.
      const range = argumentRange(masked, open, targetArgument);
      if (range === null) continue;
      const targetText = targetWithin(masked, source, range.start, range.end);
      const target = resolveTarget(targetText, bindings);
      // A generic write must name docs/evidence. The evidence helpers may name
      // the slice directly, because naming it IS their contract.
      const inEvidence = target.text.includes(EVIDENCE_PREFIX) || evidenceHelper;
      if (!inEvidence) {
        // UNRESOLVED, NOT "ELSEWHERE": a bare identifier, or a template whose interpolation cannot
        // be resolved, names nothing at all - so this call is a write we cannot attribute rather than
        // a write to somewhere else. A literal path that simply is not under docs/evidence stays
        // silent, which is the legitimate case this branch must not start reporting.
        const bare = /^[A-Za-z_$][\w$]*$/.test(targetText.trim()) || targetText.includes("${");
        if (bare && target.ids.length === 0) unresolvedWrites.push(match[0].replace(/\s*\($/, ""));
        continue;
      }
      if (target.ids.length === 0) {
        if (targetText.includes(EVIDENCE_PREFIX) || evidenceHelper) {
          runtimeAssembled.push(match[0].replace(/\s*\($/, ""));
        }
        continue;
      }
      for (const id of target.ids) if (!writes.includes(id)) writes.push(id);
    }
  }

  // A mention counts only when the file names a directory somewhere that is NOT
  // one of the write targets - which is exactly the shape of the false positives.
  const mentioned = new Set<string>();
  for (const line of source.split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) { for (const id of idsIn(line)) mentioned.add(id); }
    else for (const id of idsIn(line)) mentioned.add(id);
  }
  const mentions = [...mentioned].filter((id) => !writes.includes(id));
  // Only reports a script that is ABOUT evidence: an unattributable write in a file that never names
  // an evidence directory is out of scope for this census, and saying so here keeps the bucket's
  // meaning the same as the mention-only bucket's.
  const unresolvedEvidenceWrites = mentions.length > 0 ? unresolvedWrites : [];
  return { writes, mentions, runtimeAssembled, unresolvedWrites: unresolvedEvidenceWrites };
}

export interface Census {
  /** evidence directory -> the scripts that write it. */
  writers: Record<string, string[]>;
  /** On-disk evidence directories that no script writes (debt worth knowing). */
  unwritten: string[];
  /** Scripts that NAME an evidence directory and write nothing (the probes). */
  namingButNotWriting: Record<string, string[]>;
  /** Every write call whose evidence target could not be resolved. */
  runtimeAssembled: Record<string, string[]>;
  /** audio-feed-t5lb: scripts with a write call whose target could not be resolved AT ALL - an
   *  unattributable write. Distinct from `namingButNotWriting`, which positively claims a script
   *  writes no evidence directory; a script here must NOT also be reported there. */
  unresolvedWrites: Record<string, string[]>;
  /** audio-feed-t9w1: ids a script NAMES as an evidence write target for which NO directory exists.
   *  These are NOT in `writers` - an id that is only ever named in source is not an evidence directory,
   *  and crediting it was the false positive found on `verify_s3uk_real_browser.ts`. Reported rather
   *  than dropped, because either it is a proof that has not run yet or a name that is not a directory. */
  writesWithoutDirectory: Record<string, string[]>;
}

const SCRIPT_RE = /^[A-Za-z0-9_.-]+\.ts$/;

/** Census the tree at `root`: what each script WRITES, not what it mentions. */
export async function census(root: string): Promise<Census> {
  const writers: Record<string, string[]> = {};
  const namingButNotWriting: Record<string, string[]> = {};
  const unresolvedWrites: Record<string, string[]> = {};
  const runtimeAssembled: Record<string, string[]> = {};

  for await (const entry of Deno.readDir(`${root}/scripts`)) {
    if (!entry.isFile || !SCRIPT_RE.test(entry.name)) continue;
    const relative = `scripts/${entry.name}`;
    const result = censusSource(await Deno.readTextFile(`${root}/${relative}`));
    for (const id of result.writes) (writers[id] ??= []).push(relative);
    // THE EXCLUSION IS THE POINT OF THIS CHANGE, not the new field: a script with an unattributable
    // WRITE must not be described as writing no evidence directory. Before this, `evidence-compress.ts`
    // was printed as MENTION-ONLY - a positive claim about a real writer - because its rename target
    // arrives through a function parameter and the resolver returned nothing.
    const unattributable = result.unresolvedWrites.length > 0;
    if (result.unresolvedWrites.length > 0) unresolvedWrites[relative] = result.unresolvedWrites;
    if (result.mentions.length > 0 && !unattributable) {
      namingButNotWriting[relative] = result.mentions;
    }
    if (result.runtimeAssembled.length > 0) runtimeAssembled[relative] = result.runtimeAssembled;
  }

  // audio-feed-t9w1: `writers` IS BUILT FROM SOURCE, so an id that appears in a write call but has NO
  // directory on disk was credited as an evidence directory. That is the false positive found on
  // `verify_s3uk_real_browser.ts`, where a BEAD ID IN SOURCE read as a directory: `writers` said the
  // repo had evidence `audio-feed-<id>` while nothing of the kind existed. The real set is read right
  // here and was only ever used in the OPPOSITE direction (dirs with no writer), so the two were never
  // intersected.
  //
  // THE FIX INTERSECTS AND THEN REPORTS, RATHER THAN FILTERING SILENTLY: a write naming an
  // id with no directory is either a proof that has not been run yet or a name that is not a
  // directory at all, and both are worth seeing. Dropping them quietly would fix the false
  // positive by hiding the information - the failure mode this census already avoids in
  // `unwritten` and `runtimeAssembled`, and the reason this bucket exists.
  const onDisk = new Set<string>();
  const unwritten: string[] = [];
  for await (const entry of Deno.readDir(`${root}/${EVIDENCE_PREFIX}`)) {
    if (!entry.isDirectory || !entry.name.startsWith("audio-feed-")) continue;
    onDisk.add(entry.name);
    if (!(entry.name in writers)) unwritten.push(entry.name);
  }
  const { credited, writesWithoutDirectory } = splitCreditedWrites(writers, onDisk);
  return {
    writers: credited,
    unwritten,
    namingButNotWriting,
    runtimeAssembled,
    unresolvedWrites,
    writesWithoutDirectory,
  };
}

function summarise(result: Census): void {
  const dirs = Object.keys(result.writers).sort();
  const scriptCount = new Set(Object.values(result.writers).flat()).size;
  console.log(`evidence directories with a writer: ${dirs.length}`);
  console.log(`scripts that write at least one evidence directory: ${scriptCount}`);
  console.log(`evidence directories on disk with NO writer: ${result.unwritten.length}`);
  for (const dir of result.unwritten.sort()) console.log(`  UNWRITTEN  ${dir}`);
  const probes = Object.keys(result.namingButNotWriting).sort();
  console.log(
    `scripts that mention an audio-feed-* token and write no evidence directory: ${probes.length}`,
  );
  for (const script of probes) {
    console.log(`  MENTION-ONLY  ${script}  ->  ${result.namingButNotWriting[script]!.join(", ")}`);
  }
  const unattributable = Object.keys(result.unresolvedWrites).sort();
  console.log(
    `scripts with a write call whose target could NOT be resolved (unattributable, not "elsewhere"): ${unattributable.length}`,
  );
  for (const script of unattributable) {
    console.log(`  UNATTRIBUTABLE  ${script}  ->  ${result.unresolvedWrites[script]!.join(", ")}`);
  }
  const phantom = Object.keys(result.writesWithoutDirectory).sort();
  console.log(
    `evidence ids NAMED as a write target with NO directory on disk: ${phantom.length}`,
  );
  for (const id of phantom) {
    console.log(`  NOT-A-DIRECTORY  ${id}  <-  ${result.writesWithoutDirectory[id]!.join(", ")}`);
  }
  const unresolved = Object.keys(result.runtimeAssembled).sort();
  console.log(`scripts with a runtime-assembled evidence target: ${unresolved.length}`);
  for (const script of unresolved) {
    console.log(`  UNRESOLVED  ${script}  ->  ${result.runtimeAssembled[script]!.join(", ")}`);
  }
}

if (import.meta.main) {
  const root = Deno.args.find((arg) => !arg.startsWith("--")) ?? ".";
  const result = await census(root);
  if (Deno.args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else summarise(result);
}
