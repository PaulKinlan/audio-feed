/**
 * Tests for Cross-Document View Transitions (audio-feed-rra).
 *
 * Verifies:
 * - DESIGN_TOKENS defines `@view-transition { navigation: auto; }` for no-preference motion
 * - Reduced motion preference suppresses transitions
 * - Persistent UI elements declare consistent view-transition-name identifiers:
 *   - .app-header / .site-header -> app-header
 *   - .brand -> app-brand
 *   - .dock -> player-dock
 * - All user pages (Home, Account, Player) inherit view transitions via unified tokens
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DESIGN_TOKENS } from "../src/routes/tokens.ts";
import { SHELL_CSS } from "../src/routes/shell.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { createTempChromeProfile, newestChrome } from "../scripts/proof-helper.ts";

const BASE = "https://audio.example.com";

Deno.test("DESIGN_TOKENS: declares @view-transition navigation: auto under no-preference motion (audio-feed-rra)", () => {
  assertStringIncludes(DESIGN_TOKENS, "@media (prefers-reduced-motion: no-preference)");
  assertStringIncludes(DESIGN_TOKENS, "@view-transition");
  assertStringIncludes(DESIGN_TOKENS, "navigation: auto;");
});

Deno.test("DESIGN_TOKENS: @view-transition is strictly scoped to no-preference motion (audio-feed-rra, audio-feed-81q)", () => {
  const pattern =
    /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?@view-transition\s*\{[\s\S]*?navigation:\s*auto;[\s\S]*?\}\s*\}/;
  assertEquals(
    pattern.test(DESIGN_TOKENS),
    true,
    "view transition declaration must be nested inside @media (prefers-reduced-motion: no-preference)",
  );

  const withoutScopedVt = DESIGN_TOKENS.replace(pattern, "");
  assertEquals(
    withoutScopedVt.includes("@view-transition"),
    false,
    "no unconstrained @view-transition allowed outside prefers-reduced-motion: no-preference",
  );
});

Deno.test("view-transitions: link click engages transition under no-preference and suppresses under reduce (audio-feed-rra, audio-feed-81q)", async () => {
  const hasRun = (await Deno.permissions.query({ name: "run" })).state === "granted";
  if (!hasRun) return;

  const pageA = `<!doctype html>
<html>
<head>
<style>${DESIGN_TOKENS}</style>
</head>
<body>
  <h1>Page A</h1>
  <a id="linkToB" href="/b">Go to B</a>
</body>
</html>`;

  const pageB = `<!doctype html>
<html>
<head>
<style>${DESIGN_TOKENS}</style>
<script>
  window.revealedTransition = null;
  window.addEventListener("pagereveal", (e) => {
    window.revealedTransition = Boolean(e.viewTransition);
  });
</script>
</head>
<body>
  <h1>Page B</h1>
  <a id="linkToA" href="/a">Go to A</a>
</body>
</html>`;

  const server = Deno.serve({ port: 0 }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/a") {
      return new Response(pageA, { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/b") {
      return new Response(pageB, { headers: { "content-type": "text/html" } });
    }
    return new Response("Not found", { status: 404 });
  });

  const port = server.addr.port;
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-vt-proof-");
  const chrome = new Deno.Command(newestChrome(), {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let cdpPort = "";
  for (let i = 0; i < 50 && !cdpPort; i++) {
    await sleep(100);
    cdpPort = (await Deno.readTextFile(`${profileDir}/DevToolsActivePort`).catch(() => "")).split(
      "\n",
    )[0]!;
  }

  try {
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    // deno-lint-ignore no-explicit-any
    const page = targets.find((t: any) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));

    let nextId = 0;
    // deno-lint-ignore no-explicit-any
    const pending = new Map<number, (v: any) => void>();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });
    const cdp = (method: string, params: Record<string, unknown> = {}) => {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve) => pending.set(id, resolve));
    };

    await cdp("Page.enable");
    await cdp("Runtime.enable");

    // 1. Emulate no-preference: link click must engage view transition
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await cdp("Page.navigate", { url: `http://localhost:${port}/a` });
    await sleep(300);
    await cdp("Runtime.evaluate", { expression: `document.getElementById("linkToB").click()` });
    await sleep(500);
    // deno-lint-ignore no-explicit-any
    const resNoPref: any = await cdp("Runtime.evaluate", {
      expression: `window.revealedTransition`,
    });
    assertEquals(
      resNoPref.result.result.value,
      true,
      "view transition must be engaged under no-preference motion",
    );

    // 2. Emulate reduce: link click must suppress view transition
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await cdp("Page.navigate", { url: `http://localhost:${port}/a` });
    await sleep(300);
    await cdp("Runtime.evaluate", { expression: `document.getElementById("linkToB").click()` });
    await sleep(500);
    // deno-lint-ignore no-explicit-any
    const resReduce: any = await cdp("Runtime.evaluate", {
      expression: `window.revealedTransition`,
    });
    assertEquals(
      resReduce.result.result.value,
      false,
      "view transition must NOT be engaged under reduced motion",
    );

    ws.close();
  } finally {
    try {
      chrome.kill();
    } catch { /* ignore */ }
    await cleanup();
    await server.shutdown();
  }
});

Deno.test("shell & player define persistent view-transition-name identifiers (audio-feed-rra)", async () => {
  // Shell CSS (Home, Account, Login, Admin)
  assertStringIncludes(SHELL_CSS, "view-transition-name: app-header;");
  assertStringIncludes(SHELL_CSS, "view-transition-name: app-brand;");

  // Player CSS
  const assetModule = await import("../src/routes/assets.ts");
  const url = assetModule.assetUrl("listen.css");
  const fileName = url.replace("/assets/", "");
  const res = assetModule.handleAsset(
    // deno-lint-ignore no-explicit-any
    { params: { name: fileName } } as any,
  );
  assertEquals(res.status, 200);
  const css = await res.text();
  assertStringIncludes(css, "view-transition-name: app-header;");
  assertStringIncludes(css, "view-transition-name: player-dock;");
});

Deno.test("pages include view transition declarations in rendered markup (audio-feed-rra)", async () => {
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const rawUser = await createUser(stores.metadata, {
    email: "vt@example.com",
    displayName: "VT Listener",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);
  const cookie = `__Host-af_session=${session}`;

  // 1. Homepage
  const homeRes = await fetch(new Request(BASE));
  const homeHtml = await homeRes.text();
  assertStringIncludes(homeHtml, "@view-transition");
  assertStringIncludes(homeHtml, "navigation: auto;");

  // 2. Account
  const accountRes = await fetch(new Request(`${BASE}/account`, { headers: { cookie } }));
  const accountHtml = await accountRes.text();
  assertStringIncludes(accountHtml, "@view-transition");

  // 3. Player
  const playerRes = await fetch(new Request(`${BASE}/listen/${user.feedToken}`));
  const playerHtml = await playerRes.text();
  // Player links to content-addressed listen.css, which embeds DESIGN_TOKENS
  assertStringIncludes(playerHtml, "listen.css");
});
