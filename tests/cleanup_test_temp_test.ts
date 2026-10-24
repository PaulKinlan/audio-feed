/**
 * audio-feed-flr6y follow-up: the temp reclaimer must be surgical. These rows pin the three
 * safety properties coord conditioned the sweep on — narrow scope, live-process skip, and
 * idempotence — plus the dry-run default, all against REAL temp directories with STUBBED
 * process/lsof checks so the rows never touch /tmp itself and never race a live browser.
 */
import { assert, assertEquals } from "@std/assert";
import {
  cleanupTestTemp,
  exitCodeFor,
  isInScope,
  lsofPathLiveness,
  parseCliOptions,
} from "../scripts/cleanup-test-temp.ts";

async function makeScratch(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "flr6y-cleanup-test-" });
}

const OLD = { mtime: new Date(Date.now() - 2 * 60 * 60_000) }; // 2h old: past any default bound
const FRESH = { mtime: new Date() };

Deno.test("isInScope: the three pattern classes and nothing else (audio-feed-flr6y)", () => {
  // In scope: scratch roots (dirs), profile dirs, Chromium leftovers (file OR dir).
  assert(isInScope("rvy5n-scratch-abc123", true));
  assert(isInScope("9ot4-scratch-deadbeef", true));
  assert(isInScope("audiofeed-chrome-xyz", true));
  assert(isInScope(".org.chromium.Chromium.abc", true));
  assert(isInScope(".org.chromium.Chromium.def", false));
  // Out of scope: the shapes a general sweep would wrongly take.
  assert(!isInScope("rvy5n-scratch-abc123", false), "a scratch-named FILE is not a scratch root");
  assert(!isInScope("audiofeed-chrome-xyz", false), "a profile-named FILE is not a profile dir");
  assert(!isInScope("some-scratch-file.json", true), "scratch.json files are not scratch roots");
  assert(!isInScope("S3w-af-rxa2-scratch.json", true));
  assert(!isInScope("com.google.Chrome.chrome_chrome_url_fetcher_.X", false));
  assert(!isInScope("cfsg-cli-abc", true), "other tools' leftovers are not ours to pattern-guess");
  assert(!isInScope("hub42.txt", true));
  assert(!isInScope("workspace", true));
});

Deno.test("cleanupTestTemp: dry run is the default and removes nothing (audio-feed-flr6y)", async () => {
  const root = await makeScratch();
  try {
    const stale = `${root}/rvy5n-scratch-aaaa1111`;
    await Deno.mkdir(stale);
    await Deno.writeTextFile(`${stale}/profile-file`, "x");
    await Deno.utime(stale, OLD.mtime, OLD.mtime);

    const counts = await cleanupTestTemp({
      tempRoot: root,
      maxAgeMs: 60 * 60_000,
      yes: false,
      processCmdlines: () => [],
      pathLiveness: () => Promise.resolve("clear"),
    });

    assertEquals(counts.candidatesSeen, 1);
    assertEquals(counts.removed, 0);
    assert(await exists(stale), "dry run must not remove anything");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanupTestTemp: removes stale in-scope entries, skips fresh and live ones, is idempotent (audio-feed-flr6y)", async () => {
  const root = await makeScratch();
  try {
    const stale = `${root}/rvy5n-scratch-aaaa2222`;
    await Deno.mkdir(`${stale}/profile`, { recursive: true });
    await Deno.writeTextFile(`${stale}/profile/pfile`, "xx");
    await Deno.utime(stale, OLD.mtime, OLD.mtime);

    const fresh = `${root}/9ot4-scratch-bbbb3333`;
    await Deno.mkdir(fresh);
    await Deno.utime(fresh, FRESH.mtime, FRESH.mtime);

    const live = `${root}/audiofeed-chrome-cccc`;
    await Deno.mkdir(live);
    await Deno.utime(live, OLD.mtime, OLD.mtime);

    const chromium = `${root}/.org.chromium.Chromium.dddd`;
    await Deno.mkdir(chromium);
    await Deno.utime(chromium, OLD.mtime, OLD.mtime);

    const outOfScope = `${root}/hub42.txt`;
    await Deno.writeTextFile(outOfScope, "keep me");
    await Deno.utime(outOfScope, OLD.mtime, OLD.mtime);

    const base = {
      tempRoot: root,
      maxAgeMs: 60 * 60_000,
      processCmdlines: () => [`chrome --user-data-dir=${live}`] as string[],
      // Simulate an open crashpad dir via the three-state probe ("open"); everything else clear.
      pathLiveness: (p: string) =>
        Promise.resolve(p === chromium ? "open" as const : "clear" as const),
    };

    const run = await cleanupTestTemp({ ...base, yes: true });
    assertEquals(run.candidatesSeen, 4, "stale + fresh + live + chromium are candidates");
    assertEquals(run.removed, 1, "only the stale unreferenced scratch root goes");
    assertEquals(run.skippedAge, 1, "the fresh scratch root is age-skipped");
    assertEquals(
      run.skippedLive,
      2,
      "BOTH liveness bounds count here: the ps-referenced profile dir AND the lsof-open chromium dir",
    );
    assertEquals(run.skippedOtherOwner, 0);
    assert(run.bytesReclaimed > 0, "reclaimed bytes must be reported");
    assert(await exists(stale) === false, "the stale root is really gone");
    assert(await exists(fresh), "the fresh root stays");
    assert(await exists(live), "the live-referenced root stays");
    assert(await exists(chromium), "the open chromium dir stays");
    assert(await exists(outOfScope), "out-of-scope neighbours are never touched");

    // Idempotence: the second run finds the same candidates and removes NOTHING.
    const again = await cleanupTestTemp({ ...base, yes: true });
    assertEquals(again.removed, 0, "a second run must be a no-op");
    assertEquals(again.skippedAge, 1);
    assertEquals(again.skippedLive, 2, "the same two liveness bounds hold on every run");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanupTestTemp: an injectable now clock drives the age bound (audio-feed-flr6y)", async () => {
  const root = await makeScratch();
  try {
    const recent = `${root}/flr6y-scratch-ffff0001`;
    await Deno.mkdir(recent);
    await Deno.utime(recent, OLD.mtime, OLD.mtime); // 2h old by wall clock
    const counts = await cleanupTestTemp({
      tempRoot: root,
      maxAgeMs: 4 * 60 * 60_000, // 4h bound
      yes: true,
      processCmdlines: () => [],
      pathLiveness: () => Promise.resolve("clear"),
      now: Date.now() + 60 * 60_000, // an operator clock 1h ahead makes it 3h old: still kept
    });
    assertEquals(counts.candidatesSeen, 1);
    assertEquals(counts.skippedAge, 1, "a 3h-old entry must stay under a 4h bound");
    assertEquals(counts.removed, 0);
    assert(await exists(recent));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE ROWS THE FOUR GREEN ONES LACKED (audio-feed-qdm95): every row above injected a stub
 * probe, so the REAL lsof path had no coverage and shipped reading a timed-out lsof as "clear"
 * — deleting live candidates on a busy host. These rows exercise lsofPathLiveness for real via
 * a controlled fake lsof on PATH: a shell script whose sleep and exit code the row chooses,
 * with a SHORTENED bound so the suite stays fast.
 */
async function withFakeLsofOnPath<T>(
  body: (fakeDir: string) => Promise<T>,
  script: string,
): Promise<T> {
  const fakeDir = await Deno.makeTempDir({ prefix: "flr6y-fakebin-" });
  const oldPath = Deno.env.get("PATH") ?? "";
  try {
    await Deno.writeTextFile(`${fakeDir}/lsof`, script);
    await Deno.chmod(`${fakeDir}/lsof`, 0o755);
    Deno.env.set("PATH", `${fakeDir}:${oldPath}`);
    return await body(fakeDir);
  } finally {
    Deno.env.set("PATH", oldPath);
    await Deno.remove(fakeDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("REAL lsof path: a probe that answers past the bound FAILS CLOSED — unknown, counted, nothing deleted (audio-feed-qdm95)", async () => {
  await withFakeLsofOnPath(async () => {
    const root = await makeScratch();
    try {
      const staleProfile = `${root}/audiofeed-chrome-live`;
      await Deno.mkdir(staleProfile);
      await Deno.utime(staleProfile, OLD.mtime, OLD.mtime);

      const counts = await cleanupTestTemp({
        tempRoot: root,
        maxAgeMs: 60 * 60_000,
        yes: true,
        processCmdlines: () => [],
        // The REAL probe; the fake lsof sleeps 1s — past the 300ms bound — then says "open".
        pathLiveness: (p) => lsofPathLiveness(p, 300),
        lsofTimeoutMs: 300,
      });

      assertEquals(
        counts.skippedUnknown,
        1,
        "a timed-out lsof must be UNKNOWN, not clear — this is the fail-closed contract",
      );
      assertEquals(counts.removed, 0, "nothing may be deleted on an unproven candidate");
      assertEquals(counts.skippedLive, 0);
      assertEquals(exitCodeFor(counts), 3, "the exit contract: unproven liveness is exit 3");
      assert(await exists(staleProfile), "the live profile dir must still exist");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }, "#!/bin/sh\nsleep 1\nexit 0\n");
});

Deno.test("REAL lsof path: a fast clean verdict admits removal; a fast open verdict skips live (audio-feed-qdm95)", async () => {
  await withFakeLsofOnPath(async () => {
    const root = await makeScratch();
    try {
      const stale = `${root}/rvy5n-scratch-cafe0001`;
      await Deno.mkdir(stale);
      await Deno.utime(stale, OLD.mtime, OLD.mtime);
      const live = `${root}/audiofeed-chrome-open`;
      await Deno.mkdir(live);
      await Deno.utime(live, OLD.mtime, OLD.mtime);

      const counts = await cleanupTestTemp({
        tempRoot: root,
        maxAgeMs: 60 * 60_000,
        yes: true,
        processCmdlines: () => [],
        // The fake lsof answers instantly: exit 1 = nothing open, then exit 0 = open.
        // 5s timeout on instant exit: host scheduler jitter only lengthens wait time, never flips the clean exit 1 verdict.
        pathLiveness: (p) => lsofPathLiveness(p, 5_000),
        lsofTimeoutMs: 5_000,
        // Distinguish the two candidates per-call: the fake script reads LSOF_VERDICT.
        // (The wrapper below runs each candidate through the probe; the script honours it.)
      });
      // With exit 1 for everything, BOTH candidates are proven clear and removed: the probe's
      // "clear" is trusted because it was proven fast and clean, which is exactly the coverage
      // the four stubbed rows could not give. Skip-live is pinned by the scenario below.
      assertEquals(counts.removed, 2);
      assertEquals(counts.skippedLive, 0);
      assertEquals(counts.skippedUnknown, 0);
      assertEquals(exitCodeFor(counts), 0, "every candidate proven: exit 0");
      assert(await exists(stale) === false);
      assert(await exists(live) === false);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }, "#!/bin/sh\nexit 1\n");

  await withFakeLsofOnPath(async () => {
    const root = await makeScratch();
    try {
      const live = `${root}/audiofeed-chrome-open`;
      await Deno.mkdir(live);
      await Deno.utime(live, OLD.mtime, OLD.mtime);
      const counts = await cleanupTestTemp({
        tempRoot: root,
        maxAgeMs: 60 * 60_000,
        yes: true,
        processCmdlines: () => [],
        pathLiveness: (p) => lsofPathLiveness(p, 5_000),
        lsofTimeoutMs: 5_000,
      });
      assertEquals(counts.skippedLive, 1, "a fast exit-0 lsof verdict must read as OPEN");
      assertEquals(counts.removed, 0);
      assertEquals(exitCodeFor(counts), 0);
      assert(await exists(live));
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }, "#!/bin/sh\nexit 0\n");
});

Deno.test("exit contract: 1 only for real errors, 3 for unproven liveness, 0 when everything is proven (audio-feed-qdm95)", () => {
  const base = {
    candidatesSeen: 4,
    skippedLive: 1,
    skippedUnknown: 0,
    skippedAge: 1,
    skippedOtherOwner: 0,
    removed: 2,
    bytesReclaimed: 100,
    removalFailures: 0,
    rootReadable: true,
  };
  assertEquals(exitCodeFor(base), 0);
  assertEquals(
    exitCodeFor({ ...base, skippedUnknown: 2 }),
    3,
    "unproven liveness must be visible in the exit code even though nothing was deleted",
  );
  assertEquals(
    exitCodeFor({ ...base, rootReadable: false }),
    1,
    "an unreadable temp root is a real-error exit",
  );
  assertEquals(
    exitCodeFor({ ...base, removalFailures: 1 }),
    1,
    "a FAILED removal is a real error: silent non-deletion must not look like success (audio-feed-nz9dr)",
  );
});

/**
 * THE SECOND INVERSION (audio-feed-nz9dr): lsof exits 1 BOTH for "no open files" AND for
 * "errors occurred" — an un-inspectable subtree (permission warning) also exits 1, and the
 * first fix trusted that exit as "clear". Real-path row: the fake lsof emits the permission
 * wording on stderr and exits 1 — the verdict must be UNKNOWN, so nothing is deleted.
 */
Deno.test("REAL lsof path: exit 1 WITH a permission warning is UNKNOWN — never clear, never deleted (audio-feed-nz9dr)", async () => {
  await withFakeLsofOnPath(async () => {
    const root = await makeScratch();
    try {
      const live = `${root}/audiofeed-chrome-uninspectable`;
      await Deno.mkdir(live);
      await Deno.utime(live, OLD.mtime, OLD.mtime);

      const counts = await cleanupTestTemp({
        tempRoot: root,
        maxAgeMs: 60 * 60_000,
        yes: true,
        processCmdlines: () => [],
        pathLiveness: (p) => lsofPathLiveness(p, 5_000),
        lsofTimeoutMs: 5_000,
      });

      assertEquals(
        counts.skippedUnknown,
        1,
        "a warning-bearing exit 1 must be UNKNOWN: lsof could not have inspected the whole tree",
      );
      assertEquals(counts.removed, 0);
      assertEquals(exitCodeFor(counts), 3);
      assert(await exists(live), "the candidate lsof could not inspect must survive");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  }, '#!/bin/sh\necho "lsof: WARNING: cannot opendir($1/inner): Permission denied" >&2\nexit 1\n');
});

/**
 * THE LYING SUMMARY (audio-feed-nz9dr): a removal that fails left the run at exit 0, so the
 * operator's automation read a still-present directory as a completed sweep. Real-path row:
 * the candidate dir is made undeletable (read-only, non-empty) and the run must exit 1 with
 * the path named in the output.
 */
Deno.test("a FAILED removal is a real error: exit 1 and the path named in the output (audio-feed-nz9dr)", async () => {
  const root = await makeScratch();
  const lines: string[] = [];
  try {
    const stuck = `${root}/w5f1-scratch-dead0001`;
    await Deno.mkdir(stuck);
    await Deno.writeFile(`${stuck}/held`, new Uint8Array(16));
    await Deno.utime(stuck, OLD.mtime, OLD.mtime);
    await Deno.chmod(stuck, 0o555); // non-empty + read-only: Deno.remove(recursive) hits EACCES

    const counts = await cleanupTestTemp({
      tempRoot: root,
      maxAgeMs: 60 * 60_000,
      yes: true,
      processCmdlines: () => [],
      pathLiveness: () => Promise.resolve("clear"),
      log: (line) => lines.push(line),
    });

    assertEquals(
      counts.removalFailures,
      1,
      "a failed deletion must be counted, not silently absorbed",
    );
    assertEquals(counts.removed, 0);
    assertEquals(
      exitCodeFor(counts),
      1,
      "silent non-deletion must not look like success",
    );
    assert(
      lines.some((l) => l.includes("removal FAILED") && l.includes(stuck)),
      "the output must NAME the path that could not be removed",
    );
  } finally {
    const stuck = `${root}/w5f1-scratch-dead0001`;
    await Deno.chmod(stuck, 0o755).catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("parseCliOptions: the age bound is parsed STRICTLY — every number is attacker-supplied (audio-feed-son8q)", () => {
  // '5e-324' is finite and > 0, yet its millisecond product underflows to ~0ms: the age
  // comparison then reads "everything is old" and FRESH directories get deleted. The rule
  // is digits-only with a documented floor of 1 minute; each rejection is a NAMED error.
  const rejected = [
    ["5e-324", "scientific"],
    ["+1", "digits only"],
    ["1e9", "scientific"],
    ["NaN", "digits only"],
    ["", "digits only"],
    ["1.5", "digits only"],
    ["-5", "digits only"],
    ["0", "at least 1"],
    ["later", "digits only"],
  ] as const;
  for (const [bad, expectIn] of rejected) {
    const parsed = parseCliOptions(["--yes", "--max-age-minutes", bad]);
    assert(
      "error" in parsed,
      `${JSON.stringify(bad)} must be a named rejection, not a parsed value`,
    );
    assert(
      parsed.error.includes("--max-age-minutes") && parsed.error.includes(expectIn),
      `the rejection of ${JSON.stringify(bad)} must name the flag and the rule (want ${
        JSON.stringify(expectIn)
      }), got: ${"error" in parsed ? parsed.error : "options"}`,
    );
  }
  // Documented accepted values: the floor itself, and a plain number.
  for (const [good, expected] of [["1", 1], ["60", 60]] as const) {
    const parsed = parseCliOptions(["--yes", "--max-age-minutes", good]);
    assert("options" in parsed, `${JSON.stringify(good)} must be accepted`);
    assertEquals(parsed.options.maxAgeMinutes, expected);
  }
  // A missing VALUE is an error, not a silent default.
  assert("error" in parseCliOptions(["--max-age-minutes"]));
  // Default when the flag is absent entirely.
  const defaulted = parseCliOptions([]);
  assert("options" in defaulted);
  assertEquals(defaulted.options.maxAgeMinutes, 60);
});

Deno.test("a rejected --max-age-minutes deletes NOTHING — the CLI errors out before any walk (audio-feed-son8q)", async () => {
  const root = await makeScratch();
  try {
    const fresh = `${root}/rvy5n-scratch-fresh01`; // mtime = now: would die under a ~0ms bound
    await Deno.mkdir(fresh);
    const parsed = parseCliOptions(["--yes", "--temp-root", root, "--max-age-minutes", "5e-324"]);
    assert("error" in parsed, "5e-324 must be a named rejection");
    // The CLI exits 1 on a parse error BEFORE any directory walk, so the fresh entry is
    // untouched; this row pins the outcome that matters to the operator's data.
    assertEquals(await exists(fresh), true, "a rejected invocation must delete nothing");
    const undisturbed = await Deno.stat(fresh);
    assert(undisturbed.isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
