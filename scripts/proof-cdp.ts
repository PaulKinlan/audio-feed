/**
 * Shared CDP client for browser proofs (audio-feed-t6o2).
 *
 * Extracted verbatim from proof harness implementations:
 * establishes DevTools WebSocket connection, manages message-id dispatch,
 * and provides js() evaluate and until() poll helpers.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Render a polled expression's last value for a timeout message without throwing on it. */
function renderValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

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
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let polls = 0;
    let last: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      last = await js(expr);
      if (last) return;
      polls++;
      await sleep(50);
    }
    // audio-feed-ev6wj: never a bare "timed out waiting for: <desc>". A reader of a gate log
    // could not tell the 8s default from the 120s budget a slow row passes explicitly, could
    // not see WHICH expression never held, and could not see whether the poll ran once (the
    // host never gave the page a slice) or two thousand times (the page really never got
    // there) - the two failures need opposite responses.
    throw new Error(
      `until: '${desc}' did not hold within ${timeoutMs}ms of entry ` +
        `(expression \`${expr}\`, entry ${new Date(startedAt).toISOString()}, ` +
        `deadline ${new Date(deadline).toISOString()}, ` +
        `elapsed ${Date.now() - startedAt}ms, polls ${polls}, ` +
        `last value ${renderValue(last)})`,
    );
  }

  function close() {
    try {
      ws.close();
    } catch { /* ignore */ }
  }

  return { ws, cdp, js, until, close };
}
