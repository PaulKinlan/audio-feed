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

export interface SupervisedHarness {
  port: number;
  base: string;
  process: Deno.ChildProcess;
  getLogs: () => { stdout: string; stderr: string };
  kill: () => void;
}

/**
 * HOW LONG AN ABANDONED PROFILE MAY SIT BEFORE THE NEXT RUN OF THE SAME PREFIX RECLAIMS IT
 * (audio-feed-u8nv).
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
 * THE BOUND IS THE REAPER'S OWN, AND THAT IS WHY IT IS PROVABLY SAFE RATHER THAN CONVENIENT: the
 * reaper's documented rule on every fleet VM is "browsers older than 45 min (orphaned ones after 5)",
 * so NO LIVE BROWSER CAN OWN A PROFILE OLDER THAN 45 MINUTES. Anything past that bound is therefore
 * not merely probably abandoned, it CANNOT be running. The earlier 2-hour figure was empirical
 * ("no legitimate run holds one for more than minutes") and that is a weaker argument for the same
 * decision, so it is replaced by the derivation.
 */
export const STALE_PROFILE_AGE_MS = 45 * 60 * 1000;

/**
 * Reclaim abandoned profile directories for ONE PREFIX (audio-feed-u8nv).
 *
 * TWO GUARDS, AND BOTH ARE ASSERTED IN tests/proof_helper_profile_sweep_test.ts BECAUSE EACH IS A
 * DIFFERENT WAY OF DESTROYING SOMETHING THAT IS IN USE:
 *   - PREFIX SCOPING: every caller passes its own prefix, so this can never reach another proof's,
 *     another lane's, or another prefix's directory. Only `makeTempDir`-created DIRECTORIES are
 *     considered; a file that happens to share the name shape is not ours to delete.
 *   - AGE BOUND: a young directory may be a LIVE run of the same prefix, so it is left alone. The
 *     reclaim only ever removes what the declared bound has already ruled out as running.
 *
 * OPPORTUNISTIC BY CONSTRUCTION: every failure to read or remove is swallowed, because reclaiming
 * disk must never break allocating a profile. Returns what it actually removed so a caller, or a
 * test, can observe the work rather than trust it.
 */
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
 * Whether `name` is a directory THIS prefix created, rather than a sibling that merely starts with it
 * (audio-feed-3nit).
 *
 * `startsWith(prefix)` ALONE IS NOT OWNERSHIP, and the reviewer's counterexample is exact:
 * `audiofeed-chrome-test-` starts with `audiofeed-chrome-`, so a sweep for the shorter prefix ate the
 * longer prefix's directories. A guard whose job is "touch nothing that is not mine" cannot be built
 * from a prefix comparison alone.
 *
 * THE BOUNDARY, AND WHY THIS ONE IS EXACT RATHER THAN HEURISTIC: `makeTempDir` appends its random
 * characters DIRECTLY to the prefix, so an owned name is `<prefix>` plus a separator-free tail.
 * MEASURED over the whole pile on this VM: 574 names, EVERY ONE with a separator-free tail, and ZERO
 * with a `-` in the tail. So a `-` after the prefix does not mean "random characters"; it means a
 * DIFFERENT prefix that happens to start with ours.
 *
 * DECLARED LIMIT, so the next reader does not have to infer it: this requires the caller's prefix to
 * carry its own separator. Every prefix in this tree ends with `-` (measured: the nine literal ones
 * plus the computed `audiofeed-proof-exww-`), and a prefix passed WITHOUT one would reclaim nothing
 * rather than reclaim wrongly - the failure is in the safe direction.
 */
function isOwnProfileName(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false;
  const tail = name.slice(prefix.length);
  if (tail.length === 0) return false;
  return !tail.includes("-");
}

export async function sweepStaleProfiles(
  prefix: string,
  nowMs: number = Date.now(),
  ageMs: number = STALE_PROFILE_AGE_MS,
): Promise<string[]> {
  const swept: string[] = [];
  // The SAME base directory makeTempDir uses, or the sweep would look somewhere the profiles are not.
  const baseDir = Deno.env.get("TMPDIR") ?? "/tmp";
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(baseDir);
  } catch {
    return swept;
  }
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (!isOwnProfileName(entry.name, prefix)) continue;
    const full = `${baseDir}/${entry.name}`;
    // INSURANCE, NOT THE MATCHING RULE (audio-feed-u8nv, after coord measured the other /tmp piles as
    // worktrees): a checkout is never a profile, so one that happens to sit under a profile prefix is
    // left alone. This can only NARROW what is reclaimed. `.git` is tested by EXISTENCE because in a
    // linked worktree it is a FILE, not a directory.
    if (exists(`${full}/.git`)) continue;
    try {
      const info = await Deno.stat(full);
      const age = nowMs - (info.mtime?.getTime() ?? nowMs);
      if (age < ageMs) continue;
      await originalRemove(full, { recursive: true });
      swept.push(full);
    } catch {
      // A live run, a concurrent reclaim, or a permission we do not have: leave it, never throw.
    }
  }
  return swept;
}

export async function createTempChromeProfile(
  prefix = "audiofeed-chrome-",
): Promise<{ profileDir: string; cleanup: () => Promise<void>; sweptStale: number }> {
  // Reclaim THIS prefix's abandoned directories before allocating another one, so a leak cannot
  // accumulate across runs (audio-feed-u8nv).
  const sweptStale = (await sweepStaleProfiles(prefix)).length;
  const profileDir = await Deno.makeTempDir({ prefix });
  const normProfileDir = normalizeFilePath(profileDir);
  activeChromeProfiles.add(normProfileDir);
  let cleaned = false;

  return {
    profileDir,
    sweptStale,
    cleanup: async () => {
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

export function newestChrome(chromeCacheRoot?: string): string {
  if (!chromeCacheRoot) {
    const envBin = Deno.env.get("AUDIOFEED_CHROME_BIN");
    if (envBin && envBin.trim().length > 0) {
      return envBin.trim();
    }
  }
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

export function resolveChromeBinary(override?: string): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const envBin = Deno.env.get("AUDIOFEED_CHROME_BIN");
  if (envBin && envBin.trim().length > 0) {
    return envBin.trim();
  }
  return newestChrome();
}

export interface ChromeLaunchOptions {
  binary?: string;
  prefix?: string;
  args?: string[];
  portTimeoutMs?: number;
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
  const binary = resolveChromeBinary(opts.binary);
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
    profile = await createTempChromeProfile(prefix);
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
    const portTimeoutMs = opts.portTimeoutMs ?? 10_000;
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

export async function spawnHarness(
  scriptRelPath: string,
  extraArgs: string[] = [],
  options: { healthPath?: string; timeoutMs?: number } = {},
): Promise<SupervisedHarness> {
  const healthPath = options.healthPath ?? "/health";
  const timeoutMs = options.timeoutMs ?? 15_000;
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

  // Pipe and accumulate stdout in background
  (async () => {
    try {
      for await (const chunk of process.stdout) {
        stdoutBuf += textDecoder.decode(chunk, { stream: true });
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
  process.status.then((st) => {
    exited = true;
    exitCode = st.code;
  }).catch(() => {});

  const startTime = Date.now();
  let assignedPort: number | null = null;

  while (Date.now() - startTime < timeoutMs) {
    if (exited) {
      throw new Error(
        `Harness '${scriptRelPath}' exited prematurely with code ${exitCode} before answering health check.\n` +
          `Stdout:\n${stdoutBuf}\nStderr:\n${stderrBuf}`,
      );
    }

    if (!assignedPort) {
      const match = /READY port=(\d+)/.exec(stdoutBuf) ??
        /http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(stdoutBuf);
      if (match) {
        assignedPort = Number(match[1]);
      }
    }

    if (assignedPort) {
      let res: Response | null = null;
      try {
        res = await fetch(`http://localhost:${assignedPort}${healthPath}`);
      } catch {
        // Socket not open or not responding yet
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
        return {
          port: assignedPort,
          base: `http://localhost:${assignedPort}`,
          process,
          getLogs: () => ({ stdout: stdoutBuf, stderr: stderrBuf }),
          kill: () => {
            try {
              process.kill();
            } catch { /* ignore */ }
          },
        };
      }
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    process.kill();
  } catch { /* ignore */ }
  throw new Error(
    `Harness '${scriptRelPath}' timed out after ${timeoutMs}ms waiting for ${healthPath}.\n` +
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
  /** Explicit opt-out for maintenance tools or tests running outside a proof transaction. */
  allowOutsideProof?: boolean;
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

  await Deno.mkdir(options.dir, { recursive: true });
  const cleanDir = options.dir.replace(/\/+$/, "");
  const readmePath = `${cleanDir}/README.md`;
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
