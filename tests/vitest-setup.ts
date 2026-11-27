/**
 * Vitest global setup bridging legacy `Deno.*` test APIs to standard Node 22+ & Vitest APIs.
 * Allows running the entire test suite directly on Node + Vitest with zero Deno installation.
 */

import { test as vitestTest } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { registerLocalMetadataOpener } from "../src/config.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import { createTestD1 } from "./sqlite_d1.ts";

registerLocalMetadataOpener((path) => {
  const d1 = createTestD1(path && path !== ":memory:" ? path : ":memory:");
  const store = new D1MetadataStore(d1);
  const origClose = store.close.bind(store);
  store.close = async () => {
    await origClose();
    d1.close();
  };
  return Promise.resolve(store);
});

const pendingListeners = new Set<Promise<void>>();
let ephemeralPortCursor = 32000 + ((process.pid * 73) % 20000);

// Node's Undici Request requires `duplex: "half"` when `body` is a ReadableStream.
const NativeRequest = globalThis.Request;
globalThis.Request = class PatchedRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init && init.body instanceof ReadableStream && !("duplex" in init)) {
      super(input, { ...init, duplex: "half" } as RequestInit);
    } else {
      super(input, init);
    }
  }
} as typeof Request;

// Wait for any just-started Deno.serve() loopback listener before issuing loopback fetch.
const NativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (pendingListeners.size > 0) {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (urlStr.startsWith("http://127.0.0.1:") || urlStr.startsWith("http://localhost:")) {
      await Promise.all([...pendingListeners]);
    }
  }
  return NativeFetch(input, init);
}) as typeof fetch;

interface DenoTestContext {
  name: string;
  step(name: string, fn: (t: DenoTestContext) => void | Promise<void>): Promise<boolean>;
  step(def: { name: string; fn: (t: DenoTestContext) => void | Promise<void> }): Promise<boolean>;
}

function makeTestContext(name: string): DenoTestContext {
  return {
    name,
    async step(
      nameOrDef: string | { name: string; fn: (t: DenoTestContext) => void | Promise<void> },
      maybeFn?: (t: DenoTestContext) => void | Promise<void>,
    ): Promise<boolean> {
      const stepName = typeof nameOrDef === "string" ? nameOrDef : nameOrDef.name;
      const fn = typeof nameOrDef === "string" ? maybeFn! : nameOrDef.fn;
      await fn(makeTestContext(stepName));
      return true;
    },
  };
}

function denoTest(
  nameOrDef:
    | string
    | {
      name: string;
      fn: (t: DenoTestContext) => void | Promise<void>;
      ignore?: boolean;
      only?: boolean;
    },
  optsOrFn?:
    | ((t: DenoTestContext) => void | Promise<void>)
    | { ignore?: boolean; only?: boolean; sanitizeResources?: boolean; sanitizeOps?: boolean },
  maybeFn?: (t: DenoTestContext) => void | Promise<void>,
): void {
  let name: string;
  let fn: (t: DenoTestContext) => void | Promise<void>;
  let ignore = false;
  let only = false;

  if (typeof nameOrDef === "string") {
    name = nameOrDef;
    if (typeof optsOrFn === "function") {
      fn = optsOrFn;
    } else {
      ignore = Boolean(optsOrFn?.ignore);
      only = Boolean(optsOrFn?.only);
      fn = maybeFn!;
    }
  } else {
    name = nameOrDef.name;
    fn = nameOrDef.fn;
    ignore = Boolean(nameOrDef.ignore);
    only = Boolean(nameOrDef.only);
  }

  const wrapped = async () => {
    await fn(makeTestContext(name));
  };

  if (ignore) {
    vitestTest.skip(name, wrapped);
  } else if (only) {
    vitestTest.only(name, wrapped);
  } else {
    vitestTest(name, wrapped);
  }
}

function denoServe(
  optsOrHandler:
    | {
      port?: number;
      hostname?: string;
      signal?: AbortSignal;
      onListen?: (addr: { hostname: string; port: number }) => void;
    }
    | ((req: Request, info: { remoteAddr: { hostname: string; port: number; transport: "tcp" } }) => Response | Promise<Response>),
  maybeHandler?: (
    req: Request,
    info: { remoteAddr: { hostname: string; port: number; transport: "tcp" } },
  ) => Response | Promise<Response>,
) {
  const opts = typeof optsOrHandler === "function" ? {} : optsOrHandler;
  const handler = typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler!;
  const hostname = opts.hostname ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;

  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });

  const server = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    try {
      const host = nodeReq.headers.host ?? `${hostname}:${actualPort}`;
      const url = `http://${host}${nodeReq.url ?? "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(nodeReq.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else if (typeof v === "string") {
          headers.set(k, v);
        }
      }

      const method = nodeReq.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const body = hasBody
        ? (Readable.toWeb(nodeReq) as unknown as ReadableStream<Uint8Array>)
        : undefined;

      const webReq = new Request(url, {
        method,
        headers,
        ...(body ? { body, duplex: "half" } : {}),
      } as RequestInit);

      const remoteAddr = {
        hostname: nodeReq.socket.remoteAddress ?? "127.0.0.1",
        port: nodeReq.socket.remotePort ?? 0,
        transport: "tcp" as const,
      };
      const webRes = await handler(webReq, { remoteAddr });

      nodeRes.statusCode = webRes.status;
      webRes.headers.forEach((v, k) => {
        nodeRes.setHeader(k, v);
      });
      if (method === "HEAD") {
        if (!webRes.headers.has("content-length") && webRes.body) {
          const buf = await webRes.arrayBuffer();
          nodeRes.setHeader("content-length", String(buf.byteLength));
        } else {
          await webRes.body?.cancel();
        }
      } else if (webRes.body) {
        const reader = webRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) nodeRes.write(value);
        }
      }
      nodeRes.end();
    } catch (err) {
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = 500;
        nodeRes.end(String(err));
      } else {
        nodeRes.end();
      }
    }
  });

  let actualPort = requestedPort === 0 ? ++ephemeralPortCursor : requestedPort;
  const addr = {
    get hostname() {
      return hostname;
    },
    get port() {
      return actualPort;
    },
    transport: "tcp" as const,
  };

  let resolveListening!: () => void;
  const listeningPromise = new Promise<void>((r) => {
    resolveListening = r;
  });
  pendingListeners.add(listeningPromise);
  listeningPromise.finally(() => pendingListeners.delete(listeningPromise));

  server.listen(actualPort, hostname, () => {
    const a = server.address();
    if (a && typeof a === "object") {
      actualPort = a.port;
    }
    resolveListening();
    opts.onListen?.({ hostname, port: actualPort });
  });
  server.on("error", () => {
    resolveListening();
  });

  const shutdown = (): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        resolveFinished();
        resolve();
      });
    });

  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      void shutdown();
    }, { once: true });
  }

  return {
    addr,
    finished,
    shutdown,
    unref() {
      server.unref();
    },
    ref() {
      server.ref();
    },
    [Symbol.asyncDispose]: shutdown,
  };
}

class NotFoundError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "NotFound";
  }
}

class AlreadyExistsError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AlreadyExists";
  }
}

function wrapFsError(err: unknown): never {
  const code = (err as { code?: string })?.code;
  if (code === "ENOENT") throw new NotFoundError((err as Error).message);
  if (code === "EEXIST") throw new AlreadyExistsError((err as Error).message);
  throw err;
}

class DenoCommandShim {
  readonly #cmd: string;
  readonly #args: string[];
  readonly #cwd?: string;
  readonly #env?: Record<string, string>;

  constructor(
    cmd: string | URL,
    opts?: { args?: string[]; cwd?: string | URL; env?: Record<string, string> },
  ) {
    this.#cmd = typeof cmd === "string" ? cmd : cmd.pathname;
    this.#args = opts?.args ?? [];
    this.#cwd = opts?.cwd ? String(opts.cwd) : undefined;
    this.#env = opts?.env;
  }

  outputSync() {
    const res = spawnSync(this.#cmd, this.#args, {
      cwd: this.#cwd,
      env: this.#env ? { ...process.env, ...this.#env } : process.env,
    });
    return {
      success: res.status === 0,
      code: res.status ?? 1,
      signal: res.signal,
      stdout: new Uint8Array(res.stdout ?? []),
      stderr: new Uint8Array(res.stderr ?? []),
    };
  }

  output(): Promise<{
    success: boolean;
    code: number;
    signal: NodeJS.Signals | null;
    stdout: Uint8Array;
    stderr: Uint8Array;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#cmd, this.#args, {
        cwd: this.#cwd,
        env: this.#env ? { ...process.env, ...this.#env } : process.env,
      });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout?.on("data", (d) => outChunks.push(Buffer.from(d)));
      child.stderr?.on("data", (d) => errChunks.push(Buffer.from(d)));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        resolve({
          success: code === 0,
          code: code ?? 1,
          signal,
          stdout: new Uint8Array(Buffer.concat(outChunks)),
          stderr: new Uint8Array(Buffer.concat(errChunks)),
        });
      });
    });
  }
}

if (typeof (globalThis as Record<string, unknown>).Deno === "undefined") {
  (globalThis as Record<string, unknown>).Deno = {
    test: denoTest,
    serve: denoServe,
    Command: DenoCommandShim,
    execPath: () => process.execPath,
    permissions: {
      querySync: () => ({ state: "granted" }),
      query: () => Promise.resolve({ state: "granted" }),
    },
    env: {
      get(key: string): string | undefined {
        return process.env[key];
      },
      set(key: string, value: string): void {
        process.env[key] = value;
      },
      delete(key: string): void {
        delete process.env[key];
      },
      toObject(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) out[k] = v;
        }
        return out;
      },
    },
    errors: {
      NotFound: NotFoundError,
      AlreadyExists: AlreadyExistsError,
    },
    readTextFile: (p: string | URL) => fsp.readFile(p, "utf8").catch(wrapFsError),
    readTextFileSync: (p: string | URL) => readFileSync(p, "utf8"),
    readFile: (p: string | URL) => fsp.readFile(p).then((b) => new Uint8Array(b)).catch(wrapFsError),
    writeTextFile: (p: string | URL, data: string) => fsp.writeFile(p, data, "utf8"),
    writeFile: (p: string | URL, data: Uint8Array) => fsp.writeFile(p, data),
    mkdir: (p: string | URL, opts?: { recursive?: boolean }) => fsp.mkdir(p, opts).then(() => {}),
    remove: (p: string | URL, opts?: { recursive?: boolean }) =>
      fsp.rm(p, { recursive: opts?.recursive ?? false, force: false }).catch(wrapFsError),
    stat: (p: string | URL) =>
      fsp.stat(p).then((s) => ({
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymlink: s.isSymbolicLink(),
        size: s.size,
        mtime: s.mtime,
      })).catch(wrapFsError),
    statSync: (p: string | URL) => {
      try {
        const s = statSync(p);
        return {
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          isSymlink: s.isSymbolicLink(),
          size: s.size,
          mtime: s.mtime,
        };
      } catch (err) {
        wrapFsError(err);
      }
    },
    makeTempFile: async (opts?: { dir?: string; prefix?: string; suffix?: string }) => {
      const dir = await fsp.mkdtemp(join(opts?.dir ?? tmpdir(), opts?.prefix ?? "audio-feed-tmp-"));
      const file = join(dir, `file${opts?.suffix ?? ""}`);
      await fsp.writeFile(file, "");
      return file;
    },
    lstat: (p: string | URL) =>
      fsp.lstat(p).then((s) => ({
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymlink: s.isSymbolicLink(),
        size: s.size,
        mtime: s.mtime,
      })).catch(wrapFsError),
    async *readDir(p: string | URL) {
      const entries = await fsp.readdir(p, { withFileTypes: true }).catch(wrapFsError);
      for (const e of entries) {
        yield {
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
          isSymlink: e.isSymbolicLink(),
        };
      }
    },
    *readDirSync(p: string | URL) {
      let entries;
      try {
        entries = readdirSync(p, { withFileTypes: true });
      } catch (err) {
        wrapFsError(err);
      }
      for (const e of entries) {
        yield {
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
          isSymlink: e.isSymbolicLink(),
        };
      }
    },
    makeTempDir: (opts?: { dir?: string; prefix?: string }) =>
      fsp.mkdtemp(join(opts?.dir ?? tmpdir(), opts?.prefix ?? "audio-feed-test-")),
    rename: (o: string | URL, n: string | URL) => fsp.rename(o, n),
    chmod: (p: string | URL, mode: number) => fsp.chmod(p, mode),
    copyFile: (s: string | URL, d: string | URL) => fsp.copyFile(s, d),
    symlink: (t: string | URL, p: string | URL) => fsp.symlink(t, p),
    utime: (p: string | URL, a: number | Date, m: number | Date) => fsp.utimes(p, a, m),
    unrefTimer: (id: unknown) => {
      if (id && typeof (id as { unref?: () => void }).unref === "function") {
        (id as { unref: () => void }).unref();
      }
    },
    cwd: () => process.cwd(),
  };
}
