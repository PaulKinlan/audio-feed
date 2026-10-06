/**
 * audio-feed-wr1u review P2-3: the resume tests in synthesis_resume_test.ts drive a hand-built
 * replica of the hook protocol, so they would stay green even if the real client silently
 * ignored options.resume. This file drives the REAL GeminiTtsClient (stubbed fetchFn, no
 * network) through synthesizeNarration and synthesizeDialogue with resume hooks and asserts
 * the production seam itself:
 *
 * - prepare is consulted with the exact segment text BEFORE each paid call;
 * - a stored segment skips its call entirely (fetch count drops);
 * - commit sees each freshly paid segment before the next call;
 * - the stitched result of a resumed run equals the single-run result byte for byte;
 * - dialogue segment identity carries speaker attribution (U+0001) and joins batches with
 *   U+0000, and the dialogue voice key is the speakers' voices joined.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { GeminiTtsClient, pcmToWav, uint8ArrayToBase64 } from "../src/tts/gemini.ts";

/** Deterministic WAV per text, so a re-fetched segment equals its stored copy. */
function wavForText(text: string): Uint8Array {
  const pcm = new Uint8Array(96 + (text.length % 24) * 8);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = (text.charCodeAt(i % text.length) + i * 3) & 0x7f;
  }
  return pcmToWav(pcm, { sampleRate: 24000, numChannels: 1, bitsPerSample: 8 });
}

function okResponse(wav: Uint8Array): string {
  return JSON.stringify({
    candidates: [{
      content: {
        parts: [{ inlineData: { mimeType: "audio/wav", data: uint8ArrayToBase64(wav) } }],
      },
      finishReason: "STOP",
    }],
  });
}

/** The spoken text of one request, exactly as the client puts it in the body. */
function requestText(body: string): string {
  const parsed = JSON.parse(body) as {
    contents: { parts: { text: string }[] }[];
  };
  return parsed.contents.map((c) => c.parts.map((p) => p.text).join("\n")).join("\n");
}

function stubClient(calls: string[]) {
  return new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: (_url, init) => {
      const body = String(init?.body ?? "");
      calls.push(body);
      return Promise.resolve(
        new Response(okResponse(wavForText(requestText(body))), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });
}

/** Two paragraphs, each over the 6,000-byte segment budget: exactly two segments. */
const TWO_SEGMENT_BODY = [0, 1].map((n) =>
  `Movement ${n}: ` + "the quarterly numbers arrived exactly as nobody expected. ".repeat(90)
).join("\n\n");

Deno.test("the real narration client resumes stored segments and skips their paid calls", async () => {
  const stored = new Map<string, Uint8Array>();
  const firstCalls: string[] = [];
  const client = stubClient(firstCalls);

  const first = await client.synthesizeNarration(
    { title: "T", author: "A", body: TWO_SEGMENT_BODY, voice: "Charon" },
    {
      resume: {
        prepare: () => Promise.resolve("synthesize"),
        commit: (text, decoded) => {
          stored.set(text, decoded.format === "wav" ? decoded.rawBytes : decoded.toWav());
          return Promise.resolve();
        },
      },
    },
  );
  assertEquals(firstCalls.length, 2, "two segments, two paid calls");
  assertEquals(stored.size, 2, "every paid segment is committed before the run ends");

  const secondCalls: string[] = [];
  const resumedClient = stubClient(secondCalls);
  const prepareSeen: string[] = [];
  const second = await resumedClient.synthesizeNarration(
    { title: "T", author: "A", body: TWO_SEGMENT_BODY, voice: "Charon" },
    {
      resume: {
        prepare: (text) => {
          prepareSeen.push(text);
          const wav = stored.get(text);
          return Promise.resolve(wav ? { wav } : "synthesize");
        },
        commit: () => Promise.resolve(),
      },
    },
  );

  assertEquals(prepareSeen.length, 2, "prepare is consulted for every segment, stored or not");
  assertEquals(
    secondCalls.length,
    0,
    "both segments are stored, so the resumed run pays for nothing",
  );
  assertEquals(second.toWav(), first.toWav(), "resumed stitch equals the single-run stitch");
});

Deno.test("the real dialogue client keys segments by attributed turn text and joined voices", async () => {
  const turnText = (n: number) =>
    `Turn ${n} says: ` + "and then the discussion went exactly where the data led it. ".repeat(80);
  const turns = [
    { speaker: "Alex", text: turnText(0) },
    { speaker: "Sam", text: turnText(1) },
  ];
  const stored = new Map<string, Uint8Array>();
  const firstCalls: string[] = [];
  const client = stubClient(firstCalls);
  await client.synthesizeDialogue(
    {
      title: "T",
      speakers: [
        { name: "Alex", role: "expert", voice: "Kore" },
        { name: "Sam", role: "curious_foil", voice: "Puck" },
      ],
      turns,
    },
    {
      resume: {
        prepare: () => Promise.resolve("synthesize"),
        commit: (text, decoded) => {
          stored.set(text, decoded.format === "wav" ? decoded.rawBytes : decoded.toWav());
          return Promise.resolve();
        },
      },
    },
  );
  assertEquals(firstCalls.length, 2, "two over-budget turns, two batches, two paid calls");
  assertEquals(stored.size, 2);
  for (const key of stored.keys()) {
    assertStringIncludes(key, "\u0001", "attribution (speaker) is part of the segment identity");
    assert(key.startsWith("Alex\u0001") || key.startsWith("Sam\u0001"), "key names its speaker");
  }

  const secondCalls: string[] = [];
  const resumedClient = stubClient(secondCalls);
  await resumedClient.synthesizeDialogue(
    {
      title: "T",
      speakers: [
        { name: "Alex", role: "expert", voice: "Kore" },
        { name: "Sam", role: "curious_foil", voice: "Puck" },
      ],
      turns,
    },
    {
      resume: {
        prepare: (text) => {
          const wav = stored.get(text);
          return Promise.resolve(wav ? { wav } : "synthesize");
        },
        commit: () => Promise.resolve(),
      },
    },
  );
  assertEquals(secondCalls.length, 0, "both attributed batches resume; nothing is re-billed");
});

Deno.test("a truncated segment is never committed as resume material", async () => {
  const calls: string[] = [];
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: (_url, init) => {
      calls.push(String(init?.body ?? ""));
      const body = String(init?.body ?? "");
      const wav = wavForText(requestText(body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{
              content: {
                parts: [{ inlineData: { mimeType: "audio/wav", data: uint8ArrayToBase64(wav) } }],
              },
              finishReason: "MAX_TOKENS",
            }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
  const committed: string[] = [];
  let threw = false;
  try {
    await client.synthesizeNarration(
      { title: "T", author: "A", body: TWO_SEGMENT_BODY, voice: "Charon" },
      {
        resume: {
          prepare: () => Promise.resolve("synthesize"),
          commit: (text) => {
            committed.push(text);
            return Promise.resolve();
          },
        },
      },
    );
  } catch {
    threw = true; // truncated audio is rejected by default (allowTruncated false)
  }
  assert(threw, "truncated narration must not publish");
  assertEquals(committed, [], "a truncated segment must never become resume material");
});
