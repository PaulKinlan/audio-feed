import { assert, assertEquals } from "@std/assert";
import { MIN_CLAIM_INK_LEGIBILITY } from "../scripts/exww-section-measures.ts";

/**
 * Two FRESH captures answer whether the l7m1 capture path repeats. The four committed blob hashes
 * in l7m1_proof_test.ts answer a different question: whether reviewed archive bytes changed.
 *
 * Measured across two independent raw-capture pairs (audio-feed-3cvy): these are the narrow
 * live-value boxes, not the quantised PNG8's global PLTE drift. One blank row joins adjacent
 * changed rows into a band; two pixels of paint-edge padding bound each box. A changed pixel
 * outside these measured boxes is a failure, even if its channel delta is only ONE.
 */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const ADMIN_LIVE: Box[] = [
  { x: 316, y: 568, width: 41, height: 17 }, // clock in live-claims heading
  { x: 460, y: 1392, width: 33, height: 17 }, // waiting age at a minute boundary
  { x: 705, y: 1503, width: 145, height: 31 }, // waiting age / claim date
  { x: 435, y: 1736, width: 51, height: 18 }, // claim time
  { x: 38, y: 1965, width: 376, height: 18 }, // correlation UUID
  { x: 38, y: 2129, width: 23, height: 17 }, // request duration
  { x: 435, y: 2223, width: 51, height: 18 }, // failure time
];
const HOME_PORTS: Box[] = [
  { x: 295, y: 553, width: 51, height: 13 }, // bookmarklet destination port
  { x: 420, y: 785, width: 61, height: 14 }, // curl snippet port
];
const OUTSIDE_CHANNEL_TOLERANCE = 0; // measured raw static admin prose y2800..3370: zero changes
const REPO = new URL("../", import.meta.url);
const PROOF = new URL("../scripts/verify_main_l7m1_e2e.ts", import.meta.url);
const CONFIG = new URL("../deno.json", import.meta.url);
const PNGS = [
  "01-admin-observability.png",
  "02-homepage-bookmarklet-main.png",
  "03-listen-web-player.png",
] as const;

async function runFreshProof(dir: string): Promise<void> {
  const source = await Deno.readTextFile(PROOF);
  let copy = source;
  for (
    const [from, to] of [
      ["../src/", new URL("../src/", import.meta.url).href],
      ["../tests/", new URL("../tests/", import.meta.url).href],
      ["./proof-helper.ts", new URL("../scripts/proof-helper.ts", import.meta.url).href],
    ]
  ) {
    copy = copy.replaceAll(`"${from}`, `"${to}`);
  }
  const pngImport = 'import { quantiseEvidencePng } from "./evidence-png.ts";';
  const outDeclaration =
    'const OUT = new URL("../docs/evidence/audio-feed-l7m1/", import.meta.url).pathname;';
  assertEquals(
    copy.split(pngImport).length,
    2,
    "the raw capture must bypass exactly one quantiser",
  );
  assertEquals(copy.split(outDeclaration).length, 2, "the proof must write only into the temp dir");
  copy = copy.replace(
    pngImport,
    "const quantiseEvidencePng = async (_path: string, _options?: unknown): Promise<void> => {};",
  ).replace(outDeclaration, `const OUT = ${JSON.stringify(`${dir}/evidence/`)};`);
  const script = `${dir}/proof.ts`;
  await Deno.writeTextFile(script, copy);
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", `--config=${CONFIG.pathname}`, "--allow-all", "--unstable-kv", script],
    cwd: REPO.pathname,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(
    output.success,
    `fresh proof failed (${output.code}): ${
      new TextDecoder().decode(output.stderr).slice(-1600)
    }\n` +
      new TextDecoder().decode(output.stdout).slice(-1600),
  );
}

function imageDimensions(png: Uint8Array): { width: number; height: number } {
  assertEquals(new TextDecoder().decode(png.subarray(1, 4)), "PNG", "raw capture is PNG");
  assert(
    png[25] === 2 || png[25] === 6,
    `raw CDP capture must be non-palette (PNG colour type 2/6), got ${png[25]}`,
  );
  return {
    width: new DataView(png.buffer, png.byteOffset).getUint32(16),
    height: new DataView(png.buffer, png.byteOffset).getUint32(20),
  };
}

async function decodedRgb(path: string, expectedBytes: number): Promise<Uint8Array> {
  const result = await new Deno.Command("convert", {
    args: [path, "-alpha", "off", "-depth", "8", "RGB:-"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  assertEquals(result.stdout.length, expectedBytes, "decoded RGB must cover the whole PNG");
  return result.stdout;
}

function inside(box: Box, x: number, y: number): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

function outsideMaskIsEqual(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  boxes: Box[],
): { equal: boolean; changed: number; outside: number } {
  assertEquals(a.length, width * height * 3);
  assertEquals(b.length, a.length);
  assert(
    boxes.length > 0 && boxes.every((r) =>
      r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 &&
      r.x + r.width <= width && r.y + r.height <= height
    ),
    "each measured live-value mask must fit inside the image",
  );
  assert(
    boxes.reduce((area, r) => area + r.width * r.height, 0) < width * height / 100,
    "masks must cover less than 1% of the image (no vacuous whole-frame mask)",
  );
  let changed = 0;
  let outside = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const delta = Math.max(
        Math.abs(a[offset]! - b[offset]!),
        Math.abs(a[offset + 1]! - b[offset + 1]!),
        Math.abs(a[offset + 2]! - b[offset + 2]!),
      );
      if (delta === 0) continue;
      changed++;
      if (delta > OUTSIDE_CHANNEL_TOLERANCE && !boxes.some((r) => inside(r, x, y))) outside++;
    }
  }
  return { equal: outside === 0, changed, outside };
}

function contrast(rgb: Uint8Array, width: number, box: Box): number {
  let min = 255;
  let max = 0;
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const i = (y * width + x) * 3;
      const gray = (rgb[i]! + rgb[i + 1]! + rgb[i + 2]!) / 3;
      min = Math.min(min, gray);
      max = Math.max(max, gray);
    }
  }
  return (max - min) / 255;
}

function maskedInkIsLegible(rgb: Uint8Array, width: number, boxes: Box[]): boolean {
  return boxes.every((box) => contrast(rgb, width, box) >= MIN_CLAIM_INK_LEGIBILITY);
}

Deno.test({
  name:
    "l7m1: two fresh raw captures agree outside measured live values; archive pins are separate",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const first = await Deno.makeTempDir({ prefix: "l7m1-raw-first-" });
    const second = await Deno.makeTempDir({ prefix: "l7m1-raw-second-" });
    try {
      // Sequential by construction: never run two headless browsers at once.
      await runFreshProof(first);
      await runFreshProof(second);
      const readmeA = await Deno.readFile(`${first}/evidence/README.md`);
      const readmeB = await Deno.readFile(`${second}/evidence/README.md`);
      assertEquals(readmeA, readmeB, "two fresh generated READMEs must be byte-identical");
      for (const [index, file] of PNGS.entries()) {
        const aPath = `${first}/evidence/${file}`;
        const bPath = `${second}/evidence/${file}`;
        const aPng = await Deno.readFile(aPath);
        const bPng = await Deno.readFile(bPath);
        const aSize = imageDimensions(aPng);
        assertEquals(imageDimensions(bPng), aSize, `${file} dimensions must repeat`);
        if (index === 2) {
          assertEquals(aPng, bPng, "two fresh raw 03-listen captures must be byte-identical");
          continue;
        }
        const { width, height } = aSize;
        const [a, b] = await Promise.all([
          decodedRgb(aPath, width * height * 3),
          decodedRgb(bPath, width * height * 3),
        ]);
        const boxes = index === 0 ? ADMIN_LIVE : HOME_PORTS;
        assert(
          maskedInkIsLegible(a, width, boxes) && maskedInkIsLegible(b, width, boxes),
          `${file}: every masked live-value box in BOTH captures must retain visible ink ` +
            `(existing floor ${MIN_CLAIM_INK_LEGIBILITY})`,
        );
        const result = outsideMaskIsEqual(a, b, width, height, boxes);
        assert(
          result.equal,
          `${file}: ${result.outside} of ${result.changed} changed raw pixels OUTSIDE measured ` +
            `live-value boxes (tolerance ${OUTSIDE_CHANNEL_TOLERANCE}); capture drift is not a live field`,
        );
        if (index === 0) {
          const staticOffset = (3000 * width + 100) * 3; // static prose, outside all live bands
          const mutant = a.slice();
          mutant[staticOffset] = mutant[staticOffset] === 255
            ? mutant[staticOffset]! - 1
            : mutant[staticOffset]! + 1;
          assert(
            !outsideMaskIsEqual(mutant, a, width, height, boxes).equal,
            "+1 channel-level static-pixel mutant MUST fail the zero-tolerance comparison",
          );
        } else {
          // A mask must not become permission for a blank claim: erase the port ink and require
          // the existing claim-ink floor to reject it, even though its box is masked for comparison.
          const port = HOME_PORTS[0]!;
          const erased = a.slice();
          const background = (port.y * width + port.x) * 3;
          for (let y = port.y; y < port.y + port.height; y++) {
            for (let x = port.x; x < port.x + port.width; x++) {
              const i = (y * width + x) * 3;
              erased.set(a.subarray(background, background + 3), i);
            }
          }
          assert(
            !maskedInkIsLegible(erased, width, boxes),
            "erased port ink INSIDE the masked region MUST fail the SAME legibility predicate",
          );
        }
      }
    } finally {
      await Deno.remove(first, { recursive: true });
      await Deno.remove(second, { recursive: true });
    }
  },
});
