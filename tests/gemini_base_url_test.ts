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
  const previous = Deno.env.get("GEMINI_API_BASE_URL");
  try {
    Deno.env.delete("GEMINI_API_BASE_URL");
    assertEquals(
      getGeminiApiBaseUrl(),
      "https://generativelanguage.googleapis.com/v1beta",
    );
    const client = new GeminiTtsClient({ apiKey: "test-key" });
    assertEquals(
      client.baseUrl,
      "https://generativelanguage.googleapis.com/v1beta",
    );
    assertEquals(
      client.getBaseUrl(),
      "https://generativelanguage.googleapis.com/v1beta",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("GEMINI_API_BASE_URL");
    } else {
      Deno.env.set("GEMINI_API_BASE_URL", previous);
    }
  }
});

Deno.test("Gemini API base URL - respects GEMINI_API_BASE_URL env override with host normalization", () => {
  const previous = Deno.env.get("GEMINI_API_BASE_URL");
  try {
    // 1. Host-only URL (should append /v1beta)
    Deno.env.set("GEMINI_API_BASE_URL", "https://gemini.int.exe.xyz");
    assertEquals(
      getGeminiApiBaseUrl(),
      "https://gemini.int.exe.xyz/v1beta",
    );
    const client1 = new GeminiTtsClient({ apiKey: "test-key" });
    assertEquals(client1.baseUrl, "https://gemini.int.exe.xyz/v1beta");

    // 2. URL already containing /v1beta and trailing slash
    Deno.env.set("GEMINI_API_BASE_URL", "https://gemini.int.exe.xyz/v1beta/");
    assertEquals(
      getGeminiApiBaseUrl(),
      "https://gemini.int.exe.xyz/v1beta",
    );
    const client2 = new GeminiTtsClient({ apiKey: "test-key" });
    assertEquals(client2.baseUrl, "https://gemini.int.exe.xyz/v1beta");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("GEMINI_API_BASE_URL");
    } else {
      Deno.env.set("GEMINI_API_BASE_URL", previous);
    }
  }
});

Deno.test("Gemini API base URL - explicit config.baseUrl takes precedence over env override", () => {
  const previous = Deno.env.get("GEMINI_API_BASE_URL");
  try {
    Deno.env.set("GEMINI_API_BASE_URL", "https://env.example.com");
    const client = new GeminiTtsClient({
      apiKey: "test-key",
      baseUrl: "https://explicit.example.com/v1beta",
    });
    assertEquals(client.baseUrl, "https://explicit.example.com/v1beta");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("GEMINI_API_BASE_URL");
    } else {
      Deno.env.set("GEMINI_API_BASE_URL", previous);
    }
  }
});

Deno.test("Gemini API base URL - sendRequest targets overridden base URL", async () => {
  const previous = Deno.env.get("GEMINI_API_BASE_URL");
  try {
    Deno.env.set("GEMINI_API_BASE_URL", "https://gemini.int.exe.xyz");

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
  } finally {
    if (previous === undefined) {
      Deno.env.delete("GEMINI_API_BASE_URL");
    } else {
      Deno.env.set("GEMINI_API_BASE_URL", previous);
    }
  }
});
