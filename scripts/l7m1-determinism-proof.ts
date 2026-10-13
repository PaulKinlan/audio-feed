import { assert, assertEquals } from "@std/assert";
import { MIN_CLAIM_INK_LEGIBILITY } from "./exww-section-measures.ts";

/**
 * Two FRESH captures answer whether the l7m1 capture path repeats. The four committed blob hashes
 * in l7m1_proof_test.ts answer a different question: whether reviewed archive bytes changed.
 *
 * Diff-derived pixel boxes under-covered the next changing clock digit at x312 (17:25 vs 16:49).
 * Instead the disposable proof reads each live value's WHOLE DOM text range at capture time,
 * including its actual width, before it writes the corresponding raw CDP PNG. The only inflation
 * is 2 CSS pixels on each edge for font antialiasing and scale-1 device rounding; no mask is
 * inferred from the pixels it will later excuse. This manual proof is NOT a fast-gate test until
 * it proves load-invariant in two contended runs (audio-feed-3cvy).
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface MaskManifest {
  boxes: Box[];
  counts: { time: number; age: number; uuid: number; duration: number; port: number };
}

const MASK_EXPRESSION = `(() => {
  const boxes = [], counts = { time: 0, age: 0, uuid: 0, duration: 0, port: 0 };
  const kind = location.pathname === "/" ? "home" : "admin";
  const add = (name, range) => {
    let visible = false;
    for (const r of range.getClientRects()) {
      if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.top < 0 ||
          r.right > innerWidth || r.bottom > innerHeight) continue;
      // Only ranges inside the actual captured viewport are masked.
      // Exactly 2 CSS pixels for font edges and integer device-scale rounding.
      boxes.push({ x: Math.max(0, Math.floor(r.left) - 2),
        y: Math.max(0, Math.floor(r.top) - 2),
        width: Math.ceil(r.right) - Math.max(0, Math.floor(r.left) - 2) + 2,
        height: Math.ceil(r.bottom) - Math.max(0, Math.floor(r.top) - 2) + 2 });
      visible = true;
    }
    if (visible) counts[name]++;
  };
  if (kind === "admin") {
    for (const el of document.querySelectorAll("time[datetime]")) {
      const range = document.createRange(); range.selectNodeContents(el); add("time", range);
    }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, text = node.textContent || "";
    const patterns = kind === "home"
      ? [["port", /localhost:(\\d{2,5})/g, 1]]
      : [["uuid", /\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b/gi, 0],
         ["age", /\\b\\d+\\s*(?:min|s)(?:\\s+ago)?\\b/g, 0],
         ["duration", /\\b\\d+ms\\b/g, 0]];
    for (const [name, pattern, group] of patterns) {
      for (const match of text.matchAll(pattern)) {
        const prefix = group ? match[0].indexOf(match[group]) : 0;
        const start = match.index + prefix, end = start + (group ? match[group] : match[0]).length;
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
        add(name, range);
      }
    }
  }
  return { boxes, counts };
})()`;
const OUTSIDE_CHANNEL_TOLERANCE = 0; // measured raw static admin prose y2800..3370: zero changes
const REPO = new URL("../", import.meta.url);
const PROOF = new URL("./verify_main_l7m1_e2e.ts", import.meta.url);
const CONFIG = new URL("../deno.json", import.meta.url);
const PNGS = [
  "01-admin-observability.png",
  "02-homepage-bookmarklet-main.png",
  "03-listen-web-player.png",
] as const;

async function runFreshProof(): Promise<string> {
  // Keep the temp-dir origin in this scope so the read-relation detector classifies proof.ts
  // as OUT-OF-REPO rather than an unresolved path that disables inert docs-only gates.
  const dir = await Deno.makeTempDir({ prefix: "l7m1-raw-" });
  try {
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
    assertEquals(
      copy.split(outDeclaration).length,
      2,
      "the proof must write only into the temp dir",
    );
    copy = copy.replace(
      pngImport,
      "const quantiseEvidencePng = async (_path: string, _options?: unknown): Promise<void> => {};",
    ).replace(outDeclaration, `const OUT = ${JSON.stringify(`${dir}/evidence/`)};`);
    for (
      const [anchor, file] of [
        ['const shotAdmin = (await cdp("Page.captureScreenshot", { format: "png" }))', "01-admin"],
        ['const shotHome = (await cdp("Page.captureScreenshot", { format: "png" }))', "02-home"],
      ] as const
    ) {
      assertEquals(copy.split(anchor).length, 2, `${file} capture anchor must appear once`);
      copy = copy.replace(
        anchor,
        `await Deno.writeTextFile(OUT + ${JSON.stringify(`${file}.masks.json`)}, ` +
          `JSON.stringify(await js(${JSON.stringify(MASK_EXPRESSION)})));\n        ${anchor}`,
      );
    }
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
    return dir;
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
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

export function outsideMaskIsEqual(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  boxes: Box[],
): { equal: boolean; changed: number; outside: number; firstOutside: string[] } {
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
    boxes.reduce((area, r) => area + r.width * r.height, 0) < width * height * 0.03,
    "two DOM-derived mask sets must cover less than 3% of the image (no vacuous frame mask)",
  );
  let changed = 0;
  let outside = 0;
  const firstOutside: string[] = [];
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
      if (delta > OUTSIDE_CHANNEL_TOLERANCE && !boxes.some((r) => inside(r, x, y))) {
        outside++;
        if (firstOutside.length < 12) firstOutside.push(`(${x},${y},delta=${delta})`);
      }
    }
  }
  return { equal: outside === 0, changed, outside, firstOutside };
}

export function contrast(rgb: Uint8Array, width: number, box: Box): number {
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

export function maskedInkIsLegible(rgb: Uint8Array, width: number, boxes: Box[]): boolean {
  return boxes.every((box) => contrast(rgb, width, box) >= MIN_CLAIM_INK_LEGIBILITY);
}

export async function verifyFreshCaptures(): Promise<void> {
  let first: string | undefined;
  let second: string | undefined;
  try {
    // Sequential by construction: never run two headless browsers at once.
    first = await runFreshProof();
    second = await runFreshProof();
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
      const manifestName = index === 0 ? "01-admin" : "02-home";
      const masksA = JSON.parse(
        await Deno.readTextFile(`${first}/evidence/${manifestName}.masks.json`),
      ) as MaskManifest;
      const masksB = JSON.parse(
        await Deno.readTextFile(`${second}/evidence/${manifestName}.masks.json`),
      ) as MaskManifest;
      assertEquals(masksA.counts, masksB.counts, `${file}: live-field census must agree`);
      if (index === 0) {
        assert(
          masksA.counts.time === 6 && masksA.counts.age === 1 &&
            masksA.counts.uuid === 1 && masksA.counts.duration === 1,
          `${file}: expected exactly six time elements, one waiting age, one UUID and one duration`,
        );
      } else {
        assertEquals(masksA.counts.port, 2, "home must show precisely two port snippets");
      }
      const boxes = [...masksA.boxes, ...masksB.boxes];
      console.log(
        `${file}: live-field census ${JSON.stringify(masksA.counts)}; ` +
          `mask area ${boxes.reduce((n, r) => n + r.width * r.height, 0)}/${width * height}`,
      );
      assert(
        maskedInkIsLegible(a, width, boxes) && maskedInkIsLegible(b, width, boxes),
        `${file}: every masked live-value box in BOTH captures must retain visible ink ` +
          `(existing floor ${MIN_CLAIM_INK_LEGIBILITY})`,
      );
      const result = outsideMaskIsEqual(a, b, width, height, boxes);
      assert(
        result.equal,
        `${file}: ${result.outside} of ${result.changed} changed raw pixels OUTSIDE measured ` +
          `live-value boxes (tolerance ${OUTSIDE_CHANNEL_TOLERANCE}); first: ` +
          result.firstOutside.join(", "),
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
        const port = masksA.boxes[0]!;
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
    if (first) await Deno.remove(first, { recursive: true });
    if (second) await Deno.remove(second, { recursive: true });
  }
}

if (import.meta.main) {
  await verifyFreshCaptures();
  console.log("PASS: two fresh l7m1 captures checked outside DOM-derived live-value masks");
}
