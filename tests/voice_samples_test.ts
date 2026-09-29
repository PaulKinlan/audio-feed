/**
 * Voice audition samples (audio-feed-msw).
 *
 * The route spends real money on a cold cache, so the tests are ordered the way the
 * guards run: session -> allowlist -> cache -> synthesis. The first two must spend
 * NOTHING, a cache hit must spend nothing, and two concurrent misses must spend
 * once. One test additionally drives the REAL GeminiTtsClient through a capturing
 * fetchFn, so the outgoing request (voice, fixed text, no intro) is pinned by an
 * observation rather than by a helper the call site might stop using.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import {
  GeminiTtsClient,
  type GeminiTtsClientConfig,
  type NarrationInput,
  pcmToWav,
} from "../src/tts/gemini.ts";
import { VOICE_SAMPLE_TEXT, voiceSampleKey } from "../src/tts/voice-samples.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";

/** A real (tiny) WAV: 4800 PCM bytes is 0.1 s at 24 kHz mono — playable, if brief. */
const sampleWav = () =>
  pcmToWav(new Uint8Array(4800).map((_, i) => (i % 32) * 4), { sampleRate: 24000 });

function fakeClient(calls: NarrationInput[], delayMs = 0) {
  return {
    synthesizeNarration: async (input: NarrationInput) => {
      calls.push(input);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const rawBytes = sampleWav();
      return {
        rawBytes,
        mimeType: "audio/wav",
        format: "wav" as const,
        sampleRate: 24000,
        channels: 1,
        bitsPerSample: 16,
        durationSeconds: 0.1,
        finishReason: "STOP",
        truncated: false,
        toWav: () => rawBytes,
      };
    },
  };
}

async function setup(
  options: { calls?: NarrationInput[]; client?: boolean; apiKey?: string } = {},
) {
  const calls = options.calls ?? [];
  const config: AppConfig = {
    port: 8080,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
    geminiApiKey: options.apiKey,
  };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const handlers = createHandlers(
    ctx,
    options.client === false ? {} : { ttsClient: fakeClient(calls) },
  );
  const { fetch } = createApp(ctx, handlers);

  const rawUser = await createUser(stores.metadata, {
    email: "audition@example.com",
    displayName: "Audition",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);
  return { fetch, stores, user, session, calls };
}

const cookieFor = (session: string) => ({ cookie: `__Host-af_session=${session}` });

Deno.test("every voice serves a real WAV sample with its own synthesis (audio-feed-msw)", async () => {
  const { fetch, session, calls } = await setup();

  for (const voice of ["Aoede", "Charon", "Fenrir", "Kore", "Puck"]) {
    const res = await fetch(
      new Request(`${BASE}/assets/voices/${voice}`, { headers: cookieFor(session) }),
    );
    assertEquals(res.status, 200, `${voice} should serve`);
    assertEquals(res.headers.get("content-type"), "audio/wav");
    assertEquals(res.headers.get("x-voice-sample"), "generated");
    assertStringIncludes(String(res.headers.get("cache-control")), "immutable");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals(res.headers.get("content-length"), String(bytes.length));
    assert(bytes.length > 44, `${voice} body should be more than a WAV header`);
    assertEquals(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
    assertEquals(String.fromCharCode(...bytes.slice(8, 12)), "WAVE");
  }

  assertEquals(calls.map((c) => c.voice), ["Aoede", "Charon", "Fenrir", "Kore", "Puck"]);
  // The fixed line, no intro: the five clips compare voices rather than scripts.
  assert(
    calls.every((c) => c.body === VOICE_SAMPLE_TEXT),
    "every call narrates the fixed sample line",
  );
  assert(
    calls.every((c) => c.includeIntro === false),
    "the episode intro must not be read over a sample",
  );
});

Deno.test("an unknown voice is refused before anything is read or spent (audio-feed-msw)", async () => {
  const { fetch, session, calls, stores } = await setup();

  for (const name of ["Gandalf", "aoede", "Aoede/../Charon", "..", "Charon.wav"]) {
    const res = await fetch(
      new Request(`${BASE}/assets/voices/${encodeURIComponent(name)}`, {
        headers: cookieFor(session),
      }),
    );
    assertEquals(res.status, 404, `${name} must not resolve to a sample`);
  }
  assertEquals(calls.length, 0, "no synthesis for a name outside the allowlist");
  assertEquals(await stores.blobs.head(voiceSampleKey("Aoede")), null, "and nothing was stored");
});

Deno.test("a signed-out request does not trigger synthesis (audio-feed-msw)", async () => {
  const { fetch, calls } = await setup();

  const res = await fetch(new Request(`${BASE}/assets/voices/Aoede`));
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
  assertStringIncludes(await res.text(), "Sign in");
});

Deno.test("the second request is served from the cache (audio-feed-msw)", async () => {
  const { fetch, session, calls, stores } = await setup();
  const headers = cookieFor(session);

  const first = await fetch(new Request(`${BASE}/assets/voices/Kore`, { headers }));
  const second = await fetch(new Request(`${BASE}/assets/voices/Kore`, { headers }));
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals(second.headers.get("x-voice-sample"), "cached");
  assertEquals(calls.length, 1, "a cache hit costs no API call");
  assertEquals(await first.text(), await second.text(), "the cached bytes are the same bytes");
  assertEquals((await stores.blobs.head(voiceSampleKey("Kore")))?.contentType, "audio/wav");
});

Deno.test("two concurrent cold requests synthesise once (audio-feed-msw)", async () => {
  const calls: NarrationInput[] = [];
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const handlers = createHandlers(ctx, { ttsClient: fakeClient(calls, 20) });
  const { fetch } = createApp(ctx, handlers);
  const rawUser = await createUser(stores.metadata, {
    email: "burst@example.com",
    displayName: "Burst",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);
  const headers = cookieFor(session);

  // Five audition buttons invite a burst: the in-flight map must collapse it.
  const responses = await Promise.all([
    fetch(new Request(`${BASE}/assets/voices/Puck`, { headers })),
    fetch(new Request(`${BASE}/assets/voices/Puck`, { headers })),
    fetch(new Request(`${BASE}/assets/voices/Puck`, { headers })),
  ]);
  const bodies = await Promise.all(responses.map((r) => r.text()));

  assertEquals(calls.length, 1, "one synthesis for three simultaneous cold requests");
  assert(responses.every((r) => r.status === 200));
  assertEquals(new Set(bodies).size, 1, "every caller got the same clip");
});

Deno.test("without a key or a client the route says so instead of failing (audio-feed-msw)", async () => {
  const { fetch, session, calls } = await setup({ client: false, apiKey: undefined });

  const res = await fetch(
    new Request(`${BASE}/assets/voices/Aoede`, { headers: cookieFor(session) }),
  );
  assertEquals(res.status, 503);
  assertStringIncludes(await res.text(), "GEMINI_API_KEY");
  assertEquals(calls.length, 0);
});

Deno.test("a synthesis failure is a 502 and is not cached (audio-feed-msw)", async () => {
  const calls: string[] = [];
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const handlers = createHandlers(ctx, {
    ttsClient: {
      synthesizeNarration: (input: NarrationInput) => {
        calls.push(String(input.voice));
        throw new Error("quota exceeded");
      },
    },
  });
  const { fetch } = createApp(ctx, handlers);
  const rawUser = await createUser(stores.metadata, {
    email: "fail@example.com",
    displayName: "Fail",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);
  const headers = cookieFor(session);

  const first = await fetch(new Request(`${BASE}/assets/voices/Fenrir`, { headers }));
  assertEquals(first.status, 502);
  assertStringIncludes(await first.text(), "quota exceeded");

  // A failure must not leave a poisoned cache entry: the next request retries.
  const second = await fetch(new Request(`${BASE}/assets/voices/Fenrir`, { headers }));
  assertEquals(second.status, 502);
  assertEquals(calls.length, 2, "failures are retried, not remembered");
  assertEquals(await stores.blobs.head(voiceSampleKey("Fenrir")), null);
});

Deno.test("HEAD answers the headers this route promises (audio-feed-msw)", async () => {
  const { fetch, session } = await setup();

  // The router maps HEAD onto this GET handler and the HTTP runtime is what drops
  // the body, so in-process the body is present: the CONTRACT under test here is
  // the header set (content-length in particular, which a player reads to size its
  // buffer before it asks for the bytes). The browser proof checks the dropped body
  // over real HTTP.
  const res = await fetch(
    new Request(`${BASE}/assets/voices/Charon`, { method: "HEAD", headers: cookieFor(session) }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "audio/wav");
  assert(Number(res.headers.get("content-length")) > 44);
});

Deno.test("the account page offers a named play button per voice and ONE audio element (audio-feed-msw)", async () => {
  const { fetch, session } = await setup();

  const res = await fetch(new Request(`${BASE}/account`, { headers: cookieFor(session) }));
  assertEquals(res.status, 200);
  const html = await res.text();

  for (const voice of ["Aoede", "Charon", "Fenrir", "Kore", "Puck"]) {
    assertStringIncludes(
      html,
      `data-voice-sample="${voice}"`,
      `${voice} needs its own audition button`,
    );
    assertStringIncludes(html, `aria-label="Play a sample of ${voice}"`);
  }
  // One audio element for all five buttons is what makes "exactly one plays at a
  // time" structural; two elements would need bookkeeping to stay in step.
  assertEquals(html.split('id="voiceSampleAudio"').length - 1, 1, "exactly one audio element");
  assertEquals(html.split("data-voice-sample=").length - 1, 5, "one button per voice, no more");
  // The radios are the same form contract the <select> had (name=voice), and the
  // select itself is gone: two controls for one value is the duplicate-input bug.
  assertEquals(
    html.includes('<select id="voice"'),
    false,
    "the old select is replaced, not duplicated",
  );
  for (const voice of ["", "Aoede", "Charon", "Fenrir", "Kore", "Puck"]) {
    assertStringIncludes(html, `name="voice" value="${voice}"`);
  }
  assertStringIncludes(html, 'name="voice" value="" checked');
  assertStringIncludes(html, 'role="radiogroup"');
  assertEquals(
    html.includes('<button type="button" class="btn quiet small voice-play"'),
    true,
    "a real button, not a div",
  );
  assertStringIncludes(html, 'aria-pressed="false"');
});

Deno.test("HEAD on a cold voice settles the sample rather than answering 404 (audio-feed-msw)", async () => {
  const { fetch, session, calls, stores } = await setup();
  const headers = cookieFor(session);

  // A player that probes with HEAD before fetching must be told the truth about a
  // sample that CAN be made, not refused because nobody has asked for it yet.
  const head = await fetch(
    new Request(`${BASE}/assets/voices/Fenrir`, { method: "HEAD", headers }),
  );
  assertEquals(head.status, 200);
  assertEquals(calls.length, 1, "the cold HEAD is what generated it");
  assertEquals((await stores.blobs.head(voiceSampleKey("Fenrir")))?.contentType, "audio/wav");

  const after = await fetch(new Request(`${BASE}/assets/voices/Fenrir`, { headers }));
  assertEquals(after.headers.get("x-voice-sample"), "cached");
  assertEquals(calls.length, 1, "and the GET that follows pays nothing");
});

// -- the real client's outgoing request ---------------------------------------

Deno.test("the real GeminiTtsClient is asked for the fixed line in the chosen voice (audio-feed-msw)", async () => {
  let capturedUrl = "";
  // deno-lint-ignore no-explicit-any
  let capturedBody: any = null;
  const pcm = new Uint8Array(4800).fill(3);
  const mockFetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedUrl = input.toString();
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    const b64 = btoa(String.fromCharCode(...pcm));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: b64 } }] },
              finishReason: "STOP",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  }) as unknown as GeminiTtsClientConfig["fetchFn"];

  const config: AppConfig = {
    port: 8080,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
    geminiApiKey: "test-key",
  };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const handlers = createHandlers(ctx, {
    ttsClient: new GeminiTtsClient({ apiKey: "test-key", fetchFn: mockFetch }),
  });
  const { fetch } = createApp(ctx, handlers);
  const rawUser = await createUser(stores.metadata, {
    email: "real@example.com",
    displayName: "Real",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);

  const res = await fetch(
    new Request(`${BASE}/assets/voices/Aoede`, { headers: cookieFor(session) }),
  );
  assertEquals(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertEquals(String.fromCharCode(...bytes.slice(0, 4)), "RIFF", "PCM was converted to WAV");

  assertStringIncludes(capturedUrl, "generativelanguage.googleapis.com");
  const spoken =
    capturedBody?.contents?.[0]?.parts?.map((p: { text?: string }) => p.text ?? "").join(" ") ?? "";
  assertStringIncludes(spoken, VOICE_SAMPLE_TEXT);
  // The same string a two-voice dialogue would read aloud must not appear here.
  assert(!spoken.includes("generating"), "no meta-instruction reaches the sample request");
  assertEquals(
    capturedBody?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName,
    "Aoede",
  );
});
