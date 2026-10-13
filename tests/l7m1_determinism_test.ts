import { assert, assertEquals } from "@std/assert";
import {
  type Box,
  maskedInkIsLegible,
  outsideMaskIsEqual,
} from "../scripts/l7m1-determinism-proof.ts";

// Pure, machine-independent controls stay in the fast tier. The two-browser comparison runs only
// as `deno run -A --unstable-kv scripts/l7m1-determinism-proof.ts` until load invariance is proven.
Deno.test("l7m1 raw comparison fails on +1 static change and erased ink inside a narrow mask", () => {
  const width = 100, height = 100;
  const box: Box = { x: 10, y: 10, width: 5, height: 5 };
  const clean = new Uint8Array(width * height * 3).fill(245);
  const ink = (12 * width + 12) * 3;
  clean.set([20, 20, 20], ink);
  assert(maskedInkIsLegible(clean, width, [box]));
  const changedValue = clean.slice();
  changedValue.set([30, 30, 30], ink);
  assert(outsideMaskIsEqual(clean, changedValue, width, height, [box]).equal);

  const staticChange = clean.slice();
  staticChange[0] = 244; // delta ONE, outside every live-value mask
  const measured = outsideMaskIsEqual(clean, staticChange, width, height, [box]);
  assertEquals(measured.outside, 1, "+1 static-pixel control must count one outside-mask change");
  assert(!measured.equal, "a +1 static-pixel mutation must fail");

  const erased = clean.slice();
  erased.set([245, 245, 245], ink);
  assert(!maskedInkIsLegible(erased, width, [box]), "erased ink inside a mask must fail");
});
