import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1.0.10";
import {
  base64ToUint8Array,
  buildDialogueRequest,
  buildNarrationSystemPrompt,
  buildSingleVoiceRequest,
  decodeAudioResponse,
  DEFAULT_EXPERT_VOICE,
  DEFAULT_FOIL_VOICE,
  DEFAULT_NARRATION_STYLE,
  DEFAULT_NARRATION_VOICE,
  DEFAULT_TTS_MODEL,
  detectAudioFormat,
  DialogueSpeaker,
  DialogueTurn,
  formatCodeForTts,
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
    "Aggregators and Platforms. Published on September 24, 2026, by Ben Thompson. From Stratechery. Why distribution economics define modern platforms.",
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
  assertEquals(titleOnly, "Solo Thought.");

  const titleAndAuthor = formatNarrationIntro({
    title: "Solo Thought",
    author: "Ben Thompson",
    body: "Content...",
  });
  assertEquals(titleAndAuthor, "Solo Thought. By Ben Thompson.");

  const titleAndDate = formatNarrationIntro({
    title: "Solo Thought",
    publishedAt: "2026-09-24T10:00:00Z",
    body: "Content...",
  });
  assertEquals(titleAndDate, "Solo Thought. Published on September 24, 2026.");
});

Deno.test("Single-voice narration - builds prompt with spoken intro and article text without meta-preamble or bracketed headers (audio-feed-xad, audio-feed-9dc)", () => {
  const prompt = formatNarrationPrompt({
    title: "AI Operating Models",
    author: "Paul Kinlan",
    publishedAt: "2026-09-24",
    body: "The shift from local agents to fleet swarms is accelerating.",
  });

  // Meta-prompting instructions must NOT be present in the spoken prompt text
  assertEquals(
    prompt.includes("Read the following article text directly"),
    false,
  );
  assertEquals(
    prompt.includes("Maintain a steady, measured pace"),
    false,
  );
  assertEquals(
    prompt.includes("Pronounce technical terms with confidence"),
    false,
  );

  // Bracketed section markers must NOT be present (prevents TTS speaking them aloud, audio-feed-9dc)
  assertEquals(prompt.includes("[Spoken Introduction]"), false);
  assertEquals(prompt.includes("[Article Text]"), false);

  // Spoken introduction and article text must be present directly
  assertEquals(prompt.startsWith("AI Operating Models."), true);
  assertEquals(prompt.includes("Published on September 24, 2026, by Paul Kinlan."), true);
  assertEquals(prompt.includes("The following is"), false);
  assertEquals(
    prompt.includes(
      "The shift from local agents to fleet swarms is accelerating.",
    ),
    true,
  );
  assertEquals(
    prompt,
    "AI Operating Models. Published on September 24, 2026, by Paul Kinlan.\n\nThe shift from local agents to fleet swarms is accelerating.",
  );
});

Deno.test("Single-voice narration - request builder creates valid Gemini payload", () => {
  const req = buildSingleVoiceRequest("Test article prompt", "Charon", 0.7);

  assertEquals(req.contents[0]?.parts.length, 1);
  assertEquals(req.contents[0]?.parts[0]?.text, "Test article prompt");
  assertEquals(req.contents[0]?.parts[0]?.speech_metadata?.style, DEFAULT_NARRATION_STYLE);
  assertEquals(req.contents[0]?.parts[0]?.speechMetadata?.style, DEFAULT_NARRATION_STYLE);
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

Deno.test("Two-voice dialogue - returns the supplied turns and speaker roles in order", () => {
  // Was "formats NotebookLM style prompt from turns", asserting on
  // `prompt.includes("style of NotebookLM")` and the speaker description lines.
  // That string is never sent to the API (audio-feed-9jh), so those assertions
  // were covering a discarded value and would have resisted removing it. Asserted
  // on `turns` instead, which is what buildDialogueRequest actually transmits.
  const { turns, speakers } = formatDialoguePrompt({
    topic: "WebAssembly Garbage Collection",
    speakers: [
      { name: "Fenrir", role: "expert", voice: "Fenrir" },
      { name: "Kore", role: "curious_foil", voice: "Kore" },
    ],
    turns: [
      {
        speaker: "Kore",
        text: "Today we are diving into WasmGC. What makes it different from traditional Wasm?",
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
  assertEquals(turns.length, 2, "supplied turns pass through unchanged");
  assertEquals(turns[0]?.speaker, "Kore");
  assertEquals(
    turns[0]?.text,
    "Today we are diving into WasmGC. What makes it different from traditional Wasm?",
  );
  assertEquals(turns[1]?.speaker, "Fenrir");
});

Deno.test("Two-voice dialogue - derives an opening exchange from article context", () => {
  const { turns, speakers } = formatDialoguePrompt({
    article: {
      title: "State of Autonomous Systems",
      author: "Paul Kinlan",
      body: "Autonomous agents require bounded execution and continuous verification.",
      summary: "A practical guide to multi-agent architectures.",
    },
  });

  assertEquals(speakers[0].name, "Alex");
  assertEquals(speakers[0].voice, "Fenrir");
  assertEquals(speakers[1].name, "Sam");
  assertEquals(speakers[1].voice, "Puck");

  // Same content the old prompt assertions checked, but read off the turns that
  // actually reach the API rather than a string built and thrown away.
  assert(turns.length >= 2, "an article with no turns still produces a dialogue");
  assertEquals(turns[0]?.speaker, "Sam", "the foil opens");
  assert(
    turns[0]?.text.includes("Welcome back to the deep dive!") === true,
    "opening line is part of the transmitted turn text",
  );
  assert(
    turns.some((t) => t.text.includes("State of Autonomous Systems")),
    "the article title must reach the spoken turns, not just a discarded prompt",
  );
  assert(
    turns.some((t) => t.speaker === "Alex" && t.text.startsWith("Thanks Sam.")),
    "the expert's reply is a real turn",
  );
});

Deno.test("no meta-instruction reaches the dialogue API (audio-feed-9jh)", () => {
  // The guard, and the reason this bead is not just dead-code removal. Dialogue
  // escaped audio-feed-xad BY ACCIDENT: formatDialoguePrompt used to build a
  // ~15-line "You are generating..." / "Style guidelines:" instruction string that
  // nothing sent. A field that looks like an unused bug invites wiring in, and
  // wiring it in would read the instructions aloud - looking exactly like a fix.
  // So the property is pinned on the OUTGOING REQUEST, not on a comment.
  const { turns, speakers } = formatDialoguePrompt({
    topic: "WebAssembly Garbage Collection",
    turns: [
      { speaker: "Alex", text: "The domain expert speaks here." },
      { speaker: "Sam", text: "The curious foil answers here." },
    ],
  });
  const wire = JSON.stringify(buildDialogueRequest(turns, speakers));

  for (
    const phrase of [
      "You are generating",
      "Style guidelines",
      "Speak with natural human cadence",
      "No robotic pauses",
      "The domain expert.",
      "curious interviewer and foil",
      "Dialogue Script",
      "in the style of NotebookLM",
    ]
  ) {
    assertEquals(
      wire.includes(phrase),
      false,
      `meta-instruction "${phrase}" must not reach the API; it would be read aloud (audio-feed-xad on the dialogue path)`,
    );
  }

  // Positive companion: the assertion above must not pass because the request came
  // out empty. Real turn text and speaker names DO reach the wire.
  assertStringIncludes(wire, "The domain expert speaks here.");
  assertStringIncludes(wire, "Alex");
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

  // Assert per-part speech_metadata.speaker (100% of parts have speaker attribution, audio-feed-9pc)
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

// ---------------------------------------------------------------------------
// 5. Episode Intro & Code Handling in Outgoing Requests (audio-feed-tov, audio-feed-bdo)
// ---------------------------------------------------------------------------

Deno.test("outgoing single-voice request captures title-first intro and keeps parts strictly verbatim without meta-instructions (audio-feed-tov, audio-feed-bdo, audio-feed-bjt)", async () => {
  let capturedRequest: GeminiGenerateContentRequest | null = null;
  const mockFetch: typeof fetch = (_url, init) => {
    capturedRequest = JSON.parse(String(init?.body)) as GeminiGenerateContentRequest;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: uint8ArrayToBase64(new Uint8Array(48)),
                },
              }],
            },
            finishReason: "STOP",
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const client = new GeminiTtsClient({ apiKey: "test-key", fetchFn: mockFetch });
  await client.synthesizeNarration({
    title: "Understanding Fleet Topologies",
    author: "Paul Kinlan",
    publishedAt: "2026-09-26T12:00:00Z",
    sourceName: "Platform Architecture",
    body: "First paragraph.\n\n```ts\nconst agent = new Agent();\n```\n\nFinal paragraph.",
    codeHandling: "skip",
  });

  assert(capturedRequest !== null);
  const req = capturedRequest as GeminiGenerateContentRequest;

  // Exactly 1 part: the verbatim article prompt (audio-feed-bjt)
  assertEquals(req.contents[0]?.parts.length, 1);
  const promptPart = req.contents[0]?.parts[0]?.text ?? "";

  // tov: first words must be title, followed by date, author, source
  assertEquals(
    promptPart.startsWith(
      "Understanding Fleet Topologies. Published on September 26, 2026, by Paul Kinlan. From Platform Architecture.",
    ),
    true,
  );
  assertEquals(promptPart.includes("The following is"), false);

  // bdo: raw code block is stripped from prompt text
  assertEquals(promptPart.includes("const agent"), false);
  assertEquals(promptPart.includes("First paragraph."), true);
  assertEquals(promptPart.includes("Final paragraph."), true);

  // audio-feed-bjt: parts.text contains ONLY verbatim transcript and NEVER meta-instructions
  const fullText = req.contents[0]?.parts.map((p) => p.text).join(" ") ?? "";
  assertEquals(fullText.includes("You are an audio narrator"), false);
  assertEquals(fullText.includes("Skip code blocks"), false);
  assertEquals(fullText.includes("Never read raw code"), false);

  // Style instruction rides in speech_metadata.style / speechMetadata.style
  const part = req.contents[0]?.parts[0];
  assertEquals(part?.speech_metadata?.style, DEFAULT_NARRATION_STYLE);
  assertEquals(part?.speechMetadata?.style, DEFAULT_NARRATION_STYLE);

  // audio-feed-2ob: systemInstruction must NOT be attached to audio requests
  assertEquals(
    req.systemInstruction,
    undefined,
    "systemInstruction must NOT be attached to audio requests",
  );
});

Deno.test("formatCodeForTts - skips code blocks by default (audio-feed-bdo)", async () => {
  const input =
    "Here is some context.\n\n```python\ndef compute(x):\n    return x * 2\n```\n\nThat was the computation.";
  const processed = await formatCodeForTts(input, "skip");
  assertEquals(processed.includes("def compute"), false);
  assertEquals(processed.includes("Here is some context."), true);
  assertEquals(processed.includes("That was the computation."), true);
});

Deno.test("formatCodeForTts - explains code blocks when summarizer is available (audio-feed-bdo, audio-feed-sju)", async () => {
  const input = 'Look at this snippet:\n\n```rust\nfn main() { println!("hi"); }\n```\n\nDone.';
  const summarizer = (code: string) => `prints a greeting using ${code.split("\n")[0]}`;
  const processed = await formatCodeForTts(input, "explain", summarizer);
  assertEquals(
    processed.includes(
      'Here is what that code does: prints a greeting using fn main() { println!("hi"); }',
    ),
    true,
  );
  assertEquals(processed.includes("fn main()"), true);
  assertEquals(processed.includes("Look at this snippet:"), true);
  // Brackets must NOT be present in the spoken text (audio-feed-sju, audio-feed-xad/9dc)
  assertEquals(processed.includes("["), false);
  assertEquals(processed.includes("]"), false);
});

Deno.test("formatCodeForTts - falls back to skip when summarizer throws or is omitted (audio-feed-bdo)", async () => {
  const input = "Snippet:\n\n```js\nconst x = 42;\n```\n\nEnd.";

  // Omitted summarizer
  const withoutSummarizer = await formatCodeForTts(input, "explain");
  assertEquals(withoutSummarizer.includes("const x = 42"), false);
  assertEquals(withoutSummarizer, "Snippet:\n\nEnd.");

  // Throwing summarizer
  const throwingSummarizer = () => {
    throw new Error("summarizer backend offline");
  };
  const fallbackOnThrow = await formatCodeForTts(input, "explain", throwingSummarizer);
  assertEquals(fallbackOnThrow.includes("const x = 42"), false);
  assertEquals(fallbackOnThrow, "Snippet:\n\nEnd.");
});

Deno.test("buildNarrationSystemPrompt directs code handling without forbidden meta-phrases (audio-feed-bdo)", () => {
  const skipPrompt = buildNarrationSystemPrompt("skip");
  assertStringIncludes(skipPrompt, "Skip code blocks");
  assertStringIncludes(skipPrompt, "Never read raw code");

  const explainPrompt = buildNarrationSystemPrompt("explain");
  assertStringIncludes(explainPrompt, "explain or summarize");
  assertStringIncludes(explainPrompt, "Never read raw code");

  // Must not trigger audio-feed-xad / 9jh forbidden phrases
  for (
    const forbidden of [
      "You are generating",
      "Style guidelines",
      "Speak with natural human cadence",
      "No robotic pauses",
      "in the style of NotebookLM",
    ]
  ) {
    assertEquals(skipPrompt.includes(forbidden), false);
    assertEquals(explainPrompt.includes(forbidden), false);
  }
});

Deno.test("GeminiTtsClient - synthesizeDialogue passes code-handled article body without un-attributed instructions (audio-feed-bdo, audio-feed-9pc)", async () => {
  let capturedRequest: GeminiGenerateContentRequest | null = null;
  const mockFetch: typeof fetch = (_url, init) => {
    capturedRequest = JSON.parse(String(init?.body)) as GeminiGenerateContentRequest;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: uint8ArrayToBase64(new Uint8Array(48)),
                },
              }],
            },
            finishReason: "STOP",
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const client = new GeminiTtsClient({ apiKey: "test-key", fetchFn: mockFetch });
  await client.synthesizeDialogue({
    title: "Deep Dive on Code",
    article: {
      title: "Deep Dive on Code",
      body: "Opening analysis.\n\n```python\nimport sys\n```\n\nClosing thoughts.",
    },
    codeHandling: "skip",
  });

  assert(capturedRequest !== null);
  const req = capturedRequest as GeminiGenerateContentRequest;
  const bodyText = JSON.stringify(req);
  assertEquals(bodyText.includes("import sys"), false);
  // audio-feed-2ob: systemInstruction must NOT be attached to dialogue audio requests
  assertEquals(
    req.systemInstruction,
    undefined,
    "systemInstruction must NOT be attached to dialogue requests",
  );
  // audio-feed-9pc: 100% of parts must carry speech_metadata.speaker matching declared speakerVoiceConfigs
  const speakerNames = new Set(
    req.generationConfig.speechConfig.multiSpeakerVoiceConfig!.speakerVoiceConfigs.map((
      s,
    ) => s.speaker),
  );
  assertEquals(req.contents[0]!.parts.length > 0, true);
  for (const part of req.contents[0]!.parts) {
    assert(part.speech_metadata, "every part in multi-speaker dialogue must have speech_metadata");
    assert(part.speech_metadata.speaker, "every part must have speech_metadata.speaker");
    assert(
      speakerNames.has(part.speech_metadata.speaker),
      `speaker ${part.speech_metadata.speaker} must be declared in speakerVoiceConfigs`,
    );
  }
});

Deno.test("formatCodeForTts - handles code block variants including tildes, multiline CRLF, and HTML pre tags (audio-feed-2ob)", async () => {
  const input = [
    "Intro text.",
    "````js\nconst quad = 4;\n````",
    "Middle text.",
    "~~~python\r\ndef tilde():\r\n    return True\r\n~~~",
    "Between text.",
    "<pre><code>const inPre = 'html';</code></pre>",
    "Another text.",
    "<pre>rawPreCode();</pre>",
    "Outro text.",
  ].join("\n\n");

  const skipped = await formatCodeForTts(input, "skip");
  assertEquals(skipped.includes("const quad"), false);
  assertEquals(skipped.includes("def tilde"), false);
  assertEquals(skipped.includes("const inPre"), false);
  assertEquals(skipped.includes("rawPreCode"), false);
  assertEquals(skipped.includes("Intro text."), true);
  assertEquals(skipped.includes("Middle text."), true);
  assertEquals(skipped.includes("Between text."), true);
  assertEquals(skipped.includes("Another text."), true);
  assertEquals(skipped.includes("Outro text."), true);

  const explained = await formatCodeForTts(
    input,
    "explain",
    (code) => `code block with ${code.length} chars`,
  );
  assertEquals(explained.includes("Here is what that code does: code block with"), true);
  assertEquals(explained.includes("const quad"), false);
  assertEquals(explained.includes("def tilde"), false);
});

Deno.test("decodeHtmlEntities - decodes specific entities before ampersand to avoid double-decoding (audio-feed-91r)", async () => {
  // Escaped entity representation (e.g. teaching how to write &lt; in HTML)
  // must become literal &lt;, NOT double-decoded to <.
  const sample = "Demonstration: <pre><code>esc &amp;lt;b&amp;gt; here</code></pre>";
  let capturedCode = "";
  await formatCodeForTts(sample, "explain", (code) => {
    capturedCode = code;
    return `[explained: ${code}]`;
  });
  assertEquals(
    capturedCode,
    "esc &lt;b&gt; here",
    "&amp;lt; must decode to literal &lt;, not raw <",
  );

  // Single-level entities decode as expected
  const single =
    "<pre><code>x &amp;&amp; y &lt; 10 &gt; 2 &quot;quoted&quot; &#39;single&#39; &nbsp;end</code></pre>";
  let singleCaptured = "";
  await formatCodeForTts(single, "explain", (code) => {
    singleCaptured = code;
    return `[explained: ${code}]`;
  });
  assertEquals(singleCaptured, `x && y < 10 > 2 "quoted" 'single'  end`);
});

Deno.test("GeminiTtsClient - synthesizeDialogue guarantees 100% of parts specify speech_metadata.speaker with zero bare parts (audio-feed-9pc)", async () => {
  let capturedRequest: GeminiGenerateContentRequest | null = null;
  const mockFetch: typeof fetch = (_url, init) => {
    capturedRequest = JSON.parse(String(init?.body)) as GeminiGenerateContentRequest;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: uint8ArrayToBase64(new Uint8Array(48)),
                },
              }],
            },
            finishReason: "STOP",
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const client = new GeminiTtsClient({ apiKey: "test-key", fetchFn: mockFetch });
  // Call synthesizeDialogue with article and codeHandling - this generated the bare system prompt on main!
  await client.synthesizeDialogue({
    title: "Deep Dive on Dialogue",
    article: {
      title: "Deep Dive on Dialogue",
      body: "First turn topic.\n\n```ts\nconst x = 1;\n```\n\nSecond turn topic.",
    },
    codeHandling: "skip",
    speakers: [
      { name: "Alex", role: "expert", voice: "Kore" },
      { name: "Sam", role: "curious_foil", voice: "Puck" },
    ],
  });

  assert(capturedRequest !== null);
  const req = capturedRequest as GeminiGenerateContentRequest;
  const parts = req.contents[0]?.parts ?? [];
  assert(parts.length > 0, "dialogue must have at least one turn part");

  const declaredSpeakers = new Set(
    req.generationConfig.speechConfig.multiSpeakerVoiceConfig!.speakerVoiceConfigs.map((s) =>
      s.speaker
    ),
  );

  // 1. 100% of parts must specify speech_metadata.speaker and speechMetadata.speaker matching declared configs
  // On main, this fails because part 0 was a bare { text: "You are an audio narrator..." } with no speaker!
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    assert(
      part.speech_metadata?.speaker,
      `part[${i}] must have speech_metadata.speaker (got text: "${part.text.slice(0, 30)}...")`,
    );
    assert(
      part.speechMetadata?.speaker,
      `part[${i}] must have speechMetadata.speaker (got text: "${part.text.slice(0, 30)}...")`,
    );
    assert(
      declaredSpeakers.has(part.speech_metadata.speaker),
      `speaker "${part.speech_metadata.speaker}" must match declared speakerVoiceConfigs`,
    );
  }

  // 2. Zero bare text parts without speaker metadata
  const bareParts = parts.filter((p) => !p.speech_metadata?.speaker);
  assertEquals(bareParts.length, 0, "zero bare text parts allowed in multi-speaker requests");

  // 3. req.systemInstruction is undefined (rejected by Gemini audio endpoints)
  assertEquals(req.systemInstruction, undefined);

  // audio-feed-bjt: dialogue parts.text contains ONLY verbatim dialogue turns and NEVER meta-instructions
  const allDialogueText = parts.map((p) => p.text).join(" ");
  assertEquals(allDialogueText.includes("You are an audio narrator"), false);
  assertEquals(allDialogueText.includes("Skip code blocks"), false);
  assertEquals(allDialogueText.includes("Never read raw code"), false);
});

Deno.test("Gemini TTS requests guarantee parts.text contains ONLY verbatim transcript without meta-instructions in single and dialogue (audio-feed-bjt)", async () => {
  const capturedRequests: GeminiGenerateContentRequest[] = [];
  const mockFetch: typeof fetch = (_url, init) => {
    capturedRequests.push(JSON.parse(String(init?.body)) as GeminiGenerateContentRequest);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: uint8ArrayToBase64(new Uint8Array(48)),
                },
              }],
            },
            finishReason: "STOP",
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const client = new GeminiTtsClient({ apiKey: "test-key", fetchFn: mockFetch });

  // 1. Single-voice narration
  await client.synthesizeNarration({
    title: "Article Title",
    body: "Paragraph one.\n\nParagraph two.",
    codeHandling: "skip",
  });

  // 2. Multi-speaker dialogue
  await client.synthesizeDialogue({
    turns: [
      { speaker: "Alex", text: "Turn 1" },
      { speaker: "Sam", text: "Turn 2" },
    ],
    speakers: [
      { name: "Alex", role: "expert", voice: "Kore" },
      { name: "Sam", role: "curious_foil", voice: "Puck" },
    ],
  });

  assertEquals(capturedRequests.length, 2);

  // Single-voice check
  const singleReq = capturedRequests[0]!;
  assertEquals(singleReq.contents[0]?.parts.length, 1);
  const singleText = singleReq.contents[0]?.parts[0]?.text ?? "";
  assertEquals(singleText.includes("You are an audio narrator"), false);
  assertEquals(singleText.includes("Skip code blocks"), false);
  assertEquals(singleText.includes("Never read raw code"), false);
  assertStringIncludes(singleText, "Article Title");
  assertStringIncludes(singleText, "Paragraph one.");
  assertEquals(
    singleReq.contents[0]?.parts[0]?.speech_metadata?.style,
    DEFAULT_NARRATION_STYLE,
  );

  // Dialogue check
  const dialogueReq = capturedRequests[1]!;
  assertEquals(dialogueReq.contents[0]?.parts.length, 2);
  for (const part of dialogueReq.contents[0]!.parts) {
    assertEquals(part.text.includes("You are an audio narrator"), false);
    assertEquals(part.text.includes("Skip code blocks"), false);
    assertEquals(part.text.includes("Never read raw code"), false);
    assert(Boolean(part.speech_metadata?.speaker));
  }
});
