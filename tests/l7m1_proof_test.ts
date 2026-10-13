/**
 * Anti-tests and isolation proof for l7m1 browser verification mutant (audio-feed-bujv).
 *
 * Verifies:
 * 1. The controls-removal mutant (from audio-feed-ge3n) injected into a COPY of
 *    scripts/verify_main_l7m1_e2e.ts causes the proof to fail and exit non-zero (1),
 *    naming the failing check and the missing controls.
 * 2. The committed evidence image docs/evidence/audio-feed-l7m1/03-listen-web-player.png
 *    and README are protected by construction (output redirected to a temp dir) and
 *    remain byte-identical and blob-identical to their committed hashes before and after
 *    the run, with no restore step required or performed.
 * 3. A mutant execution killed mid-run leaves the working tree clean (git status reports
 *    no modified PNG) and the committed blob hash unchanged.
 *
 * Follows the pattern established in tests/outbox_proof_test.ts (audio-feed-qqxp):
 * copies the script to a temp file, redirects OUT to an isolated temp directory,
 * injects the mutant into the COPY, runs the COPY as a subprocess, and cleans up in a finally block.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import process from "node:process";

export const EXPECTED_01_PNG_BLOB = "835349478343356b90b84dc6070b77e0f76328ed";
export const EXPECTED_02_PNG_BLOB = "de50533128d33b9b160a600d14a3de7477dc99e6";
export const EXPECTED_03_PNG_BLOB = "01d787704e3320f92c9a77e853a61704310817d9";
export const EXPECTED_README_BLOB = "a0028c7e5e61a69cbdf258b5a09a2e9dccaafd07";

export interface EvidenceArtefacts {
  png01: { bytes: Uint8Array; blobHash: string };
  png02: { bytes: Uint8Array; blobHash: string };
  png03: { bytes: Uint8Array; blobHash: string };
  readme: { bytes: Uint8Array; blobHash: string };
}

export async function readCommittedEvidenceArtefacts(): Promise<EvidenceArtefacts> {
  const dir = new URL("../docs/evidence/audio-feed-l7m1/", import.meta.url).pathname;
  const [png01, png02, png03, readme] = await Promise.all([
    getFileBytesAndBlobHash(`${dir}01-admin-observability.png`),
    getFileBytesAndBlobHash(`${dir}02-homepage-bookmarklet-main.png`),
    getFileBytesAndBlobHash(`${dir}03-listen-web-player.png`),
    getFileBytesAndBlobHash(`${dir}README.md`),
  ]);
  return { png01, png02, png03, readme };
}

export function assertArtefactsMatch(
  current: EvidenceArtefacts,
  expected = {
    png01: EXPECTED_01_PNG_BLOB,
    png02: EXPECTED_02_PNG_BLOB,
    png03: EXPECTED_03_PNG_BLOB,
    readme: EXPECTED_README_BLOB,
  },
  label = "committed evidence artefacts",
) {
  assertEquals(current.png01.blobHash, expected.png01, `${label}: 01 PNG blob mismatch`);
  assertEquals(current.png02.blobHash, expected.png02, `${label}: 02 PNG blob mismatch`);
  assertEquals(current.png03.blobHash, expected.png03, `${label}: 03 PNG blob mismatch`);
  assertEquals(current.readme.blobHash, expected.readme, `${label}: README blob mismatch`);
}

export const CONTROLS_REMOVAL_MUTANT = `await js(\`(() => {
  document.querySelector("audio")?.removeAttribute("controls");
  document.querySelectorAll("button, [role=button], input[type=range]").forEach((e) => e.remove());
})()\`);`;

export async function getFileBytesAndBlobHash(filePath: string): Promise<{
  bytes: Uint8Array;
  blobHash: string;
}> {
  const bytes = await Deno.readFile(filePath);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const full = new Uint8Array(header.byteLength + bytes.byteLength);
  full.set(header, 0);
  full.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", full));
  const blobHash = Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { bytes, blobHash };
}

/**
 * Copies scripts/verify_main_l7m1_e2e.ts, redirects OUT to a temporary evidence
 * directory, injects the given mutant line, and executes the copy.
 *
 * By redirecting OUT in the copy, committed evidence files under docs/evidence/audio-feed-l7m1/
 * are unreachable and cannot be overwritten or mutated by the subprocess.
 */
export async function runProofWithInjectedMutant(injectedMutant: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
}> {
  const originalScriptPath = new URL("../scripts/verify_main_l7m1_e2e.ts", import.meta.url)
    .pathname;
  const originalSource = await Deno.readTextFile(originalScriptPath);

  const outLine =
    'const OUT = new URL("../docs/evidence/audio-feed-l7m1/", import.meta.url).pathname;';
  if (!originalSource.includes(outLine)) {
    throw new Error(`OUT declaration '${outLine}' not found in scripts/verify_main_l7m1_e2e.ts`);
  }

  const marker = "const captureIdentity = (await js(`(() => {";
  if (!originalSource.includes(marker)) {
    throw new Error(`Marker '${marker}' not found in scripts/verify_main_l7m1_e2e.ts`);
  }

  const tempEvidenceDir = await Deno.makeTempDir({ prefix: "l7m1-proof-test-evidence-" });
  // Ensure OUT points to the temporary evidence directory so that tests cannot overwrite committed evidence
  const modifiedSource = originalSource
    .replace(
      outLine,
      `const OUT = ${
        JSON.stringify(tempEvidenceDir.endsWith("/") ? tempEvidenceDir : tempEvidenceDir + "/")
      };`,
    )
    .replace(
      marker,
      `${injectedMutant}\n      ${marker}`,
    );

  const scriptsDir = new URL("../scripts/", import.meta.url).pathname;
  const tempScriptPath = await Deno.makeTempFile({
    dir: scriptsDir,
    prefix: ".l7m1-proof-test-",
    suffix: ".ts",
  });

  try {
    await Deno.writeTextFile(tempScriptPath, modifiedSource);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--unstable-kv", tempScriptPath],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    return {
      code: output.code,
      stdout,
      stderr,
      combined: `${stdout}\n${stderr}`,
    };
  } finally {
    try {
      await Deno.remove(tempScriptPath);
    } catch {
      // ignore
    }
    try {
      await Deno.remove(tempEvidenceDir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

Deno.test("l7m1-proof: controls-removal mutant on copy exits non-zero naming missing control, leaving committed PNG and README byte-identical (audio-feed-bujv)", async () => {
  // 1. Read committed PNGs and README before the run
  const artefactsBefore = await readCommittedEvidenceArtefacts();
  assertArtefactsMatch(artefactsBefore, undefined, "before mutant run");

  // 2. Execute the copy with injected mutant and redirected OUT
  const result = await runProofWithInjectedMutant(CONTROLS_REMOVAL_MUTANT);

  assertEquals(
    result.code,
    1,
    "mutant proof must exit non-zero (exit code 1) when playback controls are stripped",
  );

  assertStringIncludes(
    result.combined,
    "web player capture asserts page identity at /listen with audio controls",
    "must name the failing check",
  );

  assertStringIncludes(
    result.combined,
    "missing: play/pause button, seek slider, dock transport buttons (found: 0/3)",
    "must name the missing controls",
  );

  // 3. Read committed PNGs and README after the run and assert byte/blob identity
  const artefactsAfter = await readCommittedEvidenceArtefacts();
  assertArtefactsMatch(artefactsAfter, undefined, "after mutant run");

  assertEquals(
    artefactsAfter.png01.bytes,
    artefactsBefore.png01.bytes,
    "committed 01 PNG bytes must be byte-for-byte identical after mutant run",
  );
  assertEquals(
    artefactsAfter.png02.bytes,
    artefactsBefore.png02.bytes,
    "committed 02 PNG bytes must be byte-for-byte identical after mutant run",
  );
  assertEquals(
    artefactsAfter.png03.bytes,
    artefactsBefore.png03.bytes,
    "committed 03 PNG bytes must be byte-for-byte identical after mutant run",
  );
  assertEquals(
    artefactsAfter.readme.bytes,
    artefactsBefore.readme.bytes,
    "committed README bytes must be byte-for-byte identical after mutant run",
  );
});

Deno.test("l7m1-proof: mutant killed mid-run leaves working tree clean and committed PNG unchanged (audio-feed-bujv)", async () => {
  const artefactsBefore = await readCommittedEvidenceArtefacts();
  assertArtefactsMatch(artefactsBefore, undefined, "before mid-run kill");

  // Setup copy with redirected OUT
  const originalScriptPath = new URL("../scripts/verify_main_l7m1_e2e.ts", import.meta.url)
    .pathname;
  const originalSource = await Deno.readTextFile(originalScriptPath);
  const outLine =
    'const OUT = new URL("../docs/evidence/audio-feed-l7m1/", import.meta.url).pathname;';
  const marker = "const captureIdentity = (await js(`(() => {";

  const tempEvidenceDir = await Deno.makeTempDir({ prefix: "l7m1-killed-test-evidence-" });
  const modifiedSource = originalSource
    .replace(
      outLine,
      `const OUT = ${
        JSON.stringify(tempEvidenceDir.endsWith("/") ? tempEvidenceDir : tempEvidenceDir + "/")
      };`,
    )
    .replace(
      marker,
      `${CONTROLS_REMOVAL_MUTANT}\n      ${marker}`,
    );

  const scriptsDir = new URL("../scripts/", import.meta.url).pathname;
  const tempScriptPath = await Deno.makeTempFile({
    dir: scriptsDir,
    prefix: ".l7m1-killed-test-",
    suffix: ".ts",
  });

  let pgid = 0;
  try {
    await Deno.writeTextFile(tempScriptPath, modifiedSource);

    // Launch under setsid in a distinct process group so the kill signal reaches all children
    const cmd = new Deno.Command("setsid", {
      args: [Deno.execPath(), "run", "--allow-all", "--unstable-kv", tempScriptPath],
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    pgid = child.pid;

    // Concurrently drain stderr to prevent OS pipe buffer saturation and retain diagnostics
    let stderrAcc = "";
    (async () => {
      try {
        const reader = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderrAcc += value;
        }
      } catch {
        // Stream closes when process group is terminated
      }
    })();

    // Wait for the live browser execution milestone: Chrome loads /admin/observability and evaluates header
    const BROWSER_MILESTONE = "admin observability page loads with h1 header";
    let stdoutAcc = "";
    let milestoneReached = false;
    const milestoneTimeoutMs = 20_000;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${milestoneTimeoutMs}ms waiting for milestone "${BROWSER_MILESTONE}". Child failed to reach live browser execution.\nStdout received so far:\n${stdoutAcc}\nStderr received so far:\n${stderrAcc}`,
          ),
        );
      }, milestoneTimeoutMs);
    });

    const milestoneReader = (async () => {
      const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdoutAcc += value;
          if (stdoutAcc.includes(BROWSER_MILESTONE)) {
            milestoneReached = true;
            return;
          }
        }
      } catch {
        // Stream closes when process group is terminated
      }
      throw new Error(
        `Child process closed stdout before reaching milestone "${BROWSER_MILESTONE}". Process terminated prematurely.\nStdout received:\n${stdoutAcc}\nStderr received:\n${stderrAcc}`,
      );
    })();

    try {
      await Promise.race([milestoneReader, timeoutPromise]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }

    assertEquals(
      milestoneReached,
      true,
      `Child must reach live browser execution milestone: "${BROWSER_MILESTONE}"`,
    );

    // 1. Deliver SIGKILL to the entire process group and confirm the kill command itself succeeded
    const killCmd = new Deno.Command("kill", {
      args: ["-KILL", "--", `-${pgid}`],
    });
    const killOut = await killCmd.output();
    assertEquals(
      killOut.code,
      0,
      `kill command must exit 0, got ${killOut.code} (stderr: ${
        new TextDecoder().decode(killOut.stderr)
      })`,
    );

    // 2. Confirm the target process group is GONE via bounded poll for ESRCH
    let esrchConfirmed = false;
    const maxPollAttempts = 50; // 50 * 50ms = 2500ms max
    for (let i = 0; i < maxPollAttempts; i++) {
      try {
        process.kill(-pgid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === "ESRCH") {
          esrchConfirmed = true;
          break;
        }
        throw err;
      }
    }
    assertEquals(
      esrchConfirmed,
      true,
      `target process group -${pgid} must be gone (process.kill(-pgid, 0) raising ESRCH)`,
    );

    // 3. Confirm child process was terminated by SIGKILL mid-run
    const childStatus = await child.status;
    assertEquals(
      childStatus.success,
      false,
      "child process must not exit successfully when killed mid-run",
    );
    assertEquals(
      childStatus.signal,
      "SIGKILL",
      `child process must be terminated by SIGKILL, got status: ${JSON.stringify(childStatus)}`,
    );

    // 4. Verify git status shows no modified PNGs in the working tree
    // pass explicit cwd for the real repository where .git exists and assert exit code 0
    const repoRoot = new URL("../", import.meta.url).pathname;
    const statusCmd = new Deno.Command("git", {
      args: ["status", "--porcelain", "docs/evidence/"],
      cwd: repoRoot,
    });
    const statusOut = await statusCmd.output();
    assertEquals(
      statusOut.code,
      0,
      `git status must exit 0, got ${statusOut.code} (stderr: ${
        new TextDecoder().decode(statusOut.stderr)
      })`,
    );
    const statusText = new TextDecoder().decode(statusOut.stdout).trim();
    assertEquals(
      statusText,
      "",
      "docs/evidence/ must have no git modifications after mid-run kill",
    );

    // 5. Verify committed PNG and README blob hashes are unchanged
    const artefactsAfter = await readCommittedEvidenceArtefacts();
    assertArtefactsMatch(artefactsAfter, undefined, "after mid-run kill");
    assertEquals(
      artefactsAfter.png01.bytes,
      artefactsBefore.png01.bytes,
      "01 PNG bytes must be unchanged",
    );
    assertEquals(
      artefactsAfter.png02.bytes,
      artefactsBefore.png02.bytes,
      "02 PNG bytes must be unchanged",
    );
    assertEquals(
      artefactsAfter.png03.bytes,
      artefactsBefore.png03.bytes,
      "03 PNG bytes must be unchanged",
    );
    assertEquals(
      artefactsAfter.readme.bytes,
      artefactsBefore.readme.bytes,
      "README bytes must be unchanged",
    );
  } finally {
    if (pgid !== 0) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // process group already terminated
      }
    }
    try {
      await Deno.remove(tempScriptPath);
    } catch {
      // ignore
    }
    try {
      await Deno.remove(tempEvidenceDir, { recursive: true });
    } catch {
      // ignore
    }
  }
});
