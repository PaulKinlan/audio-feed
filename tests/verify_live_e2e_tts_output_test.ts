/**
 * audio-feed-v20a: verify live E2E TTS proof preserves committed evidence by default,
 * routing runtime verification evidence to uncommitted var/ by default and only writing
 * to docs/evidence/audio-feed-9vns/ when explicitly requested via --write-committed-evidence.
 */
import { assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { formatEvidenceReadme } from "../scripts/proof-helper.ts";
import { buildU60aReadmeOptions } from "../scripts/verify_live_tts.ts";
import {
  build9vnsReadmeOptions,
  isCommittedTarget,
  resolveEvidenceOutputDir,
} from "../scripts/verify_live_e2e_tts.ts";

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

Deno.test("audio-feed-1t8t / audio-feed-guep: u60a committed README matches generator formatEvidenceReadme byte-for-byte", async () => {
  const repoRoot = new URL("../", import.meta.url).pathname.replace(/\/+$/, "");
  const committed = await Deno.readTextFile(`${repoRoot}/docs/evidence/audio-feed-u60a/README.md`);
  const expected = formatEvidenceReadme(buildU60aReadmeOptions());
  assertEquals(committed, expected, "u60a committed README must be byte-identical to generator");

  // Negative control: a modified body or extra character fails equality
  const modified = expected + "\n";
  assertNotEquals(committed, modified, "extra newline must fail equality");
  const mutatedOptions = buildU60aReadmeOptions();
  mutatedOptions.sections![0]!.body += " mutant";
  assertNotEquals(
    committed,
    formatEvidenceReadme(mutatedOptions),
    "mutated section body must fail equality",
  );
});

Deno.test("audio-feed-1t8t / audio-feed-guep / audio-feed-6y1n: 9vns committed README matches generator formatEvidenceReadme byte-for-byte and retains 2026-10-08 table", async () => {
  const repoRoot = new URL("../", import.meta.url).pathname.replace(/\/+$/, "");
  const committed = await Deno.readTextFile(`${repoRoot}/docs/evidence/audio-feed-9vns/README.md`);
  const expected = formatEvidenceReadme(build9vnsReadmeOptions("docs/evidence/audio-feed-9vns"));
  assertEquals(committed, expected, "9vns committed README must be byte-identical to generator");

  // audio-feed-6y1n: verify dated table is preserved and labeled as 2026-10-08 snapshot
  assertStringIncludes(
    committed,
    "The counts and per-segment table below describe the original 2026-10-08 verification run",
  );
  assertStringIncludes(
    committed,
    "| **Total** | **44,645** | **44,703** | **2,689.20** | **129,130,512** | **129,081,600** | — | — |",
  );

  // Negative control: a modified body or extra character fails equality
  const mutatedOptions = build9vnsReadmeOptions("docs/evidence/audio-feed-9vns");
  mutatedOptions.sections![0]!.body += " mutant";
  assertNotEquals(
    committed,
    formatEvidenceReadme(mutatedOptions),
    "mutated section body must fail equality",
  );
});
