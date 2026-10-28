/**
 * Shared test & proof harness utilities (audio-feed-9se, audio-feed-kv91).
 *
 * Solves:
 * 1. Port conflicts: binds port 0 and reads back the assigned ephemeral port.
 * 2. Profile collisions: allocates unique isolated Chrome user-data-dir via Deno.makeTempDir.
 * 3. Harness visibility: captures and retains harness stdout & stderr.
 * 4. Premature exit detection: monitors harness process status during health check loop
 *    and fails fast if the child process dies or /health never answers.
 * 5. Chrome discovery: single canonical `newestChrome()` resolver across all proofs.
 *
 * Note on `scripts/*-browser-proof.ts`:
 * Browser-proof scripts are manual-only, on-demand verification harnesses designed
 * to drive headless Chrome over CDP to satisfy the Functional Verification Mandate
 * (AGENTS.md) when changing UI, shell, or auth surfaces. They are not run by the
 * automated CI gate (`deno task gate`), which only executes `tests/*_test.ts`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  hasGeneratedRegion,
  mergeGeneratedRegion,
  readEvidenceReadmeIfExists,
} from "./evidence-readme.ts";

export interface SupervisedHarness {
  port: number;
  base: string;
  process: Deno.ChildProcess;
  getLogs: () => { stdout: string; stderr: string };
  kill: () => void;
}

/**
 * HOW LONG AN ABANDONED PROFILE MAY SIT BEFORE A LATER RUN RECLAIMS IT (audio-feed-u8nv; the "same
 * prefix" qualifier went with the name rule, audio-feed-h62q).
 *
 * THE MEASUREMENT THAT MAKES THIS A DEFECT RATHER THAN TIDINESS, taken on this VM: `/tmp` held
 * **1926 `audiofeed-*` profile directories totalling 1.5 GB**, the oldest two days old. A leaked
 * profile is not only disk: it is 50-150 MB that a gate then cannot write into, and the failure it
 * produces appears in a tool nowhere near the cause.
 *
 * AND THE MECHANISM IS NOT A MISSING `finally`. Measured through the tool's own entry point: a
 * browser test on the SUCCESS path left ZERO new directories, both `finally` blocks guard
 * `chrome.kill()` and then run `await cleanup()`, and there were ZERO orphaned Chrome processes - the
 * wrapper and the reaper own the process layer correctly. THE LEAK IS THAT A KILLED RUN EXECUTES NO
 * `finally` AT ALL, so the directory outlives the process that would have removed it, and nothing
 * sweeps what is left behind.
 *
 * REAPER INTERACTION AND HEURISTIC AGE BOUND (audio-feed-hu1s, audio-feed-gy3x):
 * The default reaper rule on fleet VMs is "browsers older than 45 min (orphaned ones after 5)"
 * (reaper.mjs:54 BROWSER_MIN = 45), polled on a 2-minute timer (fleet-reaper.timer OnUnitActiveSec=2min).
 * However, the reaper explicitly spares any browser operating inside its own declared command timeout
 * (reaper.mjs:224; pinned and tested in ~/fleet/tests/reaper.test.sh:155-173, test 10). A long-running command
 * (e.g. `timeout 3600` or `fleet-heavy`) yields boundMin = 62 min, sparing its browser past 45 or 50 minutes.
 *
 * Therefore, NO age threshold derived from BROWSER_MIN is guaranteed safe against live browsers. Because
 * Deno.remove(recursive) succeeds on directories held open by active processes on Linux, this sweep CAN
 * remove a profile that a live browser is still actively using if that browser runs past the age bound.
 *
 * STALE_PROFILE_AGE_MS is set to 50 minutes as an empirical heuristic (45m default threshold + 2m timer poll
 * + 3m margin). This trade-off is accepted for this test helper because:
 *   1. Chrome profiles allocated here are disposable scratch directories for automated headless proof tests,
 *      not durable sessions or persistent user data.
 *   2. Legitimate proof tests finish in seconds or minutes; only pathological or unusually long-timeout runs
 *      exceed 50 minutes.
 *   3. The worst-case consequence is a broken in-flight test in an already-abnormal run, rather than data loss,
 *      which is preferable to allowing unbounded accumulation of orphaned /tmp profiles across VM runs.
 */
export const STALE_PROFILE_AGE_MS = 50 * 60 * 1000;

/**
 * Activity-based mtime/touch window for live Chrome profiles (audio-feed-upby).
 *
 * A live browser running under a long command timeout (e.g. `timeout 3600`, `boundMin = 62 min`,
 * audio-feed-gy3x) can legitimately outlive `STALE_PROFILE_AGE_MS` (50 min), and `/proc/<pid>`
 * inspection is denied in the `deno test` sandbox without `--allow-all` (audio-feed-gw4k).
 * Checking internal profile file activity (`Default/` files, lock/database entries, or the
 * periodic heartbeat file touched while `createTempChromeProfile` is live) provides a sandbox-safe
 * liveness guard: if any file inside the profile was modified within `PROFILE_ACTIVITY_AGE_MS`
 * (20 minutes), the sweep spares the profile even when its top-level directory creation mtime
 * exceeds `STALE_PROFILE_AGE_MS`.
 */
export const PROFILE_ACTIVITY_AGE_MS = 20 * 60 * 1000;
export const PROFILE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const PROFILE_ACTIVITY_MARKER = "profile-activity";

/**
 * Root marker file for disposable mutation-testing scratch directories (audio-feed-6pay).
 *
 * Writing `MUTANT-MARKER` at the scratch root (rather than injecting `// MUTANT` comments into
 * tracked files like `scripts/proof-helper.ts` and leaving `/tmp/mut*` copies behind) lets
 * start-of-run sweeps distinguish mutation scratch from live lane worktrees and reclaim abandoned
 * scratch directories deterministically.
 */
export const MUTANT_MARKER_FILE = "MUTANT-MARKER";

/**
 * Canonical display origin and feed token for deterministic `/account` browser captures
 * (audio-feed-te4l, audio-feed-3cvy, audio-feed-ifgw).
 */
export const CANONICAL_PROOF_ORIGIN = "http://localhost:8133";
export const CANONICAL_QZ3X_FEED_TOKEN = "qz3x-pinned-feed-token";

/**
 * Reclaim abandoned profile directories WHATEVER THEY ARE CALLED (audio-feed-u8nv, widened by
 * audio-feed-h62q).
 *
 * TWO GUARDS, AND BOTH ARE ASSERTED IN tests/proof_helper_profile_sweep_test.ts BECAUSE EACH IS A
 * DIFFERENT WAY OF DESTROYING SOMETHING THAT IS IN USE:
 *   - PROFILE SIGNATURE: `Default/` is inside, and `.git` is not. The signature is what a profile IS;
 *     the name was only ever a guess at who made it.
 *   - AGE BOUND: a young directory may be a LIVE run's, so it is left alone. The reclaim removes
 *     directories exceeding the heuristic age bound.
 *
 * WHY THE NAME RULE IS GONE, BECAUSE THIS IS THE PART THAT LOOKS LIKE A REGRESSION AND IS NOT: a
 * prefix matches only the callers that exist now. Every directory created by a path that does not go
 * through `createTempChromeProfile` - a new proof with its own prefix, a one-off script, a renamed
 * one - is unreclaimable FOREVER, because no future sweep will ever ask for its name. MEASURED on this
 * VM before this change: 82 directories under `/tmp` carry the profile signature and are >=45 minutes
 * stale; 66 are reachable by some caller's prefix and **16 are not**, among them six `i9hq-*-prof` at
 * ~1027 minutes, `regen-prof`, `l6tl-mutant-prof`, and five `audiofeed-txcz-*` / `audiofeed-vt-`
 * `proof-*` directories created minutes past the bound. Those 16 are the defect: permanent precisely
 * because nothing can name them.
 *
 * AND WHY THE SIGNATURE IS SAFER THAN THE NAME IT REPLACES, measured rather than asserted:
 * `audio-feed-u8nv` found `Default/` present in 20 of 20 profiles and 0 of 22 non-profiles, and the
 * live pile re-measures the same way - of 9408 directories >=45 minutes stale, 82 carry it and 9326 do
 * NOT. Those 9326 are the blast radius: **a rule that matched on age alone would delete every
 * worktree and scratch directory on the VM, 24 of the newest 22 entries under `af-*`/`audio-feed-*`
 * being exactly that** - and a by-age sweep in fact did delete other lanes' worktrees earlier that
 * night, sparing a gate's only because it was too young to match. `.git` is tested by EXISTENCE, not
 * by `isDirectory`, because in a LINKED WORKTREE it is a FILE.
 *
 * THIS RETIRES audio-feed-3nit's OWNERSHIP GUARD RATHER THAN TUNING IT, and the difference matters:
 * `isOwnProfileName` existed because `startsWith(prefix)` cannot tell `audiofeed-chrome-` from
 * `audiofeed-chrome-test-`, so a name comparison was answering the wrong question ("who made this?")
 * with too little information to be safe. The invariant it protected is kept and restated in the
 * tests: a reclaim may remove an ABANDONED PROFILE and nothing else - never a checkout, never a plain
 * directory, whatever its name. The two 3nit tests are replaced by that statement, not deleted.
 *
 * THIS RULE SHIPPED ONCE BEFORE AND WAS REVERTED (397b9ae, reverted by 3612977) - not because of the
 * signature, which was measured then as it is now, but because the pile measurement that motivated it
 * (`/tmp/audio-feed-*`, `/tmp/af-*`) turned out to be plain files and other lanes' WORKTREES, and the
 * retraction was right. What is different today is the evidence for the target: 16 signature-carrying,
 * permanently unreachable profiles, named above, that no prefix rule can ever reclaim.
 *
 * OPPORTUNISTIC BY CONSTRUCTION: every failure to read or remove is swallowed, because reclaiming
 * disk must never break allocating a profile. Returns what it actually removed so a caller, or a
 * test, can observe the work rather than trust it.
 */

/** Chrome's own marker that a directory holds an initialised profile. */
const PROFILE_MARKER = "Default";

/** A checkout is never a profile. Tested by EXISTENCE: in a linked worktree this is a FILE. */
const CHECKOUT_MARKER = ".git";

/** Existence without throwing. */
function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `dir` is an abandoned-profile CANDIDATE by shape: Chrome's marker inside, no checkout
 * inside. EXPORTED so a census or a dry run can ask the sweep's OWN question rather than re-deriving
 * it - a count of what a reclaim would remove is only a measurement of this rule if it shares this
 * predicate, and `deno eval` reproductions of a predicate drift from it (audio-feed-h62q).
 *
 * TWO DETAILS HERE THAT LOOK LIKE STYLE AND ARE NOT, because each one in its "obvious" form deletes
 * something in use:
 *   - `exists` on the PROFILE marker rather than `isDirectory`: the marker's nature is Chrome's
 *     business, and its presence is evidence a profile was initialised whatever it is.
 *   - `exists` on `.git` RATHER THAN `isDirectory`, and this is the lethal one: **in a LINKED WORKTREE
 *     `.git` IS A REGULAR FILE containing `gitdir: ...`, NOT A DIRECTORY.** A directory test would
 *     report "no checkout" for every linked worktree in this fleet, so a stale worktree that also
 *     held a `Default/` would satisfy the whole conjunction and be DELETED - which is the class of
 *     destruction the name rule's removal was meant to avoid, reintroduced by one character. The
 *     suite's `CHECKOUT_MARKER as a file` row has a red case for it (audio-feed-h62q).
 */
export function isAbandonedProfile(dir: string): boolean {
  if (!exists(dir)) return false;
  if (exists(`${dir}/${CHECKOUT_MARKER}`)) return false;
  return exists(`${dir}/${PROFILE_MARKER}`);
}

/**
 * Latest mtime (in epoch ms) among regular files or symlinks inside a Chrome profile directory
 * up to depth 3 (audio-feed-upby).
 *
 * Inspects non-directory entries (`Default/Preferences`, `Default/LOCK`, `Default/databases/...`,
 * `DevToolsActivePort`, `Default/profile-activity`, etc.) without reading `/proc/<pid>`, so it is
 * compatible with `deno test`'s restricted sandbox permissions (audio-feed-gw4k). Empty directory
 * inodes (such as a bare `Default/` directory in a synthetic test fixture) are not counted as file
 * activity, so aging the root directory in unit fixtures still behaves deterministically.
 */
export async function latestProfileActivityMs(profileDir: string): Promise<number | null> {
  let latest: number | null = null;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: profileDir, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(current.dir);
    } catch {
      continue;
    }
    try {
      for await (const entry of entries) {
        const childPath = join(current.dir, entry.name);
        if (entry.isDirectory) {
          if (current.depth < 2) {
            queue.push({ dir: childPath, depth: current.depth + 1 });
          }
          continue;
        }
        try {
          const info = await Deno.lstat(childPath);
          const mtime = info.mtime?.getTime();
          if (mtime !== undefined && (latest === null || mtime > latest)) {
            latest = mtime;
          }
        } catch {
          // Ignore disappearing transient lock/journal files
        }
      }
    } catch {
      // Ignore concurrent directory removal
    }
  }
  return latest;
}

/**
 * Touch the internal profile activity marker so an idle live browser operating under a long
 * command timeout refreshes its activity mtime and is spared by `sweepStaleProfiles` (audio-feed-upby).
 */
export async function touchProfileActivity(
  profileDir: string,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const defaultDir = join(profileDir, PROFILE_MARKER);
    await originalMkdir(defaultDir, { recursive: true });
    const markerPath = join(defaultDir, PROFILE_ACTIVITY_MARKER);
    await originalWriteTextFile(markerPath, `${nowMs}\n`);
    const when = new Date(nowMs);
    await Deno.utime(markerPath, when, when);
  } catch {
    // Best-effort heartbeat; never disrupt the caller if the profile is being torn down.
  }
}

export async function sweepStaleProfiles(
  nowMs: number = Date.now(),
  ageMs: number = STALE_PROFILE_AGE_MS,
  activityAgeMs: number = PROFILE_ACTIVITY_AGE_MS,
  // WHICH DIRECTORY TO SWEEP IS A PARAMETER, not process state (audio-feed-oyf3g). It defaults to the SAME
  // base directory makeTempDir uses, so production behaviour is unchanged; a caller that wants to sweep a
  // sandbox passes it explicitly instead of mutating the process-global TMPDIR, which under
  // `deno test --parallel` captured and then deleted OTHER concurrent modules' live temp dirs.
  rootDir: string = Deno.env.get("TMPDIR") ?? "/tmp",
): Promise<string[]> {
  const swept: string[] = [];
  const baseDir = rootDir;
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(baseDir);
  } catch {
    return swept;
  }
  const effectiveActivityWindow = Math.min(ageMs, activityAgeMs);
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const full = `${baseDir}/${entry.name}`;
    if (activeChromeProfiles.has(normalizeFilePath(full))) continue;
    if (!isAbandonedProfile(full)) continue;
    try {
      const info = await Deno.stat(full);
      const age = nowMs - (info.mtime?.getTime() ?? nowMs);
      if (age < ageMs) continue;
      // audio-feed-upby: before removing a profile whose root mtime exceeds ageMs, check internal
      // profile file activity so a live browser that has written (or been touched) within the
      // activity window is spared without needing /proc inspection.
      const latestActivity = await latestProfileActivityMs(full);
      if (latestActivity !== null && nowMs - latestActivity < effectiveActivityWindow) {
        continue;
      }
      await originalRemove(full, { recursive: true });
      swept.push(full);
    } catch {
      // Concurrent reclaim or filesystem permission error: leave it, never throw.
    }
  }
  return swept;
}

/**
 * Whether `dir` is a disposable mutation-testing scratch directory (audio-feed-6pay).
 *
 * Matches either:
 * 1. Any directory carrying `MUTANT-MARKER` at its root (the canonical marker convention that
 *    avoids writing `// MUTANT` comments into tracked source files), or
 * 2. A directory under `TMPDIR` named `mut*-M*`, `mut-*`, `mut_*`, or `mut<digits>*` from ad-hoc
 *    mutation loops (covering both `git worktree add` linked worktrees where `.git` is a file and
 *    plain `cp` checkout copies that have `scripts/proof-helper.ts` or `src/`).
 *
 * Never matches a normal non-`mut*` checkout unless it explicitly carries `MUTANT-MARKER`.
 */
export function isMutationScratchDir(dir: string): boolean {
  if (!exists(dir)) return false;
  if (exists(join(dir, MUTANT_MARKER_FILE))) return true;
  const name = basename(dir);
  if (!/^mut(?:[-_].*|\d+.*)$/.test(name)) return false;
  return exists(join(dir, CHECKOUT_MARKER)) || exists(join(dir, "scripts")) ||
    exists(join(dir, "src"));
}

/**
 * Sweep abandoned mutation-testing scratch directories under `TMPDIR` by path/marker and age,
 * reporting `unreadable` entries separately from clean/skipped ones (audio-feed-6pay).
 */
export async function sweepStaleMutationScratch(
  nowMs: number = Date.now(),
  ageMs: number = STALE_PROFILE_AGE_MS,
  activityAgeMs: number = PROFILE_ACTIVITY_AGE_MS,
  // See sweepStaleProfiles: the swept root is a parameter rather than the process-global TMPDIR
  // (audio-feed-oyf3g), defaulting to the base makeTempDir uses so production behaviour is unchanged.
  rootDir: string = Deno.env.get("TMPDIR") ?? "/tmp",
): Promise<{ swept: string[]; unreadable: string[] }> {
  const swept: string[] = [];
  const unreadable: string[] = [];
  const baseDir = rootDir;
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(baseDir);
  } catch {
    unreadable.push(baseDir);
    return { swept, unreadable };
  }
  const effectiveActivityWindow = Math.min(ageMs, activityAgeMs);
  for (const entry of entries) {
    const full = `${baseDir}/${entry.name}`;
    try {
      const info = await Deno.lstat(full);
      if (!info.isDirectory) continue;
      // Verify the directory itself is readable so unreadable scratch dirs are reported explicitly
      // rather than silently treated as clean (audio-feed-6pay point 3).
      try {
        for await (const _ of Deno.readDir(full)) {
          break;
        }
      } catch {
        unreadable.push(full);
        continue;
      }
      if (!isMutationScratchDir(full)) continue;
      const age = nowMs - (info.mtime?.getTime() ?? nowMs);
      if (age < ageMs) continue;
      const latestActivity = await latestProfileActivityMs(full);
      if (latestActivity !== null && nowMs - latestActivity < effectiveActivityWindow) {
        continue;
      }
      await originalRemove(full, { recursive: true });
      swept.push(full);
    } catch {
      unreadable.push(full);
    }
  }
  return { swept, unreadable };
}

/**
 * Run a mutation experiment inside a self-cleaning scratch directory marked with `MUTANT-MARKER`
 * at its root, removing the directory on normal exit AND on `SIGINT`/`SIGTERM` (audio-feed-6pay).
 */
export async function withMutationScratch<T>(
  label: string,
  body: (scratchDir: string) => Promise<T> | T,
  // The root this run sweeps and allocates in; an explicit root keeps a caller (a test) from mutating the
  // process-global TMPDIR to contain the scratch (audio-feed-oyf3g).
  rootDir: string = Deno.env.get("TMPDIR") ?? "/tmp",
): Promise<T> {
  await sweepStaleMutationScratch(
    Date.now(),
    STALE_PROFILE_AGE_MS,
    PROFILE_ACTIVITY_AGE_MS,
    rootDir,
  );
  const safeLabel = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  const scratchDir = await Deno.makeTempDir({ prefix: `mut-${safeLabel}-`, dir: rootDir });
  const markerPath = join(scratchDir, MUTANT_MARKER_FILE);
  await originalWriteTextFile(
    markerPath,
    JSON.stringify({ label, createdAt: new Date().toISOString(), pid: Deno.pid }) + "\n",
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      originalRemoveSync(scratchDir, { recursive: true });
    } catch {
      // Ignore if already removed
    }
  };
  const onSigInt = () => {
    cleanup();
  };
  const onSigTerm = () => {
    cleanup();
  };
  try {
    Deno.addSignalListener("SIGINT", onSigInt);
    Deno.addSignalListener("SIGTERM", onSigTerm);
  } catch {
    // Signal listeners may be unsupported on some platforms/permissions
  }
  try {
    return await body(scratchDir);
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", onSigInt);
      Deno.removeSignalListener("SIGTERM", onSigTerm);
    } catch {
      // Ignore
    }
    if (!cleaned) {
      cleaned = true;
      await originalRemove(scratchDir, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * Pin the varying `/account` render inputs in `verify_qz3x_confirm_dismiss_browser.ts`
 * (`publicBaseUrl` and `user.feedToken`) so two fresh captures of `01-second-dialog-open.png`
 * render identical background text behind the modal backdrop (audio-feed-te4l).
 */
export function pinQz3xCaptureDeterminism(
  source: string,
  options: {
    origin?: string;
    feedToken?: string;
    disableQuantiser?: boolean;
    outDir?: string;
  } = {},
): string {
  const origin = options.origin ?? CANONICAL_PROOF_ORIGIN;
  const feedToken = options.feedToken ?? CANONICAL_QZ3X_FEED_TOKEN;
  let result = source.replace(
    'const config: AppConfig = { port: 0, adminToken: "harness-admin" };',
    `const config: AppConfig = { port: 0, adminToken: "harness-admin", publicBaseUrl: ${
      JSON.stringify(origin)
    } };`,
  ).replace(
    'const user = await approveUser(stores.metadata, rawUser.id, "qz3x@example.com/feed");',
    `const approved = await approveUser(stores.metadata, rawUser.id, "qz3x@example.com/feed");\n` +
      `  const user = { ...approved, feedToken: ${JSON.stringify(feedToken)} };\n` +
      `  await stores.metadata.putUser(user);`,
  );
  if (options.disableQuantiser) {
    result = result.replace(
      'import { quantiseEvidencePng } from "./evidence-png.ts";',
      "const quantiseEvidencePng = async (_path: string, _options?: unknown): Promise<void> => {};",
    );
  }
  if (options.outDir !== undefined) {
    result = result.replace(
      'const OUT = new URL("../docs/evidence/audio-feed-qz3x/", import.meta.url).pathname;',
      `const OUT = ${JSON.stringify(options.outDir)};`,
    );
  }
  return result;
}

export async function createTempChromeProfile(
  prefix = "audiofeed-chrome-",
  // WHICH ROOT THE PROFILE IS ALLOCATED IN - AND SWEPT FROM - IS A PARAMETER (audio-feed-oyf3g), not process
  // state. A caller that wants a sandbox passes it here instead of mutating the process-global TMPDIR, which
  // under `deno test --parallel` captures every other concurrent module's temp dirs into that sandbox and then
  // deletes them with it. Omitting it keeps the previous behaviour EXACTLY: the sweep resolves TMPDIR itself,
  // and `Deno.makeTempDir({ prefix })` uses the platform temp dir.
  rootDir?: string,
): Promise<{ profileDir: string; cleanup: () => Promise<void>; sweptStale: number }> {
  // Reclaim abandoned profiles before allocating another one, so a leak cannot accumulate across runs
  // (audio-feed-u8nv). NOT scoped to `prefix` (audio-feed-h62q): a directory whose creator never runs
  // again cannot be named by anyone, which is how the unreachable population got permanent.
  const sweptStale = (await (rootDir === undefined ? sweepStaleProfiles() : sweepStaleProfiles(
    Date.now(),
    STALE_PROFILE_AGE_MS,
    PROFILE_ACTIVITY_AGE_MS,
    rootDir,
  ))).length;
  const profileDir = rootDir === undefined
    ? await Deno.makeTempDir({ prefix })
    : await Deno.makeTempDir({ prefix, dir: rootDir });
  const normProfileDir = normalizeFilePath(profileDir);
  activeChromeProfiles.add(normProfileDir);
  let cleaned = false;

  // audio-feed-upby: periodically refresh the internal profile activity marker while the profile
  // handle is open, so an idle live browser operating under a long timeout (e.g. boundMin = 62 min)
  // keeps a fresh internal file mtime (< PROFILE_ACTIVITY_AGE_MS) until cleanup() runs.
  const heartbeatTimer = setInterval(() => {
    if (!cleaned) {
      void touchProfileActivity(profileDir);
    }
  }, PROFILE_HEARTBEAT_INTERVAL_MS);
  try {
    Deno.unrefTimer(heartbeatTimer);
  } catch {
    // Ignore if timer unref is unavailable
  }

  return {
    profileDir,
    sweptStale,
    cleanup: async () => {
      clearInterval(heartbeatTimer);
      activeChromeProfiles.delete(normProfileDir);
      if (cleaned) return;
      const maxAttempts = 10;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await originalRemove(profileDir, { recursive: true });
          cleaned = true;
          return;
        } catch (err) {
          if (
            err instanceof Deno.errors.NotFound ||
            (err as Error)?.message?.includes("No such file or directory")
          ) {
            cleaned = true;
            return;
          }

          lastError = err;
          const msg = (err as Error)?.message ?? "";
          const code = (err as { code?: string })?.code;
          const isRetryable = err instanceof Deno.errors.Busy ||
            code === "ENOTEMPTY" ||
            code === "EBUSY" ||
            msg.includes("Directory not empty") ||
            msg.includes("os error 39") ||
            msg.includes("os error 16") ||
            msg.includes("Resource busy") ||
            msg.includes("EBUSY");

          if (!isRetryable || attempt === maxAttempts) {
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      throw new Error(
        `Failed to clean up temp Chrome profile '${profileDir}': ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    },
  };
}

/**
 * Where chrome configuration is read from.
 *
 * Injected so a test can assert the resolution rules WITHOUT mutating the process env (audio-feed-w5i0m).
 * `Deno.env.set("AUDIOFEED_CHROME_BIN"/"HOME")` under `deno test --parallel` is process-global: every
 * concurrently running module sees the value for the whole set/restore window, and a module that launches a
 * child inherits the mutated HOME/PATH. The default stays `Deno.env`, so production callers are unchanged.
 */
export interface EnvReader {
  get(key: string): string | undefined;
}

export function newestChrome(chromeCacheRoot?: string, env: EnvReader = Deno.env): string {
  if (!chromeCacheRoot) {
    const envBin = env.get("AUDIOFEED_CHROME_BIN");
    if (envBin && envBin.trim().length > 0) {
      return envBin.trim();
    }
  }
  // HOME stays a LITERAL `Deno.env.get("HOME")` on purpose. The fast gate's read-relation scanner classifies an
  // out-of-repo base by that exact expression (`isOutOfRepoRhs` in scripts/test-selection.ts); routing it
  // through the injected reader instead made `${home}/.cache/puppeteer/chrome` read as an unresolved IN-REPO
  // hint, which disabled the gate's inert class and answered 500 server_misconfigured-shaped noise on three
  // gate suites (audio-feed-w5i0m). A caller that needs a different root passes `chromeCacheRoot`, which is
  // this module's existing seam and the one the discovery test uses.
  const home = Deno.env.get("HOME") ?? "";
  const root = chromeCacheRoot ?? `${home}/.cache/puppeteer/chrome`;
  let dirs: string[] = [];
  try {
    dirs = [...Deno.readDirSync(root)]
      .filter((d) => d.isDirectory)
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    dirs = [];
  }
  if (dirs.length === 0) {
    throw new Error(`No Chrome binaries found under ${root}`);
  }
  return `${root}/${dirs.at(-1)}/chrome-linux64/chrome`;
}

export function resolveChromeBinary(
  override?: string,
  env: EnvReader = Deno.env,
  chromeCacheRoot?: string,
): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const envBin = env.get("AUDIOFEED_CHROME_BIN");
  if (envBin && envBin.trim().length > 0) {
    return envBin.trim();
  }
  return newestChrome(chromeCacheRoot, env);
}

export interface ChromeLaunchOptions {
  binary?: string;
  prefix?: string;
  args?: string[];
  portTimeoutMs?: number;
  /**
   * The root the profile is allocated in and swept from (audio-feed-oyf3g). A caller that wants a sandbox passes
   * it here instead of mutating the process-global TMPDIR, which under `deno test --parallel` captured other
   * concurrent modules' temp dirs into that sandbox and deleted them with it. Omitted, behaviour is unchanged:
   * createTempChromeProfile resolves TMPDIR itself and allocates in the platform temp dir.
   */
  profileRoot?: string;
  /**
   * Where the chrome binary is resolved from (audio-feed-w5i0m). Passed instead of mutating the
   * process-global `AUDIOFEED_CHROME_BIN`/`HOME`, which under `deno test --parallel` is visible to every
   * concurrently running module. Omitted, resolution is unchanged and reads `Deno.env`.
   */
  env?: EnvReader;
  /**
   * The Chrome cache root to discover under (audio-feed-w5i0m). Passed rather than mutating `HOME`, so a
   * test can assert "no Chrome binaries found under <root>" without redirecting path resolution for every
   * concurrently running module.
   */
  chromeCacheRoot?: string;
}

export interface ChromeHandle {
  port: number;
  profileDir: string;
  process: Deno.ChildProcess;
  close: () => Promise<void>;
}

export async function launchChrome(
  opts: ChromeLaunchOptions = {},
): Promise<ChromeHandle> {
  const binary = resolveChromeBinary(opts.binary, opts.env, opts.chromeCacheRoot);
  const prefix = opts.prefix ?? "audiofeed-chrome-";

  let profile: { profileDir: string; cleanup: () => Promise<void> } | null = null;
  let process: Deno.ChildProcess | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (closed) return;
      closed = true;
      if (process) {
        try {
          process.kill();
        } catch {
          // ignore
        }
        await process.status.catch(() => {});
      }
      if (profile) {
        await profile.cleanup();
      }
    })();
    return closePromise;
  };

  try {
    profile = await createTempChromeProfile(prefix, opts.profileRoot);
    const { profileDir } = profile;

    const defaultArgs = [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ];

    const args = opts.args ? [...opts.args] : defaultArgs;
    if (opts.args && !args.some((a) => a.startsWith("--user-data-dir="))) {
      args.push(`--user-data-dir=${profileDir}`);
    }

    const cmd = new Deno.Command(binary, {
      args,
      stdout: "null",
      stderr: "null",
    });
    process = cmd.spawn();

    let exited = false;
    let exitCode: number | null = null;
    process.status.then((st) => {
      exited = true;
      exitCode = st.code;
    }).catch(() => {});

    const portFile = `${profileDir}/DevToolsActivePort`;
    // audio-feed-d6g4c (measured, full-gate run 46f091ab on a loaded host): the old 10s
    // bound expired BEFORE Chrome wrote DevToolsActivePort - the proof died with a launch
    // timeout instead of the mutant contract the calling row asserts, which is how the
    // l7m1 row flaked ('Timed out after 10000ms waiting for DevToolsActivePort' at
    // proof-helper.ts:761). The bound is an observability GUARD on an external binary's
    // cold start, not a measurement and not a budget under test (the y2ex ruling shape:
    // headroom against a loaded box, loud failure if genuinely broken), so it carries 4x
    // headroom. The 50ms poll below is the observed-event wait; premature exit still
    // fails immediately with the exit code.
    const portTimeoutMs = opts.portTimeoutMs ?? 40_000;
    const startTime = Date.now();
    let port = 0;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    while (Date.now() - startTime < portTimeoutMs) {
      if (exited) {
        const content = await Deno.readTextFile(portFile).catch(() => "");
        const firstLine = content.split("\n")[0]?.trim();
        if (firstLine && /^\d+$/.test(firstLine)) {
          port = Number(firstLine);
          break;
        }
        throw new Error(
          `Chrome process '${binary}' exited prematurely with code ${
            exitCode ?? -1
          } before writing DevToolsActivePort in '${profileDir}'`,
        );
      }

      const content = await Deno.readTextFile(portFile).catch(() => "");
      const firstLine = content.split("\n")[0]?.trim();
      if (firstLine && /^\d+$/.test(firstLine)) {
        port = Number(firstLine);
        break;
      }

      await sleep(50);
    }

    if (!port) {
      throw new Error(
        `Timed out after ${portTimeoutMs}ms waiting for DevToolsActivePort in '${profileDir}'`,
      );
    }

    return {
      port,
      profileDir,
      process,
      close,
    };
  } catch (err) {
    try {
      await close();
    } catch (cleanupErr) {
      if (err instanceof Error && !err.cause) {
        err.cause = cleanupErr;
      }
    }
    throw err;
  }
}

export async function withChrome<T>(
  body: (chrome: ChromeHandle) => Promise<T> | T,
  opts: ChromeLaunchOptions = {},
): Promise<T> {
  const chrome = await launchChrome(opts);
  let bodyError: unknown = null;
  let result: T;
  try {
    result = await body(chrome);
  } catch (err) {
    bodyError = err;
  }

  let teardownError: unknown = null;
  try {
    await chrome.close();
  } catch (err) {
    teardownError = err;
  }

  if (bodyError && teardownError) {
    if (bodyError instanceof Error && !bodyError.cause) {
      bodyError.cause = teardownError;
    }
    throw bodyError;
  }

  if (bodyError) {
    throw bodyError;
  }

  if (teardownError) {
    throw teardownError;
  }

  return result!;
}

/**
 * Production fail-fast window for a harness child to bind and answer its
 * health check (audio-feed-57ape). Proof scripts rely on this for fast
 * feedback; tests pin it BY NAME rather than racing it, because one wall
 * window deciding both the happy path and fail-fast reads a healthy-but-slow
 * host as a broken harness (measured twice at exactly 15s under saturation).
 */
export const SPAWN_HARNESS_HEALTH_TIMEOUT_MS = 15_000;

/**
 * The harness STARTUP window is DERIVED, never fixed (audio-feed-3n0xs).
 *
 * Spawn -> READY is a Deno compile, so how long it takes is a property of the
 * host's CURRENT load, not of the child. Measured on this VM while fixing this:
 *
 *   baseline 503ms   account-harness.ts logged READY at  12.0s  (23.9x boot)
 *   baseline 899ms   account-harness.ts logged READY at  19.0s  (21.1x boot)
 *                    (the second sample is the same harness under eight busy loops)
 *
 * A fixed 15s window (audio-feed-62ozc's `SPAWN_HARNESS_STARTUP_TIMEOUT_MS`) sits
 * BELOW that second sample, so a loaded host reported a HEALTHY harness as "never
 * logged its READY line" and reddened whichever proof row happened to spawn it - a
 * row racing real time, the family of dv4p/5dxrk/hrfn/cls. Raising 15s is not a fix:
 * it moves the red to a slower host. The window is instead derived from a boot
 * baseline MEASURED ON THE SAME HOST at the same moment, so a load that stretches
 * the baseline by 1.8x stretches the window by 1.8x. The measured harness-to-boot
 * ratio (21-24x) sits inside 60x in BOTH samples, i.e. ~2.5x headroom at every load
 * level observed here.
 */
export const SPAWN_HARNESS_STARTUP_BOOT_MULTIPLE = 60;

/**
 * The startup window for a host that booted the baseline in `measuredBootMs`.
 *
 * Proportional BY CONSTRUCTION - `startupBackstopMs(2 * b) === 2 * startupBackstopMs(b)` -
 * so a host that is twice as slow gets twice the window. Pinned BY NAME by
 * "proof-helper: the harness startup window is derived from the measured boot
 * baseline, never a fixed 15s (audio-feed-3n0xs)" in tests/proof_helper_test.ts,
 * which reds if a constant is ever returned from here again.
 */
export function startupBackstopMs(measuredBootMs: number): number {
  return Math.round(measuredBootMs * SPAWN_HARNESS_STARTUP_BOOT_MULTIPLE);
}

/**
 * Source for the boot-baseline probe child: the SAME runtime with the SAME flags as
 * a harness child and no imports, so what it measures is this host's Deno BOOT cost
 * right now - the quantity the startup window is derived from.
 */
const BOOT_BASELINE_PROBE_SOURCE = `console.log("READY");\nDeno.exit(0);\n`;

/**
 * How long this host currently takes to boot a Deno child, in ms (audio-feed-3n0xs).
 *
 * Fed to the child over stdin (`deno run -`) rather than written to a scratch file,
 * so the measurement touches no path on disk and leaves nothing behind for a sweep to
 * reclaim, and so the fast gate's selection gains no file to read. Fails CLOSED: a
 * probe that cannot run throws, so a broken measurement can never silently become a
 * window.
 */
async function measureHarnessBootBaselineMs(cwd: string): Promise<number> {
  const startedAt = Date.now();
  const probe = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--unstable-kv", "-"],
    cwd,
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const writer = probe.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(BOOT_BASELINE_PROBE_SOURCE));
    await writer.close();
  } catch { /* the probe child died before reading its source: reported below */ }
  const output = await probe.output();
  const measured = Date.now() - startedAt;
  if (!output.success) {
    throw new Error(
      `the boot-baseline probe exited ${output.code}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  if (!Number.isFinite(measured) || measured <= 0) {
    throw new Error(`the boot-baseline probe measured ${measured}ms`);
  }
  return measured;
}

export async function spawnHarness(
  scriptRelPath: string,
  extraArgs: string[] = [],
  options: {
    healthPath?: string;
    timeoutMs?: number;
    /** Explicit STARTUP window; when set it REPLACES the derived window (deterministic fail-fast rows). */
    startupTimeoutMs?: number;
    /** A boot baseline measured elsewhere, injected so a row decides the window instead of the host. */
    bootBaselineMs?: number;
  } = {},
): Promise<SupervisedHarness> {
  const healthPath = options.healthPath ?? "/health";
  // The deadline is a BACKSTOP, never the pass condition: the wait below is on
  // the child's own bind/first-response state signal, so a healthy-but-slow
  // host passes whenever readiness actually arrives (audio-feed-57ape).
  // audio-feed-62ozc: `timeoutMs` bounds the HEALTH phase and its budget starts
  // at the OBSERVED bind event (the READY line), not at spawn - cold-start
  // compilation is the STARTUP phase, whose window is DERIVED from this host's
  // measured boot baseline instead of fixed (audio-feed-3n0xs).
  const timeoutMs = options.timeoutMs ?? SPAWN_HARNESS_HEALTH_TIMEOUT_MS;
  const cwd = new URL("..", import.meta.url).pathname;

  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--unstable-kv", scriptRelPath, "0", ...extraArgs],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });

  const process = cmd.spawn();
  let stdoutBuf = "";
  let stderrBuf = "";

  const textDecoder = new TextDecoder();

  // The readiness SIGNAL: resolved the moment the child's own READY line reaches
  // its stdout, so the startup wait is an EVENT - never a fixed sleep, and never a
  // fixed real-time window that a loaded host can spend on compilation.
  let assignedPort: number | null = null;
  let announceReady: (() => void) | null = null;
  const readyLine = new Promise<void>((resolve) => {
    announceReady = resolve;
  });
  const scanForReadyLine = () => {
    if (assignedPort !== null) return;
    const match = /READY port=(\d+)/.exec(stdoutBuf) ??
      /http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(stdoutBuf);
    if (match) {
      assignedPort = Number(match[1]);
      announceReady?.();
    }
  };

  // Pipe and accumulate stdout in background
  (async () => {
    try {
      for await (const chunk of process.stdout) {
        stdoutBuf += textDecoder.decode(chunk, { stream: true });
        scanForReadyLine();
      }
    } catch { /* stream closed */ }
  })();

  // Pipe and accumulate stderr in background
  (async () => {
    try {
      for await (const chunk of process.stderr) {
        stderrBuf += textDecoder.decode(chunk, { stream: true });
      }
    } catch { /* stream closed */ }
  })();

  let exited = false;
  let exitCode: number | null = null;
  let announceExit: (() => void) | null = null;
  const exitSignal = new Promise<void>((resolve) => {
    announceExit = resolve;
  });
  process.status.then((st) => {
    exited = true;
    exitCode = st.code;
    announceExit?.();
  }).catch(() => {
    exited = true;
    announceExit?.();
  });

  /**
   * Kill AND await: a killed-but-unawaited child leaks its process resource into the
   * caller's test sanitizer (audio-feed-ft1sj). Bounded so a child that ignores the
   * signal cannot hang the error path.
   */
  const killAndReap = async () => {
    try {
      process.kill();
    } catch { /* ignore */ }
    await Promise.race([
      process.status.catch(() => {}),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  };

  // The baseline probe is started CONCURRENTLY with the child, so on the pass path it
  // costs nothing: its measurement overlaps the compile it exists to size.
  const baselineProbe = options.startupTimeoutMs !== undefined ||
      options.bootBaselineMs !== undefined
    ? null
    : measureHarnessBootBaselineMs(cwd)
      .then((ms) => ({ ok: true as const, ms }))
      .catch((error: unknown) => ({ ok: false as const, error }));

  let startupMs: number;
  let startupDerived = false;
  if (options.startupTimeoutMs !== undefined) {
    startupMs = options.startupTimeoutMs;
  } else if (options.bootBaselineMs !== undefined) {
    startupMs = startupBackstopMs(options.bootBaselineMs);
    startupDerived = true;
  } else {
    const probe = await baselineProbe!;
    if (!probe.ok) {
      await killAndReap();
      throw new Error(
        `Harness '${scriptRelPath}': the boot-baseline probe failed (${
          probe.error instanceof Error ? probe.error.message : String(probe.error)
        }), so the startup window has no host measurement to derive from.\n` +
          `Stdout:\n${stdoutBuf}\nStderr:\n${stderrBuf}`,
      );
    }
    startupMs = startupBackstopMs(probe.ms);
    startupDerived = true;
  }

  // STARTUP: spawn -> READY. Whichever event happens first decides; the derived
  // window is only the backstop for a child that neither binds nor exits.
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const startupDeadline = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), startupMs);
    Deno.unrefTimer(timer);
    startupTimer = timer;
  });
  const startupOutcome = await Promise.race([
    readyLine.then(() => "ready" as const),
    exitSignal.then(() => "exited" as const),
    startupDeadline,
  ]);
  if (startupTimer !== undefined) clearTimeout(startupTimer);

  if (startupOutcome === "exited") {
    // Reap before throwing: the child is gone, but its status must settle before the
    // error leaves or the caller's sanitizer sees a live resource.
    await process.status.catch(() => {});
    throw new Error(
      `Harness '${scriptRelPath}' exited prematurely with code ${exitCode} before answering health check.\n` +
        `Stdout:\n${stdoutBuf}\nStderr:\n${stderrBuf}`,
    );
  }

  if (startupOutcome === "ready") {
    // HEALTH: bind -> first OK response. audio-feed-62ozc: the budget starts HERE, at
    // the observed bind, so whatever the host spent compiling is startup, not health.
    const healthStartedAt = Date.now();
    for (;;) {
      if (exited) {
        throw new Error(
          `Harness '${scriptRelPath}' exited prematurely with code ${exitCode} before answering health check.\n` +
            `Stdout:\n${stdoutBuf}\nStderr:\n${stderrBuf}`,
        );
      }

      const healthElapsed = Date.now() - healthStartedAt;
      if (healthElapsed >= timeoutMs) break; // health budget exhausted: named /health report below
      let res: Response | null = null;
      try {
        // Bound each probe by the REMAINING health budget: an accepted-but-
        // never-answered socket must not defeat the deadline (the mutation
        // fixture tests/fixtures/binds_never_answers_harness_child.ts proved
        // an unbounded fetch hangs the wait past its own timeout).
        const remaining = timeoutMs - healthElapsed;
        res = await fetch(`http://localhost:${assignedPort}${healthPath}`, {
          signal: AbortSignal.timeout(Math.max(remaining, 1)),
        });
      } catch {
        // Socket not open, not responding yet, or probe outlived the budget
      }

      if (res && res.ok) {
        // Note: A process dying immediately after answering health check is inherently racy;
        // if the status handler already settled, detect premature exit and fail fast.
        if (exited) {
          throw new Error(
            `Harness '${scriptRelPath}' exited with code ${exitCode} immediately after answering health check.\n` +
              `Stdout:\n${stdoutBuf}\nStderr:\n${stderrBuf}`,
          );
        }
        const port = assignedPort!;
        return {
          port,
          base: `http://localhost:${port}`,
          process,
          getLogs: () => ({ stdout: stdoutBuf, stderr: stderrBuf }),
          kill: () => {
            try {
              process.kill();
            } catch { /* ignore */ }
          },
        };
      }

      await new Promise((r) =>
        setTimeout(r, Math.max(Math.min(100, timeoutMs - healthElapsed), 1))
      );
    }
  }

  // One of the two budgets expired: the derived startup window (spawn -> READY) or
  // the health window (observed bind -> first OK answer).
  await killAndReap();
  // Name the condition that never became true, and the PHASE whose budget
  // expired: a report must not render an inability to know as a fact, and
  // "timed out" alone says nothing about whether the child never bound or
  // bound but never answered (audio-feed-57ape); a startup stall is likewise
  // not a /health answer, so each phase names its own window
  // (audio-feed-62ozc). The startup window names the DERIVED value it used, so a
  // report shows what this host was measured to need (audio-feed-3n0xs).
  const condition = assignedPort === null
    ? "the child never logged its READY line (no 'READY port=N' or server URL in stdout)"
    : `the child bound port ${assignedPort} but ${healthPath} never answered OK`;
  const phase = assignedPort === null
    ? `timed out after ${startupMs}ms waiting for the harness to log READY${
      startupDerived ? " (a window derived from the measured boot baseline)" : ""
    }`
    : `timed out after ${timeoutMs}ms waiting for ${healthPath}`;
  throw new Error(
    `Harness '${scriptRelPath}' ${phase}: ${condition}.\n` +
      `Assigned port: ${assignedPort}\nStdout:\n${stdoutBuf}\nStderr:\n${stderrBuf}`,
  );
}

export class CheckFailureError extends Error {
  readonly checkName: string;
  readonly detail?: string;

  constructor(checkName: string, detail?: string) {
    super(
      detail !== undefined
        ? `Check failed: ${checkName} (${detail})`
        : `Check failed: ${checkName}`,
    );
    this.name = "CheckFailureError";
    this.checkName = checkName;
    this.detail = detail;
  }
}

export interface CheckFailure {
  name: string;
  detail?: string;
}

export type CheckLogger = (line: string) => void;

export interface CheckerOptions {
  logger?: CheckLogger;
}

export interface RunProofOptions extends CheckerOptions {
  rollbackHook?: (
    phase: "start" | "end" | "lock-acquired",
    path?: string,
  ) => Promise<void> | void;
}

export interface Checker extends Disposable {
  check: (name: string, pass: boolean, detail?: string) => boolean;
  failures: CheckFailure[];
  finish: () => void;
  [Symbol.dispose](): void;
}

export function createChecker(options?: CheckerOptions | CheckLogger): Checker {
  const logger = typeof options === "function" ? options : options?.logger;
  return createCheckerInternal(false, logger);
}

function createCheckerInternal(deferred: boolean, logger?: CheckLogger): Checker {
  const failures: CheckFailure[] = [];

  const check = (name: string, pass: boolean, detail?: string): boolean => {
    const status = pass ? "PASS" : "FAIL";
    const line = detail !== undefined ? `${status}  ${name}  ${detail}` : `${status}  ${name}`;
    if (logger) {
      logger(line);
    } else {
      console.log(line);
    }
    if (!pass) {
      failures.push({ name, detail });
      if (!deferred) {
        throw new CheckFailureError(name, detail);
      }
    }
    return pass;
  };

  const finish = (): void => {
    if (failures.length > 0) {
      const summary = failures
        .map((f) => f.detail ? `${f.name} (${f.detail})` : f.name)
        .join("; ");
      throw new Error(`Checker failed ${failures.length} check(s): ${summary}`);
    }
  };

  return {
    check,
    failures,
    finish,
    [Symbol.dispose]() {
      finish();
    },
  };
}

export type SnapshotEntry =
  | Uint8Array
  | { isDirectory: true }
  | { isSymlink: true; target: string }
  | null;

let globalCommitSeq = 0;
const committedFileTimestamps = new Map<string, number>();

interface LockHolder {
  ownerId?: number;
  count: number;
  releasePromise: Promise<void>;
  resolveRelease: () => void;
}

class PathLock {
  #activeHolders = new Map<string, LockHolder>();

  isLocked(path: string): boolean {
    const active = activeProofStorage.getStore();
    const currentOwnerId = active?.id;
    for (const [lockedPath, holder] of this.#activeHolders.entries()) {
      if (
        path === lockedPath ||
        path.startsWith(lockedPath + "/") ||
        lockedPath.startsWith(path + "/")
      ) {
        if (currentOwnerId === undefined || holder.ownerId !== currentOwnerId) {
          return true;
        }
      }
    }
    return false;
  }

  async acquire(path: string): Promise<() => void> {
    const active = activeProofStorage.getStore();
    const currentOwnerId = active?.id;

    // Fast-path for same owner reacquiring exact same path
    const existing = this.#activeHolders.get(path);
    if (
      existing &&
      currentOwnerId !== undefined &&
      existing.ownerId === currentOwnerId
    ) {
      existing.count++;
      return () => {
        existing.count--;
        if (existing.count === 0) {
          if (this.#activeHolders.get(path) === existing) {
            this.#activeHolders.delete(path);
          }
          existing.resolveRelease();
        }
      };
    }

    while (true) {
      const conflicting: Promise<void>[] = [];
      for (const [lockedPath, holder] of this.#activeHolders.entries()) {
        if (
          path === lockedPath ||
          path.startsWith(lockedPath + "/") ||
          lockedPath.startsWith(path + "/")
        ) {
          if (
            currentOwnerId === undefined || holder.ownerId !== currentOwnerId
          ) {
            conflicting.push(holder.releasePromise);
          }
        }
      }

      if (conflicting.length === 0) {
        const currentHolder = this.#activeHolders.get(path);
        if (
          currentHolder &&
          currentOwnerId !== undefined &&
          currentHolder.ownerId === currentOwnerId
        ) {
          currentHolder.count++;
          return () => {
            currentHolder.count--;
            if (currentHolder.count === 0) {
              if (this.#activeHolders.get(path) === currentHolder) {
                this.#activeHolders.delete(path);
              }
              currentHolder.resolveRelease();
            }
          };
        }

        let resolveRelease!: () => void;
        const releasePromise = new Promise<void>((r) => {
          resolveRelease = r;
        });
        const holder: LockHolder = {
          ownerId: currentOwnerId,
          count: 1,
          releasePromise,
          resolveRelease,
        };
        this.#activeHolders.set(path, holder);

        return () => {
          holder.count--;
          if (holder.count === 0) {
            if (this.#activeHolders.get(path) === holder) {
              this.#activeHolders.delete(path);
            }
            resolveRelease();
          }
        };
      }

      await Promise.all(conflicting);
    }
  }

  async withLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire(path);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const proofPathLocks = new PathLock();

let globalProofSeq = 0;
let activeProofCount = 0;

interface PathSnapshotRecord {
  proofId: number;
  writtenBy?: number;
  entry: SnapshotEntry;
}

const pathSnapshotChains = new Map<string, PathSnapshotRecord[]>();
const failedProofs = new Set<number>();
const pathLastWriter = new Map<string, number>();

function recordPathSnapshot(norm: string, activeId: number, content: SnapshotEntry) {
  const writer = pathLastWriter.get(norm);
  const writtenBy = (writer !== undefined && writer !== activeId) ? writer : undefined;
  let chain = pathSnapshotChains.get(norm);
  if (!chain) {
    chain = [];
    pathSnapshotChains.set(norm, chain);
  }
  const existingIdx = chain.findIndex((r) => r.proofId === activeId);
  const record: PathSnapshotRecord = { proofId: activeId, writtenBy, entry: content };
  if (existingIdx >= 0) {
    chain[existingIdx] = record;
  } else {
    chain.push(record);
  }
  pathLastWriter.set(norm, activeId);
}

function getSafeRestoreContent(
  filePath: string,
  proofId: number,
  fallback: SnapshotEntry,
): SnapshotEntry {
  const chain = pathSnapshotChains.get(filePath);
  if (!chain) return fallback;
  const idx = chain.findIndex((r) => r.proofId === proofId);
  if (idx < 0) return fallback;
  let curr: PathSnapshotRecord | undefined = chain[idx];
  while (curr && curr.writtenBy !== undefined && failedProofs.has(curr.writtenBy)) {
    const prevIdx = chain.findIndex((r) => r.proofId === curr?.writtenBy);
    if (prevIdx >= 0) {
      curr = chain[prevIdx];
    } else {
      break;
    }
  }
  return curr ? curr.entry : fallback;
}

const proofWaitGraph = new Map<number, number>();

function wouldDeadlock(fromProofId: number, targetProofId: number): boolean {
  let curr: number | undefined = targetProofId;
  while (curr !== undefined) {
    if (curr === fromProofId) return true;
    curr = proofWaitGraph.get(curr);
  }
  return false;
}

interface InFlightWrite {
  proofId: number;
  proofName: string;
  done: Promise<void>;
}
const inFlightProofWrites = new Map<string, InFlightWrite>();

interface CommittedPathRecord {
  proofId: number;
  commitSeq: number;
  entry: SnapshotEntry;
}
const committedPathRecords = new Map<string, CommittedPathRecord>();

export interface ActiveProofContext {
  id: number;
  name: string;
  checker: Checker;
  startTime: number;
  snapshots: Map<string, SnapshotEntry>;
  snapshotSeq: Map<string, number>;
  completionPromise: Promise<void>;
  trackedChildProcesses: Deno.ChildProcess[];
  lastWrittenBytes: Map<string, SnapshotEntry>;
}

const activeProofStorage = new AsyncLocalStorage<ActiveProofContext>();

export function getActiveProof(): ActiveProofContext | undefined {
  return activeProofStorage.getStore();
}

// Intercept Deno file writes during runProof to support atomic rollback on proof failure (audio-feed-2bfv)
const originalWriteFile = Deno.writeFile;
const originalWriteFileSync = Deno.writeFileSync;
const originalWriteTextFile = Deno.writeTextFile;
const originalWriteTextFileSync = Deno.writeTextFileSync;
const originalRename = Deno.rename;
const originalRenameSync = Deno.renameSync;
const originalRemove = Deno.remove;
const originalRemoveSync = Deno.removeSync;
const originalMkdir = Deno.mkdir;
const originalMkdirSync = Deno.mkdirSync;
const originalSymlink = Deno.symlink;
const originalSymlinkSync = Deno.symlinkSync;
const originalOpen = Deno.open;
const originalOpenSync = Deno.openSync;
let originalCopyFile = Deno.copyFile;
let originalCopyFileSync = Deno.copyFileSync;

export function setOriginalCopyFileForTesting(fn: typeof Deno.copyFile) {
  originalCopyFile = fn;
}

export function setOriginalCopyFileSyncForTesting(fn: typeof Deno.copyFileSync) {
  originalCopyFileSync = fn;
}

export {
  originalCopyFile,
  originalCopyFileSync,
  originalOpen,
  originalOpenSync,
  originalWriteFile,
  originalWriteFileSync,
};

function normalizeFilePath(path: string | URL, baseDir?: string): string {
  let p: string;
  if (path instanceof URL) {
    if (path.protocol === "file:") {
      p = fromFileUrl(path);
    } else {
      p = path.pathname;
    }
  } else if (typeof path === "string" && path.startsWith("file://")) {
    p = fromFileUrl(path);
  } else {
    p = String(path);
  }
  return baseDir ? resolve(baseDir, p) : resolve(p);
}

const activeChromeProfiles = new Set<string>();

export function isChromeProfilePath(path: string | URL): boolean {
  const norm = normalizeFilePath(path);
  for (const prof of activeChromeProfiles) {
    if (norm === prof || norm.startsWith(`${prof}/`)) return true;
  }
  const baseDir = normalizeFilePath(Deno.env.get("TMPDIR") ?? "/tmp");
  if (
    norm.startsWith(`${baseDir}/`) &&
    (norm.includes("audiofeed-chrome-") || norm.includes("audiofeed-proof-"))
  ) {
    return true;
  }
  return false;
}

function registerInFlightWrite(active: ActiveProofContext, path: string) {
  inFlightProofWrites.set(path, {
    proofId: active.id,
    proofName: active.name,
    done: active.completionPromise,
  });
}

async function snapshotDirectoryRecursive(
  snapshots: Map<string, SnapshotEntry>,
  dir: string,
  options?: { followSymlinkTarget?: boolean; capturedKeys?: Set<string> },
) {
  const normDir = normalizeFilePath(dir);
  const active = activeProofStorage.getStore();
  if (active && !active.snapshotSeq.has(normDir)) {
    active.snapshotSeq.set(normDir, ++globalCommitSeq);
  }
  if (snapshots.has(normDir) && snapshots.get(normDir) === null) {
    // Preserve null baseline for directory created during this proof
  } else if (!snapshots.has(normDir)) {
    snapshots.set(normDir, { isDirectory: true });
    options?.capturedKeys?.add(normDir);
    if (active) recordPathSnapshot(normDir, active.id, { isDirectory: true });
  }
  for await (const entry of Deno.readDir(normDir)) {
    const fullPath = `${normDir}/${entry.name}`;
    if (entry.isDirectory) {
      await snapshotDirectoryRecursive(snapshots, fullPath, options);
    } else {
      await snapshotPath(snapshots, fullPath, options);
    }
  }
}

function snapshotDirectoryRecursiveSync(
  snapshots: Map<string, SnapshotEntry>,
  dir: string,
  options?: { followSymlinkTarget?: boolean; capturedKeys?: Set<string> },
) {
  const normDir = normalizeFilePath(dir);
  const active = activeProofStorage.getStore();
  if (active && !active.snapshotSeq.has(normDir)) {
    active.snapshotSeq.set(normDir, ++globalCommitSeq);
  }
  if (snapshots.has(normDir) && snapshots.get(normDir) === null) {
    // Preserve null baseline for directory created during this proof
  } else if (!snapshots.has(normDir)) {
    snapshots.set(normDir, { isDirectory: true });
    options?.capturedKeys?.add(normDir);
    if (active) recordPathSnapshot(normDir, active.id, { isDirectory: true });
  }
  for (const entry of Deno.readDirSync(normDir)) {
    const fullPath = `${normDir}/${entry.name}`;
    if (entry.isDirectory) {
      snapshotDirectoryRecursiveSync(snapshots, fullPath, options);
    } else {
      snapshotPathSync(snapshots, fullPath, options);
    }
  }
}

async function snapshotPath(
  snapshots: Map<string, SnapshotEntry>,
  path: string | URL,
  options?: { followSymlinkTarget?: boolean; capturedKeys?: Set<string> },
) {
  const norm = normalizeFilePath(path);
  if (isChromeProfilePath(norm)) return;
  const active = activeProofStorage.getStore();
  const committedSeq = committedFileTimestamps.get(norm) ?? 0;
  const currentSnapSeq = active ? (active.snapshotSeq.get(norm) ?? 0) : 0;
  if (active) {
    if (!active.snapshotSeq.has(norm) || committedSeq > currentSnapSeq) {
      active.snapshotSeq.set(norm, ++globalCommitSeq);
      if (committedSeq > currentSnapSeq) {
        snapshots.delete(norm);
      }
    }
  }
  if (snapshots.has(norm) && snapshots.get(norm) === null) {
    // Preserve original null baseline for path created during this proof
    return;
  }
  const existing = snapshots.get(norm);
  if (existing !== undefined) {
    if (options?.followSymlinkTarget) {
      try {
        const currentTarget = await Deno.readLink(norm);
        const resolvedCurrent = resolve(dirname(norm), currentTarget);
        if (!snapshots.has(resolvedCurrent)) {
          await snapshotPath(snapshots, resolvedCurrent, options);
        }
      } catch {
        if (
          existing && typeof existing === "object" && "isSymlink" in existing
        ) {
          const resolvedTarget = resolve(dirname(norm), existing.target);
          if (!snapshots.has(resolvedTarget)) {
            await snapshotPath(snapshots, resolvedTarget, options);
          }
        }
      }
    }
    return;
  }
  try {
    const lstat = await Deno.lstat(norm);
    if (lstat.isSymlink) {
      const target = await Deno.readLink(norm);
      const entry: SnapshotEntry = { isSymlink: true, target };
      snapshots.set(norm, entry);
      options?.capturedKeys?.add(norm);
      if (active) recordPathSnapshot(norm, active.id, entry);
      if (options?.followSymlinkTarget) {
        const resolvedTarget = resolve(dirname(norm), target);
        if (!snapshots.has(resolvedTarget)) {
          await snapshotPath(snapshots, resolvedTarget, options);
        }
      }
      return;
    }
    if (lstat.isDirectory) {
      await snapshotDirectoryRecursive(snapshots, norm, options);
      return;
    }
    const bytes = await Deno.readFile(norm);
    snapshots.set(norm, bytes);
    options?.capturedKeys?.add(norm);
    if (active) recordPathSnapshot(norm, active.id, bytes);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      snapshots.set(norm, null);
      options?.capturedKeys?.add(norm);
      if (active) recordPathSnapshot(norm, active.id, null);
    } else {
      throw err;
    }
  }
}

function snapshotPathSync(
  snapshots: Map<string, SnapshotEntry>,
  path: string | URL,
  options?: { followSymlinkTarget?: boolean; capturedKeys?: Set<string> },
) {
  const norm = normalizeFilePath(path);
  if (isChromeProfilePath(norm)) return;
  const active = activeProofStorage.getStore();
  const committedSeq = committedFileTimestamps.get(norm) ?? 0;
  const currentSnapSeq = active ? (active.snapshotSeq.get(norm) ?? 0) : 0;
  if (active) {
    if (!active.snapshotSeq.has(norm) || committedSeq > currentSnapSeq) {
      active.snapshotSeq.set(norm, ++globalCommitSeq);
      if (committedSeq > currentSnapSeq) {
        snapshots.delete(norm);
      }
    }
  }
  if (snapshots.has(norm) && snapshots.get(norm) === null) {
    // Preserve original null baseline for path created during this proof
    return;
  }
  const existing = snapshots.get(norm);
  if (existing !== undefined) {
    if (options?.followSymlinkTarget) {
      try {
        const currentTarget = Deno.readLinkSync(norm);
        const resolvedCurrent = resolve(dirname(norm), currentTarget);
        if (!snapshots.has(resolvedCurrent)) {
          snapshotPathSync(snapshots, resolvedCurrent, options);
        }
      } catch {
        if (
          existing && typeof existing === "object" && "isSymlink" in existing
        ) {
          const resolvedTarget = resolve(dirname(norm), existing.target);
          if (!snapshots.has(resolvedTarget)) {
            snapshotPathSync(snapshots, resolvedTarget, options);
          }
        }
      }
    }
    return;
  }
  try {
    const lstat = Deno.lstatSync(norm);
    if (lstat.isSymlink) {
      const target = Deno.readLinkSync(norm);
      const entry: SnapshotEntry = { isSymlink: true, target };
      snapshots.set(norm, entry);
      options?.capturedKeys?.add(norm);
      if (active) recordPathSnapshot(norm, active.id, entry);
      if (options?.followSymlinkTarget) {
        const resolvedTarget = resolve(dirname(norm), target);
        if (!snapshots.has(resolvedTarget)) {
          snapshotPathSync(snapshots, resolvedTarget, options);
        }
      }
      return;
    }
    if (lstat.isDirectory) {
      snapshotDirectoryRecursiveSync(snapshots, norm, options);
      return;
    }
    const bytes = Deno.readFileSync(norm);
    snapshots.set(norm, bytes);
    options?.capturedKeys?.add(norm);
    if (active) recordPathSnapshot(norm, active.id, bytes);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      snapshots.set(norm, null);
      options?.capturedKeys?.add(norm);
      if (active) recordPathSnapshot(norm, active.id, null);
    } else {
      throw err;
    }
  }
}

async function resolveNearestExistingPath(norm: string): Promise<string> {
  const parts: string[] = [];
  let curr = norm;
  while (true) {
    try {
      const realCurr = await Deno.realPath(curr);
      if (parts.length === 0) return realCurr;
      let result = realCurr;
      for (let i = parts.length - 1; i >= 0; i--) {
        result = resolve(result, parts[i]!);
      }
      return result;
    } catch {
      const p = dirname(curr);
      if (!p || p === curr) return norm;
      parts.push(basename(curr));
      curr = p;
    }
  }
}

function resolveNearestExistingPathSync(norm: string): string {
  const parts: string[] = [];
  let curr = norm;
  while (true) {
    try {
      const realCurr = Deno.realPathSync(curr);
      if (parts.length === 0) return realCurr;
      let result = realCurr;
      for (let i = parts.length - 1; i >= 0; i--) {
        result = resolve(result, parts[i]!);
      }
      return result;
    } catch {
      const p = dirname(curr);
      if (!p || p === curr) return norm;
      parts.push(basename(curr));
      curr = p;
    }
  }
}

async function resolveTargetPath(path: string | URL): Promise<string> {
  const norm = normalizeFilePath(path);
  try {
    const lstat = await Deno.lstat(norm);
    if (lstat.isSymlink) {
      try {
        const realParent = await resolveNearestExistingPath(dirname(norm));
        return resolve(realParent, basename(norm));
      } catch {
        return norm;
      }
    }
  } catch { /* does not exist */ }

  return await resolveNearestExistingPath(norm);
}

function resolveTargetPathSync(path: string | URL): string {
  const norm = normalizeFilePath(path);
  try {
    const lstat = Deno.lstatSync(norm);
    if (lstat.isSymlink) {
      try {
        const realParent = resolveNearestExistingPathSync(dirname(norm));
        return resolve(realParent, basename(norm));
      } catch {
        return norm;
      }
    }
  } catch { /* does not exist */ }

  return resolveNearestExistingPathSync(norm);
}

async function resolveWritePath(path: string | URL): Promise<string> {
  const norm = normalizeFilePath(path);
  try {
    const lstat = await Deno.lstat(norm);
    if (lstat.isSymlink) {
      const target = await Deno.readLink(norm);
      const physicalParent = await resolveNearestExistingPath(dirname(norm));
      const resolvedTarget = resolve(physicalParent, target);
      return await resolveWritePath(resolvedTarget);
    }
  } catch { /* does not exist */ }

  return await resolveNearestExistingPath(norm);
}

function resolveWritePathSync(path: string | URL): string {
  const norm = normalizeFilePath(path);
  try {
    const lstat = Deno.lstatSync(norm);
    if (lstat.isSymlink) {
      const target = Deno.readLinkSync(norm);
      const physicalParent = resolveNearestExistingPathSync(dirname(norm));
      const resolvedTarget = resolve(physicalParent, target);
      return resolveWritePathSync(resolvedTarget);
    }
  } catch { /* does not exist */ }

  return resolveNearestExistingPathSync(norm);
}

async function discardFailedWriteSnapshots(
  active: ActiveProofContext,
  capturedKeys: Set<string>,
  writeTarget: string,
) {
  for (const k of capturedKeys) {
    if (active.lastWrittenBytes.has(k)) continue;
    if (k !== writeTarget) {
      active.snapshots.delete(k);
      active.snapshotSeq.delete(k);
      pathSnapshotChains.get(k)?.pop();
    } else {
      try {
        const st = await Deno.lstat(writeTarget);
        if (st.isDirectory) {
          active.snapshots.delete(k);
          active.snapshotSeq.delete(k);
          pathSnapshotChains.get(k)?.pop();
        }
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          active.snapshots.delete(k);
          active.snapshotSeq.delete(k);
          pathSnapshotChains.get(k)?.pop();
        }
      }
    }
  }
}

function discardFailedWriteSnapshotsSync(
  active: ActiveProofContext,
  capturedKeys: Set<string>,
  writeTarget: string,
) {
  for (const k of capturedKeys) {
    if (active.lastWrittenBytes.has(k)) continue;
    if (k !== writeTarget) {
      active.snapshots.delete(k);
      active.snapshotSeq.delete(k);
      pathSnapshotChains.get(k)?.pop();
    } else {
      try {
        const st = Deno.lstatSync(writeTarget);
        if (st.isDirectory) {
          active.snapshots.delete(k);
          active.snapshotSeq.delete(k);
          pathSnapshotChains.get(k)?.pop();
        }
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          active.snapshots.delete(k);
          active.snapshotSeq.delete(k);
          pathSnapshotChains.get(k)?.pop();
        }
      }
    }
  }
}

Deno.writeFile = async function (
  path: string | URL,
  data: Uint8Array | ReadableStream<Uint8Array>,
  options?: Deno.WriteFileOptions,
) {
  const active = activeProofStorage.getStore();
  if (active) {
    if (options?.createNew) {
      let exists = false;
      try {
        const lstat = await Deno.lstat(normalizeFilePath(path));
        exists = Boolean(lstat);
      } catch { /* proceed */ }
      if (exists) {
        return await originalWriteFile(path, data, options);
      }
    }
    const writeTarget = await resolveWritePath(path);
    return await proofPathLocks.withLock(writeTarget, async () => {
      registerInFlightWrite(active, writeTarget);
      const capturedKeys = new Set<string>();
      try {
        await snapshotPath(active.snapshots, writeTarget, { capturedKeys });
        const res = await originalWriteFile(writeTarget, data, options);
        try {
          active.lastWrittenBytes.set(
            writeTarget,
            await Deno.readFile(writeTarget),
          );
        } catch { /* ignore */ }
        return res;
      } catch (err) {
        await discardFailedWriteSnapshots(active, capturedKeys, writeTarget);
        throw err;
      }
    });
  }
  return await originalWriteFile(path, data, options);
};

Deno.writeFileSync = function (
  path: string | URL,
  data: Uint8Array,
  options?: Deno.WriteFileOptions,
) {
  const active = activeProofStorage.getStore();
  if (active) {
    if (options?.createNew) {
      let exists = false;
      try {
        const lstat = Deno.lstatSync(normalizeFilePath(path));
        exists = Boolean(lstat);
      } catch { /* proceed */ }
      if (exists) {
        return originalWriteFileSync(path, data, options);
      }
    }
    const writeTarget = resolveWritePathSync(path);
    if (proofPathLocks.isLocked(writeTarget)) {
      throw new Deno.errors.Busy(
        `Resource busy: synchronous write to '${writeTarget}' is excluded while path is locked by conflicting proof transaction or rollback`,
      );
    }
    registerInFlightWrite(active, writeTarget);
    const capturedKeys = new Set<string>();
    try {
      snapshotPathSync(active.snapshots, writeTarget, { capturedKeys });
      const res = originalWriteFileSync(writeTarget, data, options);
      try {
        active.lastWrittenBytes.set(
          writeTarget,
          Deno.readFileSync(writeTarget),
        );
      } catch { /* ignore */ }
      return res;
    } catch (err) {
      discardFailedWriteSnapshotsSync(active, capturedKeys, writeTarget);
      throw err;
    }
  }
  return originalWriteFileSync(path, data, options);
};

Deno.writeTextFile = async function (
  path: string | URL,
  data: string | ReadableStream<string>,
  options?: Deno.WriteFileOptions,
) {
  const active = activeProofStorage.getStore();
  if (active) {
    if (options?.createNew) {
      let exists = false;
      try {
        const lstat = await Deno.lstat(normalizeFilePath(path));
        exists = Boolean(lstat);
      } catch { /* proceed */ }
      if (exists) {
        return await originalWriteTextFile(path, data, options);
      }
    }
    const writeTarget = await resolveWritePath(path);
    return await proofPathLocks.withLock(writeTarget, async () => {
      registerInFlightWrite(active, writeTarget);
      const capturedKeys = new Set<string>();
      try {
        await snapshotPath(active.snapshots, writeTarget, { capturedKeys });
        const res = await originalWriteTextFile(writeTarget, data, options);
        try {
          active.lastWrittenBytes.set(
            writeTarget,
            await Deno.readFile(writeTarget),
          );
        } catch { /* ignore */ }
        return res;
      } catch (err) {
        await discardFailedWriteSnapshots(active, capturedKeys, writeTarget);
        throw err;
      }
    });
  }
  return await originalWriteTextFile(path, data, options);
};

Deno.writeTextFileSync = function (
  path: string | URL,
  data: string,
  options?: Deno.WriteFileOptions,
) {
  const active = activeProofStorage.getStore();
  if (active) {
    if (options?.createNew) {
      let exists = false;
      try {
        const lstat = Deno.lstatSync(normalizeFilePath(path));
        exists = Boolean(lstat);
      } catch { /* proceed */ }
      if (exists) {
        return originalWriteTextFileSync(path, data, options);
      }
    }
    const writeTarget = resolveWritePathSync(path);
    if (proofPathLocks.isLocked(writeTarget)) {
      throw new Deno.errors.Busy(
        `Resource busy: synchronous write to '${writeTarget}' is excluded while path is locked by conflicting proof transaction or rollback`,
      );
    }
    registerInFlightWrite(active, writeTarget);
    const capturedKeys = new Set<string>();
    try {
      snapshotPathSync(active.snapshots, writeTarget, { capturedKeys });
      const res = originalWriteTextFileSync(writeTarget, data, options);
      try {
        active.lastWrittenBytes.set(
          writeTarget,
          Deno.readFileSync(writeTarget),
        );
      } catch { /* ignore */ }
      return res;
    } catch (err) {
      discardFailedWriteSnapshotsSync(active, capturedKeys, writeTarget);
      throw err;
    }
  }
  return originalWriteTextFileSync(path, data, options);
};

Deno.rename = async function (oldPath: string | URL, newPath: string | URL) {
  const active = activeProofStorage.getStore();
  if (active) {
    const oldTarget = await resolveTargetPath(oldPath);
    const newTarget = await resolveTargetPath(newPath);

    const runWithLocks = async (fn: () => Promise<void>): Promise<void> => {
      if (oldTarget === newTarget) {
        return await proofPathLocks.withLock(oldTarget, fn);
      }
      const [first, second] = oldTarget < newTarget
        ? [oldTarget, newTarget]
        : [newTarget, oldTarget];
      return await proofPathLocks.withLock(first, async () => {
        return await proofPathLocks.withLock(second, fn);
      });
    };

    return await runWithLocks(async () => {
      registerInFlightWrite(active, oldTarget);
      registerInFlightWrite(active, newTarget);
      const prevSnapKeys = new Set(active.snapshots.keys());

      try {
        // Snapshot target file/dir state before it is overwritten
        await snapshotPath(active.snapshots, newTarget);

        // Snapshot source: if already tracked in snapshots, preserve it.
        // If not tracked yet, snapshot its full file/dir/symlink state.
        if (!active.snapshots.has(oldTarget)) {
          await snapshotPath(active.snapshots, oldTarget);
        }
        try {
          const lstat = await Deno.lstat(oldTarget);
          if (lstat.isDirectory) {
            if (!active.snapshots.has(newTarget)) {
              active.snapshots.set(newTarget, null);
              active.snapshotSeq.set(newTarget, ++globalCommitSeq);
            }
            // Mark all destination paths for items moving from oldTarget into newTarget as null in snapshots,
            // so if the proof fails, these moved items in newTarget will be cleaned up in rollback step 1!
            const markDestinationChildrenNull = async (
              src: string,
              dest: string,
            ) => {
              for await (const entry of Deno.readDir(src)) {
                const srcChild = `${src}/${entry.name}`;
                const destChild = `${dest}/${entry.name}`;
                if (!active.snapshots.has(destChild)) {
                  active.snapshots.set(destChild, null);
                  active.snapshotSeq.set(destChild, ++globalCommitSeq);
                }
                if (entry.isDirectory) {
                  await markDestinationChildrenNull(srcChild, destChild);
                }
              }
            };
            await markDestinationChildrenNull(oldTarget, newTarget);
          }
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
        const res = await originalRename(oldTarget, newTarget);
        active.lastWrittenBytes.set(oldTarget, null);
        for (const key of active.snapshots.keys()) {
          if (key.startsWith(oldTarget + "/")) {
            active.lastWrittenBytes.set(key, null);
          }
        }
        for (const key of active.lastWrittenBytes.keys()) {
          if (key.startsWith(oldTarget + "/")) {
            active.lastWrittenBytes.set(key, null);
          }
        }
        try {
          const stat = await Deno.lstat(newTarget);
          if (stat.isSymlink) {
            active.lastWrittenBytes.set(newTarget, {
              isSymlink: true,
              target: await Deno.readLink(newTarget),
            });
          } else if (stat.isDirectory) {
            active.lastWrittenBytes.set(newTarget, { isDirectory: true });
            const captureMovedDirectoryChildren = async (dir: string) => {
              for await (const entry of Deno.readDir(dir)) {
                const childPath = `${dir}/${entry.name}`;
                try {
                  const childStat = await Deno.lstat(childPath);
                  if (childStat.isSymlink) {
                    active.lastWrittenBytes.set(childPath, {
                      isSymlink: true,
                      target: await Deno.readLink(childPath),
                    });
                  } else if (childStat.isDirectory) {
                    active.lastWrittenBytes.set(childPath, {
                      isDirectory: true,
                    });
                    await captureMovedDirectoryChildren(childPath);
                  } else {
                    active.lastWrittenBytes.set(
                      childPath,
                      await Deno.readFile(childPath),
                    );
                  }
                } catch {
                  active.lastWrittenBytes.set(childPath, null);
                }
              }
            };
            await captureMovedDirectoryChildren(newTarget);
          } else {
            active.lastWrittenBytes.set(
              newTarget,
              await Deno.readFile(newTarget),
            );
          }
        } catch {
          active.lastWrittenBytes.set(newTarget, null);
        }
        return res;
      } catch (err) {
        // Rename is atomic; if it threw, no mutation occurred on oldTarget or newTarget.
        // Discard any snapshots introduced solely by this failed rename attempt so concurrent
        // external edits to destination or created sources are preserved!
        for (const k of Array.from(active.snapshots.keys())) {
          if (!prevSnapKeys.has(k)) {
            active.snapshots.delete(k);
            active.snapshotSeq.delete(k);
            const chain = pathSnapshotChains.get(k);
            if (
              chain && chain.length > 0 &&
              chain[chain.length - 1]?.proofId === active.id
            ) {
              chain.pop();
              if (chain.length === 0) pathSnapshotChains.delete(k);
            }
          }
        }
        throw err;
      }
    });
  }
  return await originalRename(oldPath, newPath);
};

Deno.renameSync = function (oldPath: string | URL, newPath: string | URL) {
  const active = activeProofStorage.getStore();
  if (active) {
    const oldTarget = resolveTargetPathSync(oldPath);
    const newTarget = resolveTargetPathSync(newPath);
    if (proofPathLocks.isLocked(oldTarget) || proofPathLocks.isLocked(newTarget)) {
      throw new Deno.errors.Busy(
        `Resource busy: synchronous rename between '${oldTarget}' and '${newTarget}' is excluded while path is locked by conflicting proof transaction or rollback`,
      );
    }

    const prevSnapKeys = new Set(active.snapshots.keys());

    try {
      snapshotPathSync(active.snapshots, newTarget);

      if (!active.snapshots.has(oldTarget)) {
        snapshotPathSync(active.snapshots, oldTarget);
      }
      try {
        const lstat = Deno.lstatSync(oldTarget);
        if (lstat.isDirectory) {
          if (!active.snapshots.has(newTarget)) {
            active.snapshots.set(newTarget, null);
            active.snapshotSeq.set(newTarget, ++globalCommitSeq);
          }
          const markDestinationChildrenNullSync = (
            src: string,
            dest: string,
          ) => {
            for (const entry of Deno.readDirSync(src)) {
              const srcChild = `${src}/${entry.name}`;
              const destChild = `${dest}/${entry.name}`;
              if (!active.snapshots.has(destChild)) {
                active.snapshots.set(destChild, null);
                active.snapshotSeq.set(destChild, ++globalCommitSeq);
              }
              if (entry.isDirectory) {
                markDestinationChildrenNullSync(srcChild, destChild);
              }
            }
          };
          markDestinationChildrenNullSync(oldTarget, newTarget);
        }
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      const res = originalRenameSync(oldTarget, newTarget);
      active.lastWrittenBytes.set(oldTarget, null);
      for (const key of active.snapshots.keys()) {
        if (key.startsWith(oldTarget + "/")) {
          active.lastWrittenBytes.set(key, null);
        }
      }
      for (const key of active.lastWrittenBytes.keys()) {
        if (key.startsWith(oldTarget + "/")) {
          active.lastWrittenBytes.set(key, null);
        }
      }
      try {
        const stat = Deno.lstatSync(newTarget);
        if (stat.isSymlink) {
          active.lastWrittenBytes.set(newTarget, {
            isSymlink: true,
            target: Deno.readLinkSync(newTarget),
          });
        } else if (stat.isDirectory) {
          active.lastWrittenBytes.set(newTarget, { isDirectory: true });
          const captureMovedDirectoryChildrenSync = (dir: string) => {
            for (const entry of Deno.readDirSync(dir)) {
              const childPath = `${dir}/${entry.name}`;
              try {
                const childStat = Deno.lstatSync(childPath);
                if (childStat.isSymlink) {
                  active.lastWrittenBytes.set(childPath, {
                    isSymlink: true,
                    target: Deno.readLinkSync(childPath),
                  });
                } else if (childStat.isDirectory) {
                  active.lastWrittenBytes.set(childPath, { isDirectory: true });
                  captureMovedDirectoryChildrenSync(childPath);
                } else {
                  active.lastWrittenBytes.set(
                    childPath,
                    Deno.readFileSync(childPath),
                  );
                }
              } catch {
                active.lastWrittenBytes.set(childPath, null);
              }
            }
          };
          captureMovedDirectoryChildrenSync(newTarget);
        } else {
          active.lastWrittenBytes.set(newTarget, Deno.readFileSync(newTarget));
        }
      } catch {
        active.lastWrittenBytes.set(newTarget, null);
      }
      return res;
    } catch (err) {
      // Rename is atomic; if it threw, no mutation occurred on oldTarget or newTarget.
      // Discard any snapshots introduced solely by this failed rename attempt so concurrent
      // external edits to destination or created sources are preserved!
      for (const k of Array.from(active.snapshots.keys())) {
        if (!prevSnapKeys.has(k)) {
          active.snapshots.delete(k);
          active.snapshotSeq.delete(k);
          const chain = pathSnapshotChains.get(k);
          if (
            chain && chain.length > 0 &&
            chain[chain.length - 1]?.proofId === active.id
          ) {
            chain.pop();
            if (chain.length === 0) pathSnapshotChains.delete(k);
          }
        }
      }
      throw err;
    }
  }
  return originalRenameSync(oldPath, newPath);
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface CommandRunState {
  outputPaths: string[];
  newlySnapshotted: Set<string>;
  preStats: Map<string, { exists: boolean; entry: SnapshotEntry }>;
}

const OriginalCommand = Deno.Command;
// deno-lint-ignore no-explicit-any
(Deno as any).Command = class Command extends OriginalCommand {
  #command: string | URL;
  #options?: Deno.CommandOptions;
  constructor(command: string | URL, options?: Deno.CommandOptions) {
    super(command, options);
    this.#command = command;
    this.#options = options;
  }

  #snapshotCandidate(
    pathStr: string,
    runState: CommandRunState,
    active: ActiveProofContext,
    baseDir?: string,
  ) {
    const clean = pathStr.replace(/^[A-Za-z0-9]+:/, "").trim();
    if (!clean || clean.startsWith("-")) return;
    const resolved = normalizeFilePath(clean, baseDir);
    const realTarget = resolveWritePathSync(resolved);
    if (!runState.outputPaths.includes(realTarget)) {
      runState.outputPaths.push(realTarget);
    }
    registerInFlightWrite(active, realTarget);
    const hadPriorSnapshot = active.snapshots.has(realTarget);
    snapshotPathSync(active.snapshots, realTarget);
    if (!hadPriorSnapshot && active.snapshots.has(realTarget)) {
      runState.newlySnapshotted.add(realTarget);
    }
    let preEntry: SnapshotEntry = null;
    try {
      const stat = Deno.lstatSync(realTarget);
      if (stat.isSymlink) {
        preEntry = { isSymlink: true, target: Deno.readLinkSync(realTarget) };
      } else if (stat.isDirectory) {
        preEntry = { isDirectory: true };
      } else {
        preEntry = Deno.readFileSync(realTarget);
      }
    } catch {
      preEntry = null;
    }
    runState.preStats.set(realTarget, {
      exists: preEntry !== null,
      entry: preEntry,
    });
  }

  #snapshotCopiedTree(
    srcDir: string,
    destDir: string,
    runState: CommandRunState,
    active: ActiveProofContext,
    baseDir?: string,
  ) {
    try {
      for (const entry of Deno.readDirSync(srcDir)) {
        const srcChild = join(srcDir, entry.name);
        const destChild = join(destDir, entry.name);
        if (entry.isDirectory) {
          let destChildExistsAsDir = false;
          try {
            destChildExistsAsDir = Deno.lstatSync(destChild).isDirectory;
          } catch {
            destChildExistsAsDir = false;
          }
          if (!destChildExistsAsDir) {
            this.#snapshotCandidate(destChild, runState, active, baseDir);
          }
          this.#snapshotCopiedTree(
            srcChild,
            destChild,
            runState,
            active,
            baseDir,
          );
        } else {
          this.#snapshotCandidate(destChild, runState, active, baseDir);
        }
      }
    } catch { /* proceed */ }
  }

  #captureNewDirectoryChildren(
    dir: string,
    active: ActiveProofContext,
    preStats: Map<string, { exists: boolean; entry: SnapshotEntry }>,
  ) {
    try {
      for (const entry of Deno.readDirSync(dir)) {
        const childPath = join(dir, entry.name);
        if (!preStats.has(childPath)) {
          if (!active.snapshots.has(childPath)) {
            active.snapshots.set(childPath, null);
            active.snapshotSeq.set(childPath, ++globalCommitSeq);
            recordPathSnapshot(childPath, active.id, null);
          }
          try {
            const stat = Deno.lstatSync(childPath);
            if (stat.isSymlink) {
              active.lastWrittenBytes.set(childPath, {
                isSymlink: true,
                target: Deno.readLinkSync(childPath),
              });
            } else if (stat.isDirectory) {
              active.lastWrittenBytes.set(childPath, { isDirectory: true });
              this.#captureNewDirectoryChildren(childPath, active, preStats);
            } else {
              active.lastWrittenBytes.set(
                childPath,
                Deno.readFileSync(childPath),
              );
            }
          } catch { /* proceed */ }
        }
      }
    } catch { /* proceed */ }
  }

  #captureOutputs(runState: CommandRunState) {
    const active = activeProofStorage.getStore();
    if (!active) return;
    for (const p of runState.outputPaths) {
      const pre = runState.preStats.get(p);
      let changed = false;
      try {
        const stat = Deno.lstatSync(p);
        if (!pre?.exists) {
          changed = true;
          if (stat.isSymlink) {
            active.lastWrittenBytes.set(p, {
              isSymlink: true,
              target: Deno.readLinkSync(p),
            });
          } else if (stat.isDirectory) {
            active.lastWrittenBytes.set(p, { isDirectory: true });
            this.#captureNewDirectoryChildren(p, active, runState.preStats);
          } else {
            active.lastWrittenBytes.set(p, Deno.readFileSync(p));
          }
        } else {
          if (stat.isSymlink) {
            const newTarget = Deno.readLinkSync(p);
            const preTarget = (pre.entry && typeof pre.entry === "object" &&
                !(pre.entry instanceof Uint8Array) &&
                "isSymlink" in pre.entry)
              ? pre.entry.target
              : undefined;
            if (newTarget !== preTarget) {
              changed = true;
              active.lastWrittenBytes.set(p, {
                isSymlink: true,
                target: newTarget,
              });
            }
          } else if (stat.isDirectory) {
            const preIsDir = Boolean(
              pre.entry && typeof pre.entry === "object" &&
                !(pre.entry instanceof Uint8Array) &&
                "isDirectory" in pre.entry,
            );
            if (!preIsDir) {
              changed = true;
              active.lastWrittenBytes.set(p, { isDirectory: true });
              this.#captureNewDirectoryChildren(p, active, runState.preStats);
            }
          } else {
            const currentBytes = Deno.readFileSync(p);
            const preBytes = pre.entry instanceof Uint8Array ? pre.entry : null;
            if (!preBytes || !bytesEqual(currentBytes, preBytes)) {
              changed = true;
              active.lastWrittenBytes.set(p, currentBytes);
            }
          }
        }
      } catch {
        if (pre?.exists) {
          changed = true;
          active.lastWrittenBytes.set(p, null);
        }
      }

      if (!changed && runState.newlySnapshotted.has(p)) {
        active.snapshots.delete(p);
        active.snapshotSeq.delete(p);
        const chain = pathSnapshotChains.get(p);
        if (
          chain && chain.length > 0 &&
          chain[chain.length - 1]?.proofId === active.id
        ) {
          chain.pop();
          if (chain.length === 0) pathSnapshotChains.delete(p);
        }
      }
    }
  }

  #prepareOutputs(): CommandRunState {
    const runState: CommandRunState = {
      outputPaths: [],
      newlySnapshotted: new Set(),
      preStats: new Map(),
    };
    const active = activeProofStorage.getStore();
    if (!active || !this.#options?.args) return runState;
    const baseDir = this.#options.cwd ? normalizeFilePath(this.#options.cwd) : undefined;
    const cmdName = typeof this.#command === "string" ? this.#command : "";
    const args = this.#options.args;

    const extractShellWord = (
      script: string,
      startIndex: number,
    ): { word: string; nextIndex: number } | null => {
      let i = startIndex;
      while (i < script.length && /\s/.test(script[i]!)) i++;
      if (i >= script.length) return null;
      const start = i;
      while (i < script.length) {
        const ch = script[i]!;
        if (/\s|[;&|<>]/.test(ch)) break;
        if (ch === "'") {
          i++;
          while (i < script.length && script[i] !== "'") i++;
          if (i < script.length) i++;
        } else if (ch === '"') {
          i++;
          while (i < script.length && script[i] !== '"') {
            if (script[i] === "\\" && i + 1 < script.length) i += 2;
            else i++;
          }
          if (i < script.length) i++;
        } else if (ch === "\\") {
          i += 2;
        } else {
          i++;
        }
      }
      if (i === start) return null;
      return { word: script.slice(start, i), nextIndex: i };
    };

    const getEnvVal = (name: string): string | undefined => {
      if (this.#options?.env && name in this.#options.env) {
        return this.#options.env[name];
      }
      if (this.#options?.clearEnv) {
        return undefined;
      }
      return Deno.env.get(name);
    };

    const resolveStringWithVars = (str: string, cIdx: number): string => {
      let res = "";
      let j = 0;
      while (j < str.length) {
        if (str[j] === "$") {
          const exp = expandVariable(str.slice(j), cIdx);
          if (exp) {
            res += exp.text;
            j += exp.length;
          } else {
            res += "$";
            j++;
          }
        } else {
          res += str[j]!;
          j++;
        }
      }
      return res;
    };

    const expandVariable = (
      remainder: string,
      cIdx: number,
    ): { text: string; length: number } | null => {
      // 1. ${...} parameter expansion
      if (remainder.startsWith("${")) {
        let depth = 0;
        let closeBrace = -1;
        for (let k = 0; k < remainder.length; k++) {
          if (remainder[k] === "{" && k > 0 && remainder[k - 1] === "$") {
            depth++;
          } else if (remainder[k] === "}" && depth > 0) {
            depth--;
            if (depth === 0) {
              closeBrace = k;
              break;
            }
          }
        }
        if (closeBrace !== -1) {
          const inner = remainder.slice(2, closeBrace);
          // Positional: ${1}
          if (/^[0-9]+$/.test(inner)) {
            const num = parseInt(inner, 10);
            return {
              text: args[cIdx + 2 + num] ?? "",
              length: closeBrace + 1,
            };
          }
          // Default/alternate value: ${VAR:-fallback}, ${VAR-fallback}, ${VAR:+alternate}, ${VAR+alternate}
          const defMatch = inner.match(
            /^([a-zA-Z_][a-zA-Z0-9_]*)(:?-|:\+|\+)(.*)$/,
          );
          if (defMatch) {
            const varName = defMatch[1]!;
            const op = defMatch[2]!;
            const fallback = defMatch[3]!;
            const val = getEnvVal(varName);
            let selected = "";
            if (op === ":-") {
              selected = (val !== undefined && val !== "")
                ? val
                : resolveStringWithVars(fallback, cIdx);
            } else if (op === "-") {
              selected = val !== undefined ? val : resolveStringWithVars(fallback, cIdx);
            } else if (op === ":+") {
              selected = (val !== undefined && val !== "")
                ? resolveStringWithVars(fallback, cIdx)
                : "";
            } else if (op === "+") {
              selected = val !== undefined ? resolveStringWithVars(fallback, cIdx) : "";
            }
            return { text: selected, length: closeBrace + 1 };
          }
          // Simple ${VAR}
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inner)) {
            const val = getEnvVal(inner);
            return {
              text: val ?? "",
              length: closeBrace + 1,
            };
          }
        }
      }
      // 2. Simple $1..$9
      const numMatch = remainder.match(/^\$([0-9]+)/);
      if (numMatch) {
        const num = parseInt(numMatch[1]!, 10);
        return {
          text: args[cIdx + 2 + num] ?? "",
          length: numMatch[0].length,
        };
      }
      // 3. Simple $VAR
      const varMatch = remainder.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (varMatch) {
        const varName = varMatch[1]!;
        const val = getEnvVal(varName);
        return {
          text: val ?? "",
          length: varMatch[0].length,
        };
      }
      return null;
    };

    const resolveShellWord = (
      word: string,
      cIdx: number,
    ): string | null => {
      let result = "";
      let i = 0;

      while (i < word.length) {
        const ch = word[i]!;
        if (ch === "'") {
          // Single-quoted: strictly literal, no variable expansion
          i++;
          const start = i;
          while (i < word.length && word[i] !== "'") i++;
          result += word.slice(start, i);
          if (i < word.length) i++;
        } else if (ch === '"') {
          // Double-quoted: expand variables and handle POSIX escape rules:
          // backslash retains escape meaning only before $, `, ", \, and newline
          i++;
          while (i < word.length && word[i] !== '"') {
            if (word[i] === "\\" && i + 1 < word.length) {
              const next = word[i + 1]!;
              if (next === "\n") {
                // POSIX: backslash followed by newline is removed entirely
                i += 2;
              } else if (
                next === "$" || next === "`" || next === '"' || next === "\\"
              ) {
                result += next;
                i += 2;
              } else {
                result += "\\" + next;
                i += 2;
              }
            } else if (word[i] === "$") {
              const exp = expandVariable(word.slice(i), cIdx);
              if (exp) {
                result += exp.text;
                i += exp.length;
              } else {
                result += "$";
                i++;
              }
            } else {
              result += word[i]!;
              i++;
            }
          }
          if (i < word.length) i++;
        } else if (ch === "\\") {
          if (i + 1 < word.length) {
            const next = word[i + 1]!;
            if (next === "\n") {
              i += 2;
            } else {
              result += next;
              i += 2;
            }
          } else {
            result += "\\";
            i++;
          }
        } else if (ch === "$") {
          const exp = expandVariable(word.slice(i), cIdx);
          if (exp) {
            result += exp.text;
            i += exp.length;
          } else {
            result += "$";
            i++;
          }
        } else {
          result += ch;
          i++;
        }
      }

      if (!result) return null;
      return result;
    };

    // 1. Shell commands: inspect scripts for output redirects, tees, and format prefixes
    if (cmdName.endsWith("sh") || cmdName.endsWith("bash")) {
      const cIdx = args.indexOf("-c");
      if (cIdx !== -1 && cIdx + 1 < args.length) {
        const script = args[cIdx + 1]!;
        // Redirects: > or >> followed by target shell word
        const redirectRegex = />+(?!>)/g;
        let match: RegExpExecArray | null;
        while ((match = redirectRegex.exec(script)) !== null) {
          const wordInfo = extractShellWord(
            script,
            match.index + match[0].length,
          );
          if (wordInfo) {
            const target = resolveShellWord(wordInfo.word, cIdx);
            if (target) {
              this.#snapshotCandidate(target, runState, active, baseDir);
            }
          }
        }
        // Tee targets: tee [-a] word
        const teeRegex = /\btee(?:\s+-[a-zA-Z]+)*\s+/g;
        while ((match = teeRegex.exec(script)) !== null) {
          const wordInfo = extractShellWord(
            script,
            match.index + match[0].length,
          );
          if (wordInfo) {
            const target = resolveShellWord(wordInfo.word, cIdx);
            if (target) {
              this.#snapshotCandidate(target, runState, active, baseDir);
            }
          }
        }
        // Format prefixes like png8:word
        const prefixRegex = /\b([a-zA-Z0-9]+):(?=[^\s;&|<>])/g;
        while ((match = prefixRegex.exec(script)) !== null) {
          const prefix = match[1]!;
          if (prefix === "http" || prefix === "https" || prefix === "file") {
            continue;
          }
          const wordInfo = extractShellWord(
            script,
            match.index + match[0].length,
          );
          if (wordInfo) {
            const target = resolveShellWord(wordInfo.word, cIdx);
            if (target) {
              this.#snapshotCandidate(target, runState, active, baseDir);
            }
          }
        }
      }
    }

    // 2. Direct arguments: flags specifying output or format prefixes (direct argv without shell expansion)
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-o" || arg === "--output" || arg === "--out") {
        if (i + 1 < args.length) {
          this.#snapshotCandidate(args[i + 1]!, runState, active, baseDir);
        }
      } else if (
        arg.startsWith("-o=") || arg.startsWith("--output=") ||
        arg.startsWith("--out=")
      ) {
        const val = arg.split("=").slice(1).join("=");
        this.#snapshotCandidate(val, runState, active, baseDir);
      } else if (
        /^[A-Za-z0-9]+:/.test(arg) && !arg.startsWith("http:") &&
        !arg.startsWith("https:") &&
        !arg.startsWith("file:")
      ) {
        this.#snapshotCandidate(arg, runState, active, baseDir);
      }
    }

    // 3. Command specific: for convert, magick, cp:
    if (cmdName.endsWith("convert") || cmdName.endsWith("magick")) {
      for (let i = args.length - 1; i >= 0; i--) {
        const arg = args[i]!;
        if (!arg.startsWith("-")) {
          this.#snapshotCandidate(arg, runState, active, baseDir);
          break;
        }
      }
    } else if (cmdName.endsWith("cp")) {
      let targetDir: string | null = null;
      let noTargetDir = false;
      const sourceArgs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "-t" || arg === "--target-directory") {
          if (i + 1 < args.length) {
            targetDir = args[i + 1]!;
            i++; // skip dest directory operand
          }
        } else if (arg.startsWith("--target-directory=")) {
          targetDir = arg.split("=").slice(1).join("=");
        } else if (arg === "-T" || arg === "--no-target-directory") {
          noTargetDir = true;
        } else if (arg.startsWith("-") && !arg.startsWith("--")) {
          if (arg.includes("T")) {
            noTargetDir = true;
          }
        } else if (!arg.startsWith("-")) {
          sourceArgs.push(arg);
        }
      }

      if (noTargetDir && sourceArgs.length >= 2) {
        const src = sourceArgs[0]!;
        const dest = sourceArgs[sourceArgs.length - 1]!;
        const resolvedSrc = normalizeFilePath(src, baseDir);
        const resolvedDest = normalizeFilePath(dest, baseDir);
        let srcIsDir = false;
        try {
          srcIsDir = Deno.lstatSync(resolvedSrc).isDirectory;
        } catch { /* proceed */ }
        if (srcIsDir) {
          let destExistsAsDir = false;
          try {
            destExistsAsDir = Deno.lstatSync(resolvedDest).isDirectory;
          } catch {
            destExistsAsDir = false;
          }
          if (!destExistsAsDir) {
            this.#snapshotCandidate(resolvedDest, runState, active, baseDir);
          }
          this.#snapshotCopiedTree(
            resolvedSrc,
            resolvedDest,
            runState,
            active,
            baseDir,
          );
        } else {
          this.#snapshotCandidate(resolvedDest, runState, active, baseDir);
        }
      } else if (targetDir) {
        const resolvedTargetDir = normalizeFilePath(targetDir, baseDir);
        for (const src of sourceArgs) {
          const childName = basename(src);
          const effectiveDest = join(resolvedTargetDir, childName);
          const resolvedSrc = normalizeFilePath(src, baseDir);
          let srcIsDir = false;
          try {
            srcIsDir = Deno.lstatSync(resolvedSrc).isDirectory;
          } catch { /* proceed */ }
          if (srcIsDir) {
            let effectiveDestExistsAsDir = false;
            try {
              effectiveDestExistsAsDir = Deno.lstatSync(effectiveDest).isDirectory;
            } catch {
              effectiveDestExistsAsDir = false;
            }
            if (!effectiveDestExistsAsDir) {
              this.#snapshotCandidate(
                effectiveDest,
                runState,
                active,
                baseDir,
              );
            }
            this.#snapshotCopiedTree(
              resolvedSrc,
              effectiveDest,
              runState,
              active,
              baseDir,
            );
          } else {
            this.#snapshotCandidate(
              effectiveDest,
              runState,
              active,
              baseDir,
            );
          }
        }
      } else if (sourceArgs.length >= 2) {
        const lastArg = sourceArgs[sourceArgs.length - 1]!;
        const resolvedLast = normalizeFilePath(lastArg, baseDir);
        let isDir = false;
        try {
          isDir = Deno.lstatSync(resolvedLast).isDirectory;
        } catch {
          isDir = lastArg.endsWith("/") || lastArg.endsWith("\\");
        }
        if (isDir) {
          const sources = sourceArgs.slice(0, sourceArgs.length - 1);
          for (const src of sources) {
            const childName = basename(src);
            const effectiveDest = join(resolvedLast, childName);
            const resolvedSrc = normalizeFilePath(src, baseDir);
            let srcIsDir = false;
            try {
              srcIsDir = Deno.lstatSync(resolvedSrc).isDirectory;
            } catch { /* proceed */ }
            if (srcIsDir) {
              let effectiveDestExistsAsDir = false;
              try {
                effectiveDestExistsAsDir = Deno.lstatSync(effectiveDest).isDirectory;
              } catch {
                effectiveDestExistsAsDir = false;
              }
              if (!effectiveDestExistsAsDir) {
                this.#snapshotCandidate(
                  effectiveDest,
                  runState,
                  active,
                  baseDir,
                );
              }
              this.#snapshotCopiedTree(
                resolvedSrc,
                effectiveDest,
                runState,
                active,
                baseDir,
              );
            } else {
              this.#snapshotCandidate(
                effectiveDest,
                runState,
                active,
                baseDir,
              );
            }
          }
        } else {
          const src = sourceArgs[0]!;
          const resolvedSrc = normalizeFilePath(src, baseDir);
          let srcIsDir = false;
          try {
            srcIsDir = Deno.lstatSync(resolvedSrc).isDirectory;
          } catch { /* proceed */ }
          if (srcIsDir) {
            let destExistsAsDir = false;
            try {
              destExistsAsDir = Deno.lstatSync(resolvedLast).isDirectory;
            } catch {
              destExistsAsDir = false;
            }
            if (!destExistsAsDir) {
              this.#snapshotCandidate(resolvedLast, runState, active, baseDir);
            }
            this.#snapshotCopiedTree(
              resolvedSrc,
              resolvedLast,
              runState,
              active,
              baseDir,
            );
          } else {
            this.#snapshotCandidate(resolvedLast, runState, active, baseDir);
          }
        }
      } else if (sourceArgs.length === 1) {
        this.#snapshotCandidate(
          sourceArgs[0]!,
          runState,
          active,
          baseDir,
        );
      }
    }

    return runState;
  }

  override async output(): Promise<Deno.CommandOutput> {
    const runState = this.#prepareOutputs();
    try {
      const res = await super.output();
      this.#captureOutputs(runState);
      return res;
    } catch (err) {
      this.#captureOutputs(runState);
      throw err;
    }
  }

  override outputSync(): Deno.CommandOutput {
    const runState = this.#prepareOutputs();
    try {
      const res = super.outputSync();
      this.#captureOutputs(runState);
      return res;
    } catch (err) {
      this.#captureOutputs(runState);
      throw err;
    }
  }

  override spawn(): Deno.ChildProcess {
    const runState = this.#prepareOutputs();
    const child = super.spawn();
    const active = activeProofStorage.getStore();
    if (active) {
      active.trackedChildProcesses.push(child);
      child.status.then(() => {
        this.#captureOutputs(runState);
      }).catch(() => {});
    }
    return child;
  }
};

Deno.remove = async function (
  path: string | URL,
  options?: Deno.RemoveOptions,
) {
  const active = activeProofStorage.getStore();
  if (active && !isChromeProfilePath(path)) {
    const targetPath = await resolveTargetPath(path);
    return await proofPathLocks.withLock(targetPath, async () => {
      registerInFlightWrite(active, targetPath);
      const addedSnapshots: string[] = [];
      const isRecursive = Boolean(options?.recursive);
      let targetStat: Deno.FileInfo | null = null;
      try {
        targetStat = await Deno.lstat(targetPath);
      } catch { /* proceed */ }

      if (targetStat?.isDirectory && !isRecursive) {
        // Non-recursive removal can only succeed on an empty directory; do not snapshot descendants!
        if (!active.snapshots.has(targetPath)) {
          active.snapshots.set(targetPath, { isDirectory: true });
          active.snapshotSeq.set(targetPath, ++globalCommitSeq);
          recordPathSnapshot(targetPath, active.id, { isDirectory: true });
          addedSnapshots.push(targetPath);
        }
      } else {
        const prevSnapKeys = new Set(active.snapshots.keys());
        await snapshotPath(active.snapshots, targetPath);
        for (const k of active.snapshots.keys()) {
          if (!prevSnapKeys.has(k)) {
            addedSnapshots.push(k);
          }
        }
      }

      try {
        const res = await originalRemove(targetPath, options);
        active.lastWrittenBytes.set(targetPath, null);
        for (const key of active.snapshots.keys()) {
          if (key.startsWith(targetPath + "/")) {
            active.lastWrittenBytes.set(key, null);
          }
        }
        for (const key of active.lastWrittenBytes.keys()) {
          if (key.startsWith(targetPath + "/")) {
            active.lastWrittenBytes.set(key, null);
          }
        }
        return res;
      } catch (err) {
        // Discard snapshots only for paths that were NOT removed by this attempt.
        // Paths that were actually deleted before a partial recursive removal failed
        // (existed before and absent afterward) retain their snapshots and record deletion.
        // Paths that were already absent before this attempt must NOT record false deletion!
        for (const k of addedSnapshots) {
          let stillExists = false;
          try {
            stillExists = Boolean(await Deno.lstat(k));
          } catch {
            stillExists = false;
          }
          const existedBefore = active.snapshots.has(k) &&
            active.snapshots.get(k) !== null;
          if (!stillExists && existedBefore) {
            active.lastWrittenBytes.set(k, null);
          } else {
            active.snapshots.delete(k);
            active.snapshotSeq.delete(k);
            const chain = pathSnapshotChains.get(k);
            if (
              chain && chain.length > 0 &&
              chain[chain.length - 1]?.proofId === active.id
            ) {
              chain.pop();
              if (chain.length === 0) pathSnapshotChains.delete(k);
            }
          }
        }
        throw err;
      }
    });
  }
  return await originalRemove(path, options);
};

Deno.removeSync = function (path: string | URL, options?: Deno.RemoveOptions) {
  const active = activeProofStorage.getStore();
  if (active && !isChromeProfilePath(path)) {
    const targetPath = resolveTargetPathSync(path);
    if (proofPathLocks.isLocked(targetPath)) {
      throw new Deno.errors.Busy(
        `Resource busy: synchronous removal of '${targetPath}' is excluded while path is locked by conflicting proof transaction or rollback`,
      );
    }
    const addedSnapshots: string[] = [];
    const isRecursive = Boolean(options?.recursive);
    let targetStat: Deno.FileInfo | null = null;
    try {
      targetStat = Deno.lstatSync(targetPath);
    } catch { /* proceed */ }

    if (targetStat?.isDirectory && !isRecursive) {
      // Non-recursive removal can only succeed on an empty directory; do not snapshot descendants!
      if (!active.snapshots.has(targetPath)) {
        active.snapshots.set(targetPath, { isDirectory: true });
        active.snapshotSeq.set(targetPath, ++globalCommitSeq);
        recordPathSnapshot(targetPath, active.id, { isDirectory: true });
        addedSnapshots.push(targetPath);
      }
    } else {
      const prevSnapKeys = new Set(active.snapshots.keys());
      snapshotPathSync(active.snapshots, targetPath);
      for (const k of active.snapshots.keys()) {
        if (!prevSnapKeys.has(k)) {
          addedSnapshots.push(k);
        }
      }
    }

    try {
      const res = originalRemoveSync(targetPath, options);
      active.lastWrittenBytes.set(targetPath, null);
      for (const key of active.snapshots.keys()) {
        if (key.startsWith(targetPath + "/")) {
          active.lastWrittenBytes.set(key, null);
        }
      }
      for (const key of active.lastWrittenBytes.keys()) {
        if (key.startsWith(targetPath + "/")) {
          active.lastWrittenBytes.set(key, null);
        }
      }
      return res;
    } catch (err) {
      // Discard snapshots only for paths that were NOT removed by this attempt.
      // Paths that were actually deleted before a partial recursive removal failed
      // (existed before and absent afterward) retain their snapshots and record deletion.
      // Paths that were already absent before this attempt must NOT record false deletion!
      for (const k of addedSnapshots) {
        let stillExists = false;
        try {
          stillExists = Boolean(Deno.lstatSync(k));
        } catch {
          stillExists = false;
        }
        const existedBefore = active.snapshots.has(k) &&
          active.snapshots.get(k) !== null;
        if (!stillExists && existedBefore) {
          active.lastWrittenBytes.set(k, null);
        } else {
          active.snapshots.delete(k);
          active.snapshotSeq.delete(k);
          const chain = pathSnapshotChains.get(k);
          if (
            chain && chain.length > 0 &&
            chain[chain.length - 1]?.proofId === active.id
          ) {
            chain.pop();
            if (chain.length === 0) pathSnapshotChains.delete(k);
          }
        }
      }
      throw err;
    }
  }
  return originalRemoveSync(path, options);
};

Deno.copyFile = async function (fromPath: string | URL, toPath: string | URL) {
  const active = activeProofStorage.getStore();
  if (active) {
    const writeTarget = await resolveWritePath(toPath);
    return await proofPathLocks.withLock(writeTarget, async () => {
      registerInFlightWrite(active, writeTarget);
      const hadPriorSnapshot = active.snapshots.has(writeTarget);
      await snapshotPath(active.snapshots, writeTarget, {
        followSymlinkTarget: true,
      });
      const preEntry = active.snapshots.get(writeTarget);
      try {
        const res = await originalCopyFile(fromPath, writeTarget);
        try {
          active.lastWrittenBytes.set(
            writeTarget,
            await Deno.readFile(writeTarget),
          );
        } catch { /* ignore */ }
        return res;
      } catch (err) {
        // Inspect current disk state to check if destination was modified (e.g. partial copy before error)
        let modified = false;
        let currentBytes: Uint8Array | null = null;
        let currentExists = false;
        try {
          currentBytes = await Deno.readFile(writeTarget);
          currentExists = true;
        } catch {
          try {
            await Deno.lstat(writeTarget);
            currentExists = true;
          } catch {
            currentExists = false;
          }
        }

        if (preEntry === null) {
          modified = currentExists;
        } else if (preEntry instanceof Uint8Array) {
          modified = !currentExists || !currentBytes ||
            !bytesEqual(currentBytes, preEntry);
        } else {
          modified = true;
        }

        if (modified) {
          // Destination was modified before the error: retain the snapshot and record current written bytes
          if (currentExists && currentBytes) {
            active.lastWrittenBytes.set(writeTarget, currentBytes);
          } else if (!currentExists) {
            active.lastWrittenBytes.set(writeTarget, null);
          }
        } else {
          // Destination was untouched: discard snapshot introduced solely by this attempt
          if (!hadPriorSnapshot) {
            active.snapshots.delete(writeTarget);
            active.snapshotSeq.delete(writeTarget);
            const chain = pathSnapshotChains.get(writeTarget);
            if (
              chain && chain.length > 0 &&
              chain[chain.length - 1]?.proofId === active.id
            ) {
              chain.pop();
              if (chain.length === 0) pathSnapshotChains.delete(writeTarget);
            }
          }
        }
        throw err;
      }
    });
  }
  return await originalCopyFile(fromPath, toPath);
};

Deno.copyFileSync = function (fromPath: string | URL, toPath: string | URL) {
  const active = activeProofStorage.getStore();
  if (active) {
    const writeTarget = resolveWritePathSync(toPath);
    if (proofPathLocks.isLocked(writeTarget)) {
      throw new Deno.errors.Busy(
        `Resource busy: synchronous copy to '${writeTarget}' is excluded while path is locked by conflicting proof transaction or rollback`,
      );
    }
    registerInFlightWrite(active, writeTarget);
    const hadPriorSnapshot = active.snapshots.has(writeTarget);
    snapshotPathSync(active.snapshots, writeTarget, {
      followSymlinkTarget: true,
    });
    const preEntry = active.snapshots.get(writeTarget);
    try {
      const res = originalCopyFileSync(fromPath, writeTarget);
      try {
        active.lastWrittenBytes.set(
          writeTarget,
          Deno.readFileSync(writeTarget),
        );
      } catch { /* ignore */ }
      return res;
    } catch (err) {
      // Inspect current disk state to check if destination was modified (e.g. partial copy before error)
      let modified = false;
      let currentBytes: Uint8Array | null = null;
      let currentExists = false;
      try {
        currentBytes = Deno.readFileSync(writeTarget);
        currentExists = true;
      } catch {
        try {
          Deno.lstatSync(writeTarget);
          currentExists = true;
        } catch {
          currentExists = false;
        }
      }

      if (preEntry === null) {
        modified = currentExists;
      } else if (preEntry instanceof Uint8Array) {
        modified = !currentExists || !currentBytes ||
          !bytesEqual(currentBytes, preEntry);
      } else {
        modified = true;
      }

      if (modified) {
        // Destination was modified before the error: retain the snapshot and record current written bytes
        if (currentExists && currentBytes) {
          active.lastWrittenBytes.set(writeTarget, currentBytes);
        } else if (!currentExists) {
          active.lastWrittenBytes.set(writeTarget, null);
        }
      } else {
        // Destination was untouched: discard snapshot introduced solely by this attempt
        if (!hadPriorSnapshot) {
          active.snapshots.delete(writeTarget);
          active.snapshotSeq.delete(writeTarget);
          const chain = pathSnapshotChains.get(writeTarget);
          if (
            chain && chain.length > 0 &&
            chain[chain.length - 1]?.proofId === active.id
          ) {
            chain.pop();
            if (chain.length === 0) pathSnapshotChains.delete(writeTarget);
          }
        }
      }
      throw err;
    }
  }
  return originalCopyFileSync(fromPath, toPath);
};

function trackMissingAncestors(snapshots: Map<string, SnapshotEntry>, target: string) {
  let curr = target;
  const toAdd: string[] = [];
  while (true) {
    const parent = dirname(curr);
    if (!parent || parent === curr) break;
    if (snapshots.has(curr)) {
      curr = parent;
      continue;
    }
    try {
      Deno.lstatSync(curr);
      break;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        toAdd.push(curr);
        curr = parent;
      } else {
        break;
      }
    }
  }
  const active = activeProofStorage.getStore();
  for (const p of toAdd) {
    if (!snapshots.has(p)) {
      snapshots.set(p, null);
      if (active) {
        active.snapshotSeq.set(p, ++globalCommitSeq);
        recordPathSnapshot(p, active.id, null);
      }
    }
  }
}

Deno.mkdir = async function (path: string | URL, options?: Deno.MkdirOptions) {
  const active = activeProofStorage.getStore();
  if (active) {
    const targetPath = await resolveTargetPath(path);
    return await proofPathLocks.withLock(targetPath, async () => {
      registerInFlightWrite(active, targetPath);
      let existedBefore = false;
      try {
        existedBefore = Boolean(await Deno.lstat(targetPath));
      } catch { /* proceed */ }
      trackMissingAncestors(active.snapshots, targetPath);
      const res = await originalMkdir(targetPath, options);
      if (!existedBefore) {
        active.lastWrittenBytes.set(targetPath, { isDirectory: true });
      }
      return res;
    });
  }
  return await originalMkdir(path, options);
};

Deno.mkdirSync = function (path: string | URL, options?: Deno.MkdirOptions) {
  const active = activeProofStorage.getStore();
  if (active) {
    const targetPath = resolveTargetPathSync(path);
    if (proofPathLocks.isLocked(targetPath)) {
      throw new Deno.errors.Busy(
        `Resource busy: synchronous mkdir of '${targetPath}' is excluded while path is locked by conflicting proof transaction or rollback`,
      );
    }
    let existedBefore = false;
    try {
      existedBefore = Boolean(Deno.lstatSync(targetPath));
    } catch { /* proceed */ }
    trackMissingAncestors(active.snapshots, targetPath);
    const res = originalMkdirSync(targetPath, options);
    if (!existedBefore) {
      active.lastWrittenBytes.set(targetPath, { isDirectory: true });
    }
    return res;
  }
  return originalMkdirSync(path, options);
};

Deno.symlink = async function (
  oldPath: string | URL,
  newPath: string | URL,
  options?: Deno.SymlinkOptions,
) {
  const active = activeProofStorage.getStore();
  if (active) {
    const targetNewPath = await resolveTargetPath(newPath);
    return await proofPathLocks.withLock(targetNewPath, async () => {
      registerInFlightWrite(active, targetNewPath);
      await snapshotPath(active.snapshots, targetNewPath);
      const res = await originalSymlink(oldPath, targetNewPath, options);
      active.lastWrittenBytes.set(targetNewPath, { isSymlink: true, target: String(oldPath) });
      return res;
    });
  }
  return await originalSymlink(oldPath, newPath, options);
};

Deno.symlinkSync = function (
  oldPath: string | URL,
  newPath: string | URL,
  options?: Deno.SymlinkOptions,
) {
  const active = activeProofStorage.getStore();
  if (active) {
    const targetNewPath = resolveTargetPathSync(newPath);
    if (proofPathLocks.isLocked(targetNewPath)) {
      throw new Deno.errors.Busy(
        `Resource busy: synchronous symlink at '${targetNewPath}' is excluded while path is locked by conflicting proof transaction or rollback`,
      );
    }
    snapshotPathSync(active.snapshots, targetNewPath);
    const res = originalSymlinkSync(oldPath, targetNewPath, options);
    active.lastWrittenBytes.set(targetNewPath, { isSymlink: true, target: String(oldPath) });
    return res;
  }
  return originalSymlinkSync(oldPath, newPath, options);
};

function isWritableOpen(options?: Deno.OpenOptions): boolean {
  if (!options) return false;
  return Boolean(
    options.write || options.append || options.truncate || options.createNew ||
      (options.create && options.write),
  );
}

function wrapFsFile(
  handle: Deno.FsFile,
  active: ActiveProofContext,
  writeTarget: string,
): Deno.FsFile {
  const origWrite = handle.write.bind(handle);
  const origWriteSync = handle.writeSync.bind(handle);
  const origTruncate = handle.truncate.bind(handle);
  const origTruncateSync = handle.truncateSync.bind(handle);
  const origClose = handle.close.bind(handle);

  const captureDisk = () => {
    try {
      active.lastWrittenBytes.set(writeTarget, Deno.readFileSync(writeTarget));
    } catch { /* ignore */ }
  };

  handle.write = async function (p: Uint8Array): Promise<number> {
    return await proofPathLocks.withLock(writeTarget, async () => {
      registerInFlightWrite(active, writeTarget);
      await snapshotPath(active.snapshots, writeTarget);
      const res = await origWrite(p);
      captureDisk();
      return res;
    });
  };

  handle.writeSync = function (p: Uint8Array): number {
    if (proofPathLocks.isLocked(writeTarget)) {
      throw new Deno.errors.Busy(
        `Path ${writeTarget} is currently locked by a proof transaction or rollback`,
      );
    }
    registerInFlightWrite(active, writeTarget);
    snapshotPathSync(active.snapshots, writeTarget);
    const res = origWriteSync(p);
    captureDisk();
    return res;
  };

  handle.truncate = async function (len?: number): Promise<void> {
    return await proofPathLocks.withLock(writeTarget, async () => {
      registerInFlightWrite(active, writeTarget);
      await snapshotPath(active.snapshots, writeTarget);
      await origTruncate(len);
      captureDisk();
    });
  };

  handle.truncateSync = function (len?: number): void {
    if (proofPathLocks.isLocked(writeTarget)) {
      throw new Deno.errors.Busy(
        `Path ${writeTarget} is currently locked by a proof transaction or rollback`,
      );
    }
    registerInFlightWrite(active, writeTarget);
    snapshotPathSync(active.snapshots, writeTarget);
    origTruncateSync(len);
    captureDisk();
  };

  handle.close = function (): void {
    origClose();
  };

  return handle;
}

Deno.open = async function (
  path: string | URL,
  options?: Deno.OpenOptions,
): Promise<Deno.FsFile> {
  const active = activeProofStorage.getStore();
  if (active && isWritableOpen(options)) {
    if (options?.createNew) {
      let exists = false;
      try {
        const lstat = await Deno.lstat(normalizeFilePath(path));
        exists = Boolean(lstat);
      } catch { /* proceed */ }
      if (exists) {
        return await originalOpen(path, options);
      }
    }
    const writeTarget = await resolveWritePath(path);
    let beforeStat: Deno.FileInfo | null = null;
    let afterStat: Deno.FileInfo | null = null;
    const handle = await proofPathLocks.withLock(writeTarget, async () => {
      registerInFlightWrite(active, writeTarget);
      const capturedKeys = new Set<string>();
      try {
        try {
          beforeStat = await Deno.lstat(writeTarget);
        } catch { /* proceed */ }
        await snapshotPath(active.snapshots, writeTarget, { capturedKeys });
        const h = await originalOpen(writeTarget, options);
        try {
          afterStat = await Deno.lstat(writeTarget);
        } catch { /* proceed */ }
        if (!beforeStat && afterStat) {
          try {
            active.lastWrittenBytes.set(
              writeTarget,
              await Deno.readFile(writeTarget),
            );
          } catch { /* proceed */ }
        } else if (
          beforeStat && afterStat && options?.truncate && beforeStat.size > 0 &&
          afterStat.size === 0
        ) {
          try {
            active.lastWrittenBytes.set(
              writeTarget,
              await Deno.readFile(writeTarget),
            );
          } catch { /* proceed */ }
        }
        return h;
      } catch (err) {
        await discardFailedWriteSnapshots(active, capturedKeys, writeTarget);
        throw err;
      }
    });
    return wrapFsFile(handle, active, writeTarget);
  }
  return await originalOpen(path, options);
};

Deno.openSync = function (
  path: string | URL,
  options?: Deno.OpenOptions,
): Deno.FsFile {
  const active = activeProofStorage.getStore();
  if (active && isWritableOpen(options)) {
    if (options?.createNew) {
      let exists = false;
      try {
        const lstat = Deno.lstatSync(normalizeFilePath(path));
        exists = Boolean(lstat);
      } catch { /* proceed */ }
      if (exists) {
        return originalOpenSync(path, options);
      }
    }
    const writeTarget = resolveWritePathSync(path);
    if (proofPathLocks.isLocked(writeTarget)) {
      throw new Deno.errors.Busy(
        `Resource busy: synchronous open of '${writeTarget}' is excluded while path is locked by conflicting proof transaction or rollback`,
      );
    }
    registerInFlightWrite(active, writeTarget);
    const capturedKeys = new Set<string>();
    try {
      let beforeStat: Deno.FileInfo | null = null;
      try {
        beforeStat = Deno.lstatSync(writeTarget);
      } catch { /* proceed */ }
      snapshotPathSync(active.snapshots, writeTarget, { capturedKeys });
      const handle = originalOpenSync(writeTarget, options);
      let afterStat: Deno.FileInfo | null = null;
      try {
        afterStat = Deno.lstatSync(writeTarget);
      } catch { /* proceed */ }
      if (!beforeStat && afterStat) {
        try {
          active.lastWrittenBytes.set(
            writeTarget,
            Deno.readFileSync(writeTarget),
          );
        } catch { /* proceed */ }
      } else if (
        beforeStat && afterStat && options?.truncate && beforeStat.size > 0 &&
        afterStat.size === 0
      ) {
        try {
          active.lastWrittenBytes.set(
            writeTarget,
            Deno.readFileSync(writeTarget),
          );
        } catch { /* proceed */ }
      }
      return wrapFsFile(handle, active, writeTarget);
    } catch (err) {
      discardFailedWriteSnapshotsSync(active, capturedKeys, writeTarget);
      throw err;
    }
  }
  return originalOpenSync(path, options);
};

export async function runProof(
  name: string,
  body: (checker: Checker) => Promise<void> | void,
  options?: RunProofOptions | CheckLogger,
): Promise<void> {
  const runOptions: RunProofOptions | undefined = typeof options === "function"
    ? { logger: options }
    : options;
  const logger = runOptions?.logger;
  const checker = createCheckerInternal(true, logger);
  const snapshots = new Map<string, SnapshotEntry>();
  const snapshotSeq = new Map<string, number>();
  let resolveProofDone!: () => void;
  const completionPromise = new Promise<void>((r) => {
    resolveProofDone = r;
  });
  const startTime = Date.now();
  const proofId = ++globalProofSeq;
  activeProofCount++;
  const activeContext: ActiveProofContext = {
    id: proofId,
    name,
    checker,
    startTime,
    snapshots,
    snapshotSeq,
    completionPromise,
    trackedChildProcesses: [],
    lastWrittenBytes: new Map<string, SnapshotEntry>(),
  };

  return await activeProofStorage.run(activeContext, async () => {
    try {
      let bodyError: unknown = null;
      try {
        await body(checker);
      } catch (err) {
        bodyError = err;
      }

      // Await all tracked spawned child processes so their writes complete before commit or rollback
      if (activeContext.trackedChildProcesses.length > 0) {
        try {
          await Promise.all(activeContext.trackedChildProcesses.map((cp) => cp.status));
        } catch (err) {
          if (!bodyError) bodyError = err;
        }
      }

      let finishError: unknown = null;
      try {
        checker.finish();
      } catch (err) {
        finishError = err;
      }

      if (bodyError || finishError) {
        let rollbackError: unknown = null;
        if (runOptions?.rollbackHook) {
          try {
            await runOptions.rollbackHook("start");
          } catch (err) {
            rollbackError = err;
          }
        }
        failedProofs.add(proofId);
        const isCommittedByLaterProof = (p: string) => {
          const record = committedPathRecords.get(p);
          if (
            record &&
            record.proofId > proofId &&
            record.commitSeq > (snapshotSeq.get(p) ?? 0)
          ) {
            return true;
          }
          return false;
        };
        const getRollbackEntry = (filePath: string, fallback: SnapshotEntry): SnapshotEntry => {
          const record = committedPathRecords.get(filePath);
          if (record && record.commitSeq <= (snapshotSeq.get(filePath) ?? 0)) {
            return fallback;
          }
          if (record) {
            return record.entry;
          }
          return getSafeRestoreContent(filePath, proofId, fallback);
        };
        const waitForInFlightWrite = async (filePath: string) => {
          const inFlight = inFlightProofWrites.get(filePath);
          if (inFlight && inFlight.proofId !== proofId) {
            if (!wouldDeadlock(proofId, inFlight.proofId)) {
              proofWaitGraph.set(proofId, inFlight.proofId);
              try {
                await inFlight.done;
              } finally {
                proofWaitGraph.delete(proofId);
              }
            }
          }
        };

        // Helper to safely remove null entries while preserving directories that contain untracked children
        const safelyRemoveNullEntry = async (targetPath: string) => {
          try {
            const stat = await Deno.lstat(targetPath);
            if (stat.isDirectory) {
              let hasUntrackedChildren = false;
              try {
                for await (const entry of Deno.readDir(targetPath)) {
                  const childPath = `${targetPath}/${entry.name}`;
                  if (
                    !snapshots.has(childPath) || snapshots.get(childPath) !== null ||
                    isCommittedByLaterProof(childPath)
                  ) {
                    hasUntrackedChildren = true;
                    break;
                  }
                }
              } catch { /* ignore */ }
              if (!hasUntrackedChildren) {
                await originalRemove(targetPath);
              }
            } else {
              await originalRemove(targetPath);
            }
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) {
              if (!rollbackError) rollbackError = err;
            }
          }
        };

        // Roll back only files/directories/symlinks touched/created during this proof transaction
        // 1. First remove newly created paths (null entries), sorting children before parents
        const nullEntries = Array.from(snapshots.entries())
          .filter(([_, content]) => content === null)
          .sort((a, b) => b[0].length - a[0].length);
        for (const [filePath] of nullEntries) {
          await waitForInFlightWrite(filePath);
          await proofPathLocks.withLock(filePath, async () => {
            if (runOptions?.rollbackHook) {
              try {
                await runOptions.rollbackHook("lock-acquired", filePath);
              } catch (hookErr) {
                if (!rollbackError) rollbackError = hookErr;
              }
            }
            if (isCommittedByLaterProof(filePath)) return;
            const baseline = getRollbackEntry(filePath, null);
            if (baseline === null) {
              await safelyRemoveNullEntry(filePath);
            }
          });
        }
        // 2. Then restore pre-existing directories, files, and symlinks
        for (const [filePath, originalContent] of snapshots.entries()) {
          const restoreContent = getRollbackEntry(filePath, originalContent);
          if (restoreContent === null) continue;
          await waitForInFlightWrite(filePath);
          await proofPathLocks.withLock(filePath, async () => {
            if (runOptions?.rollbackHook) {
              try {
                await runOptions.rollbackHook("lock-acquired", filePath);
              } catch (hookErr) {
                if (!rollbackError) rollbackError = hookErr;
              }
            }
            if (isCommittedByLaterProof(filePath)) return;
            try {
              if (restoreContent instanceof Uint8Array) {
                const dir = dirname(filePath);
                try {
                  const currentStat = await Deno.lstat(filePath);
                  if (currentStat.isDirectory) {
                    let hasUntracked = false;
                    for await (const entry of Deno.readDir(filePath)) {
                      const child = `${filePath}/${entry.name}`;
                      if (
                        !snapshots.has(child) || snapshots.get(child) !== null ||
                        isCommittedByLaterProof(child)
                      ) {
                        hasUntracked = true;
                        break;
                      }
                    }
                    if (hasUntracked) {
                      // Relocate replacement directory to preserve another actor's untracked files with collision-safe name
                      let relocated = false;
                      for (let attempt = 0; attempt < 5; attempt++) {
                        const backup = `${filePath}.untracked-${Date.now()}-${crypto.randomUUID()}`;
                        try {
                          await originalRename(filePath, backup);
                          relocated = true;
                          break;
                        } catch { /* retry */ }
                      }
                      if (!relocated) {
                        throw new Error(
                          `Failed to relocate untracked directory at ${filePath} during rollback`,
                        );
                      }
                    } else {
                      await originalRemove(filePath, { recursive: true });
                    }
                  } else if (currentStat.isSymlink) {
                    await originalRemove(filePath);
                  }
                } catch { /* does not exist */ }
                await originalMkdir(dir, { recursive: true });
                await originalWriteFile(filePath, restoreContent);
              } else if ("isDirectory" in restoreContent) {
                try {
                  const currentStat = await Deno.lstat(filePath);
                  if (!currentStat.isDirectory) {
                    await originalRemove(filePath, { recursive: true });
                  }
                } catch { /* does not exist */ }
                await originalMkdir(filePath, { recursive: true });
              } else if ("isSymlink" in restoreContent) {
                try {
                  await originalRemove(filePath);
                } catch (err) {
                  if (!(err instanceof Deno.errors.NotFound)) throw err;
                }
                await Deno.symlink(restoreContent.target, filePath);
              }
            } catch (err) {
              if (!rollbackError) rollbackError = err;
            }
          });
        }

        if (rollbackError) {
          console.error(`Proof '${name}' rollback failed:`, rollbackError);
          if (bodyError instanceof Error) {
            if (!bodyError.cause) {
              bodyError.cause = rollbackError;
            } else {
              bodyError.cause = new AggregateError(
                [bodyError.cause, rollbackError],
                `Multiple failure causes during proof '${name}' (including rollback failure)`,
              );
            }
          } else if (finishError instanceof Error) {
            if (!finishError.cause) {
              finishError.cause = rollbackError;
            } else {
              finishError.cause = new AggregateError(
                [finishError.cause, rollbackError],
                `Multiple failure causes during proof '${name}' (including rollback failure)`,
              );
            }
          } else if (!bodyError && !finishError) {
            throw rollbackError;
          }
        }

        if (bodyError && finishError) {
          console.error(`Proof '${name}' failed with error:`, bodyError);
          console.error(`Checker also reported failures:`, finishError);
          if (bodyError instanceof Error) {
            if (!bodyError.cause) {
              bodyError.cause = finishError;
            } else {
              bodyError.cause = new AggregateError(
                [bodyError.cause, finishError],
                `Body error and checker failure during proof '${name}'`,
              );
            }
          }
          throw bodyError;
        }

        if (bodyError) {
          throw bodyError;
        }

        if (finishError) {
          throw finishError;
        }
      } else {
        // On success: mark ONLY actually mutated paths as committed with this proof's written bytes
        for (
          const [filePath, writtenEntry] of activeContext.lastWrittenBytes
            .entries()
        ) {
          const newSeq = ++globalCommitSeq;
          committedFileTimestamps.set(filePath, newSeq);
          committedPathRecords.set(filePath, {
            proofId,
            commitSeq: newSeq,
            entry: writtenEntry,
          });
        }
        for (const [filePath] of snapshots.entries()) {
          pathLastWriter.delete(filePath);
          pathSnapshotChains.delete(filePath);
        }
      }
    } finally {
      for (const [filePath] of snapshots.entries()) {
        if (inFlightProofWrites.get(filePath)?.proofId === proofId) {
          inFlightProofWrites.delete(filePath);
        }
      }
      resolveProofDone();
      activeProofCount--;
      if (activeProofCount === 0) {
        failedProofs.clear();
        pathSnapshotChains.clear();
        pathLastWriter.clear();
        committedPathRecords.clear();
      }
    }
  });
}

export function assertVisibleExpression(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) {
    return {
      found: false,
      scrollWidth: 0,
      clientWidth: 0,
      offsetHeight: 0,
      rectWidth: 0,
      rectHeight: 0,
      rectTop: 0,
      rectBottom: 0,
      viewportHeight: 0,
      inViewport: false,
    };
  }
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const inViewport = (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < vh &&
    rect.left < vw
  );
  return {
    found: true,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    offsetHeight: el.offsetHeight,
    rectWidth: rect.width,
    rectHeight: rect.height,
    rectTop: rect.top,
    rectBottom: rect.bottom,
    viewportHeight: vh,
    inViewport,
  };
})()`;
}

export interface ElementMeasurement {
  found: boolean;
  scrollWidth: number;
  clientWidth: number;
  offsetHeight: number;
  rectWidth: number;
  rectHeight: number;
  inViewport: boolean;
  rectTop?: number;
  rectBottom?: number;
  viewportHeight?: number;
  top?: number;
  bottom?: number;
  rect?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    width?: number;
    height?: number;
  };
}

export function isVisible(
  measurement: ElementMeasurement,
): { visible: boolean; reason: string } {
  if (!measurement.found) {
    return { visible: false, reason: "Element not found" };
  }
  if (
    measurement.rectWidth <= 0 ||
    measurement.rectHeight <= 0 ||
    measurement.offsetHeight <= 0
  ) {
    return { visible: false, reason: "Element has zero-size rendered box" };
  }
  if (measurement.scrollWidth > measurement.clientWidth + 1) {
    return {
      visible: false,
      reason:
        `Element content is clipped: scrollWidth (${measurement.scrollWidth}) > clientWidth + 1 (${
          measurement.clientWidth + 1
        })`,
    };
  }
  if (!measurement.inViewport) {
    return { visible: false, reason: "Element is outside viewport" };
  }
  return {
    visible: true,
    reason: "Element is rendered, visible in viewport, and not clipped",
  };
}

export function isFullyVisible(
  measurement: ElementMeasurement,
): { visible: boolean; reason: string } {
  const base = isVisible(measurement);
  if (!base.visible) {
    return base;
  }
  const top = measurement.rectTop ?? measurement.top ?? measurement.rect?.top;
  const bottom = measurement.rectBottom ?? measurement.bottom ?? measurement.rect?.bottom;
  const vh = measurement.viewportHeight ??
    (measurement as { innerHeight?: number }).innerHeight;

  if (top === undefined || bottom === undefined || vh === undefined) {
    return {
      visible: false,
      reason:
        "Element measurement lacks vertical coordinates or viewport height for strict containment",
    };
  }

  if (top < 0 || bottom > vh) {
    return {
      visible: false,
      reason:
        `Element is not fully in viewport: rect.top (${top}) >= 0 && rect.bottom (${bottom}) <= window.innerHeight (${vh}) is false`,
    };
  }

  return {
    visible: true,
    reason: "Element is rendered, fully visible in viewport, and not clipped",
  };
}

export interface EvidenceSection {
  heading: string;
  body: string;
}

export interface EvidenceReadmeOptions {
  dir: string;
  title: string;
  script?: string;
  asserts?: string[];
  capture?: boolean | string;
  captureReason?: string;
  sections?: EvidenceSection[];
  allowLocalhost?: boolean;
  executedBy?: string;
  checker?: Checker;
  /**
   * Free-text notes the generated README carries. For facts that must survive regeneration - e.g. a
   * coupling this evidence directory broke, which no assert expresses.
   */
  notes?: string[];
  /** Explicit opt-out for maintenance tools or tests running outside a proof transaction. */
  allowOutsideProof?: boolean;
}

export function formatEvidenceReadme(options: EvidenceReadmeOptions): string {
  const isCapture = Boolean(options.capture);
  let captureReason = "";
  if (isCapture) {
    if (typeof options.capture === "string" && options.capture.trim().length > 0) {
      captureReason = options.capture.trim();
    } else if (
      typeof options.captureReason === "string" &&
      options.captureReason.trim().length > 0
    ) {
      captureReason = options.captureReason.trim();
    } else {
      throw new Error("capture: true requires a mandatory one-line reason");
    }

    if (captureReason.includes("\n") || captureReason.includes("\r")) {
      throw new Error("capture reason must be a single line");
    }
  }

  let cleanedAsserts: string[] = [];
  if (!isCapture) {
    if (!options.asserts || !Array.isArray(options.asserts) || options.asserts.length === 0) {
      throw new Error(
        "writeEvidenceReadme requires either a non-empty asserts array or capture: true with a reason",
      );
    }
    cleanedAsserts = options.asserts.map((a) => a.trim()).filter((a) => a.length > 0);
    if (cleanedAsserts.length === 0) {
      throw new Error("writeEvidenceReadme requires a non-empty asserts array");
    }
    if (!options.script || !options.script.trim()) {
      throw new Error(
        "writeEvidenceReadme with asserts requires a script (e.g. 'scripts/my-proof.ts')",
      );
    }
  }

  if (options.executedBy?.trim() && !options.script?.trim()) {
    throw new Error(
      "writeEvidenceReadme with executedBy requires a script (e.g. 'scripts/my-proof.ts')",
    );
  }

  const lines: string[] = [`# ${options.title.trim()}`, ""];

  if (options.script?.trim()) {
    lines.push(`- Script: ${options.script.trim()}`);
  }

  if (options.executedBy?.trim()) {
    lines.push(`- Executed by: ${options.executedBy.trim()}`);
  }

  if (options.notes) {
    const cleanedNotes = options.notes.map((n) => n.trim()).filter((n) => n.length > 0);
    if (cleanedNotes.length > 0) lines.push(`- Notes: ${cleanedNotes.join("; ")}`);
  }

  if (isCapture) {
    lines.push("- Capture: no assertions");
    lines.push("");
    lines.push(captureReason);
  } else {
    lines.push(`- Asserts: ${cleanedAsserts.join("; ")}`);
  }

  if (options.sections && options.sections.length > 0) {
    for (const section of options.sections) {
      lines.push("");
      lines.push(`## ${section.heading.trim()}`);
      lines.push("");
      lines.push(section.body.trim());
    }
  }
  lines.push("");

  const content = lines.join("\n");

  if (!options.allowLocalhost) {
    const localhostMatch = content.match(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d+/i);
    if (localhostMatch) {
      throw new Error(
        `Evidence README cannot contain ephemeral localhost URL '${
          localhostMatch[0]
        }'. Proof docs must not hardcode ephemeral ports. Pass allowLocalhost: true if strictly required.`,
      );
    }
  }

  const shaMatch = content.match(/(?<![\w-])([0-9a-fA-F]{7,40})(?![\w-])/);
  if (shaMatch) {
    throw new Error(
      `Evidence README cannot contain bare commit SHA token '${
        shaMatch[0]
      }'. Docs must name the command that regenerates the artifact, not a sha that goes stale.`,
    );
  }

  return content;
}

export async function writeEvidenceReadme(
  options: EvidenceReadmeOptions,
): Promise<string> {
  const activeProof = activeProofStorage.getStore();
  if (!activeProof && !options.allowOutsideProof) {
    throw new Error(
      `writeEvidenceReadme() called outside of runProof() context for '${
        options.script ?? options.dir
      }'. Evidence must be written inside await runProof(name, async (checker) => { ... }) to ensure atomic rollback and transactional integrity. (Pass allowOutsideProof: true only for non-proof maintenance tools).`,
    );
  }
  const checkers: Checker[] = [];
  if (activeProof?.checker) {
    checkers.push(activeProof.checker);
  }
  if (options.checker && options.checker !== activeProof?.checker) {
    checkers.push(options.checker);
  }
  for (const checker of checkers) {
    if (checker.failures.length > 0) {
      const summary = checker.failures
        .map((f) => f.detail ? `${f.name} (${f.detail})` : f.name)
        .join("; ");
      const proofLabel = activeProof?.name ? ` for proof '${activeProof.name}'` : "";
      throw new Error(
        `Refusing to write evidence README${proofLabel}: proof has ${checker.failures.length} recorded failure(s): ${summary}`,
      );
    }
  }

  const content = formatEvidenceReadme(options);
  await Deno.mkdir(options.dir, { recursive: true });
  const cleanDir = options.dir.replace(/\/+$/, "");
  const readmePath = `${cleanDir}/README.md`;
  // audio-feed-i98g1: a README that a human curates AND a proof regenerates is a two-writer file, and
  // the overwrite here used to be the second writer that always won - one run of
  // playback-position-browser-proof deleted 26 lines of hand-written prose from
  // docs/evidence/audio-feed-kzi/README.md. The house mechanism is the marker-delimited generated
  // region (scripts/evidence-readme.ts, audio-feed-pluv): when the committed README carries the
  // markers, write ONLY the generated region and preserve everything a human wrote outside it.
  // A README without the markers keeps the historical overwrite - migration is a deliberate per-file
  // decision, never injected here. A file that HAS markers but malformed ones (missing, duplicated,
  // reversed) falls through to mergeGeneratedRegion and THROWS loudly: refuse to guess, and above all
  // refuse to strip prose because the region could not be parsed.
  const existing = await readEvidenceReadmeIfExists(readmePath);
  if (existing !== null && hasGeneratedRegion(existing)) {
    // mergeGeneratedRegion runs BEFORE the write: a malformed region throws and leaves the file
    // exactly as it was, rather than half-written or overwritten.
    await Deno.writeTextFile(readmePath, mergeGeneratedRegion(existing, content));
    return readmePath;
  }
  await Deno.writeTextFile(readmePath, content);
  return readmePath;
}

export interface InProcessServerOptions {
  hostname?: string;
  publicBaseUrl?: string;
  allowedHosts?: string[];
}

export interface InProcessServer {
  port: number;
  base: string;
  shutdown: () => Promise<void>;
}

export function startInProcessServer(
  handler: (req: Request, info: Deno.ServeHandlerInfo) => Response | Promise<Response>,
  options: InProcessServerOptions = {},
): InProcessServer {
  const hostname = options.hostname ?? "127.0.0.1";

  const wrappedHandler = (
    req: Request,
    info: Deno.ServeHandlerInfo,
  ): Response | Promise<Response> => {
    if (options.allowedHosts && options.allowedHosts.length > 0) {
      const url = new URL(req.url);
      const host = url.hostname;
      const reqHostHeader = req.headers.get("host")?.split(":")[0] ?? host;
      const isAllowed = options.allowedHosts.some(
        (h) => h === host || h === reqHostHeader || h === "*",
      );
      if (!isAllowed) {
        return new Response("Forbidden: host not allowed", { status: 403 });
      }
    }
    return handler(req, info);
  };

  const server = Deno.serve(
    {
      port: 0,
      hostname,
      onListen: () => {},
    },
    wrappedHandler,
  );

  const port = (server.addr as Deno.NetAddr).port;
  let base: string;
  if (options.publicBaseUrl) {
    base = options.publicBaseUrl.includes(":0")
      ? options.publicBaseUrl.replace(":0", `:${port}`)
      : options.publicBaseUrl;
  } else {
    const baseHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
    base = `http://${baseHost}:${port}`;
  }

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (timeoutMs = 5000): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        await Promise.race([
          server.shutdown(),
          new Promise((r) => setTimeout(r, timeoutMs)),
        ]);
      } catch {
        // idempotent and safe
      }
    })();
    return shutdownPromise;
  };

  return { port, base, shutdown };
}

/**
 * Kill a Chrome process this test launched, and WAIT for it to exit (audio-feed-wj8o2).
 *
 * The kill alone is not a teardown. Chrome's CHILDREN outlive the parent by long enough to keep writing into the
 * profile - which is how the browser rows leaked one scratch directory per run: cleanup() succeeded, the row
 * removed the parent, and the children recreated the profile inside it. This is the kill-then-await-status pattern
 * launchChrome's close() has always used, so a test that launches Chrome itself behaves the same way.
 */
/**
 * Write a run-owned SCRATCH file (a fixture, never evidence) (audio-feed-d82rv).
 *
 * A browser proof that fills a file input through CDP DOM.setFileInputFiles needs real
 * paths on disk, and those paths live under the run-owned makeTempDir root, never under
 * docs/evidence. Writing them through this helper keeps the proof's OWN source free of
 * raw Deno.writeFile call sites, which the evidence census (scripts/evidence-census.ts)
 * counts as unattributable writes: a template target like `${SCRATCH}/x.pdf` resolves to
 * nothing the census can name, and an unattributable write reddens the proof as a blind
 * spot (audio-feed-0gbo) even though the destination is provably not evidence. Routing the
 * write here states the contract once: scratch files are run-owned, temporary, and removed
 * with the scratch root by removeDirWhenQuiet.
 */
export async function writeScratchFile(
  scratchRoot: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const path = `${scratchRoot}/${name}`;
  await Deno.writeFile(path, bytes);
  return path;
}

export async function killChromeAndWait(chrome: Deno.ChildProcess): Promise<void> {
  try {
    chrome.kill();
  } catch {
    // Already gone: a row may have watched it exit itself.
  }
  await chrome.status.catch(() => {});
}

/**
 * Remove a directory that a dying process may still be recreating, and report whether it is finally gone
 * (audio-feed-wj8o2).
 *
 * It re-checks rather than sleeping a fixed time: it returns as soon as a check finds the directory absent, and
 * gives up after `attempts` x `settleMs` (~1s by default). The RETURN VALUE is the point - callers assert it
 * instead of swallowing the failure, because the failure this exists for (a child recreating the profile after
 * cleanup() had removed it) was invisible while every removal ended in `.catch(() => {})`.
 */
export async function removeDirWhenQuiet(
  dir: string,
  opts: { attempts?: number; settleMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 20;
  const settleMs = opts.settleMs ?? 50;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    if (attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (!exists(dir)) return true;
  }
  return !exists(dir);
}

/**
 * Whether no process still references a Chrome profile directory (audio-feed-wj8o2).
 *
 * "The directory is deleted" is not "nothing is still writing where it was": a Chrome child can outlive the parent
 * with the profile path on its own command line. This asks the process table via `ps` rather than reading
 * /proc/<pid>, because reading /proc is documented as denied in at least one sandboxed context in this repo
 * (tests/fast_check_test.ts:1129), while `ps` is available wherever the suite runs with --allow-run.
 *
 * Fails CLOSED: if `ps` cannot run it throws, so a broken probe cannot become a green assertion.
 */
/**
 * Pids from this process up to init, via `ps -eo pid,ppid`.
 *
 * audio-feed-ubjt1: used to ignore OUR OWN command line. Upwards ONLY - a child of this run is not an ancestor, so a
 * leftover harness or browser that this run spawned still counts as a leftover.
 */
async function ancestorPids(): Promise<Set<number>> {
  const listing = await new Deno.Command("ps", { args: ["-eo", "pid,ppid"] }).output();
  if (!listing.success) {
    throw new Error(
      `ps -eo pid,ppid exited ${listing.code}: cannot determine this process's ancestors`,
    );
  }
  const parents = new Map<number, number>();
  for (const line of new TextDecoder().decode(listing.stdout).split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) parents.set(pid, ppid);
  }
  const ancestors = new Set<number>();
  let pid = Deno.pid;
  while (pid > 0 && !ancestors.has(pid)) {
    ancestors.add(pid);
    pid = parents.get(pid) ?? 0;
  }
  return ancestors;
}

/**
 * Whether a process's rendered argument list references `profileDir` as its OWN `--user-data-dir` value.
 *
 * audio-feed-pclwg: `args.includes("--user-data-dir=" + profileDir)` is a PREFIX match, so the profile `/tmp/x` was
 * reported as used whenever a DIFFERENT profile `/tmp/x-other` was on some command line. The value has to end at an
 * argument boundary: `ps -eo args` joins argv with single spaces, so end-of-string, a space, or a quote terminates it.
 * A trailing separator is accepted because a browser launched with `/tmp/x/` is using `/tmp/x`.
 */
function referencesProfile(args: string, profileDir: string): boolean {
  for (const flag of [`--user-data-dir=${profileDir}`, `--user-data-dir=${profileDir}/`]) {
    let from = 0;
    for (;;) {
      const at = args.indexOf(flag, from);
      if (at < 0) break;
      const next = args[at + flag.length];
      if (next === undefined || next === " " || next === "\t" || next === '"' || next === "'") {
        return true;
      }
      from = at + flag.length;
    }
  }
  return false;
}

export async function waitForChromeProfileUnused(
  profileDir: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  // 2s default timeout: caller teardowns (e.g. listen_activity_test) assert unused profile cleanup; a delayed process reap past 2s will redden the caller's teardown.
  const timeoutMs = opts.timeoutMs ?? 2000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  // audio-feed-ubjt1: SCOPED, NOT QUIETER. Two narrow rules, and deliberately no third:
  //   1. SIGNAL - a browser child carries `--user-data-dir=<profile>` as an argument. Matching the FLAG rather than
  //      the bare path is what stops a caller counting itself: regenerate-browser-proof.ts takes profileDir through
  //      Deno.args, so the invocation has the path on its command line.
  //   2. ANCESTRY - this process and its PARENTS are ignored. Upwards only: a child of this run is not an ancestor
  //      and still counts, so a leftover harness/browser that this run spawned cannot be excluded by this rule.
  //   3. THERE IS NO PATTERN RULE. Nothing like "ignore processes whose args mention audiofeed" - that breadth would
  //      also ignore a real leftover harness, which is the leak this detector exists to find.
  const ignored = await ancestorPids();
  for (;;) {
    const listing = await new Deno.Command("ps", { args: ["-eo", "pid,args"] }).output();
    if (!listing.success) {
      throw new Error(
        `ps -eo pid,args exited ${listing.code}: cannot prove that no process still references '${profileDir}'`,
      );
    }
    const referencing = new TextDecoder().decode(listing.stdout).split("\n").slice(1)
      .map((line) => {
        const trimmed = line.trim();
        const split = trimmed.indexOf(" ");
        return split < 0
          ? { pid: 0, args: "" }
          : { pid: Number(trimmed.slice(0, split)), args: trimmed.slice(split + 1) };
      })
      .filter((entry) => !ignored.has(entry.pid) && referencesProfile(entry.args, profileDir));
    if (referencing.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
