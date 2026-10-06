import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.10";
import {
  assertTextSeams,
  runManagedTurns,
  splitTextUnderByteBudget,
} from "../src/synthesis/limits.ts";

Deno.test("shared byte chunker keeps Unicode and paragraph boundaries under a caller-supplied cap", () => {
  const source = "First paragraph.\n\nSecond paragraph has 🚀 text.";
  const parts = splitTextUnderByteBudget(source, 24);
  assertTextSeams(source, parts);
  assertEquals(parts[0], "First paragraph.");
  assertEquals(parts.every((part) => new TextEncoder().encode(part).length <= 24), true);
});

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
        request: () => {
          calls++;
          return Promise.resolve("x");
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
    request: (part, previous) => {
      calls++;
      return Promise.resolve(`${previous.length}:${part}`);
    },
    stitch: (parts) => parts.join("|"),
  });
  assertEquals(result, "0:a|1:b");
});

Deno.test("generic output continuation carries validated partial text to next turn and checks seam", async () => {
  const result = await runManagedTurns({
    segments: ["first"],
    maxTurns: 2,
    request: (segment, completed) => {
      if (segment === "first") return Promise.reject(new Error("MAX_TOKENS"));
      assertEquals(completed, ["Once upon"]);
      return Promise.resolve(" a time.");
    },
    continueOnOutputLimit: () => ({ partial: "Once upon", next: ["continue"] }),
    stitch: (parts) => {
      assertTextSeams("Once upon a time.", parts);
      return parts.join("");
    },
  });
  assertEquals(result, "Once upon a time.");
});

Deno.test("managed turns replace one output-limited turn without stitching its incomplete output", async () => {
  const sent: string[] = [];
  const result = await runManagedTurns({
    segments: ["alpha", "bravo"],
    maxTurns: 4,
    request: (segment) => {
      sent.push(segment);
      if (segment === "bravo") return Promise.reject(new Error("MAX_TOKENS"));
      return Promise.resolve(segment);
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
