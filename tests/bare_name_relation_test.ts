/**
 * Regression guard for audio-feed-3ttu: a runtime-assembled read hint whose filename is not a
 * plain word must not be DISCARDED IN SILENCE, and must not be reported TRUNCATED.
 *
 * The finding measured that `notes+draft`, `draft#1` and Unicode `déjà` produced relations=[],
 * unresolved=[], unattributed=[], outOfRepo=[] and bareNames=[] - every bucket empty, so a
 * considered hint vanished - while `daily notes` was worse, entering the bucket as `daily`,
 * i.e. reporting a PREFIX as if it were the filename. The behaviour was measured as already
 * fixed on current main, so this is a GUARD rather than a fix: it pins the property, not the
 * implementation.
 *
 * DELIBERATELY BUCKET-AGNOSTIC. Another change is in flight against the name-derivation
 * functions this reads (fleet/adm1-4kl3), so naming the bucket this lands in would make the
 * guard fail for a reason that is not its subject. It asserts instead, over EVERY bucket the
 * report returns: the whole filename is reported somewhere, the truncated prefix is NOT reported
 * as if it were the filename, and a literal command name stays silent in every bucket.
 */
import { assert, assertFalse } from "@std/assert";
import { deriveReadRelationReport } from "../scripts/test-selection.ts";

/** Every string the report mentions, across every bucket - so the check names no bucket. */
function reportedNames(report: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(report);
  return out;
}

function readerSource(body: string): string {
  return `export async function readIt(dir: string) {\n  return await ${body};\n}\n`;
}

async function withFixture<T>(
  source: string,
  body: (root: string) => Promise<T>,
): Promise<T> {
  // The derivation takes a root that the repo's own callers pass SLASH-TERMINATED (`ROOT` in
  // scripts/test-selection.ts is built with a trailing "/"). A root without it yields an empty
  // report SILENTLY - every bucket empty for a fixture that does read a file - which is the same
  // silent-drop shape this guard exists for, so the slash is deliberate rather than cosmetic.
  const root = (await Deno.makeTempDir({ prefix: "bare-name-" })) + "/";
  try {
    await Deno.mkdir(`${root}tests`, { recursive: true });
    await Deno.writeTextFile(`${root}tests/read_test.ts`, source);
    return await body(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

Deno.test("audio-feed-3ttu: an unwordlike filename is reported whole rather than dropped in silence", async () => {
  for (const filename of ["README", "notes+draft", "draft#1", "d\u00e9j\u00e0", "daily notes"]) {
    await withFixture(
      readerSource("Deno.readTextFile(`${dir}/" + filename + "`)"),
      async (root) => {
        const report = await deriveReadRelationReport(root, ["tests/read_test.ts"]);
        const names = reportedNames(report);
        assert(
          names.includes(filename),
          `the considered name must be reported somewhere in the report, whole: ${filename} missing from ${
            JSON.stringify(names)
          }`,
        );
        if (filename === "daily notes") {
          assertFalse(
            names.includes("daily"),
            `the name must not be reported TRUNCATED to its first word: "daily" appeared in ${
              JSON.stringify(names)
            }`,
          );
        }
      },
    );
  }
});

Deno.test("audio-feed-3ttu control: a literal command name stays silent in every bucket", async () => {
  await withFixture(
    readerSource('new Deno.Command("beads", { args: ["list"], stdout: "piped" }).output()'),
    async (root) => {
      const report = await deriveReadRelationReport(root, ["tests/read_test.ts"]);
      const names = reportedNames(report);
      assert(
        !names.some((name) => name.includes("beads")),
        `a literal command name must not be reported as a read hint: ${JSON.stringify(names)}`,
      );
    },
  );
});
