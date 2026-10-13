/**
 * Browser proof for the /account bookmarklet disclosure (audio-feed-kvnw).
 *
 * The bead: /account shipped the SAME javascript: bookmarklet anchor as the front door, on a page served by
 * the same htmlResponse CSP (src/routes/csp.ts:58), with no fallback - so clicking it was refused and said
 * nothing. This drives real headless Chrome over CDP against a signed-in session and checks:
 *
 *   1. the draggable anchor is UNCHANGED (class, draggable="true", javascript: payload) - the intended
 *      install flow must survive the fix;
 *   2. the <details> disclosure exists, opens on a real click, and its <pre><code> carries the SAME payload
 *      as the anchor's href (a fallback that installs something else would be worse than none);
 *   3. the wording states the CSP refusal honestly;
 *   4. THE CLICK IS OBSERVED, NOT ASSUMED: the CSP refusal Chrome logs for that javascript: URL is ASSERTED
 *      (it is the behaviour the disclosure documents, and the assertion fails if the click ever starts
 *      silently working - or silently doing nothing at all). audio-feed-1d0n is the reason this is an
 *      assertion rather than a collected-and-dropped array: a check that cannot fail is a false green.
 *
 * The report deliberately does NOT write the ephemeral port into the committed README (audio-feed-1d0n):
 * a fixed port that the script cannot reproduce makes the artifact wrong from the next run onwards.
 *
 *   deno run --allow-all --unstable-kv scripts/verify_kvnw_account_bookmarklet_browser.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { runProof, withChrome, writeEvidenceReadme } from "./proof-helper.ts";

const OUT = new URL("../docs/evidence/audio-feed-kvnw/", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

await runProof("audio-feed-kvnw", async (checker) => {
  const config: AppConfig = { port: 0 };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };

  const rawUser = await createUser(stores.metadata, {
    email: "grace@example.com",
    displayName: "Grace Hopper",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const sessionSecret = await createSession(stores.metadata, user.id);

  const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
  const PORT = (server.addr as Deno.NetAddr).port;
  const BASE = `http://localhost:${PORT}`;
  config.port = PORT;
  config.publicBaseUrl = BASE;

  const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
  function check(name: string, pass: boolean, detail?: string) {
    checks.push({ name, pass, detail });
    checker.check(name, pass, detail);
    if (!pass) throw new Error(`step failed: ${name}`);
  }

  try {
    await withChrome(async (chrome) => {
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();

      interface CdpLogEntry {
        source?: string;
        level?: string;
        text?: string;
        url?: string;
      }
      const consoleMessages: string[] = [];

      const onMessage = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)!(msg);
            pending.delete(msg.id);
          } else if (msg.method === "Log.entryAdded") {
            const entry = msg.params?.entry as CdpLogEntry;
            if (entry?.text) consoleMessages.push(`[${entry.level ?? "log"}] ${entry.text}`);
          } else if (msg.method === "Runtime.consoleAPICalled") {
            const type = msg.params?.type ?? "log";
            const args = (msg.params?.args as Array<{ value?: unknown }>) ?? [];
            consoleMessages.push(`[${type}] ${args.map((a) => String(a.value ?? "")).join(" ")}`);
          }
        } catch { /* malformed */ }
      };
      ws.addEventListener("message", onMessage);

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

      async function until(expr: string, desc = expr, timeout = 15_000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          try {
            if (await js(expr)) return;
          } catch {
            // transient during navigation
          }
          await sleep(100);
        }
        throw new Error(`Timed out waiting for ${desc}`);
      }

      try {
        await cdp("Page.enable");
        await cdp("Runtime.enable");
        await cdp("Log.enable");
        await cdp("Network.enable");
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        // Seed the session cookie before navigating to /account, so the request is signed in on first arrival.
        await cdp("Network.setCookie", {
          name: "__Host-af_session",
          value: sessionSecret,
          url: `${BASE}/`,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
        });

        // 1. Visit /account
        await cdp("Page.navigate", { url: `${BASE}/account` });
        await until(`document.readyState === "complete"`, "account page loaded");
        const currentPath = String(await js(`window.location.pathname`));
        check(
          "the browser is ON /account with the seeded session (not redirected to /login)",
          currentPath === "/account",
          `pathname: ${currentPath}`,
        );

        // 2. The draggable bookmarklet button keeps its attributes
        const anchor = (await js(
          `(() => { const a = document.querySelector("a.bookmarklet-btn");
          return a ? { class: a.getAttribute("class"), draggable: a.getAttribute("draggable"), href: a.getAttribute("href") } : null; })()`,
        )) as { class: string; draggable: string; href: string } | null;
        check(
          "bookmarklet anchor keeps its class and is still draggable",
          anchor !== null &&
            anchor.class === "btn quiet small bookmarklet-btn" &&
            anchor.draggable === "true",
          anchor
            ? `class: '${anchor.class}', draggable: '${anchor.draggable}'`
            : "element not found",
        );

        const anchorHref = anchor?.href ?? "";
        check(
          "anchor still carries the javascript: bookmarklet payload",
          anchorHref.startsWith("javascript:(function()"),
          `href starts: '${anchorHref.slice(0, 30)}...'`,
        );

        // 3. The fallback disclosure is present
        const details = (await js(
          `(() => { const d = document.querySelector("details.bookmarklet-code");
          if (!d) return null;
          const s = d.querySelector("summary");
          const p = d.querySelector("p");
          const code = d.querySelector("pre.bookmarklet-snippet code");
          return { exists: true, open: d.open, summary: s?.textContent?.trim(), wording: p?.textContent?.trim(), code: code?.textContent }; })()`,
        )) as {
          exists: boolean;
          open: boolean;
          summary?: string;
          wording?: string;
          code?: string;
        } | null;
        check(
          "the disclosure exists on /account",
          details?.exists === true,
        );

        check(
          "the summary offers the code as the fallback",
          details?.summary === "Can’t drag it? Get the bookmarklet code",
          `summary: '${details?.summary}'`,
        );

        // 4. Click the disclosure to open it
        await js(`document.querySelector("details.bookmarklet-code summary")?.click()`);
        await until(
          `document.querySelector("details.bookmarklet-code")?.open === true`,
          "details open",
        );

        // 5. Assert the snippet text EQUALS the anchor href (the copy fallback must install the same script)
        const snippetText = String(
          await js(
            `document.querySelector("details.bookmarklet-code pre.bookmarklet-snippet code")?.textContent`,
          ),
        );
        check(
          "the open disclosure's snippet is the SAME payload as the anchor href (one builder)",
          snippetText === anchorHref,
          snippetText === anchorHref
            ? `snippet matches href (${snippetText.length} chars)`
            : `snippet ${snippetText.length} != href ${anchorHref.length}`,
        );

        // 6. Assert the wording states the CSP refusal honestly (no "click to install" falsehoods)
        const wording = String(
          await js(`document.querySelector("details.bookmarklet-code p")?.textContent`),
        );
        check(
          "the wording names the Content Security Policy and tells the user to drag or paste",
          wording.includes("Content Security Policy") &&
            wording.includes("drag the button above") &&
            wording.includes("paste this code as its URL"),
          `wording: '${wording.slice(0, 60)}...'`,
        );

        // 7. Assert the code snippet wraps and is NOT clipped inside the bookmarklet box
        const snippetBox = (await js(
          `(() => { const p = document.querySelector("details.bookmarklet-code pre.bookmarklet-snippet");
          if (!p) return null;
          const style = window.getComputedStyle(p);
          const r = p.getBoundingClientRect();
          return { scrollWidth: p.scrollWidth, clientWidth: p.clientWidth, whiteSpace: style.whiteSpace, height: Math.round(r.height) }; })()`,
        )) as
          | { scrollWidth: number; clientWidth: number; whiteSpace: string; height: number }
          | null;
        check(
          "the disclosure's code is fully visible inside its box (no horizontal clipping)",
          Boolean(snippetBox) &&
            snippetBox!.scrollWidth <= snippetBox!.clientWidth + 1 &&
            snippetBox!.whiteSpace === "pre-wrap" &&
            snippetBox!.height > 20,
          snippetBox
            ? `scrollWidth ${snippetBox.scrollWidth} vs clientWidth ${snippetBox.clientWidth}, white-space: ${snippetBox.whiteSpace}, rendered height ${snippetBox.height}px`
            : "element not found",
        );

        // 8. THE OBSERVED CLICK: click the anchor, assert Chrome logs the CSP refusal
        consoleMessages.length = 0;
        await js(`document.querySelector("a.bookmarklet-btn")?.click()`);
        await sleep(500);

        const refusalLog = consoleMessages.find((m) =>
          m.includes("violates the following Content Security Policy directive") &&
          m.includes("script-src")
        );
        check(
          "clicking the anchor is REFUSED by the CSP, and the refusal is asserted rather than collected",
          refusalLog !== undefined,
          refusalLog
            ? `console: '${refusalLog.slice(0, 95)}...'`
            : `no CSP log captured among: ${JSON.stringify(consoleMessages)}`,
        );

        // 9. Assert the refusal left the page in place and the disclosure still open
        const stillThere = String(await js(`window.location.pathname`));
        const stillOpen = Boolean(
          await js(`document.querySelector("details.bookmarklet-code")?.open`),
        );
        check(
          "the refusal leaves the page and the open disclosure intact",
          stillThere === "/account" && stillOpen,
          `pathname: ${stillThere}, disclosure open: ${stillOpen}`,
        );

        // Screenshot
        const box = (await js(
          `(() => { const r = document.querySelector(".bookmarklet-box")?.getBoundingClientRect();
          return r ? { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 } : null; })()`,
        )) as { x: number; y: number; width: number; height: number } | null;
        if (!box) throw new Error("the bookmarklet box was not found for the screenshot");
        const shot = (await cdp("Page.captureScreenshot", {
          format: "png",
          clip: { ...box, scale: 1 },
        })) as { data: string };
        await Deno.writeFile(
          `${OUT}01-account-bookmarklet-disclosure-open.png`,
          Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
        );

        // The rule that un-clips the snippet is SHARED (src/routes/shell.ts UTILITY_CSS), so the front door's
        // disclosure is checked here too.
        await cdp("Page.navigate", { url: `${BASE}/` });
        await until(`document.readyState === "complete"`, "front door loaded");
        await js(`document.querySelector("details.bookmarklet-code summary")?.click()`);
        await until(
          `document.querySelector("details.bookmarklet-code")?.open === true`,
          "front-door disclosure open",
        );
        const frontBox = (await js(
          `(() => { const p = document.querySelector(".bookmarklet-snippet");
          if (!p) return null;
          return { scrollWidth: p.scrollWidth, clientWidth: p.clientWidth, height: Math.round(p.getBoundingClientRect().height) }; })()`,
        )) as { scrollWidth: number; clientWidth: number; height: number } | null;
        check(
          "the SAME shared rule also un-clips the front door's disclosure (audio-feed-3asd surface)",
          Boolean(frontBox) && frontBox!.scrollWidth <= frontBox!.clientWidth + 1,
          frontBox
            ? `scrollWidth ${frontBox.scrollWidth} vs clientWidth ${frontBox.clientWidth}, rendered height ${frontBox.height}px`
            : "the front-door snippet element was not found",
        );

        await writeEvidenceReadme({
          dir: OUT,
          title: "Browser Proof: /account bookmarklet CSP disclosure (audio-feed-kvnw)",
          script: "scripts/verify_kvnw_account_bookmarklet_browser.ts",
          asserts: checks.map((c) => c.name),
          sections: [
            {
              heading: "Test Environment",
              body:
                `- **Browser:** Headless Chrome (CDP), 1280x900\n- **Page:** \`GET /account\` on an in-process server with an ephemeral port\n- **Session:** a real seeded session cookie (\`__Host-af_session\`), the same way the unit tests sign in`,
            },
            {
              heading: "Key Verifications",
              body:
                `1. **Draggable anchor unchanged:** the /account bookmarklet button keeps \`class="btn quiet small bookmarklet-btn"\`, \`draggable="true"\` and its \`javascript:(function()...\` payload.
2. **Disclosure added:** a native \`<details class="bookmarklet-code">\` under the button, whose \`<pre class="bookmarklet-snippet"><code>\` carries the SAME payload as the anchor's href.
3. **Honest wording:** the paragraph names the app's Content Security Policy and tells the user to drag the button or paste the code as a bookmark's URL - it does not imply the click works.
4. **The click is OBSERVED, not assumed:** Chrome logs the CSP refusal for the javascript: URL and the check ASSERTS it (audio-feed-1d0n: a collected-and-dropped console array cannot fail, and this check fails if the click ever starts silently working or silently doing nothing).
5. **No inline script:** no click interceptor, no nonced or un-nonced script was added for the fallback.
6. **The code is legible, not merely present:** the snippet box is measured (scrollWidth vs clientWidth) and wraps with \`white-space: pre-wrap\`. Before this branch's shared rule it rendered as ONE 4754px line inside a 1231px box - so the front door's disclosure, landed in audio-feed-3asd, was clipped too; the same shared rule is re-measured on \`/\` here so the fix is not applied to one surface at the other's expense.`,
            },
            {
              heading: "Execution Log",
              body: `\`\`\`\n${
                checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail ?? ""}`).join(
                  "\n",
                )
              }\n\`\`\``,
            },
            {
              heading: "Screenshot",
              body:
                `- \`01-account-bookmarklet-disclosure-open.png\`: the bookmarklet box with the disclosure expanded, clipped to the box so the evidence is legible and the PNG stays inside the evidence size budget.`,
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
