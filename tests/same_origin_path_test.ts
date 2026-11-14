/**
 * audio-feed-fg18i — THREAT_MODEL.md register row 6, enforced in src/ instead of enumerated.
 *
 * THE GAP: three browser helpers take a path and hand it straight to `fetch()` — `api(path, options)`
 * in src/assets/admin.js, `send(method, path, body)` in src/routes/account.ts and `post(path, body)`
 * in PASSKEY_CLIENT (src/routes/shell.ts). None of them checked the argument, so a call site passing
 * `"//evil.example/x"`, `"https://evil.example/x"`, `"../x"` or `"x"` would issue that request from
 * the page: fetch() resolves its first argument against the document URL, so all four leave this
 * origin. Row 6 recorded the constraint and said nothing enforced it.
 *
 * THE FIX, in two halves — and why not the typed union of literal route strings the row offered as
 * the first option: two of the three helpers are declared INSIDE template literals (account.ts's
 * inline script, shell.ts's PASSKEY_CLIENT) and the third lives in a `.js` asset served as text. No
 * TypeScript compiler sees any of the three, so a union type on their signatures would have been
 * checked at exactly zero of the 40 real call sites. The union was available in principle and
 * useless in practice.
 *
 *   1. src/assets/same-origin-path.js is the single canonical guard, and all three wrappers run
 *      their caller's path through `assertSameOriginPath()` before `fetch()` sees it (the console
 *      module binds it as `requireSameOriginPath`, because there the served bytes are also evaluated
 *      as one function body). It is composed
 *      in front of admin.js by src/routes/assets.ts and inlined on the login and account pages as
 *      SAME_ORIGIN_PATH_CLIENT, so an escaping path THROWS at the call that produced it — including
 *      at call sites written later, which is what the row's "nothing enforces it" was really about.
 *   2. This suite derives the wrapper population AND every call site from source — no list of call
 *      sites, no line numbers — and fails naming file and line when a call site's path literal is
 *      not a single-slash same-origin route. A new call site is covered the moment it is written; a
 *      new wrapper is covered the moment it forwards a `path` parameter to fetch().
 *
 * Mutant (proved by hand in the bead's branch): adding `send("GET", "//evil.example/x")` to
 * src/routes/account.ts reddens the call-site row by name, at the line the call was added on. It is
 * NOT a type error and cannot be one — the call sits inside a template literal.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { stripComments } from "../scripts/test-selection.ts";
import { assetBody } from "../src/routes/assets.ts";
import { SAME_ORIGIN_PATH_CLIENT } from "../src/routes/shell.ts";

// ── The guard as the browser receives it ─────────────────────────────────────────────────────
/**
 * `SAME_ORIGIN_PATH_CLIENT` is the byte string the login and account pages inline, and a verbatim
 * slice of the file src/routes/assets.ts composes in front of the admin console module — so
 * evaluating this export evaluates the shipped code, not a copy of it.
 * `globalThis` is a parameter, so nothing the guard publishes leaks into this test process.
 */
function guardFromShippedSource(): (path: unknown) => string {
  const factory = new Function(
    "globalThis",
    `${SAME_ORIGIN_PATH_CLIENT}\nreturn assertSameOriginPath;`,
  ) as (scope: unknown) => (path: unknown) => string;
  return factory({});
}

Deno.test("audio-feed-fg18i: the shipped guard refuses every path that leaves the origin", () => {
  const guard = guardFromShippedSource();
  const refused = [
    "//evil.example/x", // network-path reference: a different host, same scheme
    "///evil.example/x",
    "https://evil.example/x", // an absolute URL is not this origin
    "http://evil.example/x",
    "../x", // relative: resolves against the current page
    "./x",
    "x", // no leading slash at all
    "",
    "/\\evil.example/x", // "\" is a path separator for http(s), so this is "//evil.example/x"
    "\\\\evil.example/x",
    "/\t/evil.example/x", // tabs and newlines are DELETED during URL parsing
    "/\n/evil.example/x",
    "/\r/evil.example/x",
    "/\u0000/x",
  ];
  for (const path of refused) {
    const error = assertThrows(() => guard(path), Error);
    assert(
      error.message.includes("single-slash same-origin route"),
      `the guard must name the invariant it refused ${
        JSON.stringify(path)
      } on, got: ${error.message}`,
    );
    assert(
      error.message.includes(JSON.stringify(path)),
      `the guard must quote the refused path ${JSON.stringify(path)}, got: ${error.message}`,
    );
  }
  // A non-string is a call-site defect too, and the same refusal covers it rather than letting
  // `undefined` reach fetch().
  for (const value of [42, null, undefined, {}, ["/api/ingest"]]) {
    assertThrows(() => guard(value), Error, "single-slash same-origin route");
  }
  const accepted = [
    "/",
    "/api/ingest",
    "/api/account/sources/a%2Fb",
    "/api/account/episodes/e1/retry",
    "/api/admin/users/u1/approve",
    "/api/account/discover-feed?x=1//y",
  ];
  for (const path of accepted) {
    assertEquals(
      guard(path),
      path,
      `${path} is a same-origin absolute route and must pass through`,
    );
  }
});

// ── The population, derived from source ─────────────────────────────────────────────────────
const SOURCE_FILE = /\.(?:ts|js)$/;

/** Every `.ts`/`.js` file the server ships: all of src/, plus main.ts. */
async function runtimeSourceFiles(): Promise<string[]> {
  const files: string[] = ["main.ts"];
  // The LITERAL root is load-bearing: scripts/test-selection.ts derives this suite's relation to the
  // "src/" tree from a readDir call whose argument is the directory name, and this suite must be
  // selected by a change to any file it scans. A parameterised read reaches the same files and
  // earns no relation, which would leave the scan unrun exactly when it matters.
  for await (const entry of Deno.readDir("src")) {
    const path = `src/${entry.name}`;
    if (entry.isDirectory) files.push(...await walkSourceTree(path));
    else if (entry.isFile && SOURCE_FILE.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function walkSourceTree(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) files.push(...await walkSourceTree(path));
    else if (entry.isFile && SOURCE_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

/** `text` split on commas that are not inside a string, a template literal or a bracket pair. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** The bound name of a parameter declaration (`path`, `path = "/"`, ...). */
function parameterName(declaration: string): string {
  return /^\s*([A-Za-z_$][\w$]*)/.exec(declaration)?.[1] ?? "";
}

/** The balanced `{...}` body that starts at or after `afterParams`. */
function bodyAfter(stripped: string, afterParams: number): string | null {
  const open = stripped.indexOf("{", afterParams);
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return stripped.slice(open, i + 1);
    }
  }
  return null;
}

interface PathForwardingFunction {
  /** the helper's name, as its call sites spell it */
  name: string;
  /** index of the `path` parameter in the declaration's parameter list */
  pathIndex: number;
  /** offset of the declaration in the file's stripped text */
  declarationIndex: number;
  body: string;
}

/**
 * Every function declaration in `stripped` that forwards a `path` PARAMETER into `fetch()`.
 *
 * That shape, not a list of three names, is the class: it is what makes a helper able to send the
 * request somewhere its caller chose. A same-named method that takes no path (`Router.post` in
 * src/router.ts) or a same-named client helper with a different signature (cwv.js's
 * `send(metric, value)`) is excluded by the shape, and a NEW forwarder is included by it.
 */
function pathForwardingFunctions(stripped: string): PathForwardingFunction[] {
  const found: PathForwardingFunction[] = [];
  const declaration =
    /(?:^|\n)[\t ]*(?:async[\t ]+)?function[\t ]+([A-Za-z_$][\w$]*)[\t ]*\(([^)]*)\)/g;
  for (let match = declaration.exec(stripped); match !== null; match = declaration.exec(stripped)) {
    const params = splitTopLevel(match[2]!).map(parameterName);
    const pathIndex = params.indexOf("path");
    if (pathIndex < 0) continue;
    const body = bodyAfter(stripped, match.index + match[0].length);
    if (body === null) continue;
    // `fetch(path, ...)`, with or without a wrapper call already around the path, is the shape:
    // the console module binds the guard as `requireSameOriginPath`, so the name in front of
    // `(path)` is not fixed — the tested property is that a step happens (or does not) between
    // the parameter and fetch's first argument.
    if (!/\bfetch\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\(\s*)?path\b/.test(body)) continue;
    found.push({ name: match[1]!, pathIndex, declarationIndex: match.index, body });
  }
  return found;
}

/**
 * The exported `const` whose template literal the declaration sits inside, if any.
 *
 * This is how a helper declared on a classic-script page becomes visible in another file: the
 * page module imports the STRING and interpolates it (`${PASSKEY_CLIENT}`), so neither the import
 * graph nor a single-file grep can find the call sites. The splice is derived here, so the
 * population is derived too.
 */
function enclosingExportedConst(stripped: string, declarationIndex: number): string | null {
  const declaration = /(?:^|\n)export const ([A-Z][A-Z0-9_]*) = /g;
  let enclosed: string | null = null;
  for (let match = declaration.exec(stripped); match !== null; match = declaration.exec(stripped)) {
    if (match.index >= declarationIndex) break;
    enclosed = match[1]!;
  }
  return enclosed;
}

interface PathForwardingWrapper extends PathForwardingFunction {
  /** the file the declaration lives in */
  file: string;
  /** files whose call sites can see this helper: the definition file, plus every page that splices it */
  population: string[];
}

async function deriveWrappers(): Promise<{
  wrappers: PathForwardingWrapper[];
  sources: Map<string, string>;
}> {
  const files = await runtimeSourceFiles();
  const sources = new Map<string, string>();
  for (const file of files) sources.set(file, await Deno.readTextFile(file));

  const wrappers: PathForwardingWrapper[] = [];
  for (const file of files) {
    const { stripped } = stripComments(sources.get(file)!);
    for (const found of pathForwardingFunctions(stripped)) {
      const population = [file];
      const spliced = enclosingExportedConst(stripped, found.declarationIndex);
      if (spliced !== null) {
        for (const [candidate, text] of sources) {
          if (candidate !== file && text.includes(`\${${spliced}}`)) population.push(candidate);
        }
      }
      wrappers.push({ ...found, file, population });
    }
  }
  return { wrappers: wrappers.sort((a, b) => a.name.localeCompare(b.name)), sources };
}

// ── Every call site, derived and checked ────────────────────────────────────────────────────
interface Violation {
  file: string;
  line: number | null;
  detail: string;
}

/**
 * 1-based line of `needle` in `source`, or null when it does not appear at all.
 *
 * `needle` is a call read out of the COMMENT-STRIPPED text, so a comment inside the argument list
 * makes it unfindable — null is reported rather than a guessed line, and the failure still names the
 * file and the call. When the same call text appears more than once, the first occurrence is the one
 * reported; every occurrence carries the same escaping argument.
 */
function lineOf(source: string, needle: string): number | null {
  const at = source.indexOf(needle);
  return at < 0 ? null : source.slice(0, at).split("\n").length;
}

/** The string-literal prefix a call site's path argument begins with, if it begins with one. */
function leadingLiteral(argument: string): string | null {
  const trimmed = argument.trim();
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\") {
      value += ch + (trimmed[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === quote) return value;
    if (quote === "`" && ch === "$" && trimmed[i + 1] === "{") return value;
    value += ch;
  }
  return null; // unterminated on one line: report it rather than guess
}

Deno.test("audio-feed-fg18i: every derived wrapper call site passes a single-slash same-origin path", async () => {
  const { wrappers, sources } = await deriveWrappers();

  // The population assertion first: a scan over an empty or shrunken set of wrappers passes
  // vacuously. Renaming or removing a wrapper is a THREAT_MODEL.md register row 6 change.
  assertEquals(
    wrappers.map((w) => w.name),
    ["api", "post", "send"],
    "the population of path-forwarding client wrappers changed. Row 6 of THREAT_MODEL.md names " +
      "api/send/post; if this is a rename or a removal, update that row to match, and if it is a " +
      "FOURTH wrapper, wire it through assertSameOriginPath() before it is admitted here.",
  );

  const guard = guardFromShippedSource();
  const violations: Violation[] = [];
  let callSites = 0;
  for (const wrapper of wrappers) {
    for (const file of wrapper.population) {
      const source = sources.get(file)!;
      const { stripped } = stripComments(source);
      // Call-shaped occurrences only. The lookbehind drops `Router.post(` and `.map(`; the quote
      // check drops prose that merely mentions the name ("… post(s) queued." — a string literal,
      // whose last non-space character before the word is a quote). Both helpers are declared in
      // files whose client code is TEMPLATE TEXT, so a span filter cannot make this distinction:
      // in those files the real call and the prose are both inside the template.
      const call = new RegExp(`(?<![\\w$.])${wrapper.name}\\s*\\(`, "g");
      for (let match = call.exec(stripped); match !== null; match = call.exec(stripped)) {
        const nameIndex = match.index;
        const before = stripped.slice(Math.max(0, nameIndex - 20), nameIndex);
        if (/(?:^|\W)(?:async\s+)?function\s*$/.test(before)) continue; // the declaration itself
        if (/["'`]$/.test(before.trimEnd())) continue; // prose inside a string, not a call
        const text = callText(stripped, nameIndex);
        if (text === null) continue; // unbalanced on one line: not a call this scan can read
        callSites++;
        const closeParen = text.lastIndexOf(")");
        const args = splitTopLevel(text.slice(text.indexOf("(") + 1, closeParen));
        const argument = args[wrapper.pathIndex]?.trim();
        const line = lineOf(source, text);
        if (argument === undefined) {
          violations.push({
            file,
            line,
            detail:
              `${text} passes no path argument (position ${wrapper.pathIndex} of ${wrapper.name})`,
          });
          continue;
        }
        if (argument.startsWith("assertSameOriginPath(")) continue;
        const literal = leadingLiteral(argument);
        if (literal === null) {
          violations.push({
            file,
            line,
            detail: `${text} — the path argument "${argument}" is not a literal, so no static ` +
              `check can see it: wrap it in assertSameOriginPath(...) instead`,
          });
          continue;
        }
        // The static rule IS the shipped rule: the literal prefix is handed to the guard the page
        // runs, so tightening the guard tightens this row with no second copy to keep in step.
        try {
          guard(literal);
        } catch {
          violations.push({
            file,
            line,
            detail: `${text} — the path literal ${JSON.stringify(literal)} is not a single-slash ` +
              `same-origin route, so fetch() would resolve it off this origin`,
          });
        }
      }
    }
  }

  assert(
    violations.length === 0,
    `${violations.length} wrapper call site(s) can escape the API base (THREAT_MODEL.md row 6, ` +
      `audio-feed-fg18i):\n` +
      violations
        .map((v) => `  ${v.file}${v.line === null ? "" : `:${v.line}`} — ${v.detail}`)
        .join("\n"),
  );

  // A floor, not an exact count: a NEW call site must be covered without editing anything, but a
  // scan that silently stopped finding the population must not pass. Row 6 records 40 sites
  // (16 api + 13 send + 11 post) at a0f55db1.
  assert(
    callSites >= 40,
    `the scan found ${callSites} wrapper call sites; row 6 of THREAT_MODEL.md records 40 ` +
      `(16 api + 13 send + 11 post) and this scan must see at least that population`,
  );
});

/**
 * The balanced call expression starting at `nameIndex`, read from `stripped` (comments gone).
 * Returns null when it does not balance before end of file, which is how a shape the scan cannot
 * read is reported rather than mis-measured.
 */
function callText(stripped: string, nameIndex: number): string | null {
  const open = stripped.indexOf("(", nameIndex);
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return stripped.slice(nameIndex, i + 1);
    }
  }
  return null;
}

// ── The wiring: one guard, three wrappers, two splice seams ─────────────────────────────────
Deno.test("audio-feed-fg18i: all three wrappers run their path through the guard, and every surface carries it", async () => {
  const { wrappers, sources } = await deriveWrappers();
  for (const wrapper of wrappers) {
    const guardCall = /\bfetch\s*\(\s*(assertSameOriginPath|requireSameOriginPath)\s*\(\s*path\s*\)/
      .exec(
        wrapper.body,
      );
    assert(
      guardCall !== null,
      `${wrapper.file} defines ${wrapper.name}() but its fetch() does not run the caller's path ` +
        `through the guard`,
    );
    if (guardCall[1] === "requireSameOriginPath") {
      // The console module cannot see the composed prefix's module scope, so it binds the guard off
      // globalThis — the same contract askConfirm uses, and the reason its local name differs.
      assert(
        /const requireSameOriginPath\s*=[\s\S]{0,200}?\(globalThis\)\.assertSameOriginPath/
          .test(sources.get(wrapper.file)!),
        `${wrapper.file} binds requireSameOriginPath from something other than ` +
          `globalThis.assertSameOriginPath`,
      );
    }
  }

  // The guard must be IN SCOPE where each wrapper's body runs: the console module gets it composed
  // in front, the classic-script pages get it inlined. Both are asserted against the bytes served,
  // not against the file on disk, so a broken splice fails here rather than at deploy.
  // The inline snippet is the marked REGION of the asset, not the whole file: the file's own
  // comments spell out attack shapes, and a page carrying those strings in a comment reddens the
  // open-redirect rows. What ships must still be the guard itself, and be shippable as a classic
  // script.
  assert(
    SAME_ORIGIN_PATH_CLIENT.includes("function assertSameOriginPath("),
    "SAME_ORIGIN_PATH_CLIENT must contain the guard, not an empty or re-scoped region",
  );
  assertEquals(
    /(^|\n)\s*(?:import|export)\b/.test(SAME_ORIGIN_PATH_CLIENT),
    false,
    "SAME_ORIGIN_PATH_CLIENT ships inside a classic <script>: import/export there is a SyntaxError",
  );
  const composed = assetBody("admin.js") ?? "";
  const guardAt = composed.indexOf(SAME_ORIGIN_PATH_CLIENT);
  assert(
    guardAt >= 0 && guardAt < composed.indexOf("async function api("),
    "the served admin.js module must carry the same-origin path guard IN FRONT of the console " +
      "code (src/routes/assets.ts composition), or api() calls an undefined global at the first " +
      "admin request",
  );
  assertEquals(
    composed.split(SAME_ORIGIN_PATH_CLIENT).length - 1,
    1,
    "the served admin.js must carry the guard exactly once",
  );
  for (const wrapper of wrappers) {
    for (const file of wrapper.population) {
      if (!file.endsWith(".ts")) continue;
      if (file === wrapper.file) continue; // the definition file holds the string, not the splice
      assert(
        sources.get(file)!.includes("${SAME_ORIGIN_PATH_CLIENT}"),
        `${file} runs ${wrapper.name}() inline but does not splice SAME_ORIGIN_PATH_CLIENT into ` +
          `its script, so the guard would be undefined in the browser`,
      );
    }
  }
});

Deno.test("audio-feed-fg18i: no src/ fetch() takes a bare `path` identifier, so an arrow-grown wrapper cannot hide", async () => {
  // The derivation above reads `function` DECLARATIONS. A wrapper written as an arrow
  // (`const api = (path) => fetch(path)`) would not be derived by name — but it would leave exactly
  // this trace: a fetch() whose first argument is the identifier `path`. Server-side fetches use
  // `url`/`blobUrl`, and every guarded wrapper reads `fetch(assertSameOriginPath(path)`, so the
  // whole-tree invariant is "zero", and a new arrow wrapper reddens here.
  const files = await runtimeSourceFiles();
  const offenders: string[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const { stripped } = stripComments(source);
    const unguarded = /\bfetch\s*\(\s*path\b/g;
    for (let match = unguarded.exec(stripped); match !== null; match = unguarded.exec(stripped)) {
      offenders.push(`${file}:${lineOf(source, match[0]) ?? "?"} ${match[0].trim()}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "a fetch() in src/ takes the bare identifier `path` — that is a wrapper that never ran its " +
      "path through assertSameOriginPath() (audio-feed-fg18i / THREAT_MODEL.md row 6)",
  );
});

Deno.test("audio-feed-fg18i: THREAT_MODEL.md row 6 names the enforcement this suite pins", async () => {
  const threatModel = await Deno.readTextFile(new URL("../THREAT_MODEL.md", import.meta.url));
  for (
    const anchor of [
      "src/assets/same-origin-path.js",
      "assertSameOriginPath",
      "tests/same_origin_path_test.ts",
    ]
  ) {
    assert(
      threatModel.includes(anchor),
      `THREAT_MODEL.md register row 6 must cite ${anchor}: the row's residual said nothing ` +
        `enforced the constraint, and this suite is what makes the new claim checkable`,
    );
  }
  assert(
    !threatModel.includes("nothing enforces that constraint today"),
    "row 6 still claims nothing enforces the single-slash path constraint; the guard and this " +
      "suite are that enforcement (drop the claim, or say which part of it remains)",
  );
});
