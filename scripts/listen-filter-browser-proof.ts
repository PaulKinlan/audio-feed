/**
 * Browser proof for player source and text filtering (audio-feed-3h1).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts scripts/listen-harness.ts on port 8138.
 *   2. Desktop (1280x900):
 *      - Verifies initial 5 episodes and "5 episodes" count.
 *      - Filters by source ("The Verge") -> asserts 2 rows and "2 of 5 episodes".
 *      - Filters by text ("Marco") -> asserts 1 row and "1 of 5 episodes".
 *      - Filters by non-matching query -> asserts honest #filterEmpty ("No episodes match..."), #empty hidden.
 *      - Clicks #clearFilterBtn -> asserts 5 rows and "5 episodes" restored.
 *      - Persists filter across reload -> asserts filter restored on reload.
 *      - Asserts per-user filter storage (another user ID has no saved filter).
 *      - Extracts a11y tree for filter controls.
 *   3. Mobile (390x844):
 *      - Verifies zero horizontal overflow (scrollWidth <= clientWidth).
 *      - Asserts the iOS focus floor (audio-feed-nmw3) on the rendered page: every control a reader
 *        can put text into computes >= 16px; the floor outweighs a page-level 0.9rem size; and with
 *        the floor's declarations removed that same rule puts the search box below 16px, so the
 *        assertion is falsifiable and the floor is what holds the value.
 *   4. Screenshots saved to docs/evidence/audio-feed-3h1/.
 *
 *   deno run --allow-all --unstable-kv scripts/listen-filter-browser-proof.ts
 */

import {
  killChromeAndWait,
  runProof,
  spawnHarness,
  withChrome,
  writeEvidenceReadme,
} from "./proof-helper.ts";

const ASSERTS = [
  "initial load shows 5 rows and '5 episodes'",
  "source filter updates count to '2 of 5 episodes'",
  "visible rows belong exclusively to 'The Verge'",
  "text filter updates count to '1 of 5 episodes'",
  "empty state names the active filters honestly",
  "generic 'No episodes yet' empty state is hidden while filter is active",
  "clearing filters restores '5 episodes'",
  "filters survive reload for the same user",
  "filter state is scoped per-user",
  "a11y tree includes search role landmark",
  "mobile layout has zero horizontal overflow at 390px",
  "at 390x844 every text control computes at least 16px, so focusing one cannot make iOS zoom the standalone PWA",
  "the floor outweighs a page-level control size: with a 0.9rem page rule on the search box inserted into the page's own stylesheet, it still computes 16px",
  "the floor is what holds it: with the floor's declarations removed and that page rule left in place, the search box computes below 16px, so the check above is falsifiable",
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
    try {
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
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        });

        await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
        await until(
          `document.querySelectorAll("#episodes .episode").length === 5`,
          "page load 5 rows",
        );

        checker.check(
          "initial load shows 5 rows and '5 episodes'",
          (await js(`document.getElementById("episodeCount")?.textContent`)) === "5 episodes",
          "5 episodes uninhibited",
        );

        // 2. Filter by source: The Verge
        await js(`(() => {
    const sel = document.getElementById("filterSource");
    sel.value = "The Verge";
    sel.dispatchEvent(new Event("change"));
  })()`);
        await until(
          `document.querySelectorAll("#episodes .episode").length === 2`,
          "filtered to 2 Verge rows",
        );

        const vergeCount = await js(`document.getElementById("episodeCount")?.textContent`);
        checker.check(
          "source filter updates count to '2 of 5 episodes'",
          vergeCount === "2 of 5 episodes",
          `count text: '${vergeCount}'`,
        );

        const sources = await js(`
    [...document.querySelectorAll("#episodes .episode .ep-source")].map(el => el.textContent)
  `);
        checker.check(
          "visible rows belong exclusively to 'The Verge'",
          sources.every((s: string) => s === "The Verge") && sources.length === 2,
          JSON.stringify(sources),
        );

        // 3. Text filter: "Marco"
        await js(`(() => {
    const inp = document.getElementById("filterText");
    inp.value = "Marco";
    inp.dispatchEvent(new Event("input"));
  })()`);
        await until(
          `document.querySelectorAll("#episodes .episode").length === 1`,
          "filtered to 1 Marco row",
        );

        const marcoCount = await js(`document.getElementById("episodeCount")?.textContent`);
        checker.check(
          "text filter updates count to '1 of 5 episodes'",
          marcoCount === "1 of 5 episodes",
          `count text: '${marcoCount}'`,
        );

        // 4. Non-matching query: honest empty state
        await js(`(() => {
    const inp = document.getElementById("filterText");
    inp.value = "NonExistentTerm";
    inp.dispatchEvent(new Event("input"));
  })()`);
        await until(
          `!document.getElementById("filterEmpty")?.classList.contains("hidden")`,
          "filterEmpty shown",
        );

        const filterEmptyMsg = await js(
          `document.getElementById("filterEmptyMessage")?.textContent`,
        );
        checker.check(
          "empty state names the active filters honestly",
          typeof filterEmptyMsg === "string" && filterEmptyMsg.includes("NonExistentTerm") &&
            filterEmptyMsg.includes("The Verge"),
          `message: '${filterEmptyMsg}'`,
        );

        const genericEmptyHidden = await js(
          `document.getElementById("empty")?.classList.contains("hidden")`,
        );
        checker.check(
          "generic 'No episodes yet' empty state is hidden while filter is active",
          genericEmptyHidden === true,
          "generic empty remains hidden",
        );

        // 5. Clear filter button resets view
        await js(`document.getElementById("clearFilterBtn")?.click()`);
        await until(
          `document.querySelectorAll("#episodes .episode").length === 5`,
          "reset to 5 rows",
        );

        const resetCount = await js(`document.getElementById("episodeCount")?.textContent`);
        checker.check(
          "clearing filters restores '5 episodes'",
          resetCount === "5 episodes",
          `count text: '${resetCount}'`,
        );

        // 6. Persistence across reload
        await js(`(() => {
    const sel = document.getElementById("filterSource");
    sel.value = "Stratechery";
    sel.dispatchEvent(new Event("change"));
  })()`);
        await until(
          `document.querySelectorAll("#episodes .episode").length === 3`,
          "filtered to 3 Stratechery rows",
        );

        // Reload page
        await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
        await until(
          `document.querySelectorAll("#episodes .episode").length === 3`,
          "reload restores 3 rows",
        );

        const reloadedSource = await js(`document.getElementById("filterSource")?.value`);
        const reloadedCount = await js(`document.getElementById("episodeCount")?.textContent`);
        checker.check(
          "filters survive reload for the same user",
          reloadedSource === "Stratechery" && reloadedCount === "3 of 5 episodes",
          `source: '${reloadedSource}', count: '${reloadedCount}'`,
        );

        // 7. Per-user filter storage isolation
        const savedFilter = await js(`localStorage.getItem("audio-feed-filter:user-1")`);
        const otherTokenFilter = await js(`localStorage.getItem("audio-feed-filter:other-user")`);
        checker.check(
          "filter state is scoped per-user",
          savedFilter !== null && otherTokenFilter === null,
          `saved: ${savedFilter}, other: ${otherTokenFilter}`,
        );

        // 8. Capture desktop screenshot & dump a11y tree
        const shotDesktop = await cdp("Page.captureScreenshot", { format: "png" });
        await Deno.writeFile(
          `${OUT}01-listen-filter-desktop.png`,
          Uint8Array.from(atob(shotDesktop.data), (c) => c.charCodeAt(0)),
        );
        console.log(`Saved screenshot to ${OUT}01-listen-filter-desktop.png`);

        const axNodes = await cdp("Accessibility.getFullAXTree");
        const searchSection = axNodes.nodes?.find((n: { role?: { value: string } }) =>
          n.role?.value === "search"
        );
        checker.check(
          "a11y tree includes search role landmark",
          Boolean(searchSection),
          `found search landmark in AX tree: id=${searchSection?.nodeId}`,
        );

        // 9. Mobile test (390x844)
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true,
        });

        await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
        await until(`document.querySelectorAll("#episodes .episode").length === 3`, "mobile load");

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

        // ------------------------------------------------- 10. THE iOS FOCUS FLOOR (audio-feed-nmw3)
        //
        // WHY IT IS HERE AND NOT IN A SCRIPT OF ITS OWN. The floor `font-size: max(1rem, 1em)` exists
        // in three places (listen.css's `body input/select/textarea`, shell.ts's `.shell` kit rule and
        // home.css's url/password rule) and, before this, NOTHING asserted it: no proof script and no
        // verify_* script touched font size. A proof nobody runs would be that same defect over again,
        // so the assertion goes inside the mobile pass this proof already runs - 390x844, on the page
        // installed as a standalone PWA (no browser chrome, so no pinch to escape an iOS focus zoom),
        // whose own comment records the history (a search box at 0.9rem, a speed control at 0.8rem, a
        // share field at 0.85rem) and whose selector `.filter-field input[type="search"]` the floor
        // was raised to outweigh.
        //
        // IT READS THE RENDERED VALUE. Grepping the stylesheets for `max(1rem, 1em)` would stay green
        // if the rule were never applied to the element or were outweighed by a page rule, so what is
        // read here is `getComputedStyle(...).fontSize` on the served page, for every control a reader
        // can put text into - the platform's type list, not the floor's selector, so the check does
        // not go blind exactly when the declaration does.
        //
        // AND IT IS A CHECK THAT CAN BE SEEN TO FAIL (docs/evidence/README.md, "Honesty"): on this
        // page, one mutation later - the floor's declarations deleted and the pre-audio-feed-rxa2
        // 0.9rem page rule put back - the same measurement must read BELOW 16px, and it is asserted
        // to. Served 16px against mutant 14.4px is the difference between asserting the outcome and
        // asserting the source text.
        const TEXT_CONTROLS =
          'input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"], [type="button"], [type="submit"], [type="reset"], [type="image"], [type="hidden"]), select, textarea';
        const FLOOR_PX = 16;

        /** Every control a reader can put text into, with the font-size the browser actually used. */
        async function controlFontSizes() {
          return (await js(
            `[...document.querySelectorAll(${JSON.stringify(TEXT_CONTROLS)})].map((el) => ({` +
              ` control: "#" + (el.id || el.tagName.toLowerCase()),` +
              ` fontSizePx: Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 }))`,
          )) as Array<{ control: string; fontSizePx: number }>;
        }
        const fontSizeReport = (rows: Array<{ control: string; fontSizePx: number }>) =>
          rows.map((r) => `${r.control} ${r.fontSizePx}px`).join(", ");

        /**
         * Deletes every rule whose font-size declaration IS the floor, and counts what it removed.
         *
         * The declaration is tested before descending: in a browser with CSS nesting, `rule.cssRules`
         * is an EMPTY (but truthy) list on a plain style rule, so testing it first makes every rule
         * look like a grouping rule and removes nothing - which the caller asserts against, because a
         * mutation that did not happen would otherwise leave this check reading green for nothing.
         */
        const DELETE_FLOOR_RULES = `(() => {
          let removed = 0;
          const walk = (rules) => {
            for (let i = rules.length - 1; i >= 0; i--) {
              const rule = rules[i];
              const declared = rule.style ? String(rule.style.getPropertyValue("font-size")) : "";
              if (/max\\(\\s*1rem/i.test(declared)) {
                const owner = rule.parentRule || rule.parentStyleSheet;
                if (owner) { owner.deleteRule(i); removed++; }
                continue;
              }
              if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
            }
          };
          for (const sheet of document.styleSheets) {
            try { walk(sheet.cssRules); } catch { /* a cross-origin sheet cannot be read */ }
          }
          return removed;
        })()`;

        // The filter controls are revealed by the page's own script, but a control has no rendered
        // box while it is display:none, and this check is about a value a reader actually gets.
        await js(`document.getElementById("filterSection").classList.remove("hidden")`);
        const servedFontSizes = await controlFontSizes();
        checker.check(
          "at 390x844 every text control computes at least 16px, so focusing one cannot make iOS zoom the standalone PWA",
          servedFontSizes.length >= 3 && servedFontSizes.every((r) => r.fontSizePx >= FLOOR_PX),
          fontSizeReport(servedFontSizes),
        );

        // The page rule the floor was built to outweigh: a page-level control size below 1rem, the
        // shape listen.css shipped before audio-feed-rxa2, which the floor's two :not() groups
        // outweigh on specificity. It goes into the SAME sheet as the floor, through the CSSOM, for
        // two reasons: an appended <style> is blocked by this page's nonce-only `style-src` (measured
        // - the rule silently did not apply and the check below passed for nothing), and being after
        // `.filter-field input[type="search"] { font: inherit }` in the cascade is what makes it the
        // winner once the floor is gone.
        const pageLevelRule = await js(`(() => {
          const RULE = '.filter-field input[type="search"] { font-size: 0.9rem; }';
          for (const sheet of document.styleSheets) {
            let rules = null;
            try { rules = sheet.cssRules; } catch { continue; }
            const hasFloor = [...rules].some((rule) =>
              rule.style && /max\\(\\s*1rem/i.test(String(rule.style.getPropertyValue("font-size")))
            );
            if (!hasFloor) continue;
            sheet.insertRule(RULE, rules.length);
            return RULE;
          }
          return "";
        })()`) as string;
        const floorPresent = await controlFontSizes();
        checker.check(
          "the floor outweighs a page-level control size: with a 0.9rem page rule on the search box inserted into the page's own stylesheet, it still computes 16px",
          // Read with the counterexample below, which is what proves this rule has any effect at all.
          pageLevelRule !== "" && floorPresent.every((r) => r.fontSizePx >= FLOOR_PX),
          pageLevelRule === ""
            ? "the page-level rule could not be inserted into any same-origin sheet"
            : `${pageLevelRule} | ${fontSizeReport(floorPresent)}`,
        );

        // THE COUNTEREXAMPLE, measured with the same instrument that just passed: the floor's
        // declarations gone is what "an override or a removed declaration" looks like in the served
        // document, and on that document the check above must be red. `removed` is asserted because a
        // renamed or restructured rule would otherwise turn this into a no-op that still reads green.
        const removedWithPageRule = await js(DELETE_FLOOR_RULES) as number;
        const mutantFontSizes = await controlFontSizes();

        // What the floor is actually holding on today's page, measured rather than assumed: reload to
        // drop the page rule, delete the floor alone, read the same controls again.
        await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
        await until(
          `document.querySelectorAll("#episodes .episode").length === 3`,
          "mobile reload for the floor-only measure",
        );
        await js(`document.getElementById("filterSection").classList.remove("hidden")`);
        const removedAlone = await js(DELETE_FLOOR_RULES) as number;
        const floorOnlySizes = await controlFontSizes();
        checker.check(
          "the floor is what holds it: with the floor's declarations removed and that page rule left in place, the search box computes below 16px, so the check above is falsifiable",
          removedWithPageRule >= 1 && removedAlone >= 1 &&
            mutantFontSizes.some((r) => r.fontSizePx < FLOOR_PX),
          `floor + page rule: ${
            fontSizeReport(floorPresent)
          } | floor removed (${removedWithPageRule} rule(s)) + page rule: ` +
            `${fontSizeReport(mutantFontSizes)} | floor removed alone (${removedAlone} rule(s)): ${
              fontSizeReport(floorOnlySizes)
            }`,
        );

        // Leave the document as the page served it, so anything appended here later cannot inherit a
        // mutation this check made.
        await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
        await until(
          `document.querySelectorAll("#episodes .episode").length === 3`,
          "mobile reload after the floor measurements",
        );
      }, { prefix: "audiofeed-listen-filter-" });
    } finally {
      await writeEvidenceReadme({
        dir: OUT,
        title: "Player source and text filtering",
        script: "scripts/listen-filter-browser-proof.ts",
        asserts: ASSERTS,
        checker,
      });
    }
  });
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await killChromeAndWait(harness.process);
}

Deno.exit(exitCode);
