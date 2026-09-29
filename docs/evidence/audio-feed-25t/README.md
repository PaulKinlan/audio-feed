# Passkey Provider Icon and Name Verification: audio-feed-25t

## Implementation Overview
Implements WebAuthn AAGUID resolution per [web.dev/articles/passkey-management](https://web.dev/articles/passkey-management) and [web.dev/articles/webauthn-aaguid](https://web.dev/articles/webauthn-aaguid).
- Authenticator AAGUID is extracted during WebAuthn registration (`verification.registrationInfo.aaguid`) and persisted on `PasskeyCredential.aaguid`.
- `src/auth/aaguid.ts` maps known AAGUIDs across Google Password Manager, Apple iCloud Keychain, Windows Hello, 1Password, Bitwarden, Dashlane, and YubiKey to brand names and inline SVG icons.
- If AAGUID is empty, unknown, or all-zeroes, it falls back to a clean generic Passkey icon.
- `/account` UI displays the provider logo SVG and provider name alongside the passkey creation date, last used date, and user label.

## Verification Results
```
PASS  renders Google Password Manager with label  Google Password Manager present
PASS  renders iCloud Keychain with label  iCloud Keychain present
PASS  renders generic Passkey fallback for unknown AAGUID  Passkey fallback present
PASS  every passkey row renders an inline SVG provider icon  found 3 SVGs
PASS  mobile passkey list has zero horizontal overflow  no horizontal scroll at 390px
```

## Screenshots
- `01-account-passkey-providers-desktop.png`: Desktop view of /account showing Google Password Manager, iCloud Keychain, and Passkey icons.
- `02-account-passkey-providers-mobile-390.png`: Mobile view showing responsive passkey list without overflow.
