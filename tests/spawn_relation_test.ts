/**
 * audio-feed-4kl3: a `.ts` path a suite EXECUTES is a relation, and the change that admits it is TWO SITES.
 *
 * THE MEASUREMENT THIS LANDS WITH, because the reason the admission was missing is subtle and the earlier
 * probes could not see it: the resolver ALREADY follows a spawn argument - a `Deno.Command` args array naming
 * a non-.ts file derives a relation on main today. So the failure for a `.ts` path was never "a spawn is not a
 * relation"; it was the `.ts` class being dropped AFTER the path was resolved. Four probes that asked "does the
 * map hold a key for a `.ts` path" cannot tell those two apart, because both produce NO - which is why the
 * deciding instrument was a NON-.ts CONTROL FOR THE SAME SHAPE rather than a better reading of the same output.
 *
 * TWO SITES, AND EACH IS INERT WITHOUT THE OTHER:
 *   site 1 - add() in scripts/test-selection.ts admits a relation for a `.ts` path when the call site is an
 *            EXECUTE call (`Deno.Command`/`Command`), and still drops it for a READ, which the import graph
 *            covers;
 *   site 2 - classifyNonTsChanges() consults the relation for a `.ts` path WITH a derived executor, before the
 *            `.ts` skip, and lets a `.ts` path with NO executor keep exactly today's behaviour.
 * A test of site 1 alone passes while nothing consults it; a test of site 2 alone passes while the map holds
 * no `.ts` key. Both halves are asserted below, in both directions.
 *
 * WHAT THIS MUST NOT DO, AND IS ASSERTED BECAUSE IT IS THE FAILURE THAT CANNOT BE SEEN: the execute relation
 * must be a UNION with the import graph, never a replacement - if it replaced, every src/** change would stop
 * selecting its own tests and the gate would go green about less. The third test below pins the negative
 * direction, with a relation present for the same file so the union is what is really being tested.
 */
import { assert, assertEquals } from "@std/assert";
import {
  classifyNonTsChanges,
  deriveReadRelationReport,
  isProvablyInert,
} from "../scripts/test-selection.ts";
import { planTests } from "../scripts/fast-check.ts";

const NO_MAP = new Map<string, string[]>();

/** A fixture tree laid out the way the detector expects: root ends in "/" and suites live under tests/. */
async function withTempTree(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = (await Deno.makeTempDir({ prefix: "4kl3-spawn-" })) + "/";
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = `${root}${relPath}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, content);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** Three suites over ONE script: one spawns it, one reads it, one only mentions a call inside a string. */
const TREE: Record<string, string> = {
  "scripts/tool.ts": "export const t = 1;\n",
  "tests/spawn_test.ts":
    'const TOOL = "scripts/tool.ts";\nexport function s(dir: string) {\n  return new Deno.Command("deno", { args: ["run", `${dir}/${TOOL}`] });\n}\nDeno.test("s", () => {});\n',
  "tests/read_test.ts":
    'export async function r() { return await Deno.readTextFile("../scripts/tool.ts"); }\nDeno.test("r", () => {});\n',
  "tests/string_test.ts":
    'const FIXTURE = \'new Deno.Command("deno", { args: ["run", "scripts/tool.ts"] });\';\nDeno.test("s", () => {});\n',
};

Deno.test("audio-feed-4kl3: a SPAWNED .ts path is a relation, a READ of it is not, and a call inside a string is not a call site", async () => {
  await withTempTree(TREE, async (root) => {
    const spawn = await deriveReadRelationReport(root, ["tests/spawn_test.ts"]);
    assertEquals(
      spawn.relations.get("scripts/tool.ts"),
      ["tests/spawn_test.ts"],
      "a spawned .ts path must be derived for the suite that spawns it (the whole point of the change)",
    );

    const read = await deriveReadRelationReport(root, ["tests/read_test.ts"]);
    assertEquals(
      read.relations.get("scripts/tool.ts"),
      undefined,
      "a READ of a .ts path stays out of the relation: the import graph covers reads, and admitting them " +
        "would bury the non-TS paths that matter (measured: admitting reads would add 17 .ts keys across 13 " +
        "suites, so it is a separate decision rather than a freebie)",
    );

    const str = await deriveReadRelationReport(root, ["tests/string_test.ts"]);
    assertEquals(
      str.relations.get("scripts/tool.ts"),
      undefined,
      "a call that exists only inside string content is data, not a call site (the lm4d boundary)",
    );
  });
});

Deno.test("audio-feed-4kl3: the classifier selects the SPAWNER, and a .ts path with no executor keeps today's behaviour", async () => {
  await withTempTree(TREE, async (root) => {
    const report = await deriveReadRelationReport(root, [
      "tests/spawn_test.ts",
      "tests/read_test.ts",
      "tests/string_test.ts",
    ]);

    const withExecutor = classifyNonTsChanges(["scripts/tool.ts"], report.relations);
    assertEquals(
      withExecutor.suites,
      ["tests/spawn_test.ts"],
      "a change to a spawned script selects the suite that executes it - and only that suite",
    );
    assertEquals(
      withExecutor.unclassified,
      [],
      "a .ts path with a derived executor must NOT fall through to the unclassified bucket, which widens to " +
        "the full suite",
    );
    assertEquals(withExecutor.inert, [], "TypeScript is never inert documentation");

    const noExecutor = classifyNonTsChanges(["scripts/unknown.ts"], report.relations);
    assertEquals(noExecutor.suites, [], "no derived executor, no selection from the relation");
    assertEquals(
      noExecutor.unclassified,
      [],
      "and NOT unclassified either: the import graph decides for .ts paths, so this loop must leave them alone",
    );
    assertEquals(noExecutor.inert, []);
    assert(
      !isProvablyInert(["scripts/unknown.ts"], noExecutor),
      "an unknown .ts file must never be provably inert: that is the state where nothing may select nothing",
    );
  });
});

Deno.test("audio-feed-4kl3: the execute relation is a UNION with the import graph, never a replacement", () => {
  // The risky shape on purpose: a relation EXISTS for the src file, so a naive implementation that consulted
  // the relation "instead of" the graph would select only the spawner and silently drop the graph's test.
  const reverse = new Map([["src/routes/tool.ts", ["tests/tool_test.ts"]]]);
  const relations = new Map([["src/routes/tool.ts", ["tests/spawn_test.ts"]]]);
  const plan = planTests(["src/routes/tool.ts"], reverse, NO_MAP, relations, [], []);
  const selected = plan.testFiles ?? [];
  assert(
    selected.includes("tests/tool_test.ts"),
    "THE NEGATIVE DIRECTION: a src change that selects its test today must still select it after - the " +
      "import graph's selection cannot be replaced by the execute relation",
  );
  assert(
    selected.includes("tests/spawn_test.ts"),
    "and the derived executor is added alongside it rather than instead of it",
  );
});

/**
 * audio-feed-20c7: the relation must come from what a spawn can RUN, not from every string in its options
 * object. rev-46's repro, verbatim in shape: `env: { NOTE: TOOL }` where TOOL names a TypeScript file.
 *
 * WHY THIS TEST HAS A POSITIVE CONTROL IN IT, and why that is the point rather than belt-and-braces: all six
 * probes that validated 4kl3 asked "does this path resolve?" - and a FALSE POSITIVE answers yes exactly like a
 * true one, so no arrangement of "does it resolve" probes can see this defect. The instrument for this
 * direction is a call of the SAME SHAPE that must NOT produce a relation, next to one that MUST, so a
 * narrowing that simply switched the feature off would fail the control rather than pass the negative.
 */
const PASSED_NOT_EXECUTED: Record<string, string> = {
  "scripts/tool.ts": 'export const value = "correct";\n',
  // The reviewer's repro: TOOL reaches the process as an environment variable, and `args` runs `eval 1`.
  "tests/env_only_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("irrelevant", () => {\n  new Deno.Command("deno", { args: ["eval", "1"], env: { NOTE: TOOL } });\n});\n',
  "tests/cwd_only_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("cwd", () => {\n  new Deno.Command("deno", { args: ["eval", "1"], cwd: TOOL });\n});\n',
  "tests/windows_only_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("win", () => {\n  new Deno.Command("deno", { args: ["eval", "1"], windowsRawArguments: TOOL });\n});\n',
  // The control: the same constant, the same file, but in the position that IS executed.
  "tests/args_control_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("runs", () => {\n  new Deno.Command("deno", { args: ["run", TOOL] });\n});\n',
  // The consumer that 4kl3's narrowing would have silenced: a READ of the script.
  "tests/consumer_test.ts":
    'Deno.test("real", async () => {\n  const text = await Deno.readTextFile("../scripts/tool.ts");\n  if (!text.includes("correct")) throw new Error("tool changed");\n});\n',
};

Deno.test("audio-feed-20c7: a path passed in env/cwd earns NO execute relation, and the control in args does", async () => {
  await withTempTree(PASSED_NOT_EXECUTED, async (root) => {
    const report = await deriveReadRelationReport(root, [
      "tests/env_only_test.ts",
      "tests/cwd_only_test.ts",
      "tests/windows_only_test.ts",
      "tests/args_control_test.ts",
      "tests/consumer_test.ts",
    ]);

    assertEquals(
      report.relations.get("scripts/tool.ts"),
      ["tests/args_control_test.ts"],
      "ONLY the args position earns the relation: env, cwd and windowsRawArguments pass a path TO a process " +
        "and cannot name something that runs (audio-feed-20c7)",
    );

    // The narrowing consequence, asserted rather than described: with the false positive gone, nothing claims
    // this file, so the empty-selection guard fail-closes into the full tier - which contains the real reader.
    const plan = planTests(["scripts/tool.ts"], NO_MAP, NO_MAP, report.relations, [], []);
    const selected = plan.testFiles ?? [];
    assert(
      !selected.includes("tests/env_only_test.ts"),
      "the irrelevant suite must not be selected: selecting it is the false narrowing, and it REPLACES the " +
        "fail-closed tier rather than adding to it",
    );
    assert(
      selected.includes("tests/args_control_test.ts"),
      "and the control still selects - the fix narrows the derivation, it does not disable it",
    );
  });
});

Deno.test("audio-feed-20c7: with only env/cwd mentions, the selection is the FAIL-CLOSED TIER, not an empty one", async () => {
  const onlyPassed = { ...PASSED_NOT_EXECUTED } as Record<string, string>;
  delete onlyPassed["tests/args_control_test.ts"];
  await withTempTree(onlyPassed, async (root) => {
    const report = await deriveReadRelationReport(root, [
      "tests/env_only_test.ts",
      "tests/cwd_only_test.ts",
      "tests/windows_only_test.ts",
      "tests/consumer_test.ts",
    ]);
    assertEquals(report.relations.get("scripts/tool.ts"), undefined);
    const plan = planTests(["scripts/tool.ts"], NO_MAP, NO_MAP, report.relations, [], []);

    // ⚠️ THIS ASSERTION USED TO READ `plan.testFiles ?? []` AND THAT COLLAPSE HID THE VERY OUTCOME ITS MESSAGE
    // DESCRIBED. `null` means the FULL tier - the real consumer runs. `[]` means NO suite runs. `?? []` maps
    // both to `[]`, so the assertion passed for the safe outcome and for the silent pass alike: it could not
    // fire on the state it existed to catch, which is a stricter defect than a missing assertion, because the
    // message claimed a fail-closed tier nothing observed. `null` is the safe state for a `.ts` change that
    // nothing claims, and it is asserted as itself.
    assertEquals(
      plan.testFiles,
      null,
      "a `.ts` change with no derived executor must FAIL CLOSED into the full tier (audio-feed-20c7): null " +
        "is the full suite, and an empty array would be a selection that runs nothing while looking like one. " +
        `reason: ${plan.reason}`,
    );
    // AND THE ASSERTION ABOVE IS ONLY WORTH ANYTHING IF IT CAN TELL THE TWO STATES APART, so the other state
    // is asserted in the same test, on the same plan function: a DECLARED-inert change is the only thing
    // allowed to select nothing, and it must come back as the empty array rather than as null.
    const inert = planTests(
      ["docs/observability-api.md"],
      NO_MAP,
      NO_MAP,
      report.relations,
      [],
      [],
    );
    assertEquals(
      inert.testFiles,
      [],
      "a declared-inert change is the OTHER state: it selects nothing on purpose, and it must be " +
        "distinguishable from the fail-closed tier rather than equal to it",
    );
  });
});

Deno.test("audio-feed-20c7: stdout/stdin/clearEnv positions also earn no execute relation", async () => {
  // The same axis as the env/cwd case, on the rest of the options object, so a future narrowing that only
  // guards the three positions named in the reviewer's repro is not enough to pass this file.
  await withTempTree({
    "scripts/tool.ts": 'export const value = "correct";\n',
    "tests/stdout_test.ts":
      'const TOOL = "scripts/tool.ts";\nDeno.test("out", () => {\n  new Deno.Command("deno", ' +
      '{ args: ["eval", "1"], stdout: "piped", stdin: "null", clearEnv: true, cwd: TOOL });\n});\n',
    "tests/args_control_test.ts":
      'const TOOL = "scripts/tool.ts";\nDeno.test("runs", () => {\n  new Deno.Command("deno", ' +
      '{ args: ["run", TOOL] });\n});\n',
  }, async (root) => {
    const report = await deriveReadRelationReport(root, [
      "tests/stdout_test.ts",
      "tests/args_control_test.ts",
    ]);
    assertEquals(
      report.relations.get("scripts/tool.ts"),
      ["tests/args_control_test.ts"],
      "the args position earns the relation and NOTHING ELSE in the options object does",
    );
  });
});

// ---------------------------------------------------------------------------
// audio-feed-9rer: the MIRROR direction. Every probe above asks "does this resolve";
// these ask "does something resolve that should NOT", and then ask the second half
// the reviewer insisted on - that removing the false relation must not suppress the
// real consumer the fail-closed tier used to catch.
// ---------------------------------------------------------------------------

/** One tree where the SAME path is reached four legitimate ways and four illegitimate ones. */
const SEMANTICS_TREE: Record<string, string> = {
  "scripts/tool.ts": 'export const value = "correct";\n',
  // PROVEN: the runtime itself, which is how every real child fixture in this repo is spawned.
  "tests/execpath_test.ts":
    'const FIXTURE = "scripts/tool.ts";\nDeno.test("execpath", () => {\n  new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--unstable-kv", FIXTURE] });\n});\n',
  // PROVEN: a named runner, with flags to skip before the program.
  "tests/node_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("node", () => {\n  new Deno.Command("node", { args: ["--experimental-strip-types", TOOL] });\n});\n',
  // PROVEN: the path in the COMMAND position, which was already a relation before this bead.
  "tests/commandpos_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("command", () => {\n  new Deno.Command(TOOL, { args: [] });\n});\n',
  // DATA: echoed, not executed - the reviewer's counterexample.
  "tests/echo_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("echo unrelated", () => {\n  new Deno.Command("echo", { args: [TOOL] });\n});\n',
  // DATA: `deno eval` runs the CODE it is given, so a path near it is data.
  "tests/eval_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("eval", () => {\n  new Deno.Command("deno", { args: ["eval", TOOL] });\n});\n',
  // DATA: `deno task` resolves a name in deno.json, not a file path.
  "tests/task_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("task", () => {\n  new Deno.Command("deno", { args: ["task", TOOL] });\n});\n',
  // DATA: an unknown command proves nothing about its arguments.
  "tests/unknown_test.ts":
    'const TOOL = "scripts/tool.ts";\nDeno.test("unknown", () => {\n  new Deno.Command("mytool", { args: [TOOL] });\n});\n',
  // The suite the fail-closed tier exists to protect: it READS the file the others mention.
  "tests/consumer_test.ts":
    'Deno.test("real", async () => {\n  const t = await Deno.readTextFile("scripts/tool.ts");\n  if (!t.includes("correct")) throw new Error("tool changed");\n});\n',
};

const ALL_SUITES = Object.keys(SEMANTICS_TREE).filter((path) => path.startsWith("tests/"));

/** Every suite the relation maps TO, for a path - the direction a false positive shows up in. */
function suitesMapping(
  relations: Map<string, string[]>,
  path: string,
): string[] {
  return [...relations.entries()]
    .filter(([key]) => key === path)
    .flatMap(([, suites]) => suites)
    .sort();
}

Deno.test("audio-feed-9rer: only the command and the PROGRAM it proves earn a .ts execute relation", async () => {
  await withTempTree(SEMANTICS_TREE, async (root) => {
    const report = await deriveReadRelationReport(root, ALL_SUITES);
    const mapped = suitesMapping(report.relations, "scripts/tool.ts");

    // The four proven shapes must still derive. THIS IS THE POSITIVE CONTROL: a narrowing
    // that switched the feature off would satisfy every exclusion below and fail here.
    for (
      const suite of [
        "tests/execpath_test.ts",
        "tests/node_test.ts",
        "tests/commandpos_test.ts",
      ]
    ) {
      assert(
        mapped.includes(suite),
        `${suite} spawns the file by a proven route and must keep its relation`,
      );
    }
    // ...and the four DATA shapes must derive nothing at all. Each of these was a passing
    // probe above: they ask "does this resolve", and every one of them answered yes.
    for (
      const suite of [
        "tests/echo_test.ts",
        "tests/eval_test.ts",
        "tests/task_test.ts",
        "tests/unknown_test.ts",
      ]
    ) {
      assert(
        !mapped.includes(suite),
        `${suite} passes the path as DATA and must not earn an execute relation`,
      );
    }
  });
});

Deno.test("audio-feed-9rer: the false relation is gone AND the plan stays FAIL-CLOSED, so the real consumer is not omitted", async () => {
  await withTempTree(SEMANTICS_TREE, async (root) => {
    // The reviewer's exact scenario: the echo suite and the reading consumer.
    const report = await deriveReadRelationReport(root, [
      "tests/echo_test.ts",
      "tests/consumer_test.ts",
    ]);
    assertEquals(
      report.relations.get("scripts/tool.ts"),
      undefined,
      "echo prints the path as data; a relation here is the false positive this bead is about",
    );

    const plan = planTests(
      ["scripts/tool.ts"],
      NO_MAP,
      NO_MAP,
      report.relations,
      report.unresolved,
      [],
    );
    // BOTH HALVES, AND THEY ARE NOT THE SAME PROPERTY: the relation is absent (above) and
    // the outcome is fail-closed (here). `null` is how the gate says "run the FULL suite",
    // which is what includes the consumer that a narrowed selection would have dropped.
    assertEquals(
      plan.testFiles,
      null,
      "with no relation the plan must fall back to the full tier rather than narrowing to the suite that mentions the path",
    );
    assert(
      plan.reason.includes("no suite is mapped"),
      `the full-tier reason must name the absence of a relation, got: ${plan.reason}`,
    );
  });
});

/**
 * audio-feed-tziw: THE READ THAT IS ADMITTED, AND IT IS THE NARROWER CASE ON PURPOSE.
 *
 * "Proven read" in this change means THE RESOLVER RESOLVED THE PATH - not "the suite reads it". The two
 * fixtures below differ in exactly one way: whether the resolver can follow the path from the read call.
 * The literal one passes the path as a string and lands in authoredPaths; the named one passes a module
 * local constant and lands in resolvedPaths. Only the second earns a .ts relation, and the row asserting
 * that a LITERAL read is excluded (audio-feed-4kl3's read row, above) is deliberately left untouched.
 *
 * WHY BOTH DIRECTIONS ARE HERE RATHER THAN ONLY THE POSITIVE: a row that admits a read but cannot fail is
 * coverage theatre. This row goes green when the resolved read is admitted AND red if that admission is
 * removed - which is demonstrated by mutating the resolvedPaths call site back to a plain add(), a one-word
 * change whose substitution count is reported when the demonstration is run.
 */
const TREE_TZIW: Record<string, string> = {
  "scripts/tool.ts": "export const t = 1;\n",
  "tests/read_name_test.ts":
    'const TOOL = "scripts/tool.ts";\nexport async function r() { return await Deno.readTextFile(TOOL); }\nDeno.test("r", () => {});\n',
  "tests/read_literal_test.ts":
    'export async function r() { return await Deno.readTextFile("../scripts/tool.ts"); }\nDeno.test("r", () => {});\n',
};

Deno.test("audio-feed-tziw: a read the RESOLVER can follow earns the .ts relation, and a literal one still does not", async () => {
  await withTempTree(TREE_TZIW, async (root) => {
    const byName = await deriveReadRelationReport(root, ["tests/read_name_test.ts"]);
    assertEquals(
      byName.relations.get("scripts/tool.ts"),
      ["tests/read_name_test.ts"],
      "a read whose path the RESOLVER resolved must earn a relation for the reading suite (audio-feed-tziw)",
    );

    // The contrast, in the same row, so the distinction is visible in one place: same script, same read
    // call, and the only difference is whether the resolver could follow the path.
    const byLiteral = await deriveReadRelationReport(root, ["tests/read_literal_test.ts"]);
    assertEquals(
      byLiteral.relations.get("scripts/tool.ts"),
      undefined,
      "and a LITERAL read stays out: it lands in authoredPaths, which this change deliberately does not admit",
    );
  });
});
