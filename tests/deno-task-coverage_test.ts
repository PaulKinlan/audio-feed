/**
 * audio-feed-zjy — the gate must keep covering scripts/.
 *
 * `scripts/ is never type-checked` was proven by planting a type error in scripts/smoke.ts and
 * watching `deno task gate` exit 0. The one-line fix (naming scripts in the check task) is exactly
 * the kind of thing that silently walks back out during a later task rewrite, and no test noticed
 * the first time because nothing was looking. So this file looks.
 *
 * It pins the property rather than the string where it can: it actually runs the check over
 * scripts/ and requires success, and it asserts the task names scripts as a PATH rather than
 * through a double-star glob: the old task spelled src and tests that way, and in a shell without
 * globstar the pattern degrades to a single directory level, which matches NONE of the eleven
 * top-level scripts. That is how the hole survived in the first place. (The literal pattern is
 * not written here because it contains a comment-closing sequence — discovered the hard way.)
 */
import { assert, assertEquals } from "@std/assert";

/**
 * deno.json is JSONC — it carries whole-line comments explaining the fmt scope. Stripped here
 * rather than worked around: only lines whose first non-space characters are `//`, so a `//`
 * inside a value (a URL, for instance) survives. A tolerant parser would be better still, but
 * there is no public one in the runtime, and this file's own shape is the thing under test.
 */
function stripLineComments(jsonc: string): string {
  return jsonc
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const denoJson = JSON.parse(
  stripLineComments(await Deno.readTextFile(new URL("../deno.json", import.meta.url))),
);
const tasks: Record<string, string> = denoJson.tasks ?? {};

function checkCommands(task: string): string[] {
  return task.split("&&").map((part) => part.trim()).filter((part) =>
    part.startsWith("deno check")
  );
}

Deno.test("the check and gate tasks type-check scripts/ (audio-feed-zjy)", () => {
  for (const name of ["check", "gate"]) {
    const task = tasks[name];
    assert(task, `the ${name} task exists`);
    const checks = checkCommands(task);
    assertEquals(checks.length, 1, `${name} has exactly one deno check stage`);
    const command = checks[0]!;
    // Named as a bare directory: the double-star form does not reach top-level scripts in a shell
    // without globstar, which is the bug this task used to have for everything in scripts/.
    assert(/\sscripts(\s|$)/.test(command), `${name} must check scripts/ as a path: ${command}`);
    assert(
      !/scripts\/\*\*/.test(command),
      `${name} must not rely on a scripts/** glob: it does not expand as written: ${command}`,
    );
  }
});

// What is NOT pinned here, stated rather than left as a surprise: no test can run
// `deno check scripts` and assert it passes, because the repo's test task grants
// --allow-net/env/read/write but NOT --allow-run, so a test cannot spawn the checker. Widening
// the permission set to let a test shell out would trade one hole for a bigger one. The
// behavioural half was therefore verified by hand on this commit, twice, and the result is
// recorded on audio-feed-zjy: a planted `const x: number = "not a number"` in scripts/smoke.ts
// makes `deno task gate` exit 1 naming scripts/smoke.ts, and removing it returns the gate to
// exit 0. What this file CAN pin is the shape that lets that regression be caught by review
// rather than discovered in CI: the task must name scripts as a path, and the scripts it covers
// must all be files a path argument reaches.

Deno.test("every script on disk is inside the checked tree (audio-feed-zjy)", async () => {
  // Guards the shape of the fix rather than its text: if scripts/ grows a subdirectory or a file
  // with an extension `deno check scripts` skips, the count here drifts and says so.
  const onDisk: string[] = [];
  for await (const entry of Deno.readDir(new URL("../scripts", import.meta.url))) {
    if (entry.isFile && /\.(ts|tsx|mts)$/.test(entry.name)) onDisk.push(entry.name);
    if (entry.isDirectory) {
      for await (
        const child of Deno.readDir(new URL(`../scripts/${entry.name}/`, import.meta.url))
      ) {
        if (child.isFile && /\.(ts|tsx|mts)$/.test(child.name)) {
          onDisk.push(`${entry.name}/${child.name}`);
        }
      }
    }
  }
  assert(
    onDisk.length >= 11,
    `expected the existing scripts, found ${onDisk.length}: ${onDisk.join(", ")}`,
  );
});
