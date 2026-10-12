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
  if (v.captures < 2) {
    lines.push(
      "ONE CAPTURE: a single capture cannot establish stability - it can only fail to detect " +
        "instability. Supply at least two, and read N=3 as detection rather than proof.",
    );
    return lines;
  }
  if (v.missing > 0) {
    lines.push(
      `${v.missing} run director(ies) had NO capture for this artefact, so this row ` +
        `compares ${v.captures} of ${
          v.captures + v.missing
        } - reported rather than treated as identical.`,
    );
  }
  if (v.distinctRenders <= 1) {
    lines.push("IDENTICAL: every capture supplied for this artefact has the same pixels.");
    return lines;
  }
  lines.push(
    `${v.distinctRenders} of ${v.captures} captures differ; ` +
      `${v.differingPixels} pixel(s) differ, by up to ${v.maxDelta} level(s).`,
  );
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
  } else {
    const ratio = mean > 0 ? v.zeroShiftMean / mean : Infinity;
    lines.push(
      `A shift of (dx ${dx}, dy ${dy}) reduces the mean from ${sci(v.zeroShiftMean)} to ` +
        `${sci(mean)}, a factor of ${ratio.toFixed(1)} - consistent with content MOVING by ` +
        `${Math.abs(dx) || Math.abs(dy)}px rather than changing.`,
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
 */
async function signature(path: string): Promise<string> {
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
  await Deno.mkdir(out, { recursive: true });
  const runs: Map<string, string>[] = [];
  for (const dir of runDirs) runs.push(await pngsIn(dir));
  const first = runs[0]!;
  let unstable = 0;
  for (const artefact of artefactNames(first)) {
    const variance = await measure(artefact, runs, out);
    if (variance.distinctRenders <= 1) continue;
    unstable++;
    console.log(`\n=== ${artefact}`);
    console.log(
      `    box ${variance.box}  differing ${variance.differingPixels} px  max delta ${variance.maxDelta}`,
    );
    for (const line of reading(variance)) console.log(`    ${line}`);
    for (const crop of variance.crops) console.log(`    crop: ${crop}`);
  }
  console.log(
    `\n${unstable} unstable artefact(s) of ${first.size}; nothing here names a source - ` +
      `the numbers discriminate, and the naming is a judgement recorded on a bead.`,
  );
}
