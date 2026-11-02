/**
 * Tests for scripts/bd-durability-check.sh — the check that is supposed to catch a
 * wedged bead DB (audio-feed-a1bm8) was itself reporting a FALSE PASS and failing the
 * healthy configuration. These rows pin the fixes:
 *
 *   1. a `bd show` that returns rc=0 with the WRONG title must FAIL the check (the
 *      first cut only grepped for the id it had just passed in, i.e. for argv);
 *   2. the same call returning the created title must PASS;
 *   3. an absent backup destination with `backup: enabled: false` must PASS (healthy,
 *      intended state — auto-backup is deliberately off in this repo);
 *   4. an absent backup destination with auto-backup enabled must FAIL.
 *
 * Rows run against tests/fixtures/bd_stub.sh through BEADS_DIR, so no real bead DB is
 * touched and no wedged DB is needed to reproduce a failure.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Literal pathname forms (not templates over ROOT): the fast gate derives which suite
// executes which non-TypeScript path from exactly these literals.
const CHECK_PATH = new URL("../scripts/bd-durability-check.sh", import.meta.url).pathname;
const STUB_PATH = new URL("./fixtures/bd_stub.sh", import.meta.url).pathname;

const ADDR_A = "0123456789abcdef0123456789abcdef";
const ADDR_B = "fedcba9876543210fedcba9876543210";
const ZERO_ADDR = "0".repeat(32);

interface Row {
  /** Does the fixture .beads/backup destination exist with consistent chunks? */
  backupDir: boolean;
  /** Contents of .beads/config.yaml beyond the header comment. */
  config: string;
  /** Title the stub hands back from `bd show`; unset means "the one it recorded". */
  showTitle?: string;
}

async function runCheck(row: Row): Promise<{ code: number; stdout: string; stderr: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "bd-durability-test-" });
  try {
    const beads = `${tmp}/beads`;
    await Deno.mkdir(beads, { recursive: true });
    await Deno.writeTextFile(
      `${beads}/config.yaml`,
      `# stub config for tests/bd_durability_check_test.ts\n${row.config}`,
    );
    if (row.backupDir) {
      await Deno.mkdir(`${beads}/backup/oldgen`, { recursive: true });
      await Deno.writeTextFile(
        `${beads}/backup/manifest`,
        `${ZERO_ADDR}:${ADDR_A}:${ADDR_B}`,
      );
      await Deno.writeTextFile(`${beads}/backup/${ADDR_A}.darc`, "x");
      await Deno.writeTextFile(`${beads}/backup/oldgen/${ADDR_B}.darc`, "x");
    }

    const stubDir = `${tmp}/bin`;
    const state = `${tmp}/state`;
    await Deno.mkdir(stubDir, { recursive: true });
    await Deno.copyFile(STUB_PATH, `${stubDir}/bd`);
    await Deno.chmod(`${stubDir}/bd`, 0o755);

    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      PATH: `${stubDir}:${Deno.env.get("PATH") ?? ""}`,
      BEADS_DIR: beads,
      BD_STUB_DIR: state,
      BD_DURABILITY_TIMEOUT: "20",
      BD_DURABILITY_SLOW: "30",
      TMPDIR: tmp,
    };
    delete env.BD_DURABILITY_KEEP;
    if (row.showTitle !== undefined) env.BD_STUB_SHOW_TITLE = row.showTitle;

    const out = await new Deno.Command(CHECK_PATH, {
      args: [],
      cwd: ROOT,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

const ENABLED_FIXTURE: Row = {
  backupDir: true,
  config: `sync.remote: "git+https://example.invalid/audio-feed.git"\nbackup:\n  enabled: true\n`,
};

Deno.test("audio-feed bd-check: a wrong read-back FAILS, rc=0 from bd show is not durability", async () => {
  const result = await runCheck({ ...ENABLED_FIXTURE, showTitle: "some other bead entirely" });
  assertEquals(
    result.code,
    1,
    `check must exit 1 on a wrong read-back:\n${result.stdout}\n${result.stderr}`,
  );
  assertStringIncludes(result.stderr, "did not return the title that was created");
  assert(
    !result.stdout.includes("live read-back: the title stored in the DB equals the title created"),
    "the wrong-read-back row must not print the read-back ok line",
  );
});

Deno.test("audio-feed bd-check: the created title read back PASSES", async () => {
  const result = await runCheck(ENABLED_FIXTURE);
  assertEquals(
    result.code,
    0,
    `check must exit 0 on a correct read-back:\n${result.stdout}\n${result.stderr}`,
  );
  assertStringIncludes(
    result.stdout,
    "live read-back: the title stored in the DB equals the title created",
  );
  assertStringIncludes(
    result.stdout,
    "round-trip proven: the created title is readable from the restored backup",
  );
});

Deno.test("audio-feed bd-check: absent backup + auto-backup disabled PASSES", async () => {
  const result = await runCheck({ backupDir: false, config: `backup:\n  enabled: false\n` });
  assertEquals(
    result.code,
    0,
    `disabled auto-backup is the healthy state:\n${result.stdout}\n${result.stderr}`,
  );
  assertStringIncludes(result.stdout, "auto-backup: off");
  assertStringIncludes(result.stdout, "backup destination absent and auto-backup disabled");
});

Deno.test("audio-feed bd-check: absent backup + auto-backup enabled FAILS", async () => {
  const result = await runCheck({
    backupDir: false,
    config: `sync.remote: "git+https://example.invalid/audio-feed.git"\nbackup:\n  enabled: true\n`,
  });
  assertEquals(result.code, 1, "a missing destination with auto-backup ON is a real failure");
  assertStringIncludes(result.stderr, "backup manifest missing");
});

Deno.test("audio-feed bd-check: an unparseable backup manifest is not a pass", async () => {
  const result = await runCheck({ backupDir: true, config: `backup:\n  enabled: true\n` });
  assertEquals(result.code, 0);
  // The guard itself: a manifest with no 32-char address must fail rather than
  // report "all 0 referenced table files present".
  const tmp = await Deno.makeTempDir({ prefix: "bd-durability-empty-" });
  try {
    await Deno.mkdir(`${tmp}/backup`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/backup/manifest`, "not-a-manifest\n");
    await Deno.writeTextFile(`${tmp}/config.yaml`, "backup:\n  enabled: true\n");
    const out = await new Deno.Command("bash", {
      args: [
        "-c",
        `BEADS_DIR="${tmp}" BD_DURABILITY_TIMEOUT=20 bash "${CHECK_PATH}" --skip-restore`,
      ],
      cwd: ROOT,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 1, `an empty manifest must fail the check:\n${stdout}\n${stderr}`);
    assertStringIncludes(stderr, "no parseable 32-char table-file address");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed bd-check: a dashed id and a dashed title are parsed apart", async () => {
  // The first cut used `grep -oE '[a-z0-9]+-[a-z0-9]+' | tail -1`, which turned
  // `audio-feed-ro4tg` into `audio-feed` and preferred any dashed word from a title
  // or a PATH warning over the id. The stub prints its id with a dashed PATH warning
  // on stderr and the check generates a dashed title of its own.
  const result = await runCheck(ENABLED_FIXTURE);
  assertStringIncludes(result.stdout, "bd create printed a bare id: audio-feed-tst01");
  assertStringIncludes(result.stdout, "live read-back of audio-feed-tst01");
});
