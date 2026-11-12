/**
 * audio-feed-amho — the PURE STRING HELPERS that the evidence census and its test suites
 * share, in a module that READS NOTHING.
 *
 * WHY THEY LIVE HERE RATHER THAN IN scripts/evidence-census.ts. The fast gate derives its
 * data-read relation by scanning a suite and, to a closure depth of 2, the modules it imports,
 * and it records a relation PER SUITE — so a suite that imports a pure utility from a module
 * which also WALKS DIRECTORIES inherits that module's DIRECTORY relations. maskNonCode() is a
 * string function with no filesystem behaviour whatsoever, but it used to live in the census,
 * so tests/chrome_profile_sweep_sites_test.ts was derived as an observer of docs/evidence/ and
 * of scripts/ and was selected for a changed evidence PNG or a changed shell runner it cannot
 * read. That over-selection is the SAFE direction and the gate's guard tolerates it BY NAME
 * (assertSelected's overSelection list) — which is how audio-feed-qmcf landed — but the
 * declaration was only ever needed because of the MODULE LAYOUT: a suite that imports from here
 * derives NOTHING and needs no declaration at all.
 *
 * MEASURED, and the measurement is why this file exists: with the helpers here,
 * tests/chrome_profile_sweep_sites_test.ts derives no relation of its own, and the
 * overSelection declaration that used to name it is removed in the same change
 * (audio-feed-amho). A utility that reads no file must not lend directory relations to its
 * importers.
 *
 * THE FUNCTIONS ARE MOVED VERBATIM — offsets, limits and behaviour unchanged — so the census
 * and its suites see byte-identical answers. Their own doc comments, below, carry the reasoning
 * that belongs to them.
 */

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
 * REGEX LITERAL is not recognised (telling `/` as regex from division needs a
 * previous-token rule, and a wrong guess would mask real code and LOSE a write,
 * which is the silent direction), and a template literal nested inside another
 * template's `${...}` is treated as code. The regex limit has a measured SHAPE
 * rather than a hypothesis (audio-feed-naplt): a pattern that ENDS in an escaped
 * slash pair - `\/` immediately followed by the closing delimiter - puts two
 * slashes adjacent, so the walk reads `//` as a comment start and blanks the REST
 * OF THAT LINE. The line this limit was MEASURED on (`src/ingest/url.ts`'s
 * protocol-relative test) was rewritten to spell the pair as `[/]{2}`, which matches
 * the same strings with no adjacency, and tests/source_mask_test.ts pins the misread
 * itself under a name that says DECLARED LIMIT. audio-feed-nl0cn rewrote the four
 * lines where the blanked tail is a DECISION rather than boilerplate - the
 * `articleUrl` linkback ternary in `src/routes/listen.ts` and the three `itemLink`
 * URL tests in `src/ingest/feed.ts` - the same way and for the same reason, and its
 * part 2 rewrote EVERY remaining site on the tree: twenty lines across fifteen files,
 * being `src/auth/sessions.ts`, `src/assets/listen-landing.js`, `scripts/call-arity.ts`,
 * `scripts/cors-repro.ts`, `scripts/evidence-selection.ts`, `scripts/fast-check.ts`,
 * `scripts/test-selection.ts` (five), and nine in `tests/` - `auth_routes_test.ts`,
 * `auth_login_options_limit_test.ts`, `contracts_test.ts`, `fast_check_test.ts`
 * (twice), `fast_gate_subset_test.ts`, `l7m1_proof_test.ts`, `listen_activity_test.ts`
 * and `synthesis_invocation_death_test.ts`. Each took the same one-line rewrite: the
 * escaped slash that sat before the closing delimiter becomes a character class -
 * `[/]` for one slash, `[/]{2}` for two, `[/][/]` where the pair is a `file:` scheme -
 * which matches the same strings with no adjacency. Equivalence was proven per pattern
 * against cases chosen for that pattern (protocol-relative, single-slash and
 * mixed-case for the URL-ish ones; unterminated, nested and empty for the comment
 * strippers), not asserted by inspection. THE SHAPE'S FOOTPRINT ON THIS TREE IS NOW
 * ZERO, and that is a MEASUREMENT rather than a claim: a scan that runs this walk and
 * keeps only the lines where the adjacency survives in CODE (a line inside a string, a
 * template body or a comment is blanked before the test, so it cannot survive) found
 * twenty such lines before and none after. TWO SHAPE-LOOKING LINES ARE NOT SITES, AND
 * ARE NAMED SO A LATER GREP DOES NOT RE-OPEN THEM AS DEBT: `src/routes/shell.ts`'s
 * `PASSKEY_CLIENT` carries the adjacency inside a TEMPLATE BODY, where this walk never
 * reads a comment start because the template branch consumes the body itself, and
 * `tests/source_mask_test.ts`'s DECLARED LIMIT row pins it inside a DOUBLE-QUOTED
 * STRING for the same reason. THAT ROW STAYS AND IS NOT DELETED: it pins the WALKER's
 * behaviour on the shape, not the tree's inventory, so emptying the tree does not
 * retire it - it is the tripwire for the limit itself, and if the walk ever learns
 * regex literals that row should go red and be replaced. Both limits are named here
 * rather than assumed away.
 *
 * THIS IS THE `blankLiterals: true` ARM of blankedSource(). audio-feed-anqjk
 * needed the other arm - comments blanked, literal BODIES kept - and one walk
 * with two outputs is what stops the two from drifting on quote state, which is
 * the part that took a bug to get right.
 */
export function maskNonCode(source: string): string {
  return blankedSource(source, true);
}

/**
 * The source with COMMENTS blanked and every string, template literal and
 * `${...}` expression left EXACTLY as written, at identical offsets (newlines are
 * kept, so line numbers survive).
 *
 * WHY THIS IS NOT maskNonCode(): maskNonCode() blanks literal BODIES as well, and
 * a route path IS a literal body - `new Request("https://host/login")` carries the
 * `/login` the route classifier is looking for inside a double-quoted string, so
 * masking that string erases the very token being classified. The two functions
 * disagree only on literal bodies; they must agree on everything else, which is
 * why they are the two arms of one walk rather than two implementations.
 *
 * WHAT IT IS FOR (audio-feed-anqjk): a whole-file comment strip with no quote
 * state - `replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*$/g, "")`, the shape this replaces -
 * reads the `//` in `https://` as a comment start and deletes the rest of the
 * line, INCLUDING the route path on it. tests/login_conditional_mediation_test.ts:269
 * dispatches `/login` as `app.fetch(new Request("https://audio.example.com/login"))`
 * and was classified mention-only for that reason alone.
 *
 * COMMENTS ARE BLANKED, NOT DELETED, so offsets and line structure survive and a
 * caller may still split on newlines or slice against the original. The DELIMITERS
 * themselves are left in place - `//` and `/*` `*\/` still read as a marker with
 * nothing after them, exactly as in maskNonCode() - and that is why a commented-out
 * dispatch stays out of the result: its text is spaces.
 *
 * DECLARED LIMITS, shared with maskNonCode() because it is the same walk: a REGEX
 * LITERAL is not recognised (a `//` inside one would be read as a comment start -
 * the miss direction for a classifier), a template literal nested inside another
 * template's `${...}` is treated as code, and an unterminated literal stops at the
 * newline. The measured instance of the regex limit is an escaped slash pair before
 * the closing delimiter, which blanks the rest of its line (audio-feed-naplt; every
 * site on this tree is rewritten now, and the count is the block above).
 */
export function blankCommentsOnly(source: string): string {
  return blankedSource(source, false);
}

/**
 * ONE walk over the source that knows which of code / line comment / block
 * comment / string / template it is in, and blanks only what the caller asked to
 * lose. `blankLiterals` is the whole difference between maskNonCode() and
 * blankCommentsOnly(); nothing else about the scan may depend on it.
 */
function blankedSource(source: string, blankLiterals: boolean): string {
  const out = source.split("");
  const mask = (from: number, to: number) => {
    for (let k = Math.max(0, from); k < Math.min(to, source.length); k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  // A literal BODY: blanked by maskNonCode(), kept verbatim by blankCommentsOnly().
  const body = (from: number, to: number) => {
    if (blankLiterals) mask(from, to);
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
      body(i + 1, stop);
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
          body(j, j + 1);
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
            body(j + 1, stop);
            j = stop + 1;
            continue;
          }
          if (d === "{") depth++;
          else if (d === "}") depth--;
          j++;
          continue;
        }
        body(j, j + 1);
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
