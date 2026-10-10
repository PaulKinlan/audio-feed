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

/** import.meta.dirname: new URL(...).pathname percent-encodes spaces. */
export const EVIDENCE_DIR = `${import.meta.dirname}/../docs/evidence`;
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
  let total = 0;
  let saved = 0;
  const oversized: string[] = [];

  for await (const path of evidencePngs()) {
    if (check) {
      const size = (await Deno.stat(path)).size;
      total += size;
      if (size > EVIDENCE_PNG_BUDGET_BYTES) oversized.push(path);
      continue;
    }
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
    }MB total` +
      (check ? "" : `, saved ${(saved / 1024 / 1024).toFixed(1)}MB`),
  );
  for (const path of oversized) {
    console.error(
      `over budget (${(EVIDENCE_PNG_BUDGET_BYTES / 1024).toFixed(0)}KB): ${path}` +
        (check
          ? " — run `deno task evidence:compress`"
          : " (already compressed; consider a smaller viewport)"),
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
