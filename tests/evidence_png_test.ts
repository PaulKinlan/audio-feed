/**
 * Unit tests for evidence PNG palette quantisation helper (audio-feed-az9j, audio-feed-xgjc).
 *
 * Verifies:
 * 1. Stub `convert` on PATH exiting 7 throws naming the file and exit code, leaving no .tmp file.
 * 2. Missing `convert` (absent from PATH) throws naming the file and code ENOENT, leaving no .tmp file.
 * 3. Positive control: successful convert produces byte-identical output to direct ImageMagick invocation.
 * 4. Injectable runner support for seam testing without process execution.
 * 5. Artefact chunk assertion: helper output carries no tIME chunk, with positive and negative controls.
 */

import { assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert";
import { quantiseEvidencePng, quantiseMaintenancePng } from "../scripts/evidence-png.ts";
import { runProof } from "../scripts/proof-helper.ts";

Deno.test({
  name: "quantiseEvidencePng: throws when called outside runProof without allowOutsideProof",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-png-unbound-" });
    const filePath = `${dir}/shot.png`;
    await Deno.writeFile(filePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    try {
      const err = await assertRejects(
        () => quantiseEvidencePng(filePath),
        Error,
        "quantiseEvidencePng() called outside of runProof() context",
      );
      assertMatch(err.message, /Evidence must be written inside await runProof/);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "quantiseMaintenancePng: succeeds outside runProof",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-png-maintenance-" });
    const filePath = `${dir}/shot.png`;
    const tmpPath = `${filePath}.tmp`;
    await Deno.writeFile(filePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    try {
      await Deno.writeTextFile(tmpPath, "maintenance-bytes");
      const res = await quantiseMaintenancePng(filePath, {
        runner: () => Promise.resolve({ success: true, code: 0 }),
      });
      assertEquals(res, filePath);
      assertEquals(await Deno.readTextFile(filePath), "maintenance-bytes");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "quantiseEvidencePng: succeeds inside runProof without explicit allowOutsideProof",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-png-in-proof-" });
    const filePath = `${dir}/shot.png`;
    const tmpPath = `${filePath}.tmp`;
    await Deno.writeFile(filePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    try {
      await runProof("test-quantise-in-proof", async () => {
        await Deno.writeTextFile(tmpPath, "in-proof-bytes");
        const res = await quantiseEvidencePng(filePath, {
          runner: () => Promise.resolve({ success: true, code: 0 }),
        });
        assertEquals(res, filePath);
        assertEquals(await Deno.readTextFile(filePath), "in-proof-bytes");
      });
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "quantiseEvidencePng: stub convert exiting 7 throws naming file and exit code, and cleans up .tmp",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-png-exit7-" });
    const binDir = `${dir}/bin`;
    await Deno.mkdir(binDir, { recursive: true });

    const filePath = `${dir}/shot.png`;
    const tmpPath = `${filePath}.tmp`;
    await Deno.writeFile(filePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

    // Stub convert that touches the .tmp output and exits with code 7
    const stub = `${binDir}/convert`;
    await Deno.writeTextFile(
      stub,
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    png8:*|PNG8:*)
      out="\${arg#*:}"
      touch "$out"
      ;;
  esac
done
exit 7
`,
    );
    await Deno.chmod(stub, 0o755);

    {
      // The seam is the binary path (audio-feed-lnnjd): a named stub binary
      // still exercises the real Deno.Command spawn; mutating process-global
      // PATH would be visible to every concurrently running module.
      const err = await assertRejects(
        () => quantiseEvidencePng(filePath, { allowOutsideProof: true, convertBin: stub }),
        Error,
      );

      // Must name the file and the exit code
      assertMatch(err.message, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assertMatch(err.message, /exit code 7/);

      // Must clean up .tmp file
      const tmpExists = await Deno.stat(tmpPath).then(() => true).catch(() => false);
      assertEquals(tmpExists, false, ".tmp file must be removed on nonzero exit");

      // Original file must remain untouched
      const origExists = await Deno.stat(filePath).then(() => true).catch(() => false);
      assertEquals(origExists, true, "original file must remain on disk");
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  },
});

Deno.test({
  name:
    "quantiseEvidencePng: convert absent from PATH throws naming file and code ENOENT, and cleans up .tmp",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-png-enoent-" });
    const emptyBinDir = `${dir}/empty_bin`;
    await Deno.mkdir(emptyBinDir, { recursive: true });

    const filePath = `${dir}/shot.png`;
    const tmpPath = `${filePath}.tmp`;
    await Deno.writeFile(filePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    // Pre-create .tmp to ensure spawn failure cleans it up
    await Deno.writeTextFile(tmpPath, "abandoned-tmp");

    // The seam is the binary path (audio-feed-lnnjd): a nonexistent binary
    // hits the same real-spawn ENOENT as a PATH search miss, without mutating
    // process-global PATH for every concurrently running module.
    {
      const err = await assertRejects(
        () =>
          quantiseEvidencePng(filePath, {
            allowOutsideProof: true,
            convertBin: `${emptyBinDir}/convert`,
          }),
        Error,
      );

      // Must name the file and code ENOENT
      assertMatch(err.message, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assertMatch(err.message, /code ENOENT/);

      // Must clean up .tmp file
      const tmpExists = await Deno.stat(tmpPath).then(() => true).catch(() => false);
      assertEquals(tmpExists, false, ".tmp file must be removed on spawn failure");
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  },
});

Deno.test({
  name: "quantiseEvidencePng: positive control produces identical bytes to direct convert command",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-png-control-" });
    const origPath = `${dir}/sample.png`;

    try {
      // Create a 24-bit PNG with real ImageMagick convert
      const makeOut = await new Deno.Command("/usr/bin/convert", {
        args: ["-size", "8x8", "xc:#123456", `PNG24:${origPath}`],
      }).output();
      assertEquals(makeOut.success, true, "Failed to generate initial sample PNG");

      // 1. Test standard default options (256 colors, png8:)
      const oldPath = `${dir}/control_old.png`;
      const newPath = `${dir}/control_new.png`;
      await Deno.copyFile(origPath, oldPath);
      await Deno.copyFile(origPath, newPath);

      // Run old direct convert logic
      const oldCmd = new Deno.Command("convert", {
        args: [oldPath, "-strip", "-colors", "256", `png8:${oldPath}.tmp`],
      });
      const oldRes = await oldCmd.output();
      assertEquals(oldRes.success, true);
      await Deno.rename(`${oldPath}.tmp`, oldPath);

      // Run new helper
      const returnedPath = await quantiseEvidencePng(newPath, { allowOutsideProof: true });
      assertEquals(returnedPath, newPath);

      // Byte-for-byte check
      const oldBytes = await Deno.readFile(oldPath);
      const newBytes = await Deno.readFile(newPath);
      assertEquals(newBytes, oldBytes, "Standard 256-color output must match byte-for-byte");

      // 2. Test site 8 options (128 colors, compression level 9, PNG8:)
      const oldPath8 = `${dir}/control_old8.png`;
      const newPath8 = `${dir}/control_new8.png`;
      await Deno.copyFile(origPath, oldPath8);
      await Deno.copyFile(origPath, newPath8);

      const oldCmd8 = new Deno.Command("convert", {
        args: [
          oldPath8,
          "-strip",
          "-colors",
          "128",
          "-define",
          "png:compression-level=9",
          `PNG8:${oldPath8}.tmp`,
        ],
      });
      const oldRes8 = await oldCmd8.output();
      assertEquals(oldRes8.success, true);
      await Deno.rename(`${oldPath8}.tmp`, oldPath8);

      await quantiseEvidencePng(newPath8, {
        colors: 128,
        compressionLevel: 9,
        formatPrefix: "PNG8",
        allowOutsideProof: true,
      });

      const oldBytes8 = await Deno.readFile(oldPath8);
      const newBytes8 = await Deno.readFile(newPath8);
      assertEquals(newBytes8, oldBytes8, "Site 8 128-color output must match byte-for-byte");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "quantiseEvidencePng: injectable runner works without spawning processes",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-png-runner-" });
    const filePath = `${dir}/runner_test.png`;
    const tmpPath = `${filePath}.tmp`;
    await Deno.writeTextFile(filePath, "raw");

    try {
      // A. Simulated nonzero exit
      await Deno.writeTextFile(tmpPath, "tmp-before-nonzero");
      const errExit = await assertRejects(
        () =>
          quantiseEvidencePng(filePath, {
            allowOutsideProof: true,
            runner: () => Promise.resolve({ success: false, code: 42 }),
          }),
        Error,
      );
      assertMatch(errExit.message, /with exit code 42/);
      assertEquals(await Deno.stat(tmpPath).then(() => true).catch(() => false), false);

      // B. Simulated spawn error with code
      await Deno.writeTextFile(tmpPath, "tmp-before-spawn-err");
      const errSpawn = await assertRejects(
        () =>
          quantiseEvidencePng(filePath, {
            allowOutsideProof: true,
            runner: () => {
              const e = new Error("Command failed to spawn");
              (e as unknown as { code: string }).code = "EACCES";
              return Promise.reject(e);
            },
          }),
        Error,
      );
      assertMatch(errSpawn.message, /code EACCES/);
      assertEquals(await Deno.stat(tmpPath).then(() => true).catch(() => false), false);

      // C. Simulated success
      await Deno.writeTextFile(tmpPath, "converted-bytes");
      const res = await quantiseEvidencePng(filePath, {
        allowOutsideProof: true,
        runner: () => Promise.resolve({ success: true, code: 0 }),
      });
      assertEquals(res, filePath);
      assertEquals(await Deno.readTextFile(filePath), "converted-bytes");

      // D. Verify runner always receives unconditional -strip flag
      let capturedArgs: string[] = [];
      await Deno.writeTextFile(tmpPath, "runner-bytes");
      await quantiseEvidencePng(filePath, {
        colors: 128,
        formatPrefix: "PNG8",
        allowOutsideProof: true,
        runner: (_cmd, args) => {
          capturedArgs = args;
          return Promise.resolve({ success: true, code: 0 });
        },
      });
      assertEquals(
        capturedArgs.includes("-strip"),
        true,
        "-strip must always be passed to convert",
      );
      assertEquals(capturedArgs[1], "-strip", "-strip must precede options");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

/**
 * PNG chunk metadata parsed by walking the binary stream according to the PNG spec.
 */
interface PngChunk {
  type: string;
  length: number;
  offset: number;
}

/**
 * Parses the chunk sequence of a PNG file by walking the 8-byte signature,
 * followed by each chunk's 4-byte length, 4-byte type, data bytes, and 4-byte CRC.
 *
 * Fails closed on invalid signature, truncated chunk header, or unconsumed trailing bytes.
 */
function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8) {
    throw new Error(`Invalid PNG: file too short (${bytes.length} bytes)`);
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error(
        `Invalid PNG signature at byte ${i}: got ${bytes[i]}, expected ${PNG_SIGNATURE[i]}`,
      );
    }
  }

  const chunks: PngChunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = new TextDecoder("ascii").decode(typeBytes);
    chunks.push({ type, length, offset });

    offset += 8 + length + 4;
  }

  if (offset !== bytes.length) {
    throw new Error(
      `Invalid PNG: offset (${offset}) did not match byte length (${bytes.length})`,
    );
  }

  return chunks;
}

/**
 * Asserts that a PNG file's chunk sequence contains no chunk of the specified type.
 * Throws an Error with full chunk sequence details if found.
 */
function assertNoPngChunk(bytes: Uint8Array, forbiddenChunkType: string): void {
  const chunks = parsePngChunks(bytes);
  const found = chunks.filter((c) => c.type === forbiddenChunkType);
  if (found.length > 0) {
    throw new Error(
      `PNG artefact contains forbidden chunk type "${forbiddenChunkType}" (${found.length} occurrence(s)). ` +
        `Chunk sequence: ${chunks.map((c) => c.type).join(" -> ")}`,
    );
  }
}

/**
 * Synthetically constructs a PNG with a tIME chunk inserted before IEND
 * to prove negative control rejection independently of any external tool.
 */
function injectSyntheticTimeChunk(pngBytes: Uint8Array): Uint8Array {
  const chunks = parsePngChunks(pngBytes);
  const iend = chunks.find((c) => c.type === "IEND");
  if (!iend) throw new Error("IEND chunk not found in PNG");

  // PNG tIME chunk: length = 7 bytes
  // Year: 2 bytes (2026 = 0x07ea), Month: 10, Day: 13, Hour: 12, Min: 0, Sec: 0
  const timeData = new Uint8Array([0x07, 0xea, 10, 13, 12, 0, 0]);
  const typeAndData = new Uint8Array(4 + timeData.length);
  typeAndData.set(new TextEncoder().encode("tIME"), 0);
  typeAndData.set(timeData, 4);

  // CRC32 calculation over type and data
  let c = 0xffffffff;
  for (let i = 0; i < typeAndData.length; i++) {
    c ^= typeAndData[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  const crc = (c ^ 0xffffffff) >>> 0;

  const chunkBuf = new Uint8Array(4 + 4 + 7 + 4);
  const view = new DataView(chunkBuf.buffer);
  view.setUint32(0, 7, false); // Length
  chunkBuf.set(typeAndData, 4);
  view.setUint32(15, crc, false); // CRC

  // Splice before IEND
  const result = new Uint8Array(pngBytes.length + chunkBuf.length);
  result.set(pngBytes.subarray(0, iend.offset), 0);
  result.set(chunkBuf, iend.offset);
  result.set(pngBytes.subarray(iend.offset), iend.offset + chunkBuf.length);
  return result;
}

Deno.test({
  name:
    "quantiseEvidencePng: artefact carries no tIME chunk (negative controls prove assertion rejects tIME)",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-png-time-" });
    const rawPath = `${dir}/raw_with_time.png`;

    try {
      // 1. Generate an initial image with ImageMagick without -strip.
      // Default ImageMagick write stamps an encode-instant tIME chunk.
      const makeOut = await new Deno.Command("/usr/bin/convert", {
        args: ["-size", "8x8", "xc:red", rawPath],
      }).output();
      assertEquals(makeOut.success, true, "Failed to generate initial unstripped PNG");

      const rawBytes = await Deno.readFile(rawPath);
      const rawChunks = parsePngChunks(rawBytes);

      // Verify baseline: unstripped image MUST have tIME chunk
      const hasInitialTime = rawChunks.some((c) => c.type === "tIME");
      assertEquals(
        hasInitialTime,
        true,
        "Baseline ImageMagick PNG must carry tIME chunk to validate negative control",
      );

      // 2. NEGATIVE CONTROL 1: assertNoPngChunk MUST throw when given the unstripped file
      assertThrows(
        () => assertNoPngChunk(rawBytes, "tIME"),
        Error,
        'PNG artefact contains forbidden chunk type "tIME"',
      );

      // 3. POSITIVE ASSERTION (default options: 256 colors, png8:)
      const defaultPath = `${dir}/stripped_default.png`;
      await Deno.copyFile(rawPath, defaultPath);
      await quantiseEvidencePng(defaultPath, { allowOutsideProof: true });

      const defaultBytes = await Deno.readFile(defaultPath);
      const defaultChunks = parsePngChunks(defaultBytes);

      // Must NOT carry tIME chunk
      assertNoPngChunk(defaultBytes, "tIME");

      // Verify essential chunks are intact and metadata chunks are stripped
      assertEquals(defaultChunks.some((c) => c.type === "IHDR"), true, "Must have IHDR");
      assertEquals(defaultChunks.some((c) => c.type === "IDAT"), true, "Must have IDAT");
      assertEquals(defaultChunks.some((c) => c.type === "IEND"), true, "Must have IEND");
      assertEquals(
        defaultChunks.some((c) => c.type === "tIME" || c.type === "cHRM"),
        false,
        "Metadata chunks (tIME, cHRM) must be stripped",
      );

      // 4. POSITIVE ASSERTION (site 8 custom options: 128 colors, compressionLevel 9, formatPrefix PNG8)
      const site8Path = `${dir}/stripped_site8.png`;
      await Deno.copyFile(rawPath, site8Path);
      await quantiseEvidencePng(site8Path, {
        colors: 128,
        compressionLevel: 9,
        formatPrefix: "PNG8",
        allowOutsideProof: true,
      });

      const site8Bytes = await Deno.readFile(site8Path);
      assertNoPngChunk(site8Bytes, "tIME");

      // 5. NEGATIVE CONTROL 2: Synthetic tIME chunk injection on the stripped artefact.
      // Proves that even on a valid quantised output, adding a tIME chunk is immediately rejected.
      const syntheticWithTime = injectSyntheticTimeChunk(defaultBytes);
      const syntheticChunks = parsePngChunks(syntheticWithTime);
      assertEquals(
        syntheticChunks.some((c) => c.type === "tIME"),
        true,
        "Synthetic PNG must contain tIME chunk",
      );

      assertThrows(
        () => assertNoPngChunk(syntheticWithTime, "tIME"),
        Error,
        'PNG artefact contains forbidden chunk type "tIME"',
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
