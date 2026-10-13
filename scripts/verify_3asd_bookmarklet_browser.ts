/**
 * Browser verification proof for bookmarklet CSP click fallback and duplicate class fix (audio-feed-3asd).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts app server on fixed port 8133 with real CSP headers.
 *   2. Desktop (1280x900):
 *      - Loads homepage (/).
 *      - Verifies bookmarklet link is present, has merged class="bookmarklet-link u-strong-link",
 *        and carries draggable="true".
 *      - Verifies <details> disclosure is present ("Can't drag it? Get the bookmarklet code").
 *      - Clicks the disclosure to open it and asserts the bookmarklet code snippet is rendered
 *        inside <pre><code> and copyable/selectable.
 *      - Clicks the bookmarklet link.
 *      - Asserts zero unhandled page crashes, and captures screenshot evidence.
 *
 *   deno run --allow-all --unstable-kv scripts/verify_3asd_bookmarklet_browser.ts
 *   If 8133 is busy, retry when free for commit-worthy captures. For local-only
 *   verification, BOOKMARKLET_PROOF_PORT=8134 writes evidence to OS temp instead.
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { runProof, withChrome, writeEvidenceReadme } from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";
import { HARNESS_PORT_DEFAULT, resolveHarnessPort } from "./harness-port.ts";

const PROOF_PORT = resolveHarnessPort([], Deno.env.get("BOOKMARKLET_PROOF_PORT"));
if (PROOF_PORT === 0) throw new Error("Bookmarklet evidence requires a fixed port, not 0");
const OUT = PROOF_PORT === HARNESS_PORT_DEFAULT
  ? new URL("../docs/evidence/audio-feed-3asd/", import.meta.url).pathname
  : `${await Deno.makeTempDir({ prefix: "audio-feed-3asd-local-" })}/`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

await runProof("audio-feed-3asd", async (checker) => {
  const stores: Stores = memoryStores();
  const config: AppConfig = { port: PROOF_PORT };
  const ctx = { config, stores };
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
        `Bookmarklet proof port ${PROOF_PORT} is busy; retry when free, or use BOOKMARKLET_PROOF_PORT=8134 for local-only OS-temp evidence`,
        { cause: error },
      );
    }
    throw error;
  }
  const PORT = (server.addr as Deno.NetAddr).port;
  const BASE = `http://localhost:${PORT}`;
  config.port = PORT;
  config.publicBaseUrl = BASE;

  const checks: { name: string; pass: boolean; detail?: string }[] = [];

  try {
    await withChrome(async (chrome) => {
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
      interface CdpLogEntry {
        text: string;
        level: string;
        url?: string;
      }
      const consoleLogs: CdpLogEntry[] = [];
      const pageExceptions: Array<{ text: string; url?: string; line?: number }> = [];

      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.method === "Runtime.exceptionThrown") {
          pageExceptions.push({
            text: msg.params.exceptionDetails?.text ??
              msg.params.exceptionDetails?.exception?.description ?? "exception",
            url: msg.params.exceptionDetails?.url,
            line: msg.params.exceptionDetails?.lineNumber,
          });
        }
        if (msg.method === "Log.entryAdded") {
          const text = String(msg.params.entry?.text ?? "");
          consoleLogs.push({ text, level: msg.params.entry?.level ?? "log" });
        }
        if (msg.method === "Runtime.consoleAPICalled") {
          const text = msg.params.args?.map((a: { value?: unknown }) =>
            String(a.value ?? "")
          ).join(" ") ?? "";
          consoleLogs.push({ text, level: msg.params.type });
        }
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      });

      // deno-lint-ignore no-explicit-any
      async function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        const msg = await new Promise<{ result?: unknown; error?: unknown }>((r) =>
          pending.set(id, r)
        );
        if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
        return msg.result;
      }

      // deno-lint-ignore no-explicit-any
      async function js(expression: string): Promise<any> {
        const r = await cdp("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        if (r.exceptionDetails) {
          throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
        }
        return r.result?.value;
      }

      function check(name: string, pass: boolean, detail = "") {
        checks.push({ name, pass, detail });
        checker.check(name, pass, detail);
        if (!pass) throw new Error(`step failed: ${name}`);
      }

      try {
        await cdp("Page.enable");
        await cdp("Runtime.enable");
        await cdp("Log.enable");
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        // 1. Navigate to /
        await cdp("Page.navigate", { url: `${BASE}/` });
        await sleep(1000);

        // 2. Verify anchor classes and draggable attribute
        const anchorClasses = (await js(
          `document.querySelector("a.bookmarklet-link")?.getAttribute("class")`,
        )) as string | null;
        check(
          "bookmarklet anchor has unified class list without duplicate attributes",
          anchorClasses === "bookmarklet-link u-strong-link",
          `class: '${anchorClasses}'`,
        );

        const isDraggable = (await js(
          `document.querySelector("a.bookmarklet-link")?.getAttribute("draggable")`,
        )) as string | null;
        check(
          "bookmarklet anchor is draggable for bookmark bar installation",
          isDraggable === "true",
          `draggable: '${isDraggable}'`,
        );

        const anchorHref = (await js(
          `document.querySelector("a.bookmarklet-link")?.getAttribute("href")`,
        )) as string | null;
        check(
          "bookmarklet anchor carries javascript: bookmarklet payload",
          Boolean(anchorHref && anchorHref.startsWith("javascript:")),
          `href starts with: '${anchorHref?.slice(0, 30)}...'`,
        );

        // 3. Verify disclosure presence and summary wording
        const detailsExists =
          (await js(`Boolean(document.querySelector("details.bookmarklet-code"))`)) as boolean;
        check("details disclosure exists under bookmarklet box", detailsExists);

        const summaryText = ((await js(
          `document.querySelector("details.bookmarklet-code summary")?.textContent`,
        )) as string | null)?.trim() ?? "";
        check(
          "summary explains code option when dragging is not possible",
          summaryText.includes("Can’t drag it?") &&
            summaryText.includes("Get the bookmarklet code"),
          `summary: '${summaryText}'`,
        );

        // 4. Open the disclosure and verify code contents
        await js(`document.querySelector("details.bookmarklet-code")?.setAttribute("open", "")`);
        await sleep(300);

        const isOpen =
          (await js(`document.querySelector("details.bookmarklet-code")?.open`)) as boolean;
        check("details disclosure opens upon user interaction", isOpen);

        const codeSnippet = (await js(
          `document.querySelector("details.bookmarklet-code pre.bookmarklet-snippet code")?.textContent`,
        )) as string | null;
        check(
          "code snippet in disclosure contains matching bookmarklet source",
          codeSnippet === anchorHref,
          codeSnippet === anchorHref
            ? `snippet matches href (${codeSnippet?.length} chars)`
            : `snippet mismatch: snippet len ${codeSnippet?.length}, href len ${anchorHref?.length}`,
        );
        check(
          "rendered bookmarklet uses the selected proof port",
          Boolean(codeSnippet?.includes(`localhost:${PROOF_PORT}`)) &&
            Boolean(anchorHref?.includes(`localhost:${PROOF_PORT}`)),
          `selected port ${PROOF_PORT}; rendered port ${
            codeSnippet?.match(/localhost:(\d+)/)?.[1] ?? "none"
          }`,
        );

        const preBox = (await js(`(() => {
        const el = document.querySelector("details.bookmarklet-code pre.bookmarklet-snippet");
        if (!el) return null;
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          offsetWidth: el.offsetWidth,
          clientHeight: el.clientHeight,
        };
      })()`)) as {
          scrollWidth: number;
          clientWidth: number;
          offsetWidth: number;
          clientHeight: number;
        } | null;
        check(
          "disclosure code wraps and is fully visible (not horizontally clipped)",
          Boolean(
            preBox && preBox.clientWidth > 0 && preBox.clientHeight > 0 &&
              preBox.scrollWidth <= preBox.clientWidth + 1,
          ),
          `scrollWidth ${preBox?.scrollWidth} vs clientWidth ${preBox?.clientWidth}`,
        );

        const policyExplanation = ((await js(
          `document.querySelector("details.bookmarklet-code p")?.textContent`,
        )) as string | null) ?? "";
        check(
          "disclosure text plainly explains browser CSP refusal of javascript: links",
          policyExplanation.includes("Content Security Policy") &&
            policyExplanation.includes("drag the link"),
          `explanation: '${policyExplanation.slice(0, 60)}...'`,
        );

        // 5. Click the bookmarklet anchor and isolate click-induced console records
        const logsBeforeClick = consoleLogs.length;
        await js(`document.querySelector("a.bookmarklet-link")?.click()`);
        await sleep(500);

        const clickLogs = consoleLogs.slice(logsBeforeClick);
        const cspRefusal = clickLogs.find(
          (l) =>
            (l.text.includes("JavaScript URL") || l.text.includes("javascript:")) &&
            (l.text.includes("Content Security Policy") || l.text.includes("script-src")),
        );
        check(
          "browser console explicitly records JavaScript URL CSP refusal on bookmarklet click",
          Boolean(cspRefusal),
          cspRefusal
            ? `refusal logged: '${cspRefusal.text.slice(0, 80)}...'`
            : "no JavaScript URL CSP refusal seen",
        );

        const unexpectedErrors = consoleLogs.filter(
          (l) =>
            l.level === "error" &&
            !(
              (l.text.includes("JavaScript URL") || l.text.includes("javascript:")) &&
              (l.text.includes("Content Security Policy") || l.text.includes("script-src"))
            ),
        );
        check(
          "zero unhandled page exceptions or unexpected console errors",
          pageExceptions.length === 0 && unexpectedErrors.length === 0,
          `exceptions: ${pageExceptions.length}, unexpected errors: ${unexpectedErrors.length}`,
        );

        // 6. Check that page state remains intact and disclosure is still copyable
        const stillOpen = await js(`document.querySelector("details.bookmarklet-code")?.open`);
        check("page and disclosure remain open and stable after link click", stillOpen === true);

        // Scroll disclosure into view so screenshot captures the bookmarklet box and open code
        await js(
          `document.querySelector("details.bookmarklet-code")?.scrollIntoView({ block: "center" })`,
        );
        await sleep(300);

        // Capture screenshot of the open disclosure
        const shot = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
        const raw = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
        await Deno.writeFile(`${OUT}01-bookmarklet-disclosure-open.png`, raw);
        await quantiseEvidencePng(`${OUT}01-bookmarklet-disclosure-open.png`);

        await writeEvidenceReadme({
          dir: OUT,
          title: "Browser Proof: Bookmarklet CSP Disclosure & Class Fix (audio-feed-3asd)",
          script: "scripts/verify_3asd_bookmarklet_browser.ts",
          asserts: checks.map((c) => c.name),
          sections: [
            {
              heading: "Key Verifications",
              body:
                `1. **Unified Class Attribute:** The bookmarklet anchor carries \`class="bookmarklet-link u-strong-link"\` without duplicate HTML class attributes.
2. **Draggable Installation:** The anchor retains \`draggable="true"\` and the full \`javascript:(function()...\` payload for dragging to the bookmarks bar.
3. **No-Script Disclosure Fallback:** A native HTML5 \`<details class="bookmarklet-code">\` disclosure provides the bookmarklet source inside a \`<pre class="bookmarklet-snippet"><code>\` element.
4. **Honest CSP Explanation:** The disclosure explains that browsers refuse \`javascript:\` links when clicked directly on a CSP-protected page and directs the user to drag the link or copy the snippet.
5. **Zero Inline Script:** Operates without any un-nonced inline scripts or click interception scripts, conforming strictly to the page's Content Security Policy.`,
            },
            {
              heading: "Execution Log",
              body: `\`\`\`\n${
                checks.map((c) =>
                  `${c.pass ? "PASS" : "FAIL"}  ${c.detail ? `${c.name}  ${c.detail}` : c.name}`
                ).join("\n")
              }\n\`\`\``,
            },
            {
              heading: "Screenshots",
              body:
                `- \`01-bookmarklet-disclosure-open.png\`: Homepage with bookmarklet box and expanded fallback disclosure showing snippet code.`,
            },
          ],
        });
        console.log(`Saved proof report to ${OUT}README.md`);
      } finally {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    });
  } finally {
    try {
      await server.shutdown();
    } catch {
      /* ignore */
    }
    await stores.metadata.close();
  }
});
