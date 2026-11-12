/**
 * audio-feed-thwir: trusted non-threat register dynamic RegExp population, pinned against a
 * hand-written classification.
 *
 * THREAT_MODEL.md register row 5 originally exempted an entire vulnerability class (dynamic pattern
 * use / RegExp construction) on a sample of seven anchors. That violated the register's preamble:
 * "Under no circumstances may an admitted accepted residual or a broad vulnerability class be
 * declared a trusted non-threat shape."
 *
 * Dynamic RegExp construction cannot be trusted by class: constructing regular expressions from
 * arbitrary user-controlled input can introduce ReDoS or pattern injection. In the audio-feed
 * runtime (`src/` and `main.ts`), exactly three dynamic `new RegExp` constructor sites exist:
 *
 *   1. `src/routes/shell.ts:572` - matches `CONFIRM_SHARED_BEGIN` escaped via `escapeRegExp`
 *   2. `src/routes/shell.ts:573` - matches `CONFIRM_SHARED_END` escaped via `escapeRegExp`
 *   3. `src/worker/script.ts:153` - matches `<tag>` over internal hardcoded `FENCE_NAMES`
 *
 * Every dynamic pattern site is derived at runtime by scanning `src/` and `main.ts`, and every
 * site found must appear in `TRUSTED_DYNAMIC_REGEXP_SITES`. A new dynamic RegExp site fails the test
 * until audited and added to the register.
 *
 * Mutant: adding `new RegExp(userInput)` to any runtime file reddens this suite.
 */

import { assert, assertEquals } from "@std/assert";
import { stripComments } from "../scripts/test-selection.ts";

/**
 * Hand-written list of audited dynamic RegExp sites in `src/` and `main.ts`.
 * Every entry is a verified safe pattern: interpolation is escaped via `escapeRegExp()`
 * or drawn from an internal constant list, never from arbitrary user input.
 */
export const TRUSTED_DYNAMIC_REGEXP_SITES = [
  'src/routes/shell.ts new RegExp(`^${escapeRegExp(CONFIRM_SHARED_BEGIN)}$`, "m")',
  'src/routes/shell.ts new RegExp(`^${escapeRegExp(CONFIRM_SHARED_END)}$`, "m")',
  'src/worker/script.ts new RegExp(`<\\\\s*\\\\/?\\\\s*(?:${FENCE_NAMES.join("|")})[^>]*>`, "gi")',
];

/** Extracts the full call expression `(new )?RegExp(...)` starting at `startIdx`. */
export function extractCall(text: string, startIdx: number): string | null {
  const openIdx = text.indexOf("(", startIdx);
  if (openIdx === -1) return null;
  let depth = 1;
  let inStr: string | null = null;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === inStr) {
        inStr = null;
      }
    } else {
      if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    i++;
  }
  return text.slice(startIdx, i);
}

/** Recursively collects all `.ts` and `.js` runtime source files under `dir`. */
async function getSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...(await getSourceFiles(fullPath)));
    } else if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Scans a source text for dynamic `new RegExp(...)` or `RegExp(...)` construction sites. */
export function scanSourceForDynamicRegExp(relPath: string, source: string): string[] {
  const { stripped } = stripComments(source);
  const regex = /(?:^|[^\w$])(?:new\s+)?RegExp\s*\(/g;
  const calls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stripped)) !== null) {
    const startIdx = match.index + (match[0].startsWith("n") || match[0].startsWith("R") ? 0 : 1);
    const call = extractCall(stripped, startIdx);
    if (call) {
      calls.push(`${relPath} ${call}`);
    }
  }
  return calls;
}

/** Derives the runtime population of dynamic RegExp sites across `src/` and `main.ts`. */
export async function deriveDynamicRegExpPopulation(): Promise<string[]> {
  const allFiles = [...(await getSourceFiles("src")).sort(), "main.ts"];
  const population: string[] = [];
  for (const file of allFiles) {
    const content = await Deno.readTextFile(file);
    population.push(...scanSourceForDynamicRegExp(file, content));
  }
  return population;
}

Deno.test("audio-feed-thwir: every dynamic RegExp site in src/ is classified in TRUSTED_DYNAMIC_REGEXP_SITES", async () => {
  const derived = await deriveDynamicRegExpPopulation();
  assertEquals(
    derived.sort(),
    [...TRUSTED_DYNAMIC_REGEXP_SITES].sort(),
    "the dynamic RegExp population changed: dynamic patterns cannot be trusted by class (THREAT_MODEL.md preamble). " +
      "Every new dynamic pattern must be audited and pinned in TRUSTED_DYNAMIC_REGEXP_SITES and the non-threat register.",
  );
});

Deno.test("audio-feed-thwir: mutant adding new RegExp(userInput) fails the population assertion", () => {
  const mutantCode = 'export const search = new RegExp(userInput, "i");';
  const mutantCalls = scanSourceForDynamicRegExp("src/routes/search.ts", mutantCode);
  assertEquals(mutantCalls, ['src/routes/search.ts new RegExp(userInput, "i")']);
  const isClassified = TRUSTED_DYNAMIC_REGEXP_SITES.includes(mutantCalls[0]!);
  assertEquals(
    isClassified,
    false,
    "unclassified dynamic regex with userInput must not be in TRUSTED_DYNAMIC_REGEXP_SITES",
  );
});

Deno.test("audio-feed-thwir: THREAT_MODEL.md register row 10 documents the exact dynamic RegExp population", async () => {
  const threatModel = await Deno.readTextFile(new URL("../THREAT_MODEL.md", import.meta.url));
  assert(
    threatModel.includes("Dynamic regular expression construction (`new RegExp`)"),
    "THREAT_MODEL.md must contain dynamic RegExp row",
  );
  assert(
    threatModel.includes("`CONFIRM_SHARED_BEGIN`/`CONFIRM_SHARED_END` (`src/routes/shell.ts`)"),
    "THREAT_MODEL.md row 10 must cite the shell.ts constant anchor",
  );
  assert(
    threatModel.includes("`FENCE_NAMES` (`src/worker/script.ts`)"),
    "THREAT_MODEL.md row 10 must cite the script.ts constant anchor",
  );
  // audio-feed-0c5uc: the row cites its anchors by CONSTANT, not by line number — a line range in
  // this row is what drifted to point at the wrong symbol before the sweep.
  assert(
    !/src\/(routes\/shell\.ts|worker\/script\.ts):\d+/.test(threatModel),
    "THREAT_MODEL.md must cite row 10's anchors by constant, not by line number (audio-feed-0c5uc)",
  );
  assert(
    threatModel.includes("3 matches at `34ae917d`"),
    "THREAT_MODEL.md row 10 must record the 3 verified matches",
  );
});
