/**
 * audio-feed-v20a: verify live E2E TTS proof preserves committed evidence by default,
 * routing runtime verification evidence to uncommitted var/ by default and only writing
 * to docs/evidence/audio-feed-9vns/ when explicitly requested via --write-committed-evidence.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { isCommittedTarget, resolveEvidenceOutputDir } from "../scripts/verify_live_e2e_tts.ts";

Deno.test("audio-feed-v20a: default run routes evidence to uncommitted var/ to protect committed docs", () => {
  const result = resolveEvidenceOutputDir([]);
  assertEquals(result.dir, "var/evidence/audio-feed-9vns");
  assertEquals(result.isCommitted, false);
});

Deno.test("audio-feed-v20a: explicit out-dir override is respected and marked uncommitted", () => {
  const result = resolveEvidenceOutputDir(["--out-dir=/tmp/custom-run"]);
  assertEquals(result.dir, "/tmp/custom-run");
  assertEquals(result.isCommitted, false);
});

Deno.test("audio-feed-v20a: --write-committed-evidence routes to committed evidence directory", () => {
  const result = resolveEvidenceOutputDir(["--write-committed-evidence"]);
  assertEquals(result.dir, "docs/evidence/audio-feed-9vns");
  assertEquals(result.isCommitted, true);
});

Deno.test("audio-feed-v20a: --update-evidence routes to committed evidence directory", () => {
  const result = resolveEvidenceOutputDir(["--update-evidence"]);
  assertEquals(result.dir, "docs/evidence/audio-feed-9vns");
  assertEquals(result.isCommitted, true);
});

Deno.test("audio-feed-ulab: --out-dir targeting committed directory without --write-committed-evidence throws error", () => {
  assertThrows(
    () => resolveEvidenceOutputDir(["--out-dir=docs/evidence/audio-feed-9vns"]),
    Error,
    "Refusing to overwrite committed evidence",
  );
  assertThrows(
    () => resolveEvidenceOutputDir(["--out-dir=docs/evidence/audio-feed-9vns/../audio-feed-9vns"]),
    Error,
    "Refusing to overwrite committed evidence",
  );
});

Deno.test("audio-feed-ulab: --out-dir targeting committed directory WITH --write-committed-evidence succeeds and is marked committed", () => {
  const result = resolveEvidenceOutputDir([
    "--out-dir=docs/evidence/audio-feed-9vns",
    "--write-committed-evidence",
  ]);
  assertEquals(result.dir, "docs/evidence/audio-feed-9vns");
  assertEquals(result.isCommitted, true);
});

Deno.test("audio-feed-ulab: isCommittedTarget canonicalises relative, .., and absolute aliases", () => {
  assertEquals(isCommittedTarget("docs/evidence/audio-feed-9vns"), true);
  assertEquals(isCommittedTarget("docs/evidence/audio-feed-9vns/../audio-feed-9vns"), true);
  assertEquals(isCommittedTarget("./docs/evidence/audio-feed-9vns"), true);
  assertEquals(isCommittedTarget(`${Deno.cwd()}/docs/evidence/audio-feed-9vns`), true);
  assertEquals(isCommittedTarget("docs/evidence/audio-feed-3xq"), false);
  assertEquals(isCommittedTarget("var/evidence/audio-feed-9vns"), false);
  assertEquals(isCommittedTarget("/tmp/custom-run"), false);
});

Deno.test("audio-feed-ulab: target canonicalisation checks containment for subdirectories", () => {
  assertEquals(isCommittedTarget("docs/evidence/audio-feed-9vns/nested"), true);
  assertEquals(isCommittedTarget("docs/evidence/audio-feed-9vns/nested/deep"), true);
  assertThrows(
    () => resolveEvidenceOutputDir(["--out-dir=docs/evidence/audio-feed-9vns/nested"]),
    Error,
    "Refusing to overwrite committed evidence",
  );
});

Deno.test("audio-feed-ulab (shape 1): out-dir containing file symlink to committed evidence throws without write flag", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ulab-file-symlink-" });
  try {
    const outDir = `${tmpDir}/output`;
    await Deno.mkdir(outDir, { recursive: true });
    const repoRoot = new URL("../", import.meta.url).pathname.replace(/\/+$/, "");
    const realReadme = `${repoRoot}/docs/evidence/audio-feed-9vns/README.md`;
    await Deno.symlink(realReadme, `${outDir}/README.md`);

    // Refuses without write flag
    assertThrows(
      () => resolveEvidenceOutputDir([`--out-dir=${outDir}`]),
      Error,
      "Refusing to overwrite committed evidence",
    );

    // Succeeds and is marked committed WITH write flag
    const res = resolveEvidenceOutputDir([`--out-dir=${outDir}`, "--write-committed-evidence"]);
    assertEquals(res.dir, outDir);
    assertEquals(res.isCommitted, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-ulab (shape 2): symlinked default directory pointing to committed evidence throws without write flag", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ulab-dir-symlink-" });
  const origCwd = Deno.cwd();
  try {
    await Deno.mkdir(`${tmpDir}/var/evidence`, { recursive: true });
    const repoRoot = new URL("../", import.meta.url).pathname.replace(/\/+$/, "");
    const committedTarget = `${repoRoot}/docs/evidence/audio-feed-9vns`;
    await Deno.symlink(committedTarget, `${tmpDir}/var/evidence/audio-feed-9vns`);

    Deno.chdir(tmpDir);

    // Default args [] targets var/evidence/audio-feed-9vns.
    // Because that symlinks to docs/evidence/audio-feed-9vns, it must refuse without write flag:
    assertThrows(
      () => resolveEvidenceOutputDir([]),
      Error,
      "Refusing to overwrite committed evidence",
    );

    // With explicit write flag, it succeeds and is marked committed
    const res = resolveEvidenceOutputDir(["--write-committed-evidence"]);
    assertEquals(res.isCommitted, true);
  } finally {
    Deno.chdir(origCwd);
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
