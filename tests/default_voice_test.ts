/**
 * audio-feed-4xt — a default voice that is actually reachable.
 *
 * Two kinds of test, and both are needed. The resolver cases assert on the voice NAME
 * IN THE OUTGOING REQUEST rather than a helper's return value, because audio-feed-2np's
 * trap was a method tested in isolation while its call site went unexamined. The
 * creation case at the bottom asserts that a source built by the real subscribe path
 * carries NO stamped voice — without it, re-stamping DEFAULT_VOICES at creation
 * escapes every other test in this file, which is exactly how the original bug worked.
 *
 * The capturing fetchFn rejects on purpose: the request payload is the thing under
 * test, and letting the call "succeed" would require a fake audio body to assert less.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { loadConfig, memoryStores } from "../src/config.ts";
import { GeminiTtsClient } from "../src/tts/gemini.ts";
import { subscribeToFeed } from "../src/ingest/feed.ts";
import { renderHomePage } from "../src/routes/home.ts";
import { createGeminiSynthesizer } from "../src/worker/synthesis.ts";
import type { AppContext } from "../src/app.ts";
import type { Source } from "../src/types.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Feed</title>
  <item><title>One</title><link>https://example.com/one</link></item>
</channel></rss>`;

const pollDeps = {
  transport: () =>
    Promise.resolve(new Response(RSS, { headers: { "content-type": "application/rss+xml" } })),
  fetchArticle: (url: string) =>
    Promise.resolve({
      url,
      title: "One",
      author: null,
      publishedAt: null,
      lead: "Lead",
      body: "Body.",
    }),
};

/** Resolve the voice for one direct-mode synthesis, given what each layer offers. */
async function resolvedVoice(opts: {
  configVoice?: string;
  userVoice?: string | null;
  sourceVoices: Source["voices"];
  sourceTitle?: string;
}): Promise<string | undefined> {
  const stores = memoryStores();
  if (opts.userVoice !== undefined) {
    await stores.metadata.putUser(
      makeUser({ id: "u1", status: "approved", voice: opts.userVoice ?? undefined }),
    );
  }
  const ctx = {
    config: { port: 0, defaultVoice: opts.configVoice } as AppContext["config"],
    stores,
  } as AppContext;

  const seen: { voice?: string } = {};
  const synthesize = createGeminiSynthesizer(ctx, {
    client: new GeminiTtsClient({
      apiKey: "test-key-not-real",
      fetchFn: (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          generationConfig?: {
            speechConfig?: {
              voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } };
            };
          };
        };
        seen.voice = body.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig
          ?.voiceName;
        return Promise.reject(
          new Error("captured: this test asserts on the request, not the audio"),
        );
      },
    }),
  });

  await assertRejects(
    () =>
      synthesize({
        article: makeArticle({ id: "a1", userId: "u1", sourceId: "s1" }),
        source: makeSource({ id: "s1", userId: "u1", voices: opts.sourceVoices }),
        episode: makeEpisode({ id: "e1", userId: "u1", sourceId: "s1", articleId: "a1" }),
        mode: "direct",
      }),
    Error,
    "captured",
  );
  return seen.voice;
}

Deno.test("an explicit source voice still wins over every default (audio-feed-4xt)", async () => {
  const voice = await resolvedVoice({ configVoice: "Kore", sourceVoices: { direct: "Fenrir" } });
  assertEquals(voice, "Fenrir", "a source that chose a voice must not be overridden");
});

Deno.test("with no source voice, the user's own preference applies (audio-feed-4xt)", async () => {
  const voice = await resolvedVoice({ configVoice: "Kore", userVoice: "Puck", sourceVoices: {} });
  assertEquals(voice, "Puck", "user preference must beat the system default");
});

Deno.test("with no source or user voice, the system DEFAULT_VOICE applies (audio-feed-4xt)", async () => {
  const voice = await resolvedVoice({
    configVoice: "Aoede",
    userVoice: null,
    sourceVoices: {},
  });
  assertEquals(voice, "Aoede", "the operator default must reach the request");
});

Deno.test("with nothing set at all, it falls back to the documented constant (audio-feed-4xt)", async () => {
  const voice = await resolvedVoice({ userVoice: null, sourceVoices: {} });
  assertEquals(voice, "Charon");
});

Deno.test("an empty source voice does not shadow the defaults (audio-feed-4xt)", async () => {
  // `""` is falsy but not nullish. A `??` chain would send it to the API as a voice
  // name, and the client's own `||` fallback would then silently pick Charon and skip
  // both the user preference and DEFAULT_VOICE.
  const voice = await resolvedVoice({
    configVoice: "Kore",
    userVoice: null,
    sourceVoices: { direct: "" },
  });
  assertEquals(voice, "Kore", "an unset source voice must fall through, not be sent as-is");
});

Deno.test("a feed subscribed without a voice stores NO stamped voice (audio-feed-4xt)", async () => {
  // The end-to-end half. The resolver above is only reachable if creation leaves the
  // field unset; subscribeToFeed used to stamp DEFAULT_VOICES, which made every
  // default below the first term dead. Re-stamping it escapes all five tests above,
  // so this is the one that actually pins the bug.
  const stores = memoryStores();
  const ctx = {
    config: { port: 0, defaultVoice: "Aoede" } as AppContext["config"],
    stores,
  } as AppContext;
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved" }));

  const { source } = await subscribeToFeed(
    ctx,
    { userId: "u1", feedUrl: "https://example.com/feed.xml" },
    pollDeps,
  );

  assertEquals(
    source.voices.direct,
    undefined,
    "creation must not invent a narrator; that is what makes DEFAULT_VOICE unreachable",
  );
  assertEquals(source.voices.deepdive, undefined, "same for the dialogue pair");

  // And the stored source really does resolve to the operator default end to end.
  const persisted = await stores.metadata.getSource("u1", source.id);
  assert(persisted, "source should be persisted");
  const voice = await resolvedVoice({
    configVoice: "Aoede",
    userVoice: null,
    sourceVoices: persisted.voices,
  });
  assertEquals(voice, "Aoede", "a source created by the real path must reach DEFAULT_VOICE");
});

Deno.test("the home page states the deployment's real default voice, not Charon (audio-feed-4xt)", () => {
  // Compiles-but-unverified is the failure mode this whole bead keeps hitting. The
  // page used to hard-code "Default voice: Charon"; passing defaultVoice through
  // proves nothing unless a non-Charon value actually appears.
  const html = renderHomePage({
    publicBaseUrl: "https://audio.example.com",
    synthesisConfigured: true,
    defaultVoice: "Fenrir",
  });
  assertStringIncludes(html, "Default voice: Fenrir");
  assertEquals(
    html.includes("Default voice: Charon"),
    false,
    "the hard-coded name must be gone, not merely joined by a second claim",
  );
});

Deno.test("loadConfig rejects an invalid DEFAULT_VOICE at boot (audio-feed-4xt)", () => {
  const had = Deno.env.get("DEFAULT_VOICE");
  Deno.env.set("DEFAULT_VOICE", "Charonn"); // the typo this guard exists for
  try {
    let thrown: unknown;
    try {
      loadConfig();
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Error, "an invalid DEFAULT_VOICE must throw, not fall back");
    assertStringIncludes((thrown as Error).message, "Charonn");
    assertStringIncludes((thrown as Error).message, "Aoede", "the error must name the valid set");
  } finally {
    // Restore, or every later test in this process inherits the bad value.
    if (had === undefined) Deno.env.delete("DEFAULT_VOICE");
    else Deno.env.set("DEFAULT_VOICE", had);
  }
});

Deno.test("loadConfig accepts a valid DEFAULT_VOICE (audio-feed-4xt)", () => {
  const had = Deno.env.get("DEFAULT_VOICE");
  Deno.env.set("DEFAULT_VOICE", "Kore");
  try {
    assertEquals(loadConfig().defaultVoice, "Kore");
  } finally {
    if (had === undefined) Deno.env.delete("DEFAULT_VOICE");
    else Deno.env.set("DEFAULT_VOICE", had);
  }
});
