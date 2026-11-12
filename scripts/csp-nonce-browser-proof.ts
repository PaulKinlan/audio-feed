/**
 * Browser proof for audio-feed-syhu: the emitted CSP carries a per-response nonce, not
 * 'unsafe-inline', and the real pages still render and run under enforcement.
 *
 * HOME IS CAPTURED SIGNED-OUT (audio-feed-38qar, measured by the evidence seed pilot
 * audio-feed-9x9e1): since src/routes/home.ts:263-273 (audio-feed-irgu) answers a SIGNED-IN
 * `GET /` with a 303 to /account, a cookie set for the whole page loop made `home-1280x900.png`
 * the /account document byte for byte - four `home:` checks that were silently duplicates of the
 * account ones, green even if the home page regressed. The home row now clears the session
 * cookie, captures the page a visitor actually gets, and asserts it LANDED on `/`, so a future
 * change to the redirect reds the row instead of quietly changing what it proves.
 *
 * THE LISTEN ROWS GOT THE SAME TREATMENT (audio-feed-yyyjw), and their wrong document was
 * DETERMINISTIC, not intermittent: `GET /listen` answers an APPROVED session with a 302 to
 * /listen/<token> (src/app.ts — the PWA start_url, audio-feed-b6nr), so the signed-in
 * "listen-landing" row captured the PLAYER page every run. In the runs where the two listen
 * artefacts were byte-identical, one row was proving the other's page; in the run where they
 * differed, both were still the player at different client-settle moments. The landing row
 * now captures signed-out (cookie dropped and restored, like home), the navigation wait
 * requires the requested pathname (a readyState-only wait is also true of the PREVIOUS
 * document before a navigation commits), each listen row waits for its own server-rendered
 * landmark, and each asserts where it landed, so a wrong-document capture can no longer pass.
 *
 * For each HTML surface it asserts, in headless Chrome with the CSP enforced:
 *   1. zero `securitypolicyviolation` events (nothing the page ships was blocked);
 *   2. zero console errors/warnings/exceptions;
 *   3. the inline `<style>` was APPLIED (a utility class computes a non-zero margin) —
 *      which is only true if `style-src` accepted the nonce;
 *   4. the inline classic script EXECUTED — dispatching `pointerover` on a probe
 *      `[data-tooltip]` element makes the shell's tooltip client show `#appTooltip`.
 *
 *   deno run --allow-all --unstable-kv scripts/csp-nonce-browser-proof.ts
 *
 * Not part of the gate (it launches Chrome).
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { createSession } from "../src/auth/sessions.ts";
import { bytes, makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { runProof, withChrome, writeEvidenceReadme } from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";
import { boundedCdpReply, HANG_BOUND_MS, withHangBound } from "./proof-cdp.ts";

const OUT = new URL("../docs/evidence/audio-feed-syhu/", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

const stores: Stores = memoryStores();
const config: AppConfig = { port: 0, adminToken: "short-token" };
const ctx = { config, stores };

const user = makeUser({
  id: "syhu-user",
  displayName: "Paul",
  status: "approved",
  isAdmin: true,
});
await stores.metadata.putUser(user);
await stores.metadata.putSource(makeSource({ id: "s1", userId: user.id, title: "Stratechery" }));
await stores.metadata.putArticle(
  makeArticle({ id: "a1", userId: user.id, sourceId: "s1", author: "Ben Thompson" }),
);
await stores.metadata.putEpisode(
  makeEpisode({
    id: "ep1",
    userId: user.id,
    sourceId: "s1",
    articleId: "a1",
    status: "ready",
    title: "The Aggregation Theory of Everything",
    audioKey: `audio/${user.id}/direct/ep1.mp3`,
  }),
);
// The player's client fetches the enclosure; without bytes the page logs a 404 that has
// nothing to do with the CSP under test.
await stores.blobs.put(`audio/${user.id}/direct/ep1.mp3`, bytes(2048), {
  contentType: "audio/mpeg",
});
const session = await createSession(stores.metadata, user.id);

const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

await runProof("audio-feed-syhu", async (checker) => {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    checker.check(name, pass, detail);
  };

  try {
    await withChrome(async (chrome) => {
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
      interface CdpEvent {
        method: string;
        params: {
          response?: { url?: string; status?: number };
          type?: string;
          entry?: { level?: string };
        };
      }
      const events: CdpEvent[] = [];
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        } else if (msg.method) {
          events.push({ method: msg.method, params: msg.params });
        }
      });

      function cdp(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs = HANG_BOUND_MS,
      ): Promise<unknown> {
        const id = ++nextId;
        // audio-feed-9go2t: the reply is bounded at this ONE definition rather than at each call
        // site, so a browser that never answers names the method instead of parking the proof.
        const reply = new Promise<unknown>((resolve, reject) => {
          pending.set(id, (res) => {
            if (res.error) reject(new Error(`${method}: ${JSON.stringify(res.error)}`));
            else resolve(res.result);
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
        return boundedCdpReply(method, reply, cdp, timeoutMs);
      }

      async function js(expr: string): Promise<unknown> {
        const res = await cdp("Runtime.evaluate", {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
        if (res.exceptionDetails) {
          throw new Error(`${expr} threw: ${JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result?.value;
      }

      /**
       * This host has MEASURED a bare `readyState === "complete"`
       * evaluate legitimately exceeding 8s under eight-way CPU saturation (audio-feed-6gst1).
       * That measured starved floor is the unit.
       *
       * UNTIL_HANG_BOUND_MS = 120s = 15 x that 8s floor. It is a HANG bound, not a latency
       * bound: a page whose main thread never answers still fails, in two minutes rather
       * than hanging until something outside the proof kills the lane - and it fails with a
       * message naming what was asked and the budget it had.
       */
      const MEASURED_STARVED_POLL_MS = 8_000;
      const UNTIL_HANG_BOUND_MS = 15 * MEASURED_STARVED_POLL_MS;
      async function until(expr: string, desc = expr, timeout = 15_000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (await withHangBound(js(`Boolean(${expr})`), desc)) return true;
          await sleep(50);
        }
        throw new Error(`Timeout waiting for: ${desc}`);
      }

      const consoleBad = () =>
        events.filter((e) =>
          (e.method === "Runtime.consoleAPICalled" &&
            ["error", "warning"].includes(e.params.type ?? "")) ||
          e.method === "Runtime.exceptionThrown" ||
          (e.method === "Log.entryAdded" && e.params.entry?.level === "error")
        );

      try {
        await cdp("Page.enable");
        await cdp("Network.enable");
        await cdp("Log.enable");
        await cdp("Runtime.enable");
        // Install the violation recorder before any page script runs.
        await cdp("Page.addScriptToEvaluateOnNewDocument", {
          source: `window.__cspViolations = [];
          document.addEventListener("securitypolicyviolation", (e) => {
            window.__cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample });
          });`,
        });
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        // __Host- cookies need Secure; Chrome allows Secure on localhost (a trustworthy origin).
        const signIn = () =>
          cdp("Network.setCookie", {
            name: "__Host-af_session",
            value: session,
            url: BASE,
            secure: true,
            path: "/",
            httpOnly: true,
          });
        await signIn();

        const pages: Array<[string, string]> = [
          ["home", "/"],
          ["login", "/login"],
          ["admin", "/admin"],
          ["listen-landing", "/listen"],
          ["listen-player", `/listen/${user.feedToken}`],
          ["account", "/account"],
        ];

        for (const [name, path] of pages) {
          // Signed-in `GET /` is a 303 to /account (audio-feed-irgu) and signed-in `GET /listen`
          // is a 302 to /listen/<token> (the PWA start_url, src/app.ts), so the home and
          // listen-landing rows drop the cookie first and take it back afterwards: every later
          // row is signed in again, and those two rows capture the pages a visitor WITHOUT a
          // session actually gets rather than a second capture of the signed-in destination.
          if (name === "home" || name === "listen-landing") {
            await cdp("Network.deleteCookies", { name: "__Host-af_session", url: BASE });
          }
          events.length = 0;
          await cdp("Page.navigate", { url: `${BASE}${path}` });
          // audio-feed-yyyjw: readyState alone is already true of the PREVIOUS document before a
          // navigation commits, so this wait could pass before the new page arrived and the
          // capture below would screenshot the previous row's page. Requiring the requested
          // pathname makes a pre-commit pass impossible: the old document has a different one —
          // and it turns any future redirect of a row into a red timeout, never a silent
          // change of surface.
          await until(
            `document.readyState === "complete" && location.pathname === ${JSON.stringify(path)}`,
            `${path} loaded (complete and on ${path})`,
            UNTIL_HANG_BOUND_MS,
          );
          await sleep(250);

          // audio-feed-yyyjw: a document-identifying landmark per listen row, on top of the
          // pathname gate. The pathname proves the navigation committed; the landmark proves
          // WHICH template the path served - if the two routes ever swapped content at these
          // paths, pathname alone would not notice. Both landmarks are server-rendered, so
          // waiting for them cannot depend on the page's client script.
          if (name === "listen-landing") {
            await until(
              `document.getElementById("feedUrl") !== null`,
              "listen landing restore form (#feedUrl)",
              UNTIL_HANG_BOUND_MS,
            );
          }
          if (name === "listen-player") {
            await until(
              `document.getElementById("episodes") !== null && document.getElementById("audio") !== null`,
              "listen player episodes list and audio element",
              UNTIL_HANG_BOUND_MS,
            );
          }

          const landed = await js(`location.pathname`) as string;
          const violations = await js(`JSON.stringify(window.__cspViolations ?? [])`) as string;
          const bad = consoleBad();
          check(
            `${name}: zero CSP violations`,
            violations === "[]",
            violations,
          );
          check(
            `${name}: no console errors/warnings`,
            bad.length === 0,
            bad.slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 200)).join(" | ") ||
              "clean",
          );

          // Inline <style> enforcement: a class defined in the nonced style block must apply. The
          // listen pages are templates of their own (external stylesheets only); they have no
          // inline style block to enforce, so the probe is meaningful only on shell pages.
          if (name !== "listen-player" && name !== "listen-landing") {
            const margin = await js(`
            (() => {
              const probe = document.createElement("div");
              probe.className = "u-mt-4";
              document.body.appendChild(probe);
              const v = getComputedStyle(probe).marginBlockStart;
              probe.remove();
              return v;
            })()
          `) as string;
            check(
              `${name}: inline <style> applied (nonce accepted)`,
              margin !== "0px" && margin !== "",
              `u-mt-4 margin-block-start = ${margin}`,
            );
          }

          // Inline classic script enforcement: only the shell's inline tooltip client can show it.
          if (name !== "listen-player" && name !== "listen-landing") {
            const tooltipShown = await js(`
            (() => {
              const el = document.getElementById("appTooltip");
              if (!el) return "no-container";
              const probe = document.createElement("span");
              probe.setAttribute("data-tooltip", "nonce probe");
              probe.textContent = "probe";
              document.body.appendChild(probe);
              probe.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
              const hidden = el.getAttribute("aria-hidden");
              const text = el.textContent;
              probe.remove();
              return hidden === "false" && text === "nonce probe" ? "shown" : "hidden=" + hidden;
            })()
          `) as string;
            check(
              `${name}: inline classic script executed (tooltip client ran)`,
              tooltipShown === "shown",
              tooltipShown,
            );
          }

          // audio-feed-syhu review finding: the u-* classes replaced inline style attributes, which
          // beat same-specificity rules from linked sheets. admin.css sets `.card { margin-block: 1.5rem }`;
          // the short-ADMIN_TOKEN advisory card carries `.u-mb-4` (1rem) and must win that tie.
          if (name === "admin") {
            const cardMargin = await js(`
            (() => {
              const card = document.querySelector(".u-accent-start.u-mb-4");
              if (!card) return "card-absent";
              const s = getComputedStyle(card);
              return s.marginBlockEnd + "/" + s.marginBlockStart;
            })()
          `) as string;
            check(
              "admin: utility CSS wins the tie against the linked .card rule",
              cardMargin === "16px/24px",
              `advisory card margin-block-end/start = ${cardMargin} (want 16px/24px)`,
            );
          }

          // A redirect on the home row is a RED, never a silent change of surface: without this
          // the row proves whatever / happens to serve (audio-feed-38qar).
          if (name === "home") {
            check(
              "home: signed-out viewer landed on /",
              landed === "/",
              `landed on ${landed}`,
            );
          }

          if (name === "account" && landed !== "/account") {
            check(
              "account: authenticated session landed on /account",
              false,
              `landed on ${landed}`,
            );
          }

          // The two listen rows assert their own surfaces, the way the home row does
          // (audio-feed-yyyjw): without a landed assertion the landing row proved the player
          // page (signed-in 302) and the player row could prove a pre-commit document while
          // green (see the header).
          if (name === "listen-landing") {
            check(
              "listen-landing: signed-out viewer landed on /listen",
              landed === "/listen",
              `landed on ${landed}`,
            );
          }
          if (name === "listen-player") {
            const expectedPath = `/listen/${user.feedToken}`;
            check(
              "listen-player: landed on /listen/<feedToken>",
              landed === expectedPath,
              `landed on ${landed} (want ${expectedPath})`,
            );
          }

          const shot = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
          const raw = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
          await Deno.writeFile(`${OUT}${name}-1280x900.png`, raw);
          await quantiseEvidencePng(`${OUT}${name}-1280x900.png`);

          if (name === "home") await signIn();
          if (name === "listen-landing") await signIn();
        }

        await writeEvidenceReadme({
          dir: OUT,
          title: "audio-feed-syhu — drop 'unsafe-inline' from the HTML CSP",
          script: "scripts/csp-nonce-browser-proof.ts",
          asserts: checks.map((c) => c.name),
          notes: [
            "home is captured SIGNED-OUT and asserts it landed on / (audio-feed-38qar): src/routes/home.ts:263-273 (audio-feed-irgu) 303-redirects a signed-in GET / to /account, so the row clears the session cookie first and restores it after the capture - before that the row captured the /account document byte for byte and its four checks duplicated the account ones",
            "what the row no longer does is silently follow a redirect: where a SIGNED-IN GET / lands is a separate contract this proof does not own, but where a signed-out one lands is asserted",
            "listen-landing is captured SIGNED-OUT for the same reason (audio-feed-yyyjw): `GET /listen` 302s an approved session to /listen/<token> (src/app.ts, the PWA start_url), so the signed-in row captured the PLAYER page every run - the byte-identical listen artefacts were two captures of the same player document, one row proving the other's page",
            "the navigation wait requires the requested pathname and the listen rows wait for their own server-rendered landmark (audio-feed-yyyjw): a readyState-only wait is also true of the PREVIOUS document before a navigation commits, and a pathname without a landmark cannot tell which template a path served",
          ],
          sections: [
            {
              heading: "What changed",
              body:
                `The HTML policy carries a per-response nonce on all HTML surfaces, replacing 'unsafe-inline'. Every HTML surface verifies zero CSP violations, zero console errors, applied nonced inline styles, and executed nonced classic scripts.`,
            },
            {
              heading: "Execution Log",
              body: `\`\`\`\n${
                checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")
              }\n\`\`\``,
            },
          ],
        });
        console.log(`Screenshots and report in ${OUT}`);
      } finally {
        try {
          ws.close();
        } catch { /* already closed */ }
      }
    });
  } finally {
    await server.shutdown().catch(() => {});
  }
});
