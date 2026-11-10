/**
 * audio-feed-q2cf5: the route census in THREAT_MODEL.md is a claim about the WHOLE population of
 * entry points, so it is checked against the tree instead of restated by whichever lane adds the
 * next route.
 *
 * WHY THIS EXISTS. `THREAT_MODEL.md` ("Entry-point coverage") states that every entry point is one
 * `router.<method>(...)` registration in `src/app.ts`, that `createRouter` registers all 72 of them
 * itself, and that "the census is the whole population, not a sample of it". The section had just
 * been repaired (it said 32 POST where the tree has 33, so the parts no longer summed to the route
 * count) when the merger measured what the repair left behind: adding one registration,
 * `router.get("/mutant-census-route", ...)`, took the real total from 72 to 73 and the entire fast
 * suite stayed green. The one signal that a route had appeared — a total that no longer adds up —
 * was arithmetic nobody computed. A figure that is only restated at write time tells a reader when
 * it was last true; it does not tell anyone when it stops being true. So the section's own command
 * is run here.
 *
 * THE ENUMERATION IS THE DOCUMENTED COMMAND, not a cleverer approximation of it. `CENSUS_COMMAND`
 * is the line the section publishes, and `ROUTE_REGISTRATION` is that line's pattern character for
 * character, so this suite counts exactly what a reader who runs the doc's grep counts — including
 * a `router.get(` spelled inside a comment, because that is what grep prints — and cannot part
 * company with the published method. The doc row below refuses a section that stops publishing the
 * command this suite uses, so the two cannot silently diverge.
 *
 * THE EXPECTATION IS A LITERAL, AND THAT IS THE POINT. A total computed from the very enumeration
 * it checks is a tautology dressed as an assertion: an enum that partitions the set it iterates can
 * never disagree with it, so a row shaped that way proves only `rows.length === rows.length`.
 * Parsing the figure back out of `THREAT_MODEL.md` moves the same hole one level up — the doc then
 * becomes the only authority, and a number that is wrong in both places is checked against itself.
 * The numbers below are therefore hand-written from the doc (72 = 35 GET + 33 POST + 3 DELETE +
 * 1 `add`) and independent of both the tree and the prose, which is what lets each row fail:
 *
 *   - the two real-tree rows red when `src/app.ts` gains or loses a registration;
 *   - the doc row reds when the published figure stops matching the pin;
 *   - the mutant row proves the comparison is load-bearing rather than vacuous.
 *
 * Growing the population is a deliberate two-place edit — move the route, move the doc figure,
 * move this literal — and every failure message names the `THREAT_MODEL.md` line to move.
 *
 * Mutant: adding a registration to `src/app.ts` reddens "the route census total matches src/app.ts"
 * and "the route census per-method split matches src/app.ts" by name; the synthetic form of the
 * same mutant is the last row, so the property is pinned even when nobody is watching.
 *
 * WHY THE SOURCE PATH IS A CONSTANT AND NOT AN INLINE LITERAL — the bed this suite has to be AWAKE in.
 * A passing suite that the gate does not run is a comment with a test runner attached, and this suite
 * spent its first revision that way. The fast tier selects suites from a DERIVED read relation
 * (`scripts/test-selection.ts`, consulted by `planTests`), and that relation admits a `.ts` path only
 * when the path is RESOLVER-PROVEN: it arrived through a module-scope constant the resolver can
 * resolve (the `add(..., isProvenRead)` branch, audio-feed-tziw). A literal read of the path is an
 * AUTHORED hint instead — `Deno.readTextFile("src/app.ts")` earns this suite a relation for
 * `THREAT_MODEL.md` (data) and NONE for the source file, because a `.ts` read is presumed to be the
 * import graph's job, and a text read never appears in that graph. MEASURED before `APP_SOURCE` existed: a `THREAT_MODEL.md` change
 * SELECTED this suite, and a `src/app.ts` change selected the graph's suites WITHOUT it (79 suites in
 * the bare planner, 107 with the real reverse graph) while every row below still passed. That is
 * backwards from the risk: the route registration these rows exist to catch is added in `src/app.ts`,
 * so the test was dormant in precisely the change it guards. So the path is DECLARED where the
 * resolver can see it: keep `APP_SOURCE` a module-scope `const` and keep the reads going through it.
 * Inlining the literal back into a call silently drops the relation and re-dormants this suite — the
 * rows cannot see that happen, which is why it is written down here.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/**
 * The file the census counts, held in a module-scope constant ON PURPOSE — this constant IS the
 * declared read relation that puts this suite in the fast tier when `src/app.ts` changes (see the
 * file header). `Deno.readTextFile(APP_SOURCE)` is resolver-proven; a literal argument is not, and a
 * literal argument selects this suite for no change to the file the census is about.
 */
const APP_SOURCE = "src/app.ts";

/**
 * The command `THREAT_MODEL.md` publishes beside the census figure ("Entry-point coverage").
 * `ROUTE_REGISTRATION` below is this command's pattern, character for character.
 */
const CENSUS_COMMAND = "grep -nE 'router\\.(get|post|delete|put|patch|add)\\(' src/app.ts";

/** The grep pattern of `CENSUS_COMMAND`, as a global RegExp. */
const ROUTE_REGISTRATION = /router\.(get|post|delete|put|patch|add)\(/g;

/** Every method name the census pattern counts. */
const METHODS = ["get", "post", "delete", "put", "patch", "add"] as const;

type Method = (typeof METHODS)[number];

/** One `router.<method>(` occurrence in `src/app.ts`. */
interface RouteRegistration {
  method: Method;
}

/**
 * The census `THREAT_MODEL.md` publishes, hand-written from the "Entry-point coverage" sentence
 * "**72 registrations** (35 GET, 33 POST, 3 DELETE, 1 `add`)". See the file header for why this is
 * a literal rather than something derived from `enumerateRouteRegistrations`.
 */
const EXPECTED_ROUTE_CENSUS = {
  total: 72,
  byMethod: { get: 35, post: 33, delete: 3, put: 0, patch: 0, add: 1 },
} as const;

/**
 * The doc text the third row requires: the published figure, spelled exactly as the section spells
 * it. It is written out rather than composed from the pin so the row states what the document must
 * say; moving the pin means moving this sentence too, and the row's message names the line.
 */
const CENSUS_SENTENCE = "**72 registrations** (35 GET, 33 POST, 3 DELETE, 1 `add`)";

/** The section's second statement of the total, in the sentence about `createRouter`. */
const CREATE_ROUTER_SENTENCE = "`createRouter` registers all 72";

function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}

/** 1-based line number of the byte/char position `index` within `text`. */
function lineNumberOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * 1-based line number of the first occurrence of `needle`, or `"unknown"` when the text no longer
 * contains it. Failure messages call this, so it must not be able to throw the message away.
 */
function lineOf(text: string, needle: string): string {
  const index = text.indexOf(needle);
  return index === -1 ? "unknown" : String(lineNumberOf(text, index));
}

/** Enumerates every `router.<method>(` registration in an `src/app.ts` text. */
export function enumerateRouteRegistrations(source: string): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  for (const match of source.matchAll(ROUTE_REGISTRATION)) {
    const method = match[1] ?? "";
    if (!isMethod(method)) continue;
    registrations.push({ method });
  }
  return registrations;
}

/** Counts the enumerated registrations per method, with a zero for a method the tree never uses. */
function countByMethod(registrations: RouteRegistration[]): Record<Method, number> {
  const counts: Record<Method, number> = { get: 0, post: 0, delete: 0, put: 0, patch: 0, add: 0 };
  for (const { method } of registrations) counts[method] += 1;
  return counts;
}

/**
 * The failure message for both real-tree rows, because the fix is the same either way: it names the
 * `THREAT_MODEL.md` lines that carry the figure, what the enumeration actually found, and which
 * methods moved. It names methods rather than `src/app.ts` lines on purpose — on an increase, every
 * line of that method is equally a candidate, and a guessed line would send the reader to the wrong
 * registration. The command in the message prints the real line numbers.
 */
function censusMismatchMessage(doc: string, registrations: RouteRegistration[]): string {
  const counts = countByMethod(registrations);
  const actual = METHODS.map((method) => `${counts[method]} ${method.toUpperCase()}`).join(", ");
  const expected = METHODS.map((method) =>
    `${EXPECTED_ROUTE_CENSUS.byMethod[method]} ${method.toUpperCase()}`
  ).join(", ");
  const moved = METHODS.filter((method) =>
    counts[method] !== EXPECTED_ROUTE_CENSUS.byMethod[method]
  )
    .map((method) => `  ${method}: ${EXPECTED_ROUTE_CENSUS.byMethod[method]} -> ${counts[method]}`);
  const figureLine = lineOf(doc, "that command yields");
  const createRouterLine = lineOf(doc, CREATE_ROUTER_SENTENCE);
  return [
    `the route census drifted: the doc's own command (${CENSUS_COMMAND}) finds ` +
    `${registrations.length} registrations in src/app.ts (${actual}), but this suite pins ` +
    `${EXPECTED_ROUTE_CENSUS.total} (${expected}).`,
    ...(moved.length > 0 ? ["what moved:", ...moved] : []),
    `Fix: run that command, then update the figure at THREAT_MODEL.md:${figureLine} ` +
    `("**${EXPECTED_ROUTE_CENSUS.total} registrations** (35 GET, 33 POST, 3 DELETE, 1 \`add\`)") and ` +
    `THREAT_MODEL.md:${createRouterLine} ("\`createRouter\` registers all ${EXPECTED_ROUTE_CENSUS.total}"), ` +
    `plus EXPECTED_ROUTE_CENSUS and CENSUS_SENTENCE in tests/route_census_test.ts. If the registration ` +
    `was not intended, remove it from src/app.ts instead — do not move the figure.`,
  ].join("\n");
}

Deno.test("audio-feed-q2cf5: the route census total matches src/app.ts", async () => {
  const source = await Deno.readTextFile(APP_SOURCE);
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  const registrations = enumerateRouteRegistrations(source);
  assertEquals(
    registrations.length,
    EXPECTED_ROUTE_CENSUS.total,
    censusMismatchMessage(doc, registrations),
  );
});

Deno.test("audio-feed-q2cf5: the route census per-method split matches src/app.ts", async () => {
  const source = await Deno.readTextFile(APP_SOURCE);
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  const registrations = enumerateRouteRegistrations(source);
  const counts = countByMethod(registrations);
  for (const method of METHODS) {
    assertEquals(
      counts[method],
      EXPECTED_ROUTE_CENSUS.byMethod[method],
      censusMismatchMessage(doc, registrations),
    );
  }
});

Deno.test("audio-feed-q2cf5: THREAT_MODEL.md publishes the pinned census and the command this suite runs", async () => {
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  assertStringIncludes(
    doc,
    CENSUS_COMMAND,
    `THREAT_MODEL.md:${
      lineOf(doc, "The count is mechanical")
    } must publish the command this suite ` +
      `enumerates with, so the doc's figure and the pinned one are derived the same way: ` +
      `${CENSUS_COMMAND}`,
  );
  assertStringIncludes(
    doc,
    CENSUS_SENTENCE,
    `THREAT_MODEL.md:${
      lineOf(doc, "that command yields")
    } must state the pinned census, verbatim: ` +
      `"${CENSUS_SENTENCE}" (src/app.ts enumerates ${EXPECTED_ROUTE_CENSUS.total} registrations).`,
  );
  assertStringIncludes(
    doc,
    CREATE_ROUTER_SENTENCE,
    `THREAT_MODEL.md:${
      lineOf(doc, "are mounted from that single registration path")
    } must state the ` +
      `pinned total in its createRouter sentence: "${CREATE_ROUTER_SENTENCE}" — the section states ` +
      `the figure twice and both statements can go stale.`,
  );
});

Deno.test("audio-feed-q2cf5: mutant adding a registration moves the enumerated count off the pin", async () => {
  const source = await Deno.readTextFile(APP_SOURCE);
  const mutant = `${source}\nrouter.get("/mutant-census-route", () => new Response("mutant"));\n`;
  const mutantRegistrations = enumerateRouteRegistrations(mutant);
  // The comparison in the rows above is what has to red. Proven here rather than asserted: the same
  // enumerator, one extra registration, and the total and the GET split both leave the pin.
  assertEquals(
    mutantRegistrations.length,
    EXPECTED_ROUTE_CENSUS.total + 1,
    "the enumerator must count a route added at the end of src/app.ts",
  );
  assertEquals(
    countByMethod(mutantRegistrations).get,
    EXPECTED_ROUTE_CENSUS.byMethod.get + 1,
    "the per-method split must count a GET added at the end of src/app.ts",
  );
  assert(
    mutantRegistrations.length !== EXPECTED_ROUTE_CENSUS.total,
    "one extra registration must not equal the pinned total, or the real-tree rows are vacuous",
  );
});
