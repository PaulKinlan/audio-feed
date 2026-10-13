/**
 * Section-fidelity measures and the three floors they are compared against, extracted from
 * the exww live-claims browser proof so that the floors are TESTABLE rather than asserted -
 * audio-feed-017q (rev-24): a floor whose only negative control lives in a commit message is
 * a floor no reviewer can certify. The measurements each floor was derived from are in the
 * doc comments below, so the next reader can re-derive them from the repository.
 */

/** Convert a document-space rectangle relative to a clip to the captured PNG's pixel scale. */
export function inImagePixels(
  rect: { x: number; y: number; width: number; height: number },
  scale: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * The minimum contrast the claim text's OWN box shows (audio-feed-9zgi, audio-feed-l11d).
 * Four clean captures measured 0.880, faded text at opacity 0.35 measured 0.312,
 * and background-coloured text measured 0. The floor predates the request-access proof.
 */
export const MIN_CLAIM_INK_LEGIBILITY = 0.5;

/**
 * Contrast range (maxima minus minima in greyscale) of a captured crop, read out of the PNG
 * itself (audio-feed-7yom, audio-feed-l11d).
 *
 * A blank clip measures 0: a flat single-colour clip has maxima == minima.
 * A faded clip at opacity 0.35 scales the contrast range proportionally down to 0.312 (and
 * opacity 0.15 down to 0.137). Standard deviation scaled down too slowly (measuring ~0.067
 * at opacity 0.35 against a 0.01 floor), passing washed-out captures that satisfied presence
 * but failed legibility. Contrast range scales proportionally with opacity, so a floor of 0.5
 * cleanly separates legible captures (0.880) from washed-out captures (0.312, 0.137).
 *
 * Cropped to the rectangle the caller names rather than to the whole clip: the clip deliberately
 * includes 8px of the PREVIOUS section above it, and those pixels are not the section's.
 */
export async function pixelContrast(
  path: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const out = await new Deno.Command("convert", {
    args: [
      path,
      "-crop",
      `${Math.max(1, Math.round(rect.width))}x${Math.max(1, Math.round(rect.height))}+${
        Math.max(0, Math.round(rect.x))
      }+${Math.max(0, Math.round(rect.y))}`,
      "+repage",
      "-colorspace",
      "gray",
      "-format",
      "%[fx:maxima-minima]",
      "info:",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`convert could not measure ${path}: ${new TextDecoder().decode(out.stderr)}`);
  }
  const contrast = Number(new TextDecoder().decode(out.stdout).trim());
  if (!Number.isFinite(contrast)) {
    throw new Error(
      `convert returned ${JSON.stringify(out.stdout)} as the pixel contrast of ${path}`,
    );
  }
  return contrast;
}

/**
 * Normalized greyscale standard deviation over exactly the same section rectangle as pixelContrast.
 * Unlike extrema, this falls when most of a section is covered but some dark ink survives.
 */
export async function pixelDistribution(
  path: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const out = await new Deno.Command("convert", {
    args: [
      path,
      "-crop",
      `${Math.max(1, Math.round(rect.width))}x${Math.max(1, Math.round(rect.height))}+${
        Math.max(0, Math.round(rect.x))
      }+${Math.max(0, Math.round(rect.y))}`,
      "+repage",
      "-colorspace",
      "gray",
      "-format",
      "%[fx:standard_deviation]",
      "info:",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`convert could not measure ${path}: ${new TextDecoder().decode(out.stderr)}`);
  }
  const distribution = Number(new TextDecoder().decode(out.stdout).trim());
  if (!Number.isFinite(distribution)) {
    throw new Error(
      `convert returned ${JSON.stringify(out.stdout)} as pixel distribution of ${path}`,
    );
  }
  return distribution;
}

/**
 * Faded-section floor: four committed section crops measure 0.880095 in contrast range;
 * opacity 0.35 measures 0.312 and 0.15 measures 0.137. The 0.5 floor leaves
 * 0.188 above the strongest fade and 0.380 below the clean captures.
 */
export const MIN_SECTION_FADE_LEGIBILITY = 0.5;

/**
 * Partial-content-loss floor: the four committed section crops have normalized standard
 * deviations 0.191256, 0.193932, 0.200255, 0.167164. An 85%-covered crop of the first
 * capture, retaining dark ink in its left 15%, measures 0.0884339 while still passing
 * the fade floor (range 0.881773). The geometric mean of the lowest clean and the
 * mutant is 0.1215852148, rounded DOWN to 0.12: clean margin >= 0.047164, mutant
 * margin 0.0315661. This uses the separated distributions, not the old 0.01 floor.
 */
export const MIN_SECTION_CONTENT_RETENTION = 0.12;

/**
 * Localized-content floor: split the section into four equal-height bands. The lowest
 * band deviation in the four committed captures is about 0.09; covering the bottom half
 * of the healthy capture with #f7f7f7 leaves two bands below 0.0004.
 * 0.04 leaves at least 0.05 of clean margin and catches this localized loss without
 * replacing either whole-section floor. This does not establish the identity of the ink.
 */
export const MIN_SECTION_BAND_DISTRIBUTION = 0.04;

export async function pixelBandDistributions(
  path: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number[]> {
  const out = await new Deno.Command("convert", {
    args: [
      path,
      "-crop",
      `${Math.max(1, Math.round(rect.width))}x${Math.max(1, Math.round(rect.height))}+${
        Math.max(0, Math.round(rect.x))
      }+${Math.max(0, Math.round(rect.y))}`,
      "+repage",
      "-crop",
      "1x4@",
      "+repage",
      "-colorspace",
      "gray",
      "-format",
      "%[fx:standard_deviation]\n",
      "info:",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `convert could not measure height bands of ${path}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  const bands = new TextDecoder().decode(out.stdout).trim().split("\n").map((v) => Number(v));
  if (bands.length !== 4 || bands.some((v) => !Number.isFinite(v))) {
    throw new Error(
      `convert returned ${
        JSON.stringify(new TextDecoder().decode(out.stdout))
      } as height-band distributions of ${path}`,
    );
  }
  return bands;
}

/** Predicate for independent fade, whole-section loss, and height-band loss. */
export function sectionRetainsInk(
  contrast: number,
  distribution: number,
  bands: number[],
): boolean {
  return contrast >= MIN_SECTION_FADE_LEGIBILITY &&
    distribution >= MIN_SECTION_CONTENT_RETENTION &&
    bands.length === 4 && bands.every((band) => band >= MIN_SECTION_BAND_DISTRIBUTION);
}
