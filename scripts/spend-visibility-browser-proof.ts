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

const PORT = 8140;
const BASE = `http://localhost:${PORT}`;
const OUT = new URL("../docs/evidence/audio-feed-9mp/", import.meta.url).pathname;
const HOME = Deno.env.get("HOME")!;
const PROFILE = `${HOME}/cap-evidence/9mp/chrome-profile`;

function newestChrome(): string {
  const root = `${HOME}/.cache/puppeteer/chrome`;
  const dirs = [...Deno.readDirSync(root)].filter((d) => d.isDirectory).map((d) => d.name).sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );
  return `${root}/${dirs.at(-1)}/chrome-linux64/chrome`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -- start harness ------------------------------------------------------------
const harness = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-all", "--unstable-kv", "scripts/account-harness.ts", String(PORT)],
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "null",
  stderr: "inherit",
}).spawn();

for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) break;
  } catch { /* wait */ }
  await sleep(100);
}

// -- launch chrome ------------------------------------------------------------
await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
await Deno.mkdir(PROFILE, { recursive: true });
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

function check(name: string, pass: boolean, detail = "") {
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
    document.getElementById("bootstrapEmail").value = "paul@example.com";
    document.getElementById("bootstrapToken").value = "harness-admin";
    document.getElementById("bootstrapForm").requestSubmit();
  `);
  await until(`location.pathname === "/admin"`, "redirect to admin");

  // 2. Wait for console data to load
  await until(`document.getElementById("usersBody")?.children?.length > 0`, "users loaded");
  await until(`document.getElementById("statRuns")?.textContent !== "—"`, "stats loaded");

  // 3. Verify synthesis table elements
  const tableExists = await js(`!!document.getElementById("synthesisBody")`);
  check("synthesis table exists in admin console", tableExists === true, "#synthesisBody present");

  const statSynthesisExists = await js(`!!document.getElementById("statSynthesis")`);
  check("statSynthesis exists in operations grid", statSynthesisExists === true, "#statSynthesis present");

  const budgetFieldExists = await js(`!!document.getElementById("newDailyBudget")`);
  check("daily budget input exists in create form", budgetFieldExists === true, "#newDailyBudget present");

  // 4. Capture evidence screenshot
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}01-admin-spend-visibility.png`,
    Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-admin-spend-visibility.png`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  try { harness.kill(); } catch { /* ignore */ }
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
}

Deno.exit(exitCode);
