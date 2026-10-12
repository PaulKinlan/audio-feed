/**
 * audio-feed-ruqh: the declaration-vs-selection check, tested on its own because it is pure.
 *
 * The rows that matter are the two SILENT ones: an undeclared README must keep today's behaviour (Shape
 * B), and a README the plan cannot read must not become a false failure. A check that turns every
 * undeclared proof red would fail 33 sites and would be reverted within the hour.
 */
import { assertEquals } from "@std/assert";
import { evidenceReadmesAmong, findUnselectedExecutors } from "../scripts/evidence-selection.ts";

const DECLARED =
  "# Evidence\n\n- Script: scripts/proof.ts\n- Executed by: tests/proof_test.ts\n- Asserts: it works\n";
const UNDECLARED = "# Evidence\n\n- Script: scripts/proof.ts\n- Asserts: it works\n";

const read = (map: Record<string, string>) => (path: string) => map[path] ?? null;

Deno.test("audio-feed-ruqh: a declared executor that was NOT selected is a violation, and it is NAMED", () => {
  const violations = findUnselectedExecutors(
    ["docs/evidence/audio-feed-x/README.md"],
    ["tests/something_else_test.ts"],
    read({ "docs/evidence/audio-feed-x/README.md": DECLARED }),
  );
  // Asserted as a whole array rather than field by field: with noUncheckedIndexedAccess a `violations[0]`
  // read is `T | undefined`, and the array form also pins that there is EXACTLY one violation.
  assertEquals(violations, [{
    readme: "docs/evidence/audio-feed-x/README.md",
    executedBy: "tests/proof_test.ts",
  }], "the violation names BOTH the declared suite and the README that declared it");
});

Deno.test("audio-feed-ruqh: a declared executor that WAS selected is not a violation", () => {
  const violations = findUnselectedExecutors(
    ["docs/evidence/audio-feed-x/README.md"],
    ["tests/proof_test.ts", "tests/other_test.ts"],
    read({ "docs/evidence/audio-feed-x/README.md": DECLARED }),
  );
  assertEquals(violations, [], "the declaration is satisfied, so the gate stays quiet");
});

Deno.test("audio-feed-ruqh: a README with NO declaration keeps today's behaviour - this is Shape B", () => {
  const violations = findUnselectedExecutors(
    ["docs/evidence/audio-feed-y/README.md"],
    ["tests/something_else_test.ts"],
    read({ "docs/evidence/audio-feed-y/README.md": UNDECLARED }),
  );
  assertEquals(violations, [], "undeclared proofs are not newly failed by this change");
});

Deno.test("audio-feed-ruqh: an UNREADABLE readme is not a violation - the check must not invent failures", () => {
  const violations = findUnselectedExecutors(
    ["docs/evidence/audio-feed-gone/README.md"],
    ["tests/proof_test.ts"],
    read({}),
  );
  assertEquals(
    violations,
    [],
    "a missing README is the evidence runner's problem, not this check's",
  );
});

Deno.test("audio-feed-ruqh: `./tests/x.ts` and `tests/x.ts` are the same suite", () => {
  const violations = findUnselectedExecutors(
    ["docs/evidence/audio-feed-x/README.md"],
    ["./tests/proof_test.ts"],
    read({ "docs/evidence/audio-feed-x/README.md": DECLARED }),
  );
  assertEquals(violations, [], "a leading ./ must not manufacture a violation");
});

Deno.test("audio-feed-ruqh: only evidence READMEs are in scope, so a normal tip reads nothing", () => {
  const changed = [
    "scripts/fast-check.ts",
    "tests/evidence_selection_test.ts",
    "docs/evidence/audio-feed-x/README.md",
    "docs/evidence/audio-feed-x/01-shot.png",
    "docs/evidence/nested/deeper/README.md",
  ];
  assertEquals(
    evidenceReadmesAmong(changed),
    ["docs/evidence/audio-feed-x/README.md"],
    "the flat evidence README, and nothing else - not a png, not a code file, not a nested path",
  );
});
