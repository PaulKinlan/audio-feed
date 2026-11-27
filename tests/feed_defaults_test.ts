/**
 * Comprehensive tests for Issue #53: Per-Feed Playback Speed, Voice, and Mode Defaults
 * across `POST /api/account/sources/:sourceId/preferences`, synthesis voice resolution
 * (`synthesis.ts` & `synthesis_workflow.ts`), `/account` UI (Feeds tab + Email-to-Podcast
 * forwarding address), and `/listen/` per-show playback speed integration.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createApp, type AppContext } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { assetBody } from "../src/routes/assets.ts";
import {
  DEFAULT_NARRATION_VOICE,
  GEMINI_TTS_VOICES,
  GeminiTtsClient,
  pcmToWav,
  uint8ArrayToBase64,
} from "../src/tts/gemini.ts";
import {
  createGeminiSynthesizer,
  normalizeNarratorVoice,
  resolveNarratorVoice,
  resolveSourceNarratorVoice,
} from "../src/worker/synthesis.ts";
import {
  runEpisodeSynthesisWorkflow,
  type WorkflowStepConfigLike,
  type WorkflowStepLike,
} from "../src/worker/synthesis_workflow.ts";
import type { D1DatabaseLike } from "../src/storage/d1/types.ts";
import { MAX_ACCOUNT_BODY_BYTES } from "../src/http.ts";
import { INBOX_SOURCE_ID, type Source, type User } from "../src/types.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { playerClient, playerData } from "./listen_client.ts";
import { createTestD1 } from "./sqlite_d1.ts";

const BASE = "https://audio.example.com";
const EVIL = "https://evil.example";

function createHarness(customStores?: Stores) {
  const stores = customStores ?? memoryStores();
  const config: AppConfig = {
    port: 8000,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
  };
  const ctx: AppContext = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const seedUser = async (overrides: Partial<User> = {}) => {
    const user = makeUser({ id: "user-1", email: "reader@example.com", ...overrides });
    await stores.metadata.putUser(user);
    return user;
  };
  const cookieFor = async (userId: string) =>
    `${SESSION_COOKIE}=${await createSession(stores.metadata, userId)}`;

  return { fetch, stores, ctx, seedUser, cookieFor };
}

function postPrefs(
  fetch: (req: Request) => Promise<Response>,
  sourceId: string,
  body: unknown,
  opts: { cookie?: string; origin?: string; secFetchSite?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.secFetchSite !== undefined) headers["sec-fetch-site"] = opts.secFetchSite;
  return fetch(
    new Request(`${BASE}/api/account/sources/${encodeURIComponent(sourceId)}/preferences`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function toneWavResponse(durationSeconds = 0.5): Response {
  const sr = 24_000;
  const samples = Math.round(sr * durationSeconds);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(8_000 * Math.sin((2 * Math.PI * 240 * i) / sr)), true);
  }
  const wav = pcmToWav(pcm, { sampleRate: sr, numChannels: 1, bitsPerSample: 16 });
  return new Response(
    JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{ inlineData: { mimeType: "audio/wav", data: uint8ArrayToBase64(wav) } }],
        },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function createFakeStep(): WorkflowStepLike {
  return {
    async do<T>(
      _name: string,
      configOrFn: WorkflowStepConfigLike | (() => Promise<T>),
      maybeFn?: () => Promise<T>,
    ): Promise<T> {
      const fn = typeof configOrFn === "function" ? configOrFn : maybeFn!;
      return await fn();
    },
    async sleepUntil(): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// 1. Source Preferences API: Auth, CSRF, Ownership, Validation, D1 Persistence
// ---------------------------------------------------------------------------

Deno.test("POST /api/account/sources/:sourceId/preferences: enforces session auth, sameOrigin CSRF, and ownership", async () => {
  const t = createHarness();
  const alice = await t.seedUser({ id: "alice", email: "alice@example.com" });
  const bob = await t.seedUser({ id: "bob", email: "bob@example.com" });
  await t.stores.metadata.putSource(
    makeSource({ id: "alice-feed", userId: alice.id, title: "Alice Blog" }),
  );
  await t.stores.metadata.putSource(
    makeSource({ id: "bob-feed", userId: bob.id, title: "Bob Blog" }),
  );

  // Unauthenticated -> 401
  const unauth = await postPrefs(t.fetch, "alice-feed", { voice: "Aoede" }, { origin: BASE });
  assertEquals(unauth.status, 401);
  assertEquals(unauth.headers.get("cache-control"), "no-store");

  const aliceCookie = await t.cookieFor(alice.id);

  // Cross-origin -> 403
  const crossOrigin = await postPrefs(
    t.fetch,
    "alice-feed",
    { voice: "Aoede" },
    { cookie: aliceCookie, origin: EVIL },
  );
  assertEquals(crossOrigin.status, 403);

  const crossSite = await postPrefs(
    t.fetch,
    "alice-feed",
    { voice: "Aoede" },
    { cookie: aliceCookie, secFetchSite: "cross-site" },
  );
  assertEquals(crossSite.status, 403);

  // Ownership check: Alice cannot modify Bob's source -> 404
  const wrongOwner = await postPrefs(
    t.fetch,
    "bob-feed",
    { voice: "Aoede", playbackRate: 1.5 },
    { cookie: aliceCookie, origin: BASE },
  );
  assertEquals(wrongOwner.status, 404);
  const bobSource = await t.stores.metadata.getSource(bob.id, "bob-feed");
  assertEquals(bobSource?.voice, undefined);
  assertEquals(bobSource?.playbackRate, undefined);

  // Unknown source -> 404
  const missing = await postPrefs(
    t.fetch,
    "does-not-exist",
    { voice: "Aoede" },
    { cookie: aliceCookie, origin: BASE },
  );
  assertEquals(missing.status, 404);
});

Deno.test("POST /api/account/sources/:sourceId/preferences: validates voice, playbackRate, modes, codeHandling, and body cap strictly", async () => {
  const t = createHarness();
  const user = await t.seedUser();
  await t.stores.metadata.putSource(
    makeSource({
      id: "news",
      userId: user.id,
      title: "Daily News",
      modes: ["direct"],
      voices: { deepdive: ["Fenrir", "Puck"] },
      etag: '"etag-123"',
      lastPolledAt: "2026-11-20T00:00:00.000Z",
    }),
  );
  const cookie = await t.cookieFor(user.id);

  // Invalid payloads must all return 400 and leave the stored source unmodified.
  const invalidPayloads: Array<[string, Record<string, unknown>]> = [
    ["unknown voice", { voice: "BogusVoice" }],
    ["lowercase voice", { voice: "aoede" }],
    ["whitespace voice", { voice: "   " }],
    ["non-string voice", { voice: 42 }],
    ["rate below 0.5", { playbackRate: 0.49 }],
    ["rate zero", { playbackRate: 0 }],
    ["rate negative", { playbackRate: -1 }],
    ["rate above 3.0", { playbackRate: 3.01 }],
    ["string rate", { playbackRate: "1.4" }],
    ["boolean rate", { playbackRate: true }],
    ["empty modes", { modes: [] }],
    ["invalid mode", { modes: ["summary"] }],
    ["mixed valid and invalid mode", { modes: ["direct", "invalid"] }],
    ["non-array modes", { modes: "direct" }],
    ["invalid codeHandling", { codeHandling: "delete" }],
    ["non-string codeHandling", { codeHandling: 1 }],
    ["valid voice + invalid rate fails atomically", { voice: "Aoede", playbackRate: 9.9 }],
  ];

  for (const [label, payload] of invalidPayloads) {
    const res = await postPrefs(t.fetch, "news", payload, { cookie, origin: BASE });
    assertEquals(res.status, 400, `${label} must be rejected with 400`);
  }

  // Oversized body -> 413
  const oversized = JSON.stringify({ voice: "Aoede", pad: "x".repeat(MAX_ACCOUNT_BODY_BYTES + 100) });
  const tooLarge = await postPrefs(t.fetch, "news", oversized, { cookie, origin: BASE });
  assertEquals(tooLarge.status, 413);

  // Confirm none of the failed requests mutated the source.
  const unchanged = await t.stores.metadata.getSource(user.id, "news");
  assertEquals(unchanged?.voice, undefined);
  assertEquals(unchanged?.playbackRate, undefined);
  assertEquals(unchanged?.modes, ["direct"]);
  assertEquals(unchanged?.codeHandling, undefined);

  // Valid full update (including mode deduplication and preserving untouched metadata)
  const ok = await postPrefs(
    t.fetch,
    "news",
    {
      voice: "Aoede",
      playbackRate: 1.4,
      modes: ["deepdive", "deepdive", "direct"],
      codeHandling: "explain",
    },
    { cookie, origin: BASE },
  );
  assertEquals(ok.status, 200);
  const okBody = await ok.json();
  assertEquals(okBody, {
    ok: true,
    source: {
      id: "news",
      title: "Daily News",
      voice: "Aoede",
      playbackRate: 1.4,
      modes: ["deepdive", "direct"],
      codeHandling: "explain",
    },
  });

  const persisted = await t.stores.metadata.getSource(user.id, "news");
  assertEquals(persisted?.voice, "Aoede");
  assertEquals(persisted?.voices.direct, "Aoede");
  assertEquals(persisted?.voices.deepdive, ["Fenrir", "Puck"], "deepdive pair preserved");
  assertEquals(persisted?.playbackRate, 1.4);
  assertEquals(persisted?.modes, ["deepdive", "direct"]);
  assertEquals(persisted?.codeHandling, "explain");
  assertEquals(persisted?.etag, '"etag-123"', "etag preserved");

  // Boundary rates: 0.5 and 3.0 are accepted; partial update keeps other fields intact.
  const minRate = await postPrefs(t.fetch, "news", { playbackRate: 0.5 }, { cookie, origin: BASE });
  assertEquals(minRate.status, 200);
  assertEquals((await minRate.json()).source.playbackRate, 0.5);

  const maxRate = await postPrefs(t.fetch, "news", { playbackRate: 3.0 }, { cookie, origin: BASE });
  assertEquals(maxRate.status, 200);
  const maxBody = await maxRate.json();
  assertEquals(maxBody.source.playbackRate, 3);
  assertEquals(maxBody.source.voice, "Aoede", "partial update must preserve voice");
  assertEquals(maxBody.source.codeHandling, "explain", "partial update must preserve codeHandling");

  // Clearing voice & playbackRate resets both `source.voice` and legacy `source.voices.direct`
  const cleared = await postPrefs(
    t.fetch,
    "news",
    { voice: null, playbackRate: null },
    { cookie, origin: BASE },
  );
  assertEquals(cleared.status, 200);
  const clearedBody = await cleared.json();
  assertEquals(clearedBody.source.voice, null);
  assertEquals(clearedBody.source.playbackRate, null);

  const afterClear = await t.stores.metadata.getSource(user.id, "news");
  assertEquals(afterClear?.voice, undefined);
  assertEquals(afterClear?.voices.direct, undefined);
  assertEquals(afterClear?.voices.deepdive, ["Fenrir", "Puck"]);
  assertEquals(afterClear?.playbackRate, undefined);

  // Synthetic inbox source can also store per-feed defaults
  await t.stores.metadata.putSource(
    makeSource({ id: INBOX_SOURCE_ID, userId: user.id, title: "Send to Audio", feedUrl: undefined }),
  );
  const inboxRes = await postPrefs(
    t.fetch,
    INBOX_SOURCE_ID,
    { voice: "Puck", playbackRate: 1.2 },
    { cookie, origin: BASE },
  );
  assertEquals(inboxRes.status, 200);
  const savedInbox = await t.stores.metadata.getSource(user.id, INBOX_SOURCE_ID);
  assertEquals(savedInbox?.voice, "Puck");
  assertEquals(savedInbox?.playbackRate, 1.2);
});

Deno.test("source preferences round-trip cleanly through D1MetadataStore without schema migration", async () => {
  const d1 = createTestD1();
  try {
    const metadata = new D1MetadataStore(d1);
    const blobs = new MemoryBlobStore();
    const t = createHarness({ metadata, blobs, describe: "d1-test" });
    const user = await t.seedUser({ id: "u-d1", email: "d1@example.com" });
    await metadata.putSource(makeSource({ id: "tech-blog", userId: user.id, title: "Tech Blog" }));
    const cookie = await t.cookieFor(user.id);

    const res = await postPrefs(
      t.fetch,
      "tech-blog",
      { voice: "Fenrir", playbackRate: 1.2, modes: ["direct"], codeHandling: "explain" },
      { cookie, origin: BASE },
    );
    assertEquals(res.status, 200);

    const reloaded = await metadata.getSource(user.id, "tech-blog");
    assertEquals(reloaded?.voice, "Fenrir");
    assertEquals(reloaded?.playbackRate, 1.2);
    assertEquals(reloaded?.modes, ["direct"]);
    assertEquals(reloaded?.codeHandling, "explain");
  } finally {
    d1.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Synthesis Voice Resolution Precedence (synthesis.ts & synthesis_workflow.ts)
// ---------------------------------------------------------------------------

Deno.test("voice resolution helpers enforce source.voice > source.voices.direct > user.voice > defaultVoice > DEFAULT_NARRATION_VOICE", () => {
  assertEquals(normalizeNarratorVoice("Aoede"), "Aoede");
  assertEquals(normalizeNarratorVoice("  Kore  "), "Kore");
  assertEquals(normalizeNarratorVoice("BogusVoice"), undefined);
  assertEquals(normalizeNarratorVoice(""), undefined);
  assertEquals(normalizeNarratorVoice(null), undefined);

  assertEquals(
    resolveSourceNarratorVoice({ voice: "Aoede", voices: { direct: "Fenrir" } }),
    "Aoede",
  );
  assertEquals(
    resolveSourceNarratorVoice({ voice: "InvalidVoice", voices: { direct: "Fenrir" } }),
    "Fenrir",
  );
  assertEquals(
    resolveSourceNarratorVoice({ voice: "InvalidVoice", voices: {} }),
    undefined,
  );

  // Full precedence chain
  assertEquals(
    resolveNarratorVoice({
      source: { voice: "Aoede", voices: { direct: "Fenrir" } },
      user: { voice: "Puck" },
      defaultVoice: "Kore",
    }),
    "Aoede",
  );
  assertEquals(
    resolveNarratorVoice({
      source: { voice: "Invalid", voices: {} },
      user: { voice: "Puck" },
      defaultVoice: "Kore",
    }),
    "Puck",
  );
  assertEquals(
    resolveNarratorVoice({
      source: { voice: "", voices: {} },
      user: { voice: "Invalid" },
      defaultVoice: "Kore",
    }),
    "Kore",
  );
  assertEquals(
    resolveNarratorVoice({
      source: { voice: undefined, voices: {} },
      user: { voice: undefined },
      defaultVoice: undefined,
    }),
    DEFAULT_NARRATION_VOICE,
  );
});

Deno.test("createGeminiSynthesizer uses source.voice over user.voice/default and falls back safely when source.voice is invalid", async () => {
  async function captureVoice(opts: {
    source: Source;
    userVoice?: string;
    configVoice?: string;
  }): Promise<string | undefined> {
    const stores = memoryStores();
    await stores.metadata.putUser(
      makeUser({ id: "u1", status: "approved", voice: opts.userVoice }),
    );
    const ctx = {
      config: { port: 0, defaultVoice: opts.configVoice } as AppContext["config"],
      stores,
    } as AppContext;

    let seenVoice: string | undefined;
    const synthesize = createGeminiSynthesizer(ctx, {
      client: new GeminiTtsClient({
        apiKey: "test-key",
        fetchFn: (_input, init) => {
          const parsed = JSON.parse(String(init?.body)) as {
            generationConfig?: {
              speechConfig?: {
                voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } };
              };
            };
          };
          seenVoice = parsed.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig
            ?.voiceName;
          return Promise.reject(new Error("captured"));
        },
      }),
    });

    await assertRejects(
      () =>
        synthesize({
          article: makeArticle({ id: "a1", userId: "u1", sourceId: opts.source.id }),
          source: opts.source,
          episode: makeEpisode({ id: "e1", userId: "u1", sourceId: opts.source.id, articleId: "a1" }),
          mode: "direct",
        }),
      Error,
      "captured",
    );
    return seenVoice;
  }

  // source.voice beats user.voice and config.defaultVoice
  assertEquals(
    await captureVoice({
      source: makeSource({ id: "s1", userId: "u1", voice: "Aoede", voices: {} }),
      userVoice: "Puck",
      configVoice: "Kore",
    }),
    "Aoede",
  );

  // Invalid source.voice falls back cleanly to user.voice
  assertEquals(
    await captureVoice({
      source: makeSource({ id: "s2", userId: "u1", voice: "UnknownVoice", voices: {} }),
      userVoice: "Puck",
      configVoice: "Kore",
    }),
    "Puck",
  );

  // Invalid source.voice + no user.voice falls back to config.defaultVoice
  assertEquals(
    await captureVoice({
      source: makeSource({ id: "s3", userId: "u1", voice: "   ", voices: {} }),
      configVoice: "Kore",
    }),
    "Kore",
  );
});

Deno.test("runEpisodeSynthesisWorkflow resolves source.voice > user.voice > defaultVoice > Charon cleanly with MP3 assembly intact", async () => {
  async function runWorkflowAndCaptureVoice(opts: {
    sourceVoice?: string;
    userVoice?: string;
    defaultVoice?: string;
  }): Promise<{ voice: string | undefined; contentType: string | undefined; audioKey: string | undefined }> {
    const metadata = new MemoryMetadataStore();
    const blobs = new MemoryBlobStore();
    await metadata.putUser(makeUser({ id: "u1", status: "approved", voice: opts.userVoice }));
    await metadata.putSource(
      makeSource({ id: "s1", userId: "u1", voice: opts.sourceVoice, voices: {} }),
    );
    await metadata.putArticle(
      makeArticle({
        id: "a1",
        userId: "u1",
        sourceId: "s1",
        title: "Voice Precedence Test",
        content: "Short body paragraph for voice resolution verification.",
      }),
    );
    await metadata.putEpisode(
      makeEpisode({
        id: "ep-1",
        userId: "u1",
        sourceId: "s1",
        articleId: "a1",
        status: "pending",
        mode: "direct",
      }),
    );

    let capturedVoice: string | undefined;
    const ttsClient = new GeminiTtsClient({
      apiKey: "test-key",
      fetchFn: (_input, init) => {
        const parsed = JSON.parse(String(init?.body)) as {
          generationConfig?: {
            speechConfig?: {
              voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } };
            };
          };
        };
        capturedVoice = parsed.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig
          ?.voiceName;
        return Promise.resolve(toneWavResponse(0.4));
      },
    });

    const env = {
      DB: {} as unknown as D1DatabaseLike,
      GEMINI_API_KEY: "test-key",
      PUBLIC_BASE_URL: BASE,
      ...(opts.defaultVoice ? { DEFAULT_VOICE: opts.defaultVoice } : {}),
    };
    const res = await runEpisodeSynthesisWorkflow(
      env,
      { payload: { episodeId: "ep-1", userId: "u1" }, instanceId: "wf-voice" },
      createFakeStep(),
      { metadata, blobs, ttsClient, scriptGenerator: null },
    );
    assertEquals(res.status, "ready");
    const ep = await metadata.getEpisode("u1", "ep-1");
    return { voice: capturedVoice, contentType: ep?.contentType, audioKey: ep?.audioKey };
  }

  // 1. Valid source.voice wins over user.voice and DEFAULT_VOICE, and produces MP3.
  const r1 = await runWorkflowAndCaptureVoice({
    sourceVoice: "Fenrir",
    userVoice: "Puck",
    defaultVoice: "Kore",
  });
  assertEquals(r1.voice, "Fenrir");
  assertEquals(r1.contentType, "audio/mpeg");
  assert(r1.audioKey?.endsWith(".mp3"));

  // 2. Invalid source.voice safely falls back to user.voice.
  const r2 = await runWorkflowAndCaptureVoice({
    sourceVoice: "NotARealVoice",
    userVoice: "Aoede",
    defaultVoice: "Kore",
  });
  assertEquals(r2.voice, "Aoede");

  // 3. Unset source.voice and user.voice falls back to DEFAULT_VOICE.
  const r3 = await runWorkflowAndCaptureVoice({ defaultVoice: "Kore" });
  assertEquals(r3.voice, "Kore");

  // 4. Everything unset falls back to DEFAULT_NARRATION_VOICE ("Charon").
  const r4 = await runWorkflowAndCaptureVoice({});
  assertEquals(r4.voice, DEFAULT_NARRATION_VOICE);
});

// ---------------------------------------------------------------------------
// 3. /account UI (Feeds tab source-prefs + Add tab Email-to-Podcast) & CSP
// ---------------------------------------------------------------------------

Deno.test("GET /account renders per-feed defaults UI, Email-to-Podcast forwarding address, and upholds strict CSP & layout invariants", async () => {
  const t = createHarness();
  const me = await t.seedUser({
    id: "user-1",
    email: "alice@example.com",
    displayName: "Alice",
    feedToken: "tok-alice-secret-123",
  });
  const other = await t.seedUser({
    id: "user-2",
    email: "bob@example.com",
    feedToken: "tok-bob-secret-999",
  });
  await t.stores.metadata.putSource(
    makeSource({
      id: "news-feed",
      userId: me.id,
      title: "Morning News",
      voice: "Aoede",
      playbackRate: 1.4,
      modes: ["deepdive", "direct"],
      codeHandling: "explain",
    }),
  );
  await t.stores.metadata.putSource(
    makeSource({
      id: "custom-rate-feed",
      userId: me.id,
      title: "Deep Tech",
      playbackRate: 1.35,
      modes: ["direct"],
    }),
  );
  await t.stores.metadata.putSource(
    makeSource({ id: "bobs-feed", userId: other.id, title: "Bob Only" }),
  );

  const cookie = await t.cookieFor(me.id);
  const res = await t.fetch(new Request(`${BASE}/account`, { headers: { cookie } }));
  assertEquals(res.status, 200);
  const html = await res.text();

  // Strict CSP & DOM integrity invariants
  assert(!/\bstyle\s*=/i.test(html), "/account HTML must have zero inline style attributes");
  assertEquals(/\.innerHTML\s*=/.test(html), false, "/account must have zero .innerHTML assignments");
  assertEquals(
    (html.match(/<details class="source-prefs">/g) ?? []).length,
    2,
    "each of the user's 2 sources renders a collapsible source-prefs disclosure",
  );
  assertEquals(
    (html.match(/<\/details>/g) ?? []).length >= 4,
    true,
    "all rendered <details> disclosures close cleanly",
  );

  // Preserves exact 6 section.panel layout & 4-tab ARIA workspace
  const wrapStart = html.indexOf('<div class="wrap">');
  const mainEnd = html.indexOf("</main>");
  const wrapRegion = html.slice(wrapStart, mainEnd);
  assertEquals([...wrapRegion.matchAll(/<section class="panel(?:\s|")/g)].length, 6);
  for (const tabId of ["tab-episodes", "tab-add", "tab-feeds", "tab-settings"]) {
    assertStringIncludes(html, `id="${tabId}"`);
  }

  // Feeds tab: collapsible <details class="source-prefs"> with all controls and saved values
  assertStringIncludes(html, '<details class="source-prefs">');
  assertStringIncludes(html, 'data-source-prefs="news-feed"');
  assertStringIncludes(html, "Aoede · 1.4× · Deep dive · Explain code");
  for (const voice of GEMINI_TTS_VOICES) {
    assertStringIncludes(html, `value="${voice}"`);
  }
  assertStringIncludes(html, '<option value="Aoede" selected>');
  for (const speed of ["0.8", "1", "1.2", "1.4", "1.5", "1.75", "2"]) {
    assertStringIncludes(html, `value="${speed}"`);
  }
  assertStringIncludes(html, '<option value="1.4" selected>1.4x</option>');
  assertStringIncludes(html, '<option value="1.35" selected>1.35x</option>');
  assertStringIncludes(html, '<option value="deepdive,direct" selected>');
  assertStringIncludes(html, '<option value="explain" selected>');

  // In-place save via send() (which uses fetch(assertSameOriginPath(path))) with zero page reload
  const submitStart = html.indexOf('sourcesList.addEventListener("submit"');
  assert(submitStart > 0, "account client must wire delegated submit handler for source-prefs");
  const submitEnd = html.indexOf('const opmlImportForm = $("opmlImportForm");', submitStart);
  const submitBlock = html.slice(submitStart, submitEnd);
  assertStringIncludes(submitBlock, '"/api/account/sources/"');
  assertStringIncludes(submitBlock, '"/preferences"');
  assert(!submitBlock.includes("location.reload"), "saving feed defaults must not reload the page");

  // Add tab: private Email-to-Podcast forwarding address with Copy button (no cross-user leak)
  const expectedEmail = `save+${me.feedToken}@audio.example.com`;
  assertStringIncludes(html, 'id="emailIngestBox"');
  assertStringIncludes(html, `<code>${expectedEmail}</code>`);
  assertStringIncludes(html, `data-copy="${expectedEmail}"`);
  assert(!html.includes(other.feedToken), "another user's feedToken must never appear");
});

// ---------------------------------------------------------------------------
// 4. /listen/ Player Show-Default Playback Speed & D1 Sync Compatibility
// ---------------------------------------------------------------------------

Deno.test("GET /listen/:token serializes sourcePlaybackRates & episode sourceId and obeys strict CSP", async () => {
  const t = createHarness();
  const user = await t.seedUser({
    id: "u-listen",
    displayName: "Listener",
    feedToken: "tok-listen-defaults",
    status: "approved",
  });
  await t.stores.metadata.putSource(
    makeSource({ id: "news", userId: user.id, title: "Fast News", playbackRate: 1.4 }),
  );
  await t.stores.metadata.putSource(
    makeSource({ id: "essay", userId: user.id, title: "Essays" }),
  );
  await t.stores.metadata.putSource(
    makeSource({ id: "corrupt", userId: user.id, title: "Corrupt", playbackRate: 99 }),
  );
  await t.stores.metadata.putArticle(
    makeArticle({ id: "a1", userId: user.id, sourceId: "news", title: "News 1" }),
  );
  await t.stores.metadata.putArticle(
    makeArticle({ id: "a2", userId: user.id, sourceId: "essay", title: "Essay 1" }),
  );
  await t.stores.metadata.putEpisode(
    makeEpisode({
      id: "e1",
      userId: user.id,
      sourceId: "news",
      articleId: "a1",
      title: "News 1",
      status: "ready",
      audioKey: "audio/u-listen/direct/e1.mp3",
      contentType: "audio/mpeg",
    }),
  );
  await t.stores.metadata.putEpisode(
    makeEpisode({
      id: "e2",
      userId: user.id,
      sourceId: "essay",
      articleId: "a2",
      title: "Essay 1",
      status: "ready",
      audioKey: "audio/u-listen/direct/e2.mp3",
      contentType: "audio/mpeg",
    }),
  );

  const res = await t.fetch(new Request(`${BASE}/listen/${user.feedToken}`));
  assertEquals(res.status, 200);
  const html = await res.text();

  // Strict CSP invariants
  assert(!/\bstyle\s*=/i.test(html), "/listen/ HTML must have zero inline style attributes");
  assert(!/\bon[a-z]+\s*=/i.test(html), "/listen/ HTML must have zero inline event handlers");
  assertStringIncludes(html, 'id="rateShowBadge"');
  assertStringIncludes(html, '<option value="0.8">');
  assertStringIncludes(html, '<option value="1.2">');
  assertStringIncludes(html, '<option value="1.4">');

  const data = playerData(html) as {
    episodes?: Array<{ id: string; sourceId?: string }>;
    sourcePlaybackRates?: Record<string, number>;
  };
  assertEquals(data.sourcePlaybackRates, { news: 1.4 }, "only valid source playbackRates serialized");
  const epById = new Map((data.episodes ?? []).map((e) => [e.id, e]));
  assertEquals(epById.get("e1")?.sourceId, "news");
  assertEquals(epById.get("e2")?.sourceId, "essay");

  // Shipped asset checks (listen.js + listen.css in bundle.ts)
  const client = await playerClient(t.fetch, BASE, html);
  assert(!client.includes(".innerHTML"), "listen.js must never assign .innerHTML");
  // D1 sync must persist globalPlaybackRate (never an automatic show default)
  assertStringIncludes(client, "payload.playbackRate = globalPlaybackRate;");
  assertStringIncludes(client, "sessionShowRateOverrides.set(current.sourceId, rounded);");
  assertStringIncludes(client, "applyPlaybackRateForCurrentEpisode();");
  assertStringIncludes(client, '× (show)');

  const css = assetBody("listen.css") ?? "";
  assertStringIncludes(css, ".rate-wrap");
  assertStringIncludes(css, '.rate[data-source-default="true"]');
  assertStringIncludes(css, ".rate-show-badge");
});

Deno.test("shipped listen.js resolveEpisodePlaybackRate enforces session override > show default > global rate cleanly", () => {
  const listenJs = assetBody("listen.js") ?? "";
  const startIdx = listenJs.indexOf("function formatPlaybackRate(");
  const endIdx = listenJs.indexOf("/** @param {number} value */\nfunction ensureRateOption(");
  assert(startIdx > 0 && endIdx > startIdx, "listen.js must define playback rate helpers");
  const snippet = listenJs.slice(startIdx, endIdx);
  const extract = new Function(
    `${snippet}\nreturn { formatPlaybackRate, resolveEpisodePlaybackRate };`,
  ) as () => {
    formatPlaybackRate: (v: number) => string;
    resolveEpisodePlaybackRate: (
      sourceId: string | undefined,
      sourceRates: Record<string, number>,
      sessionOverrides: Map<string, number>,
      globalRate: number,
    ) => { rate: number; isShowDefault: boolean };
  };
  const { formatPlaybackRate, resolveEpisodePlaybackRate } = extract();

  const sourceRates: Record<string, number> = {
    news: 1.4,
    tech: 1.1,
    badLow: 0.1,
    badHigh: 5.0,
  };
  const overrides = new Map<string, number>();

  assertEquals(formatPlaybackRate(1.4), "1.4");
  assertEquals(formatPlaybackRate(1.0), "1");
  assertEquals(formatPlaybackRate(1.75), "1.75");

  // 1. Show with default speed uses show default and marks isShowDefault = true.
  assertEquals(resolveEpisodePlaybackRate("news", sourceRates, overrides, 1.25), {
    rate: 1.4,
    isShowDefault: true,
  });

  // 2. Show without default speed falls back to global rate with isShowDefault = false.
  assertEquals(resolveEpisodePlaybackRate("essays", sourceRates, overrides, 1.25), {
    rate: 1.25,
    isShowDefault: false,
  });

  // 3. Switching to another show with its own default applies that show's default.
  assertEquals(resolveEpisodePlaybackRate("tech", sourceRates, overrides, 1.25), {
    rate: 1.1,
    isShowDefault: true,
  });

  // 4. Manual override during the session overrides ONLY that show; other shows keep their defaults.
  overrides.set("news", 1.75);
  assertEquals(resolveEpisodePlaybackRate("news", sourceRates, overrides, 1.75), {
    rate: 1.75,
    isShowDefault: false,
  });
  assertEquals(resolveEpisodePlaybackRate("tech", sourceRates, overrides, 1.75), {
    rate: 1.1,
    isShowDefault: true,
  });

  // 5. Out-of-range or prototype keys safely fall back to global rate.
  assertEquals(resolveEpisodePlaybackRate("badLow", sourceRates, overrides, 1.25), {
    rate: 1.25,
    isShowDefault: false,
  });
  assertEquals(resolveEpisodePlaybackRate("badHigh", sourceRates, overrides, 1.25), {
    rate: 1.25,
    isShowDefault: false,
  });
  assertEquals(resolveEpisodePlaybackRate("toString", sourceRates, overrides, 1.25), {
    rate: 1.25,
    isShowDefault: false,
  });
  assertEquals(resolveEpisodePlaybackRate(undefined, sourceRates, overrides, 1.25), {
    rate: 1.25,
    isShowDefault: false,
  });
});
