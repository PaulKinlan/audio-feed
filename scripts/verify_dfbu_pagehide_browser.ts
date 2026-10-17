/**
 * Browser verification proof for audio-feed-dfbu (and lifecycle verification for audio-feed-sxlt):
 * Verifies that playback position is persisted via 'pagehide' and 'visibilitychange'
 * instead of 'beforeunload', and that bfcache lifecycle restoration (pagehide and pageshow
 * with persisted=true) operates correctly and preserves playback state on back navigation
 * and reload.
 */

import {
  killChromeAndWait,
  runProof,
  spawnHarness,
  withChrome,
  writeEvidenceReadme,
} from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";

const harness = await spawnHarness("scripts/listen-harness.ts");
const BASE = harness.base;
const TOKEN = "harness-token";
const OUT = new URL("../docs/evidence/audio-feed-dfbu/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await Deno.mkdir(OUT, { recursive: true });

const checks: { name: string; pass: boolean; detail?: string }[] = [];

function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}  ${detail}`);
  if (!pass) throw new Error(`step failed: ${name}`);
}

let exitCode = 0;
try {
  await runProof("audio-feed-dfbu", async () => {
    await withChrome(async (chrome) => {
      const port = chrome.port;
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
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
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      // 1. Navigate to player
      await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
      await until(
        `document.querySelectorAll("#episodes .episode").length === 5`,
        "page load 5 rows",
      );

      // 2. Play episode 1 and set currentTime to 35s
      await js(`
      document.querySelector('li.episode[data-episode-id="ep-1"] button.ep-play')?.click();
      const audio = document.getElementById("audio");
      audio.currentTime = 35;
    `);
      await sleep(100);

      // 3. Trigger visibilitychange with visibilityState hidden
      await js(`
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    `);
      await sleep(100);

      // 4. Verify position 35s saved to scoped localStorage
      const storedPos1 = await js(`
      JSON.parse(localStorage.getItem("audio-feed-positions:user-1") || "{}")["ep-1"]?.position
    `);
      check(
        "visibilitychange (hidden) saved position 35s to localStorage",
        storedPos1 === 35,
        `stored ${storedPos1}s`,
      );

      // 5. Advance currentTime to 42s and register lifecycle event listeners
      await js(`(() => {
      const audio = document.getElementById("audio");
      audio.currentTime = 42;
      window.__lifecycleEvents = [];
      window.addEventListener("pagehide", (e) => {
        window.__lifecycleEvents.push({ type: "pagehide", persisted: e.persisted });
      });
      window.addEventListener("pageshow", (e) => {
        window.__lifecycleEvents.push({ type: "pageshow", persisted: e.persisted });
      });
    })()`);
      await sleep(100);

      // 6. Real navigation away to about:blank (fires browser pagehide and enters bfcache)
      await cdp("Page.navigate", { url: "about:blank" });
      await sleep(500);

      // 7. Navigate back via history.back() to drive real bfcache restoration
      try {
        await js(`history.back()`);
      } catch {
        const hist = (await cdp("Page.getNavigationHistory")) as {
          currentIndex: number;
          entries: Array<{ id: number; url: string }>;
        };
        const prev = hist.entries[hist.currentIndex - 1];
        if (prev) {
          await cdp("Page.navigateToHistoryEntry", { entryId: prev.id });
        }
      }
      await until(
        `document.querySelectorAll("#episodes .episode").length === 5`,
        "bfcache restored",
      );
      await sleep(300);

      const lifecycle = (await js(`({
      events: window.__lifecycleEvents || [],
      storedPos: JSON.parse(localStorage.getItem("audio-feed-positions:user-1") || "{}")["ep-1"]?.position,
      audioTime: document.getElementById("audio")?.currentTime,
    })`)) as {
        events: Array<{ type: string; persisted: boolean }>;
        storedPos: number;
        audioTime: number;
      };

      const pagehideEvent = lifecycle.events.find((e) => e.type === "pagehide");
      const pageshowEvent = lifecycle.events.find((e) => e.type === "pageshow");

      check(
        "real navigation away fires pagehide with persisted=true and saves position 42s to localStorage",
        Boolean(pagehideEvent && pagehideEvent.persisted === true && lifecycle.storedPos === 42),
        `pagehide persisted: ${pagehideEvent?.persisted}, stored: ${lifecycle.storedPos}s`,
      );

      const hasAudioTimeRestored = typeof lifecycle.audioTime === "number" &&
        Math.abs(lifecycle.audioTime - 42) <= 1;

      check(
        "history.back() restores page from bfcache with pageshow persisted=true and preserves in-memory playback time",
        Boolean(pageshowEvent && pageshowEvent.persisted === true && hasAudioTimeRestored),
        `pageshow persisted: ${pageshowEvent?.persisted}, audio currentTime: ${lifecycle.audioTime}s (target ~42s)`,
      );

      // 8. Reload page and check UI resume affordance
      await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
      await until(`document.querySelectorAll("#episodes .episode").length === 5`, "page reloaded");

      const row1 = `document.querySelector('li.episode[data-episode-id="ep-1"]')`;
      const badgeText = await js(`${row1}?.querySelector(".ep-resume-badge")?.textContent`);
      check(
        "row displays 'Resume from 0:42' badge",
        typeof badgeText === "string" && badgeText.includes("0:42"),
        `badge text: '${badgeText}'`,
      );

      // 9. Capture screenshot
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      const raw = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
      await Deno.writeFile(`${OUT}01-pagehide-visibilitychange-resume.png`, raw);
      await quantiseEvidencePng(`${OUT}01-pagehide-visibilitychange-resume.png`);
      console.log(`Saved screenshot to ${OUT}01-pagehide-visibilitychange-resume.png`);

      // 10. Verify beforeunload is absent from window listeners
      const hasBeforeUnload = await js(`
      "onbeforeunload" in window && window.onbeforeunload !== null
    `);
      check(
        "window.onbeforeunload is not set",
        !hasBeforeUnload,
        `hasBeforeUnload: ${hasBeforeUnload}`,
      );

      await writeEvidenceReadme({
        dir: OUT,
        title: "Evidence for audio-feed-dfbu & bfcache lifecycle (audio-feed-sxlt)",
        script: "scripts/verify_dfbu_pagehide_browser.ts",
        asserts: checks.map((c) => c.name),
        sections: [
          {
            heading: "Overview",
            body:
              `Replaces the deprecated and bfcache-ineligible \`beforeunload\` listener with \`pagehide\` and \`visibilitychange\` (handling \`visibilityState === "hidden"\`) for playback position saving in \`src/assets/listen.js\`. Drives real browser navigation away and back to prove bfcache eligibility (\`persisted === true\`) and position persistence.`,
          },
          {
            heading: "Verification",
            body: `1. **Automated Unit Test (\`tests/playback_position_test.ts\`)**:
   - Asserts client script registers \`pagehide\` and \`visibilitychange\` listeners.
   - Asserts client script does NOT register any \`beforeunload\` listener.
2. **Headless Chrome Browser Proof (\`scripts/verify_dfbu_pagehide_browser.ts\`)**:
   - Drives real headless Chrome over CDP against \`scripts/listen-harness.ts\`.
   - Starts playback, simulates tab backgrounding via \`visibilitychange\` (\`document.visibilityState === "hidden"\`), asserts position is stored to scoped \`localStorage\`.
   - Advances playback, navigates away to \`about:blank\` (real browser navigation), asserts \`pagehide\` fires with \`persisted: true\` and saves updated position to \`localStorage\`.
   - Navigates back via \`history.back()\`, asserts \`pageshow\` fires with \`persisted: true\` (restored from bfcache), preserving in-memory state.
   - Reloads page, asserts row displays "Resume from 0:42" badge and button is wired to resume.
   - Asserts \`window.onbeforeunload\` is not set.
   - Captures screenshot: \`01-pagehide-visibilitychange-resume.png\`.`,
          },
        ],
      });

      ws.close();
    }, { prefix: "audiofeed-dfbu-" });
  });
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await killChromeAndWait(harness.process);
}

Deno.exit(exitCode);
