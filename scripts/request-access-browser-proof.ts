/**
 * Browser proof for the front door request-access workflow (audio-feed-r97).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts application server on port 8146.
 *   2. Desktop (1280x900):
 *      - Verifies request access section and inputs on front door.
 *      - Submits request access form with email and display name.
 *      - Asserts honest pending response and zero capability/token leaks.
 *      - Proves pending token is refused for ingest, player, and feed (403).
 *      - Captures initial and submitted desktop screenshots.
 *   3. Mobile (390x844):
 *      - Asserts zero horizontal overflow at 390px.
 *      - Captures mobile initial and submitted screenshots.
 *   4. Admin Approval & End-to-End Unlock:
 *      - Approves user via admin gate.
 *      - Proves token now unlocks player (200), master feed (200), and ingest (202).
 *      - Captures player screenshot.
 *
 *   deno run --allow-all --unstable-kv scripts/request-access-browser-proof.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser } from "../src/auth/users.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import {
  createTempChromeProfile,
  newestChrome,
  runProof,
  writeEvidenceReadme,
} from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";

await runProof("request-access-browser-proof", async (checker) => {
  const { profileDir: PROFILE, cleanup } = await createTempChromeProfile(
    "audiofeed-request-access-",
  );
  const ADMIN_TOKEN = "admin-secret-proof";
  const OUT = new URL("../docs/evidence/audio-feed-r97/", import.meta.url).pathname;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  await Deno.mkdir(OUT, { recursive: true });

  // -- start in-process server --------------------------------------------------
  const config: AppConfig = {
    port: 0,
    adminToken: ADMIN_TOKEN,
  };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const handlers = createHandlers(ctx, {
    fetchArticle: (url) =>
      Promise.resolve({
        url,
        title: "Test Ingest Article",
        author: "Test Author",
        publishedAt: new Date().toISOString(),
        lead: "Lead",
        body: "Full body",
      }),
  });
  const { fetch: appFetch } = createApp(ctx, handlers);

  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => appFetch(req));
  const PORT = (server.addr as Deno.NetAddr).port;
  const BASE = `http://localhost:${PORT}`;
  config.port = PORT;
  config.publicBaseUrl = BASE;

  // -- launch chrome ------------------------------------------------------------

  const chrome = new Deno.Command(newestChrome(), {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${PROFILE}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();

  let debugPort = "";
  for (let i = 0; i < 100 && !debugPort; i++) {
    await sleep(100);
    debugPort = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split(
      "\n",
    )[0]!;
  }

  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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
    const msg = await new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r));
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
    if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result?.value;
  }

  const checks: { name: string; pass: boolean; detail: string }[] = [];
  function check(name: string, pass: boolean, detail = "") {
    checks.push({ name, pass, detail });
    checker.check(name, pass, detail);
  }

  async function until(expr: string, desc: string, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await js(expr)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for: ${desc}`);
  }

  let crashError: unknown = null;
  try {
    await cdp("Page.enable");
    await cdp("Runtime.enable");

    // 1. Desktop pass (1280x900)
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp("Page.navigate", { url: `${BASE}/` });
    await until(`document.readyState === "complete"`, "homepage loaded");

    const requestHeader = await js(`document.getElementById("request-access")?.textContent`);
    check(
      "front door has request access section",
      requestHeader?.includes("Request access") === true,
      `header: '${requestHeader}'`,
    );

    const cueLink = await js(`!!document.querySelector('a[href="#request-access"]')`);
    check("subscribing copy links down to request access form", cueLink === true, "anchor present");

    // Capture desktop initial screenshot
    const shotDesktop1 = await cdp("Page.captureScreenshot", { format: "png" });
    const shotDesktop1Path = `${OUT}01-request-access-desktop.png`;
    await Deno.writeFile(
      shotDesktop1Path,
      Uint8Array.from(atob(shotDesktop1.data), (c) => c.charCodeAt(0)),
    );
    await quantiseEvidencePng(shotDesktop1Path);
    console.log(`Saved screenshot to ${shotDesktop1Path}`);

    // Fill in form and submit
    await js(`
    document.getElementById("request-email").value = "visitor@example.com";
    document.getElementById("request-name").value = "Ada Lovelace";
    document.getElementById("request-access-form").requestSubmit();
  `);

    await until(
      `document.getElementById("request-result")?.classList.contains("ok")`,
      "request submitted",
    );

    const resultText = await js(`document.getElementById("request-result")?.textContent`);
    check(
      "response acknowledges submission honestly",
      resultText?.includes(
        "If this address is eligible, your access request will be reviewed by an administrator.",
      ) === true,
      `msg: '${resultText}'`,
    );

    const leakedToken = await js(`
    document.getElementById("request-result")?.textContent.includes("/feed/") ||
    document.getElementById("request-result")?.textContent.includes("/listen/")
  `);
    check(
      "response does NOT leak capability URL to unapproved applicant",
      leakedToken === false,
      "no token or URL exposed",
    );

    // Capture desktop submitted screenshot
    // uiye: re-size to the document's FULL height before the submitted
    // capture. The metrics above were set once for the pre-submit page, so a plain
    // viewport grab crops the confirmation that submission appends below the fold -
    // which is why 03 and 04 came out byte-identical.
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: Math.ceil(
        await js("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)"),
      ),
      deviceScaleFactor: 1,
      mobile: false,
    });

    const shotDesktop2 = await cdp("Page.captureScreenshot", { format: "png" });
    const shotDesktop2Path = `${OUT}02-request-access-submitted-desktop.png`;
    await Deno.writeFile(
      shotDesktop2Path,
      Uint8Array.from(atob(shotDesktop2.data), (c) => c.charCodeAt(0)),
    );
    await quantiseEvidencePng(shotDesktop2Path);
    console.log(`Saved screenshot to ${shotDesktop2Path}`);

    // Verify user in store
    const pendingUser = await stores.metadata.getUserByEmail("visitor@example.com");
    check(
      "user lands in metadata store as pending",
      pendingUser?.status === "pending",
      `status: '${pendingUser?.status}'`,
    );
    const token = pendingUser!.feedToken;

    // Verify spend gate authority: pending token is refused for ingest, player, and feed
    const ingestPending = await fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-feed-token": token },
      body: JSON.stringify({ url: "https://example.com/test" }),
    });
    check(
      "pending user cannot ingest (403 forbidden)",
      ingestPending.status === 403,
      `status: ${ingestPending.status}`,
    );

    const playerPending = await fetch(`${BASE}/listen/${token}`);
    check(
      "pending user cannot access player (403 forbidden)",
      playerPending.status === 403,
      `status: ${playerPending.status}`,
    );

    const feedPending = await fetch(`${BASE}/feed/${token}/master.xml`);
    check(
      "pending user cannot access feed (403 forbidden)",
      feedPending.status === 403,
      `status: ${feedPending.status}`,
    );

    // 2. Mobile pass (390x844)
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });

    await cdp("Page.navigate", { url: `${BASE}/` });
    await until(`document.readyState === "complete"`, "mobile loaded");

    const overflow = await js(
      `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
    );
    check(
      "mobile front door has zero horizontal overflow at 390px",
      overflow === false,
      "no horizontal scroll",
    );

    const shotMobile1 = await cdp("Page.captureScreenshot", { format: "png" });
    const shotMobile1Path = `${OUT}03-request-access-mobile-390.png`;
    await Deno.writeFile(
      shotMobile1Path,
      Uint8Array.from(atob(shotMobile1.data), (c) => c.charCodeAt(0)),
    );
    await quantiseEvidencePng(shotMobile1Path);
    console.log(`Saved screenshot to ${shotMobile1Path}`);

    // Submit on mobile
    await js(`
    document.getElementById("request-email").value = "mobile-applicant@example.com";
    document.getElementById("request-name").value = "Mobile User";
    document.getElementById("request-access-form").requestSubmit();
  `);
    await until(
      `document.getElementById("request-result")?.classList.contains("ok")`,
      "mobile request submitted",
    );

    // uiye: same re-size for the mobile pair (dsf 3), so the submitted
    // confirmation is inside the frame rather than below it.
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: Math.ceil(
        await js("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)"),
      ),
      deviceScaleFactor: 3,
      mobile: true,
    });

    const shotMobile2 = await cdp("Page.captureScreenshot", { format: "png" });
    const shotMobile2Path = `${OUT}04-request-access-submitted-mobile.png`;
    await Deno.writeFile(
      shotMobile2Path,
      Uint8Array.from(atob(shotMobile2.data), (c) => c.charCodeAt(0)),
    );
    await quantiseEvidencePng(shotMobile2Path);
    console.log(`Saved screenshot to ${shotMobile2Path}`);

    // 3. Admin approval unlocks capabilities
    await approveUser(stores.metadata, pendingUser!.id, "admin");

    const playerApproved = await fetch(`${BASE}/listen/${token}`);
    check(
      "approved user accesses player (200 OK)",
      playerApproved.status === 200,
      `status: ${playerApproved.status}`,
    );

    const feedApproved = await fetch(`${BASE}/feed/${token}/master.xml`);
    check(
      "approved user accesses master feed (200 OK)",
      feedApproved.status === 200,
      `status: ${feedApproved.status}`,
    );

    const ingestApproved = await fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-feed-token": token },
      body: JSON.stringify({ url: "https://example.com/test-article" }),
    });
    check(
      "approved user can ingest (202 Queued)",
      ingestApproved.status === 202,
      `status: ${ingestApproved.status}`,
    );

    // Navigate to player in Chrome and capture proof
    await cdp("Page.navigate", { url: `${BASE}/listen/${token}` });
    await until(`document.readyState === "complete"`, "player loaded");

    const shotPlayer = await cdp("Page.captureScreenshot", { format: "png" });
    const shotPlayerPath = `${OUT}05-approved-player-unlocked.png`;
    await Deno.writeFile(
      shotPlayerPath,
      Uint8Array.from(atob(shotPlayer.data), (c) => c.charCodeAt(0)),
    );
    await quantiseEvidencePng(shotPlayerPath);
    console.log(`Saved screenshot to ${shotPlayerPath}`);
  } catch (err) {
    crashError = err;
    checker.check("proof execution completed without unhandled exception", false, String(err));
  } finally {
    try {
      chrome.kill();
    } catch { /* ignore */ }
    await server.shutdown().catch(() => {});
    await cleanup();
    await writeEvidenceReadme({
      dir: OUT,
      title: "Request Access Front Door Verification Report: audio-feed-r97",
      script: "scripts/request-access-browser-proof.ts",
      asserts: checks.map((c) => c.name),
      checker,
    });
  }
  if (crashError) throw crashError;
});
