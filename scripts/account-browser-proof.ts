/**
 * Browser proof for the login and account system (audio-feed-8fc).
 *
 * Starts scripts/account-harness.ts, drives real headless Chrome over CDP with a
 * CDP virtual authenticator (ctap2, internal, resident keys, user verified), and
 * walks: setup link -> register a passkey -> sign out -> sign in -> account edits
 * persist -> the admin reaches /admin -> a non-admin gets 403 there. Screenshots
 * of every page at 390px and 1280px in light and dark land in
 * docs/evidence/audio-feed-8fc/, with evidence.json recording each step.
 *
 * No setup secret is written anywhere: every link used here is consumed by the
 * run itself, and the one left unused expires in seven days on a memory store
 * that dies with the harness.
 *
 *   deno run --allow-all --unstable-kv scripts/account-browser-proof.ts
 */

import {
  createTempChromeProfile,
  newestChrome,
  spawnHarness,
} from "./proof-helper.ts";

const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-account-");
const harness = await spawnHarness("scripts/account-harness.ts");
const BASE = harness.base;
const OUT = new URL("../docs/evidence/audio-feed-8fc/", import.meta.url).pathname;

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
  return r.result.value;
}
async function until(expression: string, label: string, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await js(expression)) return;
    } catch { /* page mid-navigation */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function go(path: string) {
  await cdp("Page.navigate", { url: `${BASE}${path}` });
  await sleep(150);
  await until(`document.readyState === "complete"`, `load ${path}`);
}
const status = () => js(`performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0`);
const path = () => js(`location.pathname + location.hash`);

// -- screenshots --------------------------------------------------------------
const shots: string[] = [];
async function sweep(name: string) {
  for (const scheme of ["light", "dark"]) {
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    for (const width of [390, 1280]) {
      const mobile = width < 500;
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile,
      });
      await sleep(120);
      const height = Math.min(await js(`document.documentElement.scrollHeight`), 6000);
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
      await sleep(80);
      const { data } = await cdp("Page.captureScreenshot", { format: "png" });
      const file = `${name}-${width}-${scheme}.png`;
      await Deno.writeFile(`${OUT}${file}`, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      shots.push(file);
    }
  }
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

// -- the run --------------------------------------------------------------------
const steps: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail: string) {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${detail}`);
  if (!ok) throw new Error(`step failed: ${step}`);
}

async function issue(email: string): Promise<string> {
  const users = await (await fetch(`${BASE}/api/admin/users`, {
    headers: { "x-admin-token": "harness-admin" },
  })).json();
  const user = users.users.find((u: { email: string }) => u.email === email);
  const res = await fetch(`${BASE}/api/admin/users/${user.id}/setup-link`, {
    method: "POST",
    headers: { "x-admin-token": "harness-admin" },
  });
  return (await res.json()).url;
}

let exitCode = 0;
try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("WebAuthn.enable");
  const { authenticatorId } = await cdp("WebAuthn.addVirtualAuthenticator", {
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

  // Signed-out pages.
  await go("/");
  await sweep("01-home-signed-out");
  await go("/login");
  await sweep("02-login");
  await go("/admin");
  check(
    "signed-out /admin offers sign-in with token controls removed (audio-feed-0jp)",
    await js(
      `!!document.querySelector('a[href="/login?next=%2Fadmin"]') && !document.getElementById("adminToken") && !document.getElementById("saveToken") && !document.body.innerText.includes("Use admin token instead")`,
    ),
    `status ${await status()}`,
  );
  await sweep("03-admin-signed-out");

  // 1. Setup link -> register a passkey (bootstrap: ADMIN_TOKEN issues it).
  await go("/login#setup=" + (await issue("paul\u0040example.com")).split("#setup=")[1]);
  await until(`!document.getElementById("createPasskey").disabled`, "setup options");
  check(
    "setup link: secret scrubbed from the address bar",
    !(await path()).includes("setup="),
    `location is ${await path()}`,
  );
  await sweep("04-login-setup");
  await js(`document.getElementById("createPasskey").click()`);
  await until(`location.pathname === "/account"`, "account after register");
  const creds = (await cdp("WebAuthn.getCredentials", { authenticatorId })).credentials;
  check(
    "register a passkey from the setup link",
    creds.length === 1 && creds[0].isResidentCredential,
    `authenticator holds ${creds.length} resident credential(s); landed on /account`,
  );

  // 2. Sign out.
  await js(`document.querySelector('form[action="/api/auth/logout"] button').click()`);
  await until(
    `location.pathname === "/" && !!document.querySelector('.who .sign-in')`,
    "signed out",
  );
  await go("/account");
  check(
    "sign out",
    (await path()).startsWith("/login"),
    `/account now redirects to ${await path()}`,
  );

  // 3. Sign in.
  await js(`document.getElementById("signIn").click()`);
  await until(`location.pathname === "/account"`, "account after sign in");
  check(
    "sign in with the passkey",
    true,
    `back on /account as ${await js(`document.querySelector(".who .name").textContent`)}`,
  );

  // 4. Account edits persist.
  await js(
    `document.getElementById("displayName").value = "Paul K."; document.getElementById("voice").value = "Kore"; document.getElementById("profileForm").requestSubmit()`,
  );
  await until(
    `document.getElementById("profileFeedback").textContent === "Saved."`,
    "profile saved",
  );
  await sleep(900);
  await go("/account");
  const saved = await js(
    `[document.getElementById("displayName").value, document.getElementById("voice").value, document.querySelector(".who .name").textContent]`,
  );
  check(
    "account edits persist across a reload",
    saved[0] === "Paul K." && saved[1] === "Kore" && saved[2] === "Paul K.",
    JSON.stringify(saved),
  );
  await js(
    `document.getElementById("sendUrl").value = "https://example.com/article"; document.getElementById("sendForm").requestSubmit()`,
  );
  await until(
    `document.getElementById("sendFeedback").textContent.startsWith("Queued")`,
    "send to audio",
  );
  check(
    "Send to Audio without a token",
    true,
    await js(`document.getElementById("sendFeedback").textContent`),
  );
  await go("/account");
  await sweep("05-account");

  // audio-feed-ktn: self-service Regenerate, each press behind a confirm that
  // states the synthesis it will spend.
  const offered = await js(
    `[document.getElementById("regenOutdated").textContent, document.querySelectorAll("[data-regenerate-episode]").length]`,
  );
  await js(`window.__confirms = []; window.confirm = (m) => (window.__confirms.push(m), true)`);
  await js(`document.querySelector('[data-regenerate-episode="ep-0"]').click()`);
  await until(
    `document.getElementById("regenFeedback").textContent === "Queued for regeneration."`,
    "regenerate one episode",
  );
  const firstConfirm = await js(`window.__confirms[0]`);
  await until(
    `document.getElementById("regenOutdated").textContent === "Regenerate outdated (1)"`,
    "count drops after the reload",
  );
  await js(
    `window.__confirms = [${JSON.stringify(firstConfirm)}]; window.confirm = (m) => (window.__confirms.push(m), true)`,
  );
  await js(`document.getElementById("regenOutdated").click()`);
  await until(
    `document.getElementById("regenFeedback").textContent.includes("queued for regeneration")`,
    "regenerate outdated",
  );
  const regen = await js(
    `[window.__confirms, document.getElementById("regenFeedback").textContent]`,
  );
  await go("/account");
  const after = await js(`document.getElementById("regenOutdated").textContent`);
  check(
    "Regenerate on /account: one episode, then the outdated rest",
    offered[0] === "Regenerate outdated (2)" && offered[1] === 2 &&
      regen[0].length === 2 && regen[0][1].includes("1 outdated episode(s)") &&
      regen[1] === "1 episode(s) queued for regeneration." && after === "Regenerate outdated (0)",
    JSON.stringify({ offered, confirms: regen[0], feedback: regen[1], after }),
  );
  await go("/");
  await sweep("06-home-signed-in");

  // 5. The admin reaches /admin, and issues the next setup link from the console.
  await go("/admin");
  check("admin reaches /admin", (await status()) === 200, `status ${await status()}`);
  await until(`document.getElementById("usersBody").children.length === 3`, "admin user list");
  check(
    "admin console loads subscriber data on session with token controls removed (audio-feed-0jp)",
    await js(
      `!document.getElementById("adminToken") && !document.getElementById("saveToken") && document.getElementById("usersBody").children.length === 3`,
    ),
    "console loaded 3 users on session, zero token inputs present",
  );
  await sweep("07-admin");
  await js(
    `[...document.querySelectorAll("#usersBody button")].find((b) => b.getAttribute("aria-label") === "Setup link for rita\u0040example.com").click()`,
  );
  await until(
    `document.getElementById("setupLinkUrl").value.includes("#setup=")`,
    "setup link from console",
  );
  const ritaLink = await js(`document.getElementById("setupLinkUrl").value`);
  check(
    "admin console issues a setup link on the session",
    ritaLink.startsWith(`${BASE}/login#setup=`),
    "link shown in the console, not logged",
  );

  // 6. A non-admin gets 403 at /admin.
  await js(`document.querySelector('form[action="/api/auth/logout"] button').click()`);
  await until(`location.pathname === "/"`, "signed out again");
  await go("/login#setup=" + ritaLink.split("#setup=")[1]);
  await until(`!document.getElementById("createPasskey").disabled`, "rita setup options");
  await js(`document.getElementById("createPasskey").click()`);
  await until(`location.pathname === "/account"`, "rita account");
  await go("/admin");
  const code = await status();
  check(
    "a non-admin gets 403 at /admin",
    code === 403,
    `status ${code}, heading "${await js(`document.querySelector("h1").textContent`)}"`,
  );
  await sweep("08-admin-403");
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await Deno.writeTextFile(
    `${OUT}evidence.json`,
    JSON.stringify(
      {
        bead: "audio-feed-8fc",
        also: "audio-feed-ktn",
        at: new Date().toISOString(),
        steps,
        shots,
      },
      null,
      2,
    ) +
      "\n",
  );
  ws.close();
  try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
  harness.kill();
  await Promise.allSettled([chrome.status, harness.process.status]);
  await cleanup();
}
Deno.exit(exitCode);
