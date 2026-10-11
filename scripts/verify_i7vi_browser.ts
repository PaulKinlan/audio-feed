/**
 * Drives the real browser collector (audio-feed-i7vi / obs-4).
 *
 * Runs the real server, loads a real page in headless Chrome over CDP, lets the browser observe its
 * own metrics, navigates away so the pagehide beacon fires, and then reads the record back out of the
 * store. The mandate is that a browser asset is DRIVEN, not reasoned about — so this asserts that a
 * real LCP value arrived, not that the script looks correct.
 *
 * Bounded: one browser, killed in a `finally`, with a hard wall-clock limit on the whole run.
 */

import { openStores } from "../src/config.ts";
import { bootstrap } from "../src/server.ts";

const DEADLINE_MS = 90_000;
const startedAt = Date.now();

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stores = await openStores({ kvPath: ":memory:" });
const app = await bootstrap({
  port: 0,
  stores,
  isDeploy: true,
  synthesizer: null,
  inventory: false,
});
const pageUrl = `http://localhost:${(app.server.addr as Deno.NetAddr).port}/`;
const profile = await Deno.makeTempDir();
let chrome: Deno.ChildProcess | undefined;
let socket: WebSocket | undefined;

try {
  // The collector has to be IN the page before anything else is worth testing.
  const html = await (await app.fetch(new Request(pageUrl))).text();
  check(
    "the collector is inlined in the served page",
    html.includes("sendBeacon") && html.includes("largest-contentful-paint"),
  );

  chrome = new Deno.Command("google-chrome", {
    args: [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Chrome reports the debugging port it chose on stderr; no fixed port, so no collision with
  // anything else on the VM.
  const reader = chrome.stderr.getReader();
  const decoder = new TextDecoder();
  let port = 0;
  let banner = "";
  while (Date.now() - startedAt < DEADLINE_MS) {
    const { value, done } = await reader.read();
    if (done) break;
    banner += decoder.decode(value);
    const match = banner.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      port = Number(match[1]);
      break;
    }
  }
  check("headless Chrome started and reported a debugging port", port > 0, `port ${port}`);
  if (port === 0) throw new Error("no debugging port");

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }[];
  const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  check("a page target is available to drive", Boolean(target));
  if (!target?.webSocketDebuggerUrl) throw new Error("no page target");

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve();
    socket!.onerror = () => reject(new Error("websocket failed"));
  });

  let seq = 0;
  const cdp = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++seq;
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: Record<string, unknown>;
        };
        if (message.id === id) {
          socket!.removeEventListener("message", onMessage);
          resolve(message.result ?? {});
        }
      };
      socket!.addEventListener("message", onMessage);
      socket!.send(JSON.stringify({ id, method, params }));
    });

  await cdp("Page.enable");
  await cdp("Page.navigate", { url: pageUrl });
  // Let it paint and settle: LCP is only final once the page stops producing candidates.
  await wait(4000);
  // KNOWN INTERACTIONS, so the count can be compared against what this run actually dispatched
  // (audio-feed-dzgj). A mouse press and release is ONE interaction that emits several events
  // (pointerdown, mousedown, pointerup, mouseup, click), which is exactly the case a naive counter
  // gets wrong by counting events instead of interactions.
  const press = (x: number, y: number) =>
    cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  const release = (x: number, y: number) =>
    cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  // Which kinds to dispatch, so the count can be attributed to a KIND without any instrumentation
  // inside the page: run the harness with CWV_INTERACTIONS=mouse and again with =key.
  const kind = Deno.env.get("CWV_INTERACTIONS") ?? "both";
  const MOUSE_INTERACTIONS = kind === "key" ? 0 : 3;
  for (let i = 0; i < MOUSE_INTERACTIONS; i++) {
    await press(40 + i * 20, 40);
    await release(40 + i * 20, 40);
    await wait(150);
  }
  // Keys after the mouse, because the click focuses the page and an unfocused page receives no
  // keydown at all.
  // An unfocused page receives no keydown at all, so bring it to the front and focus it first.
  await cdp("Page.bringToFront");
  await cdp("Runtime.evaluate", { expression: "document.body.focus()" });
  const KEY_INTERACTIONS = kind === "mouse" ? 0 : 2;
  for (let i = 0; i < KEY_INTERACTIONS; i++) {
    await cdp("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
    });
    await cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
    });
    await wait(150);
  }
  await wait(1500);

  // What the PAGE counted, read out of it rather than assumed.
  const state = await cdp("Runtime.evaluate", {
    expression:
      "JSON.stringify(globalThis.cwvState ? { starts: cwvState.starts(), observed: cwvState.observed() } : null)",
    returnByValue: true,
  }) as { result?: { value?: string } };
  const counted = JSON.parse(state.result?.value ?? "null") as
    | { starts: number; observed: number[] }
    | null;
  const dispatched = MOUSE_INTERACTIONS + KEY_INTERACTIONS;
  console.log(
    `  OBSERVED: dispatched ${dispatched} interactions (${MOUSE_INTERACTIONS} mouse press/release, each also emitting a click, plus ${KEY_INTERACTIONS} key presses)`,
  );
  console.log(`  OBSERVED: the page counted ${counted ? counted.starts : "nothing (no cwvState)"}`);
  console.log(
    `  OBSERVED: interaction durations the observer reported: ${
      counted ? JSON.stringify(counted.observed) : "none"
    }`,
  );
  check("the collector exposes its count for checking", counted !== null);
  // The invariant that matters: an OVERCOUNT understates INP, which is the dangerous direction. An
  // undercount only degrades the value to the upper bound the interaction count exists to remove.
  check(
    "the page counted no more interactions than were dispatched (an overcount would understate INP)",
    (counted?.starts ?? 0) <= dispatched,
    `counted ${counted?.starts} of ${dispatched} dispatched`,
  );
  if (counted && counted.starts < dispatched) {
    console.log(
      `  NOTE: counted ${counted.starts} of ${dispatched} - an undercount, which is a known degradation to the upper bound rather than a wrong value in the dangerous direction. Key events reaching a headless page is the usual reason.`,
    );
  }

  // The beacon fires on pagehide/visibilitychange, so navigating away IS the flush.
  await cdp("Page.navigate", { url: "about:blank" });
  await wait(2500);

  const records = await stores.metadata.listLogs();
  const cwv = records.filter((r) => r.type === "cwv.report");
  console.log(
    `  records: ${
      records.map((r) =>
        `${r.type}(${r.context?.metric ?? "-"}=${JSON.stringify(r.context?.value ?? null)})`
      ).join(" ") || "(none)"
    }`,
  );
  check("a real browser sent at least one CWV report", cwv.length > 0, `${cwv.length} report(s)`);

  const lcp = cwv.find((r) => r.context?.metric === "lcp");
  check(
    "an LCP value arrived from the browser",
    Boolean(lcp) && Number(lcp!.context?.value) > 0,
    lcp ? `${lcp.context?.value}` : "absent",
  );
  // A page cannot take an hour to paint and still be a measurement; the range check is the same rule
  // the endpoint enforces, asserted here on what really arrived.
  const value = Number(lcp?.context?.value ?? -1);
  check(
    "the arrived value is inside the plausible range",
    value > 0 && value <= 3_600_000,
    `${value}ms`,
  );
  check(
    "the beacon never became a request-log field",
    !records.filter((r) => r.type === "http.request").some((r) =>
      JSON.stringify(r).includes("cwv")
    ),
    `${
      records.filter((r) => r.type === "http.request").length
    } request record(s), none about cwv (the page loads themselves belong in the log)`,
  );
  check(
    "a page label came with it",
    typeof lcp?.context?.page === "string",
    String(lcp?.context?.page),
  );
  const inp = cwv.find((r) => r.context?.metric === "inp");
  console.log(
    `  INP: ${
      inp ? `${inp.context?.value}ms (warn/error band applied to it)` : "not observed in this run"
    }`,
  );
} catch (error) {
  failures++;
  console.error(`FAIL  the run did not complete: ${error}`);
} finally {
  try {
    socket?.close();
  } catch { /* already gone */ }
  try {
    chrome?.kill("SIGKILL");
    await chrome?.status;
  } catch { /* already gone */ }
  try {
    await Deno.remove(profile, { recursive: true });
  } catch { /* best effort */ }
  await app.server.shutdown();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED`);
Deno.exit(failures === 0 ? 0 : 1);
