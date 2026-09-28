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
  buildNarrationSystemPrompt,
  buildSingleVoiceRequest,
  DEFAULT_TTS_MODEL,
  formatCodeForTts,
  formatDialoguePrompt,
  formatNarrationPrompt,
} from "./gemini.ts";
import {
  CODE_HANDLINGS,
  type CodeHandling,
  DEFAULT_CODE_HANDLING,
  type Episode,
} from "../types.ts";

/**
 * Fixed input: long enough to reach every slice the dialogue builder takes of a
 * body, with a code block so a change to code-block handling (audio-feed-bdo)
 * moves the version too (audio-feed-ktn).
 */
const CANONICAL_BODY = [
  ...Array.from(
    { length: 20 },
    (_, i) => `Paragraph ${i + 1} of the canonical article, which exists only to be hashed.`,
  ),
  "```js\nconst answer = [1, 2, 3].map((n) => n * 2);\n```",
  ...Array.from(
    { length: 20 },
    (_, i) => `Paragraph ${i + 21} of the canonical article, which exists only to be hashed.`,
  ),
].join("\n\n");

/** Fixed stand-in for the model summariser, so "explain" mode hashes deterministically. */
const CANONICAL_CODE_SUMMARY = "It doubles each number in a short list.";

export interface PromptVersionDeps {
  formatNarrationPrompt?: typeof formatNarrationPrompt;
  formatDialoguePrompt?: typeof formatDialoguePrompt;
  buildSingleVoiceRequest?: typeof buildSingleVoiceRequest;
  buildDialogueRequest?: typeof buildDialogueRequest;
  formatCodeForTts?: typeof formatCodeForTts;
  buildNarrationSystemPrompt?: typeof buildNarrationSystemPrompt;
  defaultCodeHandling?: CodeHandling;
  model?: string;
}

/**
 * Injectable so a test can show that a changed builder changes the version.
 * Async because code-block handling is: every mode runs over the canonical body
 * exactly as the synthesiser runs them, and the default mode is hashed too,
 * because it picks the mode for every feed that sets none (audio-feed-ktn).
 */
export async function computePromptVersion(deps: PromptVersionDeps = {}): Promise<string> {
  const formatCode = deps.formatCodeForTts ?? formatCodeForTts;
  const systemPrompt = deps.buildNarrationSystemPrompt ?? buildNarrationSystemPrompt;
  const narrate = deps.formatNarrationPrompt ?? formatNarrationPrompt;
  const converse = deps.formatDialoguePrompt ?? formatDialoguePrompt;
  const single = deps.buildSingleVoiceRequest ?? buildSingleVoiceRequest;
  const dialogueRequest = deps.buildDialogueRequest ?? buildDialogueRequest;

  const requests: unknown[] = [];
  for (const mode of CODE_HANDLINGS) {
    const body = await formatCode(CANONICAL_BODY, mode, () => CANONICAL_CODE_SUMMARY);
    const system = systemPrompt(mode);
    const narration = narrate({
      title: "Canonical Article",
      author: "A. Writer",
      publishedAt: "2026-01-01T00:00:00.000Z",
      sourceName: "Canonical Source",
      body,
    });
    const dialogue = converse({
      title: "Canonical Article",
      article: {
        title: "Canonical Article",
        author: "A. Writer",
        body,
        summary: "A canonical summary.",
      },
      speakers: [
        { name: "Alex", role: "expert", voice: "Kore" },
        { name: "Sam", role: "curious_foil", voice: "Puck" },
      ],
    });
    requests.push(
      system,
      single(narration, "Charon", undefined, system),
      dialogueRequest(dialogue.turns, dialogue.speakers, undefined, system),
    );
  }
  const material = JSON.stringify([
    deps.model ?? DEFAULT_TTS_MODEL,
    deps.defaultCodeHandling ?? DEFAULT_CODE_HANDLING,
    ...requests,
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

/** Computed once at startup. */
export const PROMPT_VERSION = await computePromptVersion();

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
