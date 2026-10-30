/**
 * The prompt-site census predicate, and the reason it exists.
 *
 * A REASONING-LLM PROMPT SITE is a function that builds the string a model will
 * follow: instructions the model obeys, in the same string where publisher-controlled
 * data (article title, author, summary, body) can land. If that data is interpolated
 * raw, a hostile article can steer the model — which is exactly the defect
 * buildScriptPrompt's fence (fencedRegion + UNTRUSTED_FENCE_TAG in
 * src/worker/script.ts) exists to close. Nothing stopped the NEXT prompt site from
 * being written with raw interpolation, because "which functions build prompts" was a
 * fact kept in reviewers' heads. This census makes it a derived fact: the set of
 * prompt sites is measured on every run and pinned to an exact list, so a new prompt
 * built as an instruction-marker block or an output-contract literal DOES red and
 * names the site; a single INTERLEAVED literal carrying an instruction with no
 * output-contract phrase is INVISIBLE (see DECLARED LIMITS below).
 *
 * HOW A SITE IS FOUND — two arms, both deliberately narrow:
 *
 * 1. THE TEXT NET, two firing shapes. A function containing an instruction-bearing
 *    template literal with NO interpolation (an instruction block: "You are ...") is a
 *    prompt site — the buildScriptPrompt shape, where data may pass through helper
 *    calls (fencedRegion) as well as template holes. Or a single literal carrying BOTH
 *    an output contract ("Respond with ...") and an interpolation — the interleaved
 *    shape a small prompt builder takes. Measured on the real tree the net has zero
 *    false positives: HTML pages and the service worker carry instruction-ish wording
 *    ("do not share", "You are offline") only inside their big interpolated templates
 *    and never use output-contract vocabulary, and a comment-carried prompt example is
 *    blanked by maskNonCode().
 *
 * 2. THE DECLARED SITES. A function whose leading comment carries a census marker is a
 *    site by declaration: PROMPT-CENSUS:TRANSCRIPT-ONLY (interpolated literals carry
 *    publisher data to be SPOKEN and no instruction region — the TTS builders) or
 *    PROMPT-CENSUS:APP-VALUES-ONLY (interpolated literals are instructions whose
 *    interpolated values are app-computed bookkeeping, never publisher data — the
 *    batch continuation prompt in createGroundedScriptGenerator).
 *
 * HOW A SITE IS JUDGED. fenced — the body routes untrusted fields through
 * fencedRegion(); transcript-only or app-values-only — declared by marker; otherwise
 * unmitigated, which is the row-red state.
 *
 * DECLARED LIMITS, because a census with unstated holes is worse than none:
 * - A prompt built as ONE interleaved template literal (instructions and ${values} in
 *   the same literal) with no instruction block is NOT caught by the text net — the
 *   loose imperative wording such a literal shares with HTML/UI copy ("do not", "must
 *   not") makes the same-literal arm a false-positive generator, measured. Such a site
 *   is caught only if its author declares it. This hole is stated and executably
 *   pinned in the consuming test row.
 * - Only function declarations are enumerated (the shape of every prompt builder in
 *   this repo); only the src/ tree is walked.
 * - Regex literals are not masked (maskNonCode's own limit), so a regex containing a
 *   backtick could confuse literal pairing. None in this repo does.
 * - THE MARKERS ARE TRUSTED, NOT VERIFIED: a site that copies a census marker onto a
 *   builder that really does mix publisher data into instructions bypasses the census.
 *   That is the cost of a comment-carried declaration — the alternative (deciding
 *   which interpolated segment is "an instruction") is exactly the clever detector
 *   this repo's census rules forbid. The trade is stated in the test row too.
 */

import { maskNonCode } from "./source-mask.ts";

/**
 * Instruction-ish markers that make a template literal part of a PROMPT rather than
 * UI copy or an error message. Deliberately second-person and role-assigning — these
 * occur in buildScriptPrompt and buildNarrationSystemPrompt today. Wider lists ("do
 * not", "must not") measured as false positives on HTML pages and the service worker,
 * which is why they are not here.
 */
export const INSTRUCTION_MARKERS: readonly string[] = [
  "You are",
  "Respond with",
  "Respond only",
  "Your job",
];

/**
 * The OUTPUT-CONTRACT vocabulary, for the interleaved shape: when "Respond with/only"
 * and an interpolation share ONE literal, the string is telling a model how to answer
 * about interpolated data. UI copy never tells the reader to respond in a format, which
 * is what keeps this arm free of the HTML/service-worker false positives that banned
 * the looser imperative wording. The batch continuation prompt ("Write EXACTLY N
 * turns...") does NOT use this vocabulary — which is why it is a DECLARED site instead.
 */
const OUTPUT_CONTRACT_RE = /(?:(?:Respond\s+with)|(?:Respond\s+only))/i;

const INSTRUCTION_MARKER_RE = new RegExp(
  `(${INSTRUCTION_MARKERS.map((m) => m.replace(/ /g, "\\s+")).join("|")})`,
  "i",
);

/**
 * The comment markers that DECLARE a site safe by a stated mechanism. Trusted, not
 * verified — see the module comment: a dishonest marker bypasses the census, and the
 * consuming test row says so where the reader will meet it.
 */
export const TRANSCRIPT_ONLY_MARKER = "PROMPT-CENSUS:TRANSCRIPT-ONLY";
export const APP_VALUES_ONLY_MARKER = "PROMPT-CENSUS:APP-VALUES-ONLY";

/** How a site's instruction/data mixing is judged. */
export type PromptMitigation = "fenced" | "transcript-only" | "app-values-only" | "unmitigated";

/** One enumerated prompt site. */
export interface PromptSite {
  /** File path relative to the walked root, e.g. "src/worker/script.ts". */
  file: string;
  /** The function's declared name. */
  name: string;
  mitigation: PromptMitigation;
  /** How the site was found: the text net (either firing shape) or a declaration marker. */
  foundBy: "instruction-block" | "interleaved-output-contract" | "declared-marker";
  /** The mixing literals found in the function, raw text, for failure messages. */
  literals: string[];
}

export interface PromptCensus {
  sites: PromptSite[];
  /** Sites with no declared safety mechanism — the state that must red a row. */
  unmitigated: PromptSite[];
}

/**
 * The span of every REAL template literal in the source: [startOfBacktick, endPastBacktick].
 * Found in the maskNonCode() projection — where comments and plain-string interiors are
 * blanked, so a prompt EXAMPLE in a comment cannot open a literal — with its text read
 * from the raw source at identical offsets, because instruction markers live in the
 * interior the masker erases.
 */
export function templateLiteralRanges(
  masked: string,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== "`") {
      i++;
      continue;
    }
    let j = i + 1;
    let depth = 0;
    let closed = false;
    while (j < masked.length) {
      const d = masked[j]!;
      if (d === "\\") {
        j += 2;
        continue;
      }
      if (depth === 0 && d === "`") {
        closed = true;
        break;
      }
      if (depth === 0 && d === "$" && masked[j + 1] === "{") {
        j += 2;
        depth = 1;
        continue;
      }
      if (depth > 0) {
        if (d === "{") depth++;
        else if (d === "}") depth--;
        j++;
        continue;
      }
      j++;
    }
    if (closed) ranges.push([i, j + 1]);
    i = j + 1;
  }
  return ranges;
}

/** A function declaration found in masked text: name and body span. */
interface FunctionSpan {
  name: string;
  /** Offset of the declaration's first character. */
  declStart: number;
  bodyStart: number;
  /** Offset one past the body's closing `}`. */
  bodyEnd: number;
}

const FUNCTION_DECL_SOURCE =
  /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/
    .source;

/**
 * Function declarations, found on the MASKED text so a comment cannot declare one,
 * with bodies balanced on the masked text so a brace inside a string cannot end one.
 * A declaration's span starts being scanned AFTER the previous span's body, so
 * declarations inside another function's body are not separately enumerated — the
 * outer function is the unit, which is where prompt builders live.
 */
export function functionSpans(masked: string): FunctionSpan[] {
  const spans: FunctionSpan[] = [];
  const re = new RegExp(FUNCTION_DECL_SOURCE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1]!;
    let k = m.index + m[0].length;
    let parenDepth = 1;
    while (k < masked.length && parenDepth > 0) {
      if (masked[k] === "(") parenDepth++;
      else if (masked[k] === ")") parenDepth--;
      k++;
    }
    while (k < masked.length && masked[k] !== "{") k++;
    if (k >= masked.length) continue;
    const bodyStart = k;
    let depth = 0;
    let bodyEnd = -1;
    while (k < masked.length) {
      const c = masked[k]!;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          bodyEnd = k + 1;
          break;
        }
      }
      k++;
    }
    if (bodyEnd < 0) continue;
    spans.push({ name, declStart: m.index, bodyStart, bodyEnd });
    re.lastIndex = bodyEnd;
  }
  return spans;
}

/**
 * The census marker declared in the comment block immediately above a declaration,
 * scanning from the previous declaration's end so one function's marker cannot be
 * credited to the next one down.
 */
export function declaredMarker(
  source: string,
  span: FunctionSpan,
  previousEnd: number,
): PromptMitigation | null {
  const lead = source.slice(Math.max(0, previousEnd), span.declStart);
  if (lead.includes(TRANSCRIPT_ONLY_MARKER)) return "transcript-only";
  if (lead.includes(APP_VALUES_ONLY_MARKER)) return "app-values-only";
  return null;
}

/** The census for ONE source file. */
export function promptCensusSource(
  source: string,
  relativePath: string,
): PromptSite[] {
  const masked = maskNonCode(source);
  const spans = functionSpans(masked);
  const literals = templateLiteralRanges(masked);
  const sites: PromptSite[] = [];

  for (let s = 0; s < spans.length; s++) {
    const span = spans[s]!;
    const previousEnd = s > 0 ? spans[s - 1]!.bodyEnd : 0;
    const declared = declaredMarker(source, span, previousEnd);

    const bodyMasked = masked.slice(span.bodyStart, span.bodyEnd);
    const fenced = /\bfencedRegion\s*\(/.test(bodyMasked);

    const bodyLiterals: string[] = [];
    let hasInstructionBlock = false;
    let interleavedContract = false;
    for (const [start, end] of literals) {
      if (start < span.bodyStart || end > span.bodyEnd) continue;
      const text = source.slice(start, end);
      bodyLiterals.push(text);
      const interpolates = text.includes("${");
      if (!interpolates && INSTRUCTION_MARKER_RE.test(text)) {
        hasInstructionBlock = true;
      }
      if (interpolates && OUTPUT_CONTRACT_RE.test(text)) {
        interleavedContract = true;
      }
    }

    // The net fires two ways: the buildScriptPrompt shape (an instruction block — data
    // may pass through helper calls like fencedRegion rather than a template hole, which
    // is why an interpolation is NOT required), or the interleaved shape (an output
    // contract and a value in the same literal). An instruction-only builder with no
    // interpolated data is watched too: it reds the row until it is judged or declared,
    // because "no untrusted input TODAY" is exactly the fact that drifts silently.
    const netFound = hasInstructionBlock || interleavedContract;
    if (!netFound && declared === null) continue;

    const mitigation: PromptMitigation = fenced ? "fenced" : declared ?? "unmitigated";
    const mixingLiterals = netFound
      ? bodyLiterals.filter((text) =>
        INSTRUCTION_MARKER_RE.test(text) || OUTPUT_CONTRACT_RE.test(text)
      )
      : [];

    sites.push({
      file: relativePath,
      name: span.name,
      mitigation,
      foundBy: interleavedContract && !hasInstructionBlock
        ? "interleaved-output-contract"
        : netFound && declared === null
        ? "instruction-block"
        : "declared-marker",
      literals: mixingLiterals,
    });
  }
  return sites;
}

/** Walk the src/ tree of a repository root and census every .ts file in it. */
export async function promptCensus(root: string, dir = "src"): Promise<PromptCensus> {
  const sites: PromptSite[] = [];
  const stack: string[] = [`${root}/${dir}`];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      const source = await Deno.readTextFile(path);
      const relative = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
      sites.push(...promptCensusSource(source, relative));
    }
  }
  return {
    sites,
    unmitigated: sites.filter((site) => site.mitigation === "unmitigated"),
  };
}
