/**
 * Gemini 3.8 / 2.5 Flash TTS Client
 *
 * Provides:
 * - Single-voice narration mode (Stratechery / Ben Thompson style with title, date, author intro)
 * - Two-voice dialogue mode (NotebookLM style: expert + curious foil)
 * - Voice configuration (Aoede, Charon, Fenrir, Kore, Puck)
 * - Request builder for Google Generative Language API
 * - Response decoder for audio output (PCM, WAV, MP3) with PCM-to-WAV conversion
 */

export const GEMINI_TTS_VOICES = [
  "Aoede",
  "Charon",
  "Fenrir",
  "Kore",
  "Puck",
] as const;

export type GeminiTtsVoice = (typeof GEMINI_TTS_VOICES)[number];

export interface VoiceProfile {
  name: GeminiTtsVoice;
  gender: "female" | "male";
  style: string;
  recommendedRole: "narrator" | "expert" | "curious_foil" | "co-host";
}

export const VOICE_PROFILES: Record<GeminiTtsVoice, VoiceProfile> = {
  Aoede: {
    name: "Aoede",
    gender: "female",
    style: "Breezy, melodic, and engagingly narrative",
    recommendedRole: "co-host",
  },
  Charon: {
    name: "Charon",
    gender: "male",
    style: "Measured, clear, authoritative journalistic narrator",
    recommendedRole: "narrator",
  },
  Fenrir: {
    name: "Fenrir",
    gender: "male",
    style: "Deep, resonant, analytical domain expert",
    recommendedRole: "expert",
  },
  Kore: {
    name: "Kore",
    gender: "female",
    style: "Warm, perceptive, conversational interviewer",
    recommendedRole: "curious_foil",
  },
  Puck: {
    name: "Puck",
    gender: "male",
    style: "Upbeat, lively, inquisitive foil",
    recommendedRole: "curious_foil",
  },
};

export const DEFAULT_NARRATION_VOICE: GeminiTtsVoice = "Charon";
export const DEFAULT_EXPERT_VOICE: GeminiTtsVoice = "Fenrir";
export const DEFAULT_FOIL_VOICE: GeminiTtsVoice = "Puck";

export const DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_API_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

/**
 * Narration input for single-voice reading (Stratechery / Ben Thompson style)
 */
export interface NarrationInput {
  title: string;
  body: string;
  author?: string;
  publishedAt?: string | Date;
  sourceName?: string;
  lead?: string;
  voice?: GeminiTtsVoice | string;
  includeIntro?: boolean;
  customIntro?: string;
}

/**
 * Dialogue speaker specification
 */
export interface DialogueSpeaker {
  name: string;
  role: "expert" | "curious_foil" | "host" | "co-host";
  voice: GeminiTtsVoice | string;
}

/**
 * A single spoken turn in a dialogue script
 */
export interface DialogueTurn {
  speaker: string;
  text: string;
}

/**
 * Dialogue input for two-voice podcast mode (NotebookLM style)
 */
export interface DialogueInput {
  title?: string;
  topic?: string;
  speakers?: [DialogueSpeaker, DialogueSpeaker];
  turns?: DialogueTurn[];
  script?: string;
  article?: {
    title: string;
    author?: string;
    body: string;
    summary?: string;
  };
}

export interface SpeechMetadata {
  speaker?: string;
  style?: string;
}

export interface ContentPart {
  text: string;
  speech_metadata?: SpeechMetadata;
  speechMetadata?: SpeechMetadata;
}

/**
 * Request payload for Gemini GenerateContent API with Audio modality
 */
export interface GeminiGenerateContentRequest {
  contents: Array<{
    role?: string;
    parts: Array<ContentPart>;
  }>;
  generationConfig: {
    responseModalities: ["AUDIO"];
    speechConfig: {
      voiceConfig?: {
        prebuiltVoiceConfig: {
          voiceName: string;
        };
      };
      multiSpeakerVoiceConfig?: {
        speakerVoiceConfigs: Array<{
          speaker: string;
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: string;
            };
          };
        }>;
      };
    };
    temperature?: number;
  };
}

/**
 * Parsed and decoded audio response
 */
export interface DecodedAudioResult {
  rawBytes: Uint8Array;
  mimeType: string;
  format: "pcm" | "wav" | "mp3" | "unknown";
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number;
  toWav(): Uint8Array;
}

/**
 * Options for audio synthesis
 */
export interface SynthesisOptions {
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Client configuration
 */
export interface GeminiTtsClientConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Custom error thrown when the Gemini TTS API returns an error response
 */
export class GeminiTtsError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GeminiTtsError";
  }
}

// ---------------------------------------------------------------------------
// Base64 & Audio Format Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string to a Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/[\s\r\n]+/g, "");
  const binaryString = atob(clean);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a Uint8Array to a base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    if (b !== undefined) {
      binary += String.fromCharCode(b);
    }
  }
  return btoa(binary);
}

/**
 * Detect the audio container or encoding format from binary magic bytes and optional MIME hint
 */
export function detectAudioFormat(
  bytes: Uint8Array,
  mimeHint?: string,
): "pcm" | "wav" | "mp3" | "unknown" {
  if (bytes.length >= 12) {
    // RIFF .... WAVE
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    ) {
      return "wav";
    }
  }

  if (bytes.length >= 3) {
    // ID3v2 tag: "ID3"
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      return "mp3";
    }
    // MPEG frame sync: 11 bits set (0xFF followed by byte with high 3 bits set)
    const b0 = bytes[0];
    const b1 = bytes[1];
    if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) {
      return "mp3";
    }
  }

  if (mimeHint) {
    const lower = mimeHint.toLowerCase();
    if (lower.includes("wav")) return "wav";
    if (lower.includes("mp3") || lower.includes("mpeg")) return "mp3";
    if (lower.includes("pcm") || lower.includes("l16")) return "pcm";
  }

  // Gemini audio/pcm is raw PCM bytes with no container header
  if (mimeHint?.includes("audio/pcm") || mimeHint?.includes("audio/L16")) {
    return "pcm";
  }

  // Default to PCM if non-empty byte buffer from Gemini TTS
  return bytes.length > 0 ? "pcm" : "unknown";
}

/**
 * Wrap raw linear PCM audio into a standard 44-byte RIFF/WAVE header
 */
export function pcmToWav(
  pcmBytes: Uint8Array,
  options: {
    sampleRate?: number;
    numChannels?: number;
    bitsPerSample?: number;
  } = {},
): Uint8Array {
  const sampleRate = options.sampleRate ?? 24000;
  const numChannels = options.numChannels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;

  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBytes.length;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const wavBuffer = new Uint8Array(totalSize);
  const view = new DataView(wavBuffer.buffer);

  // 0-3: "RIFF"
  wavBuffer[0] = 0x52; // R
  wavBuffer[1] = 0x49; // I
  wavBuffer[2] = 0x46; // F
  wavBuffer[3] = 0x46; // F

  // 4-7: ChunkSize = 36 + dataSize
  view.setUint32(4, 36 + dataSize, true);

  // 8-11: "WAVE"
  wavBuffer[8] = 0x57; // W
  wavBuffer[9] = 0x41; // A
  wavBuffer[10] = 0x56; // V
  wavBuffer[11] = 0x45; // E

  // 12-15: "fmt "
  wavBuffer[12] = 0x66; // f
  wavBuffer[13] = 0x6d; // m
  wavBuffer[14] = 0x74; // t
  wavBuffer[15] = 0x20; // ' '

  // 16-19: Subchunk1Size = 16 for PCM
  view.setUint32(16, 16, true);

  // 20-21: AudioFormat = 1 (PCM)
  view.setUint16(20, 1, true);

  // 22-23: NumChannels
  view.setUint16(22, numChannels, true);

  // 24-27: SampleRate
  view.setUint32(24, sampleRate, true);

  // 28-31: ByteRate
  view.setUint32(28, byteRate, true);

  // 32-33: BlockAlign
  view.setUint16(32, blockAlign, true);

  // 34-35: BitsPerSample
  view.setUint16(34, bitsPerSample, true);

  // 36-39: "data"
  wavBuffer[36] = 0x64; // d
  wavBuffer[37] = 0x61; // a
  wavBuffer[38] = 0x74; // t
  wavBuffer[39] = 0x61; // a

  // 40-43: Subchunk2Size = dataSize
  view.setUint32(40, dataSize, true);

  // 44+: PCM raw bytes
  wavBuffer.set(pcmBytes, 44);

  return wavBuffer;
}

/**
 * Parse a standard WAV file header
 */
export function parseWavHeader(bytes: Uint8Array): {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationSeconds: number;
} {
  if (bytes.length < 44) {
    throw new Error(
      "Invalid WAV: byte buffer shorter than standard 44-byte header",
    );
  }

  const isRiff = bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46;
  const isWave = bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45;

  if (!isRiff || !isWave) {
    throw new Error("Invalid WAV: missing RIFF/WAVE container header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 24000;
  let byteRate = 48000;
  let blockAlign = 2;
  let bitsPerSample = 16;
  let dataOffset = 44;
  let dataLength = bytes.length - 44;

  while (offset + 8 <= bytes.length) {
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const b3 = bytes[offset + 3];
    if (
      b0 === undefined ||
      b1 === undefined ||
      b2 === undefined ||
      b3 === undefined
    ) {
      break;
    }
    const chunkId = String.fromCharCode(b0, b1, b2, b3);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      byteRate = view.getUint32(offset + 16, true);
      blockAlign = view.getUint16(offset + 20, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, bytes.length - dataOffset);
      break;
    }

    offset += 8 + chunkSize;
  }

  const bytesPerSecond = byteRate > 0
    ? byteRate
    : (sampleRate * channels * bitsPerSample) / 8;
  const durationSeconds = bytesPerSecond > 0 ? dataLength / bytesPerSecond : 0;

  return {
    audioFormat,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataOffset,
    dataLength,
    durationSeconds,
  };
}

/**
 * Inspect an MP3 byte stream for basic frame metadata and estimated duration
 */
export function inspectMp3(bytes: Uint8Array): {
  channels: number;
  sampleRate: number;
  bitrateKbps: number;
  durationSeconds: number;
} {
  let offset = 0;

  // Skip ID3v2 if present
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    // ID3 synchsafe size at bytes 6..9
    const b6 = bytes[6] ?? 0;
    const b7 = bytes[7] ?? 0;
    const b8 = bytes[8] ?? 0;
    const b9 = bytes[9] ?? 0;
    const id3Size = ((b6 & 0x7f) << 21) |
      ((b7 & 0x7f) << 14) |
      ((b8 & 0x7f) << 7) |
      (b9 & 0x7f);
    offset = 10 + id3Size;
  }

  // Scan for first MPEG frame sync (11 bits set: 0xFF followed by byte with top 3 bits set)
  while (offset + 4 < bytes.length) {
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];
    if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) {
      break;
    }
    offset++;
  }

  let sampleRate = 44100;
  let channels = 2;
  let bitrateKbps = 128;

  if (offset + 4 <= bytes.length) {
    const b1 = bytes[offset + 1] ?? 0;
    const b2 = bytes[offset + 2] ?? 0;
    const b3 = bytes[offset + 3] ?? 0;

    const versionBits = (b1 >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const _layerBits = (b1 >> 1) & 0x03; // 1 = Layer III
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const sampleRateIdx = (b2 >> 2) & 0x03;
    const channelMode = (b3 >> 6) & 0x03;

    channels = channelMode === 3 ? 1 : 2;

    const sampleRateTable = [44100, 48000, 32000];
    const foundSampleRate = sampleRateTable[sampleRateIdx];
    if (foundSampleRate !== undefined) {
      sampleRate = foundSampleRate;
      if (versionBits === 2) sampleRate /= 2; // MPEG-2
      else if (versionBits === 0) sampleRate /= 4; // MPEG-2.5
    }

    // MPEG-1 Layer III bitrates (kbps)
    const bitrateTable = [
      0,
      32,
      40,
      48,
      56,
      64,
      80,
      96,
      112,
      128,
      160,
      192,
      224,
      256,
      320,
      0,
    ];
    const foundBitrate = bitrateTable[bitrateIdx];
    if (foundBitrate !== undefined && foundBitrate > 0) {
      bitrateKbps = foundBitrate;
    }
  }

  const audioBytes = Math.max(0, bytes.length - offset);
  const bytesPerSecond = (bitrateKbps * 1000) / 8;
  const durationSeconds = bytesPerSecond > 0 ? audioBytes / bytesPerSecond : 0;

  return {
    channels,
    sampleRate,
    bitrateKbps,
    durationSeconds,
  };
}

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

/**
 * Format a Date or date string to a clear spoken English format (e.g. "September 24, 2026")
 */
export function formatSpokenDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) {
    return typeof date === "string" ? date : "";
  }
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Build the Stratechery / Ben Thompson style spoken introduction
 */
export function formatNarrationIntro(input: NarrationInput): string {
  if (input.customIntro) {
    return input.customIntro.trim();
  }

  const parts: string[] = [];
  const title = input.title.trim();
  const author = input.author?.trim();
  const dateStr = input.publishedAt ? formatSpokenDate(input.publishedAt) : "";
  const source = input.sourceName?.trim();

  let intro = `The following is ${title}`;
  if (author && dateStr) {
    intro += `, written by ${author}, published on ${dateStr}.`;
  } else if (author) {
    intro += `, written by ${author}.`;
  } else if (dateStr) {
    intro += `, published on ${dateStr}.`;
  } else {
    intro += `.`;
  }
  parts.push(intro);

  if (source) {
    parts.push(`From ${source}.`);
  }

  if (input.lead?.trim()) {
    parts.push(input.lead.trim());
  }

  return parts.join(" ");
}

/**
 * Build the full prompt for single-voice narration (Stratechery style)
 */
export function formatNarrationPrompt(input: NarrationInput): string {
  const includeIntro = input.includeIntro ?? true;
  const introText = includeIntro ? formatNarrationIntro(input) : "";

  const sections: string[] = [];

  sections.push(
    "Read the following article text directly, clearly, and authoritatively in a professional podcast narrator voice.",
    "Maintain a steady, measured pace. Pronounce technical terms with confidence.",
  );

  if (introText) {
    sections.push(`[Spoken Introduction]\n${introText}`);
  }

  sections.push(`[Article Text]\n${input.body.trim()}`);

  return sections.join("\n\n");
}

export interface FormattedDialogue {
  prompt: string;
  turns: DialogueTurn[];
  speakers: [DialogueSpeaker, DialogueSpeaker];
}

/**
 * Parse a text script with "Speaker: Text" lines into structured DialogueTurns
 */
export function parseScriptIntoTurns(
  script: string,
  speakers: [DialogueSpeaker, DialogueSpeaker],
): DialogueTurn[] {
  const lines = script.split("\n").map((l) => l.trim()).filter(Boolean);
  const turns: DialogueTurn[] = [];
  let currentSpeaker = speakers[0].name;

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && colonIdx < 30) {
      const candidateName = line.slice(0, colonIdx).trim();
      const matched = speakers.find(
        (s) => s.name.toLowerCase() === candidateName.toLowerCase(),
      );
      if (matched) {
        currentSpeaker = matched.name;
        const text = line.slice(colonIdx + 1).trim();
        if (text) {
          turns.push({ speaker: currentSpeaker, text });
          continue;
        }
      }
    }

    const lastTurn = turns[turns.length - 1];
    if (lastTurn) {
      lastTurn.text += " " + line;
    } else {
      turns.push({ speaker: currentSpeaker, text: line });
    }
  }

  return turns.length > 0
    ? turns
    : [{ speaker: speakers[0].name, text: script }];
}

/**
 * Format a NotebookLM-style dialogue prompt between an expert and a curious foil
 */
export function formatDialoguePrompt(input: DialogueInput): FormattedDialogue {
  const speakers: [DialogueSpeaker, DialogueSpeaker] = input.speakers ?? [
    { name: "Alex", role: "expert", voice: DEFAULT_EXPERT_VOICE },
    { name: "Sam", role: "curious_foil", voice: DEFAULT_FOIL_VOICE },
  ];

  const expert = speakers.find((s) => s.role === "expert") ?? speakers[0];
  const foil =
    speakers.find((s) => s.role === "curious_foil" || s.role === "host") ??
      speakers[1];

  const topicOrTitle = input.topic || input.title || input.article?.title ||
    "today's subject";

  let turns: DialogueTurn[] = [];

  if (input.turns && input.turns.length > 0) {
    turns = [...input.turns];
  } else if (input.script?.trim()) {
    turns = parseScriptIntoTurns(input.script, speakers);
  } else if (input.article) {
    // Generate conversational script framing based on the article
    const art = input.article;
    const authorLine = art.author ? ` written by ${art.author}` : "";
    turns = [
      {
        speaker: foil.name,
        text:
          `Welcome back to the deep dive! Today we're digging into "${art.title}"${authorLine}. ${expert.name}, this looks like a fascinating read. What's the core thesis here?`,
      },
      {
        speaker: expert.name,
        text:
          `Thanks ${foil.name}. At its heart, this piece is about the practical realities and strategic shifts taking place. Let's start with the central argument: ${
            art.summary || art.body.slice(0, 400)
          }...`,
      },
      {
        speaker: foil.name,
        text:
          `That's a bold claim. How does the author back that up, and what are the trade-offs people usually miss?`,
      },
      {
        speaker: expert.name,
        text: `Here is where it gets really interesting: ${
          art.body.slice(400, 1600)
        }...`,
      },
      {
        speaker: foil.name,
        text:
          `Makes total sense when you frame it that way. What should listeners take away from this?`,
      },
      {
        speaker: expert.name,
        text:
          `The big takeaway is that execution and architectural simplicity beat premature abstraction every single time.`,
      },
    ];
  } else {
    throw new Error(
      "DialogueInput must provide either turns, script, or an article",
    );
  }

  const promptLines: string[] = [
    `You are generating a natural, highly engaging two-voice conversational podcast deep dive in the style of NotebookLM.`,
    `Topic: "${topicOrTitle}".`,
    `Speakers:`,
    `- ${expert.name}: The domain expert. Authoritative, analytical, provides deep technical and strategic context, historical grounding, and architectural nuance.`,
    `- ${foil.name}: The curious interviewer and foil. Sharp, inquisitive, asks real-world clarifying questions, offers accessible analogies, and keeps the conversation dynamic and relatable.`,
    `Style guidelines:`,
    `- Speak with natural human cadence, seamless turn-taking, subtle vocal enthusiasm, and authentic conversational flow.`,
    `- No robotic pauses or unnatural transitions.`,
    `\n[Dialogue Script]`,
    ...turns.map((t) => `${t.speaker}: ${t.text}`),
  ];

  return {
    prompt: promptLines.join("\n"),
    turns,
    speakers,
  };
}

// ---------------------------------------------------------------------------
// Request Builders
// ---------------------------------------------------------------------------

/**
 * Build Gemini GenerateContent request for single-voice narration
 */
export function buildSingleVoiceRequest(
  prompt: string,
  voice: GeminiTtsVoice | string = DEFAULT_NARRATION_VOICE,
  temperature = 0.7,
): GeminiGenerateContentRequest {
  return {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
      temperature,
    },
  };
}

/**
 * Build Gemini GenerateContent request for two-voice dialogue.
 * Attaches speech_metadata.speaker to each part in contents as required by Gemini 3.8 Flash TTS.
 */
export function buildDialogueRequest(
  turnsOrScript: DialogueTurn[] | string,
  speakers: [DialogueSpeaker, DialogueSpeaker],
  temperature = 0.8,
): GeminiGenerateContentRequest {
  const turns = Array.isArray(turnsOrScript)
    ? turnsOrScript
    : parseScriptIntoTurns(turnsOrScript, speakers);

  const parts: ContentPart[] = turns.map((turn) => ({
    text: turn.text,
    speech_metadata: {
      speaker: turn.speaker,
    },
    speechMetadata: {
      speaker: turn.speaker,
    },
  }));

  return {
    contents: [
      {
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            {
              speaker: speakers[0].name,
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: speakers[0].voice,
                },
              },
            },
            {
              speaker: speakers[1].name,
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: speakers[1].voice,
                },
              },
            },
          ],
        },
      },
      temperature,
    },
  };
}

// ---------------------------------------------------------------------------
// Response Decoder
// ---------------------------------------------------------------------------

/**
 * Decode a raw Gemini API JSON response and return DecodedAudioResult
 */
export function decodeAudioResponse(
  jsonResponse: unknown,
  defaultSampleRate = 24000,
): DecodedAudioResult {
  if (!jsonResponse || typeof jsonResponse !== "object") {
    throw new GeminiTtsError(
      "Invalid response: expected JSON object from Gemini API",
    );
  }

  const res = jsonResponse as Record<string, unknown>;

  if (res.error) {
    const err = res.error as Record<string, unknown>;
    throw new GeminiTtsError(
      typeof err.message === "string"
        ? err.message
        : "Gemini API returned an error",
      typeof err.code === "number" ? err.code : 500,
      err,
    );
  }

  const candidates = res.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  if (!candidates || candidates.length === 0) {
    throw new GeminiTtsError("Gemini API response contained no candidates");
  }

  const firstCandidate = candidates[0];
  if (!firstCandidate) {
    throw new GeminiTtsError(
      "Gemini API response contained no valid candidates",
    );
  }

  const finishReason = firstCandidate.finishReason as string | undefined;
  if (
    finishReason && finishReason !== "STOP" &&
    finishReason !== "FINISH_REASON_UNSPECIFIED"
  ) {
    if (finishReason === "SAFETY") {
      throw new GeminiTtsError(
        "Gemini audio generation blocked by SAFETY filter",
      );
    }
  }

  const content = firstCandidate.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  if (!parts || parts.length === 0) {
    throw new GeminiTtsError("Gemini API candidate contained no content parts");
  }

  // Find inline audio part
  let base64Data: string | undefined;
  let mimeType = "audio/pcm;rate=24000";

  for (const part of parts) {
    const inline = (part.inlineData ?? part.inline_data) as
      | { mimeType?: string; mime_type?: string; data?: string }
      | undefined;
    if (inline?.data) {
      base64Data = inline.data;
      mimeType = inline.mimeType ?? inline.mime_type ?? mimeType;
      break;
    }
  }

  if (!base64Data) {
    throw new GeminiTtsError(
      "No inline audio data found in Gemini API candidate parts",
    );
  }

  const rawBytes = base64ToUint8Array(base64Data);
  const format = detectAudioFormat(rawBytes, mimeType);

  let sampleRate = defaultSampleRate;
  let channels = 1;
  let bitsPerSample = 16;
  let durationSeconds = 0;

  // Extract sample rate hint from mimeType if present e.g. "audio/pcm;rate=24000"
  const rateMatch = mimeType.match(/rate=(\d+)/i);
  if (rateMatch && rateMatch[1]) {
    sampleRate = parseInt(rateMatch[1], 10);
  }

  if (format === "wav") {
    try {
      const wavInfo = parseWavHeader(rawBytes);
      sampleRate = wavInfo.sampleRate;
      channels = wavInfo.channels;
      bitsPerSample = wavInfo.bitsPerSample;
      durationSeconds = wavInfo.durationSeconds;
    } catch {
      // Fallback calculation if custom wav header
      const bytesPerSec = (sampleRate * channels * bitsPerSample) / 8;
      durationSeconds = bytesPerSec > 0
        ? (rawBytes.length - 44) / bytesPerSec
        : 0;
    }
  } else if (format === "mp3") {
    const mp3Info = inspectMp3(rawBytes);
    sampleRate = mp3Info.sampleRate;
    channels = mp3Info.channels;
    bitsPerSample = 16;
    durationSeconds = mp3Info.durationSeconds;
  } else {
    // Raw PCM (usually 24kHz, 16-bit mono)
    const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
    durationSeconds = bytesPerSecond > 0 ? rawBytes.length / bytesPerSecond : 0;
  }

  return {
    rawBytes,
    mimeType,
    format,
    sampleRate,
    channels,
    bitsPerSample,
    durationSeconds,
    toWav(): Uint8Array {
      if (format === "wav") {
        return rawBytes;
      }
      return pcmToWav(rawBytes, {
        sampleRate,
        numChannels: channels,
        bitsPerSample,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Main Gemini TTS Client
// ---------------------------------------------------------------------------

export class GeminiTtsClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(config: GeminiTtsClientConfig = {}) {
    let envKey: string | undefined;
    if (config.apiKey === undefined) {
      try {
        if (
          typeof Deno !== "undefined" && typeof Deno.env?.get === "function"
        ) {
          envKey = Deno.env.get("GEMINI_API_KEY");
        }
      } catch {
        // Permission denied or environment access restricted
      }
    }

    this.apiKey = config.apiKey || envKey || "";
    this.model = config.model || DEFAULT_TTS_MODEL;
    this.baseUrl = config.baseUrl || GEMINI_API_BASE_URL;
    this.fetchFn = config.fetchFn || fetch;
  }

  /**
   * Synthesize a single-voice article narration (Stratechery / Ben Thompson style)
   */
  async synthesizeNarration(
    input: NarrationInput,
    options: SynthesisOptions = {},
  ): Promise<DecodedAudioResult> {
    const voice = input.voice || DEFAULT_NARRATION_VOICE;
    const prompt = formatNarrationPrompt(input);
    const request = buildSingleVoiceRequest(prompt, voice, options.temperature);
    return await this.sendRequest(request, options);
  }

  /**
   * Synthesize a two-voice dialogue deep dive (NotebookLM style)
   */
  async synthesizeDialogue(
    input: DialogueInput,
    options: SynthesisOptions = {},
  ): Promise<DecodedAudioResult> {
    const { turns, speakers } = formatDialoguePrompt(input);
    const request = buildDialogueRequest(turns, speakers, options.temperature);
    return await this.sendRequest(request, options);
  }

  /**
   * Send a prepared GenerateContent request to the Gemini API and decode the audio
   */
  async sendRequest(
    request: GeminiGenerateContentRequest,
    options: SynthesisOptions = {},
  ): Promise<DecodedAudioResult> {
    const model = options.model || this.model;
    const apiKey = this.apiKey;

    if (!apiKey) {
      throw new GeminiTtsError(
        "GEMINI_API_KEY is not configured. Set the environment variable or pass apiKey to GeminiTtsClient.",
      );
    }

    // Do not pass API key in query params; send via x-goog-api-key header only
    const url = `${this.baseUrl}/models/${model}:generateContent`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    };

    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: options.signal,
    });

    if (!res.ok) {
      let errDetails: unknown;
      let errMsg = `Gemini API HTTP error ${res.status}: ${res.statusText}`;
      try {
        errDetails = await res.json();
        if (
          errDetails &&
          typeof errDetails === "object" &&
          "error" in errDetails
        ) {
          const apiErr = (errDetails as { error: { message?: string } }).error;
          if (apiErr?.message) {
            errMsg = `Gemini API error: ${apiErr.message}`;
          }
        }
      } catch {
        // use default statusText
      }
      throw new GeminiTtsError(errMsg, res.status, errDetails);
    }

    const json = await res.json();
    return decodeAudioResponse(json);
  }
}
