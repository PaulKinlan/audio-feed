// audio-feed-txcz: state-aware sticky headers via container scroll-state queries
// (container-scroll-state, chromium 133+)
//
// The two sticky headers — .site-header in the shell and header.app on the listen
// page — gain a subtle elevation and a stronger edge when they are actually stuck,
// with no scroll listener anywhere.
//
// Tests verify:
// - the sticky element is the scroll-state CONTAINER and the visible surface is its
//   DESCENDANT (a scroll-state query can only style descendants, never the container);
// - the no-support path renders exactly as before: the sticky geometry (offset 0,
//   z-index 5) lives on the wrapper with the same values the surface carried;
// - the stuck rules are paint-only, so there is no layout change for scroll anchoring
//   to compensate for (the flicker trap the guidance names);
// - headless Chrome really flips the computed styles on scroll for BOTH headers and
//   leaves sticky offset / z-index / container-type intact.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { renderShell, SHELL_CSS } from "../src/routes/shell.ts";
import { renderListenPage } from "../src/routes/listen.ts";
import { assetBody, handleAsset } from "../src/routes/assets.ts";
import type { RouteContext } from "../src/router.ts";
import { makeEpisode } from "./fixtures.ts";
import {
  launchChrome,
  removeDirWhenQuiet,
  waitForChromeProfileUnused,
} from "../scripts/proof-helper.ts";
import { HANG_BOUND_MS, MEASURED_STARVED_POLL_MS } from "../scripts/proof-cdp.ts";

/** The listen page with enough episodes to scroll well past its sticky header. */
function tallListenHtml(): string {
  const episodes = Array.from({ length: 40 }, (_, i) => ({
    ...makeEpisode({ id: `ep-${i}`, title: `Episode ${i}` }),
    audioUrl: `https://example.com/audio/ep-${i}.wav`,
  }));
  return renderListenPage({
    nonce: "test-nonce",
    userId: "user-1",
    token: "test-token",
    subscriber: "Listener",
    feedUrl: "https://example.com/feed/test-token",
    episodes,
    offlineEnabled: true,
  });
}

function listenCss(): string {
  return assetBody("listen.css")!;
}

Deno.test("txcz: both sticky elements are scroll-state containers and both surfaces are their descendants", () => {
  const shell = renderShell({ nonce: "test-nonce", title: "probe", viewer: null, main: "" });
  assertStringIncludes(shell, '<div class="site-header-sticky"><header class="site-header">');
  assertStringIncludes(shell, "</header></div>");
  assertStringIncludes(SHELL_CSS, "container-type: scroll-state;");
  assertStringIncludes(SHELL_CSS, "container-name: site-sticky;");
  assertStringIncludes(SHELL_CSS, "@container site-sticky scroll-state(stuck: top)");

  const listen = tallListenHtml();
  assertStringIncludes(listen, '<div class="app-header-sticky">');
  const css = listenCss();
  assertStringIncludes(css, ".app-header-sticky {");
  assertStringIncludes(css, "container-type: scroll-state;");
  assertStringIncludes(css, "container-name: app-sticky;");
  assertStringIncludes(css, "@container app-sticky scroll-state(stuck: top)");
});

Deno.test("txcz: the no-support path keeps the sticky geometry, and the stuck rules are paint-only", () => {
  // Sticky moved surface -> wrapper with identical geometry values.
  assertStringIncludes(SHELL_CSS, "position: sticky; inset-block-start: 0; z-index: 5;");
  const css = listenCss();
  assertStringIncludes(
    css,
    ".app-header-sticky {\n  position: sticky;\n  inset-block-start: 0;\n  z-index: 5;",
  );
  // The view-transition names stay on the surfaces (view_transitions_test pins them).
  assertStringIncludes(SHELL_CSS, "view-transition-name: app-header;");
  assertStringIncludes(css, "view-transition-name: app-header;");
  // Paint-only: no box-model property inside either stuck block, so scroll anchoring
  // has nothing to compensate for (the guidance's flicker trap).
  for (const [label, source] of [["shell", SHELL_CSS], ["listen", css]] as const) {
    const blocks = [
      ...source.matchAll(/@container \S+ scroll-state\(stuck: top\) \{[\s\S]*?\n\s*\}/g),
    ];
    assertEquals(blocks.length, 1, `${label}: exactly one stuck block`);
    const block = blocks[0]!;
    assert(
      !/(padding|margin|block-size|inline-size|min-block-size|font-size|line-height|transform)\s*:/
        .test(block[0]),
      `${label}: the stuck block changes paint only`,
    );
  }
});

/**
 * audio-feed-lsrace: THE loadState probe's page-side facts, extracted to module scope so the
 * guard test below pins the EXACT expression the browser poll runs (no re-typed copy that can
 * drift from the real one).
 */
const LOAD_STATE_PROBE =
  `JSON.stringify({pathname: location.pathname, readyState: document.readyState, ` +
  `scrollHeight: document.documentElement.scrollHeight, innerHeight: innerHeight})`;

/**
 * audio-feed-lsrace: a CDP evaluate can land MID-NAVIGATION. `location.href = ...` returns before
 * the new document commits, so the very next poll can run inside a document that exists but has
 * not parsed its root yet: `document.documentElement` is null and an unguarded dereference
 * throws - which `evaluate` (exceptionDetails -> reject) surfaces as a FAILURE, killing the poll
 * instead of letting it retry (the 1-in-5 race this fixes: "Cannot read properties of null
 * (reading 'scrollHeight')" thrown from the loadState poll immediately after location.href).
 *
 * THE RULE (navigation-in-flight vs page-is-broken): ONLY while `document.readyState` is
 * "loading" is a missing documentElement/body classified as NOT READY - the wrapped probe
 * returns `{"navigating":true}` so the poll's predicate fails the observation and retries. Every
 * other throw PROPAGATES: a root missing after loading finished, or any error from the probe
 * itself on a real document, still fails the suite with evidence instead of being retried into
 * an opaque timeout.
 */
const NAVIGATION_SAFE = (probe: string) =>
  `(() => {
    if (document.documentElement === null || document.body === null) {
      if (document.readyState !== "loading") {
        throw new Error(
          "documentElement/body missing while readyState is " + document.readyState,
        );
      }
      return JSON.stringify({ navigating: true });
    }
    return (${probe});
  })()`;

/**
 * audio-feed-lsrace: the guard's contract, pinned WITHOUT a browser by evaluating the generated
 * probe against stub documents (the free variables `document`/`location`/`innerHeight` are bound
 * as function parameters, shadowing the globals Deno does not have).
 */
Deno.test(
  "txcz: a load poll landing mid-navigation returns not-ready instead of throwing; a broken page still throws",
  () => {
    const run = (
      expr: string,
      doc: { readyState: string; documentElement: unknown; body: unknown },
    ) =>
      // deno-lint-ignore no-explicit-any
      (new Function("document", "location", "innerHeight", `return (${expr});`) as any)(
        doc,
        { pathname: "/listen" },
        600,
      );

    // RED (the reported race, guard reverted): with the root not yet parsed, the RAW probe
    // throws the exact TypeError the suite saw 1-in-5 - the poll dies instead of retrying.
    assertThrows(
      () =>
        run(LOAD_STATE_PROBE, {
          readyState: "loading",
          documentElement: null,
          body: null,
        }),
      Error,
      "Cannot read properties of null (reading 'scrollHeight')",
    );

    // GREEN (guarded): the same mid-navigation condition is a NOT-READY observation the poll
    // retries - pathname/readyState/scrollHeight fail the predicate, the loop polls again.
    assertEquals(
      JSON.parse(
        run(NAVIGATION_SAFE(LOAD_STATE_PROBE), {
          readyState: "loading",
          documentElement: null,
          body: null,
        }),
      ),
      { navigating: true },
    );

    // RULE 3: a root missing once loading has FINISHED is a broken page, not a navigation -
    // it must throw evidence, not be retried into a timeout.
    assertThrows(
      () =>
        run(NAVIGATION_SAFE(LOAD_STATE_PROBE), {
          readyState: "complete",
          documentElement: null,
          body: null,
        }),
      Error,
      "documentElement/body missing while readyState is complete",
    );

    // Passthrough: a real document (root and body present) evaluates the probe unchanged.
    assertEquals(
      JSON.parse(
        run(NAVIGATION_SAFE(LOAD_STATE_PROBE), {
          readyState: "complete",
          // deno-lint-ignore no-explicit-any
          documentElement: { scrollHeight: 4000 } as any,
          body: {},
        }),
      ),
      { pathname: "/listen", readyState: "complete", scrollHeight: 4000, innerHeight: 600 },
    );

    // A loaded page that is BROKEN (its own probe throws on a present root) is not swallowed
    // by the guard either - the app's error surfaces exactly as it would unguarded.
    assertThrows(
      () =>
        run(NAVIGATION_SAFE(LOAD_STATE_PROBE), {
          readyState: "complete",
          documentElement: {
            get scrollHeight(): number {
              throw new Error("app exploded");
            },
          },
          body: {},
        }),
      Error,
      "app exploded",
    );
  },
);

/**
 * audio-feed-oyf3g: a scratch root this suite owns, handed to the helper AS AN ARGUMENT.
 *
 * WHY THIS SUITE NEEDS A SANDBOX AT ALL: createTempChromeProfile() reclaims abandoned profiles under the root
 * it is given BEFORE it allocates, so running this proof against the machine's real temp directory makes a test
 * mutate shared state - and with the sweep age-and-signature based instead of prefix-scoped (audio-feed-h62q)
 * that means EVERY abandoned profile on the VM. The root argument keeps the sweep inside this sandbox.
 *
 * WHY IT IS AN ARGUMENT RATHER THAN AN ENVIRONMENT VARIABLE: it used to redirect the process-global TMPDIR.
 * Under `deno test --parallel` Deno runs test modules CONCURRENTLY IN ONE PROCESS, so that redirect captured
 * other modules' unprefixed temp dirs into this sandbox and deleted them with it, and the victims failed in
 * their own cleanup with NotFound.
 *
 * THE SANDBOX MUST OUTLIVE THE PROFILE: `restore` deletes the scratch tree, so it runs in the same `finally`
 * that closes the profile/browser - restoring earlier would delete the profile out from under its user.
 */
async function scratchRootForProfiles(): Promise<{ root: string; restore: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "w5f1-scratch-" });
  return {
    root,
    restore: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

/** Launch headless Chrome, connect over CDP, hand the caller an evaluate(). */
async function withChrome<T>(
  // deno-lint-ignore no-explicit-any
  fn: (evaluate: (expr: string) => Promise<any>) => Promise<T>,
): Promise<T> {
  // audio-feed-w5f1: BEFORE the allocation, and restored in the finally below - see the helper above.
  const { root, restore } = await scratchRootForProfiles();
  // BOOT THROUGH THE SHARED LAUNCHER (audio-feed boot-bound sweep, mirroring the
  // css_escape_guard fix in 2b4e8bab): the hand-rolled Deno.Command plus fixed 50x100ms
  // DevToolsActivePort wait is a coin flip under load - on the union gate host at loadavg 5-10
  // that 5s window expired while a healthy Chrome was merely starved. launchChrome polls the
  // port file event-by-event, and its failure names the OWNER: "exited prematurely with code N"
  // means the browser never started (flags/binary), "Timed out after <waited>ms" means it
  // started slowly (host starvation). The bound is the fleet-wide derivation, not a widened
  // constant: HANG_BOUND_MS = 15 x the 8s measured starved-poll floor (scripts/proof-cdp.ts).
  const chrome = await launchChrome({
    prefix: "audiofeed-txcz-",
    profileRoot: root,
    portTimeoutMs: HANG_BOUND_MS,
  });
  const { profileDir } = chrome;
  const cdpPort = String(chrome.port);
  try {
    // deno-lint-ignore no-explicit-any
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as any[];
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let nextId = 0;
    // deno-lint-ignore no-explicit-any
    const pending = new Map<number, (v: any) => void>();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });
    const cdp = (method: string, params: Record<string, unknown> = {}) => {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      // deno-lint-ignore no-explicit-any
      return new Promise<any>((resolve) => pending.set(id, resolve));
    };
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    const evaluate = async (expr: string) => {
      // awaitPromise: lets callers hand page-side async waits (the frame-coupled stuck-state
      // wait below, audio-feed-mir4g) to the page instead of polling over CDP. Harmless for
      // synchronous expressions - the value resolves the same way.
      const r = await cdp("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    };
    return await fn(evaluate);
  } finally {
    // close() is the launcher's own kill-and-reap: SIGTERM, await the exit, then remove the
    // profile it allocated - the same two steps this teardown used to spell out by hand.
    await chrome.close();
    await restore();
    assert(
      await removeDirWhenQuiet(root),
      "the scratch root must be gone after teardown: a dying browser's children must not recreate it (audio-feed-wj8o2)",
    );
    assert(
      await waitForChromeProfileUnused(profileDir),
      "no process may still reference the row's profile once teardown has finished (audio-feed-wj8o2)",
    );
  }
}

/**
 * audio-feed-mir4g: a FRAME-COUPLED wait for the stuck-state flip, replacing the wall-clock
 * state poll that raced under a saturated gate. The previous shape polled the computed styles
 * under a 5s wall-clock deadline and then ASSERTED on whatever the last probe saw. Under load
 * the flip landed late in the window and the deadline cut the 180ms border-color/box-shadow
 * transitions short: a probe in the transition's first instants can round back to the starting
 * 8-bit colour (measured: 'the stuck edge strengthens (rgb(36,36,43) -> rgb(36,36,43))' with
 * box-shadow already flipped - a partial, mid-transition read). Here every check runs after a
 * rendered frame (double rAF), so a starved renderer adds FRAMES, never a wall-clock miss, and
 * the values are only read once they are stable across two consecutive frames (the transitions
 * have run out). The 600-frame cap is a HANG GUARD measured in frames, not milliseconds
 * (docs/speed.md rule 1): ~50x the 11-frame transition, and it trips only when the flip or the
 * settle never happens - which is the regression, named by the returned flags.
 */
const STUCK_STATE_WAIT = (surfaceSel: string, baseKey: string, wantStuck: boolean) =>
  `(async () => {
    // audio-feed-vn72k (follow-up): publish the page's OWN uncaught-error state, because the STALL
    // classifier's starvation verdict is an environment claim - "no BeginFrame fired, the page is
    // healthy" - and a product bug that pegs the main thread while still answering trivial
    // evaluates looks identical from the host. Reset per wait (each wait is its own phase); the
    // two listeners are installed once, so re-entering the wait cannot double-register them.
    window.__stuckErr = null;
    if (!window.__stuckErrHooked) {
      window.__stuckErrHooked = true;
      addEventListener("error", (e) => {
        window.__stuckErr = String((e && (e.message || e.type)) || "error");
      });
      addEventListener("unhandledrejection", (e) => {
        const reason = e && e.reason;
        window.__stuckErr = String((reason && reason.message) || reason || "unhandledrejection");
      });
    }
    const el = document.querySelector(${JSON.stringify(surfaceSel)});
    const keyOf = () => {
      const cs = getComputedStyle(el);
      return [cs.boxShadow, cs.backgroundColor, cs.borderBlockEndColor].join("|");
    };
    const base = ${JSON.stringify(baseKey)};
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const state = () => ({
      scrollY: Math.round(window.scrollY),
      rectTop: Math.round(el.getBoundingClientRect().top),
      key: keyOf(),
    });
    // audio-feed-evhug: publish a MONOTONICALLY ADVANCING observation every iteration so the
    // host-side monitor can tell three states apart: (a) progress (n advances) - keep waiting,
    // however slow, because a starved renderer finishes transitions in fewer frames but more
    // milliseconds and redding a correct row is the flake class this row exists to avoid;
    // (b) STALL (n frozen - the renderer stopped painting) - bounded below by the host monitor;
    // (c) ABSENCE (n advancing, condition never reached) - also bounded below. The loops are
    // still condition-first and double-rAF; no timer exists in the pass path at all.
    let frames = 0;
    let iter = 0;
    for (;;) {
      const s = state();
      window.__stuckWait = { phase: ${
    JSON.stringify(wantStuck ? "flip" : "restore")
  }, n: ++iter, ...s };
      const reached = ${wantStuck}
        ? s.scrollY > 0 && s.rectTop === 0 && s.key !== base
        : s.scrollY === 0 && s.key === base;
      if (reached) break;
      if (++frames > 3600) return JSON.stringify({ reached: false, settled: false, ...s });
      await frame();
    }
    let prev = keyOf();
    frames = 0;
    for (;;) {
      await frame();
      const cur = keyOf();
      if (cur === prev) break;
      window.__stuckWait = { phase: ${
    JSON.stringify(wantStuck ? "flip" : "restore")
  }, n: ++iter, ...state() };
      if (++frames > 3600) return JSON.stringify({ reached: true, settled: false, ...state() });
      prev = cur;
    }
    return JSON.stringify({ reached: true, settled: true, ...state() });
  })()`;

/** audio-feed-evhug (round two, after the deepseek review killed the blanket 8s race): only the
 * STALL bound arms on observed absence of progress - ABSENCE is a flat ceiling measured FROM ENTRY
 * (Date.now() - started), not from the last observation. So a normal run still never trips a timer -
 * measured green flips on this host swing 0.2s to 6.8s, and any fixed deadline near that is the
 * flake class this row exists to avoid. The monitor distinguishes:
 *   - PROGRESS: the page's published counter (window.__stuckWait.n) advances -> keep waiting,
 *     however slow (a starved renderer finishes transitions in fewer frames but more ms);
 *   - STALL: the counter is frozen > STALL_LIMIT_MS (20s) -> arm the CLASSIFIER below, never a
 *     verdict on its own. 20s is >1000 missed frames against a ~16ms frame and ~3x the entire
 *     worst measured green wait - the ~100x margin precedent
 *     (tests/grounded_script_test.ts:679) applied to the thing actually being bounded.
 *     audio-feed-vn72k: the previous round threw here on the ASSUMPTION that a total rAF pause
 *     is a hang ("an assumption that fits this row, not a proven property", it admitted) - and
 *     five prior fixes each patched one symptom of that same misread. Under gate load headless
 *     Chrome stops scheduling BeginFrames, a healthy page freezes __stuckWait.n, and the STALL
 *     throw reded a correct row. The classifier below now separates that environment condition
 *     from a genuine hang IN CODE, at the moment the assumption would have fired.
 *   - ABSENCE: the counter may well be advancing - this is 45s from ENTRY, not a timer armed after
 *     progress stops - and the condition simply has not landed by ABSENCE_LIMIT_MS (45s) -> throw.
 *     45s is ~6.6x the worst measured green flip (6.8s) and ~20x the typical - stated so the number
 *     is a decision, not a leftover; it is still 2.2x better than the ~100s frame cap and throws a
 *     NAMED diagnostic instead of returning a flag.
 * (P2 fixes from the same review: the pageWait loser of every race below gets a no-op catch so a
 * late rejection can never surface unhandled, and the no-observation fallback is JSON null - the
 * previous '"unavailable"' literal parsed truthy and printed scrollY=undefined.) */
const STALL_LIMIT_MS = 20_000;
const ABSENCE_LIMIT_MS = 45_000;
// audio-feed-vn72k: classifier bounds, all DERIVED from the imported measured floor
// (scripts/proof-cdp.ts), none invented. RAF_PROBE_MS applies the measured floor to BeginFrames:
// if the page answers evaluates but no frame fires within it, the compositor is suppressing frames
// while the page is healthy -> renderer starvation, an ENVIRONMENT condition. No stall window is
// widened by this change: STALL_LIMIT_MS still arms at 20s; what changed is that arming it now
// CLASSIFIES instead of assuming.
//
// THE ALIVE PROBE CARRIES DERIVED HEADROOM (audio-feed-vn72k review P2 #1). It used to race
// `String(Date.now())` against MEASURED_STARVED_POLL_MS with ZERO headroom, and a zero-headroom
// race here is a FALSE PRODUCT FAIL generator - the exact flake family this row exists to kill.
// That floor (8s) is what ONE bare evaluate legitimately took under EIGHT-WAY saturation on this
// host (audio-feed-6gst1). The classifier arms precisely when the machine is slow enough to have
// frozen the published counter, so under heavier saturation than the measurement a HEALTHY page's
// evaluate can return later than the floor - and the old verdict for a late answer is HUNG, a
// product FAIL on a correct row. PAGE_ALIVE_PROBE_HEADROOM settles it: 4 x the floor, the same
// shape as the repo's HANG_BOUND_MS = 15 x floor derivation (scripts/proof-cdp.ts) and
// tests/fixtures/invocation_death_window.ts, deliberately BELOW 15 x because 15 x is the bound for
// a page that will never answer at all, and a once-only discriminator should not spend the whole
// hang bound before saying "hung".
// WORST CASE ADDED LATENCY (stated so the number is a decision, not a leftover): the classifier
// arms only after STALL_LIMIT_MS (20s) of a frozen counter, and from there it returns inside
// PAGE_ALIVE_PROBE_MS (32s) + RAF_PROBE_RACE_MS (40s) = 72s - i.e. <= 92s from the freeze to a
// throw it already had to make (20 + 32 + 40, pinned by a test below). The green path never arms
// any of it, and neither bound waits on a page that answers.
export const PAGE_ALIVE_PROBE_HEADROOM = 4;
export const PAGE_ALIVE_PROBE_MS = PAGE_ALIVE_PROBE_HEADROOM * MEASURED_STARVED_POLL_MS;
export const RAF_PROBE_MS = MEASURED_STARVED_POLL_MS;
// The rAF probe's evaluate travels the same saturated CDP path the alive probe just measured, so
// its host-side race is the alive bound PLUS the in-page frame timer - derived, never a literal.
export const RAF_PROBE_RACE_MS = PAGE_ALIVE_PROBE_MS + RAF_PROBE_MS;

/** The three outcomes the STALL classifier can reach (audio-feed-vn72k). */
type StallVerdict = "HUNG" | "WEDGED-WAIT" | "RENDERER-STARVED";

/**
 * The classifier's DECISION, split out from the throws below so the verdict rule is provable
 * without a browser, a frozen counter, or a 20s stall window.
 *
 * The starvation verdict is a claim about the ENVIRONMENT - the compositor stopped scheduling
 * BeginFrames on a healthy page - so it additionally requires the page to have published NO
 * uncaught error. A product fault that pegs the main thread but still answers trivial evaluates
 * looks exactly like starvation from the host; the page's own error flag is the only evidence
 * that separates them, and with it the verdict is HUNG, a product FAIL, never a mislabelled
 * unknown (audio-feed-vn72k review P2 #2).
 */
function stallVerdict(
  alive: "yes" | "timeout" | "threw",
  raf: "frame" | "timer" | "timeout" | "threw",
  pageErr: string | null,
): StallVerdict {
  if (alive !== "yes") return "HUNG";
  if (raf === "frame") return "WEDGED-WAIT";
  if (pageErr !== null) return "HUNG";
  return "RENDERER-STARVED";
}
async function stuckWithDeadline(
  url: string,
  phase: "flip" | "restore",
  pageWait: Promise<string>,
  // deno-lint-ignore no-explicit-any
  evaluate: (expr: string) => Promise<any>,
): Promise<string> {
  pageWait.catch(() => {}); // a late rejection of the loser must never become an unhandled rejection
  let done = false;
  let result: string | undefined;
  let failure: unknown;
  let failed = false;
  pageWait.then((v) => {
    done = true;
    result = v;
  }, (e) => {
    done = true;
    failed = true;
    failure = e;
  });
  const started = Date.now();
  let lastN = -1;
  let lastProgress = started;
  // audio-feed-vn72k (defect two fixed): per-poll accounting. `obsReads` counts polls that saw a
  // numeric observation; `nullReads` counts polls whose read was null, unparseable, or lost the
  // 2s CDP race. A null read used to SKIP the STALL check silently - reads lost to the same
  // starvation being diagnosed looked identical to "no observation published yet" and coasted to
  // the 45s ABSENCE bound. Nulls are now counted AND still feed stall accounting below.
  let obsReads = 0;
  let nullReads = 0;
  // n progression with timestamps, one entry per advance, capped so the one-line summary below
  // stays a single bounded line even in a gate log.
  const nTrace: string[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // audio-feed-vn72k (defect three): every throw prints ONE compact line first, because the gate
  // row truncates messages - this line is what a gate reader gets. Branch, phase, verdict,
  // observation accounting, and the n trace with timestamps.
  const summaryLine = (branch: string, verdict: string) =>
    `audio-feed-vn72k ONE-LINE: url=${url} branch=${branch} phase=${phase} verdict=${verdict} obsReads=${obsReads} nullReads=${nullReads} lastN=${lastN} n-trace=[${
      nTrace.join(" ") || "none"
    }]`;
  // The STALL verdict is a CLASSIFICATION, not an assumption (audio-feed-vn72k): when n has been
  // frozen for STALL_LIMIT_MS, probe (1) whether the page's main thread is alive at all, and
  // (2) whether the compositor is scheduling frames, then name exactly one of three outcomes.
  const classifyStall = async (lastObs: unknown): Promise<never> => {
    const base =
      `${url}: STUCK-WAIT branch=STALL phase=${phase} - __stuckWait.n frozen at ${lastN} for >${
        STALL_LIMIT_MS / 1000
      }s ` +
      `(observations read=${obsReads}, null/lost reads=${nullReads}; n-trace: ${
        nTrace.join(" ") || "none"
      }); ` +
      `last observation=${JSON.stringify(lastObs ?? null)}`;
    // Probe 1 - is the main thread alive? A trivial evaluate inside the derived alive bound
    // (PAGE_ALIVE_PROBE_MS = 4 x MEASURED_STARVED_POLL_MS, headroom explained at the constants).
    // The CDP promise itself never rejects on timeout, so the host must race it. The SAME round
    // trip also reads the page's published uncaught-error flag, so the classification costs no
    // extra latency; it is read HERE, at probe time, because an error that arrives after the
    // probe is the ABSENCE path's business rather than the classifier's.
    let alive: "yes" | "timeout" | "threw" = "timeout";
    let pageErr: string | null = null;
    try {
      alive = await Promise.race([
        evaluate(`JSON.stringify({ now: String(Date.now()), err: window.__stuckErr ?? null })`)
          .then(
            (raw: unknown) => {
              try {
                const parsed = JSON.parse(String(raw)) as { err?: unknown };
                pageErr = parsed.err == null ? null : String(parsed.err);
              } catch {
                // An unparseable reply is proof of life and nothing more - it is not evidence
                // that the page published an error, so the starvation verdict stays reachable.
                pageErr = null;
              }
              return "yes" as const;
            },
            () => "threw" as const,
          ),
        sleep(PAGE_ALIVE_PROBE_MS).then(() => "timeout" as const),
      ]);
    } catch {
      alive = "threw";
    }
    // Probe 2 - is rAF being scheduled at all? A single requestAnimationFrame raced against a
    // bounded in-page timer (RAF_PROBE_MS, the same measured floor); the whole probe is raced
    // host-side because a starved renderer may never service the evaluate either.
    let raf: "frame" | "timer" | "timeout" | "threw" = "timeout";
    if (alive === "yes") {
      const rafExpr = `(async () => { return await Promise.race([` +
        `new Promise((r) => requestAnimationFrame(() => r("frame"))), ` +
        `new Promise((r) => setTimeout(() => r("timer"), ${RAF_PROBE_MS}))]); })()`;
      try {
        raf = await Promise.race([
          evaluate(rafExpr).then(
            (v) =>
              v === "frame"
                ? "frame" as const
                : v === "timer"
                ? "timer" as const
                : "threw" as const,
            () => "threw" as const,
          ),
          sleep(RAF_PROBE_RACE_MS).then(() => "timeout" as const),
        ]);
      } catch {
        raf = "threw";
      }
    }
    const verdict = stallVerdict(alive, raf, pageErr);
    if (verdict === "HUNG") {
      console.error(summaryLine("STALL", "HANG"));
      if (alive !== "yes") {
        throw new Error(
          `${base} - VERDICT: HUNG. The page did not answer String(Date.now()) within ` +
            `${PAGE_ALIVE_PROBE_MS}ms (${PAGE_ALIVE_PROBE_HEADROOM} x the measured starved-poll ` +
            `floor, scripts/proof-cdp.ts; probe ${alive === "threw" ? "threw" : "never returned"}` +
            `) - the renderer is genuinely wedged, a product FAIL (audio-feed-vn72k)`,
        );
      }
      // Alive, no frame fired, and the page published its OWN uncaught error: a product fault has
      // pegged the main thread (or thrown on it) and the missing frames are a symptom of that,
      // not of compositor suppression. Reporting starvation here would label a real product
      // failure as an environment unknown (audio-feed-vn72k review P2 #2).
      throw new Error(
        `${base} - VERDICT: HUNG. The page answers evaluates but published its own uncaught ` +
          `error ("${pageErr}") while no BeginFrame fired - a product fault on the main thread, ` +
          `not renderer starvation, a product FAIL (audio-feed-vn72k)`,
      );
    }
    if (verdict === "WEDGED-WAIT") {
      console.error(summaryLine("STALL", "WEDGED-WAIT"));
      throw new Error(
        `${base} - VERDICT: the wait loop itself is wedged. The page answers evaluates AND frames ` +
          `are still firing (the rAF probe won), so a frozen published counter means the ` +
          `STUCK_STATE_WAIT loop stopped progressing - a product FAIL (audio-feed-vn72k)`,
      );
    }
    // Page responsive, rAF never fired (or the probe evaluate itself was starved out), and the
    // page published NO uncaught error (a published one reached the HUNG verdict above): the
    // compositor is suppressing BeginFrames under gate load. An ENVIRONMENT condition - reported
    // by name with the measurement attached, never a green PASS and never a product FAIL. Deno
    // has no skip-from-body API, so the honest surface is a NAMED UNKNOWN error, distinguishable
    // from any product failure by name, verdict, and the one-line summary above.
    console.error(summaryLine("STALL", "RENDERER-STARVED"));
    const starved = new Error(
      `${base} - VERDICT: RENDERER STARVATION, an environment condition, NOT a product failure. ` +
        `The page answers evaluates, published no uncaught error, but ${
          raf === "timer"
            ? `no BeginFrame fired within ${RAF_PROBE_MS}ms of the probe`
            : `the frame probe itself went unanswered within ${RAF_PROBE_RACE_MS}ms`
        } - under gate load headless Chrome stops scheduling BeginFrames, so a HEALTHY page ` +
        `freezes its frame-coupled counter. Classified UNKNOWN, not PASS and not a hang ` +
        `(audio-feed-vn72k)`,
    );
    starved.name = "StarvationUnknown";
    throw starved;
  };
  for (;;) {
    await sleep(250);
    if (done) {
      // (P2, review round two) test the flag, not the value: a rejection can CARRY undefined, and
      // `failure !== undefined` would then read as success and return undefined into JSON.parse.
      if (failed) {
        console.error(summaryLine("PAGEWAIT", "PAGEWAIT-REJECTED"));
        throw new Error(
          `${url}: STUCK-WAIT branch=PAGEWAIT phase=${phase} - the in-page wait rejected ` +
            `(observations read=${obsReads}, null/lost reads=${nullReads}, lastN=${lastN}): ` +
            `${failure instanceof Error ? failure.message : String(failure)} (audio-feed-vn72k)`,
          { cause: failure },
        );
      }
      return result!;
    }
    // Bounded observation read: even a starved renderer services CDP in milliseconds.
    const raw = await Promise.race([
      evaluate("JSON.stringify(window.__stuckWait ?? null)"),
      new Promise<string>((r) => setTimeout(() => r("null"), 2_000)),
    ]);
    const obs = (() => {
      try {
        return JSON.parse(raw) as
          | { n?: number; scrollY?: number; rectTop?: number; key?: string }
          | null;
      } catch {
        return null;
      }
    })();
    // audio-feed-vn72k (defect two): BOTH arms below run the STALL check - the old code checked
    // it only inside the `obs && typeof obs.n === "number"` branch, so every null read silently
    // reset the stall clock to never. A stalled page whose CDP reads are ALSO being lost now
    // reds by name through the classifier instead of coasting to ABSENCE.
    if (obs && typeof obs.n === "number") {
      obsReads++;
      if (obs.n !== lastN) {
        lastN = obs.n;
        lastProgress = Date.now();
        if (nTrace.length < 40) {
          nTrace.push(`n=${obs.n}@+${((Date.now() - started) / 1000).toFixed(1)}s`);
        }
      } else if (Date.now() - lastProgress > STALL_LIMIT_MS) {
        await classifyStall(obs);
      }
    } else {
      nullReads++;
      if (Date.now() - lastProgress > STALL_LIMIT_MS) {
        await classifyStall(null);
      }
    }
    if (Date.now() - started > ABSENCE_LIMIT_MS) {
      console.error(summaryLine("ABSENCE", "ABSENCE"));
      throw new Error(
        `${url}: STUCK-WAIT branch=ABSENCE phase=${phase} - the stuck ${phase} never landed within ` +
          `${
            ABSENCE_LIMIT_MS / 1000
          }s of the wait (observations read=${obsReads}, null/lost reads=${nullReads}; ` +
          `n-trace: ${nTrace.join(" ") || "none"}) ` +
          // (review round two) the whole observation segment is conditional: with nothing ever
          // published, interpolating obs?.scrollY renders "scrollY=undefined" - nonsense in the
          // one message whose entire job is to be actionable.
          `starting (audio-feed-evhug; ${
            obs
              ? `last observed: scrollY=${obs.scrollY}, rectTop=${obs.rectTop}, last styles=${
                obs.key ?? "none"
              }`
              : "no observation published"
          }) - the stuck block is inert or the transition ` +
          `never started (audio-feed-vn72k)`,
      );
    }
  }
}

const PROBE = (surfaceSel: string, wrapSel: string) =>
  `(() => {
    const surface = document.querySelector(${JSON.stringify(surfaceSel)});
    const wrap = document.querySelector(${JSON.stringify(wrapSel)});
    const cs = getComputedStyle(surface);
    const ws = getComputedStyle(wrap);
    const r = surface.getBoundingClientRect();
    return JSON.stringify({
      supports: CSS.supports("container-type", "scroll-state"),
      shadow: cs.boxShadow,
      bg: cs.backgroundColor,
      border: cs.borderBlockEndColor,
      containerType: ws.containerType,
      position: ws.position,
      top: ws.top,
      z: ws.zIndex,
      rectTop: Math.round(r.top),
      scrollY: Math.round(window.scrollY),
    });
  })()`;

Deno.test("txcz: real scrolling flips the computed stuck styles on both headers; geometry and z-index hold", async () => {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/assets/")) {
      return handleAsset(
        {
          params: { name: decodeURIComponent(url.pathname.slice("/assets/".length)) },
        } as unknown as RouteContext<unknown>,
      );
    }
    if (url.pathname === "/listen") {
      return new Response(tallListenHtml(), { headers: { "content-type": "text/html" } });
    }
    return new Response(
      renderShell({
        nonce: "test-nonce",
        title: "sticky probe",
        viewer: null,
        main: `<div style="block-size:4000px" aria-hidden="true"></div>`,
      }),
      { headers: { "content-type": "text/html" } },
    );
  });
  const port = server.addr.port;
  try {
    const probes = await withChrome(async (evaluate) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const until = async <T>(
        probe: () => Promise<T>,
        ready: (value: T) => boolean,
        timeoutMs = 5000,
      ): Promise<{ value: T; ready: boolean }> => {
        // State-gated CDP poll with a deadline: loops until ready condition matches; host scheduling delay adds poll cycles rather than failing a fixed sleep. It returns the LAST VALUE IT SAW alongside the verdict, so a caller's failure message can print the page's own last observation - a bare `T` narrowed by `assert()` could only ever print `false`.
        const deadline = Date.now() + timeoutMs;
        let value = await probe();
        while (!ready(value) && Date.now() < deadline) {
          await sleep(50);
          value = await probe();
        }
        return { value, ready: ready(value) };
      };
      const measure = async (url: string, surface: string, wrap: string) => {
        await evaluate(
          `location.href = ${JSON.stringify(`http://127.0.0.1:${port}${url}`)}`,
        );
        // The external listen stylesheet can arrive after navigation; scrolling a short
        // document clamps to zero and a later layout does not replay scrollTo().
        // audio-feed-1vxbj: this wait is page LOAD (navigation + stylesheet + layout), not a
        // style-state poll - under a full-gate load a starved renderer blew the 5s default
        // (measured: the gate run failed here at 21s into the row; the isolated pass takes
        // 22s). The END is the event (readyState "complete" && scrollable); the ceiling is
        // DERIVED, not a counted 20s window: this is the same load class the bootstrap
        // scripts bound with HANG_BOUND_MS = 15 x the 8s MEASURED_STARVED_POLL_MS floor
        // (scripts/proof-cdp.ts), because in a loaded fast gate the starved renderer never
        // got there in 20s at all ("/listen: page did not become scrollable within 20s").
        // The state polls below keep their 5s default.
        // The poll's last value IS the diagnostic, so the probe evaluates the page's FACTS and
        // the predicate tests them: `Boolean` over a bare conjunction narrowed the value to the
        // boolean the assert already knows, so `(last poll value: ${loaded})` could only ever
        // print `false` on the one path it existed for. Now it prints what the page actually was.
        const loadState = () => evaluate(NAVIGATION_SAFE(LOAD_STATE_PROBE)).then(JSON.parse);
        const loaded = await until(
          loadState,
          (state) =>
            state.pathname === url && state.readyState === "complete" &&
            state.scrollHeight > state.innerHeight,
          HANG_BOUND_MS,
        );
        assert(
          loaded.ready,
          `${url}: page did not become scrollable within the ${HANG_BOUND_MS}ms derived ` +
            `load ceiling (last poll value: ${JSON.stringify(loaded.value)})`,
        );
        const probe = () => evaluate(PROBE(surface, wrap)).then(JSON.parse);
        // The unscrolled baseline still polls on a wall-clock deadline: no transition is in
        // flight before the first scroll, so there is no mid-transition value to race.
        const before = (await until(
          probe,
          (state) => state.scrollY === 0 && state.rectTop === 0 && state.shadow === "none",
        )).value;
        // From here on the waits are FRAME-COUPLED (audio-feed-mir4g): the flip and the
        // restore are awaited inside the page, and the styles are read only once they are
        // stable across two rendered frames - no assertion can land mid-transition.
        const baseKey = [before.shadow, before.bg, before.border].join("|");
        await evaluate("window.scrollTo(0, 2000)");
        // audio-feed-evhug: the wait is bounded by a HOST deadline that throws with the page's last
        // published observation - a regression reds in seconds with a diagnostic, not in ~100s.
        const flip = JSON.parse(
          await stuckWithDeadline(
            url,
            "flip",
            evaluate(STUCK_STATE_WAIT(surface, baseKey, true)),
            evaluate,
          ),
        );
        assert(
          flip.reached,
          `${url}: the stuck flip never landed (scrollY=${flip.scrollY}, rectTop=${flip.rectTop})`,
        );
        assert(flip.settled, `${url}: the stuck-style transitions never settled`);
        // audio-feed-3y5vv (measured in a loaded full gate): the in-page settle reads stable
        // styles, but the ASSERTED read is a separate CDP evaluation - under load a
        // scroll-state re-evaluation can re-enter the transition between settle and probe, and
        // the probe caught the base colour again ('the stuck edge strengthens
        // rgb(220,216,232) -> rgb(220,216,232)'). The asserted read is therefore the OBSERVED
        // FLIP EVENT: poll the probe until the stuck styles differ from base, bounded by a
        // named guard that throws - never a frame count and never a wider window.
        const flipped = await (async () => {
          const guardDeadline = Date.now() + 20_000; // observability guard with load headroom, not a measurement
          for (;;) {
            const state = await probe();
            if (
              state.shadow !== "none" && state.bg !== before.bg &&
              state.border !== before.border
            ) {
              return state;
            }
            if (Date.now() > guardDeadline) {
              // audio-feed-vn72k: name the branch for the gate reader + the one-line summary.
              console.error(
                `audio-feed-vn72k ONE-LINE: url=${url} branch=GUARD(3y5vv) phase=flip verdict=GUARD-EXPIRED lastRead=shadow=${state.shadow},bg=${state.bg},border=${state.border}`,
              );
              throw new Error(
                `${url}: STUCK-WAIT branch=GUARD(3y5vv) phase=flip - the stuck styles never ` +
                  `reached the flipped values within 20s of settle ` +
                  `(last read: shadow=${state.shadow}, bg=${state.bg}, border=${state.border}) - ` +
                  `the transition either never landed or regressed after settle (audio-feed-3y5vv)`,
              );
            }
            await sleep(50);
          }
        })();
        const after = flipped;
        await evaluate("window.scrollTo(0, 0)");
        const restored = JSON.parse(
          await stuckWithDeadline(
            url,
            "restore",
            evaluate(STUCK_STATE_WAIT(surface, baseKey, false)),
            evaluate,
          ),
        );
        assert(restored.reached, `${url}: scrolling back never un-stuck the header`);
        assert(restored.settled, `${url}: the un-stick transitions never settled`);
        const back = await (async () => {
          const guardDeadline = Date.now() + 20_000; // same observed-event rule for the un-stick read
          for (;;) {
            const state = await probe();
            if (state.shadow === "none") return state;
            if (Date.now() > guardDeadline) {
              // audio-feed-vn72k: name the branch for the gate reader + the one-line summary.
              console.error(
                `audio-feed-vn72k ONE-LINE: url=${url} branch=GUARD(3y5vv) phase=restore verdict=GUARD-EXPIRED lastRead=shadow=${state.shadow}`,
              );
              throw new Error(
                `${url}: STUCK-WAIT branch=GUARD(3y5vv) phase=restore - the header never returned ` +
                  `to the un-stuck styles within 20s of scrolling back ` +
                  `(last read: shadow=${state.shadow}) - the restore regressed after settle (audio-feed-3y5vv)`,
              );
            }
            await sleep(50);
          }
        })();
        return { before, after, back };
      };
      return {
        shell: await measure("/", ".site-header", ".site-header-sticky"),
        listen: await measure("/listen", "header.app", ".app-header-sticky"),
      };
    });

    for (const [label, probe] of Object.entries(probes)) {
      assert(probe.before.supports, `${label}: this Chrome supports scroll-state queries`);
      assertEquals(
        probe.before.containerType,
        "scroll-state",
        `${label}: the wrapper IS the container`,
      );
      assertEquals(probe.before.shadow, "none", `${label}: unscrolled header has no elevation`);
      assertEquals(probe.before.rectTop, 0, `${label}: the header starts at the top of the page`);
      assert(
        probe.after.scrollY > 0 && probe.after.rectTop === 0,
        `${label}: scrolled ${probe.after.scrollY}px and the header is still pinned at the viewport top`,
      );
      assert(
        probe.after.shadow !== "none",
        `${label}: the stuck header gains elevation (${probe.after.shadow})`,
      );
      assert(
        probe.after.bg !== probe.before.bg,
        `${label}: the stuck background firms up (${probe.before.bg} -> ${probe.after.bg})`,
      );
      assert(
        probe.after.border !== probe.before.border,
        `${label}: the stuck edge strengthens (${probe.before.border} -> ${probe.after.border})`,
      );
      // The containment check: the values did not drift, before or after.
      for (const state of ["before", "after"] as const) {
        assertEquals(probe[state].position, "sticky", `${label}/${state}: still sticky`);
        assertEquals(probe[state].top, "0px", `${label}/${state}: offset unchanged`);
        assertEquals(probe[state].z, "5", `${label}/${state}: z-index unchanged`);
      }
      assertEquals(probe.back.shadow, "none", `${label}: scrolling back un-sticks the styles`);
    }
  } finally {
    await server.shutdown();
  }
});

/**
 * audio-feed-vn72k review P2 #1: the alive probe's bound must be DERIVED WITH HEADROOM, and the
 * classifier's total must stay the number its comment claims. No browser, no stall window: this
 * is the constants' own contract, and it reds the moment someone puts the probe back on the bare
 * measured floor (headroom 1), which is the false-product-FAIL shape the row was reviewed for.
 */
Deno.test("txcz: the STALL classifier's bounds are derived from the measured floor, with headroom and a bounded total", () => {
  // The floor itself is imported from scripts/proof-cdp.ts, never restated (audio-feed-6gst1).
  assertEquals(MEASURED_STARVED_POLL_MS, 8_000);
  // The alive probe is 4 x the floor, not the floor.
  assertEquals(PAGE_ALIVE_PROBE_HEADROOM, 4);
  assertEquals(PAGE_ALIVE_PROBE_MS, PAGE_ALIVE_PROBE_HEADROOM * MEASURED_STARVED_POLL_MS);
  assertEquals(PAGE_ALIVE_PROBE_MS, 32_000);
  assert(
    PAGE_ALIVE_PROBE_HEADROOM > 1,
    "the alive probe must carry headroom over the measured starved floor: at 1 x it labels a " +
      "healthy page HUNG under saturation heavier than the measurement (a false product FAIL)",
  );
  // The frame probe keeps the raw floor (a missed frame is an environment UNKNOWN, not a product
  // FAIL), and its host-side race is the alive bound plus that timer - still derived.
  assertEquals(RAF_PROBE_MS, MEASURED_STARVED_POLL_MS);
  assertEquals(RAF_PROBE_RACE_MS, PAGE_ALIVE_PROBE_MS + RAF_PROBE_MS);
  // WORST CASE ADDED LATENCY, pinned to the comment above the constants: the classifier arms after
  // STALL_LIMIT_MS, then bounds the alive probe and the frame race -> 20 + 32 + 40 = 92s from the
  // freeze to a throw it already had to make. A widening of any bound has to restate this line.
  assertEquals(STALL_LIMIT_MS + PAGE_ALIVE_PROBE_MS + RAF_PROBE_RACE_MS, 92_000);
});

/**
 * audio-feed-vn72k review P2 #2: a page that published its OWN uncaught error is not starving.
 * The same observations that read RENDERER-STARVED (an environment UNKNOWN) read HUNG (a product
 * FAIL) once the page's error flag is set - reverting that clause in stallVerdict reds this test.
 */
Deno.test("txcz: a published page error flips the starvation verdict to HUNG", () => {
  // Without an error flag, a page that answers evaluates and fires no frame is starving.
  assertEquals(stallVerdict("yes", "timer", null), "RENDERER-STARVED");
  assertEquals(stallVerdict("yes", "timeout", null), "RENDERER-STARVED");
  // With one, the SAME observations are a product failure.
  assertEquals(stallVerdict("yes", "timer", "TypeError: boom"), "HUNG");
  assertEquals(stallVerdict("yes", "timeout", "unhandledrejection"), "HUNG");
  // The other two branches keep their precedence: a dead page is hung either way, and a firing
  // frame still means the wait loop itself is wedged.
  assertEquals(stallVerdict("timeout", "timer", "TypeError: boom"), "HUNG");
  assertEquals(stallVerdict("threw", "frame", null), "HUNG");
  assertEquals(stallVerdict("yes", "frame", "TypeError: boom"), "WEDGED-WAIT");
});

/** The verdict rule is only reachable if the wait publishes the flag it reads - asserted on the
 * emitted page expression, because a classifier that reads a global nobody sets can never fire. */
Deno.test("txcz: the in-page wait publishes __stuckErr and installs both listeners once", () => {
  const wait = STUCK_STATE_WAIT(".site-header", "base|key", true);
  assertStringIncludes(wait, "window.__stuckErr = null;");
  assertStringIncludes(wait, 'addEventListener("error"');
  assertStringIncludes(wait, 'addEventListener("unhandledrejection"');
  assertStringIncludes(wait, "if (!window.__stuckErrHooked)");
});
