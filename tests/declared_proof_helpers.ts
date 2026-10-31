// Shared helpers for the declared-proof executor suites (audio-feed-u9e7s).
//
// These suites run declared evidence proofs INSIDE the fast gate, so a change to a proof script
// selects a suite that actually executes it, instead of selecting nothing and leaving a regression
// invisible until the separately-invoked evidence tier happens to run. The helpers live in a
// non-test module (the tests/admin_script.ts pattern) because the suites themselves must stay
// one-proof-per-file with the proof path inlined at the spawn site — see the load-bearing-shape note
// in either suite.
//
// THE ARTEFACTS ARE RESTORED, ALWAYS. The proofs REWRITE their committed artefacts under
// docs/evidence (icl4's repro.json carries a capturedAt timestamp, so it is never byte-identical),
// and a test that leaves them dirty invalidates every later gate run in the tree with
// "worktree modified during gate run" (scripts/fast-check.ts detectStaleRun) instead of failing at
// the cause. The restore runs in a finally BEFORE the exit-code assertion, so even a RED proof run
// leaves the tree exactly as it found it; the suite then re-walks the directory and FAILS BY NAME if
// the restore did not reproduce the snapshot, because a silent restore failure is the stale-run
// defect wearing a different hat.

import { assertEquals } from "@std/assert";

/** Repo root, derived from this module's own location: `<repo>/tests/`. */
export const ROOT = import.meta.dirname!.replace(/\/tests$/, "") + "/";

/** How long one proof may run before the backstop SIGKILLs it (measured: ~0.5s per proof). */
export const PROOF_BOUND_MS = 90_000;

/** Every file under `relDir`, repo-relative, as bytes — the snapshot a run is restored to. */
async function snapshotDir(relDir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const walk = async (rel: string): Promise<void> => {
    for await (const entry of Deno.readDir(`${ROOT}${rel}`)) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(child);
      else if (entry.isFile) files.set(child, await Deno.readFile(`${ROOT}${child}`));
    }
  };
  await walk(relDir);
  return files;
}

/**
 * Put `relDir` back exactly as `snapshot` found it: rewrite every snapshotted file byte-for-byte and
 * delete anything the proof added. Returns the files that still differ (or extras still present) so
 * the caller can fail by name instead of leaving the tree silently dirty.
 */
async function restoreDir(
  relDir: string,
  snapshot: Map<string, Uint8Array>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const [rel, bytes] of snapshot) {
    try {
      await Deno.writeFile(`${ROOT}${rel}`, bytes);
    } catch (err) {
      problems.push(`${rel}: rewrite failed (${(err as Error).message})`);
    }
  }
  for await (const entry of Deno.readDir(`${ROOT}${relDir}`)) {
    const child = `${relDir}/${entry.name}`;
    if (!snapshot.has(child)) {
      try {
        await Deno.remove(`${ROOT}${child}`, { recursive: true });
      } catch (err) {
        problems.push(`${child}: removal of proof-created file failed (${(err as Error).message})`);
      }
    }
  }
  return problems;
}

/**
 * Run one already-spawned proof child under the suite's backstop bound and restore its evidence
 * directory afterwards. The failure message names the proof's directory and quotes its output tail,
 * so a red row says WHICH demonstration stopped holding and what the proof last printed, not just
 * "non-zero". The CHILD is built by the caller (see the load-bearing-shape note in the suites); this
 * helper owns snapshot → run → restore → assert.
 */
export async function runAndRestore(
  dir: string,
  child: Deno.ChildProcess,
): Promise<void> {
  const snapshot = await snapshotDir(dir);
  let output: Deno.CommandOutput;
  const backstop = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, PROOF_BOUND_MS);
  try {
    output = await child.output();
  } finally {
    clearTimeout(backstop);
    const unrestored = await restoreDir(dir, snapshot);
    assertEquals(
      unrestored,
      [],
      `artefact restore left ${dir} dirty — the next gate in this tree would fail with ` +
        `"worktree modified during gate run" instead of at the cause`,
    );
  }
  const tail = (text: string) => text.trim().split("\n").slice(-8).join("\n");
  assertEquals(
    output.code,
    0,
    `evidence proof declared by ${dir}/README.md exited ${output.code}` +
      `${output.signal ? ` (killed by ${output.signal}, bound ${PROOF_BOUND_MS}ms)` : ""} — the ` +
      `README's demonstration no longer holds. Last stdout:\n${
        tail(new TextDecoder().decode(output.stdout))
      }\nLast stderr:\n${tail(new TextDecoder().decode(output.stderr))}`,
  );
}
