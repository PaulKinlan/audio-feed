import { assertEquals } from "@std/assert";
import {
  DEFAULT_GEMINI_API_BASE_URL,
  GEMINI_API_BASE_URL,
  GeminiTtsClient,
  getGeminiApiBaseUrl,
} from "../src/tts/gemini.ts";

Deno.test("Gemini API base URL - default literal remains unchanged", () => {
  assertEquals(
    DEFAULT_GEMINI_API_BASE_URL,
    "https://generativelanguage.googleapis.com/v1beta",
  );
  assertEquals(
    GEMINI_API_BASE_URL,
    "https://generativelanguage.googleapis.com/v1beta",
  );
});

Deno.test("Gemini API base URL - resolves default when env is unset", () => {
  // A fake reader, not a process-global env mutation (audio-feed-lnnjd):
  // under `deno test --parallel` a set/delete window is visible to every
  // concurrently running module.
  const unset = { get: () => undefined };
  assertEquals(
    getGeminiApiBaseUrl(undefined, unset),
    "https://generativelanguage.googleapis.com/v1beta",
  );
  const client = new GeminiTtsClient({ apiKey: "test-key", env: unset });
  assertEquals(
    client.baseUrl,
    "https://generativelanguage.googleapis.com/v1beta",
  );
  assertEquals(
    client.getBaseUrl(),
    "https://generativelanguage.googleapis.com/v1beta",
  );
});

Deno.test("Gemini API base URL - respects GEMINI_API_BASE_URL env override with host normalization", () => {
  // 1. Host-only URL (should append /v1beta)
  const hostOnly = { get: () => "https://gemini.int.exe.xyz" };
  assertEquals(
    getGeminiApiBaseUrl(undefined, hostOnly),
    "https://gemini.int.exe.xyz/v1beta",
  );
  const client1 = new GeminiTtsClient({ apiKey: "test-key", env: hostOnly });
  assertEquals(client1.baseUrl, "https://gemini.int.exe.xyz/v1beta");

  // 2. URL already containing /v1beta and trailing slash
  const versioned = { get: () => "https://gemini.int.exe.xyz/v1beta/" };
  assertEquals(
    getGeminiApiBaseUrl(undefined, versioned),
    "https://gemini.int.exe.xyz/v1beta",
  );
  const client2 = new GeminiTtsClient({ apiKey: "test-key", env: versioned });
  assertEquals(client2.baseUrl, "https://gemini.int.exe.xyz/v1beta");
});

Deno.test("Gemini API base URL - appends version only for a complete trailing version segment", () => {
  for (const path of ["/v1-proxy", "/v1foo", "/v1beta/proxy"]) {
    assertEquals(
      getGeminiApiBaseUrl(`https://example.com${path}`),
      `https://example.com${path}/v1beta`,
    );
  }
  for (const version of ["v1", "v1beta", "v1alpha"]) {
    assertEquals(
      getGeminiApiBaseUrl(`https://example.com/${version}/`),
      `https://example.com/${version}`,
    );
  }
});

Deno.test("Gemini API base URL - explicit config.baseUrl takes precedence over env override", () => {
  const client = new GeminiTtsClient({
    apiKey: "test-key",
    baseUrl: "https://explicit.example.com/v1beta",
    env: { get: () => "https://env.example.com" },
  });
  assertEquals(client.baseUrl, "https://explicit.example.com/v1beta");
});

Deno.test("Gemini API base URL - sendRequest targets overridden base URL", async () => {
  let requestedUrl = "";
  const mockFetch: typeof fetch = (input) => {
    requestedUrl = input.toString();
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/pcm;rate=24000",
                      data: "AAAA",
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: mockFetch,
    env: { get: () => "https://gemini.int.exe.xyz" },
  });

  await client.sendRequest({
    contents: [{ parts: [{ text: "hello" }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: "Charon",
          },
        },
      },
    },
  });

  assertEquals(
    requestedUrl,
    "https://gemini.int.exe.xyz/v1beta/models/gemini-3.8-flash-tts:generateContent",
  );
});
