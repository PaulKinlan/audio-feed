/**
 * The call-arity counter's pins — the guard against the trailing-comma
 * off-by-one that miscounted `until()` twice in one night (2026-02): a
 * top-level-comma splitter reads a MULTI-LINE call whose last argument has a
 * trailing comma as three arguments, a census published 101 two-argument sites
 * where the truth was 170, and a sweep plus its review both certified a file as
 * swept with eight unbounded calls left. Every rule below is one of the ways
 * that mistake happened or hid.
 *
 * The shape follows tests/prompt_census_test.ts: the predicate lives in
 * scripts/call-arity.ts with declared limits, synthetic sources pin each rule
 * (a counter validated only on the real tree drifts with the tree), and the
 * real-tree number is NOT pinned here — browser-proof scripts land daily, so a
 * pinned count would red on every honest sweep. Reproduce it instead:
 *   deno run --allow-read scripts/call-arity.ts until scripts
 */
import { assertEquals } from "@std/assert";
import { callAritySites } from "../scripts/call-arity.ts";

/** Count only, for rows that do not care about lines. */
function argcs(source: string, callee: string): number[] {
  return callAritySites(source, callee).map((site) => site.argc);
}

// (a) THE BUG ITSELF: a multi-line call whose last argument has a trailing
// comma counts 2, not 3. This is the row that reds if the splitter ever
// resumes the span at the comma again.
Deno.test("multi-line trailing-comma call counts 2, not 3", () => {
  const source = `await until(
  \`location.pathname === "/" && !!document.querySelector('.who .sign-in')\`,
  "signed out",
);
`;
  assertEquals(argcs(source, "until"), [2]);
});

// (b) the plain single-line two-argument call.
Deno.test("single-line two-argument call counts 2", () => {
  assertEquals(argcs(`await until("a", "b");`, "until"), [2]);
});

// (c) the three-argument call (the unbounded shape the sweep hunted).
Deno.test("three-argument call counts 3", () => {
  assertEquals(argcs(`await until("a", "b", 5000);`, "until"), [3]);
});

// (d) commas inside a nested call sit at depth > 0 and never split the outer
// argument list; the nested call is counted as its own site.
Deno.test("nested call with commas counts both sites correctly", () => {
  const source = `const x = until(waitFor(sel, 10), "ready");
`;
  assertEquals(argcs(source, "until"), [2]);
  assertEquals(argcs(source, "waitFor"), [2]);
});

// (e) the declaration is not a call, even with default parameters whose `=`
// would confuse a naive reader.
Deno.test("the declaration itself is not counted as a call", () => {
  const source = `async function until(expr, desc = expr, timeout = 15_000) {
  return true;
}
until("a", "b");
`;
  assertEquals(callAritySites(source, "until"), [{ line: 4, argc: 2 }]);
});

// (f) a mention inside a comment or a string is not a call.
Deno.test("mentions in comments and strings are not counted", () => {
  const source = `// until("a", "b", "c") in a comment is not a call
const doc = 'call until("x", "y", "z") when ready';
until("a", "b");
`;
  assertEquals(callAritySites(source, "until"), [{ line: 3, argc: 2 }]);
});

// Zero arguments: `f()` is 0, and `f(\n)` (whitespace must never read as an
// argument) is 0.
Deno.test("empty argument list counts 0", () => {
  assertEquals(argcs(`until();`, "until"), [0]);
  assertEquals(argcs("until(\n);", "until"), [0]);
});

// Depth awareness beyond nested calls: object/array/template holes and arrow
// bodies put commas at depth > 0.
Deno.test("commas inside objects, arrays and template holes do not split arguments", () => {
  const source = `until({ a: 1, b: 2 }, [1, 2, 3], \`x\${ { p: 1, q: 2 } } y\`);
`;
  assertEquals(argcs(source, "until"), [3]);
});

// A member access or a glued identifier is a DIFFERENT function.
Deno.test("member access and identifier gluing are not counted", () => {
  assertEquals(argcs(`page.until("a", "b");`, "until"), []);
  assertEquals(argcs(`wait_until("a", "b");`, "until"), []);
});

// A mention not followed by `(` is not a call (the helper passed as a value).
Deno.test("a bare mention without parentheses is not a call", () => {
  assertEquals(argcs(`const f = until;`, "until"), []);
});
