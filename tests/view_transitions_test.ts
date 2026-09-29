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

const BASE = "https://audio.example.com";

Deno.test("DESIGN_TOKENS: declares @view-transition navigation: auto under no-preference motion (audio-feed-rra)", () => {
  assertStringIncludes(DESIGN_TOKENS, "@media (prefers-reduced-motion: no-preference)");
  assertStringIncludes(DESIGN_TOKENS, "@view-transition");
  assertStringIncludes(DESIGN_TOKENS, "navigation: auto;");
});

Deno.test("DESIGN_TOKENS: respects reduced-motion preference (audio-feed-rra)", () => {
  assertStringIncludes(DESIGN_TOKENS, "@media (prefers-reduced-motion: reduce)");
  assertStringIncludes(DESIGN_TOKENS, "animation-duration: 0.01ms !important;");
  assertStringIncludes(DESIGN_TOKENS, "transition-duration: 0.01ms !important;");
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
