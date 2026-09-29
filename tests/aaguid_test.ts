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
      iconKeyword: "#0078D4",
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

Deno.test("aaguid: Google provider renders canonical cubic Bézier G logo (audio-feed-vgn, audio-feed-6wk)", () => {
  const res = resolvePasskeyProvider("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4");
  assertEquals(res.name, "Google Password Manager");
  // Asserts all four exact canonical cubic Bézier path segments and brand fills (audio-feed-6wk)
  assertStringIncludes(
    res.iconSvg,
    'd="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"',
  );
  assertStringIncludes(res.iconSvg, 'fill="#4285F4"');
  assertStringIncludes(
    res.iconSvg,
    'd="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"',
  );
  assertStringIncludes(res.iconSvg, 'fill="#34A853"');
  assertStringIncludes(
    res.iconSvg,
    'd="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"',
  );
  assertStringIncludes(res.iconSvg, 'fill="#FBBC05"');
  assertStringIncludes(
    res.iconSvg,
    'd="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"',
  );
  assertStringIncludes(res.iconSvg, 'fill="#EA4335"');
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
    assertStringIncludes(res.iconSvg, 'fill="currentColor"');
    assertStringIncludes(res.iconSvg, 'd="M7.5 12a4.5 4.5 0 1 1 0-9');
  }
});

Deno.test("aaguid: all provider SVGs use canonical official vector paths (audio-feed-f6r)", () => {
  // 1. Generic Passkey (official FIDO Alliance logo)
  const passkey = resolvePasskeyProvider(undefined);
  assertEquals(passkey.name, "Passkey");
  assertStringIncludes(passkey.iconSvg, 'd="M7.5 12a4.5 4.5 0 1 1 0-9');

  // 2. Windows Hello (official Microsoft 4-square grid)
  const windows = resolvePasskeyProvider("08987058-cadc-4b81-b6e1-30de50dcbe96");
  assertEquals(windows.name, "Windows Hello");
  assertStringIncludes(
    windows.iconSvg,
    'd="M2 2h9v9H2V2zm11 0h9v9h-9V2zM2 13h9v9H2v-9zm11 0h9v9h-9v-9z"',
  );
  assertStringIncludes(windows.iconSvg, 'fill="#0078D4"');

  // 3. 1Password (official keyhole badge)
  const onepassword = resolvePasskeyProvider("bada5566-a7aa-401f-bd96-45619a55120d");
  assertEquals(onepassword.name, "1Password");
  assertStringIncludes(onepassword.iconSvg, 'fill="#0A85EA"');
  assertStringIncludes(onepassword.iconSvg, 'd="M12 7a3 3 0 0 0-1.8 5.4V15');

  // 4. Bitwarden (official shield and cutout)
  const bitwarden = resolvePasskeyProvider("d548826e-79b4-db40-a3d8-11116f7e8349");
  assertEquals(bitwarden.name, "Bitwarden");
  assertStringIncludes(bitwarden.iconSvg, 'd="M12 2.5 4 5.7v6.6c0 5 3.4 9.7 8 10.7');
  assertStringIncludes(bitwarden.iconSvg, 'fill="#175DDC"');

  // 5. Dashlane (official D stripes)
  const dashlane = resolvePasskeyProvider("531126d6-e717-415c-9320-3d9aa6981239");
  assertEquals(dashlane.name, "Dashlane");
  assertStringIncludes(dashlane.iconSvg, 'd="M3 4h8.5C16.7 4 21 8.3 21 13.5');
  assertStringIncludes(dashlane.iconSvg, 'fill="#00A389"');

  // 6. Yubico (official key Y)
  const yubico = resolvePasskeyProvider("0a357157-9b18-4c8a-920e-d156e972b2f8");
  assertEquals(yubico.name, "YubiKey");
  assertStringIncludes(yubico.iconSvg, 'fill="#54BA37"');
  assertStringIncludes(
    yubico.iconSvg,
    'd="M8.5 7h2.2l2.3 4.5L15.3 7h2.2l-3.6 6.8V18h-2v-4.2L8.5 7z"',
  );

  // 7. Apple (canonical silhouette)
  const apple = resolvePasskeyProvider("fbfc3007-154e-4ecc-8c0b-6e020557d7bd");
  assertEquals(apple.name, "iCloud Keychain");
  assertStringIncludes(apple.iconSvg, 'd="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47');
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
