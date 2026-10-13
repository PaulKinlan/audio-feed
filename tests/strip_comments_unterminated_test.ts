import { assert, assertEquals } from "@std/assert";
import { stripComments } from "../scripts/test-selection.ts";

/**
 * audio-feed-ywjz: an UNTERMINATED BLOCK COMMENT must WIDEN the selector, not narrow it.
 *
 * stripComments finds string literals so that text inside them is not mistaken for code. When the scan
 * reaches EOF still inside a block comment the file is ill-formed, and the old behaviour was to drop
 * everything from the `/*` to the end of the file out of `stripped` while KEEPING the string spans
 * found before it. Anything named after the unterminated comment - an import, a module path, a
 * referrer - was therefore invisible to the selector. A hidden module makes the selection NARROW and
 * can LOSE a suite that should have been selected; over-selection only costs gate time. That asymmetry
 * is why the ill-formed case has to be handled in the widening direction, and the measured instance
 * was a 54-character source collapsing to 1.
 *
 * THE REPAIR IS ASYMMETRIC, and that asymmetry is the whole finding: the exclusions made BEFORE the
 * unterminated comment STAND, and only the unparseable tail is included as code. Returning the whole raw
 * source instead - the first attempt at this fix - also un-strips well-formed prefix comments, and
 * because the derivation keeps the FIRST binding for a local name, a commented-out import can then
 * shadow the real one and the read is attributed to the decoy: a new narrowing traded for the old one.
 *
 * These rows are written so that they FAIL against the behaviour they replace rather than passing beside
 * it. The controls are on the other direction - an unterminated LINE comment is still dropped (it loses
 * nothing, because the dropped text is a comment rather than code), a well-formed file still records its
 * string spans, and a well-formed comment before the unterminated one stays stripped.
 */

const UNTERMINATED = `const before = "a string";
const gap = 1;
/* this block comment is never closed
const after = "another string";
export const tail = 42;
`;

Deno.test("audio-feed-ywjz: the tail after an unterminated block comment is not blanked", () => {
  const { stripped } = stripComments(UNTERMINATED);
  assert(
    stripped.includes("export const tail"),
    "code after an unterminated block comment must stay visible to the selector",
  );
  assert(
    stripped.includes("const after"),
    "a declaration after the unterminated comment must not be blanked",
  );
});

Deno.test("audio-feed-ywjz: an ill-formed file keeps the exclusions it made BEFORE the comment", () => {
  // THE FIRST VERSION OF THIS ROW WAS WRONG (review finding P1 against 2e10b31). It asserted
  // spans.length === 0 and stripped === source - "an ill-formed file excludes NOTHING" - and that
  // reading is unsafe: un-stripping a well-formed prefix comment can make a commented-out import
  // visible, and visibleConstantsFor() keeps the FIRST binding for a name, so the decoy shadows the real
  // one. The contract is asymmetric instead: exclusions made before the unterminated comment STAND, and
  // only the unparseable tail is included as code.
  const { stripped, spans } = stripComments(UNTERMINATED);
  assertEquals(
    spans.length,
    1,
    "the string literal before the unterminated comment stays excluded",
  );
  const [start, end] = spans[0]!;
  assert(
    UNTERMINATED.slice(start, end).includes("a string"),
    "that span must cover the string content it was recorded for",
  );
  assert(
    stripped.includes("export const tail"),
    "and the unparseable tail is still included rather than blanked",
  );
});

Deno.test("audio-feed-ywjz: control - an unterminated line comment is still dropped, which loses nothing", () => {
  const source = `export const kept = 1;\n// trailing comment with no newline`;
  const { stripped } = stripComments(source);
  assert(stripped.includes("export const kept"), "code before the comment must survive");
  assert(
    !stripped.includes("trailing comment"),
    "an unterminated LINE comment is a comment, so dropping it cannot hide code",
  );
});

Deno.test("audio-feed-ywjz: control - a well-formed file still records its string spans", () => {
  const source = `const a = "text";\nconst b = 2;\n`;
  const { stripped, spans } = stripComments(source);
  assertEquals(spans.length, 1, "a well-formed file must still exclude its string literals");
  const [start, end] = spans[0]!;
  // The contract is the SPAN, not an edit to the text: the string content stays in `stripped` and the
  // span is what tells the selector to treat that range as content rather than as code. My first
  // version of this row asserted the content was removed, which this scanner never did - caught by
  // running it rather than by reading it, which is the whole point of the exercise.
  assert(
    source.slice(start, end).includes("text"),
    "the recorded span must cover the string content",
  );
  assert(stripped.includes("const b = 2"), "code between and after strings must be preserved");
});

/**
 * THE P1 THE FIRST FIX MISSED (review finding on 2e10b31). Returning the WHOLE raw source for an
 * ill-formed file also un-strips every WELL-FORMED comment that preceded it. That matters because
 * visibleConstantsFor() keeps the FIRST binding for a local name - `!visible.has(localName)` in
 * scripts/test-selection.ts - so a commented-out import earlier in the file becomes visible, shadows
 * the real one, and the read is attributed to the decoy: a real relation LOST. Widening must apply
 * only to the part that could not be parsed; the parsed prefix stays parsed.
 *
 * This row fails against 2e10b31, which is exactly why it exists.
 */
Deno.test("audio-feed-ywjz: the prefix stays stripped, so a commented-out import cannot shadow a real one", () => {
  const source = `/* import { P } from "./decoy.ts"; */
import { P } from "./real.ts";
Deno.readTextFile(P);
/* this block comment is never closed
`;
  const { stripped } = stripComments(source);
  assert(
    !stripped.includes("decoy.ts"),
    "a WELL-FORMED comment before the unterminated one must stay stripped, or its import shadows the real one",
  );
  assert(stripped.includes('"./real.ts"'), "the real import must remain visible");
  assert(
    stripped.includes("Deno.readTextFile(P)"),
    "the tail after the unterminated comment must still be included",
  );
  assert(
    stripped.includes("never closed"),
    "the unparseable tail is code as far as the selector knows, so it is included rather than blanked",
  );
});

/**
 * THE SECOND P1 (review finding against 0b80453), and it is a DUPLICATION. At the unterminated block
 * comment the prefix is appended WITH a space (scripts/test-selection.ts, the CODE case) and `offset` was
 * not advanced there, so the EOF branch appended `source.slice(offset, i)` a second time - the whole
 * prefix, twice. The consequence is not cosmetic: resolveReadName() rejects multiple matching declarations,
 * so a duplicated `const P = ...` makes the real read relation unresolvable and it is LOST, and the second
 * copy of a string literal lies outside its recorded span, so it reads as code.
 *
 * INCLUDES ASSERTIONS CANNOT SEE THIS - a duplicated prefix still includes everything once - which is why
 * this row COUNTS occurrences. It fails against 0b80453 and passes after the offset fix.
 */
Deno.test("audio-feed-ywjz: the prefix before an unterminated comment is emitted exactly once", () => {
  const source = `const P = "docs/real.md";\nDeno.readTextFile(P);\n/* unfinished\n`;
  const { stripped } = stripComments(source);
  assertEquals(
    stripped.split("const P =").length - 1,
    1,
    "the declaration before the unterminated comment must appear EXACTLY once, or the relation is lost",
  );
  assertEquals(
    stripped.split("Deno.readTextFile(P)").length - 1,
    1,
    "a read before the unterminated comment must not be duplicated either",
  );
  assert(
    stripped.includes("unfinished"),
    "and the unparseable tail is still included as code",
  );
});

/**
 * audio-feed-dmrw: THE INVARIANT, ASSERTED AS AN EQUALITY ON A FIXTURE SMALL ENOUGH TO READ IT AGAINST.
 * Stated at the width of the evidence rather than at the width of the sentiment, which is the correction the
 * review of audio-feed-ywjz made:
 *
 *   EVERY BYTE THE STRIPPER INTENDS TO KEEP APPEARS EXACTLY ONCE, IN THE ORDER IT APPEARED, WITH NO KEPT
 *   REGION DROPPED, DUPLICATED, OR EXCLUDED BY A LATER MALFORMED REGION.
 *
 * COMMENT BYTES ARE OMITTED BY DESIGN and the unterminated block-comment opener becomes a single space, so
 * "the stripped result equals the input" is NOT the invariant - a row asserting that would FAIL AGAINST
 * CORRECT CODE. Three repairs to stripComments each closed one direction and opened another: BLANKING (the
 * rest of the file lost to EOF), SHADOWING (a commented-out import made visible, so it could shadow the real
 * one), and DUPLICATION (the prefix emitted twice). Each was an error in ONE of the words above.
 *
 * WHY AN EQUALITY AND NOT MORE membership or counting assertions: this row asserts the WHOLE STRING, because
 * membership and counting can each pass while the answer is wrong in a direction nobody has named yet. The
 * counting rows stay ALONGSIDE this one, and they fail differently: counting names WHICH direction broke,
 * equality catches drops, wrong exclusions, and whatever has no name yet.
 *
 * THE EXPECTED STRING BELOW WAS REASONED FROM THE CODE BEFORE IT WAS RUN, not pasted from what the function
 * returned - an expectation copied from behaviour proves only that the behaviour has not changed, which is
 * not what this row is for.
 */
Deno.test("audio-feed-dmrw: the stripped result EQUALS an explicit expected string, byte for byte", () => {
  const source = [
    `import { real } from "./real.ts";`,
    `// import { decoy } from "./decoy.ts";`,
    `const value = "docs/real.md";`,
    `Deno.readTextFile(value);`,
    `/* never closed`,
    `more code after the unterminated opener`,
  ].join("\n");

  const expected = [
    `import { real } from "./real.ts";`,
    ``,
    `const value = "docs/real.md";`,
    `Deno.readTextFile(value);`,
    // TWO SPACES, and the reason is worth keeping because it is the first thing this row caught: the
    // unterminated opener is replaced by ONE space, and the fixture's own `/* never closed` supplies a
    // second one after the delimiter. My reasoned expectation said one, the assertion said two, and that
    // is a discrepancy no membership or counting assertion in this file can see.
    `  never closed`,
    `more code after the unterminated opener`,
  ].join("\n");

  assertEquals(
    stripComments(source).stripped,
    expected,
    "every kept byte exactly once and in order: the line comment gone, the unterminated opener as ONE space, " +
      "the tail kept as code, and no line duplicated",
  );
});
