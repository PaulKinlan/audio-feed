/**
 * audio-feed-wj8o2: the teardown helpers must outlast a process that keeps recreating a directory, and must be able
 * to prove that no process still references a browser profile.
 *
 * These rows are DETERMINISTIC versions of the real failure. Chrome's children outlive the killed parent by long
 * enough to write into the profile after cleanup() removed it, so the browser rows leaked one scratch directory per
 * run; a child of our own plays the part of those children here, which makes the race reproducible in milliseconds
 * instead of depending on browser timing.
 *
 * The first row is the mutation proof for removeDirWhenQuiet: reduced to the old single silent attempt, it goes RED
 * by assertion (not by luck), because the row checks again after the writer has stopped - the window in which the
 * leak happened.
 */

import { assert, assertEquals } from "@std/assert";
import {
  killChromeAndWait,
  removeDirWhenQuiet,
  waitForChromeProfileUnused,
} from "../scripts/proof-helper.ts";

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A child that recreates `<dir>/Default/<file>` `writes` times, ~20ms apart, standing in for Chrome's lingering
 * children. Its own command line carries nothing secret; it only writes inside the directory it is given, and it
 * signals PROGRESS on two sentinel files OUTSIDE the removed tree: `<dir>.started` after its first write and
 * `<dir>.done` after its last, so the parent can ORDER the race by events instead of guessing clocks.
 *
 * audio-feed-8b4wx: this row used two wall clocks - a `Date.now()` write window here and a blind 80ms "let it
 * get going" sleep in the parent - and both lied. If the deno-eval child booted slowly, the remover started
 * before the FIRST write, saw an absent directory and returned a false `gone=true` (measured: deterministic red
 * on a cold cache, 2026-10-19); under load the writer's wall-clock window stretched past the remover's attempt
 * budget and the row went red the same way in a full gate; and even count-bounded, a separate process cannot
 * guarantee a 20ms cadence - one child scheduling hiccup opens a quiet gap wider than the settle window and
 * the remover legitimately reports gone while writes remain (measured, same day). So the row is now PHASED by
 * sentinel events, and the only thing it never does is compare two clocks:
 *
 *   PHASE A (the teeth): ONE removal attempt while the writer is provably mid-window, then `.done`, then the
 *   directory MUST exist - a single silent attempt is exactly the leak wj8o2 fixed. Catches a regression to
 *   the old implementation by assertion, deterministically: the attempt lands between write 1 and write 12.
 *
 *   PHASE B (the fix): the real helper, full budget, same handshake. It must report gone AND the directory
 *   must be absent at the moment it reports. Whether the writer still had a queued write at that instant is
 *   the helper's contract deciding "quiet", not this row's business - a cross-process cadence cannot promise
 *   more, and pretending otherwise is what made the row flaky.
 */
function spawnLateWriter(dir: string, writes: number): Deno.ChildProcess {
  const script = `const dir = ${JSON.stringify(dir)};
    const started = dir + ".started";
    const done = dir + ".done";
    for (let i = 0; i < ${writes}; i++) {
      try {
        Deno.mkdirSync(dir + "/Default", { recursive: true });
        Deno.writeTextFileSync(dir + "/Default/Cache-" + Date.now(), "x");
        Deno.writeTextFileSync(started, "");
      } catch { /* the parent may be removing it, which is fine */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    try { Deno.writeTextFileSync(done, ""); } catch { /* nothing waits on it once we are done */ }`;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    stdout: "null",
    stderr: "null",
  }).spawn();
  return child;
}

/** Poll until `path` exists or `ms` elapse; the writer's boot time is not ours to guess. */
async function waitForSentinel(path: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (exists(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return exists(path);
}

/**
 * The two phases over one fixture shape, shared by both assertions below (audio-feed-8b4wx). 12 writes at
 * 20ms (~240ms nominal) against the full budget of 120 attempts (~3s+ at settleMs 25): ~10x headroom, and
 * both sides are iteration-counted, so the margin survives load instead of measuring it.
 */
const WRITES = 12;

Deno.test("audio-feed-wj8o2: removeDirWhenQuiet outlasts a child that keeps recreating the directory", async () => {
  // PHASE A - the teeth: a single silent attempt must LEAK, provably, or this row pins nothing.
  const leakDir = await Deno.makeTempDir({ prefix: "wj8o2-race-" });
  const leaker = await spawnLateWriter(leakDir, WRITES);
  try {
    assert(
      await waitForSentinel(leakDir + ".started", 10_000),
      "the late writer never wrote anything; the race fixture is broken, not the teardown",
    );
    // The historical implementation, exactly: one removal, no retries. The writer has writes 2..12 still
    // queued, so at least one of them lands after this attempt and recreates the directory.
    await removeDirWhenQuiet(leakDir, { attempts: 1, settleMs: 25 });
    assert(
      await waitForSentinel(leakDir + ".done", 10_000),
      "the late writer never signalled completion; the race fixture is broken, not the teardown",
    );
    await leaker.status.catch(() => {});
    assert(
      exists(leakDir),
      "a single removal attempt leaked: the writer recreated the directory after it, which is the defect " +
        "wj8o2 exists for. If this fires with the retrying helper in place, the fixture broke - not the helper.",
    );
  } finally {
    await leaker.status.catch(() => {});
    await Deno.remove(leakDir, { recursive: true }).catch(() => {});
    await Deno.remove(leakDir + ".started").catch(() => {});
    await Deno.remove(leakDir + ".done").catch(() => {});
  }

  // PHASE B - the fix: the retrying helper wins against the same fixture shape.
  const root = await Deno.makeTempDir({ prefix: "wj8o2-race-" });
  const child = await spawnLateWriter(root, WRITES);
  try {
    assert(
      await waitForSentinel(root + ".started", 10_000),
      "the late writer never wrote anything; the race fixture is broken, not the teardown",
    );
    const gone = await removeDirWhenQuiet(root, { attempts: 120, settleMs: 25 });
    assert(gone, "removeDirWhenQuiet must report the directory gone");
    assert(
      !exists(root),
      "the scratch must be absent at the moment the helper reports gone; reporting true over a present " +
        "directory would be a lie about quiescence",
    );
    await child.status.catch(() => {});
  } finally {
    await child.status.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.remove(root + ".started").catch(() => {});
    await Deno.remove(root + ".done").catch(() => {});
  }
});

Deno.test("audio-feed-wj8o2: waitForChromeProfileUnused sees a process whose command line carries the profile", async () => {
  const profile = await Deno.makeTempDir({ prefix: "wj8o2-profile-" });
  // The child carries the profile the way a REAL browser child does - as an explicit --user-data-dir=<profile>
  // argument - rather than merely mentioning the path somewhere in its code. audio-feed-ubjt1 replaced the bare-path
  // match precisely because it also counted the CALLER's own command line; the flag is the signal that survives, and
  // this row keeps its teeth: the process is still live, so it must still be reported as using the profile.
  const child = new Deno.Command("sh", {
    args: ["-c", "sleep 2", `--user-data-dir=${profile}`],
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEquals(
      await waitForChromeProfileUnused(profile, { timeoutMs: 200, pollMs: 25 }),
      false,
      "a live process carrying the profile path must be reported as still using it",
    );
    // Reap rather than outlive: awaiting a sleeping child's exit cost the fast gate 30s on the first attempt at this
    // fix, and a test may not add half a minute to the gate for its own convenience.
    await killChromeAndWait(child);
    assertEquals(
      await waitForChromeProfileUnused(profile, { timeoutMs: 2000, pollMs: 25 }),
      true,
      "once that process has exited, nothing references the profile",
    );
  } finally {
    await child.status.catch(() => {});
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }
});
