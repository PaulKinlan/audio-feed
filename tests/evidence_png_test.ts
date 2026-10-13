/**
 * Unit tests for evidence PNG palette quantisation helper (audio-feed-az9j).
 *
 * Verifies:
 * 1. Stub `convert` on PATH exiting 7 throws naming the file and exit code, leaving no .tmp file.
 * 2. Missing `convert` (absent from PATH) throws naming the file and code ENOENT, leaving no .tmp file.
 * 3. Positive control: successful convert produces byte-identical output to direct ImageMagick invocation.
 * 4. Injectable runner support for seam testing without process execution.
 */

import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { quantiseEvidencePng } from "../scripts/evidence-png.ts";

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

    const origPath = Deno.env.get("PATH") || "";
    try {
      Deno.env.set("PATH", `${binDir}:${origPath}`);

      const err = await assertRejects(
        () => quantiseEvidencePng(filePath),
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
    } finally {
      Deno.env.set("PATH", origPath);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
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

    const origPath = Deno.env.get("PATH") || "";
    try {
      Deno.env.set("PATH", emptyBinDir);

      const err = await assertRejects(
        () => quantiseEvidencePng(filePath),
        Error,
      );

      // Must name the file and code ENOENT
      assertMatch(err.message, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assertMatch(err.message, /code ENOENT/);

      // Must clean up .tmp file
      const tmpExists = await Deno.stat(tmpPath).then(() => true).catch(() => false);
      assertEquals(tmpExists, false, ".tmp file must be removed on spawn failure");
    } finally {
      Deno.env.set("PATH", origPath);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
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
      const returnedPath = await quantiseEvidencePng(newPath);
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
        runner: () => Promise.resolve({ success: true, code: 0 }),
      });
      assertEquals(res, filePath);
      assertEquals(await Deno.readTextFile(filePath), "converted-bytes");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
