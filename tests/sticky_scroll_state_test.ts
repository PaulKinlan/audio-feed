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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderShell, SHELL_CSS } from "../src/routes/shell.ts";
import { renderListenPage } from "../src/routes/listen.ts";
import { assetBody, handleAsset } from "../src/routes/assets.ts";
import type { RouteContext } from "../src/router.ts";
import { makeEpisode } from "./fixtures.ts";
import {
  createTempChromeProfile,
  killChromeAndWait,
  newestChrome,
  removeDirWhenQuiet,
  waitForChromeProfileUnused,
} from "../scripts/proof-helper.ts";

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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // audio-feed-w5f1: BEFORE the allocation, and restored in the finally below - see the helper above.
  const { root, restore } = await scratchRootForProfiles();
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-txcz-", root);
  const chrome = new Deno.Command(newestChrome(), {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  let cdpPort = "";
  for (let i = 0; i < 50 && !cdpPort; i++) {
    await sleep(100);
    cdpPort = (await Deno.readTextFile(`${profileDir}/DevToolsActivePort`).catch(() => "")).split(
      "\n",
    )[0]!;
  }
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
    await killChromeAndWait(chrome);
    await cleanup();
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
 *   - STALL: the counter is frozen > STALL_LIMIT_MS (20s) -> the renderer stopped painting ->
 *     throw, named, with the last observation. 20s is >1000 missed frames against a ~16ms frame
 *     and ~3x the entire worst measured green wait - the ~100x margin precedent
 *     (tests/grounded_script_test.ts:679) applied to the thing actually being bounded. It treats a
 *     total rAF pause as a hang: an assumption that fits this row, not a proven property.
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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    await sleep(250);
    if (done) {
      // (P2, review round two) test the flag, not the value: a rejection can CARRY undefined, and
      // `failure !== undefined` would then read as success and return undefined into JSON.parse.
      if (failed) throw failure;
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
    if (obs && typeof obs.n === "number") {
      if (obs.n !== lastN) {
        lastN = obs.n;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > STALL_LIMIT_MS) {
        throw new Error(
          `${url}: the stuck ${phase} STALLED - the page stopped publishing observations for ` +
            `${
              STALL_LIMIT_MS / 1000
            }s (last observed: scrollY=${obs.scrollY}, rectTop=${obs.rectTop}, ` +
            `last styles=${obs.key}) - the renderer hung mid-wait (audio-feed-evhug)`,
        );
      }
    }
    if (Date.now() - started > ABSENCE_LIMIT_MS) {
      throw new Error(
        `${url}: the stuck ${phase} never landed within ${ABSENCE_LIMIT_MS / 1000}s of the wait ` +
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
          `never started`,
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
      ): Promise<T> => {
        // State-gated CDP poll with a deadline: loops until ready condition matches; host scheduling delay adds poll cycles rather than failing a fixed sleep.
        const deadline = Date.now() + timeoutMs;
        let value = await probe();
        while (!ready(value) && Date.now() < deadline) {
          await sleep(50);
          value = await probe();
        }
        return value;
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
        // 22s). It gets 20s; the state polls below keep 5s.
        const loaded = await until(
          () =>
            evaluate(
              `location.pathname === ${
                JSON.stringify(url)
              } && document.readyState === "complete" && document.documentElement.scrollHeight > innerHeight`,
            ),
          Boolean,
          20_000,
        );
        assert(loaded, `${url}: page did not become scrollable within 20s`);
        const probe = () => evaluate(PROBE(surface, wrap)).then(JSON.parse);
        // The unscrolled baseline still polls on a wall-clock deadline: no transition is in
        // flight before the first scroll, so there is no mid-transition value to race.
        const before = await until(
          probe,
          (state) => state.scrollY === 0 && state.rectTop === 0 && state.shadow === "none",
        );
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
              throw new Error(
                `${url}: the stuck styles never reached the flipped values within 20s of settle ` +
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
              throw new Error(
                `${url}: the header never returned to the un-stuck styles within 20s of scrolling back ` +
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
