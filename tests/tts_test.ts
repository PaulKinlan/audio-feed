import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.10";
import {
  base64ToUint8Array,
  buildDialogueRequest,
  buildSingleVoiceRequest,
  decodeAudioResponse,
  DEFAULT_EXPERT_VOICE,
  DEFAULT_FOIL_VOICE,
  DEFAULT_NARRATION_VOICE,
  DEFAULT_TTS_MODEL,
  detectAudioFormat,
  DialogueSpeaker,
  DialogueTurn,
  formatDialoguePrompt,
  formatNarrationIntro,
  formatNarrationPrompt,
  formatSpokenDate,
  GEMINI_TTS_VOICES,
  GeminiGenerateContentRequest,
  GeminiTtsClient,
  GeminiTtsError,
  parseWavHeader,
  pcmToWav,
  uint8ArrayToBase64,
  VOICE_PROFILES,
} from "../src/tts/gemini.ts";

// ---------------------------------------------------------------------------
// 1. Voice Configuration Tests
// ---------------------------------------------------------------------------

Deno.test("Voice configuration - supports all 5 required voices", () => {
  assertEquals(GEMINI_TTS_VOICES, [
    "Aoede",
    "Charon",
    "Fenrir",
    "Kore",
    "Puck",
  ]);

  for (const voice of GEMINI_TTS_VOICES) {
    const profile = VOICE_PROFILES[voice];
    assertEquals(profile.name, voice);
    assertEquals(typeof profile.style, "string");
    assertEquals(typeof profile.gender, "string");
    assertEquals(typeof profile.recommendedRole, "string");
  }

  assertEquals(DEFAULT_NARRATION_VOICE, "Charon");
  assertEquals(DEFAULT_EXPERT_VOICE, "Fenrir");
  assertEquals(DEFAULT_FOIL_VOICE, "Puck");
  assertEquals(DEFAULT_TTS_MODEL, "gemini-3.8-flash-tts");
});

// ---------------------------------------------------------------------------
// 2. Single-Voice Narration Mode (Stratechery / Ben Thompson Style)
// ---------------------------------------------------------------------------

Deno.test("Single-voice narration - spoken date formatting", () => {
  const formatted = formatSpokenDate("2026-09-24T10:00:00Z");
  assertEquals(formatted, "September 24, 2026");

  const fromDate = formatSpokenDate(new Date(Date.UTC(2026, 0, 15)));
  assertEquals(fromDate, "January 15, 2026");
});

Deno.test("Single-voice narration - builds Ben Thompson style spoken intro", () => {
  const intro = formatNarrationIntro({
    title: "Aggregators and Platforms",
    author: "Ben Thompson",
    publishedAt: "2026-09-24T10:00:00Z",
    sourceName: "Stratechery",
    lead: "Why distribution economics define modern platforms.",
    body: "Article text here...",
  });

  assertEquals(
    intro,
    "The following is Aggregators and Platforms, written by Ben Thompson, published on September 24, 2026. From Stratechery. Why distribution economics define modern platforms.",
  );
});

Deno.test("Single-voice narration - custom intro and partial metadata", () => {
  const custom = formatNarrationIntro({
    title: "Quick Read",
    body: "Content...",
    customIntro: "Special audio edition recorded for subscribers.",
  });
  assertEquals(custom, "Special audio edition recorded for subscribers.");

  const titleOnly = formatNarrationIntro({
    title: "Solo Thought",
    body: "Content...",
  });
  assertEquals(titleOnly, "The following is Solo Thought.");
});

Deno.test("Single-voice narration - builds prompt with pacing guidelines", () => {
  const prompt = formatNarrationPrompt({
    title: "AI Operating Models",
    author: "Paul Kinlan",
    publishedAt: "2026-09-24",
    body: "The shift from local agents to fleet swarms is accelerating.",
  });

  assertEquals(
    prompt.includes("Read the following article text directly"),
    true,
  );
  assertEquals(prompt.includes("The following is AI Operating Models"), true);
  assertEquals(prompt.includes("written by Paul Kinlan"), true);
  assertEquals(
    prompt.includes(
      "The shift from local agents to fleet swarms is accelerating.",
    ),
    true,
  );
});

Deno.test("Single-voice narration - request builder creates valid Gemini payload", () => {
  const req = buildSingleVoiceRequest("Test article prompt", "Charon", 0.7);

  assertEquals(req.contents[0]?.parts[0]?.text, "Test article prompt");
  assertEquals(req.generationConfig.responseModalities, ["AUDIO"]);
  assertEquals(
    req.generationConfig.speechConfig.voiceConfig?.prebuiltVoiceConfig
      .voiceName,
    "Charon",
  );
  assertEquals(req.generationConfig.temperature, 0.7);
});

// ---------------------------------------------------------------------------
// 3. Two-Voice Dialogue Mode (NotebookLM Style: Expert + Curious Foil)
// ---------------------------------------------------------------------------

Deno.test("Two-voice dialogue - formats NotebookLM style prompt from turns", () => {
  const { prompt, speakers } = formatDialoguePrompt({
    topic: "WebAssembly Garbage Collection",
    speakers: [
      { name: "Fenrir", role: "expert", voice: "Fenrir" },
      { name: "Kore", role: "curious_foil", voice: "Kore" },
    ],
    turns: [
      {
        speaker: "Kore",
        text:
          "Today we are diving into WasmGC. What makes it different from traditional Wasm?",
      },
      {
        speaker: "Fenrir",
        text:
          "Traditional WebAssembly operates on linear memory. WasmGC allows managed objects to integrate with host garbage collection.",
      },
    ],
  });

  assertEquals(speakers[0].name, "Fenrir");
  assertEquals(speakers[1].name, "Kore");
  assertEquals(prompt.includes("style of NotebookLM"), true);
  assertEquals(prompt.includes("Fenrir: The domain expert"), true);
  assertEquals(prompt.includes("Kore: The curious interviewer and foil"), true);
  assertEquals(prompt.includes("Kore: Today we are diving into WasmGC"), true);
  assertEquals(
    prompt.includes("Fenrir: Traditional WebAssembly operates"),
    true,
  );
});

Deno.test("Two-voice dialogue - formats from article context when turns not supplied", () => {
  const { prompt, speakers } = formatDialoguePrompt({
    article: {
      title: "State of Autonomous Systems",
      author: "Paul Kinlan",
      body:
        "Autonomous agents require bounded execution and continuous verification.",
      summary: "A practical guide to multi-agent architectures.",
    },
  });

  assertEquals(speakers[0].name, "Alex");
  assertEquals(speakers[0].voice, "Fenrir");
  assertEquals(speakers[1].name, "Sam");
  assertEquals(speakers[1].voice, "Puck");

  assertEquals(prompt.includes("Sam: Welcome back to the deep dive!"), true);
  assertEquals(prompt.includes("State of Autonomous Systems"), true);
  assertEquals(prompt.includes("Alex: Thanks Sam."), true);
});

Deno.test("Two-voice dialogue - request builder creates multiSpeakerVoiceConfig", () => {
  const speakers: [
    { name: string; role: "expert"; voice: string },
    { name: string; role: "curious_foil"; voice: string },
  ] = [
    { name: "Alex", role: "expert", voice: "Fenrir" },
    { name: "Sam", role: "curious_foil", voice: "Puck" },
  ];

  const req = buildDialogueRequest("Dialogue script...", speakers, 0.85);

  assertEquals(req.generationConfig.responseModalities, ["AUDIO"]);
  const multiConfig = req.generationConfig.speechConfig.multiSpeakerVoiceConfig;
  assertEquals(multiConfig !== undefined, true);
  assertEquals(multiConfig?.speakerVoiceConfigs.length, 2);

  assertEquals(multiConfig?.speakerVoiceConfigs[0]?.speaker, "Alex");
  assertEquals(
    multiConfig?.speakerVoiceConfigs[0]?.voiceConfig.prebuiltVoiceConfig
      .voiceName,
    "Fenrir",
  );

  assertEquals(multiConfig?.speakerVoiceConfigs[1]?.speaker, "Sam");
  assertEquals(
    multiConfig?.speakerVoiceConfigs[1]?.voiceConfig.prebuiltVoiceConfig
      .voiceName,
    "Puck",
  );
  assertEquals(req.generationConfig.temperature, 0.85);
});

Deno.test("Two-voice dialogue - attaches speech_metadata.speaker to each turn part", () => {
  const speakers: [DialogueSpeaker, DialogueSpeaker] = [
    { name: "Alex", role: "expert", voice: "Fenrir" },
    { name: "Sam", role: "curious_foil", voice: "Puck" },
  ];
  const turns: DialogueTurn[] = [
    { speaker: "Alex", text: "Hello listeners." },
    { speaker: "Sam", text: "Excited to be here." },
  ];
  const req = buildDialogueRequest(turns, speakers);
  assertEquals(req.contents[0]?.parts.length, 2);
  assertEquals(req.contents[0]?.parts[0]?.text, "Hello listeners.");
  assertEquals(req.contents[0]?.parts[0]?.speech_metadata?.speaker, "Alex");
  assertEquals(req.contents[0]?.parts[1]?.text, "Excited to be here.");
  assertEquals(req.contents[0]?.parts[1]?.speech_metadata?.speaker, "Sam");
});

// ---------------------------------------------------------------------------
// 4. Response Decoder & Audio Container Handling (PCM / WAV / MP3)
// ---------------------------------------------------------------------------

Deno.test("Base64 encoding and decoding roundtrip", () => {
  const original = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 255]);
  const b64 = uint8ArrayToBase64(original);
  const decoded = base64ToUint8Array(b64);
  assertEquals(decoded, original);
});

Deno.test("PCM to WAV packaging - produces valid 44-byte RIFF header", () => {
  // 1 second of 24kHz 16-bit mono silence (24000 samples * 2 bytes = 48000 bytes)
  const pcmBytes = new Uint8Array(48000);
  const wavBytes = pcmToWav(pcmBytes, {
    sampleRate: 24000,
    numChannels: 1,
    bitsPerSample: 16,
  });

  assertEquals(wavBytes.length, 48044); // 44 header + 48000 data
  assertEquals(detectAudioFormat(wavBytes), "wav");

  const parsed = parseWavHeader(wavBytes);
  assertEquals(parsed.audioFormat, 1); // PCM
  assertEquals(parsed.channels, 1);
  assertEquals(parsed.sampleRate, 24000);
  assertEquals(parsed.bitsPerSample, 16);
  assertEquals(parsed.byteRate, 48000);
  assertEquals(parsed.dataLength, 48000);
  assertEquals(parsed.durationSeconds, 1.0);
});

Deno.test("Audio format detection - identifies WAV, MP3 and PCM", () => {
  // WAV header
  const wavHeader = new Uint8Array(44);
  wavHeader[0] = 0x52; // R
  wavHeader[1] = 0x49; // I
  wavHeader[2] = 0x46; // F
  wavHeader[3] = 0x46; // F
  wavHeader[8] = 0x57; // W
  wavHeader[9] = 0x41; // A
  wavHeader[10] = 0x56; // V
  wavHeader[11] = 0x45; // E
  assertEquals(detectAudioFormat(wavHeader), "wav");

  // MP3 with ID3 header
  const id3Mp3 = new Uint8Array([
    0x49,
    0x44,
    0x33,
    0x03,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x0a,
  ]);
  assertEquals(detectAudioFormat(id3Mp3), "mp3");

  // MP3 frame sync
  const frameSyncMp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
  assertEquals(detectAudioFormat(frameSyncMp3), "mp3");

  // Raw PCM with mime hint
  const rawPcm = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
  assertEquals(detectAudioFormat(rawPcm, "audio/pcm;rate=24000"), "pcm");
});

Deno.test("decodeAudioResponse - decodes standard Gemini audio response", () => {
  // 1/2 second of 24kHz 16-bit mono PCM (24000 bytes)
  const mockPcm = new Uint8Array(24000);
  for (let i = 0; i < mockPcm.length; i += 2) {
    mockPcm[i] = i % 256;
  }
  const base64Audio = uint8ArrayToBase64(mockPcm);

  const mockApiResponse = {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/pcm;rate=24000",
                data: base64Audio,
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  };

  const decoded = decodeAudioResponse(mockApiResponse);
  assertEquals(decoded.format, "pcm");
  assertEquals(decoded.sampleRate, 24000);
  assertEquals(decoded.channels, 1);
  assertEquals(decoded.bitsPerSample, 16);
  assertEquals(decoded.durationSeconds, 0.5);

  // Verify toWav conversion
  const wavBytes = decoded.toWav();
  assertEquals(wavBytes.length, 24044);
  const parsedWav = parseWavHeader(wavBytes);
  assertEquals(parsedWav.sampleRate, 24000);
  assertEquals(parsedWav.durationSeconds, 0.5);
});

Deno.test("decodeAudioResponse - handles snake_case inline_data format", () => {
  const pcm = new Uint8Array(4800); // 0.1s
  const b64 = uint8ArrayToBase64(pcm);

  const mockApiResponse = {
    candidates: [
      {
        content: {
          parts: [
            {
              inline_data: {
                mime_type: "audio/pcm;rate=24000",
                data: b64,
              },
            },
          ],
        },
      },
    ],
  };

  const decoded = decodeAudioResponse(mockApiResponse);
  assertEquals(decoded.format, "pcm");
  assertEquals(decoded.durationSeconds, 0.1);
});

Deno.test("decodeAudioResponse - error handling", () => {
  // API error response
  assertThrows(
    () => {
      decodeAudioResponse({
        error: {
          code: 400,
          message: "API key expired",
        },
      });
    },
    GeminiTtsError,
    "API key expired",
  );

  // Safety block
  assertThrows(
    () => {
      decodeAudioResponse({
        candidates: [
          {
            finishReason: "SAFETY",
          },
        ],
      });
    },
    GeminiTtsError,
    "blocked by SAFETY filter",
  );

  // Empty candidates
  assertThrows(
    () => {
      decodeAudioResponse({ candidates: [] });
    },
    GeminiTtsError,
    "contained no candidates",
  );
});

// ---------------------------------------------------------------------------
// 5. GeminiTtsClient Integration Tests with Mock Fetch
// ---------------------------------------------------------------------------

Deno.test("GeminiTtsClient - synthesizeNarration executes flow with mock fetch", async () => {
  const mockPcm = new Uint8Array(48000); // 1.0s
  const b64 = uint8ArrayToBase64(mockPcm);

  let capturedUrl = "";
  let capturedBody: GeminiGenerateContentRequest | undefined;
  let capturedHeaders: HeadersInit | undefined;

  const mockFetch: typeof fetch = (input, init) => {
    capturedUrl = input.toString();
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(init?.body as string);

    const responseBody = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: b64,
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const client = new GeminiTtsClient({
    apiKey: "test-api-key-12345",
    fetchFn: mockFetch,
  });

  const audio = await client.synthesizeNarration({
    title: "Understanding Microservices",
    author: "Alice Tech",
    publishedAt: "2026-09-24",
    body: "Microservices split monoliths into isolated services.",
    voice: "Charon",
  });

  // Header only: API key must NOT be sent in query string
  assertEquals(capturedUrl.includes("key="), false);
  assertEquals(
    capturedUrl,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent",
  );
  assertEquals(
    (capturedHeaders as Record<string, string>)["x-goog-api-key"],
    "test-api-key-12345",
  );
  assertEquals(
    capturedBody?.generationConfig.speechConfig.voiceConfig?.prebuiltVoiceConfig
      .voiceName,
    "Charon",
  );
  assertEquals(audio.format, "pcm");
  assertEquals(audio.durationSeconds, 1.0);

  const wav = audio.toWav();
  assertEquals(wav.length, 48044);
});

Deno.test("GeminiTtsClient - synthesizeDialogue executes multi-speaker request", async () => {
  const mockPcm = new Uint8Array(24000);
  const b64 = uint8ArrayToBase64(mockPcm);

  let capturedBody: GeminiGenerateContentRequest | undefined;

  const mockFetch: typeof fetch = (_input, init) => {
    capturedBody = JSON.parse(init?.body as string);

    const responseBody = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: b64,
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: mockFetch,
  });

  const result = await client.synthesizeDialogue({
    topic: "Cloudflare Workers vs Deno Deploy",
    turns: [
      {
        speaker: "Alex",
        text: "Workers run on V8 isolates across edge locations.",
      },
      {
        speaker: "Sam",
        text: "And how does Deno Deploy compare on cold starts?",
      },
    ],
    speakers: [
      { name: "Alex", role: "expert", voice: "Fenrir" },
      { name: "Sam", role: "curious_foil", voice: "Puck" },
    ],
  });

  assertEquals(
    capturedBody?.generationConfig.speechConfig.multiSpeakerVoiceConfig
      ?.speakerVoiceConfigs.length,
    2,
  );
  assertEquals(
    capturedBody?.generationConfig.speechConfig.multiSpeakerVoiceConfig
      ?.speakerVoiceConfigs[0]?.speaker,
    "Alex",
  );
  assertEquals(
    capturedBody?.generationConfig.speechConfig.multiSpeakerVoiceConfig
      ?.speakerVoiceConfigs[1]?.speaker,
    "Sam",
  );

  // Assert per-part speech_metadata.speaker
  assertEquals(capturedBody?.contents[0]?.parts.length, 2);
  assertEquals(
    capturedBody?.contents[0]?.parts[0]?.speech_metadata?.speaker,
    "Alex",
  );
  assertEquals(
    capturedBody?.contents[0]?.parts[1]?.speech_metadata?.speaker,
    "Sam",
  );

  assertEquals(result.format, "pcm");
  assertEquals(result.durationSeconds, 0.5);
});

Deno.test("GeminiTtsClient - rejects when API key is missing", async () => {
  const client = new GeminiTtsClient({ apiKey: "" });

  await assertRejects(
    async () => {
      await client.synthesizeNarration({
        title: "Test",
        body: "Body",
      });
    },
    GeminiTtsError,
    "GEMINI_API_KEY is not configured",
  );
});

Deno.test("GeminiTtsClient - handles HTTP 500 error from API", async () => {
  const mockFetch: typeof fetch = () => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 500,
            message: "Internal server error in TTS synthesis backend",
          },
        }),
        {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };

  const client = new GeminiTtsClient({
    apiKey: "test-key",
    fetchFn: mockFetch,
  });

  await assertRejects(
    async () => {
      await client.synthesizeNarration({
        title: "Test",
        body: "Body",
      });
    },
    GeminiTtsError,
    "Internal server error in TTS synthesis backend",
  );
});
