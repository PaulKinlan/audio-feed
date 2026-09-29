/**
 * Tests for Speculation Rules API prefetching (audio-feed-nvj).
 *
 * Verifies:
 * - Homepage, account, login, and player pages serve valid <script type="speculationrules">
 * - Speculation rules JSON is well-formed per WICG Speculation Rules specification
 * - Eagerness is set to "moderate" (prefetch on hover / intent)
 * - Critical exclusions are strictly declared: /api/*, /admin*, and logout endpoints
 * - Admin console strictly omits speculation rules to preserve script isolation and avoid prefetching
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { SPECULATION_RULES } from "../src/routes/shell.ts";
import { parseHTML } from "npm:linkedom@0.18.12";

const BASE = "https://audio.example.com";

function extractSpeculationRules(html: string): unknown | null {
  const match = html.match(/<script\s+type="speculationrules">([\s\S]*?)<\/script>/);
  if (!match || !match[1]) return null;
  return JSON.parse(match[1]);
}

Deno.test("SPECULATION_RULES: definition is valid JSON adhering to WICG document rules (audio-feed-nvj)", () => {
  const rules = extractSpeculationRules(SPECULATION_RULES) as {
    prefetch?: Array<{
      source?: string;
      where?: {
        and?: Array<{
          href_matches?: string;
          not?: { href_matches?: string; selector_matches?: string };
        }>;
      };
      eagerness?: string;
    }>;
  };
  assert(rules !== null, "SPECULATION_RULES must parse as valid JSON");
  assert(Array.isArray(rules.prefetch), "must contain prefetch array");
  assertEquals(rules.prefetch[0]?.source, "document");
  assertEquals(rules.prefetch[0]?.eagerness, "moderate");

  const andRules = rules.prefetch[0]?.where?.and ?? [];
  const excludedHrefs = andRules
    .map((r) => r.not?.href_matches)
    .filter(Boolean);

  assert(excludedHrefs.includes("/api/*"), "must exclude /api/* mutations");
  assert(excludedHrefs.includes("/admin*"), "must exclude /admin*");
  assert(excludedHrefs.includes("/logout*"), "must exclude /logout*");
});

Deno.test("pages render speculation rules on public and user surfaces (audio-feed-nvj)", async () => {
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const rawUser = await createUser(stores.metadata, {
    email: "user@example.com",
    displayName: "Listener",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);
  const cookie = `__Host-af_session=${session}`;

  // 1. Homepage (/)
  const homeRes = await fetch(new Request(BASE));
  assertEquals(homeRes.status, 200);
  const homeHtml = await homeRes.text();
  assertStringIncludes(homeHtml, '<script type="speculationrules">');
  assert(extractSpeculationRules(homeHtml) !== null);

  // 2. Login (/login)
  const loginRes = await fetch(new Request(`${BASE}/login`));
  assertEquals(loginRes.status, 200);
  const loginHtml = await loginRes.text();
  assertStringIncludes(loginHtml, '<script type="speculationrules">');

  // 3. Account (/account)
  const accountRes = await fetch(
    new Request(`${BASE}/account`, { headers: { cookie } }),
  );
  assertEquals(accountRes.status, 200);
  const accountHtml = await accountRes.text();
  assertStringIncludes(accountHtml, '<script type="speculationrules">');

  // 4. Web player landing (/listen)
  const listenLandingRes = await fetch(new Request(`${BASE}/listen`));
  assertEquals(listenLandingRes.status, 200);
  const listenLandingHtml = await listenLandingRes.text();
  assertStringIncludes(listenLandingHtml, '<script type="speculationrules">');

  // 5. User web player app (/listen/:token)
  const playerRes = await fetch(new Request(`${BASE}/listen/${user.feedToken}`));
  assertEquals(playerRes.status, 200);
  const playerHtml = await playerRes.text();
  assertStringIncludes(playerHtml, '<script type="speculationrules">');
  assert(extractSpeculationRules(playerHtml) !== null);
});

Deno.test("admin console strictly excludes speculation rules to protect isolation (audio-feed-nvj)", async () => {
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const rawAdmin = await createUser(stores.metadata, {
    email: "admin@example.com",
    displayName: "Admin",
    isAdmin: true,
  });
  const admin = await approveUser(stores.metadata, rawAdmin.id, "admin");
  const session = await createSession(stores.metadata, admin.id);

  const res = await fetch(
    new Request(`${BASE}/admin`, { headers: { cookie: `__Host-af_session=${session}` } }),
  );
  assertEquals(res.status, 200);
  const html = await res.text();

  // Admin page must NOT contain speculationrules
  assertEquals(html.includes('type="speculationrules"'), false);
  assertEquals(extractSpeculationRules(html), null);

  // Admin script block remains unambiguous (exactly 1 script block)
  const { document } = parseHTML(html);
  const scripts = document.querySelectorAll("script");
  assertEquals(scripts.length, 1, "admin page must retain exactly one script element");
});
