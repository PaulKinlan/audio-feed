import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@^1.0.10";
import {
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
const PARTIAL_JSON =
  '{"researchSummary":"History of networks was shaped by policy.","counterarguments":["Technical lock-in"],"sources":[{"title":"Example","uri":"https://example.com"}],"turns":[{"speaker":"Sam","text":"Who funded the first networks?"},';

Deno.test("before: long grounded script MAX_TOKENS leaves incomplete JSON and falls back", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const generator = createGroundedScriptGenerator({
    apiKey: "fixture-key",
    fetchFn: ((url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url).split("?")[0]!, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{
              finishReason: "MAX_TOKENS",
              content: { parts: [{ text: PARTIAL_JSON }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://source.example/1", title: "Source 1" } }],
              },
            }],
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch,
  });
  const error = await assertRejects(
    () =>
      generator({
        article: { title: "History of the Internet", body: article },
        speakers: [...speakers],
      }),
    GroundedScriptError,
  );
  assertStringIncludes(error.message, "not valid JSON");
  assertEquals(requests.length, 1);
  assertStringIncludes(requests[0]!.url, `${DEFAULT_SCRIPT_MODEL}:generateContent`);
  const config = requests[0]!.body.generationConfig as {
    temperature: number;
    maxOutputTokens: number;
  };
  assertEquals(config.maxOutputTokens, SCRIPT_MAX_OUTPUT_TOKENS);
  console.log(
    JSON.stringify({
      stage: "before",
      model: DEFAULT_SCRIPT_MODEL,
      formerMaxOutputTokens: 4096,
      currentMaxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      sourceArticleChars: article.length,
      promptBytes: new TextEncoder().encode(
        (requests[0]!.body.contents as Array<{ parts: Array<{ text: string }> }>)[0]!.parts[0]!
          .text,
      ).length,
      finishReason: "MAX_TOKENS",
      requestCount: requests.length,
      result: "incomplete JSON, fallback to static dialogue",
    }),
  );
});
