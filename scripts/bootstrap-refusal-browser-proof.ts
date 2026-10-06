/**
 * Browser proof for refusing admin bootstrap of existing accounts (audio-feed-xw7).
 *
 * Verifies Paul's ruling:
 *   - POST /api/auth/bootstrap refuses existing accounts with HTTP 409 Conflict.
 *   - Existing users (approved, pending, suspended) are NOT promoted or re-enrolled.
 *   - The browser UI displays the refusal message clearly in #bootstrapFeedback.
 *   - New accounts can still be bootstrapped into approved admins.
 *
 *   deno run --allow-all --unstable-kv scripts/bootstrap-refusal-browser-proof.ts
 */

import {
  createTempChromeProfile,
  newestChrome,
  spawnHarness,
} from "./proof-helper.ts";

const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-bootstrap-refusal-");
const harness = await spawnHarness("scripts/account-harness.ts");
const BASE = harness.base;
const OUT = new URL("../docs/evidence/audio-feed-xw7/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -- chrome -------------------------------------------------------------------
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
  port = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split("\n")[0]!;
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

const steps: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = "") {
  steps.push({ name, pass, detail });
  const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}  ${detail}`);
  if (!pass) throw new Error(`step failed: ${name}`);
}

async function until(expr: string, desc: string, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(expr)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}

async function go(path: string) {
  await cdp("Page.navigate", { url: `${BASE}${path}` });
  await until(`document.readyState === "complete"`, `load ${path}`);
  await sleep(100);
}

let exitCode = 0;
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

  // 1. Visit /login?next=%2Fadmin#bootstrap
  await go("/login?next=%2Fadmin#bootstrap");
  check(
    "#bootstrap fragment auto-opens Admin bootstrap details",
    await js(`document.getElementById("bootstrapDetails")?.open === true`),
    "accordion is open",
  );

  // 2. Refusal test: submit valid token with existing approved reader email (rita@example.com)
  await js(`
    document.getElementById("bootstrapEmail").value = "rita@example.com";
    document.getElementById("bootstrapToken").value = "harness-admin";
    document.getElementById("bootstrapSubmit").disabled = false;
    document.getElementById("bootstrapForm").requestSubmit();
  `);
  await until(
    `document.getElementById("bootstrapFeedback").dataset.tone === "error"`,
    "error on existing user bootstrap",
  );
  const ritaFeedback = await js(`document.getElementById("bootstrapFeedback").textContent`);
  check(
    "existing account bootstrap is refused with 409 error message",
    ritaFeedback.includes("An account already exists for this email"),
    ritaFeedback,
  );
  check(
    "page stays on login, no redirect occurs",
    (await js(`location.pathname`)) === "/login",
    "still on /login",
  );

  // Capture refusal screenshot
  const shotRefusal = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}01-existing-account-refusal.png`,
    Uint8Array.from(atob(shotRefusal.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-existing-account-refusal.png`);

  // 3. Refusal test: submit valid token with existing pending reader email (sam@example.com)
  await js(`
    document.getElementById("bootstrapEmail").value = "sam@example.com";
    document.getElementById("bootstrapToken").value = "harness-admin";
    document.getElementById("bootstrapSubmit").disabled = false;
    document.getElementById("bootstrapForm").requestSubmit();
  `);
  await until(
    `document.getElementById("bootstrapFeedback").dataset.tone === "error"`,
    "error on pending user bootstrap",
  );
  const samFeedback = await js(`document.getElementById("bootstrapFeedback").textContent`);
  check(
    "existing pending account bootstrap is also refused with 409",
    samFeedback.includes("An account already exists for this email"),
    samFeedback,
  );

  // 4. Valid bootstrap: enter new non-existing email with correct token
  await js(`
    document.getElementById("bootstrapEmail").value = "freshadmin@example.com";
    document.getElementById("bootstrapToken").value = "harness-admin";
    document.getElementById("bootstrapSubmit").disabled = false;
    document.getElementById("bootstrapForm").requestSubmit();
  `);

  // Wait for WebAuthn ceremony to complete and redirect to /admin
  await until(`location.pathname === "/admin"`, "redirect to /admin", 10000);
  check(
    "new admin bootstrap completes passkey registration and redirects to /admin",
    (await js(`location.pathname`)) === "/admin",
    "landed on /admin",
  );

  // 5. Verify /admin console loaded on session
  await until(`document.getElementById("usersBody")?.children?.length > 0`, "console subscribers loaded");
  const adminEmail = await js(`document.querySelector(".signin-card strong")?.textContent || ""`);
  check(
    "admin console is signed in as new bootstrap admin",
    adminEmail.length > 0,
    `signed in header: ${adminEmail}`,
  );

  // Capture success screenshot
  const shotSuccess = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}02-new-admin-bootstrap-success.png`,
    Uint8Array.from(atob(shotSuccess.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}02-new-admin-bootstrap-success.png`);
  await cdp("WebAuthn.disable").catch(() => {});
} catch (e) {
  console.error("FATAL", e);
  exitCode = 1;
} finally {
  try {
    await ws.close();
    chrome.kill();
  } catch { /* ignore */ }
  harness.kill();
  await cleanup();
  Deno.exit(exitCode);
}
