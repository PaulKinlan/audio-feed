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

Deno.test("audio-feed-20c7: with only env/cwd mentions, the selection is EMPTY rather than narrowed", async () => {
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
    assertEquals(
      plan.testFiles ?? [],
      [],
      "an empty selection is the SAFE outcome: the gate then fail-closes into the full tier and runs the real " +
        "consumer. A non-empty selection here is the defect - it looks like a mapping and it drops the suite " +
        "that would have caught the change",
    );
  });
});
