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
 * scanning a masked copy of the source — maskNonCode() below. Each is pinned by a
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
   * CORRECTED, AND THE CORRECTION IS KEPT BECAUSE THE ERROR IS INSTRUCTIVE (audio-feed-vex8,
   * rev-46 retracted a PASS over this): this paragraph PREVIOUSLY declared `Deno.rename` out of
   * the set, on the strength of a measurement that was WRONG - a four-line grep context window
   * around each call, which CANNOT SEE a destination that arrives as a variable, a constant or an
   * EVIDENCE_DIR-shaped helper. It reported "zero destinations in evidence"; the truth is ten of
   * the eleven non-comment callers rename INTO evidence, and one of them rewrites a selected
   * evidence PNG while the census credited it with no writer at all. A declared limit whose number
   * is wrong is worse than no declaration, because it reads as considered - so rename is now IN the
   * table with the same per-entry target argument as copyFile, and the wrong instrument is named
   * here rather than quietly deleted.
   *
   * AND THE AGGREGATE COULD NOT HAVE CAUGHT IT: the writer-directory count was 36 before the fix
   * and is 36 after it, because those proof scripts also write through other calls, so a headline
   * number that "held" held while a defect was present. The per-site credit is the control; the
   * total is not.
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

/**
 * The source with COMMENTS and the INTERIOR of string and template literals
 * replaced by spaces, at identical offsets (newlines are kept so line numbers
 * survive). audio-feed-ehon: a write call NAMED inside a comment or a string is
 * not a call, and the census used to scan the raw source, so a comment example
 * and a string example were both counted as writers.
 *
 * The offsets are preserved on purpose, because the argument text must be taken
 * from the RAW source: masking the first argument would erase the literal that
 * names the evidence directory. Masked text is for FINDING calls and for
 * counting brackets; raw text is for reading the target.
 *
 * DECLARED LIMIT, MEASURED (audio-feed-vex8), AND NOT FIXED HERE BECAUSE IT IS A
 * DIFFERENT THRESHOLD: a write target assembled from SEPARATE string segments has
 * no contiguous evidence prefix, so joining the prefix's own two segments with a
 * slice name as a first argument resolves its id but reads as a MENTION rather
 * than a write. Widening the prefix test to a concatenation of the argument's
 * literals would change this predicate's published counts (36 writer directories
 * on the tree at the time of writing), so it is a decision with its own
 * before/after rather than a by-product of a comma fix.
 *
 * AND THIS PARAGRAPH IS ITSELF EVIDENCE OF THAT CLASS, WHICH IS WHY IT NO LONGER
 * SPELLS THE PATH OUT: written with a literal `path.join` expression, the gate's
 * read relation RESOLVED it out of this comment, recorded this script - and so
 * every suite that imports it - as an observer of docs/evidence, and turned five
 * pinned assertions red in tests/fast_gate_subset_test.ts. A path in a comment is
 * a path to a scanner, exactly as a call in a comment was to the previous version
 * of this file: the same lesson from the other side.
 *
 * DECLARED LIMITS, because a masker with unstated holes is worse than none: a
 * REGEX LITERAL is not masked (telling `/` as regex from division needs a
 * previous-token rule, and a wrong guess would mask real code and LOSE a write,
 * which is the silent direction), and a template literal nested inside another
 * template's `${...}` is treated as code. Neither shape appears in this
 * repository's scripts, and both are named here rather than assumed away.
 */
export function maskNonCode(source: string): string {
  const out = source.split("");
  const mask = (from: number, to: number) => {
    for (let k = Math.max(0, from); k < Math.min(to, source.length); k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  const endOfQuoted = (start: number, quote: string): number => {
    for (let j = start + 1; j < source.length; j++) {
      const ch = source[j]!;
      if (ch === "\\") {
        j++;
        continue;
      }
      if (ch === quote || ch === "\n") return j; // an unterminated literal stops at the newline
    }
    return source.length;
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      const stop = nl < 0 ? source.length : nl;
      mask(i + 2, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const stop = close < 0 ? source.length : close + 2;
      mask(i + 2, close < 0 ? source.length : close);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const stop = endOfQuoted(i, ch);
      mask(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (ch === "`") {
      // Template: the literal parts are masked, `${ ... }` is CODE and is left alone.
      let j = i + 1;
      let depth = 0;
      while (j < source.length) {
        const d = source[j]!;
        if (d === "\\") {
          mask(j, j + 1);
          j += 2;
          continue;
        }
        if (depth === 0 && d === "`") break;
        if (depth === 0 && d === "$" && source[j + 1] === "{") {
          j += 2;
          depth = 1;
          continue;
        }
        if (depth > 0) {
          if (d === '"' || d === "'") {
            const stop = endOfQuoted(j, d);
            mask(j + 1, stop);
            j = stop + 1;
            continue;
          }
          if (d === "{") depth++;
          else if (d === "}") depth--;
          j++;
          continue;
        }
        mask(j, j + 1);
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * The text of the FIRST argument of the call whose `(` is at `open`, or null when
 * the parens never close. Masked text is used to count DEPTH (so a paren or comma
 * inside a string cannot end the call early) and the RAW text is returned, so the
 * literal naming the target survives.
 *
 * ONLY THE FIRST ARGUMENT, because that is the one that names the target:
 * `Deno.writeTextFile("/tmp/report.txt", "docs/evidence/audio-feed-abcd")` writes
 * outside the tree and merely MENTIONS the id in its payload (audio-feed-ehon).
 *
 * A COMMA IS A SEPARATOR ONLY AT ARGUMENT-LIST DEPTH 0 (audio-feed-vex8). The first
 * version counted `(` and `)` alone, so the comma BETWEEN PROPERTIES of an object
 * literal was read as the argument separator and the first argument was truncated
 * before the target: `writeEvidenceReadme({ title: "x", dir: "audio-feed-abcd" })`
 * lost its write while the same call with `dir` first kept it, which means the
 * predicate's answer depended on PROPERTY ORDER - a thing with no runtime meaning.
 * Counting `{`/`}` and `[`/`]` as well closes the CLASS rather than the instance: an
 * object, an array, a nested call and a nested object in the first argument all put
 * their commas at depth > 0, so no list of known bad shapes is needed and none is
 * used. Anything that is not a separator here is simply part of the target text.
 *
 * WHAT THIS STILL GETS WRONG, measured rather than assumed: a REGEX LITERAL is not
 * masked (see maskNonCode's declared limit), so a comma inside one - `/a{1,3}/` -
 * can still split an argument early; and an unterminated string literal stops at
 * the newline, so a call written after it on that line is masked away rather than
 * reported (a MISS, the silent direction, and it is why the masker's limits are
 * stated at all). A template `${ ... }` containing a comma is handled correctly,
 * because the masker leaves that expression as code and its braces are counted here.
 */
export function argumentRange(
  masked: string,
  open: number,
  index: number,
): { start: number; end: number } | null {
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let nth = 1;
  let start = open + 1;
  for (let i = open + 1; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === "(") parens++;
    else if (ch === ")") {
      if (parens === 0) return nth === index ? { start, end: i } : null;
      parens--;
    } else if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "," && parens === 0 && braces === 0 && brackets === 0) {
      if (nth === index) return { start, end: i };
      nth++;
      start = i + 1;
    }
  }
  return null;
}

/** The first argument, which is the target of every entry whose targetArgument is 1. */
export function firstArgument(masked: string, raw: string, open: number): string | null {
  const range = argumentRange(masked, open, 1);
  return range === null ? null : raw.slice(range.start, range.end);
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
}

/**
 * Census one script's SOURCE. `mentions` is the field that catches the four
 * false positives this bead was filed about: a script that names a directory
 * and writes nothing is a probe, not an evidence slice.
 */
export function censusSource(source: string): ScriptCensus {
  const bindings = evidenceBindings(source);
  const writes: string[] = [];
  const runtimeAssembled: string[] = [];

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
      if (!inEvidence) continue;
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
  return { writes, mentions, runtimeAssembled };
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
}

const SCRIPT_RE = /^[A-Za-z0-9_.-]+\.ts$/;

/** Census the tree at `root`: what each script WRITES, not what it mentions. */
export async function census(root: string): Promise<Census> {
  const writers: Record<string, string[]> = {};
  const namingButNotWriting: Record<string, string[]> = {};
  const runtimeAssembled: Record<string, string[]> = {};

  for await (const entry of Deno.readDir(`${root}/scripts`)) {
    if (!entry.isFile || !SCRIPT_RE.test(entry.name)) continue;
    const relative = `scripts/${entry.name}`;
    const result = censusSource(await Deno.readTextFile(`${root}/${relative}`));
    for (const id of result.writes) (writers[id] ??= []).push(relative);
    if (result.mentions.length > 0) namingButNotWriting[relative] = result.mentions;
    if (result.runtimeAssembled.length > 0) runtimeAssembled[relative] = result.runtimeAssembled;
  }

  const unwritten: string[] = [];
  for await (const entry of Deno.readDir(`${root}/${EVIDENCE_PREFIX}`)) {
    if (!entry.isDirectory || !entry.name.startsWith("audio-feed-")) continue;
    if (!(entry.name in writers)) unwritten.push(entry.name);
  }
  return { writers, unwritten, namingButNotWriting, runtimeAssembled };
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
