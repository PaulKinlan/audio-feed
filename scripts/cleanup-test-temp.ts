/**
 * Bounded, idempotent reclaimer of THIS project's leaked Chrome/test temp entries
 * (audio-feed-flr6y follow-up).
 *
 * WHY THIS EXISTS: the repo's createTempChromeProfile already reclaims abandoned PROFILES at
 * allocation time (sweepStaleProfiles, audio-feed-u8nv), but the SCRATCH ROOTS tests allocate
 * around them (Deno.makeTempDir with a `<bead>-scratch-<hex>` prefix, passed as rootDir) leak
 * whenever a test dies before its own teardown, and Chromium's crashpad leftovers
 * (.org.chromium.*) leak unconditionally. On 2026-10-23 the VM's /tmp carried 14,519 entries
 * / 4.3 GB, a large share of them these classes, and the fleet was paying for it in slow
 * browser suites. This script reclaims EXACTLY the three pattern classes below and nothing
 * else — never a general /tmp sweep; a general sweep is how a proof loses its evidence
 * mid-run.
 *
 * SAFETY PROPERTIES (audio-feed-flr6y, coord-approved constraints):
 * - SCOPE: only (1) `.org.chromium*`, (2) scratch-root directories shaped
 *   `<3-5 alnum>-scratch-<hex>`, (3) `audiofeed-chrome-*` profile dirs — all DIRECTLY in the
 *   temp root, never recursive into unrelated names.
 * - LIVENESS: a candidate is SKIPPED when any live process's command line references it, when
 *   lsof reports an open file under it, or when it was modified within the age bound
 *   (default 60 minutes — a profile mid-creation may not be referenced by any process yet).
 * - IDEMPOTENT: a second run removes zero entries and still exits 0.
 * - FAIL CLOSED (audio-feed-qdm95): if liveness cannot be PROVEN for a candidate — lsof
 *   timed out, was killed, is missing, or failed oddly — the candidate is NOT removed. It is
 *   counted as skipped-unknown, reported, and nothing else changes. The previous version read
 *   a timed-out lsof as "not open" and DELETED the candidate, which inverted the guard on
 *   exactly the busy-host case it exists for (the reviewer's repro: the same lsof verdict
 *   flip-flopped skip/delete purely by answering after the bound). A sweep that leaves work
 *   behind is cheap; a sweep that deletes a live profile mid-proof costs a gate and a morning.
 *
 * EXIT CONTRACT (stated, per the finding): 0 = completed and every candidate's fate is PROVEN
 * (removed, or skipped for a definitive reason). 3 = completed but at least one candidate was
 * skipped-unknown — NOT an error to "fix by re-running harder": it means the host was too busy
 * to prove liveness, nothing was deleted for those candidates, and the sweep should be re-run
 * when the host is quiet. 1 = a real error (temp root unreadable, unusable --max-age-minutes).
 * A removal that FAILS is a real error (exit 1, path named in the output): silent
 * non-deletion must never look like success (audio-feed-nz9dr).
 * Chosen so exit 0 can never mean "some deletions happened without proof", while automation
 * still gets a distinct, documented code to alert on instead of a silent partial sweep.
 * - NO ROOT: only entries owned by the current user are removed; anything else is counted as
 *   skipped-other-owner.
 * - DRY-RUN BY DEFAULT: without --yes it prints what it WOULD do and changes nothing.
 *
 * USAGE:
 *   deno run --allow-read --allow-write --allow-run --allow-sys scripts/cleanup-test-temp.ts           # dry run (uses $TMPDIR or /tmp; add --allow-env to honour $TMPDIR)
 *   deno run --allow-read --allow-write --allow-run --allow-sys scripts/cleanup-test-temp.ts --yes     # reclaim
 *   ... --temp-root /tmp --max-age-minutes 60
 */

/** The three in-scope name patterns, anchored to the temp root (never recursive). */
export const SCRATCH_ROOT_PATTERN = /^[a-z0-9]{3,5}-scratch-[0-9a-fA-F]+$/;
export const CHROMIUM_LEFTOVER_PATTERN = /^\.org\.chromium/;
export const PROFILE_DIR_PATTERN = /^audiofeed-chrome-/;

export interface CleanupCounts {
  candidatesSeen: number;
  skippedLive: number;
  /** Liveness could not be proven (lsof timed out, missing, or failed oddly): NOT deleted. */
  skippedUnknown: number;
  skippedAge: number;
  skippedOtherOwner: number;
  removed: number;
  bytesReclaimed: number;
  /** Deletion attempts that FAILED: a real error — silent non-deletion is not a proven fate. */
  removalFailures: number;
  /** False only when the temp root itself could not be read — the one real-error shape. */
  rootReadable: boolean;
}

export interface CleanupOptions {
  tempRoot: string;
  maxAgeMs: number;
  yes: boolean;
  /** Injected process-command-line scan (tests pass a stub). Defaults to `ps`. */
  processCmdlines?: () => string[];
  /**
   * Injected liveness probe (tests pass a stub returning "open"/"clear"/"unknown").
   * Defaults to the REAL lsof path (`lsofPathIsOpen`), whose "unknown" outcome FAILS CLOSED:
   * an unknown candidate is skipped and counted, never deleted (audio-feed-qdm95).
   */
  pathLiveness?: (path: string) => Promise<"open" | "clear" | "unknown">;
  /** Hard bound for the real lsof probe. Default 10s; tests shorten it to stay fast. */
  lsofTimeoutMs?: number;
  now?: number;
  log?: (line: string) => void;
}

/** Does this name belong to one of the three in-scope classes? Directories for 1 and 3; the
 * Chromium crashpad class creates BOTH files and directories, so it admits either. */
export function isInScope(name: string, isDirectory: boolean): boolean {
  if (SCRATCH_ROOT_PATTERN.test(name)) return isDirectory;
  if (PROFILE_DIR_PATTERN.test(name)) return isDirectory;
  if (CHROMIUM_LEFTOVER_PATTERN.test(name)) return true;
  return false;
}

/** Best-effort command-line scan: every live process's argv, joined, for substring matches. */
function liveCmdlines(): string[] {
  try {
    const out = new Deno.Command("ps", {
      args: ["-eo", "args"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    return new TextDecoder().decode(out.stdout).split("\n").filter((l) => l.length > 0);
  } catch {
    // A host without ps must not fail the sweep; the lsof and age bounds still apply.
    return [];
  }
}

/**
 * The REAL liveness probe: `lsof -a +D <path>` under a hard bound, returning a THREE-state
 * verdict. THE CONTRACT THIS FUNCTION EXISTS FOR (audio-feed-qdm95): only a clean, in-bound
 * lsof answer may resolve to "open" or "clear" — every inconclusive outcome (killed at the
 * bound, missing binary, spawn refused, odd exit code) resolves to "unknown", and the caller
 * FAILS CLOSED: an unknown candidate is skipped and counted, never deleted. The previous
 * version returned `status.success` and therefore read a timed-out lsof as "clear", deleting
 * live candidates on exactly the busy host the bound was meant to survive.
 */
export async function lsofPathLiveness(
  path: string,
  timeoutMs = 10_000,
): Promise<"open" | "clear" | "unknown"> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("lsof", {
      args: ["-a", "+D", path, "-Fn"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    // Missing binary or spawn refused: liveness cannot be established. Fail closed.
    return "unknown";
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, timeoutMs);
  let output: { code: number; signal: string | null; stdout: Uint8Array; stderr: Uint8Array };
  try {
    output = await child.output();
  } catch {
    clearTimeout(timer);
    return "unknown";
  }
  clearTimeout(timer);
  if (output.signal) return "unknown"; // killed by our own bound: no verdict exists
  if (output.code === 0) return "open"; // files found — never reaches a deletion decision
  // THE ONLY TRUSTED "none found" SHAPE (audio-feed-nz9dr): exit 1 with NOTHING on either
  // stream. lsof exits 1 BOTH for "no open files" AND for "errors occurred" — a subtree it
  // could not inspect (permission warning) also exits 1, and the earlier version read that
  // as clear and deleted. Only a silent, clean exit proves the tree was fully walked.
  if (output.code === 1 && output.stdout.length === 0 && output.stderr.length === 0) {
    return "clear";
  }
  return "unknown";
}

export async function cleanupTestTemp(options: CleanupOptions): Promise<CleanupCounts> {
  const {
    tempRoot,
    maxAgeMs,
    yes,
    processCmdlines = liveCmdlines,
    pathLiveness = (path) => lsofPathLiveness(path, options.lsofTimeoutMs ?? 10_000),
    now = Date.now(),
    log = (line) => console.log(line),
  } = options;

  const counts: CleanupCounts = {
    candidatesSeen: 0,
    skippedLive: 0,
    skippedUnknown: 0,
    skippedAge: 0,
    skippedOtherOwner: 0,
    removed: 0,
    bytesReclaimed: 0,
    removalFailures: 0,
    rootReadable: true,
  };

  const cmdlines = processCmdlines();
  // The current user's uid, probed ONCE and FAIL-SOFT: without --allow-sys, Deno.uid() throws,
  // and ownership becomes "unknown" — the sweep then proceeds and lets the removal attempt
  // decide. A silent all-skip here would make the whole script a well-formatted no-op.
  let myUid: number | null = null;
  try {
    myUid = Deno.uid();
  } catch {
    log("cleanup-test-temp: uid unavailable (no --allow-sys); ownership check disabled");
  }
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(tempRoot)];
  } catch (error) {
    log(`cleanup-test-temp: cannot read temp root ${tempRoot}: ${error}`);
    counts.rootReadable = false;
    return counts;
  }

  for (const entry of entries) {
    if (!isInScope(entry.name, entry.isDirectory)) continue;
    counts.candidatesSeen++;
    const path = `${tempRoot}/${entry.name}`;

    let owned = true;
    try {
      const stat = Deno.statSync(path);
      const ageMs = now - (stat.mtime?.getTime() ?? now);
      if (ageMs < maxAgeMs) {
        counts.skippedAge++;
        continue;
      }
      // Unix ownership: compare the entry's uid with the probed current user. If the
      // filesystem does not report uid (or the probe was unavailable), treat as owned and let
      // the removal attempt decide — a permission failure is counted, not fatal.
      const uid = (stat as { uid?: number }).uid;
      if (typeof uid === "number" && myUid !== null && myUid !== uid) {
        owned = false;
      }
      if (!owned) {
        counts.skippedOtherOwner++;
        continue;
      }
    } catch (error) {
      // Vanished between readdir and stat: someone else reclaimed it. Reported, never silent,
      // and never fatal (audio-feed-flr6y: a silent skip here made the whole sweep a no-op).
      log(`skipped ${path}: stat failed: ${error}`);
      continue;
    }

    const referenced = cmdlines.some((l) => l.includes(path));
    const liveness = referenced ? "open" : await pathLiveness(path);
    if (liveness === "open") {
      counts.skippedLive++;
      continue;
    }
    if (liveness === "unknown") {
      // FAIL CLOSED (audio-feed-qdm95): liveness could not be proven, so this candidate is
      // NOT deleted. Loud, counted, and reflected in the exit code (see EXIT CONTRACT).
      counts.skippedUnknown++;
      log(
        `skipped-unknown ${path}: liveness could not be proven (lsof inconclusive); NOT deleted — re-run when the host is quiet`,
      );
      continue;
    }

    let bytes = 0;
    try {
      bytes = dirSize(path);
    } catch {
      bytes = 0;
    }

    if (!yes) {
      log(`would remove ${path} (${bytes} bytes)`);
      continue;
    }
    try {
      await Deno.remove(path, { recursive: true });
      counts.removed++;
      counts.bytesReclaimed += bytes;
      log(`removed ${path} (${bytes} bytes)`);
    } catch (error) {
      // REAL ERROR (audio-feed-nz9dr): a removal that fails must never read as success —
      // the exit contract's "every candidate's fate is proven" would be a lie. Named in the
      // log, counted, and exit 1 via exitCodeFor. (A benign race with a creator would ALSO
      // land here; the sweep is scoped to hour-old entries, so re-running later is correct
      // and cheap — loud beats silent either way.)
      counts.removalFailures++;
      log(`removal FAILED ${path}: ${error}`);
    }
  }

  log(
    `cleanup-test-temp (${tempRoot}): candidates ${counts.candidatesSeen}, ` +
      `skipped-live ${counts.skippedLive}, skipped-unknown ${counts.skippedUnknown}, ` +
      `skipped-age ${counts.skippedAge}, skipped-other-owner ${counts.skippedOtherOwner}, ` +
      `removed ${counts.removed}, removal-failures ${counts.removalFailures}, ` +
      `reclaimed ${counts.bytesReclaimed} bytes${yes ? "" : " (DRY RUN)"}`,
  );
  return counts;
}

/** Byte size of a file or a directory tree; failures count as zero rather than blocking the sweep. */
function dirSize(path: string): number {
  const stat = Deno.statSync(path);
  if (!stat.isDirectory) return stat.size ?? 0;
  let total = 0;
  for (const entry of Deno.readDirSync(path)) {
    try {
      total += dirSize(`${path}/${entry.name}`);
    } catch {
      // A file vanishing mid-walk shrinks the estimate, never the safety.
    }
  }
  return total;
}

function isYesFlag(args: string[]): boolean {
  return args.includes("--yes");
}

export interface CliOptions {
  tempRoot: string;
  maxAgeMinutes: number;
  yes: boolean;
}

/** Parses and VALIDATES the CLI: a non-positive --max-age-minutes would disable the age bound
 * entirely (a typo silencing a real guard), so it is a real error, not a default. */
export function parseCliOptions(
  args: string[],
  readEnv: (name: string) => string | undefined = (n) => Deno.env.get(n),
): { options: CliOptions } | { error: string } {
  const rootFlagIndex = args.indexOf("--temp-root");
  let tempRoot: string | undefined = rootFlagIndex !== -1 ? args[rootFlagIndex + 1] : undefined;
  if (tempRoot === undefined) {
    try {
      tempRoot = readEnv("TMPDIR")?.trim() || "/tmp";
    } catch {
      tempRoot = "/tmp";
    }
  }
  const maxAgeIndex = args.indexOf("--max-age-minutes");
  let maxAgeMinutes = 60;
  if (maxAgeIndex !== -1) {
    const raw = Number(args[maxAgeIndex + 1]);
    if (!Number.isFinite(raw) || raw <= 0) {
      return {
        error: `--max-age-minutes must be a positive number of minutes (got ${
          args[maxAgeIndex + 1] ?? "nothing"
        }); a zero or negative bound would disable the age guard entirely.`,
      };
    }
    maxAgeMinutes = raw;
  }
  return { options: { tempRoot, maxAgeMinutes, yes: isYesFlag(args) } };
}

/** THE EXIT CONTRACT (see the header): 1 = real error, 3 = completed with unproven liveness,
 * 0 = every candidate's fate proven. A failed removal is a REAL error: the tool's job is
 * removal, so a silent non-deletion must not look like success (audio-feed-nz9dr). */
export function exitCodeFor(counts: CleanupCounts): number {
  if (!counts.rootReadable) return 1;
  if (counts.removalFailures > 0) return 1;
  return counts.skippedUnknown > 0 ? 3 : 0;
}

if (import.meta.main) {
  const parsed = parseCliOptions(Deno.args);
  if ("error" in parsed) {
    console.error(`cleanup-test-temp: ${parsed.error}`);
    Deno.exit(1);
  }
  const counts = await cleanupTestTemp({
    tempRoot: parsed.options.tempRoot,
    maxAgeMs: parsed.options.maxAgeMinutes * 60_000,
    yes: parsed.options.yes,
  });
  Deno.exit(exitCodeFor(counts));
}
