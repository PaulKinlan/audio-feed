/**
 * The call-arity counter, and the silent mistake it exists to kill.
 *
 * TWICE IN ONE NIGHT (2026-02), two separate counts of `until()` call arity were
 * wrong in the same way: a top-level-comma splitter reads a MULTI-LINE call whose
 * last argument carries a trailing comma as THREE arguments —
 *
 *     await until(
 *       `expr`,
 *       "desc",
 *     );
 *
 * has two arguments at runtime, but splitting on top-level commas yields three
 * spans, the last of them empty. One census published 101 two-argument sites
 * where the truth was 170, and one sweep plus its review both certified a file
 * as swept while eight unbounded calls remained. Every counter that caught this
 * lived in /tmp and died with the session, so the next person repeated it. This
 * file puts the counter IN THE REPO so the count is reproducible and the
 * trailing-comma rule is pinned by tests/call_arity_test.ts.
 *
 * COUNTING RULES (each pinned by a test):
 * 1. COMMENTS and the INTERIOR of string/template literals are masked first
 *    (maskNonCode), so a mention of the callee inside a comment or a string is
 *    never counted; argument text and positions come from the raw source.
 * 2. A CALL is the bare identifier `callee` followed, after optional whitespace
 *    (newlines included), by `(`. A mention not followed by `(` is not a call.
 *    An occurrence preceded by `.` or another identifier character (a member
 *    access like `obj.until(`, or `wait_until`) is a DIFFERENT function and is
 *    not counted.
 * 3. THE DECLARATION IS NOT A CALL: an occurrence whose preceding word is
 *    `function` (covering `async function until(a, b, c = 1)`) is skipped.
 * 4. TRAILING COMMA SAFE: the argument list is walked paren/bracket/brace-aware
 *    (commas inside nested calls, arrays, objects, template `${}` expressions
 *    and arrow bodies sit at depth > 0 and never split an argument). After the
 *    LAST top-level comma, a span that holds only whitespace before the closing
 *    paren is EMPTY — it is the trailing comma, not an argument. `f()` counts 0.
 * 5. An argument list that never closes (truncated source) is skipped and
 *    reported on stderr rather than guessed at.
 *
 * DECLARED LIMITS, because a counter with unstated holes is worse than none:
 * type-parameter instantiation `callee<T>(...)`, tagged templates on the callee,
 * and comma-operator arguments (`f((a, b), c)`) are not modelled — none appears
 * in this repository's call sites. Regex literals are not masked (maskNonCode's
 * own declared limit), so a callee name or a stray top-level comma inside a
 * regex could still confuse the walk; none in this repo does.
 */

import { maskNonCode } from "./source-mask.ts";

/** One call site: the 1-based line of the callee identifier and its argument count. */
export interface CallArity {
  line: number;
  argc: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count the arguments of the call whose `(` is at `open` in MASKED source, or
 * null when the parens never close. Depth-aware over (), [], {}; a comma is a
 * separator only at depth 0. The span after the last top-level comma that holds
 * only whitespace before `)` is the trailing comma and adds NO argument.
 */
function argcAt(masked: string, open: number): number | null {
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let commas = 0;
  let lastComma = -1;
  let close = -1;
  for (let i = open + 1; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === "(") parens++;
    else if (ch === ")") {
      if (parens === 0) {
        close = i;
        break;
      }
      parens--;
    } else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "," && parens === 0 && brackets === 0 && braces === 0) {
      commas++;
      lastComma = i;
    }
  }
  if (close < 0) return null;
  if (commas === 0) {
    return masked.slice(open + 1, close).trim() === "" ? 0 : 1;
  }
  // TRAILING COMMA RULE: a span that ends at the closing paren holding only
  // whitespace is EMPTY, not an argument (audio-feed arity bug, 2026-02).
  const last = masked.slice(lastComma + 1, close);
  return last.trim() === "" ? commas : commas + 1;
}

/** True when the identifier at `start` is the name of a declaration, not a call: the preceding word is `function`. */
function isDeclaration(masked: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /\s/.test(masked[i]!)) i--;
  let word = "";
  while (i >= 0 && /[\w$]/.test(masked[i]!)) {
    word = masked[i]! + word;
    i--;
  }
  return word === "function";
}

/**
 * Given source text and a callee name, return every CALL to it with its line and
 * argument count — trailing-comma safe, declaration- and comment/string-aware.
 * Order follows source order; line numbers are 1-based.
 */
export function callAritySites(source: string, callee: string): CallArity[] {
  const masked = maskNonCode(source);
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(callee)}(?![\\w$])`, "g");
  const sites: CallArity[] = [];
  for (const match of masked.matchAll(re)) {
    const nameAt = match.index!;
    let open = nameAt + callee.length;
    while (open < masked.length && /\s/.test(masked[open]!)) open++;
    if (masked[open] !== "(") continue; // a mention, not a call
    if (isDeclaration(masked, nameAt)) continue; // the declaration itself
    const argc = argcAt(masked, open);
    if (argc === null) {
      const line = source.slice(0, nameAt).split("\n").length;
      console.error(`call-arity: unterminated argument list at ${callee} line ${line}; skipped`);
      continue;
    }
    sites.push({ line: source.slice(0, nameAt).split("\n").length, argc });
  }
  return sites;
}

/** Expand CLI path arguments to .ts files: an existing file is used as-is, a directory is walked, a glob is matched against a walk rooted at its non-glob prefix. */
export async function resolveTargets(paths: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const raw of paths) {
    if (raw.includes("*") || raw.includes("?")) {
      const stem = raw.replace(/[*?].*$/, "");
      const rootDir = stem.includes("/") ? stem.slice(0, stem.lastIndexOf("/")) || "/" : ".";
      for await (
        const path of expandGlob(raw, rootDir === "/" ? "/" : rootDir)
      ) {
        found.add(path);
      }
      continue;
    }
    try {
      const stat = await Deno.stat(raw);
      if (stat.isFile) {
        found.add(raw);
        continue;
      }
      if (stat.isDirectory) {
        for await (const path of walkTs(raw)) found.add(path);
        continue;
      }
    } catch {
      // fall through to the named-error below
    }
    console.error(`call-arity: no such file or directory: ${raw}`);
  }
  return [...found].sort();
}

async function* walkTs(dir: string): AsyncIterable<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkTs(path);
    else if (entry.isFile && entry.name.endsWith(".ts")) yield path;
  }
}

/** Minimal glob over one tree: `**` crosses directories, `*` and `?` stay within one segment. Only what the CLI needs — no dependency added. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (const [i, part] of pattern.split("**").entries()) {
    if (i > 0) source += ".*";
    source += part.replace(
      /[.+^${}()|[\]\\*?]/g,
      (ch) => ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : `\\${ch}`,
    );
  }
  return new RegExp(`^${source}$`);
}

async function* expandGlob(pattern: string, rootDir: string): AsyncIterable<string> {
  const re = globToRegExp(pattern);
  for await (const path of walkTs(rootDir)) {
    if (re.test(path)) yield path;
  }
}

async function main(): Promise<void> {
  const args = [...Deno.args];
  const only2 = args.includes("--only-2arg");
  const rest = args.filter((a) => a !== "--only-2arg");
  if (only2) {
    const [callee, ...paths] = rest;
    if (!callee || paths.length === 0) {
      console.error(
        "usage: deno run --allow-read scripts/call-arity.ts --only-2arg <callee> <file|dir|glob>...",
      );
      Deno.exit(2);
    }
    const files = await resolveTargets(paths);
    let count = 0;
    for (const file of files) {
      const source = await Deno.readTextFile(file);
      for (const site of callAritySites(source, callee)) {
        if (site.argc === 2) {
          console.log(`${file}:${site.line}`);
          count++;
        }
      }
    }
    console.log(`# ${count} two-argument call(s) to ${callee} in ${files.length} file(s)`);
    return;
  }
  const [callee, ...paths] = rest;
  if (!callee || paths.length === 0) {
    console.error("usage: deno run --allow-read scripts/call-arity.ts <callee> <file|dir|glob>...");
    Deno.exit(2);
  }
  const files = await resolveTargets(paths);
  let total = 0;
  let twoArg = 0;
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    for (const site of callAritySites(source, callee)) {
      console.log(`${file}  ${callee}  ${site.argc}`);
      total++;
      if (site.argc === 2) twoArg++;
    }
  }
  console.log(
    `# ${total} call(s) to ${callee} in ${files.length} file(s), ${twoArg} two-argument`,
  );
}

if (import.meta.main) {
  await main();
}
