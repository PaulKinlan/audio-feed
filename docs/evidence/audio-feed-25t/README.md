# Passkey Provider Icon and Name Verification: audio-feed-25t

- Script: scripts/passkey-provider-browser-proof.ts
- Asserts: renders Google Password Manager with label; renders iCloud Keychain with label; renders generic Passkey fallback for unknown AAGUID; every passkey row renders an inline SVG provider icon; passkeys card is scrolled into view on desktop; mobile passkey list has zero horizontal overflow; passkeys card is scrolled into view on mobile

## Implementation Overview
Implements WebAuthn AAGUID resolution per [web.dev/articles/passkey-management](https://web.dev/articles/passkey-management) and [web.dev/articles/webauthn-aaguid](https://web.dev/articles/webauthn-aaguid).
- Authenticator AAGUID is extracted during WebAuthn registration (`verification.registrationInfo.aaguid`) and persisted on `PasskeyCredential.aaguid`.
- `src/auth/aaguid.ts` maps known AAGUIDs across Google Password Manager, Apple iCloud Keychain, Windows Hello, 1Password, Bitwarden, Dashlane, and YubiKey to brand names and inline SVG icons.
- If AAGUID is empty, unknown, or all-zeroes, it falls back to a clean generic Passkey icon.
- `/account` UI displays the provider logo SVG and provider name alongside the passkey creation date, last used date, and user label.

## Screenshots
- `01-account-passkey-providers-desktop.png`: Desktop view of /account showing Google Password Manager, iCloud Keychain, and Passkey icons.
- `02-account-passkey-providers-mobile-390.png`: Mobile view showing responsive passkey list without overflow.
