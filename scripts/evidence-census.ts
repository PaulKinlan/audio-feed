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
 * but "the script WRITES one": an argument to a write call that resolves into
 * docs/evidence. A mention elsewhere in the file — a comment, a bead id, a
 * localStorage key, a route — is not evidence of a write, and a read is not a
 * write. An evidence slice is defined by what it COMMITS.
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
export const WRITE_CALLS: readonly { pattern: RegExp; evidenceHelper: boolean }[] = [
  { pattern: /\bwriteEvidenceReadme\s*\(/g, evidenceHelper: true },
  { pattern: /\bwriteEvidencePng\s*\(/g, evidenceHelper: true },
  { pattern: /\bDeno\.writeTextFile\s*\(/g, evidenceHelper: false },
  { pattern: /\bDeno\.writeFile\s*\(/g, evidenceHelper: false },
  { pattern: /\bDeno\.mkdir\s*\(/g, evidenceHelper: false },
  { pattern: /\bDeno\.copyFile\s*\(/g, evidenceHelper: false },
];

/** The directory every evidence slice lives under. Required in a write target. */
export const EVIDENCE_PREFIX = "docs/evidence";

const ID_RE = /audio-feed-[a-z0-9]+/g;

/** Extract `audio-feed-<id>` tokens, or [] when the text carries none. */
export function idsIn(text: string): string[] {
  return [...new Set(text.match(ID_RE) ?? [])];
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

  for (const { pattern, evidenceHelper } of WRITE_CALLS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const args = callArguments(source, open);
      if (args === null) continue;
      const target = resolveTarget(args, bindings);
      // A generic write must name docs/evidence. The evidence helpers may name
      // the slice directly, because naming it IS their contract.
      const inEvidence = target.text.includes(EVIDENCE_PREFIX) || evidenceHelper;
      if (!inEvidence) continue;
      if (target.ids.length === 0) {
        if (args.includes(EVIDENCE_PREFIX) || evidenceHelper) {
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
