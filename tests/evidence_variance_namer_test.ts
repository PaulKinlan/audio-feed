/**
 * audio-feed-btam — the unit tests for the variance-naming instrument.
 *
 * The instrument's job is to make three namings reproducible, and each of those
 * namings turned on a discriminator rather than on a number:
 *   - "a handful of one-level pixels is not a visible difference" is a count and
 *     a magnitude, so the tests pin that the reading quotes BOTH;
 *   - "zero shift is best, so it is not a translation" is the translation
 *     SEARCH's own answer, so the tests pin the two arms separately;
 *   - "the box described nowhere" was a thresholded geometry, so the tests pin
 *     that a zero-width box yields no crop geometry instead of a bogus one.
 * There is no threshold anywhere in the instrument and therefore none here: a
 * bound in a test would be a threshold invented from one sample.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  artefactKey,
  artefactNames,
  boxGeometry,
  distinctRenders,
  reading,
  type Variance,
} from "../scripts/evidence-variance-namer.ts";

function variance(overrides: Partial<Variance>): Variance {
  return {
    artefact: "01-shot.png",
    distinctRenders: 2,
    captures: 3,
    pair: { a: "run1/01-shot.png", b: "run2/01-shot.png" },
    box: "12x9+40+40",
    differingPixels: 12,
    maxDelta: 7,
    zeroShiftMean: 1.4e-7,
    bestShift: { dx: 0, dy: 0, mean: 1.4e-7 },
    missing: 0,
    crops: [],
    ...overrides,
  };
}

Deno.test("an identical artefact is reported as identical and nothing else", () => {
  const lines = reading(variance({ distinctRenders: 1 }));
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "IDENTICAL");
});

Deno.test("ONE capture is reported as unable to establish stability", () => {
  // "0 unstable" from a single capture is a false green, not a result.
  const lines = reading(variance({ captures: 1, distinctRenders: 1 }));
  assertStringIncludes(lines[0]!, "ONE CAPTURE");
  assertStringIncludes(lines[0]!, "cannot establish stability");
});

Deno.test("a capture MISSING from a run directory is reported, not skipped", () => {
  // The layout that produced a false green: each run directory named the artefact
  // differently, so one capture per artefact was compared and it looked stable.
  const lines = reading(variance({ distinctRenders: 2, missing: 2 }));
  assertStringIncludes(lines[0]!, "NO capture");
  assertStringIncludes(lines[0]!, "reported rather than treated as identical");
});

Deno.test("the artefact key strips a per-run suffix so runs can be compared", () => {
  assertEquals(artefactKey("01-shot.r2.png"), "01-shot.png");
  assertEquals(artefactKey("01-shot.png"), "01-shot.png");
  assertEquals(artefactKey("my.r10.png"), "my.png");
});

Deno.test("a difference quotes BOTH the pixel count and the maximum delta", () => {
  // Eight pixels at one level and 1,329 at 142 are the two real specimens; the
  // reading must carry both numbers or the pair cannot discriminate them.
  const quiet = reading(variance({ differingPixels: 8, maxDelta: 1 }))[0]!;
  assertStringIncludes(quiet, "8 pixel(s)");
  assertStringIncludes(quiet, "up to 1 level(s)");
  const loud = reading(variance({ differingPixels: 1329, maxDelta: 142 }))[0]!;
  assertStringIncludes(loud, "1329 pixel(s)");
  assertStringIncludes(loud, "up to 142 level(s)");
});

Deno.test("zero shift being best is stated as NOT a translation", () => {
  const line = reading(variance({ bestShift: { dx: 0, dy: 0, mean: 1.4e-7 } }))[1]!;
  assertStringIncludes(line, "ZERO SHIFT IS BEST");
  assertStringIncludes(line, "NOT a translation");
});

Deno.test("a better shift is stated as movement, with the factor and the size", () => {
  // The port row's shape: a real content change, and a shift that makes it worse.
  const line = reading(
    variance({ zeroShiftMean: 5.4e-5, bestShift: { dx: 0, dy: -1, mean: 1.7e-2 } }),
  )[1]!;
  assertStringIncludes(line, "content MOVING");
  assertStringIncludes(line, "1px");
});

Deno.test("a zero-size box yields no crop geometry rather than a bogus one", () => {
  // This is the "box describing NOWHERE" defect: -crop 0x0+0+0 produces nothing
  // useful and reads as if a crop had been taken.
  assertEquals(boxGeometry("0x0+1280+900"), null);
  assertEquals(boxGeometry(null), null);
  assertEquals(boxGeometry("not a box"), null);
  assertEquals(boxGeometry("563x591+440+246"), "563x591+440+246");
});

Deno.test("distinct renders counts hashes as a set, not as a list", () => {
  assertEquals(distinctRenders(["a", "a", "a"]), 1);
  assertEquals(distinctRenders(["a", "b", "a"]), 2);
  assertEquals(distinctRenders(["a", "b", "c"]), 3);
});

Deno.test("artefacts are matched by file name in a stable order", () => {
  const names = artefactNames(
    new Map([["02-b.png", "r1/02-b.png"], ["01-a.png", "r1/01-a.png"]]),
  );
  assertEquals(names, ["01-a.png", "02-b.png"]);
  assert(names.length === 2);
});
