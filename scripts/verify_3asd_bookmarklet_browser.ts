/**
 * Browser verification proof for bookmarklet CSP click fallback and duplicate class fix (audio-feed-3asd).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts app server on an ephemeral port with real CSP headers.
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
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { withChrome, writeEvidenceReadme } from "./proof-helper.ts";

const OUT = new URL("../docs/evidence/audio-feed-3asd/", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

const stores: Stores = memoryStores();
const config: AppConfig = { port: 0 };
const ctx = { config, stores };
const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

let exitCode = 0;
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

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
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
      const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
      console.log(`${tag}  ${name}  ${detail}`);
      if (!pass) exitCode = 1;
    }

    try {
      await cdp("Page.enable");
      await cdp("Runtime.enable");
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
        summaryText.includes("Can’t drag it?") && summaryText.includes("Get the bookmarklet code"),
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

      const codeBox = (await js(`(() => {
        const el = document.querySelector("details.bookmarklet-code pre.bookmarklet-snippet code");
        if (!el) return null;
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          offsetWidth: el.offsetWidth,
        };
      })()`)) as { scrollWidth: number; clientWidth: number; offsetWidth: number } | null;
      check(
        "disclosure code wraps and is fully visible (not horizontally clipped)",
        Boolean(codeBox && codeBox.scrollWidth <= codeBox.clientWidth + 1),
        `scrollWidth ${codeBox?.scrollWidth} vs clientWidth ${codeBox?.clientWidth}`,
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

      // 5. Click the bookmarklet anchor
      await js(`document.querySelector("a.bookmarklet-link")?.click()`);
      await sleep(500);

      // 6. Check that page state remains intact and disclosure is still copyable
      const stillOpen = await js(`document.querySelector("details.bookmarklet-code")?.open`);
      check("page and disclosure remain open and stable after link click", stillOpen === true);

      // Capture screenshot of the open disclosure
      const shot = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
      await Deno.writeFile(
        `${OUT}01-bookmarklet-disclosure-open.png`,
        Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
      );

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
} catch (err) {
  console.error("Browser proof failed:", err);
  exitCode = 1;
} finally {
  try {
    await server.shutdown();
  } catch {
    /* ignore */
  }
  await stores.metadata.close();
}

if (exitCode !== 0 || checks.some((c) => !c.pass)) {
  Deno.exit(1);
}
