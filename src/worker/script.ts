/**
 * Pre-TTS script stage: a grounded deep-dive dialogue (audio-feed-yaz5).
 *
 * WHY THIS EXISTS
 * Deep dives were shallow because the dialogue was assembled from static slices of the
 * article body (`formatDialoguePrompt`'s `art.body.slice(400, 1600)` and its fixed
 * welcome/tease/takeaway turns). No model ever *read* the article to decide what was worth
 * discussing, so the conversation could not carry background, outside evidence, or a
 * genuine disagreement — the two speakers were reading the same excerpt back at each other.
 *
 * This module runs BEFORE the TTS call: it asks Gemini, with Google Search grounding, to
 * research the article's subject, collect sources and counterarguments, and then write the
 * multi-turn script. The synthesizer passes the resulting `turns` to `synthesizeDialogue`,
 * which already renders `input.turns` through the same code path as a manually written
 * script (see `DialogueInput.turns`), so nothing in the TTS layer has to change shape.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * - It does not fail synthesis. A grounded call costs money and can be refused (safety,
 *   quota, an outage, a model that returns prose instead of JSON); the caller falls back to
 *   the static builder and logs why, exactly as the pipeline behaved before this stage
 *   existed. A shallow episode is a worse episode, not a dead queue.
 * - It does not use `responseMimeType: "application/json"`. Grounding and strict JSON mode
 *   are not a combination the API guarantees; asking for a JSON contract in the prompt and
 *   parsing it tolerantly (fences, surrounding prose) keeps grounding, which is the whole
 *   point of the stage. A response that cannot be parsed is a typed error, not a guess.
 *
 * The request body, the prompt and the parser are exported so a test can assert on the
 * outgoing request and on the parsing rules without standing up a model — the same reason
 * `formatDialoguePrompt` is exported.
 */
import type { DialogueSpeaker, DialogueTurn } from "../tts/gemini.ts";
import { runManagedTurns } from "../synthesis/limits.ts";

/**
 * The text model that does the research and writes the script. Separate from
 * `DEFAULT_TTS_MODEL` on purpose: TTS is a different model family and a different price.
 * Overridable per instance so an operator (or a test) can pin one without an edit.
 */
export const DEFAULT_SCRIPT_MODEL = "gemini-3.8-flash";

const GEMINI_GENERATE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * A grounded answer can legitimately be long, but the article is bounded: past this much body
 * the request buys latency, not understanding. The head of a piece carries the thesis; the
 * tail is where a TTS prompt used to slice blindly.
 */
export const DEFAULT_MAX_BODY_CHARS = 12_000;
/** Long grounded research and 14 scripted turns must not rely on the model's default output cap. */
export const SCRIPT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * How long the grounded call may take before the stage gives up and synthesis falls back
 * (audio-feed-yaz5 review). A research call that hangs is indistinguishable from a dead queue
 * from the outside, so the bound belongs here rather than in the operator's patience.
 *
 * THE NUMBER (audio-feed-yr76): the measured distribution on real grounded calls is
 * min 14.7s / p50 19.3s / max 19.7s (n=4, sotw-ds-flash, 2026-10-04), so 30s was only ~1.5x
 * the observed maximum over a tail four samples have not probed — and grounded search fans out
 * to retrieval before generating, so a long tail is plausible. The cost asymmetry decides it:
 * a timeout throws away a call that was ALREADY PAID FOR (the episode falls back to the static
 * builder — spend wasted, quality lost), while a too-late timeout costs only queue wall time.
 * 60s is ~3x the observed max. The open follow-up the bead records: pull the timeout-classified
 * fallback rate from Workers Logs over a meaningful sample when log access is wired into the
 * fleet's tooling — ~0% closes the question for good, low single digits+ says raise it again.
 * Injected so a test can use 50ms.
 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;

export interface ScriptSource {
  title: string;
  uri: string;
}

export interface GroundedScript {
  turns: DialogueTurn[];
  /** Web sources the model actually saw, taken from the response's grounding metadata. */
  sources: ScriptSource[];
  /** The criticisms the script was built to answer; also asserted on by tests. */
  counterarguments: string[];
  /** One paragraph of background, kept for logging/debugging rather than for TTS. */
  researchSummary: string;
}

export interface GroundedScriptInput {
  article: { title: string; author?: string; body: string; summary?: string };
  speakers: [DialogueSpeaker, DialogueSpeaker];
  /** Upper bound on turns the model may write; the prompt states it and the parser trims to it. */
  maxTurns?: number;
}

export interface GroundedScriptDeps {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
  maxBodyChars?: number;
  /** Deadline for one grounded call; see DEFAULT_SCRIPT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injected clock-free logging seam so a test can assert the reason a fallback happened. */
  onWarn?: (message: string) => void;
}

/** Thrown for every failure this stage can have; the caller decides whether to fall back. */
export class GroundedScriptError extends Error {
  readonly status?: number;
  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "GroundedScriptError";
    this.status = options.status;
  }
}

/**
 * The prompt is the product here, so it states the contract explicitly:
 * research first, name the disagreement, cite by name, then write the turns as JSON.
 * The schema is described in prose because the response is parsed tolerantly (see the
 * module comment); the parser accepts exactly this shape and nothing more exotic.
 */
export function buildScriptPrompt(input: GroundedScriptInput & { maxBodyChars?: number }): string {
  const { article, speakers } = input;
  const maxTurns = input.maxTurns ?? 14;
  const bodyChars = input.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const expert = speakers.find((s) => s.role === "expert") ?? speakers[0];
  const foil = speakers.find((s) => s.role === "curious_foil" || s.role === "host") ?? speakers[1];
  const authorLine = article.author ? ` by ${article.author}` : "";

  return [
    `You are preparing a critical, evidence-led audio deep dive about the article below.`,
    `Research the subject with Google Search before you write anything. Your job is not to`,
    `summarise the article — it is to test it.`,
    ``,
    `ARTICLE: "${article.title}"${authorLine}`,
    article.summary ? `EDITOR'S SUMMARY: ${article.summary}` : ``,
    `ARTICLE BODY:`,
    article.body.slice(0, bodyChars),
    ``,
    `RESEARCH REQUIREMENTS:`,
    `1. Establish the background a listener needs to judge the article's claims.`,
    `2. Find external sources: primary documents, competing reporting, data, or expert comment.`,
    `3. Find the strongest counterarguments and criticisms of the article's position. Include at`,
    `   least three, and prefer ones the article does not address.`,
    `4. Note where evidence is thin, contested, or missing.`,
    ``,
    `SCRIPT REQUIREMENTS:`,
    `- Two speakers: ${expert.name} (expert) and ${foil.name} (curious foil).`,
    `- At most ${maxTurns} turns, alternating, starting with ${foil.name}.`,
    `- ${foil.name} presses on weaknesses and asks the questions a sceptical listener would;`,
    `  ${expert.name} answers with evidence and names sources in prose ("according to ...").`,
    `- The dialogue must engage the counterarguments rather than mention them in passing.`,
    `- Spoken prose only: no headings, no stage directions, no citation markers like [1].`,
    `- Ground every factual claim you make in the sources you found; if the sources disagree,`,
    `  say so rather than picking a side silently.`,
    ``,
    `Respond with a single JSON object and nothing else:`,
    `{"researchSummary": string, "counterarguments": string[], "sources": [{"title": string, "uri": string}], "turns": [{"speaker": string, "text": string}]}`,
  ].filter((line) => line !== ``).join("\n");
}

/**
 * Tolerant parse of the model's answer: a JSON object, optionally fenced or surrounded by
 * prose. Everything else is a typed error — guessing at a half-written dialogue would put
 * invented words in a listener's ears.
 */
function parseScriptObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new GroundedScriptError("script response contained no JSON object");
  }
  try {
    const result: unknown = JSON.parse(body.slice(start, end + 1));
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("not an object");
    }
    return result as Record<string, unknown>;
  } catch (error) {
    throw new GroundedScriptError("script response was not valid JSON", { cause: error });
  }
}

export function parseGroundedScript(text: string, maxTurns = 14): GroundedScript {
  return normaliseScript(parseScriptObject(text), maxTurns);
}

/**
 * The API's grounding metadata is where the sources come from: the model's own `sources`
 * array is a claim, the metadata is the record of what search actually returned. Both are
 * kept, metadata first, because a listener-facing citation should be a page that exists.
 */
export function sourcesFromGrounding(payload: unknown): ScriptSource[] {
  const candidate = firstCandidate(payload);
  const chunks = (candidate?.groundingMetadata as { groundingChunks?: unknown } | undefined)
    ?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set<string>();
  const sources: ScriptSource[] = [];
  for (const chunk of chunks) {
    const web = (chunk as { web?: { uri?: unknown; title?: unknown } })?.web;
    const uri = typeof web?.uri === "string" ? web.uri : "";
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: typeof web?.title === "string" && web.title ? web.title : uri, uri });
  }
  return sources;
}

function firstCandidate(payload: unknown): Record<string, unknown> | undefined {
  const candidates = (payload as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const first = candidates[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : undefined;
}

/** The visible text of the first candidate, concatenated across its parts. */
export function textFromResponse(payload: unknown): string {
  const candidate = firstCandidate(payload);
  const content = candidate?.content as { parts?: unknown } | undefined;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const text = (part as { text?: unknown })?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function normaliseScript(payload: unknown, maxTurns: number): GroundedScript {
  const record = (payload ?? {}) as Record<string, unknown>;
  const rawTurns = Array.isArray(record.turns) ? record.turns : [];
  const turns: DialogueTurn[] = [];
  for (const raw of rawTurns) {
    const speaker = (raw as { speaker?: unknown })?.speaker;
    const text = (raw as { text?: unknown })?.text;
    if (typeof speaker !== "string" || typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    turns.push({ speaker: speaker.trim(), text: trimmed });
    if (turns.length >= maxTurns) break;
  }
  if (turns.length < 2) {
    throw new GroundedScriptError(
      `script response produced ${turns.length} usable turn(s); a dialogue needs at least two`,
    );
  }
  const counterarguments = Array.isArray(record.counterarguments)
    ? record.counterarguments.filter((item): item is string =>
      typeof item === "string" && item.trim() !== ""
    )
      .map((item) => item.trim())
    : [];
  const declaredSources = Array.isArray(record.sources)
    ? record.sources.flatMap((item): ScriptSource[] => {
      const title = (item as { title?: unknown })?.title;
      const uri = (item as { uri?: unknown })?.uri;
      if (typeof uri !== "string" || !uri) return [];
      return [{ title: typeof title === "string" && title ? title : uri, uri }];
    })
    : [];
  return {
    turns,
    sources: declaredSources,
    counterarguments,
    researchSummary: typeof record.researchSummary === "string"
      ? record.researchSummary.trim()
      : "",
  };
}

export type ScriptGenerator = (
  input: GroundedScriptInput,
  /** The caller's deadline. Generators should pass it to fetch; the call site also bounds them. */
  options?: { signal?: AbortSignal },
) => Promise<GroundedScript>;

interface ScriptBatchTurn extends DialogueTurn {
  id: number;
}
type ScriptSegment = { kind: "full" | "batch"; from: number; count: number };
type ScriptResult = { segment: ScriptSegment; script: GroundedScript; turns: ScriptBatchTurn[] };

/** Only MAX_TOKENS can trigger continuation. Never accept an incomplete JSON fragment. */
export class GroundedScriptOutputLimitError extends GroundedScriptError {
  constructor() {
    super("script output reached maxOutputTokens; retrying bounded complete JSON batches");
    this.name = "GroundedScriptOutputLimitError";
  }
}

/** A complete batch must contain exactly the assigned id range, with no silent omissions. */
function parseScriptBatch(
  text: string,
  segment: ScriptSegment,
  allowedSpeakers: readonly string[],
): ScriptResult {
  const record = parseScriptObject(text);
  const raw = record.turns;
  if (!Array.isArray(raw) || raw.length !== segment.count) {
    throw new GroundedScriptError(
      `script batch expected ${segment.count} turns from id ${segment.from}`,
    );
  }
  const turns: ScriptBatchTurn[] = raw.map((item, offset) => {
    const turn = item as { id?: unknown; speaker?: unknown; text?: unknown };
    if (
      turn?.id !== segment.from + offset || typeof turn.speaker !== "string" ||
      !allowedSpeakers.includes(turn.speaker.trim()) || typeof turn.text !== "string" ||
      !turn.text.trim()
    ) {
      throw new GroundedScriptError(
        `script batch missing or duplicated turn id ${segment.from + offset}`,
      );
    }
    return { id: segment.from + offset, speaker: turn.speaker.trim(), text: turn.text.trim() };
  });
  const sources = Array.isArray(record.sources)
    ? record.sources.flatMap((item): ScriptSource[] => {
      const source = item as { title?: unknown; uri?: unknown };
      return typeof source?.uri === "string" && source.uri
        ? [{ uri: source.uri, title: typeof source.title === "string" ? source.title : source.uri }]
        : [];
    })
    : [];
  const counterarguments = Array.isArray(record.counterarguments)
    ? record.counterarguments.filter((item): item is string =>
      typeof item === "string" && !!item.trim()
    )
    : [];
  return {
    segment,
    turns,
    script: {
      turns,
      sources,
      counterarguments,
      researchSummary: typeof record.researchSummary === "string"
        ? record.researchSummary.trim()
        : "",
    },
  };
}

/** Exact id sequence catches a dropped/duplicated section; adjacent duplicate text catches
 * a repeated sentence across the boundary even when the model labels it with a new id. */
export function assertScriptTurnSeams(turns: readonly ScriptBatchTurn[], expected: number): void {
  if (turns.length !== expected) {
    throw new GroundedScriptError(`script seam has ${turns.length} of ${expected} turns`);
  }
  for (let index = 0; index < turns.length; index++) {
    if (turns[index]?.id !== index) {
      throw new GroundedScriptError(`script seam missing or duplicated turn id ${index}`);
    }
    if (!turns[index]!.text.trim()) {
      throw new GroundedScriptError(`script seam empty turn text at turn id ${index}`);
    }
    if (
      index && turns[index]!.text.trim().replace(/\s+/gu, " ").toLowerCase() ===
        turns[index - 1]!.text.trim().replace(/\s+/gu, " ").toLowerCase()
    ) {
      throw new GroundedScriptError(`script seam duplicated sentence at turn id ${index}`);
    }
  }
}

/**
 * The real generator. `fetchFn` is injectable so the tests drive this exact request path
 * with a capturing fetch rather than asserting on a helper the call site might not use.
 */
export function createGroundedScriptGenerator(deps: GroundedScriptDeps): ScriptGenerator {
  const model = deps.model ?? DEFAULT_SCRIPT_MODEL;
  const maxBodyChars = deps.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const warn = deps.onWarn ?? ((message: string) => console.warn(message));
  if (!deps.apiKey) {
    // Constructing a generator without a key would fail on every episode; the caller decides
    // whether to stage the script at all, so this is a programming error, not a runtime one.
    throw new GroundedScriptError("createGroundedScriptGenerator requires an API key");
  }
  return async (input, options) => {
    const fetchFn = deps.fetchFn ?? fetch;
    const url = `${GEMINI_GENERATE_ENDPOINT}/${model}:generateContent?key=${deps.apiKey}`;
    const maxTurns = input.maxTurns ?? 14;
    if (!Number.isInteger(maxTurns) || maxTurns < 2 || maxTurns > 32) {
      throw new GroundedScriptError("script maxTurns must be an integer from 2 to 32");
    }
    const prompt = buildScriptPrompt({ ...input, maxTurns, maxBodyChars });
    const grounded: ScriptSource[] = [];
    const segments: ScriptSegment[] = [{ kind: "full", from: 0, count: maxTurns }];
    const script = await runManagedTurns<ScriptSegment, ScriptResult, GroundedScript>({
      segments,
      maxTurns: Math.min(6, maxTurns * 2 + 1),
      request: async (segment, completed) => {
        const previous = completed.flatMap((result) => result.turns);
        const batchInstruction =
          `The previous answer hit the output token limit. Restart this batch as a COMPLETE, valid JSON object; do not continue a partial JSON string. ` +
          `Write EXACTLY ${segment.count} turns with numeric ids ${segment.from} through ${
            segment.from + segment.count - 1
          }, as {"turns":[{"id":number,"speaker":string,"text":string}]} (plus research fields for the first batch). ` +
          `Do not repeat earlier ids or spoken sentences. ${
            segment.from === 0
              ? "Include researchSummary, counterarguments, and sources."
              : "Keep previous research and sources; output only this turn range."
          }`;
        const contents = segment.kind === "full"
          ? [{ role: "user", parts: [{ text: prompt }] }]
          : previous.length
          ? [
            { role: "user", parts: [{ text: prompt }] },
            { role: "model", parts: [{ text: JSON.stringify({ turns: previous }) }] },
            { role: "user", parts: [{ text: batchInstruction }] },
          ]
          : [{ role: "user", parts: [{ text: `${prompt}\n\n${batchInstruction}` }] }];
        const body = {
          contents,
          tools: [{ googleSearch: {} }],
          generationConfig: { temperature: 0.7, maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS },
        };
        // Each turn has its own deadline; the synthesis caller also bounds the whole stage.
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        let response: Response;
        try {
          response = await fetchFn(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          });
        } catch (error) {
          if (options?.signal?.aborted) {
            throw new GroundedScriptError("script request was cancelled by the caller", {
              cause: error,
            });
          }
          if (deadline.aborted) {
            throw new GroundedScriptError(`script request timed out after ${timeoutMs}ms`, {
              cause: error,
            });
          }
          throw new GroundedScriptError("script request failed before reaching the API", {
            cause: error,
          });
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new GroundedScriptError(
            `script request was refused with ${response.status}${
              detail ? `: ${detail.slice(0, 200)}` : ""
            }`,
            { status: response.status },
          );
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          throw new GroundedScriptError("script response was not JSON", { cause: error });
        }
        grounded.push(...sourcesFromGrounding(payload));
        const reason = firstCandidate(payload)?.finishReason;
        if (reason === "MAX_TOKENS") throw new GroundedScriptOutputLimitError();
        if (
          typeof reason === "string" && reason !== "STOP" && reason !== "FINISH_REASON_UNSPECIFIED"
        ) {
          throw new GroundedScriptError(`script generation stopped with ${reason}`);
        }
        const text = textFromResponse(payload);
        if (!text.trim()) throw new GroundedScriptError("script response contained no text");
        return segment.kind === "full"
          ? { segment, script: parseGroundedScript(text, maxTurns), turns: [] }
          : parseScriptBatch(text, segment, input.speakers.map((speaker) => speaker.name));
      },
      continueOnOutputLimit: (segment, error) => {
        if (!(error instanceof GroundedScriptOutputLimitError) || segment.count < 2) return null;
        // Never stitch an incomplete JSON fragment. Regenerate two complete, smaller id ranges.
        const first = Math.ceil(segment.count / 2);
        return {
          next: [
            { kind: "batch", from: segment.from, count: first },
            { kind: "batch", from: segment.from + first, count: segment.count - first },
          ],
        };
      },
      stitch: (results) => {
        if (results.length === 1 && results[0]?.segment.kind === "full") return results[0].script;
        const turns = results.flatMap((result) => result.turns);
        assertScriptTurnSeams(turns, maxTurns);
        const first = results.find((result) => result.segment.from === 0);
        if (!first?.script.researchSummary || first.script.counterarguments.length === 0) {
          throw new GroundedScriptError("continued script omitted research or counterarguments");
        }
        return {
          turns: turns.map(({ speaker, text }) => ({ speaker, text })),
          sources: results.flatMap((result) => result.script.sources),
          counterarguments: [
            ...new Set(results.flatMap((result) => result.script.counterarguments)),
          ],
          researchSummary: first.script.researchSummary,
        };
      },
    });
    // Grounding metadata records the sources actually retrieved across ALL calls, even a
    // MAX_TOKENS response; model-declared sources come after it and are URI-deduplicated.
    const sources: ScriptSource[] = [];
    const seen = new Set<string>();
    for (const source of [...grounded, ...script.sources]) {
      if (seen.has(source.uri)) continue;
      seen.add(source.uri);
      sources.push(source);
    }
    if (sources.length === 0) {
      warn(
        `[script] grounded script for "${input.article.title}" came back without sources; the dialogue may be uncited`,
      );
    }
    return { ...script, sources };
  };
}
