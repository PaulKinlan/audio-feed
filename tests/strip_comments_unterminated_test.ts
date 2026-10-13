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
 * These rows are written so that they FAIL against the blanking behaviour rather than passing beside
 * it. The last two are the controls: an unterminated LINE comment is still dropped (it loses nothing,
 * because the dropped text is a comment rather than code), and a well-formed file still has its string
 * spans, so the fix has not simply disabled the scanner.
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

Deno.test("audio-feed-ywjz: an ill-formed input excludes nothing at all", () => {
  const { stripped, spans } = stripComments(UNTERMINATED);
  assertEquals(
    spans.length,
    0,
    "an ill-formed file must not exclude spans: excluding nothing is the safe direction",
  );
  assertEquals(
    stripped,
    UNTERMINATED,
    "the ill-formed case must hand back the source unchanged rather than a partially blanked copy",
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
