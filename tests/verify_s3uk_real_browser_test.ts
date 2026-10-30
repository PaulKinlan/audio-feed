/**
 * audio-feed-q6ecj: `scripts/verify_s3uk_real_browser.ts` is EXECUTED here, not merely audited as source.
 *
 * The verify-script ledger used to accept a suite that READS a script's text as proof the script was still
 * evidence. For this script that was `tests/chrome_profile_sweep_sites_test.ts`, which reads the source to
 * assert its temp-profile call site - a real check of that property, and no evidence at all that the INP
 * assertions (trusted pointer/key events, held-key suppression, cwvState counts, the pagehide beacon) still
 * hold. A source-text exemption is the failure mode the ledger exists to stop, so the ledger now requires
 * the EXECUTE class and this suite supplies it.
 *
 * The script needs no external service: in-memory KV, a server bootstrapped on port 0, headless Chrome over
 * CDP against localhost. It costs one Chrome launch, which is the price of it being evidence at all.
 *
 * TWO ROWS, because "it exits 0" is only worth something if a broken assertion makes it exit non-zero:
 *   1. the real script runs green;
 *   2. a copy with ONE expectation inverted reports that check as FAIL and exits 1, so the row cannot be
 *      satisfied by a script that starts up and skips its checks.
 */

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("../", import.meta.url).pathname;
const SCRIPT_REL = "scripts/verify_s3uk_real_browser.ts";
const SUCCESS_LINE = "ALL INP INTERACTION VERIFICATION CHECKS PASSED.";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The copy lives outside the repo, so resolve its relative specifiers against the scripts/ directory. */
function resolveImportsAgainstScripts(source: string): string {
  return source
    .replaceAll('from "../', `from "file://${REPO_ROOT}`)
    .replaceAll('from "./', `from "file://${REPO_ROOT}scripts/`);
}

/** Bound the child: a hung Chrome must fail the row rather than hang the gate. */
async function runBounded(command: Deno.Command): Promise<RunResult> {
  const child = command.spawn();
  const bound = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, 120_000);
  try {
    const output = await child.output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } finally {
    clearTimeout(bound);
  }
}

Deno.test("audio-feed-q6ecj: the real s3uk interaction script runs green when executed", async () => {
  const source = await Deno.readTextFile(`${REPO_ROOT}${SCRIPT_REL}`);
  assert(source.length > 0, "the script under test must exist");
  const result = await runBounded(
    new Deno.Command("deno", {
      args: [
        "run",
        `--config=${REPO_ROOT}deno.json`,
        "--no-check",
        "--allow-all",
        "--unstable-kv",
        "scripts/verify_s3uk_real_browser.ts",
      ],
      cwd: REPO_ROOT,
      stdout: "piped",
      stderr: "piped",
    }),
  );
  assertEquals(
    result.code,
    0,
    `the script's own assertions must pass:\n${result.stdout}\n${result.stderr}`,
  );
  assert(
    result.stdout.includes(SUCCESS_LINE),
    `the script must reach its success summary, not exit early:\n${result.stdout}\n${result.stderr}`,
  );
});

Deno.test("audio-feed-q6ecj: inverting one expectation makes the executed script name the check and exit 1", async () => {
  const source = await Deno.readTextFile(`${REPO_ROOT}${SCRIPT_REL}`);
  const anchor = "cwvState?.keyStarts === 2,";
  const occurrences = source.split(anchor).length - 1;
  assertEquals(
    occurrences,
    1,
    "the mutant anchor must appear exactly once - a drifted anchor would silently test nothing",
  );
  const mutant = source.replace(anchor, "cwvState?.keyStarts === 4,");
  assert(mutant !== source, "the mutant must actually differ from the script");

  const tempRoot = await Deno.makeTempDir({ prefix: "audiofeed-q6ecj-mutant-" });
  try {
    const scriptPath = `${tempRoot}/verify_s3uk_mutant.ts`;
    await Deno.writeTextFile(scriptPath, resolveImportsAgainstScripts(mutant));
    const result = await runBounded(
      new Deno.Command("deno", {
        args: [
          "run",
          `--config=${REPO_ROOT}deno.json`,
          "--no-check",
          "--allow-all",
          "--unstable-kv",
          scriptPath,
        ],
        cwd: REPO_ROOT,
        stdout: "piped",
        stderr: "piped",
      }),
    );
    assertEquals(
      result.code,
      1,
      `an inverted held-key expectation must fail the run:\n${result.stdout}\n${result.stderr}`,
    );
    assert(
      result.stdout.includes("FAIL  keyboard interactions counted == dispatched"),
      `the failing assertion must NAME itself, proving the checks ran:\n${result.stdout}\n${result.stderr}`,
    );
    assert(
      result.stdout.includes("CHECK(S) FAILED."),
      `the run must report failure in its summary:\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});
