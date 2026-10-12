/**
 * Browser proof for player source and text filtering (audio-feed-3h1).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts scripts/listen-harness.ts.
 *   2. Desktop (1280x900):
 *      - Verifies initial 5 episodes and "5 episodes" count.
 *      - Filters by source ("The Verge") -> asserts 2 rows and "2 of 5 episodes".
 *      - Filters by text ("Marco") -> asserts 1 row and "1 of 5 episodes".
 *      - Filters by non-matching query -> asserts honest #filterEmpty ("No episodes match..."), #empty hidden.
 *      - Clicks #clearFilterBtn -> asserts 5 rows and "5 episodes" restored.
 *      - Persists filter across reload -> asserts filter restored on reload.
 *      - Asserts per-user isolation (different user has no saved filter).
 *      - Extracts a11y tree for filter controls.
 *   3. Mobile (390x844):
 *      - Verifies zero horizontal overflow (scrollWidth <= clientWidth).
 *   4. Screenshots saved to docs/evidence/audio-feed-3h1/.
 *
 *   deno run --allow-all --unstable-kv scripts/listen-filter-browser-proof.ts
 */

import { runProof, spawnHarness, withChrome, writeEvidenceReadme } from "./proof-helper.ts";

const ASSERTS = [
  "initial 5 episodes present",
  "initial count is '5 episodes'",
  "filter by source shows 2 episodes",
  "filter by text shows 1 episode",
  "text filter is case-insensitive",
  "non-matching query shows empty state honestly",
  "empty state UI elements behave exclusively",
  "clear button resets filter and row count",
  "filter state is persisted across reload",
  "filter state is scoped per-user",
  "a11y tree exposes filter controls correctly",
  "mobile layout has zero horizontal overflow at 390px",
];

const harness = await spawnHarness("scripts/listen-harness.ts");
const BASE = harness.base;
const TOKEN = "harness-token";
const OUT = new URL("../docs/evidence/audio-feed-3h1/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await Deno.mkdir(OUT, { recursive: true });

let exitCode = 0;
try {
  await runProof("listen-filter-browser-proof", async (checker) => {
    await withChrome(async (chrome) => {
      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();

      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
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

      async function until(expr: string, desc: string, timeoutMs = 8000) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          if (await js(expr)) return;
          await sleep(50);
        }
        throw new Error(`timed out waiting for: ${desc}`);
      }

      await cdp("Page.enable");
      await cdp("Runtime.enable");
      await cdp("Accessibility.enable");

      // 1. Desktop test
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const sessionSecret = harness.getLogs().stdout.match(/sessionSecret=([^ \n]+)/)?.[1] || "";
      await cdp("Network.setCookie", {
        url: BASE,
        name: "__Host-af_session",
        value: sessionSecret,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });

      await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
      await until(`document.readyState === "complete"`, "homepage loaded");
      await until(
        `document.querySelectorAll('#episodes .episode').length === 5`,
        "initial 5 episodes load",
      );

      checker.check(
        "initial 5 episodes present",
        (await js(`document.querySelectorAll('#episodes .episode').length`)) === 5,
        "5 rows in DOM",
      );

      checker.check(
        "initial count is '5 episodes'",
        (await js(`document.getElementById("episodeCount")?.textContent`)) === "5 episodes",
        await js(`document.getElementById("episodeCount")?.textContent`),
      );

      // 2. Filter by source ("The Verge") -> 2 episodes
      await js(`
        document.getElementById("sourceFilter").value = "theverge";
        document.getElementById("sourceFilter").dispatchEvent(new Event("change"));
      `);
      await until(
        `document.querySelectorAll('#episodes .episode:not([hidden])').length === 2`,
        "filter source",
      );

      checker.check(
        "filter by source shows 2 episodes",
        (await js(`document.querySelectorAll('#episodes .episode:not([hidden])').length`)) === 2 &&
          (await js(`document.getElementById("episodeCount")?.textContent`)) === "2 of 5 episodes",
        await js(`document.getElementById("episodeCount")?.textContent`),
      );

      // 3. Filter by text ("Marco") -> 1 episode
      await js(`
        document.getElementById("sourceFilter").value = "all";
        document.getElementById("sourceFilter").dispatchEvent(new Event("change"));
        document.getElementById("textFilter").value = "Marco";
        document.getElementById("textFilter").dispatchEvent(new Event("input"));
      `);
      await until(
        `document.querySelectorAll('#episodes .episode:not([hidden])').length === 1`,
        "filter text Marco",
      );

      checker.check(
        "filter by text shows 1 episode",
        (await js(`document.querySelectorAll('#episodes .episode:not([hidden])').length`)) === 1 &&
          (await js(`document.getElementById("episodeCount")?.textContent`)) === "1 of 5 episodes",
        await js(`document.getElementById("episodeCount")?.textContent`),
      );

      // 4. Case-insensitivity ("mArCo")
      await js(`
        document.getElementById("textFilter").value = "mArCo";
        document.getElementById("textFilter").dispatchEvent(new Event("input"));
      `);
      await until(
        `document.querySelectorAll('#episodes .episode:not([hidden])').length === 1`,
        "filter text mArCo",
      );
      checker.check("text filter is case-insensitive", true, "1 row remains");

      // 5. Non-matching ("Zzzzzz") -> 0 episodes, shows empty state
      await js(`
        document.getElementById("textFilter").value = "Zzzzzz";
        document.getElementById("textFilter").dispatchEvent(new Event("input"));
      `);
      await until(
        `document.querySelectorAll('#episodes .episode:not([hidden])').length === 0`,
        "filter non-matching",
      );
      await until(`!document.getElementById("filterEmpty")?.hidden`, "filterEmpty visible");

      checker.check(
        "non-matching query shows empty state honestly",
        (await js(`document.getElementById("episodeCount")?.textContent`)) === "0 of 5 episodes" &&
          (await js(`document.getElementById("filterEmpty")?.textContent`))?.includes(
            "No episodes match",
          ),
        await js(`document.getElementById("filterEmpty")?.textContent`),
      );
      checker.check(
        "empty state UI elements behave exclusively",
        await js(`!!document.getElementById("empty")?.hidden`),
        "real empty state (#empty) is hidden",
      );

      // 6. Clear filter
      await js(`document.getElementById("clearFilterBtn").click()`);
      await until(
        `document.querySelectorAll('#episodes .episode:not([hidden])').length === 5`,
        "clear filter",
      );
      checker.check(
        "clear button resets filter and row count",
        (await js(`document.getElementById("textFilter").value`)) === "" &&
          (await js(`document.getElementById("sourceFilter").value`)) === "all" &&
          (await js(`document.getElementById("episodeCount")?.textContent`)) === "5 episodes",
        await js(`document.getElementById("episodeCount")?.textContent`),
      );

      // Persist across reload
      await js(`
        document.getElementById("sourceFilter").value = "theverge";
        document.getElementById("sourceFilter").dispatchEvent(new Event("change"));
        document.getElementById("textFilter").value = "Marco";
        document.getElementById("textFilter").dispatchEvent(new Event("input"));
      `);
      await until(
        `document.querySelectorAll('#episodes .episode:not([hidden])').length === 1`,
        "prepare persist",
      );

      const shotDesktop = await cdp("Page.captureScreenshot", { format: "png" });
      await Deno.writeFile(
        `${OUT}01-listen-filter-desktop.png`,
        Uint8Array.from(atob(shotDesktop.data), (c) => c.charCodeAt(0)),
      );
      console.log(`Saved screenshot to ${OUT}01-listen-filter-desktop.png`);

      await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
      await until(`document.querySelectorAll('#episodes .episode').length === 5`, "reload persist");

      const reloadedSource = await js(`document.getElementById("sourceFilter").value`);
      const reloadedCount = await js(
        `document.querySelectorAll('#episodes .episode:not([hidden])').length`,
      );
      checker.check(
        "filter state is persisted across reload",
        reloadedSource === "theverge" && reloadedCount === 1,
        `source: '${reloadedSource}', count: '${reloadedCount}'`,
      );

      // 7. Per-user isolation
      // Note: Drift fix against audio-feed-b6nr. We must use "user-1" instead of the token for the key scope.
      const savedFilter = await js(`localStorage.getItem("audio-feed-filter:user-1")`);
      const otherTokenFilter = await js(`localStorage.getItem("audio-feed-filter:other-user")`);
      checker.check(
        "filter state is scoped per-user",
        savedFilter !== null && otherTokenFilter === null,
        `saved: ${savedFilter}, other: ${otherTokenFilter}`,
      );

      // 8. Extract a11y tree for filter controls
      const a11yTree = await cdp("Accessibility.getFullAXTree");
      const findNode = (name: string, role?: string) =>
        // deno-lint-ignore no-explicit-any
        a11yTree.nodes.find((n: any) =>
          n.name?.value === name && (!role || n.role?.value === role)
        );

      const sourceFilterNode = findNode("Filter by source", "combobox");
      const textFilterNode = findNode("Filter episodes by title or author", "searchbox");
      const clearBtnNode = findNode("Clear filter", "button");

      checker.check(
        "a11y tree exposes filter controls correctly",
        !!sourceFilterNode && !!textFilterNode && !!clearBtnNode,
        `source: ${!!sourceFilterNode}, text: ${!!textFilterNode}, clear: ${!!clearBtnNode}`,
      );

      // 9. Mobile test (390x844)
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      });

      await until(`document.readyState === "complete"`, "mobile layout");
      const overflow = await js(
        `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
      );
      checker.check(
        "mobile layout has zero horizontal overflow at 390px",
        overflow === false,
        "no horizontal scroll",
      );

      const shotMobile = await cdp("Page.captureScreenshot", { format: "png" });
      await Deno.writeFile(
        `${OUT}02-listen-filter-mobile-390.png`,
        Uint8Array.from(atob(shotMobile.data), (c) => c.charCodeAt(0)),
      );
      console.log(`Saved screenshot to ${OUT}02-listen-filter-mobile-390.png`);

      ws.close();
    }, { prefix: "audiofeed-listen-filter-" });
  });
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  harness.kill();

  await writeEvidenceReadme({
    dir: OUT,
    title: "Player source and text filtering",
    script: "scripts/listen-filter-browser-proof.ts",
    asserts: ASSERTS,
  });
}

Deno.exit(exitCode);
