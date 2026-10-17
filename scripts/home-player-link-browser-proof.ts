/**
 * Browser proof for the front door player links (audio-feed-ytg).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts scripts/account-harness.ts on port 8141.
 *   2. Desktop (1280x900):
 *      - Verifies header nav links to /listen.
 *      - Verifies lede and subscribing section link to /listen.
 *      - Verifies /listen landing page renders without a stored token.
 *      - Verifies returning subscriber banner appears on / when token is stored.
 *      - Verifies /listen auto-redirects to /listen/:token when token is stored.
 *      - Verifies sending an article on / displays "Open in Web Player →" linking to /listen/:token.
 *      - Takes desktop screenshot.
 *   3. Mobile (390x844):
 *      - Verifies responsive layout and zero horizontal overflow.
 *      - Takes mobile screenshot.
 *
 *   deno run --allow-all --unstable-kv scripts/home-player-link-browser-proof.ts
 */

import {
  killChromeAndWait,
  runProof,
  spawnHarness,
  withChrome,
  writeEvidenceReadme,
} from "./proof-helper.ts";

const ASSERTS = [
  "header navigation links to /listen",
  "hero lede links to /listen",
  "/listen landing page explains how to listen",
  "returning subscriber banner is visible on /",
  "feed token field remains empty (privacy invariant)",
  "/listen with stored token restores directly to /listen/:token",
  "submission success state offers 'Open in Web Player →'",
  "mobile layout has zero horizontal overflow at 390px",
];

const harness = await spawnHarness("scripts/account-harness.ts");
const BASE = harness.base;
const OUT = new URL("../docs/evidence/audio-feed-ytg/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await Deno.mkdir(OUT, { recursive: true });

let exitCode = 0;
try {
  await runProof("home-player-link-browser-proof", async (checker) => {
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

        // 1. Desktop test
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        await cdp("Page.navigate", { url: `${BASE}/` });
        await until(`document.readyState === "complete"`, "homepage loaded");

        const headerNavLink = await js(`!!document.querySelector('.site-nav a[href="/listen"]')`);
        checker.check(
          "header navigation links to /listen",
          headerNavLink === true,
          "Web Player nav link present",
        );

        const ledeLink = await js(`!!document.querySelector('.lede a[href="/listen"]')`);
        checker.check(
          "hero lede links to /listen",
          ledeLink === true,
          "Web Player link in lede present",
        );

        await js(`document.querySelector('.site-nav a[href="/listen"]').click()`);
        await until(`location.pathname === "/listen"`, "navigate to /listen");

        const landingHeader = await js(`document.querySelector("h1")?.textContent`);
        checker.check(
          "/listen landing page explains how to listen",
          landingHeader === "Listen to your feed",
          `heading: '${landingHeader}'`,
        );

        // Obtain a real test session using WebAuthn via the account harness (audio-feed-zmxo)
        await cdp("WebAuthn.enable");
        await cdp("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        });

        const users = await (await fetch(`${BASE}/api/admin/users`, {
          headers: { "x-admin-token": "harness-admin" },
        })).json();
        const user = users.users.find((u: { email: string }) => u.email === "paul@example.com");
        const setupRes = await fetch(`${BASE}/api/admin/users/${user.id}/setup-link`, {
          method: "POST",
          headers: { "x-admin-token": "harness-admin" },
        });
        const setupUrl = (await setupRes.json()).url;

        await cdp("Page.navigate", { url: setupUrl });
        await until(`!document.getElementById("createPasskey")?.disabled`, "setup options");
        await js(`document.getElementById("createPasskey").click()`);
        await until(`location.pathname === "/account"`, "account after register");

        // Visit homepage again as authenticated user
        await cdp("Page.navigate", { url: `${BASE}/` });
        await until(
          `!document.getElementById("returningSubscriber")?.hidden`,
          "returning subscriber banner",
        );

        const returningVisible = await js(
          `!document.getElementById("returningSubscriber")?.hidden`,
        );
        checker.check(
          "returning subscriber banner is visible on /",
          returningVisible === true,
          "banner shown",
        );

        const autoFilledToken = await js(`document.getElementById("token")?.value`);
        checker.check(
          "feed token field remains empty (privacy invariant)",
          autoFilledToken === "",
          `token: '${autoFilledToken}'`,
        );

        // Visiting /listen with an active session restores directly to /listen/:token
        await cdp("Page.navigate", { url: `${BASE}/listen` });
        await until(
          `location.pathname.startsWith("/listen/")`,
          "restored to /listen/:token",
        );

        const redirectedPath = await js(`location.pathname`);
        checker.check(
          "/listen with stored token restores directly to /listen/:token",
          redirectedPath.startsWith("/listen/") && redirectedPath !== "/listen/",
          "restored into player without pasting",
        );

        const userToken = redirectedPath.replace("/listen/", "");
        // Send an article on / and verify "Open in Web Player →"
        await cdp("Page.navigate", { url: `${BASE}/` });
        await until(`document.readyState === "complete"`, "homepage loaded again");

        await js(`
        document.getElementById("url").value = "https://example.com/front-door-article";
        document.getElementById("token").value = "${userToken}";
        document.getElementById("ingest").requestSubmit();
      `);

        await until(
          `document.getElementById("result")?.classList.contains("ok") || document.getElementById("result")?.textContent.includes("Queued")`,
          "submission success",
        );

        const playerLinkUrl = await js(
          `document.querySelector("#result .player-link")?.getAttribute("href")`,
        );
        checker.check(
          "submission success state offers 'Open in Web Player →'",
          typeof playerLinkUrl === "string" && playerLinkUrl.includes(`/listen/${userToken}`),
          `player link: '${playerLinkUrl}'`,
        );

        const shotDesktop = await cdp("Page.captureScreenshot", { format: "png" });
        await Deno.writeFile(
          `${OUT}01-home-player-link-desktop.png`,
          Uint8Array.from(atob(shotDesktop.data), (c) => c.charCodeAt(0)),
        );
        console.log(`Saved screenshot to ${OUT}01-home-player-link-desktop.png`);

        // 2. Mobile test (390x844)
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true,
        });

        await cdp("Page.navigate", { url: `${BASE}/` });
        await until(`document.readyState === "complete"`, "mobile load");

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
          `${OUT}02-home-player-link-mobile-390.png`,
          Uint8Array.from(atob(shotMobile.data), (c) => c.charCodeAt(0)),
        );
        console.log(`Saved screenshot to ${OUT}02-home-player-link-mobile-390.png`);

        ws.close();
      }, { prefix: "audiofeed-home-player-" });
    } finally {
      await writeEvidenceReadme({
        dir: OUT,
        title: "Front door player links",
        script: "scripts/home-player-link-browser-proof.ts",
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
