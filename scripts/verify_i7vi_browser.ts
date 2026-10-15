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
import { withChrome } from "./proof-helper.ts";

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
let socket: WebSocket | undefined;

try {
  // The collector has to be IN the page before anything else is worth testing.
  const html = await (await app.fetch(new Request(pageUrl))).text();
  check(
    "the collector is inlined in the served page",
    html.includes("sendBeacon") && html.includes("largest-contentful-paint"),
  );

  await withChrome(async (chrome) => {
    const port = chrome.port;
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
      expression: "JSON.stringify(globalThis.cwvState ? { observed: cwvState.observed() } : null)",
      returnByValue: true,
    }) as { result?: { value?: string } };
    const counted = JSON.parse(state.result?.value ?? "null") as
      | { observed: number[] }
      | null;
    console.log(
      `  OBSERVED: interaction durations the observer reported: ${
        counted ? JSON.stringify(counted.observed) : "none"
      }`,
    );
    // Fire the collector's OWN flush without tearing the document down (audio-feed-mpmc). The transport
    // counters live inside the page, so they are only readable between the flush and the teardown — and
    // `Page.navigate` does both at once, so reading them after it reads the blank page's and reading
    // before it reads zeroes (both measured, both wrong). The collector flushes on pagehide and on
    // visibilitychange-to-hidden; this drives the second, and `flush`'s `sent` guard means the pagehide
    // that follows is a no-op rather than a second beacon.
    const flushInPage = async () => {
      await cdp("Runtime.evaluate", {
        expression:
          'Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });' +
          ' window.dispatchEvent(new Event("visibilitychange")); "flushed"',
        returnByValue: true,
      });
      await wait(1000);
    };
    const readTransports = async () => {
      const read = await cdp("Runtime.evaluate", {
        expression:
          "JSON.stringify(globalThis.cwvState && globalThis.cwvState.transports ? cwvState.transports() : null)",
        returnByValue: true,
      }) as { result?: { value?: string } };
      return JSON.parse(read.result?.value ?? "null") as
        | { beacon: number; fallback: number; failed: number }
        | null;
    };

    // The CONTROL for the transport assertions further down: on the normal path the browser ACCEPTED the
    // beacons, so the fallback must not have run. Without it, a change that always used the fallback
    // would satisfy the refused and absent scenarios below.
    await flushInPage();
    const controlTransports = await readTransports();
    check(
      "the normal path uses sendBeacon and does not fall back",
      (controlTransports?.beacon ?? 0) >= 1 && controlTransports?.fallback === 0,
      JSON.stringify(controlTransports),
    );
    // The invariant that matters: an OVERCOUNT understates INP, which is the dangerous direction. An
    // undercount only degrades the value to the upper bound the interaction count exists to remove.

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

    // ---- audio-feed-mpmc: the two silent losses, DRIVEN rather than reasoned about --------------
    // Each scenario stubs the page's transport BEFORE it loads, flushes by leaving the page, and reads
    // the STORE back. THE EVIDENCE IS THE RECORD'S PRESENCE, and that is deliberate: a refused beacon
    // has no server-side observer, so with the keepalive fallback removed the only trace of it is the
    // ABSENCE of a cwv.report, and an absent record is what these checks name. A test that only showed
    // the fallback branch executing would test the fix rather than the consequence. The control is the
    // run above, which asserts the record arrives on the normal path.
    const countReports = async () =>
      (await stores.metadata.listLogs()).filter((r) => r.type === "cwv.report").length;
    let stubId: string | undefined;
    const scenario = async (name: string, stub: string) => {
      if (stubId) {
        await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: stubId });
        stubId = undefined;
      }
      const added = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: stub }) as {
        identifier?: string;
      };
      stubId = added.identifier;
      const before = await countReports();
      await cdp("Page.navigate", { url: pageUrl });
      await wait(2500);
      // One interaction, so the run has at least one beacon to send even if this load reports no LCP.
      await press(60, 60);
      await release(60, 60);
      await wait(500);
      // Flush and read the counters while the document is still alive; see flushInPage above for why
      // neither reading before the flush nor after a navigation works.
      await flushInPage();
      const t = await readTransports();
      const arrived = (await countReports()) - before;
      console.log(
        `  ${name}: ${arrived} cwv.report record(s) arrived, transports=${JSON.stringify(t)}`,
      );
      return { arrived, transports: t };
    };

    // LITERAL check labels on purpose (docs/evidence/README.md, assertion census): a label assembled by
    // interpolation is not a call site the census can match against the README's `- Asserts:` line, so
    // the measurement goes in the detail argument and only the log line above interpolates the name.
    const refused = await scenario(
      "sendBeacon REFUSED",
      "Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: true });",
    );
    check(
      "a REFUSED beacon still arrives as a CWV report",
      refused.arrived > 0,
      `${refused.arrived} new record(s), transports=${JSON.stringify(refused.transports)}`,
    );
    check(
      "a refused beacon is recorded as a keepalive fallback rather than an accepted one",
      refused.transports?.beacon === 0 && (refused.transports?.fallback ?? 0) >= 1,
      JSON.stringify(refused.transports),
    );

    const absent = await scenario(
      "sendBeacon ABSENT",
      "Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });",
    );
    check(
      "an ABSENT sendBeacon still arrives as a CWV report",
      absent.arrived > 0,
      `${absent.arrived} new record(s), transports=${JSON.stringify(absent.transports)}`,
    );
    check(
      "a missing sendBeacon does not leave the page without a transport",
      absent.transports?.beacon === 0 && (absent.transports?.fallback ?? 0) >= 1,
      JSON.stringify(absent.transports),
    );

    try {
      socket?.close();
    } catch { /* already gone */ }
  }, { prefix: "audiofeed-i7vi-" });
} catch (error) {
  failures++;
  console.error(`FAIL  the run did not complete: ${error}`);
} finally {
  await app.server.shutdown();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED`);
Deno.exit(failures === 0 ? 0 : 1);
