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
  fillDensity,
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
    boxArea: 332733,
    fillDensity: 12 / 332733,
    zeroShiftMean: 1.4e-7,
    bestShift: { dx: 0, dy: 0, mean: 1.4e-7 },
    missing: 0,
    crops: [],
    ...overrides,
  };
}

Deno.test("fill density is changed pixels over box area, and never divides by zero", () => {
  assertEquals(fillDensity(1329, 18175), 1329 / 18175);
  assertEquals(fillDensity(23736, 23736), 1);
  assertEquals(fillDensity(8, 10), 0.8);
  assertEquals(fillDensity(5, 0), 0);
});

Deno.test("a HIGH density at a tiny count is printed alongside the count it needs", () => {
  // The counterexample to reading density alone: 8 sub-quantisation pixels in a
  // 2x5 box is density 0.8, which is what a solid lost block also reports. The
  // reading carries both numbers so the pair cannot be mistaken for dense loss.
  const v = variance({ differingPixels: 8, maxDelta: 1, boxArea: 10, fillDensity: 0.8 });
  const axes = reading(v).find((line) => line.startsWith("AXES"))!;
  assertStringIncludes(axes, "count 8 px");
  assertStringIncludes(axes, "fill density 0.8000");
});

Deno.test("the three axes are printed WITH their limits, not as decoration", () => {
  const lines = reading(variance({}));
  const axes = lines.filter((line) => line.startsWith("AXES"));
  assertEquals(axes.length, 1);
});

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
  // Selected by content, not by position: an index would bind this test to the
  // number of lines the reading happens to print, which the AXES line changed.
  const line = reading(variance({ bestShift: { dx: 0, dy: 0, mean: 1.4e-7 } }))
    .find((entry) => entry.includes("ZERO SHIFT"))!;
  assertStringIncludes(line, "ZERO SHIFT IS BEST");
  assertStringIncludes(line, "NOT a translation");
});

Deno.test("a better shift is stated as movement, with the factor and the size", () => {
  // The port row's shape: a real content change, and a shift that makes it worse.
  const line = reading(
    variance({ zeroShiftMean: 5.4e-5, bestShift: { dx: 0, dy: -1, mean: 1.7e-2 } }),
  ).find((entry) => entry.includes("content MOVING"))!;
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
