/**
 * WebAuthn AAGUID resolution for passkey providers (audio-feed-25t).
 *
 * Implements guidance from:
 *   - https://web.dev/articles/webauthn-aaguid
 *   - https://web.dev/articles/passkey-management
 *   - https://github.com/passkeydeveloper/passkey-authenticator-aaguids
 *
 * Resolves an AAGUID string to a human-friendly provider name and an inline SVG icon.
 * Falls back safely to a generic Passkey icon when AAGUID is absent, unknown, or all-zeroes.
 */

export interface PasskeyProvider {
  id: string;
  name: string;
  iconSvg: string;
}

// ── Provider Icons ──────────────────────────────────────────────────────────

const SVG_PASSKEY =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`;

const SVG_GOOGLE =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`;

const SVG_APPLE =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.38c.62-.75 1.04-1.8 0.92-2.85-.9.04-1.98.6-2.62 1.35-.56.65-.96 1.7-0.83 2.72.99.08 2.01-.5 2.53-1.22z"/></svg>`;

const SVG_WINDOWS =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#00A4EF"><path d="M0 3.449L9.75 2.1v9.451H0V3.449zm10.749-1.5L24 0v11.55h-13.251V1.949zM0 12.45h9.75v9.45L0 20.551V12.45zm10.749 0H24V24l-13.251-1.95v-9.6z"/></svg>`;

const SVG_1PASSWORD =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#0A85EA"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6" fill="#fff"/><circle cx="12" cy="12" r="3" fill="#0A85EA"/><path d="M12 6a6 6 0 0 0-1.8.27l1.8 2.73 1.8-2.73A6 6 0 0 0 12 6z" fill="#0A85EA"/></svg>`;

const SVG_BITWARDEN =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#175DDC"><path d="M12 2L4 5v6.5C4 16.5 7.4 21.1 12 22c4.6-.9 8-5.5 8-10.5V5l-8-3zm0 2.2l6 2.3v5c0 3.9-2.7 7.7-6 8.5-3.3-.8-6-4.6-6-8.5v-5l6-2.3zm-1 4.8v6h2V9h-2z"/></svg>`;

const SVG_DASHLANE =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#0E353D"><path d="M12 2L2 7v7c0 5.5 4.3 10.7 10 12 5.7-1.3 10-6.5 10-12V7l-10-5zm-1 14h2v2h-2v-2zm0-8h2v6h-2V8z" fill="#00A389"/></svg>`;

const SVG_YUBICO =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#54BA37"><circle cx="12" cy="12" r="10"/><path d="M8 8l3 5.5V17h2v-3.5L16 8h-2.3l-1.7 3.5L10.3 8H8z" fill="#fff"/></svg>`;

// ── Known Providers ─────────────────────────────────────────────────────────

const FALLBACK_PROVIDER: PasskeyProvider = {
  id: "generic",
  name: "Passkey",
  iconSvg: SVG_PASSKEY,
};

const PROVIDERS: Record<string, PasskeyProvider> = {
  google: {
    id: "google",
    name: "Google Password Manager",
    iconSvg: SVG_GOOGLE,
  },
  apple: {
    id: "apple",
    name: "iCloud Keychain",
    iconSvg: SVG_APPLE,
  },
  windows: {
    id: "windows",
    name: "Windows Hello",
    iconSvg: SVG_WINDOWS,
  },
  onepassword: {
    id: "1password",
    name: "1Password",
    iconSvg: SVG_1PASSWORD,
  },
  bitwarden: {
    id: "bitwarden",
    name: "Bitwarden",
    iconSvg: SVG_BITWARDEN,
  },
  dashlane: {
    id: "dashlane",
    name: "Dashlane",
    iconSvg: SVG_DASHLANE,
  },
  yubico: {
    id: "yubico",
    name: "YubiKey",
    iconSvg: SVG_YUBICO,
  },
  generic: FALLBACK_PROVIDER,
};

// ── AAGUID Map (normalized to lowercase UUID) ───────────────────────────────

const AAGUID_MAP: Record<string, keyof typeof PROVIDERS> = {
  // Google Password Manager
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "google",
  "ad59dadf-5dae-406a-a19e-953835f19062": "google",

  // Apple iCloud Keychain
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "apple",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "apple",
  "dd483622-9271-4475-a83d-3a322c34c1b9": "apple",

  // Windows Hello
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "windows",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "windows",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "windows",
  "08987058-cadc-4b81-b6e3-ac588c8e4e82": "windows",
  "6028b017-b1d4-4c02-b4b3-afdafc96e071": "windows",

  // 1Password
  "bada5566-a7aa-401f-bd96-45619a55120d": "onepassword",
  "b5397666-4885-aa6b-cebf-e52262a439a2": "onepassword",

  // Bitwarden
  "d548826e-79b4-db40-a3d8-11116f7e8349": "bitwarden",
  "6995642a-8c88-466d-a6aa-a82f05166416": "bitwarden",

  // Dashlane
  "531126d6-e717-415c-9320-3d9aa6981239": "dashlane",
  "32924190-271d-4467-932d-209930f305cf": "dashlane",

  // YubiKey / Yubico
  "0a357157-9b18-4c8a-920e-d156e972b2f8": "yubico",
  "03012cb7-4fb2-42e7-9e8d-a81f10e2a5e9": "yubico",
  "0bb43545-fd2c-4185-87dd-feb0b2916ace": "yubico",
  "ee882879-721c-4916-ad4e-57ec7f648f34": "yubico",
  "fa2b99dc-9e39-4257-8f92-4a30d23c4118": "yubico",
  "2fc0579f-8113-47ea-b116-e802db534b14": "yubico",
  "b92d64a2-1130-410a-9d93-3d0cf5513d8d": "yubico",
};

/**
 * Resolve an AAGUID string to its provider metadata (name and SVG icon).
 *
 * If AAGUID is empty, missing, unknown, or all-zeroes (00000000-0000-0000-0000-000000000000),
 * returns the default Passkey icon and name "Passkey".
 */
export function resolvePasskeyProvider(aaguid?: string | null): PasskeyProvider {
  if (!aaguid) return FALLBACK_PROVIDER;
  const normalized = aaguid.trim().toLowerCase();
  if (normalized === "00000000-0000-0000-0000-000000000000" || !normalized) {
    return FALLBACK_PROVIDER;
  }
  const key = AAGUID_MAP[normalized];
  if (key && PROVIDERS[key]) {
    return PROVIDERS[key]!;
  }
  return FALLBACK_PROVIDER;
}
