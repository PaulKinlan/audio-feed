/**
 * Tests for WebAuthn AAGUID passkey provider resolution (audio-feed-25t).
 *
 * Verifies:
 * - Known provider AAGUIDs map to human-friendly provider names and inline SVG icons
 * - Case insensitivity and whitespace trimming
 * - Absent, null, empty, unknown, and all-zeroes AAGUIDs map cleanly to fallback Passkey icon
 * - /account page renders the provider icon, provider name, and passkey label
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolvePasskeyProvider } from "../src/auth/aaguid.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { makeUser } from "./fixtures.ts";

const BASE = "https://audio.example.com";

Deno.test("aaguid: maps known provider AAGUIDs to names and SVG icons", () => {
  const cases: Array<{ aaguid: string; expectedName: string; iconKeyword: string }> = [
    {
      aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
      expectedName: "Google Password Manager",
      iconKeyword: "#4285F4",
    },
    {
      aaguid: "ad59dadf-5dae-406a-a19e-953835f19062",
      expectedName: "Google Password Manager",
      iconKeyword: "#4285F4",
    },
    {
      aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
      expectedName: "iCloud Keychain",
      iconKeyword: "currentColor",
    },
    {
      aaguid: "08987058-cadc-4b81-b6e1-30de50dcbe96",
      expectedName: "Windows Hello",
      iconKeyword: "#00A4EF",
    },
    {
      aaguid: "bada5566-a7aa-401f-bd96-45619a55120d",
      expectedName: "1Password",
      iconKeyword: "#0A85EA",
    },
    {
      aaguid: "d548826e-79b4-db40-a3d8-11116f7e8349",
      expectedName: "Bitwarden",
      iconKeyword: "#175DDC",
    },
    {
      aaguid: "531126d6-e717-415c-9320-3d9aa6981239",
      expectedName: "Dashlane",
      iconKeyword: "#00A389",
    },
    {
      aaguid: "0a357157-9b18-4c8a-920e-d156e972b2f8",
      expectedName: "YubiKey",
      iconKeyword: "#54BA37",
    },
  ];

  for (const { aaguid, expectedName, iconKeyword } of cases) {
    const res = resolvePasskeyProvider(aaguid);
    assertEquals(res.name, expectedName, `AAGUID ${aaguid} must resolve to ${expectedName}`);
    assertStringIncludes(res.iconSvg, "<svg", "iconSvg must be valid SVG markup");
    assertStringIncludes(res.iconSvg, iconKeyword);
  }
});

Deno.test("aaguid: case-insensitive and trims whitespace", () => {
  const upper = "  EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4  ";
  const res = resolvePasskeyProvider(upper);
  assertEquals(res.name, "Google Password Manager");
});

Deno.test("aaguid: falls back cleanly for unknown, empty, or all-zeroes AAGUID", () => {
  const fallbacks = [
    undefined,
    null,
    "",
    "   ",
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "unknown-non-guid",
  ];

  for (const val of fallbacks) {
    const res = resolvePasskeyProvider(val);
    assertEquals(res.name, "Passkey");
    assertEquals(res.id, "generic");
    assertStringIncludes(res.iconSvg, "<svg");
    assertStringIncludes(res.iconSvg, 'stroke="currentColor"');
  }
});

Deno.test("aaguid: /account renders provider icon and provider name next to passkey", async () => {
  const stores: Stores = memoryStores();
  const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const user = makeUser({ id: "user-1", email: "paul@example.com", status: "approved" });
  await stores.metadata.putUser(user);

  // Seed two credentials: one with Google AAGUID, one unknown/fallback
  await stores.metadata.putCredential({
    id: "cred-google",
    userId: user.id,
    publicKey: "pk1",
    counter: 0,
    name: "Pixel 9",
    createdAt: "2026-09-26T00:00:00.000Z",
    aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
  });
  await stores.metadata.putCredential({
    id: "cred-generic",
    userId: user.id,
    publicKey: "pk2",
    counter: 0,
    name: "Hardware Key",
    createdAt: "2026-09-26T00:00:00.000Z",
    aaguid: "00000000-0000-0000-0000-000000000000",
  });

  const session = await createSession(stores.metadata, user.id);
  const res = await fetch(
    new Request(`${BASE}/account`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    }),
  );
  assertEquals(res.status, 200);
  const html = await res.text();

  // 1. Google Password Manager rendered
  assertStringIncludes(html, "Google Password Manager");
  assertStringIncludes(html, "Pixel 9");
  assertStringIncludes(html, "#4285F4"); // Google SVG color

  // 2. Generic Passkey fallback rendered
  assertStringIncludes(html, "Passkey");
  assertStringIncludes(html, "Hardware Key");
  assertStringIncludes(html, 'class="provider-icon"');
});
