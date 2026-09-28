/**
 * Shared test & proof harness utilities (audio-feed-9se).
 *
 * Solves:
 * 1. Port conflicts: binds port 0 and reads back the assigned ephemeral port.
 * 2. Profile collisions: allocates unique isolated Chrome user-data-dir via Deno.makeTempDir.
 * 3. Harness visibility: captures and retains harness stdout & stderr.
 * 4. Premature exit detection: monitors harness process status during health check loop
 *    and fails fast if the child process dies or /health never answers.
 */

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
  return {
    profileDir,
    cleanup: async () => {
      await Deno.remove(profileDir, { recursive: true }).catch(() => {});
    },
  };
}

export function newestChrome(): string {
  const home = Deno.env.get("HOME") ?? "";
  const root = `${home}/.cache/puppeteer/chrome`;
  const dirs = [...Deno.readDirSync(root)].filter((d) => d.isDirectory).map((d) => d.name).sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );
  if (dirs.length === 0) {
    throw new Error(`No Chrome binaries found under ${root}`);
  }
  return `${root}/${dirs.at(-1)}/chrome-linux64/chrome`;
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
      try {
        const res = await fetch(`http://localhost:${assignedPort}${healthPath}`);
        if (res.ok) {
          if (exited) {
            throw new Error(
              `Harness '${scriptRelPath}' exited with code ${exitCode} immediately after answering health check.`,
            );
          }
          return {
            port: assignedPort,
            base: `http://localhost:${assignedPort}`,
            process,
            getLogs: () => ({ stdout: stdoutBuf, stderr: stderrBuf }),
            kill: () => {
              try { process.kill(); } catch { /* ignore */ }
            },
          };
        }
      } catch {
        // Not responding yet
      }
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  try { process.kill(); } catch { /* ignore */ }
  throw new Error(
    `Harness '${scriptRelPath}' timed out after ${timeoutMs}ms waiting for ${healthPath}.\n` +
      `Assigned port: ${assignedPort}\nStdout:\n${stdoutBuf}\nStderr:\n${stderrBuf}`,
  );
}
