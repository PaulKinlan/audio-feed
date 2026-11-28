/**
 * End-to-end tests for Extra Narration Styles (Item 2.3 / Issue #54):
 * - Effective style resolution (`episode.narrationStyle ?? source?.narrationStyle ?? "standard"`)
 * - Cloudflare Workflows (`runEpisodeSynthesisWorkflow`) & legacy worker (`createGeminiSynthesizer` /
 *   `runSynthesisBatch`) for `"standard"`, `"brief"` (3-Min Brief), and `"walkthrough"`
 *   (Technical Walkthrough), covering both deterministic offline fallback and detached-fetch LLM paths
 * - Exact preservation of `DEFAULT_NARRATION_STYLE` and segment hashes for `"standard"`
 * - API validation & D1 persistence across `POST /api/ingest`, `POST /api/upload`,
 *   `POST /api/account/sources`, `POST /api/sources`, `GET /api/sources`,
 *   `POST /api/account/sources/:sourceId/preferences`, and `pollFeedSource` propagation
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp, type AppContext } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { pollFeedSource } from "../src/ingest/feed.ts";
import type { ExtractedArticle } from "../src/ingest/url.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import type { D1DatabaseLike } from "../src/storage/d1/types.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "../src/storage/memory.ts";
import { collect } from "../src/storage/mod.ts";
import { inspectMp3Stream } from "../src/storage/mp3_assembly.ts";
import {
  DEFAULT_NARRATION_STYLE,
  formatNarrationPrompt,
  GeminiTtsClient,
  pcmToWav,
  uint8ArrayToBase64,
} from "../src/tts/gemini.ts";
import { NARRATION_STYLES } from "../src/tts/styles.ts";
import { type Episode, segmentTextHash, type User } from "../src/types.ts";
import {
  createGeminiSynthesizer,
  resolveNarrationStyle,
  runSynthesisBatch,
} from "../src/worker/synthesis.ts";
import {
  runEpisodeSynthesisWorkflow,
  type WorkflowStepConfigLike,
  type WorkflowStepLike,
} from "../src/worker/synthesis_workflow.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { createTestD1 } from "./sqlite_d1.ts";

const BASE = "https://audio.example.com";

const dummyEnv = {
  DB: {} as unknown as D1DatabaseLike,
  GEMINI_API_KEY: "test-key",
  PUBLIC_BASE_URL: BASE,
};

interface CapturedTtsRequest {
  text: string;
  style?: string;
  styleCamel?: string;
  voice?: string;
}

function toneWavResponse(durationSeconds = 0.6, freqHz = 240): Response {
  const sr = 24_000;
  const samples = Math.round(sr * durationSeconds);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(9_000 * Math.sin((2 * Math.PI * freqHz * i) / sr)), true);
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

function createCapturingTtsClient(): {
  client: GeminiTtsClient;
  requests: CapturedTtsRequest[];
} {
  const requests: CapturedTtsRequest[] = [];
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        contents?: Array<{
          parts?: Array<{
            text?: string;
            speech_metadata?: { style?: string };
            speechMetadata?: { style?: string };
          }>;
        }>;
        generationConfig?: {
          speechConfig?: {
            voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } };
          };
        };
      };
      const part = payload.contents?.[0]?.parts?.[0];
      requests.push({
        text: part?.text ?? "",
        style: part?.speech_metadata?.style,
        styleCamel: part?.speechMetadata?.style,
        voice: payload.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName,
      });
      return Promise.resolve(toneWavResponse(0.6, 220 + requests.length * 30));
    },
  });
  return { client, requests };
}

function createFakeWorkflowStep(): {
  step: WorkflowStepLike;
  resultsByName: Map<string, unknown>;
} {
  const resultsByName = new Map<string, unknown>();
  const step: WorkflowStepLike = {
    async do<T>(
      name: string,
      configOrFn: WorkflowStepConfigLike | (() => Promise<T>),
      maybeFn?: () => Promise<T>,
    ): Promise<T> {
      const fn = typeof configOrFn === "function" ? configOrFn : maybeFn!;
      const value = await fn();
      // Round-trip through JSON to guarantee Cloudflare Workflows step serialization compatibility.
      const serialized = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      resultsByName.set(name, serialized);
      return serialized as T;
    },
    async sleepUntil(): Promise<void> {},
  };
  return { step, resultsByName };
}

function makeLongTechnicalArticleBody(): string {
  const filler =
    "Distributed edge services rely on bounded queues, predictable tail latency, and streaming I/O to remain fast under load. ";
  return [
    "## Executive Overview",
    "Core thesis: streaming edge synthesis cuts worker memory usage by an order of magnitude while improving time to first byte. " +
    filler.repeat(26),
    "```ts\nexport async function fetchUser(id: string): Promise<Record<string, unknown>> {\n  const res = await fetch('https://api.example.com/users/' + id);\n  return res.json();\n}\n```",
    "## Storage Architecture",
    "The key architectural decision is assembling normalized MP3 frames straight into R2 multipart uploads. " +
    filler.repeat(26),
    "```sql\nSELECT id, title FROM episodes WHERE status = 'ready' ORDER BY created_at DESC;\n```",
    "## Takeaway",
    "In conclusion, streaming pipelines eliminate buffer spikes and keep podcasts dependable at scale.",
  ].join("\n\n");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Engineering Notes</title><link>https://eng.example.com</link>
<item><title>Post One</title><link>https://eng.example.com/post-1</link><pubDate>Thu, 26 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Post Two</title><link>https://eng.example.com/post-2</link><pubDate>Fri, 27 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const SAMPLE_RSS_WITH_THIRD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Engineering Notes</title><link>https://eng.example.com</link>
<item><title>Post Three</title><link>https://eng.example.com/post-3</link><pubDate>Sat, 28 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Post Two</title><link>https://eng.example.com/post-2</link><pubDate>Fri, 27 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Post One</title><link>https://eng.example.com/post-1</link><pubDate>Thu, 26 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

function createApiHarness(opts: {
  stores?: Stores;
  rss?: string;
} = {}) {
  const stores = opts.stores ?? memoryStores();
  const config: AppConfig = {
    port: 8000,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
  };
  const ctx: AppContext = { config, stores };
  const rssXml = opts.rss ?? SAMPLE_RSS;
  const fetchArticle = (url: string): Promise<ExtractedArticle> =>
    Promise.resolve({
      url,
      title: `Article for ${new URL(url).pathname}`,
      author: "Ada Lovelace",
      publishedAt: "2026-11-27T08:00:00.000Z",
      lead: "Opening thesis of the extracted article.",
      body:
        "Opening thesis of the extracted article with plenty of readable content to pass all length thresholds cleanly.",
    });
  const feedTransport = (_url: URL, _signal: AbortSignal): Promise<Response> =>
    Promise.resolve(
      new Response(rssXml, {
        status: 200,
        headers: { "content-type": "application/rss+xml; charset=utf-8" },
      }),
    );

  const { fetch } = createApp(ctx, createHandlers(ctx, { fetchArticle, feedTransport }));

  const seedUser = async (overrides: Partial<User> = {}) => {
    const user = makeUser({ id: "user-1", email: "reader@example.com", ...overrides });
    await stores.metadata.putUser(user);
    return user;
  };
  const cookieFor = async (userId: string) =>
    `${SESSION_COOKIE}=${await createSession(stores.metadata, userId)}`;

  return { fetch, stores, ctx, seedUser, cookieFor, fetchArticle, feedTransport };
}

// ---------------------------------------------------------------------------
// 1. Style Resolution Precedence
// ---------------------------------------------------------------------------

Deno.test("resolveNarrationStyle: enforces episode > source > standard precedence and guards invalid data", () => {
  assertEquals(resolveNarrationStyle(undefined, undefined), "standard");
  assertEquals(resolveNarrationStyle({ narrationStyle: undefined }, { narrationStyle: undefined }), "standard");
  assertEquals(resolveNarrationStyle({ narrationStyle: undefined }, { narrationStyle: "brief" }), "brief");
  assertEquals(
    resolveNarrationStyle({ narrationStyle: "walkthrough" }, { narrationStyle: "brief" }),
    "walkthrough",
  );
  assertEquals(
    resolveNarrationStyle({ narrationStyle: "standard" }, { narrationStyle: "brief" }),
    "standard",
    "explicit episode standard style must override source brief default",
  );
  // Defensive fallback for malformed JSON values
  assertEquals(
    resolveNarrationStyle(
      { narrationStyle: "corrupt" as unknown as Episode["narrationStyle"] },
      { narrationStyle: "walkthrough" },
    ),
    "walkthrough",
  );
  assertEquals(
    resolveNarrationStyle(
      { narrationStyle: "corrupt" as unknown as Episode["narrationStyle"] },
      { narrationStyle: "also-bad" as unknown as Episode["narrationStyle"] },
    ),
    "standard",
  );
});

// ---------------------------------------------------------------------------
// 2. Cloudflare Workflows Synthesis Pipeline (`synthesis_workflow.ts`)
// ---------------------------------------------------------------------------

Deno.test("Workflow synthesis: 'brief' condenses long article, passes brief ttsStyle, and produces valid MP3", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1", title: "Inbox" }));
  const longBody = makeLongTechnicalArticleBody();
  assert(countWords(longBody) > 850, `fixture must be long, got ${countWords(longBody)} words`);

  await metadata.putArticle(
    makeArticle({
      id: "a-brief",
      userId: "u1",
      sourceId: "inbox",
      title: "Streaming Edge Synthesis",
      content: longBody,
      excerpt: "Core thesis excerpt.",
    }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-brief",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a-brief",
      status: "pending",
      mode: "direct",
      narrationStyle: "brief",
    }),
  );

  const { client, requests } = createCapturingTtsClient();
  const { step, resultsByName } = createFakeWorkflowStep();
  const res = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-brief", userId: "u1" }, instanceId: "inst-brief" },
    step,
    { metadata, blobs, ttsClient: client, scriptGenerator: null },
  );

  assertEquals(res.status, "ready");
  assert(requests.length >= 1, "expected at least one TTS request");
  const combinedSpoken = requests.map((r) => r.text).join("\n\n");
  assert(
    countWords(combinedSpoken) < 520,
    `brief must condense long article well below original (${countWords(combinedSpoken)} words)`,
  );
  assertStringIncludes(combinedSpoken, "Core thesis: streaming edge synthesis");
  assertEquals(combinedSpoken.includes("fetchUser"), false, "brief must strip raw code blocks");

  for (const req of requests) {
    assertEquals(req.style, NARRATION_STYLES.brief.ttsStyle);
    assertEquals(req.styleCamel, NARRATION_STYLES.brief.ttsStyle);
  }

  const plan = resultsByName.get("prepare-plan") as Array<{ ttsStyle?: string }>;
  assertEquals(plan[0]?.ttsStyle, NARRATION_STYLES.brief.ttsStyle);

  const ep = await metadata.getEpisode("u1", "ep-wf-brief");
  assertEquals(ep?.status, "ready");
  assertEquals(ep?.contentType, "audio/mpeg");
  assert(ep?.audioKey?.endsWith(".mp3"));
  const mp3Bytes = await collect((await blobs.get(ep!.audioKey!))!.body);
  assertEquals(inspectMp3Stream(mp3Bytes).valid, true);
});

Deno.test("Workflow synthesis: 'walkthrough' explains code blocks in speech (inherited from source), uses walkthrough ttsStyle, and produces valid MP3", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(
    makeSource({
      id: "eng-blog",
      userId: "u1",
      title: "Engineering Blog",
      narrationStyle: "walkthrough",
      codeHandling: "skip", // walkthrough must still explain code blocks!
    }),
  );

  const techBody = [
    "Here is how we fetch a user record over HTTP:",
    "```ts\nexport async function fetchUser(id: string): Promise<Record<string, unknown>> {\n  const res = await fetch('https://api.example.com/users/' + id);\n  return res.json();\n}\n```",
    "Next, we query the database for published episodes:",
    "```sql\nSELECT id, title FROM episodes WHERE status = 'ready' ORDER BY created_at DESC;\n```",
    "Finally, we return the result to the client.",
  ].join("\n\n");

  await metadata.putArticle(
    makeArticle({
      id: "a-walk",
      userId: "u1",
      sourceId: "eng-blog",
      title: "API Walkthrough",
      content: techBody,
    }),
  );
  // Episode omits narrationStyle -> inherits "walkthrough" from source!
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-walk",
      userId: "u1",
      sourceId: "eng-blog",
      articleId: "a-walk",
      status: "pending",
      mode: "direct",
      narrationStyle: undefined,
    }),
  );

  const { client, requests } = createCapturingTtsClient();
  const { step } = createFakeWorkflowStep();
  const res = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-walk", userId: "u1" }, instanceId: "inst-walk" },
    step,
    { metadata, blobs, ttsClient: client, scriptGenerator: null },
  );

  assertEquals(res.status, "ready");
  assert(requests.length >= 1);
  const spoken = requests.map((r) => r.text).join("\n\n");
  assertStringIncludes(spoken, "Here is what that code does:");
  assertStringIncludes(spoken, "fetchUser");
  assertStringIncludes(spoken, "SQL statement");
  assertEquals(spoken.includes("```"), false, "raw code fences must not be spoken");
  assertEquals(spoken.includes("res.json()"), false, "raw code syntax must not be spoken");

  for (const req of requests) {
    assertEquals(req.style, NARRATION_STYLES.walkthrough.ttsStyle);
    assertEquals(req.styleCamel, NARRATION_STYLES.walkthrough.ttsStyle);
  }

  const ep = await metadata.getEpisode("u1", "ep-wf-walk");
  assertEquals(ep?.status, "ready");
  assertEquals(ep?.contentType, "audio/mpeg");
  const mp3Bytes = await collect((await blobs.get(ep!.audioKey!))!.body);
  assertEquals(inspectMp3Stream(mp3Bytes).valid, true);
});

Deno.test("Workflow synthesis: 'standard' preserves DEFAULT_NARRATION_STYLE and exact legacy segment hashes", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1", title: "Inbox" }));
  const content = "Plain prose paragraph.\n\n```ts\nconst skipped = 42;\n```\n\nClosing sentence.";
  await metadata.putArticle(
    makeArticle({
      id: "a-std",
      userId: "u1",
      sourceId: "inbox",
      title: "Standard Read",
      author: "Ben Thompson",
      publishedAt: "2026-11-27T08:00:00.000Z",
      content,
    }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-std",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a-std",
      status: "pending",
      mode: "direct",
      narrationStyle: "standard",
    }),
  );

  const { client, requests } = createCapturingTtsClient();
  const { step, resultsByName } = createFakeWorkflowStep();
  const res = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-std", userId: "u1" }, instanceId: "inst-std" },
    step,
    { metadata, blobs, ttsClient: client, scriptGenerator: null },
  );

  assertEquals(res.status, "ready");
  assertEquals(requests.length, 1);
  assertEquals(requests[0]!.style, DEFAULT_NARRATION_STYLE);
  assertEquals(requests[0]!.styleCamel, DEFAULT_NARRATION_STYLE);
  assertEquals(requests[0]!.text.includes("skipped"), false);

  const expectedPrompt = formatNarrationPrompt({
    title: "Standard Read",
    author: "Ben Thompson",
    publishedAt: "2026-11-27T08:00:00.000Z",
    sourceName: "Inbox",
    body: "Plain prose paragraph.\n\nClosing sentence.",
    voice: "Charon",
  });
  const plan = resultsByName.get("prepare-plan") as Array<{
    textKey: string;
    text: string;
    ttsStyle?: string;
  }>;
  assertEquals(plan.length, 1);
  assertEquals(plan[0]!.ttsStyle, undefined, "standard style must omit ttsStyle for backward compatibility");
  assertEquals(plan[0]!.textKey, expectedPrompt);
  assertEquals(segmentTextHash(plan[0]!.textKey), segmentTextHash(expectedPrompt));
});

Deno.test("Workflow synthesis: uses Gemini LLM via detached styleFetchFn + GEMINI_API_BASE_URL and falls back cleanly on error", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(makeSource({ id: "inbox", userId: "u1", title: "Inbox" }));
  await metadata.putArticle(
    makeArticle({
      id: "a-llm",
      userId: "u1",
      sourceId: "inbox",
      title: "LLM Brief Test",
      content: makeLongTechnicalArticleBody(),
    }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-llm",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a-llm",
      status: "pending",
      mode: "direct",
      narrationStyle: "brief",
    }),
  );

  const seenUrls: string[] = [];
  const seenKeys: string[] = [];
  const customBrief =
    "This executive brief summarizes how streaming edge audio synthesis cuts memory usage dramatically while preserving broadcast quality across every episode. Listeners receive fast delivery, crisp chapters, and reliable cloud playback without server memory pressure.";
  const detachedStyleFetch = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (this !== undefined) throw new TypeError("Illegal invocation: fetch must be detached");
    seenUrls.push(String(input));
    const headers = init?.headers as Record<string, string>;
    seenKeys.push(headers["x-goog-api-key"] ?? "");
    return Promise.resolve(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: customBrief }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  } as typeof fetch;

  const { client, requests } = createCapturingTtsClient();
  const { step } = createFakeWorkflowStep();
  const res = await runEpisodeSynthesisWorkflow(
    { ...dummyEnv, GEMINI_API_BASE_URL: "https://gemini-proxy.example.test" },
    { payload: { episodeId: "ep-wf-llm", userId: "u1" }, instanceId: "inst-llm" },
    step,
    {
      metadata,
      blobs,
      ttsClient: client,
      scriptGenerator: null,
      styleFetchFn: detachedStyleFetch,
    },
  );

  assertEquals(res.status, "ready");
  assertEquals(seenUrls.length, 1);
  assert(seenUrls[0]!.startsWith("https://gemini-proxy.example.test/v1beta/models/"));
  assertEquals(seenUrls[0]!.includes("test-key"), false, "API key must never appear in URL");
  assertEquals(seenKeys, ["test-key"]);
  assertStringIncludes(requests[0]!.text, "This executive brief summarizes how streaming edge audio");
  assertEquals(requests[0]!.style, NARRATION_STYLES.brief.ttsStyle);

  // Now verify clean deterministic fallback when styleFetchFn returns 503
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-fallback",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a-llm",
      status: "pending",
      mode: "direct",
      narrationStyle: "brief",
    }),
  );
  const { client: fbClient, requests: fbReqs } = createCapturingTtsClient();
  const { step: fbStep } = createFakeWorkflowStep();
  const fbRes = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-fallback", userId: "u1" }, instanceId: "inst-fb" },
    fbStep,
    {
      metadata,
      blobs,
      ttsClient: fbClient,
      scriptGenerator: null,
      styleFetchFn: () => Promise.resolve(new Response("unavailable", { status: 503 })),
    },
  );
  assertEquals(fbRes.status, "ready");
  assert(fbReqs.length >= 1, "expected at least one fallback TTS request");
  const fbSpoken = fbReqs.map((r) => r.text).join("\n\n");
  assertStringIncludes(fbSpoken, "Core thesis: streaming edge synthesis");
  for (const req of fbReqs) {
    assertEquals(req.style, NARRATION_STYLES.brief.ttsStyle);
    assertEquals(req.styleCamel, NARRATION_STYLES.brief.ttsStyle);
  }
});

Deno.test("Workflow synthesis: deepdive mode ignores narrationStyle and synthesizes multi-speaker dialogue", async () => {
  const metadata = new MemoryMetadataStore();
  const blobs = new MemoryBlobStore();
  await metadata.putUser(makeUser({ id: "u1", status: "approved" }));
  await metadata.putSource(
    makeSource({ id: "inbox", userId: "u1", title: "Inbox", narrationStyle: "brief" }),
  );
  await metadata.putArticle(
    makeArticle({
      id: "a-dd",
      userId: "u1",
      sourceId: "inbox",
      title: "Deep Dive Topic",
      content: "A thoughtful discussion of audio architectures and streaming edge pipelines.",
    }),
  );
  await metadata.putEpisode(
    makeEpisode({
      id: "ep-wf-dd",
      userId: "u1",
      sourceId: "inbox",
      articleId: "a-dd",
      status: "pending",
      mode: "deepdive",
      narrationStyle: "brief",
    }),
  );

  let styleCalls = 0;
  let sawMultiSpeaker = false;
  const ttsClient = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        generationConfig?: { speechConfig?: { multiSpeakerVoiceConfig?: unknown } };
      };
      if (payload.generationConfig?.speechConfig?.multiSpeakerVoiceConfig) {
        sawMultiSpeaker = true;
      }
      return Promise.resolve(toneWavResponse(0.6, 260));
    },
  });
  const { step } = createFakeWorkflowStep();
  const res = await runEpisodeSynthesisWorkflow(
    dummyEnv,
    { payload: { episodeId: "ep-wf-dd", userId: "u1" }, instanceId: "inst-dd" },
    step,
    {
      metadata,
      blobs,
      ttsClient,
      scriptGenerator: null,
      styleFetchFn: () => {
        styleCalls++;
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      },
    },
  );
  assertEquals(res.status, "ready");
  assertEquals(styleCalls, 0, "deepdive mode must not call narration style LLM");
  assertEquals(sawMultiSpeaker, true, "deepdive mode must still send multi-speaker dialogue");
});

// ---------------------------------------------------------------------------
// 3. Legacy Synthesis Pipeline (`src/worker/synthesis.ts`)
// ---------------------------------------------------------------------------

Deno.test("Legacy synthesis (createGeminiSynthesizer + runSynthesisBatch): supports 'brief', 'walkthrough', and 'standard'", async () => {
  const stores = memoryStores();
  const user = makeUser({ id: "u-leg", status: "approved" });
  await stores.metadata.putUser(user);
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: user.id, title: "Inbox" }));
  const longBody = makeLongTechnicalArticleBody();
  await stores.metadata.putArticle(
    makeArticle({
      id: "a-leg",
      userId: user.id,
      sourceId: "inbox",
      title: "Legacy Style Article",
      content: longBody,
    }),
  );

  // Brief episode — even with tight maxInputBytes below raw article size, brief condenses and succeeds!
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-leg-brief",
      userId: user.id,
      sourceId: "inbox",
      articleId: "a-leg",
      status: "pending",
      mode: "direct",
      narrationStyle: "brief",
    }),
  );
  // Walkthrough episode
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-leg-walk",
      userId: user.id,
      sourceId: "inbox",
      articleId: "a-leg",
      status: "pending",
      mode: "direct",
      narrationStyle: "walkthrough",
    }),
  );
  // Standard episode
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-leg-std",
      userId: user.id,
      sourceId: "inbox",
      articleId: "a-leg",
      status: "pending",
      mode: "direct",
      narrationStyle: "standard",
    }),
  );

  const ctx: AppContext = {
    config: { port: 8000, publicBaseUrl: BASE, geminiApiKey: "test-key" },
    stores,
  };

  const { client, requests } = createCapturingTtsClient();
  const synthesizer = createGeminiSynthesizer(ctx, { client, scriptGenerator: null });
  const batch = await runSynthesisBatch(ctx, synthesizer, {
    owner: "legacy-style-worker",
    batchSize: 5,
    // Deliberately smaller than raw longBody (> 6 KB) so the brief pre-check exemption is verified,
    // while keeping walkthrough/standard inside limit (longBody is ~6.8 KB -> allow 20 KB for walk/std).
    maxInputBytes: 20_000,
  });

  assertEquals(batch.failed, []);
  assertEquals(batch.ready.length, 3);

  const briefReqs = requests.filter((r) => r.style === NARRATION_STYLES.brief.ttsStyle);
  const walkReqs = requests.filter((r) => r.style === NARRATION_STYLES.walkthrough.ttsStyle);
  const stdReqs = requests.filter((r) => r.style === DEFAULT_NARRATION_STYLE);

  assert(briefReqs.length >= 1, "expected brief TTS request");
  assert(walkReqs.length >= 1, "expected walkthrough TTS request");
  assert(stdReqs.length >= 1, "expected standard TTS request");

  const briefSpoken = briefReqs.map((r) => r.text).join("\n\n");
  assert(countWords(briefSpoken) < 520, "legacy brief must condense long text");
  assertEquals(briefSpoken.includes("fetchUser"), false, "legacy brief must strip code");

  const walkSpoken = walkReqs.map((r) => r.text).join("\n\n");
  assertStringIncludes(walkSpoken, "Here is what that code does:");
  assertStringIncludes(walkSpoken, "fetchUser");
  assertStringIncludes(walkSpoken, "SQL statement");
  assertEquals(walkSpoken.includes("```"), false);

  const stdSpoken = stdReqs.map((r) => r.text).join("\n\n");
  assertEquals(stdSpoken.includes("fetchUser"), false, "standard must skip code by default");
  assertEquals(stdSpoken.includes("Here is what that code does:"), false);

  // Verify brief bypasses raw maxInputBytes pre-check even when raw article exceeds maxInputBytes
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-leg-brief-oversize",
      userId: user.id,
      sourceId: "inbox",
      articleId: "a-leg",
      status: "pending",
      mode: "direct",
      narrationStyle: "brief",
    }),
  );
  const { client: c2, requests: r2 } = createCapturingTtsClient();
  const synth2 = createGeminiSynthesizer(ctx, { client: c2, scriptGenerator: null });
  const batch2 = await runSynthesisBatch(ctx, synth2, {
    owner: "legacy-brief-tight",
    batchSize: 2,
    maxInputBytes: 500, // much smaller than raw longBody (~6.8 KB)
  });
  assertEquals(batch2.failed, []);
  assertEquals(batch2.ready.length, 1);
  assertEquals(r2[0]!.style, NARRATION_STYLES.brief.ttsStyle);
});

Deno.test("Legacy synthesis: styleFetchFn passes detached fetch and x-goog-api-key for walkthrough code explanation", async () => {
  const stores = memoryStores();
  const user = makeUser({ id: "u-llm-leg", status: "approved" });
  await stores.metadata.putUser(user);
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: user.id }));
  await stores.metadata.putArticle(
    makeArticle({
      id: "a-code",
      userId: user.id,
      sourceId: "inbox",
      title: "Code Demo",
      content: "Intro text.\n\n```ts\nexport const add = (a: number, b: number) => a + b;\n```\n\nDone.",
    }),
  );
  const ep = makeEpisode({
    id: "ep-code-llm",
    userId: user.id,
    sourceId: "inbox",
    articleId: "a-code",
    status: "pending",
    mode: "direct",
    narrationStyle: "walkthrough",
  });
  await stores.metadata.putEpisode(ep);

  let llmCalls = 0;
  let capturedKey = "";
  const ctx: AppContext = {
    config: { port: 8000, publicBaseUrl: BASE, geminiApiKey: "secret-style-key" },
    env: { get: (k) => k === "GEMINI_API_BASE_URL" ? "https://style-llm.example.test" : undefined },
    stores,
  };
  const { client, requests } = createCapturingTtsClient();
  const synth = createGeminiSynthesizer(ctx, {
    client,
    scriptGenerator: null,
    styleFetchFn: (function (this: unknown, url: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      llmCalls++;
      assertStringIncludes(String(url), "https://style-llm.example.test/v1beta/models/");
      capturedKey = ((init?.headers as Record<string, string>)["x-goog-api-key"]) ?? "";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{
              content: { parts: [{ text: "Defines a helper function that adds two numbers." }] },
            }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch,
  });

  const batch = await runSynthesisBatch(ctx, synth, { owner: "llm-walk-worker" });
  assertEquals(batch.ready.length, 1);
  assertEquals(llmCalls, 1);
  assertEquals(capturedKey, "secret-style-key");
  assertStringIncludes(requests[0]!.text, "Here is what that code does: Defines a helper function that adds two numbers.");
  assertEquals(requests[0]!.style, NARRATION_STYLES.walkthrough.ttsStyle);
});

// ---------------------------------------------------------------------------
// 4. API Validation, Persistence & Propagation (Memory + D1 SQLite)
// ---------------------------------------------------------------------------

Deno.test("POST /api/ingest & POST /api/upload: validate and persist narrationStyle on created Episode", async () => {
  const t = createApiHarness();
  const user = await t.seedUser();
  const cookie = await t.cookieFor(user.id);

  // Invalid narrationStyle values rejected with 400 before queueing anything
  for (const invalid of ["invalid", "BRIEF", "   ", 42, true, { style: "brief" }]) {
    const res = await t.fetch(
      new Request(`${BASE}/api/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: BASE,
        },
        body: JSON.stringify({
          url: "https://example.com/article",
          mode: "direct",
          narrationStyle: invalid,
        }),
      }),
    );
    assertEquals(res.status, 400, `invalid narrationStyle ${JSON.stringify(invalid)} must 400`);
  }
  assertEquals((await t.stores.metadata.listEpisodes({ userId: user.id })).length, 0);

  // Valid styles ("brief", "walkthrough", "standard") and omitted default
  for (const style of ["brief", "walkthrough", "standard", undefined] as const) {
    const res = await t.fetch(
      new Request(`${BASE}/api/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: BASE,
        },
        body: JSON.stringify({
          url: `https://example.com/post-${style ?? "default"}`,
          mode: "direct",
          ...(style ? { narrationStyle: style } : {}),
        }),
      }),
    );
    assertEquals(res.status, 202);
    const body = await res.json();
    assertEquals(body.narrationStyle, style);
    const stored = await t.stores.metadata.getEpisode(user.id, body.episodeId);
    assertEquals(stored?.narrationStyle, style);
  }

  // POST /api/upload validates and persists narrationStyle as well
  const badForm = new FormData();
  badForm.append("file", new File(["Enough readable prose ".repeat(10)], "notes.txt", { type: "text/plain" }));
  badForm.append("mode", "direct");
  badForm.append("narrationStyle", "invalid-style");
  const badUpload = await t.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { cookie, origin: BASE },
      body: badForm,
    }),
  );
  assertEquals(badUpload.status, 400);

  const okForm = new FormData();
  okForm.append("file", new File(["Enough readable prose ".repeat(10)], "notes.txt", { type: "text/plain" }));
  okForm.append("mode", "direct");
  okForm.append("narrationStyle", "walkthrough");
  const okUpload = await t.fetch(
    new Request(`${BASE}/api/upload`, {
      method: "POST",
      headers: { cookie, origin: BASE },
      body: okForm,
    }),
  );
  assertEquals(okUpload.status, 202);
  const uploadBody = await okUpload.json();
  assertEquals(uploadBody.narrationStyle, "walkthrough");
  const uploadedEp = await t.stores.metadata.getEpisode(user.id, uploadBody.episodeId);
  assertEquals(uploadedEp?.narrationStyle, "walkthrough");
});

Deno.test("POST /api/account/sources & POST /api/sources: validate narrationStyle, store on Source, and propagate to initial episodes", async () => {
  const t = createApiHarness();
  const user = await t.seedUser({ feedToken: "tok-sub" });
  const cookie = await t.cookieFor(user.id);

  // Invalid narrationStyle rejected with 400 on both /api/account/sources and /api/sources
  const badAcct = await t.fetch(
    new Request(`${BASE}/api/account/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({
        feedUrl: "https://eng.example.com/feed.xml",
        modes: ["direct"],
        narrationStyle: "podcast",
      }),
    }),
  );
  assertEquals(badAcct.status, 400);

  const badApi = await t.fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-feed-token": user.feedToken },
      body: JSON.stringify({
        feedUrl: "https://eng.example.com/feed.xml",
        modes: ["direct"],
        narrationStyle: "WALKTHROUGH",
      }),
    }),
  );
  assertEquals(badApi.status, 400);
  assertEquals((await t.stores.metadata.listSources(user.id)).length, 0);

  // Valid subscription via /api/account/sources with "brief"
  const subRes = await t.fetch(
    new Request(`${BASE}/api/account/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: BASE },
      body: JSON.stringify({
        feedUrl: "https://eng.example.com/feed.xml",
        title: "Eng Notes",
        modes: ["direct"],
        narrationStyle: "brief",
      }),
    }),
  );
  assertEquals(subRes.status, 201);
  const subBody = await subRes.json();
  assertEquals(subBody.source.narrationStyle, "brief");
  assertEquals(subBody.poll.queued, 2);

  const source = await t.stores.metadata.getSource(user.id, subBody.source.id);
  assertEquals(source?.narrationStyle, "brief");

  // Initial queued episodes inherit source.narrationStyle!
  const initialEpisodes = await t.stores.metadata.listEpisodes({
    userId: user.id,
    sourceId: subBody.source.id,
  });
  assertEquals(initialEpisodes.length, 2);
  for (const ep of initialEpisodes) {
    assertEquals(ep.narrationStyle, "brief");
  }

  // GET /api/sources exposes narrationStyle
  const listRes = await t.fetch(
    new Request(`${BASE}/api/sources`, {
      headers: { "x-feed-token": user.feedToken },
    }),
  );
  assertEquals(listRes.status, 200);
  const listBody = await listRes.json();
  assertEquals(listBody.sources[0].narrationStyle, "brief");

  // Valid subscription via /api/sources (feed-token route) with "walkthrough"
  const subTokenRes = await t.fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-feed-token": user.feedToken },
      body: JSON.stringify({
        feedUrl: "https://tech.example.com/rss.xml",
        modes: ["direct"],
        narrationStyle: "walkthrough",
      }),
    }),
  );
  assertEquals(subTokenRes.status, 201);
  const subTokenBody = await subTokenRes.json();
  assertEquals(subTokenBody.source.narrationStyle, "walkthrough");
  const tokenSource = await t.stores.metadata.getSource(user.id, subTokenBody.source.id);
  assertEquals(tokenSource?.narrationStyle, "walkthrough");
});

Deno.test("POST /api/account/sources/:sourceId/preferences & pollFeedSource: update/clear narrationStyle (D1 round-trip) and propagate on poll", async () => {
  const d1 = createTestD1();
  try {
    const metadata = new D1MetadataStore(d1);
    const blobs = new MemoryBlobStore();
    const t = createApiHarness({
      stores: { metadata, blobs, describe: "d1-styles-test" },
      rss: SAMPLE_RSS,
    });
    const user = await t.seedUser({ id: "u-d1-style", email: "d1style@example.com" });
    const cookie = await t.cookieFor(user.id);

    // Subscribe initially with no narrationStyle
    const subRes = await t.fetch(
      new Request(`${BASE}/api/account/sources`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: BASE },
        body: JSON.stringify({
          feedUrl: "https://eng.example.com/feed.xml",
          title: "Eng Notes",
          modes: ["direct"],
        }),
      }),
    );
    assertEquals(subRes.status, 201);
    const { source: created } = await subRes.json();

    // Invalid narrationStyle values rejected with 400 and leave source untouched
    for (const bad of ["deepdive", "BRIEF", "  ", 123, false]) {
      const badRes = await t.fetch(
        new Request(`${BASE}/api/account/sources/${encodeURIComponent(created.id)}/preferences`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin: BASE },
          body: JSON.stringify({ narrationStyle: bad }),
        }),
      );
      assertEquals(badRes.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
    assertEquals((await metadata.getSource(user.id, created.id))?.narrationStyle, undefined);

    // Update source preference to "walkthrough" and verify D1 persistence
    const setWalk = await t.fetch(
      new Request(`${BASE}/api/account/sources/${encodeURIComponent(created.id)}/preferences`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: BASE },
        body: JSON.stringify({ narrationStyle: "walkthrough" }),
      }),
    );
    assertEquals(setWalk.status, 200);
    const walkBody = await setWalk.json();
    assertEquals(walkBody.source.narrationStyle, "walkthrough");

    const updatedSource = await metadata.getSource(user.id, created.id);
    assertEquals(updatedSource?.narrationStyle, "walkthrough");

    // Poll feed with a brand-new 3rd item -> newly queued episode inherits "walkthrough"!
    const pollRes = await pollFeedSource(t.ctx, updatedSource!, {
      transport: () =>
        Promise.resolve(
          new Response(SAMPLE_RSS_WITH_THIRD, {
            status: 200,
            headers: { "content-type": "application/rss+xml; charset=utf-8" },
          }),
        ),
      fetchArticle: t.fetchArticle,
    });
    assertEquals(pollRes.queued, 1);

    const allEps = await metadata.listEpisodes({ userId: user.id, sourceId: created.id });
    const postThree = allEps.find((e) => e.title === "Post Three");
    assert(postThree, "expected newly polled Post Three episode");
    assertEquals(postThree.narrationStyle, "walkthrough");

    // Update to "brief", then clear via null and "" back to undefined
    const setBrief = await t.fetch(
      new Request(`${BASE}/api/account/sources/${encodeURIComponent(created.id)}/preferences`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: BASE },
        body: JSON.stringify({ narrationStyle: "brief" }),
      }),
    );
    assertEquals(setBrief.status, 200);
    assertEquals((await metadata.getSource(user.id, created.id))?.narrationStyle, "brief");

    const clearNull = await t.fetch(
      new Request(`${BASE}/api/account/sources/${encodeURIComponent(created.id)}/preferences`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: BASE },
        body: JSON.stringify({ narrationStyle: null }),
      }),
    );
    assertEquals(clearNull.status, 200);
    const clearNullBody = await clearNull.json();
    assertEquals(clearNullBody.source.narrationStyle, undefined);
    assertEquals((await metadata.getSource(user.id, created.id))?.narrationStyle, undefined);

    // Set again and verify empty string "" also clears to undefined
    await t.fetch(
      new Request(`${BASE}/api/account/sources/${encodeURIComponent(created.id)}/preferences`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: BASE },
        body: JSON.stringify({ narrationStyle: "brief" }),
      }),
    );
    const clearEmpty = await t.fetch(
      new Request(`${BASE}/api/account/sources/${encodeURIComponent(created.id)}/preferences`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: BASE },
        body: JSON.stringify({ narrationStyle: "" }),
      }),
    );
    assertEquals(clearEmpty.status, 200);
    assertEquals((await metadata.getSource(user.id, created.id))?.narrationStyle, undefined);
  } finally {
    d1.close();
  }
});
