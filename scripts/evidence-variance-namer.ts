/**
 * audio-feed-btam — name WHAT varies between two captures of the same artefact.
 *
 * WHY THIS IS A SCRIPT AND NOT A PARAGRAPH. Three rows of the evidence
 * instability table were diagnosed by hand - one turned out to be a harness PORT
 * rendered into the page, three turned out to be a handful of one-level pixels
 * that a byte-equality test reports as a "distinct render", and one was a text
 * row rasterised differently with identical words. Every one of those namings
 * lived in a bead comment and nowhere else, which makes them as unreproducible
 * as a floor whose only negative control lives in a commit message. So the four
 * measurements that produced them are here, in the tree, and can be re-run.
 *
 * WHAT IT MEASURES, and why each one was needed:
 *   1. how many distinct renders N captures produced (byte equality on stripped
 *      PNGs) - the number that started the investigation;
 *   2. the bounding box of the difference, computed with NO THRESHOLD, because a
 *      thresholded box once described "nowhere" for a real difference;
 *   3. the COUNT and the MAXIMUM CHANNEL DELTA of the differing pixels - the
 *      pair that separates eight one-level pixels (invisible) from 1,329 pixels
 *      at 142 levels (a text row rendered differently);
 *   4. a TRANSLATION SEARCH over integer shifts: if a small shift collapses the
 *      difference it was a layout move, and if zero shift is best - as it was on
 *      every row measured so far - it was not.
 *   Plus crops of the box from both runs, because two of the namings came from
 *   LOOKING at a 2-3x crop rather than from any number.
 *
 * WHAT IT DOES NOT DO: name the source. There is no threshold in this file and
 * no classification, because the categories came from looking and the numbers
 * only discriminate - a bound picked here would be a threshold invented from one
 * sample, which is the failure this instrument exists to avoid. It prints the
 * numbers and the crop paths; the naming stays a judgement, recorded on a bead.
 *
 * DEPENDENCY, declared: ImageMagick's `convert`. Zero JS dependencies on
 * purpose - adding one rewrites deno.lock, and a lock change makes the fast gate
 * run the full tier, so a measurement script would start costing a full gate to
 * land.
 *
 * USAGE
 *   deno run --allow-read --allow-write --allow-run=convert \
 *     scripts/evidence-variance-namer.ts --out /tmp/variance run1 run2 run3
 * Each argument is a directory of captures; an artefact is matched across the
 * directories by its FILE NAME.
 */

/** One artefact's measurements across N captures. */
export interface Variance {
  /** File name, which is how an artefact is matched across run directories. */
  artefact: string;
  /** How many distinct stripped-PNG hashes the N captures produced. */
  distinctRenders: number;
  /** How many captures were compared. */
  captures: number;
  /** The first pair that differs, or null when every capture is identical. */
  pair: { a: string; b: string } | null;
  /** The difference box as WxH+X+Y, with no threshold applied. */
  box: string | null;
  /** Count of pixels that differ at all. */
  differingPixels: number;
  /** The largest channel difference found, 0-255. */
  maxDelta: number;
  /** Area of the difference box in pixels. */
  boxArea: number;
  /**
   * The third axis: changed pixels divided by the box area. Dense regional loss
   * (an occluded block) fills its box; a rendering difference only outlines ink.
   * READ IT WITH THE COUNT, NEVER ALONE - see `reading`.
   */
  fillDensity: number;
  /** Mean difference over the box at zero shift. */
  zeroShiftMean: number;
  /** The integer shift that minimises the mean, and that mean. */
  bestShift: { dx: number; dy: number; mean: number } | null;
  /** How many run directories had no capture for this artefact. */
  missing: number;
  /** Paths of the two crops, so a human can look instead of inferring. */
  crops: string[];
}

/** The artefacts present in the first run directory, in a stable order. */
export function artefactNames(firstRun: Map<string, string>): string[] {
  return [...firstRun.keys()].sort();
}

/** Distinct renders among per-run hashes, compared as a set. */
export function distinctRenders(hashes: string[]): number {
  return new Set(hashes).size;
}

/**
 * The measurement's own verdicts, which are all statements about the INSTRUMENT
 * rather than about the page: is the difference a translation, and is there a
 * difference at all. Nothing here depends on a chosen bound.
 */
export function reading(v: Variance): string[] {
  const lines: string[] = [];
  if (v.missing > 0) {
    lines.push(
      `${v.missing} run director(ies) had NO capture for this artefact, so this row ` +
        `compares ${v.captures} of ${
          v.captures + v.missing
        } - reported rather than treated as identical.`,
    );
  }
  if (v.captures < 2) {
    // FEWER THAN TWO CAPTURES IS NOT A MATCH (audio-feed-cfsg). One capture can fail to detect
    // instability and cannot establish stability, so it must never be reported as consistent:
    // that is the difference between "nothing to compare" and "compared and matched".
    lines.push(
      `${v.captures} capture(s): fewer than two cannot establish stability - one capture can only ` +
        `fail to detect instability, it cannot show that a render repeats.`,
    );
    return lines;
  }
  if (v.distinctRenders <= 1) {
    lines.push("IDENTICAL: every capture supplied for this artefact has the same pixels.");
    return lines;
  }
  lines.push(
    `${v.distinctRenders} of ${v.captures} captures differ; ` +
      `${v.differingPixels} pixel(s) differ, by up to ${v.maxDelta} level(s).`,
  );
  // THE THREE AXES, PRINTED AS AXES RATHER THAN AS DECORATION. Each one has a
  // counterexample in the measured rows, and the counterexamples are in the
  // output because a reader who only sees the numbers will re-derive the mistake:
  //   - count and magnitude alone cannot tell a benign re-render from a TEXT EDIT
  //     (a row here differs in 1,329 pixels at 142 levels with identical words);
  //   - density alone cannot tell dense loss from a handful of sub-quantisation
  //     pixels (8 pixels in a 2x5 box is density 0.8);
  //   - magnitude alone is the scalar that died: a benign font variant can exceed
  //     the pixel count of a real loss.
  // What survives is a conjuction with a scope limit: pixels may claim DENSE
  // REGIONAL loss (a large count AND a full box) and may NEVER claim text
  // fidelity, which needs a semantic comparison rather than a tolerance.
  lines.push(
    `AXES: count ${v.differingPixels} px, max delta ${v.maxDelta}, ` +
      `box ${v.box ?? "none"} (area ${v.boxArea}) -> fill density ${v.fillDensity.toFixed(4)}`,
  );
  if (v.boxArea === 0) {
    // THE COUNT IS REAL AND THE BOX IS NOT USABLE, and printing "0x0 ... fill density 0.0000"
    // beside a nonzero count reads as a contradiction rather than as tooling at its limit.
    lines.push(
      `NOTE: the difference box came back degenerate at this image size, so the density above is ` +
        `not meaningful for this row - ${v.differingPixels} pixels do differ, and the count and the ` +
        `maximum delta are still measured.`,
    );
  }
  if (!v.bestShift) {
    lines.push("No shift search was run.");
    return lines;
  }
  const { dx, dy, mean } = v.bestShift;
  if (dx === 0 && dy === 0) {
    lines.push(
      `ZERO SHIFT IS BEST (mean ${sci(v.zeroShiftMean)}), so this is NOT a translation: ` +
        `shifting the image only makes the difference worse.`,
    );
  } else if (mean < v.zeroShiftMean) {
    const ratio = mean > 0 ? v.zeroShiftMean / mean : Infinity;
    lines.push(
      `A shift of (dx ${dx}, dy ${dy}) reduces the mean from ${sci(v.zeroShiftMean)} to ` +
        `${sci(mean)}, a factor of ${ratio.toFixed(1)} - consistent with content MOVING by ` +
        `${Math.abs(dx) || Math.abs(dy)}px rather than changing.`,
    );
  } else {
    // A BEST SHIFT THAT DOES NOT REDUCE THE MEAN IS NOT EVIDENCE OF MOVEMENT. The search returns a
    // shift either way, and on a pair of small or uniform images the wrapped mean can come out
    // equal, so this branch is what stops the tool asserting "content MOVING ... a factor of 1.0",
    // which is a claim its own number contradicts. Found by this bead's own control.
    lines.push(
      `NO INTEGER SHIFT explains the difference: the best shift is (dx ${dx}, dy ${dy}) and it is ` +
        `not better than zero (${sci(mean)} against ${
          sci(v.zeroShiftMean)
        }), which is what a CHANGE ` +
        `in content looks like rather than a layout move.`,
    );
  }
  return lines;
}

function sci(value: number): string {
  return value.toExponential(3);
}

const RUN_PNG_RE = /\.png$/i;

/**
 * The artefact key for a capture: the file name with any per-run suffix stripped
 * (`01-shot.r2.png` -> `01-shot.png`), because a capture set written as one
 * directory per run names the artefact differently in each run. WITHOUT this the
 * tool matches each run directory's own names, finds one capture per artefact,
 * and reports "0 unstable" - a false green of exactly the class it exists to
 * find, which is also why a MISSING capture is now reported rather than skipped.
 */
export function artefactKey(fileName: string): string {
  return fileName.replace(/\.r\d+\.png$/i, ".png");
}

async function run(command: string[], allowFailure = false): Promise<string> {
  const result = await new Deno.Command(command[0]!, { args: command.slice(1) }).output();
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`${command.join(" ")}\n${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * The render identity of a capture: ImageMagick's own signature of the PIXELS.
 * NOT the PNG bytes - the first version of this script hashed `convert -strip
 * png:-` and read the binary through a text decoder, which is lossy, and it
 * reported "0 unstable artefacts of 4" over a set whose differences were 8 to
 * 1,329 pixels wide. A comparison that cannot see the thing it measures fails
 * silently in the safe-looking direction, which is why the hand measurements
 * disagreeing with the script is a test rather than a nuisance.
 *
 * DECLARED LIMIT (audio-feed-cfsg, found by that bead's own control): `%#` covers
 * the pixel data INCLUDING its channel layout, so an RGB and an RGBA encoding of
 * the SAME picture hash differently and this field counts them as two renders,
 * while the pixel-difference metrics below report 0 differing pixels for that
 * pair. Same-channel captures - which is what one browser produces run to run -
 * are unaffected, and every row measured for this tool so far is of that kind.
 * It is named here rather than fixed, because changing the identity function
 * would change every number already recorded against it.
 */
export async function signature(path: string): Promise<string> {
  return await run(["convert", path, "-format", "%#", "info:"]);
}

async function pngsIn(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && RUN_PNG_RE.test(entry.name)) {
      found.set(artefactKey(entry.name), `${dir}/${entry.name}`);
    }
  }
  return found;
}

/** Measure one artefact across the run directories, writing crops under `out`. */
export async function measure(
  artefact: string,
  runs: Map<string, string>[],
  out: string,
): Promise<Variance> {
  const paths = runs.map((dir) => dir.get(artefact)).filter((path): path is string => !!path);
  const gaps = runs.length - paths.length;
  const hashes: string[] = [];
  for (const path of paths) hashes.push(await signature(path));

  const variance: Variance = {
    artefact,
    distinctRenders: distinctRenders(hashes),
    captures: paths.length,
    pair: null,
    box: null,
    differingPixels: 0,
    maxDelta: 0,
    boxArea: 0,
    fillDensity: 0,
    zeroShiftMean: 0,
    bestShift: null,
    missing: gaps,
    crops: [],
  };
  if (variance.distinctRenders <= 1) return variance;

  const a = paths[0]!;
  let b = paths[1] ?? a;
  for (let i = 1; i < paths.length; i++) {
    if (hashes[i] !== hashes[0]) {
      b = paths[i]!;
      break;
    }
  }
  variance.pair = { a, b };

  const geometry = await run([
    "convert",
    a,
    b,
    "-compose",
    "difference",
    "-composite",
    "-format",
    "%@",
    "info:",
  ]);
  variance.box = geometry;
  variance.differingPixels = Number(
    await run([
      "convert",
      a,
      b,
      "-compose",
      "difference",
      "-composite",
      "-threshold",
      "0",
      "-format",
      "%[fx:mean*w*h]",
      "info:",
    ]),
  );
  variance.maxDelta = Number(
    await run([
      "convert",
      a,
      b,
      "-compose",
      "difference",
      "-composite",
      "-format",
      "%[fx:maxima*255]",
      "info:",
    ]),
  );
  const measured = boxGeometry(variance.box);
  if (measured) {
    const [, w, h] = /^(\d+)x(\d+)/.exec(measured)!;
    variance.boxArea = Number(w) * Number(h);
    variance.fillDensity = fillDensity(variance.differingPixels, variance.boxArea);
  }
  variance.zeroShiftMean = await meanDifference(a, b, 0, 0);
  // The translation search. Zero shift is included, so "not a translation" is
  // the search's own answer rather than an assumption of it.
  let best: { dx: number; dy: number; mean: number } | null = null;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const mean = await meanDifference(a, b, dx, dy);
      if (!best || mean < best.mean) best = { dx, dy, mean };
    }
  }
  variance.bestShift = best;

  const base = artefact.replace(RUN_PNG_RE, "");
  const cropWidth = boxGeometry(variance.box);
  for (const [label, path] of [["a", a], ["b", b]] as const) {
    const crop = `${out}/${base}.${label}.png`;
    await run(
      [
        "convert",
        path,
        ...(cropWidth ? ["-crop", cropWidth, "+repage"] : []),
        "-scale",
        "300%",
        crop,
      ],
    );
    variance.crops.push(crop);
  }
  return variance;
}

/** Changed pixels as a fraction of the difference box: the fill-density axis. */
export function fillDensity(differingPixels: number, boxArea: number): number {
  return boxArea > 0 ? differingPixels / boxArea : 0;
}

/** The box as a crop geometry, or null when the box is empty (0x0+0+0). */
export function boxGeometry(box: string | null): string | null {
  if (!box) return null;
  const match = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(box);
  if (!match) return null;
  const [, w, h] = match;
  if (Number(w) === 0 || Number(h) === 0) return null;
  return `${w}x${h}+${match[3]}+${match[4]}`;
}

async function meanDifference(a: string, b: string, dx: number, dy: number): Promise<number> {
  const mean = await run([
    "convert",
    a,
    "(",
    b,
    "-roll",
    `+${dx}+${dy}`,
    ")",
    "-compose",
    "difference",
    "-composite",
    "-format",
    "%[fx:mean]",
    "info:",
  ]);
  return Number(mean);
}

if (import.meta.main) {
  const args = Deno.args;
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1]! : "/tmp/evidence-variance";
  const runDirs = args.filter((arg) => !arg.startsWith("--") && arg !== out);
  if (runDirs.length < 2) {
    console.error("usage: evidence-variance-namer.ts --out <dir> <run1> <run2> [run3 ...]");
    Deno.exit(2);
  }
  // A RUN DIRECTORY THAT IS NOT THERE is reported as such rather than as a stack trace: the whole
  // bead is about a tool telling "nothing to compare" apart from "compared and matched", and a
  // crash on a mistyped path is the same confusion one step earlier (audio-feed-cfsg).
  for (const dir of runDirs) {
    try {
      const info = await Deno.stat(dir);
      if (!info.isDirectory) throw new Error("not a directory");
    } catch {
      console.error(`run directory does not exist: ${dir}`);
      Deno.exit(2);
    }
  }
  await Deno.mkdir(out, { recursive: true });
  const runs: Map<string, string>[] = [];
  for (const dir of runDirs) runs.push(await pngsIn(dir));

  // ENUMERATE THE UNION OF THE RUNS, NOT THE FIRST ONE (audio-feed-cfsg). An artefact present in a
  // later run and absent from the first is exactly the missing-capture case, and enumerating
  // runs[0] made it invisible: the CLI printed "0 unstable artefact(s) of 0" for a set it had
  // never looked at. The count at the end is the number of artefacts FOUND, not the number the
  // first directory happened to contain.
  const found = [...new Set(runs.flatMap((dir) => [...dir.keys()]))].sort();

  let differences = 0;
  let identical = 0;
  let gaps = 0;
  let tooFew = 0;
  // COMPARABLE, not PRINTED (audio-feed-cfsg): this counter decides whether the run measured
  // anything, and the first version of it incremented only for rows that printed nothing, so a run
  // where EVERY artefact differed was announced as "nothing to compare" and exited 2 - a false
  // alarm about a comparison that had just happened, found by this bead's own CLI test.
  let comparable = 0;
  for (const artefact of found) {
    const variance = await measure(artefact, runs, out);
    // REPORT EVERY STATE THE FUNCTION CAN NAME, rather than filtering to differences here: the old
    // filter skipped `distinctRenders <= 1`, which is exactly where a single capture and a missing
    // capture live, so the guards inside `reading()` were unreachable from this path and the unit
    // tests that exercised them proved nothing about the CLI (audio-feed-cfsg).
    const differs = variance.captures >= 2 && variance.distinctRenders > 1;
    const isGap = variance.missing > 0;
    const isTooFew = variance.captures < 2;
    if (variance.captures >= 2) comparable++;
    if (differs) differences++;
    if (!differs && !isGap && !isTooFew) identical++;
    if (isGap) gaps++;
    if (isTooFew) tooFew++;
    if (differs || isGap || isTooFew) {
      console.log(`\n=== ${artefact}`);
      if (differs) {
        console.log(
          `    box ${variance.box}  differing ${variance.differingPixels} px  max delta ${variance.maxDelta}`,
        );
      }
      for (const line of reading(variance)) console.log(`    ${line}`);
      for (const crop of variance.crops) console.log(`    crop: ${crop}`);
    }
  }

  // AND THE DEGENERATE RUN IS ITS OWN OUTCOME (audio-feed-cfsg): if nothing had two captures to
  // compare against each other, this run MEASURED NOTHING. Printing a reassuring "0 unstable"
  // there is the whole defect - it cannot tell "nothing to compare" from "compared and matched" -
  // so the exit code says so instead of the summary pretending.
  if (comparable === 0) {
    console.log(
      `\nnothing to compare: none of the ${found.length} artefact(s) found across ${runs.length} ` +
        `run(s) had two or more captures without a gap. A run with nothing to compare is not a run ` +
        `that found nothing wrong.`,
    );
    Deno.exit(2);
  }
  console.log(
    `\n${differences} with a difference, ${gaps} with a missing capture, ${tooFew} with fewer than ` +
      `two captures, ${identical} compared and identical - of ${found.length} artefact(s) found ` +
      `across ${runs.length} run(s). Nothing here names a source: the numbers discriminate, and ` +
      `the naming is a judgement recorded on a bead.`,
  );
}
