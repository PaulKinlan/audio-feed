import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@^1.0.10";
import {
  assertScriptTurnSeams,
  createGroundedScriptGenerator,
  DEFAULT_SCRIPT_MODEL,
  GroundedScriptError,
  SCRIPT_MAX_OUTPUT_TOKENS,
} from "../src/worker/script.ts";

const article = await Deno.readTextFile(
  new URL("../docs/evidence/audio-feed-gueb/article.txt", import.meta.url),
);
const speakers = [
  { name: "Alex", role: "expert" as const, voice: "Fenrir" },
  { name: "Sam", role: "curious_foil" as const, voice: "Puck" },
] as const;
const input = {
  article: { title: "History of the Internet", body: article },
  speakers: [...speakers] as [typeof speakers[0], typeof speakers[1]],
};
const PARTIAL_JSON =
  '{"researchSummary":"History of networks was shaped by policy.","counterarguments":["Technical lock-in"],"sources":[{"title":"Example","uri":"https://example.com"}],"turns":[{"speaker":"Sam","text":"Who funded the first networks?"},';
const batch = (
  from: number,
  count: number,
  override?: (turns: Array<{ id: number; speaker: string; text: string }>) => void,
) => {
  const turns = Array.from({ length: count }, (_, i) => ({
    id: from + i,
    speaker: (from + i) % 2 ? "Alex" : "Sam",
    text: `Evidence for turn ${from + i}: distinct sentence ${from + i}.`,
  }));
  override?.(turns);
  return JSON.stringify({
    researchSummary: from === 0
      ? "Networks evolved with public and private investment."
      : undefined,
    counterarguments: from === 0 ? ["Technical lock-in", "Alternative protocol designs"] : [],
    sources: [{ title: `Source ${from}`, uri: `https://declared.example/${from}` }],
    turns,
  });
};
function response(text: string, finishReason: string, uri: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        finishReason,
        content: { parts: [{ text }] },
        groundingMetadata: { groundingChunks: [{ web: { uri, title: uri } }] },
      }],
    }),
    { status: 200 },
  );
}

Deno.test("after: long article output continues as complete numbered JSON batches, preserving grounding and seams", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const answers = [
    response(PARTIAL_JSON, "MAX_TOKENS", "https://search.example/initial"),
    response(batch(0, 7), "STOP", "https://search.example/first"),
    response(batch(7, 7), "STOP", "https://search.example/second"),
  ];
  const generator = createGroundedScriptGenerator({
    apiKey: "fixture-key",
    fetchFn: ((url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url).split("?")[0]!, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(answers.shift()!);
    }) as typeof fetch,
  });
  const script = await generator(input);
  assertEquals(requests.length, 3);
  assertEquals(script.turns.length, 14);
  assertEquals(
    script.turns.map((t) => t.text),
    Array.from({ length: 14 }, (_, i) => `Evidence for turn ${i}: distinct sentence ${i}.`),
  );
  assertEquals(script.sources.map((s) => s.uri), [
    "https://search.example/initial",
    "https://search.example/first",
    "https://search.example/second",
    "https://declared.example/0",
    "https://declared.example/7",
  ]);
  assertEquals(script.counterarguments, ["Technical lock-in", "Alternative protocol designs"]);
  assertEquals(script.researchSummary, "Networks evolved with public and private investment.");
  const firstBody = requests[0]!.body;
  assertStringIncludes(requests[0]!.url, `${DEFAULT_SCRIPT_MODEL}:generateContent`);
  const params = firstBody.generationConfig as { temperature: number; maxOutputTokens: number };
  assertEquals(params, { temperature: 0.7, maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS });
  assert(requests.every((r) => JSON.stringify(r.body.generationConfig) === JSON.stringify(params)));
  assertEquals((requests[1]!.body.contents as Array<{ role: string }>).map((c) => c.role), [
    "user",
  ]);
  assertEquals((requests[2]!.body.contents as Array<{ role: string }>).map((c) => c.role), [
    "user",
    "model",
    "user",
  ]);
  assertEquals(
    requests.every((r) => JSON.stringify(r.body.tools) === JSON.stringify([{ googleSearch: {} }])),
    true,
  );
  assert(
    !JSON.stringify(requests[1]!.body).includes(PARTIAL_JSON),
    "incomplete JSON must never be stitched as a turn",
  );
  console.log(
    JSON.stringify({
      stage: "after",
      model: DEFAULT_SCRIPT_MODEL,
      sourceArticleChars: article.length,
      promptBytes: new TextEncoder().encode(
        (firstBody.contents as Array<{ parts: Array<{ text: string }> }>)[0]!.parts[0]!.text,
      ).length,
      maxOutputTokensPerCall: SCRIPT_MAX_OUTPUT_TOKENS,
      temperature: params.temperature,
      calls: requests.length,
      finishReasons: ["MAX_TOKENS", "STOP", "STOP"],
      completeTurnIds: "0..13",
      sourceCount: script.sources.length,
      provider: "mock-only",
    }),
  );
});

Deno.test("seam verification rejects missing, repeated or altered turn IDs and duplicate sentences", async () => {
  const correct = [{ id: 0, text: "First sentence", speaker: "Sam" }, {
    id: 1,
    text: "Second sentence",
    speaker: "Alex",
  }];
  assertScriptTurnSeams(correct, 2);
  for (
    const invalid of [
      [correct[0]!, { ...correct[1]!, id: 2 }],
      [correct[0]!, { ...correct[1]!, id: 0 }],
      [correct[0]!, { ...correct[1]!, text: " first   sentence " }],
    ]
  ) {
    const error = await assertRejects(
      () => Promise.resolve().then(() => assertScriptTurnSeams(invalid, 2)),
      GroundedScriptError,
    );
    assertStringIncludes(error.message, "seam");
  }
});

Deno.test("MAX_TOKENS always continues even when a partial response happens to parse as JSON", async () => {
  let count = 0;
  const generator = createGroundedScriptGenerator({
    apiKey: "fixture-key",
    fetchFn: (() => {
      count++;
      const text = count === 1 ? batch(0, 7) : count === 2 ? batch(0, 7) : batch(7, 7);
      return Promise.resolve(
        response(text, count === 1 ? "MAX_TOKENS" : "STOP", `https://search.example/${count}`),
      );
    }) as typeof fetch,
  });
  const script = await generator(input);
  assertEquals(count, 3);
  assertEquals(script.turns.length, 14);
});

Deno.test("repeated sentence across continued batches is rejected even with distinct ids", async () => {
  let count = 0;
  const generator = createGroundedScriptGenerator({
    apiKey: "fixture-key",
    fetchFn: (() => {
      count++;
      const text = count === 1 ? PARTIAL_JSON : count === 2 ? batch(0, 7) : batch(7, 7, (turns) => {
        turns[0]!.text = "Evidence for turn 6: distinct sentence 6.";
      });
      return Promise.resolve(
        response(text, count === 1 ? "MAX_TOKENS" : "STOP", `https://search.example/${count}`),
      );
    }) as typeof fetch,
  });
  const error = await assertRejects(() => generator(input), GroundedScriptError);
  assertStringIncludes(error.message, "duplicated sentence at turn id 7");
  assertEquals(count, 3);
});

Deno.test("continued batch missing an ID fails closed, not a shortened published script", async () => {
  let count = 0;
  const generator = createGroundedScriptGenerator({
    apiKey: "fixture-key",
    fetchFn: (() => {
      count++;
      const text = count === 1 ? PARTIAL_JSON : count === 2
        ? batch(0, 7, (turns) => {
          turns[4]!.id = 5;
        })
        : batch(7, 7);
      return Promise.resolve(
        response(text, count === 1 ? "MAX_TOKENS" : "STOP", `https://search.example/${count}`),
      );
    }) as typeof fetch,
  });
  const error = await assertRejects(() => generator(input), GroundedScriptError);
  assertStringIncludes(error.message, "missing or duplicated turn id 4");
  assertEquals(count, 2);
});

Deno.test("safety refusal never retries or stitches incomplete content", async () => {
  let calls = 0;
  const generator = createGroundedScriptGenerator({
    apiKey: "fixture-key",
    fetchFn: (() => {
      calls++;
      return Promise.resolve(response(PARTIAL_JSON, "SAFETY", "https://search.example/safety"));
    }) as typeof fetch,
  });
  const error = await assertRejects(() => generator(input), GroundedScriptError);
  assertStringIncludes(error.message, "SAFETY");
  assertEquals(calls, 1);
});
