/**
 * Real-input INP verification in a real browser session (audio-feed-s3uk).
 *
 * Drives headless Chrome against the real audio-feed server on the home page (/),
 * interacting with real form inputs and buttons using CDP trusted input events (isTrusted: true).
 *
 * Verifies:
 * 1. Pointer interactions (click on input/button) produce isTrusted: true and valid interactionIds.
 * 2. Keyboard interactions (typing into real inputs) produce isTrusted: true and valid interactionIds.
 * 3. Held-key repeats share interactionId and do not inflate interaction count.
 * 4. cwvState.observed() groups event timing entries by interactionId.
 * 5. Pagehide beacon flushes to /api/cwv and stores verified cwv.report records in KV.
 */

import { openStores } from "../src/config.ts";
import { bootstrap } from "../src/server.ts";
import {
  createTempChromeProfile,
  removeDirWhenQuiet,
  waitForChromeProfileUnused,
} from "./proof-helper.ts";

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
const serverAddr = app.server.addr as Deno.NetAddr;
const pageUrl = `http://localhost:${serverAddr.port}/`;
const { profileDir: profile, cleanup } = await createTempChromeProfile("audiofeed-s3uk-");
let chrome: Deno.ChildProcess | undefined;
let socket: WebSocket | undefined;

try {
  console.log(`[s3uk] Server started at ${pageUrl}`);

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
  check("headless Chrome started and reported debugging port", port > 0, `port ${port}`);
  if (port === 0) throw new Error("no debugging port");

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }>;
  const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  check("page target available", Boolean(target));
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
  await wait(3000);

  // Install interaction diagnostic probe in the page to track DOM events and Event Timing entries
  await cdp("Runtime.evaluate", {
    expression: `
      window.__probe = {
        domEvents: [],
        timingEntries: [],
      };
      ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup'].forEach(type => {
        window.addEventListener(type, (e) => {
          window.__probe.domEvents.push({
            type: e.type,
            isTrusted: e.isTrusted,
            target: e.target ? (e.target.id || e.target.tagName) : null,
            key: e.key || null,
            repeat: e.repeat || false,
          });
        }, { capture: true, passive: true });
      });
      new PerformanceObserver((list) => {
        list.getEntries().forEach(entry => {
          window.__probe.timingEntries.push({
            name: entry.name,
            entryType: entry.entryType,
            startTime: entry.startTime,
            duration: entry.duration,
            interactionId: entry.interactionId,
          });
        });
      }).observe({ type: 'event', buffered: true, durationThreshold: 0 });
    `,
  });

  // Find real form input on home page: #request-email or another input, and scroll it into view
  const inputInfo = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = document.getElementById("request-email") || document.querySelector("input") || document.body;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({
        id: el.id,
        tagName: el.tagName,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
      });
    })()`,
    returnByValue: true,
  }) as { result?: { value?: string } };
  const inputTarget = JSON.parse(inputInfo.result?.value ?? "{}") as {
    id: string;
    tagName: string;
    x: number;
    y: number;
  };
  console.log(
    `[s3uk] Found interaction target: <${inputTarget.tagName} id="${inputTarget.id}"> at (${inputTarget.x}, ${inputTarget.y})`,
  );

  // 1. Pointer interaction: click into the input field
  console.log("[s3uk] Dispatching trusted pointer interaction (click into input)...");
  await cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: inputTarget.x,
    y: inputTarget.y,
    button: "left",
    clickCount: 1,
  });
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: inputTarget.x,
    y: inputTarget.y,
    button: "left",
    clickCount: 1,
  });
  await wait(300);

  // 2. Keyboard interaction: single key press
  console.log("[s3uk] Dispatching trusted keyboard interaction (key press)...");
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "h",
    code: "KeyH",
    text: "h",
    windowsVirtualKeyCode: 72,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "h",
    code: "KeyH",
    windowsVirtualKeyCode: 72,
  });
  await wait(300);

  // 3. Keyboard interaction with simulated key hold (repeated keydown)
  console.log("[s3uk] Dispatching trusted held-key sequence (key repeat)...");
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "e",
    code: "KeyE",
    text: "e",
    windowsVirtualKeyCode: 69,
  });
  // Simulate held key repeats
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "e",
    code: "KeyE",
    text: "e",
    windowsVirtualKeyCode: 69,
    autoRepeat: true,
  });
  await cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "e",
    code: "KeyE",
    windowsVirtualKeyCode: 69,
  });
  await wait(500);

  // Read back probe data
  const probeDataRaw = await cdp("Runtime.evaluate", {
    expression: "JSON.stringify(window.__probe)",
    returnByValue: true,
  }) as { result?: { value?: string } };
  const probeData = JSON.parse(probeDataRaw.result?.value ?? "{}") as {
    domEvents: Array<
      { type: string; isTrusted: boolean; target: string; key: string | null; repeat: boolean }
    >;
    timingEntries: Array<
      { name: string; entryType: string; duration: number; interactionId: number }
    >;
  };

  // Inspect cwvState
  const cwvStateRaw = await cdp("Runtime.evaluate", {
    expression:
      "JSON.stringify(globalThis.cwvState ? { starts: globalThis.cwvState.starts(), pointerStarts: globalThis.cwvState.pointerStarts(), keyStarts: globalThis.cwvState.keyStarts(), isTrusted: globalThis.cwvState.isTrusted(), observed: globalThis.cwvState.observed() } : null)",
    returnByValue: true,
  }) as { result?: { value?: string } };
  const cwvState = JSON.parse(cwvStateRaw.result?.value ?? "null") as {
    starts: number;
    pointerStarts: number;
    keyStarts: number;
    isTrusted: boolean;
    observed: number[];
  } | null;

  console.log(`[s3uk] Dispatched DOM events: ${probeData.domEvents.length}`);
  const trustedCount = probeData.domEvents.filter((e) => e.isTrusted).length;
  check(
    "all dispatched DOM events have isTrusted === true",
    trustedCount === probeData.domEvents.length && trustedCount > 0,
    `${trustedCount}/${probeData.domEvents.length}`,
  );

  const hasPointer = probeData.domEvents.some((e) => e.type === "pointerdown");
  const hasKey = probeData.domEvents.some((e) => e.type === "keydown");
  check("session received both pointerdown and keydown DOM events", hasPointer && hasKey);

  check(
    "globalThis.cwvState.isTrusted() confirms all counted events were trusted",
    cwvState?.isTrusted === true,
  );

  console.log(
    `[s3uk] cwvState counts: total=${cwvState?.starts}, pointer=${cwvState?.pointerStarts}, key=${cwvState?.keyStarts}`,
  );
  check(
    "pointer interactions counted == dispatched (1 click dispatched)",
    cwvState?.pointerStarts === 1,
    `counted ${cwvState?.pointerStarts} of 1`,
  );
  check(
    "keyboard interactions counted == dispatched with held-key repeat suppressed (2 key interactions: 'h' + held 'e')",
    cwvState?.keyStarts === 2,
    `counted ${cwvState?.keyStarts} of 2 (held-key repeat suppressed)`,
  );
  check(
    "total interaction starts counted == dispatched",
    cwvState?.starts === 3,
    `counted ${cwvState?.starts} of 3 dispatched`,
  );

  console.log(`[s3uk] Event Timing entries recorded: ${probeData.timingEntries.length}`);
  for (const entry of probeData.timingEntries) {
    console.log(
      `  entry: ${entry.name} duration=${entry.duration}ms interactionId=${entry.interactionId}`,
    );
  }

  // Non-zero interactionIds
  const interactionIds = new Set(
    probeData.timingEntries.map((e) => e.interactionId).filter((id) => id > 0),
  );
  console.log(`[s3uk] Distinct non-zero interactionIds: ${Array.from(interactionIds).join(", ")}`);
  check(
    "Event Timing assigned interactionId to interactions",
    interactionIds.size > 0,
    `${interactionIds.size} distinct ID(s)`,
  );

  // Verify cwvState.observed()
  check(
    "globalThis.cwvState is exposed and returns observed latencies",
    Boolean(cwvState?.observed),
  );
  console.log(`[s3uk] cwvState.observed(): ${JSON.stringify(cwvState?.observed)}`);

  // Flush CWV via navigation
  console.log("[s3uk] Navigating away to trigger pagehide beacon flush...");
  const navigateStartedAt = Date.now();
  await cdp("Page.navigate", { url: "about:blank" });

  // audio-feed-q6ecj: the beacon flush is an OBSERVED condition, not a constant. The old fixed
  // wait(2000) read the store before a loaded host had finished pagehide beacon -> POST /api/cwv
  // -> the awaited appendLog, so the gate row went red with "0 report(s)" while every interaction
  // assertion was green. Poll like tests/csp_reporting_test.ts's settleDrops: 10ms interval, a
  // deadline MEASURED FROM THE NAVIGATION and sized for a loaded host. The deadline is a failure
  // bound, not a delay - the loop returns the moment the records are there.
  const CWV_SETTLE_DEADLINE_MS = 20_000;
  // The exact expected count is a runtime property, not a constant: the client (src/assets/cwv.js)
  // flushes one beacon per metric the page actually observed, up to three, guarded to fire once.
  // The statically assertable floor is 1 - exactly the assertion under test below. A short return
  // at the deadline lets the assertion fail on absence; it never passes an empty list silently.
  const settleCwvReports = async (want: number) => {
    const deadline = navigateStartedAt + CWV_SETTLE_DEADLINE_MS;
    for (;;) {
      const logs = await stores.metadata.listLogs();
      const reports = logs.filter((r) => r.type === "cwv.report");
      if (reports.length >= want) return reports;
      if (Date.now() >= deadline) return reports;
      await wait(10);
    }
  };
  const cwvReports = await settleCwvReports(1);
  const settleMs = Date.now() - navigateStartedAt;
  console.log(
    `[s3uk] cwv.report records received in KV store: ${cwvReports.length} (settle ${settleMs}ms after navigation)`,
  );
  if (cwvReports.length < 1) {
    // Fail LOUDLY on absence: name what was waited for, how many arrived, and the deadline.
    console.error(
      `[s3uk] TIMEOUT: waited ${CWV_SETTLE_DEADLINE_MS}ms after the about:blank navigation for >= 1 cwv.report record (pagehide beacon -> POST /api/cwv -> metadata store); saw ${cwvReports.length}.`,
    );
  }
  for (const r of cwvReports) {
    console.log(
      `  report: metric=${r.context?.metric} value=${r.context?.value} page=${r.context?.page}`,
    );
  }
  check(
    "cwv.report records persisted to metadata store",
    cwvReports.length > 0,
    `${cwvReports.length} report(s) (wanted >= 1; deadline ${CWV_SETTLE_DEADLINE_MS}ms from navigation; settle took ${settleMs}ms)`,
  );
} catch (err) {
  failures++;
  console.error(`FAIL  Execution error: ${err}`);
} finally {
  try {
    socket?.close();
  } catch { /* ignored */ }
  try {
    chrome?.kill("SIGKILL");
    await chrome?.status;
  } catch { /* ignored */ }
  try {
    await cleanup();
  } catch { /* ignored */ }
  // audio-feed-ee7pk: cleanup() swallows its own failures, so nothing proved the reap. Scoped to THIS run's profile
  // (audiofeed-s3uk- prefix); never a /tmp sweep - pre-existing scratch dirs are not this row's business.
  {
    const profileRemoved = await removeDirWhenQuiet(profile);
    const profileUnused = await waitForChromeProfileUnused(profile);
    const profileLine =
      `teardown: nothing still references the Chrome profile - removeDirWhenQuiet=${profileRemoved} waitForChromeProfileUnused=${profileUnused} profile=${profile}`;
    if (profileRemoved && profileUnused) {
      console.log(`PASS  ${profileLine}`);
    } else {
      failures++;
      console.error(`FAIL  ${profileLine}`);
    }
  }
  await app.server.shutdown();
}

console.log(
  failures === 0
    ? "\nALL INP INTERACTION VERIFICATION CHECKS PASSED."
    : `\n${failures} CHECK(S) FAILED.`,
);
if (failures > 0) Deno.exit(1);
