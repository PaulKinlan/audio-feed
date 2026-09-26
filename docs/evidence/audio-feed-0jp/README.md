# Browser Acceptance Proof: audio-feed-0jp

## Goal
Delete the paste-token UI path from the admin console script (`#adminToken`, `#saveToken`, `#rememberToken`, `#authFeedback`, `<details class="token-toggle">`), point the console at the passkey sign-in flow instead, and verify through real headless Chrome that:
1. When signed out, the token-paste controls and toggles are completely gone, and the page offers a clear passkey sign-in action (`/login?next=%2Fadmin`).
2. When signed in with an admin session, the console automatically loads subscriber data, operations statistics, and background runs with zero token input or header required.

## Evidence Artifacts
- `03-admin-signed-out-1280-dark.png` / `03-admin-signed-out-1280-light.png`: Desktop view of signed-out `/admin` showing the clean passkey sign-in card and absence of token paste inputs.
- `03-admin-signed-out-390-dark.png` / `03-admin-signed-out-390-light.png`: Mobile view of signed-out `/admin`.
- `07-admin-1280-dark.png` / `07-admin-1280-light.png`: Desktop view of signed-in `/admin` loaded via session cookie auth with 3 subscribers and operations stats.
- `07-admin-390-dark.png` / `07-admin-390-light.png`: Mobile view of signed-in `/admin`.

## Automated Test Run
Executed via `scripts/account-browser-proof.ts` (CDP virtual authenticator + headless Chrome):
- `PASS signed-out /admin offers sign-in with token controls removed (audio-feed-0jp)`
- `PASS admin reaches /admin`
- `PASS admin console loads subscriber data on session with token controls removed (audio-feed-0jp)`
