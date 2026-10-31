// audio-feed-3zdrz — regression rows for tests/declared_proof_helpers.ts.
//
// RACE ROW: runAndRestore must SNAPSHOT BEFORE SPAWN. Under the pre-fix order the caller spawned
// the child and runAndRestore snapshotted afterwards, so a proof that writes early could have its
// partially-written artefact captured as the "original"; restore would then faithfully REWRITE the
// pollution, the post-restore comparison would match it, and the tree-vs-HEAD mismatch would
// surface later as "worktree modified during gate run". Here a fake proof writes its artefact
// immediately; after runAndRestore that write must be GONE (the child does not exist until the
// snapshot is complete, so the ordering — not timing — is what removes it).
//
// SWEEP ROW: restoreDir's extra-file sweep must walk RECURSIVELY. Under the pre-fix top-level-only
// readDir, a NEW file inside a PRE-EXISTING subdirectory was neither removed nor reported; the
// pre-fix sweep in fact deleted the whole pre-existing subdirectory (directories are not snapshot
// entries), silently losing its original files. Here a nested original must survive byte-for-byte
// while a proof-created sibling in the same subdirectory is removed.
//
// Sandbox discipline: the helper's ROOT is this repo, so the sandbox is created under docs/evidence
// with a pid-suffixed RUNTIME-COMPOSED name — no literal evidence path may appear in this source,
// because the gate's read relation resolves literals and this suite must observe nothing it does
// not touch (see the composed-path note in tests/evidence_census_test.ts). A finally removes the
// sandbox whole, so even a red row leaves no directory behind for a later run to trip over.

import { assertEquals } from "@std/assert";
import { runAndRestore } from "./declared_proof_helpers.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const sandboxRel = () => `docs/evidence/tmp-declared-proof-helpers-${Deno.pid}`;

/** A fake proof child: writes one file (path composed at runtime) and exits 0. */
function fakeProof(writeRelPath: string): () => Deno.ChildProcess {
  return () =>
    new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `await Deno.writeTextFile(${JSON.stringify(writeRelPath)}, "proof-wrote-this");`,
      ],
      cwd: repoRoot,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
}

Deno.test(
  "runAndRestore snapshots BEFORE spawning: an early proof write is not captured as the original (audio-feed-3zdrz)",
  async () => {
    const dir = sandboxRel();
    const sandboxAbs = `${repoRoot}${dir}`;
    await Deno.mkdir(sandboxAbs, { recursive: true });
    try {
      await runAndRestore(dir, fakeProof(`${dir}/early-write.txt`));
      let survived: string | null = null;
      try {
        survived = await Deno.readTextFile(`${sandboxAbs}/early-write.txt`);
      } catch { /* gone: correct */ }
      assertEquals(
        survived,
        null,
        "the proof's early write was captured as the 'original' and restored back — the snapshot did not precede the spawn",
      );
    } finally {
      await Deno.remove(sandboxAbs, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "restoreDir's extra sweep walks recursively: a new file in a pre-existing subdirectory is removed, the original survives (audio-feed-3zdrz)",
  async () => {
    const dir = sandboxRel();
    const sandboxAbs = `${repoRoot}${dir}`;
    await Deno.mkdir(`${sandboxAbs}/nested`, { recursive: true });
    await Deno.writeTextFile(`${sandboxAbs}/nested/keep.txt`, "original-bytes\n");
    try {
      await runAndRestore(dir, fakeProof(`${dir}/nested/proof-created.txt`));
      assertEquals(
        await Deno.readTextFile(`${sandboxAbs}/nested/keep.txt`),
        "original-bytes\n",
        "the pre-existing nested file must survive restore byte-for-byte",
      );
      let extraSurvived: string | null = null;
      try {
        extraSurvived = await Deno.readTextFile(`${sandboxAbs}/nested/proof-created.txt`);
      } catch { /* gone: correct */ }
      assertEquals(
        extraSurvived,
        null,
        "a proof-created file inside a pre-existing subdirectory was neither removed nor reported",
      );
    } finally {
      await Deno.remove(sandboxAbs, { recursive: true }).catch(() => {});
    }
  },
);
