/**
 * Browser proof for passkey provider icon and name display (audio-feed-25t).
 *
 * Verifies:
 * - /account renders passkeys with resolved provider icons and provider names:
 *   - Google Password Manager
 *   - iCloud Keychain
 *   - Generic Passkey fallback (for unknown or absent AAGUID)
 * - Renders crisp SVGs and responsive layout on desktop (1280x900) and mobile (390x844).
 *
 *   deno run --allow-all --unstable-kv scripts/passkey-provider-browser-proof.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const OUT = new URL("../docs/evidence/audio-feed-25t/", import.meta.url).pathname;
const HOME = Deno.env.get("HOME")!;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-25t-" });

function newestChrome(): string {
  const root = `${HOME}/.cache/puppeteer/chrome`;
  const dirs = [...Deno.readDirSync(root)].filter((d) => d.isDirectory).map((d) => d.name).sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );
  return `${root}/${dirs.at(-1)}/chrome-linux64/chrome`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// -- in-process test app ------------------------------------------------------
const stores: Stores = memoryStores();
const config: AppConfig = {
  port: 0,
  adminToken: "harness-admin",
};
const ctx = { config, stores };

// Seed user and session
const rawUser = await createUser(stores.metadata, {
  email: "ada@example.com",
  displayName: "Ada Lovelace",
});
const user = await approveUser(stores.metadata, rawUser.id, "admin");
const sessionSecret = await createSession(stores.metadata, user.id);

// Seed passkeys with various AAGUIDs: Google, Apple, and Generic/unknown
await stores.metadata.putCredential({
  id: "cred-google",
  userId: user.id,
  publicKey: "pk-google",
  counter: 12,
  name: "Pixel 9 Pro",
  createdAt: "2026-09-27T10:00:00.000Z",
  lastUsedAt: "2026-09-29T08:00:00.000Z",
  aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
});

await stores.metadata.putCredential({
  id: "cred-apple",
  userId: user.id,
  publicKey: "pk-apple",
  counter: 5,
  name: "MacBook Air",
  createdAt: "2026-09-25T14:30:00.000Z",
  lastUsedAt: "2026-09-28T19:15:00.000Z",
  aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
});

await stores.metadata.putCredential({
  id: "cred-generic",
  userId: user.id,
  publicKey: "pk-generic",
  counter: 2,
  name: "USB Security Key",
  createdAt: "2026-09-20T11:00:00.000Z",
  lastUsedAt: "2026-09-21T09:00:00.000Z",
  aaguid: "00000000-0000-0000-0000-000000000000",
});

const handlers = createHandlers(ctx);
const { fetch: appFetch } = createApp(ctx, handlers);

const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
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
  debugPort = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split("\n")[0]!;
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

function cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, (res) => {
      if (res.error) reject(new Error(`${method}: ${JSON.stringify(res.error)}`));
      else resolve(res.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function js(expr: string): Promise<unknown> {
  const res = (await cdp("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown } };
  return res.result?.value;
}

async function until(expr: string, desc = expr, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await js(`Boolean(${expr})`)) return;
    await sleep(50);
  }
  throw new Error(`Timeout waiting for: ${desc}`);
}

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

let exitCode = 0;

try {
  await cdp("Page.enable");
  await cdp("Network.enable");

  // Set session cookie
  await cdp("Network.setCookie", {
    name: "__Host-af_session",
    value: sessionSecret,
    url: BASE,
    secure: true,
  });

  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 1. Visit /account
  await cdp("Page.navigate", { url: `${BASE}/account` });
  await until(`document.readyState === "complete"`, "account page loaded");
  await until(
    `document.querySelectorAll("[aria-labelledby='passkeys-h'] .rows li").length === 3`,
    "3 passkeys rendered",
  );

  const passkeysText = String(
    await js(`document.querySelector("[aria-labelledby='passkeys-h'] .rows")?.textContent || ""`),
  );

  check(
    "renders Google Password Manager with label",
    passkeysText.includes("Google Password Manager") && passkeysText.includes("Pixel 9 Pro"),
    "Google Password Manager present",
  );

  check(
    "renders iCloud Keychain with label",
    passkeysText.includes("iCloud Keychain") && passkeysText.includes("MacBook Air"),
    "iCloud Keychain present",
  );

  check(
    "renders generic Passkey fallback for unknown AAGUID",
    passkeysText.includes("Passkey") && passkeysText.includes("USB Security Key"),
    "Passkey fallback present",
  );

  const iconCount = Number(
    await js(`document.querySelectorAll(".provider-icon svg").length`),
  );
  check(
    "every passkey row renders an inline SVG provider icon",
    iconCount === 3,
    `found ${iconCount} SVGs`,
  );

  // Scroll passkeys panel into view so rows are clearly visible in screenshot (audio-feed-6wk)
  await js(
    `document.querySelector("[aria-labelledby='passkeys-h']")?.scrollIntoView({ block: "center", behavior: "instant" })`,
  );
  await sleep(100);

  const desktopCardVisible = Boolean(
    await js(`(() => {
      const el = document.querySelector("[aria-labelledby='passkeys-h']");
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    })()`),
  );
  check(
    "passkeys card is scrolled into view on desktop",
    desktopCardVisible,
    "passkeys card centered in desktop viewport",
  );

  const shotDesktop = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}01-account-passkey-providers-desktop.png`,
    Uint8Array.from(atob(shotDesktop.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}01-account-passkey-providers-desktop.png`);

  // 2. Mobile viewport (390x844)
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });

  const overflow = await js(
    `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
  );
  check(
    "mobile passkey list has zero horizontal overflow",
    overflow === false,
    "no horizontal scroll at 390px",
  );

  // Scroll passkeys panel into view on mobile as well (audio-feed-6wk)
  await js(
    `document.querySelector("[aria-labelledby='passkeys-h']")?.scrollIntoView({ block: "center", behavior: "instant" })`,
  );
  await sleep(100);

  const mobileCardVisible = Boolean(
    await js(`(() => {
      const el = document.querySelector("[aria-labelledby='passkeys-h']");
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    })()`),
  );
  check(
    "passkeys card is scrolled into view on mobile",
    mobileCardVisible,
    "passkeys card visible in mobile viewport",
  );

  const shotMobile = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Deno.writeFile(
    `${OUT}02-account-passkey-providers-mobile-390.png`,
    Uint8Array.from(atob(shotMobile.data), (c) => c.charCodeAt(0)),
  );
  console.log(`Saved screenshot to ${OUT}02-account-passkey-providers-mobile-390.png`);

  // Write summary markdown report
  const summary = `# Passkey Provider Icon and Name Verification: audio-feed-25t

## Implementation Overview
Implements WebAuthn AAGUID resolution per [web.dev/articles/passkey-management](https://web.dev/articles/passkey-management) and [web.dev/articles/webauthn-aaguid](https://web.dev/articles/webauthn-aaguid).
- Authenticator AAGUID is extracted during WebAuthn registration (\`verification.registrationInfo.aaguid\`) and persisted on \`PasskeyCredential.aaguid\`.
- \`src/auth/aaguid.ts\` maps known AAGUIDs across Google Password Manager, Apple iCloud Keychain, Windows Hello, 1Password, Bitwarden, Dashlane, and YubiKey to brand names and inline SVG icons.
- If AAGUID is empty, unknown, or all-zeroes, it falls back to a clean generic Passkey icon.
- \`/account\` UI displays the provider logo SVG and provider name alongside the passkey creation date, last used date, and user label.

## Verification Results
\`\`\`
${checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")}
\`\`\`

## Screenshots
- \`01-account-passkey-providers-desktop.png\`: Desktop view of /account showing Google Password Manager, iCloud Keychain, and Passkey icons.
- \`02-account-passkey-providers-mobile-390.png\`: Mobile view showing responsive passkey list without overflow.
`;

  await Deno.writeTextFile(`${OUT}README.md`, summary);
  console.log(`Saved report to ${OUT}README.md`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  await server.shutdown().catch(() => {});
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
}

Deno.exit(exitCode);
