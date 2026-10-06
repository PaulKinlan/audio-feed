import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.10";
import { assertTextSeams, splitTextUnderByteBudget } from "../src/synthesis/limits.ts";
import { assertScriptTurnSeams, GroundedScriptError } from "../src/worker/script.ts";

Deno.test("mid-sentence word boundary re-stitches; missing or repeated character is detected", () => {
  const source = "The quick brown fox jumps over the lazy dog";
  const chunks = splitTextUnderByteBudget(source, 20);
  assert(chunks.length > 1);
  assert(chunks[0]!.endsWith("fox")); // no sentence-ending punctuation at this seam
  assertTextSeams(source, chunks);
  assertEquals(chunks.join(" "), source);
  assertThrows(
    () => assertTextSeams(source, [chunks[0]!.slice(0, -1), ...chunks.slice(1)]),
    Error,
    "lost or duplicated",
  );
  assertThrows(
    () => assertTextSeams(source, [chunks[0]! + "n", ...chunks.slice(1)]),
    Error,
    "lost or duplicated",
  );
});

Deno.test("mid-word code-point boundary re-stitches; missing or repeated code point is detected", () => {
  const source = "🚀".repeat(5);
  const chunks = splitTextUnderByteBudget(source, 8);
  assertEquals(chunks, ["🚀🚀", "🚀🚀", "🚀"]);
  assertEquals(chunks.join(""), source);
  assertTextSeams(source, chunks);
  assertThrows(
    () => assertTextSeams(source, [chunks[0]!, chunks[1]!.slice(0, -2), chunks[2]!]),
    Error,
    "lost or duplicated",
  );
  assertThrows(
    () => assertTextSeams(source, [chunks[0]! + "🚀", ...chunks.slice(1)]),
    Error,
    "lost or duplicated",
  );
});

Deno.test("empty text segment is rejected even if the other chunks cover the source", () => {
  assertTextSeams("Hello world", ["Hello ", "world"]);
  assertThrows(() => assertTextSeams("Hello world", ["Hello ", "", "world"]), Error, "empty");
  assertThrows(() => assertTextSeams("Hello world", ["Hello ", "  ", "world"]), Error, "empty");
});

Deno.test("numbered JSON seams catch missing or repeated turn IDs", () => {
  // JSON continuation regenerates complete numbered turns, never partial JSON fragments.
  // Mid-sentence and mid-word examples identify seams, but IDs cannot verify source characters.
  const turns = [
    { id: 0, speaker: "Sam", text: "The quick brown fox" },
    { id: 1, speaker: "Alex", text: "jumps over the fence." },
    { id: 2, speaker: "Sam", text: "Unbreakable" },
    { id: 3, speaker: "Alex", text: "word continues here." },
  ];
  assertScriptTurnSeams(turns, 4);
  for (const omitted of [1, 3]) {
    assertThrows(
      () => assertScriptTurnSeams(turns.filter((turn) => turn.id !== omitted), 4),
      GroundedScriptError,
      "has 3 of 4 turns",
    );
    assertThrows(
      () =>
        assertScriptTurnSeams([
          ...turns.slice(0, omitted + 1),
          turns[omitted]!,
          ...turns.slice(omitted + 1),
        ], 5),
      GroundedScriptError,
      `missing or duplicated turn id ${omitted + 1}`,
    );
  }
});

Deno.test("numbered JSON seam rejects an empty or whitespace-only turn", () => {
  const turns = [
    { id: 0, speaker: "Sam", text: "Before" },
    { id: 1, speaker: "Alex", text: "After" },
  ];
  assertScriptTurnSeams(turns, 2);
  for (const text of ["", "  "]) {
    assertThrows(
      () => assertScriptTurnSeams([turns[0]!, { ...turns[1]!, text }], 2),
      GroundedScriptError,
      "script seam empty",
    );
  }
});
