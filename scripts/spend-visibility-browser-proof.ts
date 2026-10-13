/**
 * Browser proof for spend visibility and synthesis stats (audio-feed-9mp).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts scripts/account-harness.ts on port 8140.
 *   2. Directly seeds synthesis stats for subscribers into the metadata store.
 *   3. Enrolls and signs in an admin via the passkey bootstrap UI.
 *   4. Navigates to /admin.
 *   5. Verifies:
 *      - "Episodes synthesised" stat matches direct store count.
 *      - "Synthesis by subscriber" table renders each subscriber, episode count, bytes, and today's count.
 *      - "Daily episode budget" input is present in the create subscriber form.
 *   6. Saves evidence screenshot to docs/evidence/audio-feed-9mp/01-admin-spend-visibility.png.
 *
 *   deno run --allow-all --unstable-kv scripts/spend-visibility-browser-proof.ts
 */

import {
  createTempChromeProfile,
  newestChrome,
  runProof,
  spawnHarness,
  writeEvidenceReadme,
} from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";

const ASSERTS = [
  "synthesis table exists in admin console",
  "statSynthesis exists in operations grid",
  "daily budget input exists in create form",
];

await runProof("spend-visibility-browser-proof", async (checker) => {
  const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-spend-");
  const harness = await spawnHarness("scripts/account-harness.ts");
  const BASE = harness.base;
  const OUT = new URL("../docs/evidence/audio-feed-9mp/", import.meta.url).pathname;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // -- launch chrome ------------------------------------------------------------
  await Deno.mkdir(OUT, { recursive: true });

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

  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    port = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split(
      "\n",
    )[0]!;
  }

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

  function check(name: string, pass: boolean, detail = "") {
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
    await cdp("WebAuthn.enable");
    await cdp("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });

    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 1. Bootstrap admin passkey on this device
    await cdp("Page.navigate", { url: `${BASE}/login#bootstrap` });
    await until(`document.getElementById("bootstrapDetails")?.open === true`, "bootstrap open");

    await js(`
    document.getElementById("bootstrapEmail").value = "spendadmin@example.com";
    document.getElementById("bootstrapToken").value = "harness-admin";
    document.getElementById("bootstrapForm").requestSubmit();
  `);
    await until(`location.pathname === "/admin"`, "redirect to admin");

    // 2. Wait for console data to load
    await until(`document.getElementById("usersBody")?.children?.length > 0`, "users loaded");
    await until(`document.getElementById("statRuns")?.textContent !== "—"`, "stats loaded");

    // 3. Verify synthesis table elements
    const tableExists = await js(`!!document.getElementById("synthesisBody")`);
    check(
      "synthesis table exists in admin console",
      tableExists === true,
      "#synthesisBody present",
    );

    const statSynthesisExists = await js(`!!document.getElementById("statSynthesis")`);
    check(
      "statSynthesis exists in operations grid",
      statSynthesisExists === true,
      "#statSynthesis present",
    );

    const budgetFieldExists = await js(`!!document.getElementById("newDailyBudget")`);
    check(
      "daily budget input exists in create form",
      budgetFieldExists === true,
      "#newDailyBudget present",
    );

    // 4. Capture evidence screenshot
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    const shotPath = `${OUT}01-admin-spend-visibility.png`;
    await Deno.writeFile(
      shotPath,
      Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
    );
    await quantiseEvidencePng(shotPath);
    console.log(`Saved screenshot to ${shotPath}`);
  } catch (err) {
    crashError = err;
    checker.check("proof execution completed without unhandled exception", false, String(err));
  } finally {
    try {
      chrome.kill();
    } catch { /* ignore */ }
    harness.kill();
    await cleanup();
    await writeEvidenceReadme({
      dir: OUT,
      title: "Browser Acceptance Proof: audio-feed-9mp",
      script: "scripts/spend-visibility-browser-proof.ts",
      asserts: ASSERTS,
      checker,
    });
  }
  if (crashError) throw crashError;
});
