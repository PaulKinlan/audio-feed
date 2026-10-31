/**
 * Browser proof for the /account mobile layout (audio-feed-lma7).
 *
 * Paul, 2026-10-14: "the section class=panel in the account page doesn't work on mobile. It takes
 * up entire width of desktop screen and doesn't have padding or margins or a good layout."
 *
 * The cause was NOT a width, a breakpoint or a missing viewport meta (the three the bead told me to
 * check first): the send form's radio group became a `<fieldset class="choices">` in
 * audio-feed-dc2y and kept its old `</div>` closer, so the HTML parser closed `div.wrap` inside the
 * form. Every `section.panel` after that point was a SIBLING of the page column rather than a child
 * of it, so it had the panel's own padding but none of the wrap's max-width or 1rem gutter - full
 * viewport width at 390px. Nothing about the response status, the text or any per-element assertion
 * changes when a tag is broken, so this proof drives the real served page and measures the box.
 *
 * Four things are checked on `GET /account`, and the FIRST ONE IS A CONTROL:
 *
 *   1. THE CONTROL: the served markup with that one closer flipped (`</fieldset>` -> `</div>`, the
 *      only difference) puts at least three panels OUTSIDE the page column and hard against the
 *      viewport edge, while the served markup puts none. The control is built as the OPPOSITE of
 *      whatever is served, so the check fails in both directions - and a proof whose assertion has
 *      never been seen to be false is not evidence (docs/evidence/README.md, "Honesty").
 *   2. Every `section.panel` on the served page is a DESCENDANT of `div.wrap`, measured with
 *      `closest()`, not inferred from the markup.
 *   3. At a real mobile viewport (390x844 and again at 320x720) every panel is inset from both
 *      viewport edges by the page column's own gutter (>= 16px), and the document does not scroll
 *      sideways - read from `clientWidth` and a real `scrollTo(20, 0)`, because a mobile layout
 *      viewport EXPANDS to its overflowing content and `scrollWidth <= innerWidth` is therefore a
 *      check that cannot fail (review of audio-feed-lma7; it did pass while the page was 6px too
 *      wide at 320px).
 *   4. The two-column pair still pairs: at 390px Profile/Passkeys are ONE column (stacked), and at
 *      1280px they are side by side inside the page column - so the fix restores the mobile
 *      behaviour without flattening the desktop layout.
 *
 * The proof is served on the canonical proof port (8133) so it is reproducible; an explicit
 * ACCOUNT_LAYOUT_PROOF_PORT may name a different one, and anything but the canonical port writes to
 * a temp directory instead of the committed evidence tree.
 *
 *   deno run --allow-all --unstable-kv scripts/account-mobile-layout-proof.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { Episode, Source } from "../src/types.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { runProof, withChrome, writeEvidenceReadme } from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";
import { evidencePngDigestLine } from "./evidence-png-digest.ts";
import { HARNESS_PORT_DEFAULT, resolveHarnessPort } from "./harness-port.ts";

const PROOF_PORT = resolveHarnessPort([], Deno.env.get("ACCOUNT_LAYOUT_PROOF_PORT"));
if (PROOF_PORT === 0) throw new Error("Layout evidence requires a fixed port, not 0");
const CANONICAL = PROOF_PORT === HARNESS_PORT_DEFAULT;
const OUT = CANONICAL
  ? new URL("../docs/evidence/audio-feed-lma7/", import.meta.url).pathname
  : `${await Deno.makeTempDir({ prefix: "audio-feed-lma7-local-" })}/`;
await Deno.mkdir(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mobile viewports the panel is measured at. 390x844 is the bead's own default. */
const MOBILE_VIEWPORTS: ReadonlyArray<readonly [number, number]> = [[390, 844], [320, 720]];

/** The page column's own gutter, from `.wrap { padding: 2rem 1rem ... }`. */
const WRAP_GUTTER_PX = 16;

/**
 * The two forms of the one closer, keyed on the element the send form's radio group is closed by.
 * Matching on the closing tag AND the element that follows it pins the site to the radio group
 * rather than to any `</fieldset>` or `</div>` the page might gain later.
 */
const FIXED_GROUP = /<\/fieldset>(\s*<p class="feedback" id="sendFeedback")/;
const BROKEN_GROUP = /<\/div>(\s*<p class="feedback" id="sendFeedback")/;

await runProof("audio-feed-lma7", async (checker) => {
  const config: AppConfig = { port: PROOF_PORT };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };

  // TWO SOURCES AND ONE READY EPISODE, because that is what this proof's README claims and what the
  // committed screenshots show. An earlier revision seeded only a user while the README described
  // the richer fixture, and the screenshots said "No sources yet." - a README claiming more than the
  // fixture holds (review of audio-feed-lma7, P2). The shapes mirror scripts/account-harness.ts.
  const baseInstant = "2026-10-12T03:30:00.000Z";
  const rawUser = await createUser(stores.metadata, {
    email: "paul@example.com",
    displayName: "Paul Kinlan",
  });
  // EVERY INSTANT ON THE SEEDED USER IS PINNED, NOT JUST THE TOKEN (audio-feed-8dp2). createUser()
  // stamps a live createdAt (src/auth/users.ts:105) and approveUser() a live decidedAt, so an earlier
  // revision of this file claimed "every instant is fixed" while two instants on the user were the wall
  // clock. Neither is rendered on /account today, which is why the screenshots never moved and the
  // review's P3 was about the CLAIM rather than the bytes - but a sentence like that has to be
  // literally true, or it teaches the next reader to trust a determinism claim nobody checks. The
  // fixture is asserted below, so unpinning either one fails the proof rather than silently
  // invalidating the README.
  const approved = await approveUser(stores.metadata, rawUser.id, "admin");
  const user = { ...approved, createdAt: baseInstant, decidedAt: baseInstant };
  // The feed URL is rendered on the page, so its token must be PINNED or every run produces
  // different bytes and the committed screenshots are not reproducible (audio-feed-5sei).
  user.feedToken = "feedtokenpaul0000000000000000001";
  await stores.metadata.putUser(user);
  const sessionSecret = await createSession(stores.metadata, user.id);
  const sources: Source[] = [];
  for (
    const [id, title, feedUrl, modes] of [
      ["stratechery", "Stratechery", "https://stratechery.com/feed/", ["direct"]],
      [
        "simonw",
        "Simon Willison's Weblog",
        "https://simonwillison.net/atom/everything/",
        ["direct", "deepdive"],
      ],
    ] as const
  ) {
    const source: Source = {
      id,
      userId: user.id,
      title,
      feedUrl,
      modes: [...modes],
      voices: {},
      createdAt: baseInstant,
      lastPolledAt: baseInstant,
    };
    sources.push(source);
    await stores.metadata.putSource(source);
  }
  const episode: Episode = {
    id: "ep-0",
    userId: user.id,
    sourceId: "stratechery",
    sourceTitle: "Stratechery",
    articleId: "a-0",
    mode: "direct",
    status: "ready",
    title: "The end of the beginning",
    createdAt: baseInstant,
    audioKey: `audio/${user.id}/direct/ep-0.wav`,
    contentType: "audio/wav",
    byteLength: 4,
    readyAt: baseInstant,
    // Published on older prompts, so /account offers Regenerate - the same reason the account
    // harness sets it (audio-feed-ktn). It is also what makes the episodes panel render its
    // section-title buttons rather than an empty state.
    promptVersion: "old-prompts",
  };
  await stores.metadata.putEpisode(episode);

  const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve(
      { port: PROOF_PORT, onListen: () => {} },
      (req, info) => appFetch(req, info),
    );
  } catch (error) {
    await stores.metadata.close();
    if (error instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `Layout proof port ${PROOF_PORT} is busy; retry when free, or use ACCOUNT_LAYOUT_PROOF_PORT=8134 for local-only OS-temp evidence`,
        { cause: error },
      );
    }
    throw error;
  }
  const port = (server.addr as Deno.NetAddr).port;
  const BASE = `http://localhost:${port}`;
  config.port = port;
  config.publicBaseUrl = BASE;

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  function check(name: string, pass: boolean, detail = "") {
    checks.push({ name, pass, detail });
    checker.check(name, pass, detail);
    if (!pass) throw new Error(`step failed: ${name}`);
  }

  // THE README'S DETERMINISM CLAIM, CHECKED RATHER THAN DESCRIBED (audio-feed-8dp2). The fixture is
  // read from the objects this proof seeded, so removing any pin below turns this red: createUser()
  // and approveUser() stamp the wall clock into createdAt/decidedAt, and the episode and sources are
  // pinned by hand. The claim is about the FIXTURE, which is why it is asserted here and not by
  // reading the page - none of these instants is rendered on /account, and that is exactly how a
  // determinism claim drifts away from the truth without anyone noticing.
  const liveInstants = [
    ["user.createdAt", user.createdAt],
    ["user.decidedAt", user.decidedAt],
    ["user.feedToken", user.feedToken],
    ...sources.flatMap((s, i) =>
      [[`sources[${i}].createdAt`, s.createdAt], [
        `sources[${i}].lastPolledAt`,
        s.lastPolledAt,
      ]] as const
    ),
    ["episode.createdAt", episode.createdAt],
    ["episode.readyAt", episode.readyAt],
  ] as ReadonlyArray<readonly [string, string | undefined]>;
  const unpinned = liveInstants.filter(([name, value]) =>
    name.endsWith("feedToken")
      ? value !== "feedtokenpaul0000000000000000001"
      : value !== baseInstant
  );
  check(
    "every instant (and the token) in the fixture is pinned, so the committed screenshots cannot drift with the clock or a random token",
    unpinned.length === 0,
    unpinned.length === 0
      ? `${liveInstants.length} values pinned to ${baseInstant} (the token to its fixed value)`
      : `UNPINNED: ${unpinned.map(([name, value]) => `${name}=${value}`).join(", ")}`,
  );

  // The served markup, taken as TEXT so the control below can carry the one-line revert: the DOM a
  // browser builds is already normalised, so a broken tag cannot be re-injected through it.
  const served = await fetch(`${BASE}/account`, {
    headers: { cookie: `${SESSION_COOKIE}=${sessionSecret}` },
  });
  const servedHtml = await served.text();

  try {
    await withChrome(async (chrome) => {
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
      ws.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)!(msg);
            pending.delete(msg.id);
          }
        } catch { /* malformed frame */ }
      });

      function cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          pending.set(id, (res) => {
            if (res.error) reject(new Error(`${method}: ${JSON.stringify(res.error)}`));
            else resolve(res.result);
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      }

      async function js(expr: string): Promise<unknown> {
        const res = (await cdp("Runtime.evaluate", {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
        if (res.exceptionDetails) {
          throw new Error(`${expr}: ${JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result?.value;
      }

      async function until(expr: string, label: string, timeout = 15_000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          try {
            if (await withHangBound(js(expr), `${label} poll: ${expr}`)) return;
          } catch (err) {
            // A hang bound is not the transient navigation error this loop retries: the main thread
            // did not answer within MEASURE_HANG_BOUND_MS, so re-polling would hang identically and
            // the caller would only ever see "Timed out waiting for", which names no bound.
            if (err instanceof HangBoundExceeded) throw err;
            /* transient during navigation */
          }
          await sleep(100);
        }
        throw new Error(`Timed out waiting for ${label}`);
      }

      async function viewport(width: number, height: number) {
        await cdp("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: width < 700,
        });
      }

      /**
       * What the page column actually did to every panel: containment first, then the box, then
       * whether the document overflows. `closest()` is the containment question asked of the DOM
       * rather than of the markup.
       */
      const MEASURE = `(() => {
        const panels = [...document.querySelectorAll("section.panel")];
        const scrolling = document.scrollingElement || document.documentElement;
        scrolling.scrollTo(20, 0);
        const scrollX = Math.round(scrolling.scrollLeft);
        scrolling.scrollTo(0, 0);
        return {
          viewportWidth: window.innerWidth,
          clientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          scrollXAfterScrollTo20: scrollX,
          wrapPresent: document.querySelector("div.wrap") !== null,
          panels: panels.map((panel) => {
            const box = panel.getBoundingClientRect();
            return {
              label: panel.getAttribute("aria-labelledby") || panel.className,
              insideWrap: panel.closest("div.wrap") !== null,
              left: Math.round(box.left),
              right: Math.round(document.documentElement.clientWidth - box.right),
              width: Math.round(box.width),
            };
          }),
        };
      })()`;

      /**
       * HANG BOUNDS, NOT LATENCY BOUNDS. `MEASURE` is a synchronous layout read -
       * `getBoundingClientRect()` over the page's `section.panel`s, `closest("div.wrap")` containment
       * and `scrollWidth` after a real `scrollTo(20, 0)` - so a healthy answer costs one forced reflow,
       * tens of ms, and nothing inside it waits on the network or on a timer. What can take arbitrarily
       * long is the EVALUATE being scheduled at all: `Runtime.evaluate` queues behind whatever the
       * page's main thread is doing, and this host has MEASURED a bare `readyState === "complete"`
       * evaluate legitimately exceeding 8s under eight-way CPU saturation (audio-feed-6gst1). That
       * measured starved floor is the unit.
       *
       * 120s = 15 x that 8s floor, and ~4000x a real 30ms reflow. A page whose main thread never
       * answers still fails, in two minutes rather than hanging until something outside the proof
       * kills the lane - and it fails with a message naming what was asked and the budget it had.
       */
      const MEASURED_STARVED_POLL_MS = 8_000;
      const MEASURE_HANG_BOUND_MS = 15 * MEASURED_STARVED_POLL_MS;

      /**
       * The bound is applied HERE rather than by polling `MEASURE`: a poll would re-run the read and
       * could report a box from a later state than the call asked about, and this file's `js()` has no
       * bound of its own. Racing the evaluate leaves the abandoned promise pending; the throw fails
       * the proof and `withChrome` closes the browser in its teardown, so nothing waits on it.
       */
      async function measure(timeoutMs = MEASURE_HANG_BOUND_MS) {
        let timer: ReturnType<typeof setTimeout> | 0 = 0;
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `MeasureTimeout: the MEASURE evaluate (section.panel boxes via getBoundingClientRect, ` +
                    `div.wrap containment, scrollWidth after scrollTo(20, 0)) got no answer in ` +
                    `${timeoutMs}ms - the hang bound in force (the default is 15 x the ` +
                    `${MEASURED_STARVED_POLL_MS}ms measured starved-poll floor), not a latency bound, ` +
                    `and MEASURE is a single synchronous layout read with no poll behind it, so the ` +
                    `page's main thread never answered it.`,
                ),
              ),
            timeoutMs,
          );
        });
        try {
          return (await Promise.race([js(MEASURE), expired])) as {
            viewportWidth: number;
            clientWidth: number;
            documentScrollWidth: number;
            scrollXAfterScrollTo20: number;
            wrapPresent: boolean;
            panels: Array<{
              label: string;
              insideWrap: boolean;
              left: number;
              right: number;
              width: number;
            }>;
          };
        } finally {
          clearTimeout(timer);
        }
      }

      /**
       * HANG BOUNDS, NOT LATENCY BOUNDS - the same race `measure()` runs, for the evaluates that are
       * NOT the layout read: `until()`'s readiness poll, the `/account` pathname read, the two
       * Profile/Passkeys pairing reads and `clipAround`. Every one of them is a synchronous read of
       * the document - `readyState`, `location.pathname`, `querySelector`, `getBoundingClientRect()` -
       * so a healthy answer costs microseconds to one forced reflow, and nothing inside it waits on
       * the network or on a timer. What can take arbitrarily long is the EVALUATE being scheduled at
       * all: `Runtime.evaluate` queues behind whatever the page's main thread is doing, and this host
       * has MEASURED a bare `readyState === "complete"` evaluate legitimately exceeding 8s under
       * eight-way CPU saturation (audio-feed-6gst1). 120s = 15 x that measured floor.
       *
       * `measure()` keeps its own copy of this race rather than calling this helper: its
       * `MeasureTimeout` message was reviewed and cleared at 4cc6b4b3, and a shared message builder
       * would have had to reword it. The timer semantics here are identical - one timer, cleared in
       * `finally`, with the abandoned evaluate left pending for `withChrome`'s teardown.
       */
      class HangBoundExceeded extends Error {}

      async function withHangBound<T>(
        pending: Promise<T>,
        whatWasEvaluated: string,
        timeoutMs = MEASURE_HANG_BOUND_MS,
      ): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | 0 = 0;
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new HangBoundExceeded(
                  `HangBoundExceeded: the ${whatWasEvaluated} evaluate got no answer in ` +
                    `${timeoutMs}ms - the hang bound in force (15 x the ${MEASURED_STARVED_POLL_MS}ms ` +
                    `measured starved-poll floor), not a latency bound: that expression is a ` +
                    `synchronous DOM read, so that long means the page's main thread never answered it.`,
                ),
              ),
            timeoutMs,
          );
        });
        try {
          return await Promise.race([pending, expired]);
        } finally {
          clearTimeout(timer);
        }
      }

      async function screenshot(name: string, clip: Record<string, number>) {
        const shot = (await cdp("Page.captureScreenshot", {
          format: "png",
          clip: { ...clip, scale: 1 },
          captureBeyondViewport: true,
        })) as { data: string };
        const path = `${OUT}${name}`;
        await Deno.writeFile(path, Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)));
        await quantiseEvidencePng(path);
        return path;
      }

      /** The clips are computed from the live page so they frame the panels, not a guess. */
      const clipAround = `(() => {
        const first = document.querySelector('section.panel[aria-labelledby="feeds-h"]');
        if (!first) return null;
        const box = first.getBoundingClientRect();
        const top = Math.max(0, box.top + window.scrollY - 12);
        return { x: 0, y: Math.round(top), width: window.innerWidth,
                 height: Math.min(Math.round(window.innerHeight - 24), Math.round(box.height + 24)) };
      })()`;

      try {
        await cdp("Page.enable");
        await cdp("Runtime.enable");
        await cdp("Network.enable");
        await cdp("Network.setCookie", {
          name: SESSION_COOKIE,
          value: sessionSecret,
          url: `${BASE}/`,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
        });

        // ---------------------------------------------------------------- 1. THE CONTROL
        //
        // The control document is the served response with that one closer flipped, so it is always
        // the OPPOSITE of what is served and the two can be compared directly. If the served page is
        // the broken one, the control is the fixed one, the escape counts invert, and this check is
        // the thing that fails - which is the mutant.
        const servedClosesWith = FIXED_GROUP.test(servedHtml)
          ? "`</fieldset>`"
          : "a stale `</div>`";
        const controlHtml = FIXED_GROUP.test(servedHtml)
          ? servedHtml.replace(FIXED_GROUP, "</div>$1")
          : servedHtml.replace(BROKEN_GROUP, "</fieldset>$1");
        check(
          "exactly one closer for the send form's radio group was found in the served markup, and the control flips it",
          controlHtml !== servedHtml &&
            controlHtml.includes('class="choices" aria-label="How should it sound?"'),
          `served ${servedHtml.length} bytes closing the group with ${servedClosesWith}; control ${controlHtml.length} bytes`,
        );
        const controlDir = await Deno.makeTempDir({ prefix: "audio-feed-lma7-control-" });
        const controlFile = `${controlDir}/control-markup.html`;
        await Deno.writeTextFile(controlFile, controlHtml);

        await viewport(390, 844);
        await cdp("Page.navigate", { url: `file://${controlFile}` });
        await until(`document.readyState === "complete"`, "control document");
        const control = await measure(MEASURE_HANG_BOUND_MS);
        const escaped = control.panels.filter((p) => !p.insideWrap);

        // ---------------------------------------------------------------- 2/3. THE FIXED PAGE
        await cdp("Page.navigate", { url: `${BASE}/account` });
        await until(`document.readyState === "complete"`, "served /account");
        check(
          "the browser is on the served /account page, not redirected to /login",
          String(
            await withHangBound(
              js(`window.location.pathname`),
              "window.location.pathname for the served-/account check",
            ),
          ) === "/account",
          `pathname: ${
            String(
              await withHangBound(
                js(`window.location.pathname`),
                "window.location.pathname for the served-/account check's detail line",
              ),
            )
          }`,
        );
        const fixedAt390 = await measure(MEASURE_HANG_BOUND_MS);
        const servedEscaped = fixedAt390.panels.filter((p) => !p.insideWrap);

        check(
          "ONE CLOSER IS THE WHOLE BUG: the control markup puts panels outside the page column and the served markup puts none",
          escaped.length >= 3 && servedEscaped.length === 0,
          `control: ${escaped.length} of ${control.panels.length} outside div.wrap (${
            escaped.map((p) => `${p.label} x=${p.left} w=${p.width}`).join(", ") || "none"
          }); served: ${servedEscaped.length} outside`,
        );
        check(
          "and the escaped panel in the control sits hard against the viewport edge, which is Paul's report",
          escaped.some((p) => p.left === 0 && p.right === 0),
          escaped.map((p) => `${p.label}: left ${p.left}, right ${p.right}`).join("; ") ||
            "no escaped panel",
        );

        for (const [width, height] of MOBILE_VIEWPORTS) {
          await viewport(width, height);
          await cdp("Page.navigate", { url: `${BASE}/account` });
          await until(`document.readyState === "complete"`, `served /account at ${width}px`);
          const at = await measure(MEASURE_HANG_BOUND_MS);
          check(
            `at ${width}x${height} the page column exists, so a panel has somewhere to be contained BY`,
            at.wrapPresent && at.panels.length >= 6,
            `wrap present: ${at.wrapPresent}, ${at.panels.length} section.panel`,
          );
          check(
            `at ${width}x${height} EVERY section.panel is a descendant of div.wrap`,
            at.panels.every((p) => p.insideWrap),
            at.panels.map((p) => `${p.label}: ${p.insideWrap ? "inside" : "OUTSIDE"}`).join(", "),
          );
          check(
            `at ${width}x${height} every panel is inset by the page column's ${WRAP_GUTTER_PX}px gutter`,
            at.panels.every((p) => p.left >= WRAP_GUTTER_PX && p.right >= WRAP_GUTTER_PX),
            at.panels.map((p) => `${p.label}: left ${p.left}, right ${p.right}`).join("; "),
          );
          check(
            `at ${width}x${height} the page does not scroll sideways - measured against clientWidth and a real scrollTo, not innerWidth`,
            at.documentScrollWidth <= at.clientWidth && at.scrollXAfterScrollTo20 === 0,
            `scrollWidth ${at.documentScrollWidth} vs clientWidth ${at.clientWidth}; scrollX after scrollTo(20,0) is ${at.scrollXAfterScrollTo20}; innerWidth ${at.viewportWidth}${
              at.viewportWidth > at.clientWidth
                ? " (the layout viewport EXPANDED - innerWidth alone would have hidden this)"
                : ""
            }`,
          );
          check(
            `at ${width}x${height} the two-column pair is ONE column (Profile stacked over Passkeys)`,
            Boolean(
              await withHangBound(
                js(`(() => {
                  const a = document.querySelector('section.panel[aria-labelledby="profile-h"]');
                  const b = document.querySelector('section.panel[aria-labelledby="passkeys-h"]');
                  if (!a || !b) return false;
                  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                  return Math.abs(ra.left - rb.left) < 1 && rb.top >= ra.top;
                })()`),
                `the Profile/Passkeys stacked-column read at ${width}x${height}`,
              ),
            ),
            "profile and passkeys share a left edge and stack vertically",
          );
        }

        // The screenshots are taken at the mobile viewport the bead names, framing the "Your feeds"
        // panel - the first panel that used to escape the page column.
        await viewport(390, 844);
        await cdp("Page.navigate", { url: `${BASE}/account` });
        await until(`document.readyState === "complete"`, "mobile /account for capture");
        const afterClip = (await withHangBound(
          js(clipAround),
          "clipAround (the Your feeds panel box framed by 01/02-*-390x844)",
        )) as Record<string, number> | null;
        check(
          "the 'Your feeds' panel was found on the served page to frame the screenshot",
          afterClip !== null,
          afterClip ? JSON.stringify(afterClip) : "not found",
        );
        await screenshot("02-after-390x844.png", afterClip!);

        await cdp("Page.navigate", { url: `file://${controlFile}` });
        await until(`document.readyState === "complete"`, "control document for capture");
        await screenshot("01-before-390x844.png", afterClip!);

        // 4. The desktop column is not flattened by the fix.
        await viewport(1280, 900);
        await cdp("Page.navigate", { url: `${BASE}/account` });
        await until(`document.readyState === "complete"`, "desktop /account");
        const desktop = await measure(MEASURE_HANG_BOUND_MS);
        check(
          "at 1280x900 the panels sit inside the 58rem column, not the full window",
          desktop.panels.every((p) => p.insideWrap) &&
            desktop.panels.every((p) => p.width < 1000),
          desktop.panels.map((p) => `${p.label}: left ${p.left}, width ${p.width}`).join("; "),
        );
        check(
          "at 1280x900 Profile and Passkeys pair into two columns",
          Boolean(
            await withHangBound(
              js(`(() => {
                const a = document.querySelector('section.panel[aria-labelledby="profile-h"]');
                const b = document.querySelector('section.panel[aria-labelledby="passkeys-h"]');
                if (!a || !b) return false;
                const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                return rb.left > ra.right - 1 && Math.abs(rb.top - ra.top) < 1;
              })()`),
              "the Profile/Passkeys desktop pairing read at 1280x900",
            ),
          ),
          "passkeys sits to the right of profile on the same row",
        );
        await screenshot("03-after-1280x900.png", {
          x: 0,
          y: 0,
          width: 1280,
          height: 900,
        });

        const digests = await Promise.all([
          evidencePngDigestLine(`${OUT}01-before-390x844.png`, "01-before-390x844.png"),
          evidencePngDigestLine(`${OUT}02-after-390x844.png`, "02-after-390x844.png"),
          evidencePngDigestLine(`${OUT}03-after-1280x900.png`, "03-after-1280x900.png"),
        ]);

        await writeEvidenceReadme({
          dir: OUT,
          title: "Browser Proof: /account panel layout on mobile (audio-feed-lma7)",
          script: "scripts/account-mobile-layout-proof.ts",
          asserts: checks.map((c) => c.name),
          sections: [
            {
              heading: "Test Environment",
              body:
                `- **Browser:** Headless Chrome over CDP, mobile emulation at 390x844 and 320x720, desktop at 1280x900\n` +
                `- **Page:** \`GET /account\` from the real app on memory stores, signed in with a seeded session cookie, on the canonical proof port\n` +
                `- **Data:** one approved user, two sources and one ready episode - enough for every panel to render, and the exact fixture this page describes. The user's feed token is PINNED, and every instant on the seeded user (\`createdAt\`, \`decidedAt\`), both sources (\`createdAt\`, \`lastPolledAt\`) and the episode (\`createdAt\`, \`readyAt\`) is PINNED to one timestamp, because a random token or a live clock would make the committed screenshots irreproducible. The pins are ASSERTED by this proof, not merely described here - see the "every instant in the fixture is pinned" check (audio-feed-5sei, audio-feed-8dp2)`,
            },
            {
              heading: "What the bug was",
              body:
                `The send form's narration-style radio group became \`<fieldset class="choices">\` (audio-feed-dc2y) and kept its old \`</div>\` closer. An end tag for a \`div\` closes every element the parser has open above the matching \`div\`, and the matching one was \`div.wrap\` - so the page column ended *inside the send form*. Every \`section.panel\` after it (Your feeds, Profile, Passkeys, Recent episodes, the danger zone) was a sibling of the column: it kept the panel's own padding, but had none of the wrap's \`max-inline-size\` or its 1rem gutter, and so ran edge to edge at 390px. That is Paul's report, and it is why no width or breakpoint was at fault: the shared \`.panel\` and \`.wrap\` rules were correct, and \`/login\` and every admin page rendered through the same kit were already fine (checked with the same walk).`,
            },
            {
              heading: "Why the control is the first check",
              body:
                `The control document is the served response with the one closer flipped, so it is always the OPPOSITE of what is served: one of the two carries the bug and the other does not, and the check asserts the escape counts invert between them. Without it these checks would be a capture - a containment assertion that has never been seen to be false cannot tell a fixed page from a page that never had the bug. It also makes the \`01-before\` screenshot's label a proved claim rather than an assumption.`,
            },
            {
              heading: "Execution Log",
              body: `\`\`\`\n${
                checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")
              }\n\`\`\``,
            },
            {
              heading: "Screenshots",
              body:
                `- \`01-before-390x844.png\`: the control - the served markup with the one closer reverted, framed on "Your feeds". The panel runs to both viewport edges.\n` +
                `- \`02-after-390x844.png\`: the same frame on the served page. The panel is inset by the page column's gutter.\n` +
                `- \`03-after-1280x900.png\`: the desktop column, where Profile and Passkeys still pair.\n` +
                digests.join("\n"),
            },
          ],
        });
        console.log(`Saved proof report to ${OUT}README.md`);
      } finally {
        try {
          ws?.close();
        } catch { /* ignore */ }
      }
    });
  } finally {
    try {
      await server.shutdown();
    } catch { /* ignore */ }
    try {
      await stores.metadata.close();
    } catch { /* ignore */ }
  }
});
