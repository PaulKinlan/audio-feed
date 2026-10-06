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
import { createTempChromeProfile, newestChrome } from "../scripts/proof-helper.ts";

/** The listen page with enough episodes to scroll well past its sticky header. */
function tallListenHtml(): string {
  const episodes = Array.from({ length: 40 }, (_, i) => ({
    ...makeEpisode({ id: `ep-${i}`, title: `Episode ${i}` }),
    audioUrl: `https://example.com/audio/ep-${i}.wav`,
  }));
  return renderListenPage({
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
  const shell = renderShell({ title: "probe", viewer: null, main: "" });
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

/** Launch headless Chrome, connect over CDP, hand the caller an evaluate(). */
async function withChrome<T>(
  // deno-lint-ignore no-explicit-any
  fn: (evaluate: (expr: string) => Promise<any>) => Promise<T>,
): Promise<T> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-txcz-");
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
      const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    };
    return await fn(evaluate);
  } finally {
    try {
      chrome.kill();
    } catch {
      // already gone
    }
    cleanup();
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
      ): Promise<T> => {
        const deadline = Date.now() + 5000;
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
        const loaded = await until(
          () =>
            evaluate(
              `location.pathname === ${
                JSON.stringify(url)
              } && document.readyState === "complete" && document.documentElement.scrollHeight > innerHeight`,
            ),
          Boolean,
        );
        assert(loaded, `${url}: page did not become scrollable`);
        const probe = () => evaluate(PROBE(surface, wrap)).then(JSON.parse);
        const before = await until(
          probe,
          (state) => state.scrollY === 0 && state.rectTop === 0 && state.shadow === "none",
        );
        await evaluate("window.scrollTo(0, 2000)");
        const after = await until(
          probe,
          (state) =>
            state.scrollY > 0 && state.rectTop === 0 && state.shadow !== "none" &&
            state.bg !== before.bg && state.border !== before.border,
        );
        await evaluate("window.scrollTo(0, 0)");
        const back = await until(probe, (state) => state.scrollY === 0 && state.shadow === "none");
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
