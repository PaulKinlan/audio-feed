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
 * A child that recreates `<dir>/Default/<file>` every ~20ms for `ms`, standing in for Chrome's lingering children.
 * Its own command line carries nothing secret; it only writes inside the directory it is given.
 */
async function spawnLateWriter(dir: string, ms: number): Promise<Deno.ChildProcess> {
  const script = `const dir = ${JSON.stringify(dir)};
    const end = Date.now() + ${ms};
    while (Date.now() < end) {
      try {
        Deno.mkdirSync(dir + "/Default", { recursive: true });
        Deno.writeTextFileSync(dir + "/Default/Cache-" + Date.now(), "x");
      } catch { /* the parent may be removing it, which is fine */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }`;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    stdout: "null",
    stderr: "null",
  }).spawn();
  // Let it get going, so the first removal happens while it is still writing.
  await new Promise((resolve) => setTimeout(resolve, 80));
  return child;
}

Deno.test("audio-feed-wj8o2: removeDirWhenQuiet outlasts a child that keeps recreating the directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "wj8o2-race-" });
  const child = await spawnLateWriter(root, 300);
  try {
    const gone = await removeDirWhenQuiet(root, { attempts: 60, settleMs: 25 });
    await child.status.catch(() => {});
    // The window in which the old single silent attempt leaked: the writer has stopped, but the directory it
    // recreated after the removal is still there.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(gone, "removeDirWhenQuiet must report the directory gone");
    assert(
      !exists(root),
      "the scratch must be absent once the late writer has stopped; a surviving directory is exactly the leak",
    );
  } finally {
    await child.status.catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
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
