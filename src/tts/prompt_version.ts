/**
 * promptVersion (audio-feed-8oz): which prompts made an episode's audio.
 *
 * A short hash of what the prompt builders produce for one fixed canonical article,
 * plus the TTS model id. It is computed from the builders rather than kept as a
 * constant, so any change to prompt-building code changes it and nobody has to
 * remember a bump. Lives outside src/tts/gemini.ts on purpose: that file's prompt
 * text is edited by other lanes, and this module only calls its builders.
 */
import { createHash } from "node:crypto";
import {
  buildDialogueRequest,
  buildSingleVoiceRequest,
  DEFAULT_TTS_MODEL,
  formatDialoguePrompt,
  formatNarrationPrompt,
} from "./gemini.ts";
import type { Episode } from "../types.ts";

/** Fixed input: long enough to reach every slice the dialogue builder takes of a body. */
const CANONICAL_BODY = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1} of the canonical article, which exists only to be hashed.`,
).join("\n\n");

export interface PromptVersionDeps {
  formatNarrationPrompt?: typeof formatNarrationPrompt;
  formatDialoguePrompt?: typeof formatDialoguePrompt;
  buildSingleVoiceRequest?: typeof buildSingleVoiceRequest;
  buildDialogueRequest?: typeof buildDialogueRequest;
  model?: string;
}

/** Injectable so a test can show that a changed builder changes the version. */
export function computePromptVersion(deps: PromptVersionDeps = {}): string {
  const narration = (deps.formatNarrationPrompt ?? formatNarrationPrompt)({
    title: "Canonical Article",
    author: "A. Writer",
    publishedAt: "2026-01-01T00:00:00.000Z",
    sourceName: "Canonical Source",
    body: CANONICAL_BODY,
  });
  const dialogue = (deps.formatDialoguePrompt ?? formatDialoguePrompt)({
    title: "Canonical Article",
    article: {
      title: "Canonical Article",
      author: "A. Writer",
      body: CANONICAL_BODY,
      summary: "A canonical summary.",
    },
    speakers: [
      { name: "Alex", role: "expert", voice: "Kore" },
      { name: "Sam", role: "curious_foil", voice: "Puck" },
    ],
  });
  const material = JSON.stringify([
    deps.model ?? DEFAULT_TTS_MODEL,
    (deps.buildSingleVoiceRequest ?? buildSingleVoiceRequest)(narration, "Charon"),
    (deps.buildDialogueRequest ?? buildDialogueRequest)(dialogue.turns, dialogue.speakers),
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

/** Computed once at startup. */
export const PROMPT_VERSION = computePromptVersion();

/**
 * A published episode whose audio was made by other prompts. Episodes made before
 * promptVersion existed have none, and count as outdated.
 */
export function isOutdated(
  episode: Pick<Episode, "status" | "regenerating" | "promptVersion">,
  current: string = PROMPT_VERSION,
): boolean {
  return episode.status === "ready" && !episode.regenerating &&
    episode.promptVersion !== current;
}
