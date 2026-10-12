/**
 * Shared CDP client for browser proofs (audio-feed-t6o2).
 *
 * Extracted verbatim from proof harness implementations:
 * establishes DevTools WebSocket connection, manages message-id dispatch,
 * and provides js() evaluate and until() poll helpers.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CdpClient {
  ws: WebSocket;
  // deno-lint-ignore no-explicit-any
  cdp: (method: string, params?: Record<string, unknown>) => Promise<any>;
  // deno-lint-ignore no-explicit-any
  js: (expression: string) => Promise<any>;
  until: (expr: string, desc: string, timeoutMs?: number) => Promise<void>;
  close: () => void;
}

export async function connectCdp(target: number | { port: number }): Promise<CdpClient> {
  const port = typeof target === "number" ? target : target.port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t: { type: string }) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  let nextId = 0;
  const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });

  // deno-lint-ignore no-explicit-any
  async function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    const msg = await new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r));
    if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }

  // deno-lint-ignore no-explicit-any
  async function js(expression: string): Promise<any> {
    const r = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
    }
    return r.result?.value;
  }

  async function until(expr: string, desc: string, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await js(expr)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for: ${desc}`);
  }

  function close() {
    try {
      ws.close();
    } catch { /* ignore */ }
  }

  return { ws, cdp, js, until, close };
}
