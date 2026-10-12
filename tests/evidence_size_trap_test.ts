/**
 * audio-feed-3teu: the size budget must be measured on what GIT CARRIES, because a reviewer re-running a proof
 * to reproduce the behaviour it claims overwrites a compressed committed PNG with a raw 250-500KB screenshot -
 * and that is not a defect in the delta under review. Both directions are pinned here, because a fix that
 * simply stopped checking would be worse than the false FAIL it removed:
 *   - a regenerated but UNCOMMITTED oversized PNG is REPORTED, not failed (the reviewer case), and
 *   - the same file STAGED is failed, because that is the moment it would land in the tree (the real case).
 */
import { assertEquals } from "@std/assert";
import { auditEvidenceSizes, gitCarriedSizes } from "../scripts/evidence-compress.ts";

const OVER_BUDGET = 400 * 1024;

async function git(args: string[], cwd: string): Promise<void> {
  const out = await new Deno.Command("git", {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    out.success,
    true,
    `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
  );
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      message,
    ],
    root,
  );
}

Deno.test("audio-feed-3teu: the gate reads the blob git carries, not the regenerated working file", async () => {
  const root = await Deno.makeTempDir({ prefix: "3teu-carry-" });
  const rel = "docs/evidence/bead/01-shot.png";
  try {
    await git(["init", "-q"], root);
    await git(["config", "user.email", "t@example.com"], root);
    await git(["config", "user.name", "t"], root);
    await Deno.mkdir(`${root}/docs/evidence/bead`, { recursive: true });
    await Deno.writeFile(`${root}/${rel}`, new Uint8Array(120 * 1024));
    await git(["add", rel], root);
    await commitAll(root, "committed, compressed evidence");

    // THE REVIEWER CASE: the proof runs again and writes a raw screenshot over the committed one. Git still
    // carries the compressed blob, so the carried size is unchanged and the gate is not turned red by a re-run.
    await Deno.writeFile(`${root}/${rel}`, new Uint8Array(OVER_BUDGET));
    assertEquals((await gitCarriedSizes([rel], root)).get(rel), 120 * 1024);

    const dirty = await auditEvidenceSizes(`${root}/docs/evidence`, root);
    assertEquals(dirty.oversizedCarried, [], "a re-run must not fail the size gate");
    assertEquals(
      dirty.regenerated.length,
      1,
      "the regenerated file is REPORTED rather than silent",
    );
    assertEquals(dirty.totalCarried, 120 * 1024);

    // THE REAL CASE: the same bytes STAGED are what would land in the tree, so the gate fails - and only then.
    await git(["add", rel], root);
    assertEquals((await gitCarriedSizes([rel], root)).get(rel), OVER_BUDGET);
    const staged = await auditEvidenceSizes(`${root}/docs/evidence`, root);
    assertEquals(staged.oversizedCarried.length, 1, "a STAGED oversized PNG must fail");
    assertEquals(staged.regenerated, [], "it is staged, so it is not merely regenerated");
    assertEquals(staged.totalCarried, OVER_BUDGET);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-3teu: a path git has never carried is reported, not failed", async () => {
  const root = await Deno.makeTempDir({ prefix: "3teu-novel-" });
  try {
    await git(["init", "-q"], root);
    await git(["config", "user.email", "t@example.com"], root);
    await git(["config", "user.name", "t"], root);
    await Deno.mkdir(`${root}/docs/evidence/bead`, { recursive: true });
    // Untracked: nothing is in git yet, so there is nothing to compare against - the audit reports it and the
    // failure arrives when it is staged or committed, which is when it could actually inflate the tree.
    await Deno.writeFile(`${root}/docs/evidence/bead/new.png`, new Uint8Array(OVER_BUDGET));
    const audit = await auditEvidenceSizes(`${root}/docs/evidence`, root);
    assertEquals(audit.oversizedCarried, []);
    assertEquals(audit.regenerated.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-3teu: evidence:compress refuses to touch anything outside docs/evidence", async () => {
  // The remedy used to rewrite OTHER beads' committed artefacts (measured: eight directories), so it is scoped
  // by argument now and refuses anything outside the evidence tree instead of silently rewriting it.
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--allow-read",
      "--allow-write",
      "--allow-run=convert,git",
      "scripts/evidence-compress.ts",
      "/tmp",
    ],
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.success, false);
  assertEquals(out.code, 2);
  assertEquals(
    new TextDecoder().decode(out.stderr).includes("refusing to compress outside docs/evidence"),
    true,
  );
});
