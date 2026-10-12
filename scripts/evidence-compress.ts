/**
 * audio-feed-39k1 — keep docs/evidence PNGs small.
 *
 * Browser-proof screenshots land in git because the Functional Verification
 * Mandate requires evidence, but a full-page 1280px PNG screenshot is ~285KB;
 * 100 of them were 15MB and 18 of the 20 largest files in the repo. The same
 * screenshot quantised to a 256-colour palette (PNG8, what pngquant does) is
 * ~95-130KB and indistinguishable at review scale. `-colors 256` matters:
 * ImageMagick's default PNG8 palette is 67-135 colours and a dark gradient
 * visibly bands; an explicit 256 keeps the error ~10-20x lower and every file
 * still lands under budget (fp4r-style review measurement on the bead).
 *
 *   deno task evidence:compress          recompress every PNG, replace when smaller
 *   deno task evidence:compress --check  fail if any PNG exceeds the budget
 *
 * `--check` is what tests/evidence_size_test.ts enforces, so an oversized
 * screenshot fails the suite at commit time rather than inflating the tree
 * silently. Requires ImageMagick's `convert` on PATH (present on the fleet
 * VMs); the script refuses to guess with anything else.
 */

/**
 * The evidence tree. Built with `new URL` and NOT `import.meta.dirname + "/../docs/evidence"`, because this
 * path is handed to `git cat-file` as `<rev>:<path>` and git does not normalise a `..` inside it: a staged blob
 * would read as MISSING and the gate would pass on exactly the bytes it exists to catch (found by staging one
 * regenerated screenshot while testing audio-feed-3teu).
 */
export const EVIDENCE_DIR = new URL("../docs/evidence", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
/** The repository root, so the budget can be measured on what GIT carries (audio-feed-3teu). */
export const REPO_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
/** Per-file budget after compression. 285KB full-page shots land at ~95-130KB. */
export const EVIDENCE_PNG_BUDGET_BYTES = 150 * 1024;
/** Aggregate budget: the bead's harm was tree inflation, and 100 files just under a per-file cap would reproduce it. */
export const EVIDENCE_TOTAL_BUDGET_BYTES = 8 * 1024 * 1024;

export async function* evidencePngs(dir: string = EVIDENCE_DIR): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* evidencePngs(path);
    } else if (entry.name.endsWith(".png8.tmp")) {
      // Left by a killed run: invisible to the .png scanners, committed
      // silently. Reaping it here keeps the tree clean.
      await Deno.remove(path).catch(() => {});
    } else if (entry.name.toLowerCase().endsWith(".png")) {
      yield path;
    }
  }
}

/**
 * THE BUDGET IS A PROPERTY OF WHAT THE REPOSITORY CARRIES, NOT OF WHAT A RE-RUN LEFT IN THE WORKING TREE
 * (audio-feed-3teu).
 *
 * WHY: the proof scripts write raw CDP screenshots (2-2.5x the budget); the committed PNGs are the compressed
 * ones. So a reviewer who RE-RUNS a proof to reproduce the behaviour it claims - which is exactly what the
 * Functional Verification Mandate asks reviewers to do - turned this gate red on a delta that had nothing to
 * do with compression, and the failure message pointed at a second, unrelated step. A false FAIL that a
 * reviewer has to explain away is worse than no gate: it teaches the reader to ignore the red.
 *
 * SO: the size that matters is the one git carries - the INDEX blob when the path is staged, otherwise the
 * HEAD blob - because that is what lands in the tree and what the budget was written to protect (audio-feed-
 * 39k1: 18 of the 20 largest files in the repo were evidence PNGs). A working-tree file that is over budget
 * while the carried content is fine is REPORTED (`regenerated`) and not failed: it is uncommitted work in
 * progress. The moment the lane stages or commits it, the gate fails with the remediation - which is the
 * moment the budget can actually be broken.
 */
export interface EvidenceSizeAudit {
  /** Paths whose GIT-CARRIED content is over the per-file budget: these fail the gate. */
  oversizedCarried: string[];
  /** Aggregate bytes GIT CARRIES (index, else HEAD). */
  totalCarried: number;
  /** Working-tree PNGs over budget that git does not carry oversized yet (a regenerated screenshot). */
  regenerated: string[];
}

/** The size of the index blob, else the HEAD blob, for each repo-relative path (null when git has neither). */
export async function gitCarriedSizes(
  paths: readonly string[],
  repoRoot: string = REPO_ROOT,
): Promise<Map<string, number | null>> {
  const sizes = new Map<string, number | null>();
  for (const path of paths) sizes.set(path, null);
  if (!paths.length) return sizes;
  const specs: string[] = [];
  for (const path of paths) specs.push(`:${path}`, `HEAD:${path}`);
  const child = new Deno.Command("git", {
    args: ["-C", repoRoot, "cat-file", "--batch-check"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`${specs.join("\n")}\n`));
  await writer.close();
  const text = await new Response(child.stdout).text();
  const status = await child.status;
  // FAIL LOUDLY: an audit that cannot read git must not answer "everything is fine".
  if (!status.success) throw new Error(`git cat-file --batch-check failed in ${repoRoot}`);
  const lines = text.split("\n");
  paths.forEach((path, i) => {
    const parse = (line: string | undefined): number | null => {
      const m = /^\S+ blob (\d+)$/.exec((line ?? "").trim());
      return m ? Number(m[1]) : null;
    };
    const staged = parse(lines[i * 2]);
    const committed = parse(lines[i * 2 + 1]);
    sizes.set(path, staged ?? committed);
  });
  return sizes;
}

/** The budget audit the suite and `--check` both use, so the gate and the tool cannot disagree. */
export async function auditEvidenceSizes(
  dir: string = EVIDENCE_DIR,
  repoRoot: string = REPO_ROOT,
): Promise<EvidenceSizeAudit> {
  const paths: string[] = [];
  const working = new Map<string, number>();
  for await (const path of evidencePngs(dir)) {
    paths.push(path);
    working.set(path, (await Deno.stat(path)).size);
  }
  const rel = paths.map((path) =>
    path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path
  );
  const carried = await gitCarriedSizes(rel, repoRoot);

  const oversizedCarried: string[] = [];
  const regenerated: string[] = [];
  let totalCarried = 0;
  paths.forEach((path, i) => {
    const carriedSize = carried.get(rel[i]!) ?? null;
    const workingSize = working.get(path) ?? 0;
    if (carriedSize !== null) {
      totalCarried += carriedSize;
      if (carriedSize > EVIDENCE_PNG_BUDGET_BYTES) {
        oversizedCarried.push(`${rel[i]!} (${(carriedSize / 1024).toFixed(0)}KB in git)`);
      }
    }
    // A re-run's raw screenshot: over budget in the working tree while the carried blob is fine. Reported, and
    // NOT failed - and not reported either when the carried blob is already the failure, so one file cannot
    // appear in both buckets.
    if (
      workingSize > EVIDENCE_PNG_BUDGET_BYTES &&
      (carriedSize === null || carriedSize <= EVIDENCE_PNG_BUDGET_BYTES)
    ) {
      regenerated.push(`${rel[i]!} (${(workingSize / 1024).toFixed(0)}KB uncommitted)`);
    }
  });
  return { oversizedCarried, totalCarried, regenerated };
}

/** The report for both the suite and `--check`, in one place so the wording cannot drift. */
export function reportEvidenceSizeAudit(audit: EvidenceSizeAudit): void {
  const budgetKb = (EVIDENCE_PNG_BUDGET_BYTES / 1024).toFixed(0);
  if (audit.regenerated.length) {
    // ONE line, grouped by directory: twenty multi-line notes is a wall a reader skips, and the command has to
    // be the SCOPED one or following it rewrites other beads' artefacts.
    const paths = audit.regenerated.map((entry) => entry.split(" (")[0]!);
    const dirs = [
      ...new Set(paths.map((path) => path.split("/").slice(0, -1).join("/"))),
    ].sort();
    console.log(
      `note: ${audit.regenerated.length} evidence PNG(s) are over the ${budgetKb}KB budget in the WORKING TREE ` +
        `while git carries nothing oversized for them: ${paths.slice(0, 3).join(", ")}${
          paths.length > 3 ? ", ..." : ""
        } - a re-run's raw screenshot is NOT a size-gate failure. Compress before committing: ` +
        `\`deno task evidence:compress ${dirs.join(" ")}\``,
    );
  }
  for (const path of audit.oversizedCarried) {
    console.error(`over budget (${budgetKb}KB) in git: ${path}`);
  }
}

/** The PNGs a scoped run should touch: the named paths (a directory, or one .png), or the whole tree. */
async function* evidenceFiles(selected: readonly string[]): AsyncGenerator<string> {
  if (!selected.length) {
    yield* evidencePngs();
    return;
  }
  for (const target of selected) {
    if (target.toLowerCase().endsWith(".png")) {
      const stat = await Deno.stat(target).catch(() => null);
      if (stat?.isFile) yield target;
      continue;
    }
    yield* evidencePngs(target);
  }
}

async function compressOne(path: string): Promise<{ before: number; after: number }> {
  const before = (await Deno.stat(path)).size;
  const tmp = `${path}.png8.tmp`;
  const out = await new Deno.Command("convert", {
    args: [path, "-strip", "-colors", "256", `PNG8:${tmp}`],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    await Deno.remove(tmp).catch(() => {});
    throw new Error(`convert failed for ${path}: ${new TextDecoder().decode(out.stderr)}`);
  }
  const after = (await Deno.stat(tmp)).size;
  if (after < before) {
    await Deno.rename(tmp, path);
    return { before, after };
  }
  // Palette quantisation made it BIGGER (tiny or already-paletted file): keep the original.
  await Deno.remove(tmp);
  return { before, after: before };
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const targets = Deno.args.filter((arg) => !arg.startsWith("--"));
  const selected: string[] = [];
  for (const target of targets) {
    const abs = new URL(target, `file://${Deno.cwd()}/`).pathname.replace(/\/$/, "");
    // SCOPED ON PURPOSE: this task compresses EVERY evidence PNG, so a lane that runs it to fix its own
    // screenshots rewrites other beads' committed artefacts (measured: eight other directories in one run).
    // Naming a path keeps the pass local to the evidence you touched.
    if (abs !== EVIDENCE_DIR && !abs.startsWith(`${EVIDENCE_DIR}/`)) {
      console.error(`refusing to compress outside docs/evidence: ${target}`);
      Deno.exit(2);
    }
    selected.push(abs);
  }

  if (check) {
    const audit = await auditEvidenceSizes();
    reportEvidenceSizeAudit(audit);
    const overTotal = audit.totalCarried > EVIDENCE_TOTAL_BUDGET_BYTES;
    console.log(
      `${audit.oversizedCarried.length || overTotal ? "OVERSIZED" : "ok"}: ` +
        `${(audit.totalCarried / 1024 / 1024).toFixed(1)}MB committed total` +
        (audit.regenerated.length ? `, ${audit.regenerated.length} regenerated file(s) noted` : ""),
    );
    if (audit.oversizedCarried.length || overTotal) Deno.exit(1);
    Deno.exit(0);
  }

  let total = 0;
  let saved = 0;
  const oversized: string[] = [];

  if (!selected.length) {
    console.log(
      "note: no path given: compressing every PNG under docs/evidence, including other beads' committed " +
        "artefacts - pass the directory you changed to keep the pass local",
    );
  }
  for await (const path of evidenceFiles(selected)) {
    const { before, after } = await compressOne(path);
    total += after;
    saved += before - after;
    if (after > EVIDENCE_PNG_BUDGET_BYTES) oversized.push(path);
    if (before !== after) {
      console.log(
        `${path.slice(EVIDENCE_DIR.length + 1)}: ${(before / 1024).toFixed(0)}KB -> ${
          (after / 1024).toFixed(0)
        }KB`,
      );
    }
  }

  const overTotal = total > EVIDENCE_TOTAL_BUDGET_BYTES;
  console.log(
    `${oversized.length || overTotal ? "OVERSIZED" : "ok"}: ${
      (total / 1024 / 1024).toFixed(1)
    }MB total, saved ${(saved / 1024 / 1024).toFixed(1)}MB`,
  );
  console.log(
    "note: the size gate measures what GIT carries - `git add` the files this run changed, or the committed " +
      "blob stays oversized",
  );
  for (const path of oversized) {
    console.error(
      `over budget (${
        (EVIDENCE_PNG_BUDGET_BYTES / 1024).toFixed(0)
      }KB) after compression: ${path} ` +
        "(consider a smaller viewport for this capture)",
    );
  }
  if (overTotal) {
    console.error(
      `tree total ${(total / 1024 / 1024).toFixed(1)}MB exceeds the ${
        (EVIDENCE_TOTAL_BUDGET_BYTES / 1024 / 1024).toFixed(0)
      }MB aggregate budget — prune stale evidence (docs/evidence/README.md)`,
    );
  }
  if (oversized.length || overTotal) Deno.exit(1);
}
