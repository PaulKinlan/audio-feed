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

export interface SupervisedHarness {
  port: number;
  base: string;
  process: Deno.ChildProcess;
  getLogs: () => { stdout: string; stderr: string };
  kill: () => void;
}

export async function createTempChromeProfile(
  prefix = "audiofeed-chrome-",
): Promise<{ profileDir: string; cleanup: () => Promise<void> }> {
  const profileDir = await Deno.makeTempDir({ prefix });
  let cleaned = false;

  return {
    profileDir,
    cleanup: async () => {
      if (cleaned) return;
      const maxAttempts = 10;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await Deno.remove(profileDir, { recursive: true });
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

export type RunProofOptions = CheckerOptions;

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

export interface ActiveProofContext {
  name: string;
  checker: Checker;
}

const activeProofStorage = new AsyncLocalStorage<ActiveProofContext>();

export function getActiveProof(): ActiveProofContext | undefined {
  return activeProofStorage.getStore();
}

export async function runProof(
  name: string,
  body: (checker: Checker) => Promise<void> | void,
  options?: RunProofOptions | CheckLogger,
): Promise<void> {
  const logger = typeof options === "function" ? options : options?.logger;
  const checker = createCheckerInternal(true, logger);
  let bodyError: unknown = null;
  try {
    await activeProofStorage.run({ name, checker }, async () => {
      await body(checker);
    });
  } catch (err) {
    bodyError = err;
  }

  let finishError: unknown = null;
  try {
    checker.finish();
  } catch (err) {
    finishError = err;
  }

  if (bodyError && finishError) {
    console.error(`Proof '${name}' failed with error:`, bodyError);
    console.error(`Checker also reported failures:`, finishError);
    if (bodyError instanceof Error && !bodyError.cause) {
      bodyError.cause = finishError;
    }
    throw bodyError;
  }

  if (bodyError) {
    throw bodyError;
  }

  if (finishError) {
    throw finishError;
  }
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
}

export async function writeEvidenceReadme(
  options: EvidenceReadmeOptions,
): Promise<string> {
  const activeProof = activeProofStorage.getStore();
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
