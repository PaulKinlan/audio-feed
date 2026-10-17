import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1.0.10";
// audio-feed-0evr (round two): the fence scan is asserted by the WORK it does, not by a clock - see the
// "WHAT THIS ASSERTS" block below (ScanWork.examined against the shape ceilings, with SCAN_HANG_GUARD_MS as
// the only remaining wall clock). The round-one process.threadCpuUsage() min-of-15 measure, and the
// node:process import it needed, were removed with it; do not reintroduce a CPU-time or wall-clock bound here.
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
  extractCodeBlocks,
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
  type ScanWork,
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

Deno.test("Single-voice narration - request builder creates valid Gemini payload (audio-feed-bjt)", () => {
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

Deno.test("formatCodeForTts - resolves every code block concurrently, bounded, and keeps them in order (audio-feed-8acp)", async () => {
  // More blocks than the pool, so the test can see both that calls overlap and that
  // they do not all fire at once.
  const input = Array.from(
    { length: 6 },
    (_, i) => `Paragraph ${i}.\n\n\`\`\`js\nconst block${i} = ${i};\n\`\`\``,
  ).join("\n\n");

  let inFlight = 0;
  let peak = 0;
  const summarizer = async (code: string) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Long enough that a sequential await can never overlap two calls.
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    const index = code.match(/block(\d+)/)?.[1] ?? "?";
    return `it declares block ${index}`;
  };

  const processed = await formatCodeForTts(input, "explain", summarizer);

  // Six code blocks used to cost six sequential model round-trips.
  assert(peak > 1, "summarizer calls must overlap; a sequential loop pays for each block in turn");
  assert(peak < 6, "the explanations must go through a bounded pool, not all at once");
  // The explanations are still assembled in the text's own order.
  for (let i = 0; i < 6; i++) {
    assert(
      processed.includes(`it declares block ${i}`),
      `the explanation for block ${i} must be spoken`,
    );
    assertEquals(processed.includes(`const block${i} =`), false, "raw code is never read aloud");
  }
  assert(
    processed.indexOf("it declares block 0") < processed.indexOf("it declares block 5"),
    "explanations must appear in the original code block order",
  );
});

Deno.test("formatCodeForTts - one failing explanation does not drop the others (audio-feed-8acp)", async () => {
  const input = [
    "```js\nconst bad = 1;\n```",
    "Between.",
    "```js\nconst good = 2;\n```",
  ].join("\n\n");
  const processed = await formatCodeForTts(input, "explain", (code) => {
    if (code.includes("bad")) throw new Error("summarizer backend offline");
    return "the second block is fine";
  });
  assertEquals(processed.includes("Here is what that code does: the second block is fine"), true);
  // The failed block is omitted, never narrated as raw code.
  assertEquals(processed.includes("const bad"), false);
  assertEquals(processed.includes("Between."), true);
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

/**
 * WHAT THIS ASSERTS, and why the wall-clock promise is gone (audio-feed-0evr, audio-feed-cf91x).
 *
 * The property is the SCAN'S OWN WORK. `ScanWork.examined` counts the characters the scan's forward searches
 * had to cover (src/tts/gemini.ts), and it is measured, not guessed - on this VM, for the fixed workload below:
 *
 *   fences, 16,000 markers ( 64,000 chars)    768,088,000 examined  = 12,001x the input length
 *   fences, 64,000 markers (256,000 chars) 12,288,352,000 examined  = 48,001x the input length
 *   <pre>  , 32,000 openers (352,000 chars)     1,408,000 examined  = 4.00x the input length
 *   no-gt  ,100,000 openers (500,000 chars)     1,499,996 examined  = 3.00x the input length
 *
 * A COUNT cannot be made comfortable by whatever ran first, which is what went wrong with the wall clock: on
 * identical code and the same filter, at a quiet load, this scan read 250ms when run alone, 230ms with a filter
 * that matched a couple of earlier tests, and 50ms inside the whole file - a 5x swing no assertion about the
 * scan's own cost should depend on. The count is identical in all three conditions because it is the same
 * string work, so the order dependence is removed by construction instead of being given a warmer neighbour.
 *
 * THE FENCE PATH IS LINEAR NOW (audio-feed-1mowv), and this test pins that instead of tolerating quadratic. Before
 * the fix a 4x input cost 4.00x the work PER DOUBLING - 16.00x in total, 12,288,352,000 examined characters at 64k
 * markers - because `nextFenceRun` searched for BOTH delimiters on every call and, when one of them did not occur
 * in the text at all, that search walked to the end of the text: O(n) work, O(n) times. The same defect existed on
 * the <pre> side, where a NULL lookup never set the exhausted flag. The fix is the same on both: a delimiter that
 * is absent from the text is not searched at all, and a null lookup sets exhaustion because `from` only increases.
 * Measured after the fix, the same 64k input examines 32,000 characters - 2.00x per doubling, linear - so every
 * fence assertion below is the linear band and a quadratic regression fails here rather than passing inside a
 * quadratic-sized tolerance.
 *
 * WHAT THIS NO LONGER SEES, stated rather than glossed: a constant-factor slowdown that does no extra string
 * work would pass. That is the price of an order-independent assertion - a duration cannot tell "this work is
 * expensive" from "this box is busy" - and the honest instrument for constant factors is a benchmark, not a gate.
 */
const FENCE_SCAN_MARKERS = 16_000;
const FENCE_SCAN_MARKERS_4X = FENCE_SCAN_MARKERS * 4;
const PRE_OPENERS = 32_000;
const NO_GT_OPENERS = 100_000;
/** examined <= 8x len; measured 4.00x (<pre>), 3.00x (no-gt) and 0.13x (fences, after audio-feed-1mowv). */
const SCAN_WORK_LINEAR_CEILING = 8;
/**
 * 4x the input must not cost more than 6x the work: measured 4.00x since audio-feed-1mowv made the scan linear, and
 * 16.00x before it. This window is what fails if the quadratic comes back.
 */
const SCAN_WORK_GROWTH_CEILING = 6;
/** ...and must cost at least 3x, or the scan did not look at the extra text at all (measured 4.00x). */
const SCAN_WORK_GROWTH_FLOOR = 3;
/**
 * A HANG GUARD, NOT A PERFORMANCE PROMISE (audio-feed-cf91x). The promise is the work count above; this exists
 * so that a scan which stops terminating fails the test rather than the gate. Stated as a guard is the point: as
 * a promise it was a machine measurement that a neighbour could move.
 *
 * The number is set from measurement with real headroom, and the measurements are the reason it is loose: the
 * 16k fence scan measures 62ms bare and 288ms inside this test, and the 64k scan 893ms bare but 4092ms inside
 * this test (the same work, differently scheduled - exactly why a DOMINANT wall-clock assertion was the wrong
 * thing to assert here in the first place). The earlier wall-clock form of this measurement read 250ms run
 * alone, 230ms with a filter matching earlier tests and 50ms in the whole file, and 4.1-9.1s under CPU
 * starvation. 15s is >=3x the worst observed figure, so it fires on non-termination and not on a busy box.
 */
const SCAN_HANG_GUARD_MS = 15_000;

/** One scan of `text`: its work, its wall time (the guard), and what it classified (the decision). */
function scanOf(text: string): { examined: number; ms: number; blocks: number } {
  const work: ScanWork = { examined: 0 };
  const started = performance.now();
  const blocks = extractCodeBlocks(text, work);
  return {
    examined: work.examined,
    ms: performance.now() - started,
    blocks: blocks.length,
  };
}

Deno.test("formatCodeForTts - the fence scan's WORK is counted and is LINEAR in the input (audio-feed-c0gj, audio-feed-cg8s, audio-feed-0evr, audio-feed-cf91x, audio-feed-1mowv)", async () => {
  const unclosedPre = "<pre><code>".repeat(PRE_OPENERS);
  const unclosedFences = "```\n".repeat(FENCE_SCAN_MARKERS);
  const unclosedFences4x = "```\n".repeat(FENCE_SCAN_MARKERS_4X);
  const unclosedNoGt = "<pre ".repeat(NO_GT_OPENERS);

  // The DECISION half: what each scan classifies. Unterminated <pre> and `<pre ` openers close no block; fence
  // markers can pair at most once per two markers.
  const preScan = scanOf(unclosedPre);
  const fenceScan = scanOf(unclosedFences);
  const fenceScan4x = scanOf(unclosedFences4x);
  const noGtScan = scanOf(unclosedNoGt);
  assertEquals(preScan.blocks, 0, "an unterminated <pre> sequence closes no block");
  assertEquals(noGtScan.blocks, 0, "`<pre ` with no `>` closes no block");
  assert(
    fenceScan.blocks > 0 && fenceScan.blocks <= FENCE_SCAN_MARKERS / 2,
    `fence markers pair into blocks, at most one per two markers: got ${fenceScan.blocks} for ${FENCE_SCAN_MARKERS} markers`,
  );
  assertEquals(
    fenceScan4x.blocks,
    fenceScan.blocks * 4,
    "four times the markers must classify four times the blocks, not fewer",
  );

  // The WORK half. A count is the assertion; the wall clock below is only a guard.
  // NO FLOOR for <pre> and no-gt, deliberately: since audio-feed-1mowv both stop as soon as they know no closer
  // exists (`examined` is 0 for these inputs), and a floor here would assert work the scan should be avoiding. The
  // decision assertions above say it classified them correctly; the ceilings below say it cannot be super-linear.
  assert(
    preScan.examined <= SCAN_WORK_LINEAR_CEILING * unclosedPre.length,
    `the <pre> scan must stay linear in the text: examined ${preScan.examined} for ${unclosedPre.length} characters ` +
      `(${
        (preScan.examined / unclosedPre.length).toFixed(2)
      }x, ceiling ${SCAN_WORK_LINEAR_CEILING}x)`,
  );
  assert(
    noGtScan.examined <= SCAN_WORK_LINEAR_CEILING * unclosedNoGt.length,
    `the no-gt scan must stay linear in the text: examined ${noGtScan.examined} for ${unclosedNoGt.length} characters ` +
      `(${
        (noGtScan.examined / unclosedNoGt.length).toFixed(2)
      }x, ceiling ${SCAN_WORK_LINEAR_CEILING}x)`,
  );
  assert(
    fenceScan.examined >= unclosedFences.length / 64,
    `the fence scan must examine the text: examined ${fenceScan.examined} for ${unclosedFences.length} characters`,
  );
  assert(
    fenceScan.examined <= SCAN_WORK_LINEAR_CEILING * unclosedFences.length,
    `the fence scan must stay linear in the text: examined ${fenceScan.examined} for ` +
      `${unclosedFences.length} characters ` +
      `(${
        (fenceScan.examined / unclosedFences.length).toFixed(2)
      }x, ceiling ${SCAN_WORK_LINEAR_CEILING}x)`,
  );
  const growth = fenceScan4x.examined / fenceScan.examined;
  assert(
    growth >= SCAN_WORK_GROWTH_FLOOR,
    `4x the fence markers must cost at least the input's own growth in work: measured ${
      growth.toFixed(2)
    }x`,
  );
  assert(
    growth <= SCAN_WORK_GROWTH_CEILING,
    `4x the fence markers must not cost more than ${SCAN_WORK_GROWTH_CEILING}x the work: measured ` +
      `${
        growth.toFixed(2)
      }x (a linear scan reads ~4.00x for a 4x input; the quadratic this bead removed read ~16x)`,
  );

  // The count is a property of the INPUT, so a repeat scan must agree exactly. A scanner that leaked position
  // between calls - the reference implementation in this file needs `lastIndex = 0` for exactly that reason -
  // would show up here.
  assertEquals(
    scanOf(unclosedFences).examined,
    fenceScan.examined,
    "the same input must cost the same work on a second scan",
  );

  // The guard. Deliberately loose; see SCAN_HANG_GUARD_MS.
  for (
    const [name, scan] of [
      ["<pre>", preScan],
      ["fences", fenceScan],
      ["fences 4x", fenceScan4x],
      ["no-gt", noGtScan],
    ] as const
  ) {
    assert(
      scan.ms < SCAN_HANG_GUARD_MS,
      `the ${name} scan must terminate: it did not finish inside the ${SCAN_HANG_GUARD_MS}ms HANG GUARD ` +
        `(measured ${
          scan.ms.toFixed(0)
        }ms). This is a guard, not a performance promise - the promise is the ` +
        `examined-character count above.`,
    );
  }

  // The public entry point still returns the unterminated shapes unchanged (the decision the old equalities
  // made) and a string for the fence shape.
  assertEquals(await formatCodeForTts(unclosedPre, "skip"), unclosedPre);
  assertEquals(await formatCodeForTts(unclosedNoGt, "skip"), unclosedNoGt);
  assert(typeof (await formatCodeForTts(unclosedFences, "skip")) === "string");

  // Printed on every run so a reader of the gate log sees WHAT is asserted and on what measurement.
  console.log(
    `formatCodeForTts scan WORK (characters examined, counted - NOT a duration; hang guard ${SCAN_HANG_GUARD_MS}ms): ` +
      `<pre> ${preScan.examined} (${(preScan.examined / unclosedPre.length).toFixed(2)}x input) ${
        preScan.ms.toFixed(0)
      }ms / ` +
      `fences ${fenceScan.examined} (${
        (fenceScan.examined / unclosedFences.length).toFixed(2)
      }x input) ${fenceScan.ms.toFixed(0)}ms / ` +
      `fences 4x ${fenceScan4x.examined} (${growth.toFixed(2)}x the 16k work) ${
        fenceScan4x.ms.toFixed(0)
      }ms / ` +
      `no-gt ${noGtScan.examined} (${
        (noGtScan.examined / unclosedNoGt.length).toFixed(2)
      }x input) ${noGtScan.ms.toFixed(0)}ms`,
  );
});

Deno.test("formatCodeForTts - differential equivalence with reference regex grammar across edge shapes (audio-feed-c0gj, audio-feed-cg8s)", async () => {
  const referenceRegex =
    /(?:```+|~~~+)(?:[^\n\r]*\r?\n)?([\s\S]*?)(?:```+|~~~+)|<pre\b[^>]*>(?:<code\b[^>]*>)?([\s\S]*?)(?:<\/code>)?<\/pre>/gi;

  function referenceFormatCode(text: string): string {
    if (!referenceRegex.test(text)) {
      return text;
    }
    referenceRegex.lastIndex = 0;
    return text
      .replace(referenceRegex, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  const shapes = [
    "",
    "Plain text without any code fences or pre tags.",
    "`inline` code and ``double inline`` code should not be stripped.",
    "```code```",
    "```js\r\nconst x = 1;\r\n```",
    "~~~py\r\ndef f():\r\n  return 1\r\n~~~",
    "Prefix\r\n```\r\ncode\r\n```\r\nSuffix",
    "```foo.bar-baz_123:test\nspecial\n```",
    "```c++\nint x = 1;\n```",
    "```c#\nint x = 1;\n```",
    '<pre class="hljs" id="test"><code class="language-ts">const a = 1;</code></pre>',
    '<pre style="color: red;" onclick="alert(1)">raw code</pre>',
    "<PRE><CODE>UPPERCASE</CODE></PRE>",
    "<Pre><Code>MixedCase</Code></Pre>",
    "<pre><code>&lt;div&gt;&amp;quot;test&amp;quot;&lt;/div&gt;</code></pre>",
    "~~~~~~~<code>const x = 1;c++",
    "~~~~<PRE></PRE>python</CODE>```Paragraph\n\n",
    "````</PRE>def foo(): pass```Paragraph in between.\n\n~~~~```",
    "```js\n// fence\n```\n```ts\ninner\n```",
    "Text before\n```js\ncode\n```\nText between\n<pre><code>html code</code></pre>\nText after",
    "````\n```\n````",
    "```\n~~~~\n```",
    "~~~~\n````\n~~~~",
    "Intro\n```\nconst x = 1;",
    "Intro\n~~~python\ndef f():",
    "```\n",
    "~~~",
    "```",
    "````",
    "Prefix\n```\nSuffix",
    "```\n```",
    "```\r\n```",
    "<pre></pre>",
    "<pre><code></code></pre>",
    "<pre>code</pre>",
    "<pre><code no-gt here</pre>",
  ];

  // audio-feed-ewedg hardening: the shapes named in the review - nested fences, an unterminated fence, an absent
  // delimiter, tilde fences of 3..7 characters, and mixed ~ / ` fences - GENERATED rather than hand-picked, and
  // compared against the SAME reference grammar. This stays a real differential (both implementations over generated
  // inputs); nothing here carves out an exception for a shape the fast path gets wrong.
  const generated: string[] = [];
  for (const len of [3, 4, 5, 6, 7]) {
    const ticks = "`".repeat(len);
    const tildes = "~".repeat(len);
    for (
      const [open, close] of [[ticks, ticks], [tildes, tildes], [ticks, tildes], [tildes, ticks]]
    ) {
      generated.push(
        `${open}\ninner\n${close}`,
        `${open}js\nconst a = 1;\n${close}`,
        `${open}\n`, // unterminated
        `${open}`, // nothing but an opener
        `before\n${open}\ncode\n${close}\nafter`,
        `${open}\n${open}\n${close}\n${close}`, // nested
      );
    }
  }
  generated.push(
    "~~~\n```\n~~~\n```",
    "```\n~~~\n```",
    "~~~~\n````\n~~~~",
    "plain text with no delimiters at all",
    "only ``` here",
    "only ~~~ here",
    "~~~~~~~<code>const x = 1;c++",
    "\`\`\`inline only\`\`\`",
  );
  const allShapes = [...shapes, ...generated];

  for (const shape of allShapes) {
    const expected = referenceFormatCode(shape);
    const actual = await formatCodeForTts(shape, "skip");
    assertEquals(
      actual,
      expected,
      `mismatch on shape: ${JSON.stringify(shape)}`,
    );
  }
});

Deno.test("formatCodeForTts - fast-path returns text untouched when no code blocks exist (audio-feed-c0gj, audio-feed-cg8s)", async () => {
  // 13 distinct plain-text shapes measured in fixc0gj
  const plainInputs = [
    "",
    "Simple plain text paragraph.",
    "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    "Inline `single` backtick code.",
    "Double ``inline`` backticks.",
    "HTML tags like <p>paragraph</p> and <br> and <b>bold</b>.",
    "Fake pre tags like <previous> or <prelude> or <presentation>.",
    "Mathematical comparisons: a < b and c > d.",
    "Mathematical expressions: 3 < 5 > 2.",
    "Japanese CJK text: こんにちは、これはテストです。",
    "Emoji text: 🎙️ 🎧 🔊",
    "Accented characters: naïve café résumé façade.",
    "   Whitespace and newlines only:   \n\n   \t  \n  ",
  ];

  for (const input of plainInputs) {
    const hasPotentialCode = input.includes("```") || input.includes("~~~") ||
      /<pre\b/i.test(input);
    assertEquals(hasPotentialCode, false, `fixture must not have potential code: ${input}`);
    const output = await formatCodeForTts(input, "skip");
    assertEquals(output, input, "no-code text must be returned untouched");
  }
});

Deno.test("formatCodeForTts - codeOpenRegex must not cross a </pre> regression test (audio-feed-cg8s)", async () => {
  // Divergent input: "<pre><code no-gt here</pre>"
  // Measured defect in fixc0gj v2: codeOpenRegex greedily consumed through the closing '>' of </pre>,
  // causing the </pre> closer match to fail, hasMorePre to go false, and markup left in text.
  // The baseline regex backtracks and strips.
  const divergentInput = "<pre><code no-gt here</pre>";

  // 1. Skip mode: must strip markup completely
  const skipped = await formatCodeForTts(divergentInput, "skip");
  assertEquals(skipped, "", "divergent input must be stripped cleanly");

  // 2. Explain mode: must extract '<code no-gt here' and invoke summarizer
  let summarizedCode = "";
  const explained = await formatCodeForTts(divergentInput, "explain", (code) => {
    summarizedCode = code;
    return `summary(${code})`;
  });
  assertEquals(summarizedCode, "<code no-gt here");
  assertStringIncludes(explained, "summary(<code no-gt here)");

  // 3. Block AST: extractCodeBlocks extracts the block with correct boundaries
  const blocks = extractCodeBlocks(divergentInput);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]!.full, "<pre><code no-gt here</pre>");
  assertEquals(blocks[0]!.code, "<code no-gt here");
  assertEquals(blocks[0]!.index, 0);
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

Deno.test("formatCodeForTts: one exhausted fence type must not re-scan the text (audio-feed-ewedg)", () => {
  // Reviewer's repro from audio-feed-ewedg: a single `~~~` fence followed by thousands of ``` fences. A STATIC
  // "both delimiters occur somewhere" limit kept looking for `~~~` on every marker, missed, and walked to the end of
  // the text - measured 2.00 x n^2, 128,024,006 characters at n=8000. The scan limit is now an exhaustion POINT, so
  // later markers skip while a smaller `from` (matchFence re-searches from an opener's end) still searches; the same
  // input reads 36,006 and the differential-equivalence test proves the output is unchanged.
  const scanOf = (markers: number): number => {
    const work = { examined: 0 };
    extractCodeBlocks("~~~\n" + "```\n".repeat(markers), work);
    return work.examined;
  };
  const small = scanOf(2_000);
  const large = scanOf(8_000);
  // Linear: the text grows 4x with the markers, so examined work grows about 4x. The quadratic version read 16x.
  const growth = large / small;
  assert(
    growth < 6,
    `4x the markers must cost about 4x the work, not 16x: ${small} -> ${large} is ${
      growth.toFixed(2)
    }x`,
  );
  // Absolute band: the scan may not examine more than a few characters per input character (measured 2.25x).
  const length = "~~~\n".length + "```\n".length * 8_000;
  assert(
    large <= 8 * length,
    `examined ${large} for ${length} characters (${(large / length).toFixed(2)}x, ceiling 8x)`,
  );
});
