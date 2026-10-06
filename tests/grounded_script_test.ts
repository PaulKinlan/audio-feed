/**
 * audio-feed-yaz5 — the pre-TTS grounded script stage.
 *
 * Two kinds of test, for the same reason tests/default_voice_test.ts has two: the unit cases
 * prove the request and the parser, and the case at the bottom proves the CALL SITE — that a
 * deep dive reaches the TTS request with the researched turns, that direct narration never
 * pays for a research call, and that a refused research call still produces an episode.
 * A helper tested in isolation while its call site went unexamined is the trap this project
 * has hit before (audio-feed-agl, audio-feed-2np).
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import {
  buildScriptPrompt,
  createGroundedScriptGenerator,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_SCRIPT_MODEL,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  GroundedScriptError,
  parseGroundedScript,
  SCRIPT_MAX_OUTPUT_TOKENS,
  textFromResponse,
} from "../src/worker/script.ts";
import { createGeminiSynthesizer } from "../src/worker/synthesis.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import type { AppContext } from "../src/app.ts";
import { makeArticle, makeEpisode, makeSource } from "./fixtures.ts";

const SPEAKERS = [
  { name: "Alex", role: "expert", voice: "Kore" },
  { name: "Sam", role: "curious_foil", voice: "Puck" },
] as const;

const ARTICLE = {
  title: "The Case Against Silent Defaults",
  author: "A. Writer",
  summary: "Defaults decide more than debate does.",
  body: "The article argues that defaults do the deciding, with three worked examples.",
};

function geminiResponse(text: string, sources: { uri: string; title?: string }[] = []) {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { parts: [{ text }] },
        groundingMetadata: {
          groundingChunks: sources.map((source) => ({
            web: { uri: source.uri, title: source.title ?? source.uri },
          })),
        },
      }],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

const VALID_SCRIPT = JSON.stringify({
  researchSummary: "Defaults are sticky; the literature is mixed on how sticky.",
  counterarguments: [
    "Choice architecture can be reversed as easily as it is applied.",
    "The worked examples are all consumer products, not policy.",
  ],
  sources: [{ title: "Model claim", uri: "https://model.example/claim" }],
  turns: [
    { speaker: "Sam", text: "Is the default really doing the work here?" },
    { speaker: "Alex", text: "According to the field study, yes — reversal cut uptake by half." },
  ],
});

// ─── the prompt is the product ───────────────────────────────────────────────

Deno.test("script prompt: demands research, sources and counterarguments before writing turns", () => {
  const prompt = buildScriptPrompt({ article: ARTICLE, speakers: [...SPEAKERS] });
  assertStringIncludes(prompt, "Research the subject with Google Search");
  assertStringIncludes(prompt, "counterarguments");
  assertStringIncludes(prompt, "primary documents");
  assertStringIncludes(prompt, "Alex");
  assertStringIncludes(prompt, "Sam");
  // The output contract is the last thing in the prompt; a parser depends on it being there.
  assertStringIncludes(prompt, '"turns"');
  assertStringIncludes(prompt, '"counterarguments"');
});

Deno.test("script prompt: a long article is bounded, and the contract still survives the bound", () => {
  const huge = { ...ARTICLE, body: "x".repeat(DEFAULT_MAX_BODY_CHARS * 3) };
  const prompt = buildScriptPrompt({ article: huge, speakers: [...SPEAKERS] });
  assert(
    prompt.length < DEFAULT_MAX_BODY_CHARS + 4_000,
    `prompt was not bounded: ${prompt.length} characters`,
  );
  // Truncating the whole prompt instead of the body would cut this off — the failure mode this
  // test exists for, because a prompt without the contract gets a prose answer nobody can parse.
  assertStringIncludes(prompt, '"researchSummary"');
});

// ─── the request ─────────────────────────────────────────────────────────────

Deno.test("script request: grounding is requested and the model is named in the URL", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  const generator = createGroundedScriptGenerator({
    apiKey: "test-key",
    fetchFn: (input, init) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body ?? "{}"));
      return Promise.resolve(geminiResponse(VALID_SCRIPT, [{ uri: "https://search.example/a" }]));
    },
  });
  await generator({ article: ARTICLE, speakers: [...SPEAKERS] });
  assertStringIncludes(seenUrl, `${DEFAULT_SCRIPT_MODEL}:generateContent`);
  assertEquals(seenBody.tools, [{ googleSearch: {} }]);
  assertEquals(
    (seenBody.generationConfig as { maxOutputTokens: number }).maxOutputTokens,
    SCRIPT_MAX_OUTPUT_TOKENS,
  );
  assertEquals(SCRIPT_MAX_OUTPUT_TOKENS, 16_384);
  const contents = seenBody.contents as { parts: { text: string }[] }[];
  assertStringIncludes(contents[0]?.parts[0]?.text ?? "", "counterarguments");
});

Deno.test("script request: a refused call is a typed error carrying the status", async () => {
  const generator = createGroundedScriptGenerator({
    apiKey: "test-key",
    fetchFn: () =>
      Promise.resolve(new Response("quota", { status: 429, statusText: "Too Many Requests" })),
  });
  const error = await assertRejects(
    () => generator({ article: ARTICLE, speakers: [...SPEAKERS] }),
    GroundedScriptError,
  );
  assertEquals(error.status, 429);
});

Deno.test("script generator: constructing without an API key is refused up front", () => {
  let threw = false;
  try {
    createGroundedScriptGenerator({ apiKey: "" });
  } catch (error) {
    threw = error instanceof GroundedScriptError;
  }
  assert(threw, "a keyless generator would fail once per episode instead of once per process");
});

// ─── the parser ──────────────────────────────────────────────────────────────

Deno.test("script parsing: fenced JSON surrounded by prose still parses", () => {
  const script = parseGroundedScript(
    `Here is the script you asked for:\n\`\`\`json\n${VALID_SCRIPT}\n\`\`\`\n`,
  );
  assertEquals(script.turns.length, 2);
  assertEquals(script.turns[0]?.speaker, "Sam");
  assertEquals(script.counterarguments.length, 2);
});

Deno.test("script parsing: unusable answers are errors, never half a dialogue", () => {
  const cases: [string, string][] = [
    ["prose only", "I cannot write that script."],
    ["broken JSON", '{"turns": [}'],
    ["one turn", JSON.stringify({ turns: [{ speaker: "Sam", text: "Alone?" }] })],
  ];
  for (const [name, text] of cases) {
    let threw = false;
    try {
      parseGroundedScript(text);
    } catch (error) {
      threw = error instanceof GroundedScriptError;
    }
    assert(threw, `${name} should have been refused`);
  }
});

Deno.test("script parsing: grounding metadata outranks the model's own source list, deduped", async () => {
  const generator = createGroundedScriptGenerator({
    apiKey: "test-key",
    fetchFn: () =>
      Promise.resolve(
        geminiResponse(VALID_SCRIPT, [
          { uri: "https://search.example/a", title: "Search hit A" },
          { uri: "https://search.example/a", title: "Search hit A again" },
          { uri: "https://search.example/b" },
        ]),
      ),
  });
  const script = await generator({ article: ARTICLE, speakers: [...SPEAKERS] });
  assertEquals(script.sources.map((source) => source.uri), [
    "https://search.example/a",
    "https://search.example/b",
    "https://model.example/claim",
  ]);
  assertEquals(script.sources[0]?.title, "Search hit A");
});

Deno.test("script parsing: a response with no text is an error", async () => {
  const generator = createGroundedScriptGenerator({
    apiKey: "test-key",
    fetchFn: () =>
      Promise.resolve(new Response(JSON.stringify({ candidates: [] }), { status: 200 })),
  });
  await assertRejects(
    () => generator({ article: ARTICLE, speakers: [...SPEAKERS] }),
    GroundedScriptError,
  );
  assertEquals(textFromResponse({ candidates: [] }), "");
});

// ─── the call site (the part that makes the stage real) ──────────────────────

interface SynthesisCall {
  turns?: { speaker: string; text: string }[];
  article?: { body: string };
}

function harness(options: { scriptGenerator: unknown; scriptTimeoutMs?: number }) {
  const calls: SynthesisCall[] = [];
  const client = {
    synthesizeDialogue: (input: SynthesisCall) => {
      calls.push(input);
      return Promise.resolve(
        { bytes: new Uint8Array(), mimeType: "audio/wav" } as unknown as DecodedAudioResult,
      );
    },
    synthesizeNarration: (input: SynthesisCall) => {
      calls.push(input);
      return Promise.resolve(
        { bytes: new Uint8Array(), mimeType: "audio/wav" } as unknown as DecodedAudioResult,
      );
    },
  };
  const ctx = {
    config: { geminiApiKey: "test-key" },
    stores: memoryStores(),
  } as unknown as AppContext;
  const synthesize = createGeminiSynthesizer(ctx, {
    client: client as never,
    // deno-lint-ignore no-explicit-any
    scriptGenerator: options.scriptGenerator as any,
    scriptTimeoutMs: options.scriptTimeoutMs,
  });
  return { calls, synthesize };
}

Deno.test("synthesis: a deep dive reaches the TTS request with the researched turns", async () => {
  let researchCalls = 0;
  const { calls, synthesize } = harness({
    scriptGenerator: () => {
      researchCalls++;
      return Promise.resolve({
        turns: [
          { speaker: "Sam", text: "Where does the evidence actually come from?" },
          { speaker: "Alex", text: "From the two studies I just searched for." },
        ],
        sources: [{ title: "Study", uri: "https://search.example/study" }],
        counterarguments: ["The sample was small."],
        researchSummary: "Mixed evidence.",
      });
    },
  });
  await synthesize({
    article: makeArticle({ title: ARTICLE.title, content: ARTICLE.body, excerpt: ARTICLE.summary }),
    source: makeSource({ voices: { deepdive: ["Kore", "Puck"] } }),
    episode: makeEpisode({}),
    mode: "deepdive",
  });
  assertEquals(researchCalls, 1);
  assertEquals(calls[0]?.turns?.length, 2);
  assertEquals(calls[0]?.turns?.[0]?.text, "Where does the evidence actually come from?");
});

Deno.test("synthesis: direct mode never pays for the research call", async () => {
  let researchCalls = 0;
  const { calls, synthesize } = harness({
    scriptGenerator: () => {
      researchCalls++;
      return Promise.resolve({
        turns: [],
        sources: [],
        counterarguments: [],
        researchSummary: "",
      });
    },
  });
  await synthesize({
    article: makeArticle({ title: "Direct", content: "Body." }),
    source: makeSource({ voices: {} }),
    episode: makeEpisode({}),
    mode: "direct",
  });
  assertEquals(researchCalls, 0);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.turns, undefined);
});

Deno.test("synthesis: a refused research call still produces an episode, with the static dialogue", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const { calls, synthesize } = harness({
      scriptGenerator: () => Promise.reject(new GroundedScriptError("search is down")),
    });
    await synthesize({
      article: makeArticle({ title: "Fallback", content: "Body." }),
      source: makeSource({ voices: { deepdive: ["Kore", "Puck"] } }),
      episode: makeEpisode({}),
      mode: "deepdive",
    });
    assertEquals(calls.length, 1, "the TTS call must still happen");
    assertEquals(calls[0]?.turns, undefined, "no researched turns means the static builder runs");
    assert(
      warnings.some((line) =>
        line.includes("grounded script stage failed") && line.includes("search is down")
      ),
      `expected the fallback reason to be logged, saw: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("synthesis: the stage can be switched off explicitly", async () => {
  let researchCalls = 0;
  // The first harness proves the injected generator would run; the second, built with `null`,
  // must not reach it at all.
  const { calls } = harness({
    scriptGenerator: () => {
      researchCalls++;
      return Promise.resolve({ turns: [], sources: [], counterarguments: [], researchSummary: "" });
    },
  });
  const ctx = {
    config: { geminiApiKey: "test-key" },
    stores: memoryStores(),
  } as unknown as AppContext;
  const off = createGeminiSynthesizer(ctx, {
    scriptGenerator: null,
    client: {
      synthesizeDialogue: (input: SynthesisCall) => {
        calls.push(input);
        return Promise.resolve(
          { bytes: new Uint8Array(), mimeType: "audio/wav" } as unknown as DecodedAudioResult,
        );
      },
    } as never,
  });
  await off({
    article: makeArticle({ title: "Off", content: "Body." }),
    source: makeSource({ voices: { deepdive: ["Kore", "Puck"] } }),
    episode: makeEpisode({}),
    mode: "deepdive",
  });
  assertEquals(researchCalls, 0);
  assertEquals(calls.at(-1)?.turns, undefined);
});

// ─── the real endpoint, when a key is present ────────────────────────────────
// The mock cases above prove the contract; this one proves the contract is not a fiction about
// the API. It is opt-in because it costs money and a network round trip, and it is skipped
// loudly rather than silently so a green run never implies it ran.
const LIVE_API_KEY = Deno.env.get("GEMINI_API_KEY");

Deno.test("live: a real grounded call returns dialogue and real search sources", async () => {
  if (!LIVE_API_KEY) {
    console.log("skipped: set GEMINI_API_KEY to run the live grounded-script check");
    return;
  }
  const generator = createGroundedScriptGenerator({ apiKey: LIVE_API_KEY, maxBodyChars: 2_000 });
  const script = await generator({
    article: {
      title: "Remote work and the office thermostat",
      summary: "A short argument about office occupancy.",
      body:
        "Offices are half empty on Mondays and Fridays. The article argues that mandates are the " +
        "only thing that will bring people back, and that flexible work harms junior staff.",
    },
    speakers: [...SPEAKERS],
    maxTurns: 6,
  });
  assert(script.turns.length >= 2, `expected at least two turns, saw ${script.turns.length}`);
  assert((script.turns[0]?.text ?? "").length > 20, "the first turn should be a real sentence");
  assert(
    script.counterarguments.length >= 1,
    "a grounded script must be able to name a counterargument",
  );
  console.log(
    `live grounded script: ${script.turns.length} turns, ${script.sources.length} sources, ` +
      `${script.counterarguments.length} counterarguments`,
  );
});

// ─── the deadline (audio-feed-yaz5 review) ───────────────────────────────────
// The finding: the fallback handled error responses but not a call that never answers, so a
// hung search request would hold synthesis forever. These cases pin both bounds — the stage's
// own deadline, and the call site's race for a generator that ignores the signal it is given.

Deno.test("script request: a hung call is bounded and reports the timeout", async () => {
  const generator = createGroundedScriptGenerator({
    apiKey: "test-key",
    timeoutMs: 50,
    // A fetch that never settles on its own, but honours the signal — the real shape of a stall.
    fetchFn: (_input, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const error = await assertRejects(
    () => generator({ article: ARTICLE, speakers: [...SPEAKERS] }),
    GroundedScriptError,
  );
  assertStringIncludes(error.message, "timed out after 50ms");
});

Deno.test("script request: a caller's cancel is reported as a cancel, not a timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  const generator = createGroundedScriptGenerator({
    apiKey: "test-key",
    timeoutMs: 5_000,
    // Real fetch rejects immediately for an already-aborted signal; a listener that only fires on a
    // future abort would hang this case (which is how the first version of this test failed).
    fetchFn: (_input, init) => {
      if (init?.signal?.aborted) return Promise.reject(new Error("aborted"));
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const error = await assertRejects(
    () => generator({ article: ARTICLE, speakers: [...SPEAKERS] }, { signal: controller.signal }),
    GroundedScriptError,
  );
  assertStringIncludes(error.message, "cancelled by the caller");
});

Deno.test("script deadline: the default is a real budget, not a token bound", () => {
  assert(
    DEFAULT_SCRIPT_TIMEOUT_MS >= 5_000,
    `a ${DEFAULT_SCRIPT_TIMEOUT_MS}ms default would fall back on healthy calls`,
  );
});

Deno.test("script deadline: the default clears three times the observed real-traffic maximum (yr76)", () => {
  // The measured distribution on real grounded calls (n=4, sotw-ds-flash 2026-10-04):
  // min 14.7s / p50 19.3s / max 19.7s. The default must clear 3x the observed maximum —
  // a timeout throws away a PAID grounded call (the episode falls back to the static
  // builder), so the margin is bought against a tail n=4 has not probed. Lowering the
  // default below this margin should trip here with the evidence named, not pass quietly.
  const OBSERVED_MAX_MS = 19_700;
  assert(
    DEFAULT_SCRIPT_TIMEOUT_MS >= OBSERVED_MAX_MS * 3,
    `the default (${DEFAULT_SCRIPT_TIMEOUT_MS}ms) is under 3x the observed max grounded-call time ` +
      `(${OBSERVED_MAX_MS}ms) — the margin that keeps a paid slow-but-fine call from being thrown away`,
  );
});

Deno.test("synthesis: a generator that hangs forever still produces an episode", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const { calls, synthesize } = harness({
      scriptTimeoutMs: 50,
      // Deliberately ignores its signal: this is what the call-site race exists for.
      scriptGenerator: () => new Promise(() => {}),
    });
    const started = Date.now();
    await synthesize({
      article: makeArticle({ title: "Hanging", content: "Body." }),
      source: makeSource({ voices: { deepdive: ["Kore", "Puck"] } }),
      episode: makeEpisode({}),
      mode: "deepdive",
    });
    const elapsed = Date.now() - started;
    assertEquals(calls.length, 1, "the TTS call must still happen");
    assertEquals(calls[0]?.turns, undefined, "no researched turns means the static builder runs");
    assert(elapsed < 5_000, `synthesis waited ${elapsed}ms on a hung generator`);
    assert(
      warnings.some((line) =>
        line.includes("grounded script stage failed") && line.includes("exceeded 50ms")
      ),
      `expected the timeout to be logged as the fallback reason, saw: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});
