/**
 * audio-feed-anqjk: the two ARMS of scripts/source-mask.ts's one walk.
 *
 * maskNonCode() blanks comments AND literal bodies; blankCommentsOnly() blanks
 * comments and keeps literal bodies verbatim. The difference exists because the
 * route classifier matches on a path INSIDE a string literal, while the evidence
 * census must not count a write named inside one. This suite pins the difference,
 * both directions, and the invariant that keeps the pair honest: the arms agree on
 * everything except literal bodies, and they preserve offsets.
 */
import { assert, assertEquals } from "@std/assert";
import { blankCommentsOnly, maskNonCode } from "../scripts/source-mask.ts";

const DISPATCH_WITH_PROTOCOL = 'await fetch(new Request("https://audio.example.com/books/1"));';

Deno.test("blankCommentsOnly keeps the contents of the literals maskNonCode blanks", () => {
  assertEquals(
    blankCommentsOnly(DISPATCH_WITH_PROTOCOL),
    DISPATCH_WITH_PROTOCOL,
    "a route URL inside a string must survive: the path is the token being classified",
  );
  assert(
    /^await fetch\(new Request\("\s+"\)\);$/.test(maskNonCode(DISPATCH_WITH_PROTOCOL)),
    "maskNonCode must still blank the literal body",
  );
  assert(
    !maskNonCode(DISPATCH_WITH_PROTOCOL).includes("audio.example.com"),
    "the host is gone from maskNonCode's projection, which is why it cannot classify a route",
  );
});

Deno.test("blankCommentsOnly blanks line and block comments", () => {
  // The DELIMITERS stay in place (maskNonCode has always left them); everything after
  // them is spaces, so nothing inside a comment can reach a scanner.
  const lineComment = '// await fetch(new Request("https://h/books/1"));\nx;';
  const lineBlanked = blankCommentsOnly(lineComment).split("\n");
  assertEquals(
    lineBlanked[0],
    "//" + " ".repeat(lineComment.split("\n")[0]!.length - 2),
    "a commented-out dispatch must survive only as spaces after its // delimiter",
  );
  assert(
    !lineBlanked[0]!.includes("books"),
    "the path inside a comment never reaches a classifier that reads this projection",
  );
  assertEquals(lineBlanked[1], "x;", "the line after a comment is untouched");
  const block = '/* fetch("https://h/books/1") */\nx;';
  const blockBlanked = blankCommentsOnly(block).split("\n");
  assert(blockBlanked[0]!.startsWith("/*") && blockBlanked[0]!.endsWith("*/"));
  assertEquals(
    blockBlanked[0]!.slice(2, -2).trim(),
    "",
    "a block comment is blanked between its delimiters",
  );
  assert(!blockBlanked[0]!.includes("books"), "nothing inside a block comment survives");
  assertEquals(blockBlanked[0]!.length, block.split("\n")[0]!.length, "at the same length");
});

Deno.test("blankCommentsOnly does not read a // inside a literal as a comment start", () => {
  const source = 'const url = "https://example.test/a//b";\nawait fetch(new Request(url));';
  assertEquals(
    blankCommentsOnly(source),
    source,
    "a `//` inside a string is not a comment, so nothing may be blanked",
  );
  const template =
    "const base = `https://example.test/x`;\nconst r = new Request(`${base}/books/1`);";
  assertEquals(
    blankCommentsOnly(template),
    template,
    "template literals, and the expressions inside them, are kept verbatim",
  );
});

Deno.test("blankCommentsOnly is not fooled by an apostrophe in prose", () => {
  const source = "// don't dispatch yet\n" + DISPATCH_WITH_PROTOCOL;
  assertEquals(
    blankCommentsOnly(source).split("\n")[1],
    DISPATCH_WITH_PROTOCOL,
    "the apostrophe in the comment must not open a string that swallows the dispatch",
  );
});

Deno.test("both arms preserve offsets and newlines, and blank non-code only", () => {
  const source = [
    '// a "comment" with a ` backtick',
    'const a = "literal // not a comment";',
    "const b = `t ${a} // still a literal`;",
    "await fetch(new Request(`${a}/books/1`));",
  ].join("\n");
  const blanked = blankCommentsOnly(source);
  const masked = maskNonCode(source);
  assertEquals(blanked.length, source.length, "blankCommentsOnly preserves offsets");
  assertEquals(masked.length, source.length, "maskNonCode preserves offsets");
  assertEquals(
    source.split("\n").length,
    blanked.split("\n").length,
    "line structure survives so a caller may split on newlines",
  );
  // The arms agree everywhere except literal bodies: every non-blank character
  // maskNonCode keeps must be identical in blankCommentsOnly.
  for (let i = 0; i < source.length; i++) {
    if (masked[i] !== " ") {
      assertEquals(blanked[i], masked[i], `the arms disagree outside a literal at offset ${i}`);
    }
  }
  assert(
    blanked.includes("/books/1"),
    "the dispatch path is visible to a classifier that reads blankCommentsOnly()",
  );
});

Deno.test("blankCommentsOnly is idempotent", () => {
  const source = 'const a = "https://h/books/1"; // trailing\n/* b */ x;';
  const once = blankCommentsOnly(source);
  assertEquals(blankCommentsOnly(once), once, "a second pass must change nothing");
  assertEquals(once.split("\n")[0]!.trimEnd(), 'const a = "https://h/books/1"; //');
});
