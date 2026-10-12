/**
 * Executable control for the exww localized-content floor (audio-feed-017q, from rev-24's review).
 *
 * The review's finding: the new floor's derivation - and the occlusion case it exists for - lived
 * only in a commit message and a limitation notice, so a reviewer could not certify the floor and
 * CI could not re-derive it. This test IS that case: it takes a COMMITTED capture, covers the
 * bottom half of its section with the flat #f7f7f7 that the finding's reproducer used, and asserts
 * three things at once, which together are the whole argument for the third floor:
 *
 *  1. the two OLD floors still PASS on the occluded image (range and whole-section deviation),
 *  2. the NEW height-band floor FAILS on it,
 *  3. the same three measures all PASS on the unmodified committed capture.
 *
 * (1) is why the floor was added rather than tuned, (2) is that it works, and (3) is that it is
 * not a false-red generator. The mutant is written to a temp dir: nothing in docs/evidence is
 * touched, so the control cannot depend on or disturb another run.
 */
import { assert, assertFalse } from "@std/assert";
import {
  MIN_SECTION_BAND_DISTRIBUTION,
  MIN_SECTION_CONTENT_RETENTION,
  MIN_SECTION_FADE_LEGIBILITY,
  pixelBandDistributions,
  pixelContrast,
  pixelDistribution,
  sectionRetainsInk,
} from "../scripts/exww-section-measures.ts";

const CAPTURE = new URL(
  "../docs/evidence/audio-feed-exww/01-live-lease-expiries-worker-healthy.png",
  import.meta.url,
).pathname;

async function convert(args: string[]): Promise<{ ok: boolean; out: string }> {
  const result = await new Deno.Command("convert", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim() };
}

Deno.test("exww: the height-band floor catches a bottom-half occlusion the two old floors pass", async () => {
  if (!(await convert(["-version"])).ok) {
    console.warn("exww band-floor control SKIPPED: ImageMagick convert is not available");
    return;
  }
  const size = await convert([CAPTURE, "-format", "%wx%h", "info:"]);
  assert(size.ok, "could not read the committed capture's size");
  const [width, height] = size.out.split("x").map(Number);
  assert(width! > 0 && height! > 0, `unexpected capture size ${size.out}`);

  const dir = await Deno.makeTempDir({ prefix: "exww-band-floor-" });
  try {
    const mutant = `${dir}/half-occluded.png`;
    const from = Math.floor(height! / 2);
    const draw = await convert([
      CAPTURE,
      "-fill",
      "#f7f7f7",
      "-draw",
      `rectangle 0,${from} ${width},${height}`,
      mutant,
    ]);
    assert(draw.ok, "could not build the half-occlusion mutant");

    const rect = { x: 0, y: 0, width: width!, height: height! };
    const clean = {
      contrast: await pixelContrast(CAPTURE, rect),
      distribution: await pixelDistribution(CAPTURE, rect),
      bands: await pixelBandDistributions(CAPTURE, rect),
    };
    const occluded = {
      contrast: await pixelContrast(mutant, rect),
      distribution: await pixelDistribution(mutant, rect),
      bands: await pixelBandDistributions(mutant, rect),
    };
    console.log(
      `clean    range=${clean.contrast} deviation=${clean.distribution} bands=${
        JSON.stringify(clean.bands)
      }`,
    );
    console.log(
      `occluded range=${occluded.contrast} deviation=${occluded.distribution} bands=${
        JSON.stringify(occluded.bands)
      }`,
    );

    // 3. the clean committed capture passes all three floors (this is not a false-red generator).
    assert(
      sectionRetainsInk(clean.contrast, clean.distribution, clean.bands),
      "the unmodified committed capture must pass all three floors",
    );

    // 1. the two old floors still pass the occluded image - which is why a third was needed.
    assert(
      occluded.contrast >= MIN_SECTION_FADE_LEGIBILITY,
      `old fade floor should PASS the half-occlusion (range ${occluded.contrast} >= ${MIN_SECTION_FADE_LEGIBILITY})`,
    );
    assert(
      occluded.distribution >= MIN_SECTION_CONTENT_RETENTION,
      `old retention floor should PASS the half-occlusion (deviation ${occluded.distribution} >= ${MIN_SECTION_CONTENT_RETENTION})`,
    );

    // 2. the new floor is what fails it, and the verdict function agrees.
    assert(
      occluded.bands.some((band) => band < MIN_SECTION_BAND_DISTRIBUTION),
      `the height-band floor must FAIL the half-occlusion (bands ${
        JSON.stringify(occluded.bands)
      } vs floor ${MIN_SECTION_BAND_DISTRIBUTION})`,
    );
    assertFalse(
      sectionRetainsInk(occluded.contrast, occluded.distribution, occluded.bands),
      "the occluded capture must not be reported as retaining ink",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
