import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.10";
import { assertTextSeams, runManagedTurns } from "../src/tts/limits.ts";

Deno.test("synthesis text seams preserve repeated words, punctuation and Unicode exactly", () => {
  assertTextSeams("One. One. 二！", ["One.", "One. 二！"]);
  assertThrows(
    () => assertTextSeams("One. One. 二！", ["One.", "二！"]),
    Error,
    "lost or duplicated",
  );
  assertThrows(
    () => assertTextSeams("One. One. 二！", ["One. One.", "One. 二！"]),
    Error,
    "lost or duplicated",
  );
  assertThrows(
    () => assertTextSeams("First word.", ["First", "ward."]),
    Error,
    "lost or duplicated",
  );
});

Deno.test("managed turns reject over-budget before spend and check completed-turn context", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      runManagedTurns({
        segments: ["a", "b", "c"],
        maxTurns: 2,
        request: async () => {
          calls++;
          return "x";
        },
        stitch: (parts) => parts.join(""),
      }),
    Error,
    "limit 2",
  );
  assertEquals(calls, 0);
  const result = await runManagedTurns({
    segments: ["a", "b"],
    maxTurns: 2,
    request: async (part, previous) => {
      calls++;
      return `${previous.length}:${part}`;
    },
    stitch: (parts) => parts.join("|"),
  });
  assertEquals(result, "0:a|1:b");
});

Deno.test("managed turns replace one output-limited turn without stitching its incomplete output", async () => {
  const sent: string[] = [];
  const result = await runManagedTurns({
    segments: ["alpha", "bravo"],
    maxTurns: 4,
    request: async (segment) => {
      sent.push(segment);
      if (segment === "bravo") throw new Error("MAX_TOKENS");
      return segment;
    },
    splitOnOutputLimit: (segment, error) =>
      segment === "bravo" && String(error).includes("MAX_TOKENS") ? ["bra", "vo"] : null,
    stitch: (parts) => {
      assertTextSeams("alphabravo", parts);
      return parts.join("");
    },
  });
  assertEquals(sent, ["alpha", "bravo", "bra", "vo"]);
  assertEquals(result, "alphabravo");
});
