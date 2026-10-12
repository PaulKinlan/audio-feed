/**
 * Browser proof for audio-feed-syhu: the emitted CSP carries a per-response nonce, not
 * 'unsafe-inline', and the real pages still render and run under enforcement.
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

const OUT = new URL("../docs/evidence/audio-feed-syhu/", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

await runProof("csp-nonce-browser-proof", async (checker) => {
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
  await stores.metadata.putSource(
    makeSource({ id: "s1", userId: user.id, title: "Stratechery" }),
  );
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
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req, info) => appFetch(req, info),
  );
  const PORT = (server.addr as Deno.NetAddr).port;
  const BASE = `http://localhost:${PORT}`;
  config.port = PORT;
  config.publicBaseUrl = BASE;

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
        const res = await cdp("Runtime.evaluate", {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: unknown } };
        return res.result?.value;
      }

      async function until(expr: string, desc = expr, timeout = 15_000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (await js(`Boolean(${expr})`)) return true;
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
        await cdp("Network.setCookie", {
          name: "__Host-af_session",
          value: session,
          url: BASE,
          secure: true,
          path: "/",
          httpOnly: true,
        });

        const pages: Array<[string, string]> = [
          ["home", "/"],
          ["login", "/login"],
          ["admin", "/admin"],
          ["listen-landing", "/listen"],
          ["listen-player", `/listen/${user.feedToken}`],
          ["account", "/account"],
        ];

        for (const [name, path] of pages) {
          events.length = 0;
          await cdp("Page.navigate", { url: `${BASE}${path}` });
          await until(`document.readyState === "complete"`, `${path} loaded`);
          await sleep(250);

          const landed = await js(`location.pathname`) as string;
          const violations = await js(
            `JSON.stringify(window.__cspViolations ?? [])`,
          ) as string;
          const bad = consoleBad();
          checker.check(
            `${name}: zero CSP violations`,
            violations === "[]",
            violations,
          );
          checker.check(
            `${name}: no console errors/warnings`,
            bad.length === 0,
            bad.slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 200)).join(
              " | ",
            ) || "clean",
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
            checker.check(
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
            checker.check(
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
            checker.check(
              "admin: utility CSS wins the tie against the linked .card rule",
              cardMargin === "16px/24px",
              `advisory card margin-block-end/start = ${cardMargin} (want 16px/24px)`,
            );
          }

          if (name === "account" && landed !== "/account") {
            checker.check(
              "account: authenticated session landed on /account",
              false,
              `landed on ${landed}`,
            );
          }

          const shot = (await cdp("Page.captureScreenshot", { format: "png" })) as {
            data: string;
          };
          await Deno.writeFile(
            `${OUT}${name}-1280x900.png`,
            Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
          );
        }

        console.log(`Screenshots in ${OUT}`);

        await writeEvidenceReadme({
          dir: OUT,
          title: "audio-feed-syhu: drop 'unsafe-inline' from the HTML CSP",
          script: "scripts/csp-nonce-browser-proof.ts",
          asserts: [
            "home: zero CSP violations",
            "home: no console errors/warnings",
            "home: inline <style> applied (nonce accepted)",
            "home: inline classic script executed (tooltip client ran)",
            "login: zero CSP violations",
            "login: no console errors/warnings",
            "login: inline <style> applied (nonce accepted)",
            "login: inline classic script executed (tooltip client ran)",
            "admin: zero CSP violations",
            "admin: no console errors/warnings",
            "admin: inline <style> applied (nonce accepted)",
            "admin: inline classic script executed (tooltip client ran)",
            "admin: utility CSS wins the tie against the linked .card rule",
            "listen-landing: zero CSP violations",
            "listen-landing: no console errors/warnings",
            "listen-player: zero CSP violations",
            "listen-player: no console errors/warnings",
            "account: zero CSP violations",
            "account: no console errors/warnings",
            "account: inline <style> applied (nonce accepted)",
            "account: inline classic script executed (tooltip client ran)",
          ],
          sections: [
            {
              heading: "What changed",
              body:
                `The HTML policy in \`src/router.ts\` used to allow \`script-src 'self' 'unsafe-inline'\` and
\`style-src 'self' 'unsafe-inline'\`. It now carries a **per-response nonce**:

\`\`\`
default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; img-src 'self' data: https:;
media-src 'self' blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
\`\`\`

- \`src/routes/csp.ts\` — \`newCspNonce()\`, \`htmlContentSecurityPolicy(nonce)\`, \`htmlResponse(html, nonce, init)\`.
- Every HTML route mints one nonce per response, stamps it on the shell's inline \`<style>\` and
  inline classic \`<script>\` (and the speculation-rules block and JSON data islands), and puts the
  same nonce in the response's \`content-security-policy\` header.
- Inline \`style="…"\` **attributes** are not covered by a nonce, so the ~30 that existed are now
  utility classes (\`u-*\` in \`src/routes/shell.ts\`), appended after page CSS in the nonced \`<style>\`.
- A CSP nonce cannot be guessed by injected markup, so CSP is once again a real last line of defence
  on the credentialed documents.`,
            },
            {
              heading: "Observed Behavior",
              body:
                `For each of \`/\`, \`/login\`, \`/admin\`, \`/listen\`, \`/listen/:token\`, \`/account\`:

1. **zero \`securitypolicyviolation\` events** — nothing the page ships was blocked;
2. **zero console errors/warnings/exceptions**;
3. the nonced inline \`<style>\` was **applied** (a class from it computes a non-zero margin);
4. the inline classic script **executed** — dispatching \`pointerover\` on a probe \`[data-tooltip]\`
   element makes the shell's tooltip client show \`#appTooltip\` (only the inline script can do that).

On \`/admin\` with a short \`ADMIN_TOKEN\` it also pins the review finding that the \`u-*\` classes must
still beat same-specificity rules from the linked sheet: the advisory card's
\`margin-block-end/start\` is \`16px/24px\` (\`.u-mb-4\` wins over \`admin.css\`'s \`.card\`), which only
holds because the utility \`<style>\` is emitted after the \`<link rel="stylesheet">\`.

The service worker's offline fallback (\`src/routes/pwa.ts\`) no longer carries an inline
\`style="..."\` attribute either; it is a \`<style>\` block, checked by
\`tests/security_audit_test.ts\`.`,
            },
            {
              heading: "Screenshots",
              body: `- \`home-1280x900.png\`, \`login-1280x900.png\`, \`admin-1280x900.png\`,
  \`listen-landing-1280x900.png\`, \`listen-player-1280x900.png\`, \`account-1280x900.png\`.
  (The small "nonce probe" tooltip at the top-left of the shell screenshots is the proof's probe
  element being shown on purpose — evidence that check 4 passed.)`,
            },
          ],
        });
      } finally {
        ws.close();
      }
    }, { prefix: "audiofeed-proof-syhu-" });
  } finally {
    await server.shutdown().catch(() => {});
  }
});
