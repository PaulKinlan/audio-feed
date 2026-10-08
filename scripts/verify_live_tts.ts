/**
 * Bounded live provider verification script for bead audio-feed-u60a.
 * Validates segmentation, token counts, negative control, and audio output
 * against https://gemini.int.exe.xyz/v1beta.
 */

import { buildSingleVoiceRequest, formatNarrationPrompt, MAX_TTS_INPUT_BYTES } from "../src/tts/gemini.ts";
import { splitTextUnderByteBudget } from "../src/synthesis/limits.ts";

const PROXY_BASE = "https://gemini.int.exe.xyz/v1beta";

console.log("=== 1. Checking Model Metadata ===");
const modelRes = await fetch(`${PROXY_BASE}/models/gemini-3.8-flash-tts`);
const modelJson = await modelRes.json();
console.log(`Model: ${modelJson.name}, inputTokenLimit: ${modelJson.inputTokenLimit}, outputTokenLimit: ${modelJson.outputTokenLimit}`);

console.log("\n=== 2. Negative Control (>8192 tokens) ===");
const syntheticLongText = "The quick brown fox jumps over the lazy dog. ".repeat(1500);
const negRes = await fetch(`${PROXY_BASE}/models/gemini-3.8-flash-tts:generateContent`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ parts: [{ text: syntheticLongText }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } }
    }
  })
});
const negJson = await negRes.json();
console.log(`Status: ${negRes.status}, Error: ${negJson.error?.message}`);

console.log("\n=== 3. Segmenting 47k Article ===");
const article = await Deno.readTextFile(new URL("../docs/evidence/audio-feed-gueb/article.txt", import.meta.url));
const input = { title: "History of the Internet", body: article };
const prompt = formatNarrationPrompt(input);
const segments = splitTextUnderByteBudget(prompt, MAX_TTS_INPUT_BYTES);
console.log(`Total prompt bytes: ${new TextEncoder().encode(prompt).length}, Segments: ${segments.length}`);

for (let i = 0; i < segments.length; i++) {
  const bytes = new TextEncoder().encode(segments[i]).length;
  const countRes = await fetch(`${PROXY_BASE}/models/gemini-3.8-flash-tts:countTokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: segments[i] }] }] })
  });
  const countJson = await countRes.json();
  console.log(`Segment ${i + 1}: ${bytes} bytes -> ${countJson.totalTokens} tokens`);
}

console.log("\n=== 4. Bounded Positive Synthesis Call ===");
const sampleText = "Welcome to the Audio Feed briefing. Real provider audio verification complete.";
const synthRes = await fetch(`${PROXY_BASE}/models/gemini-3.8-flash-tts:generateContent`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(buildSingleVoiceRequest(sampleText, "Charon", 0.7))
});
const synthJson = await synthRes.json();
const inline = synthJson.candidates?.[0]?.content?.parts?.[0]?.inlineData;
console.log(`Status: ${synthRes.status}, Model: ${synthJson.modelVersion}, Audio MIME: ${inline?.mimeType}, Base64 length: ${inline?.data?.length}`);
