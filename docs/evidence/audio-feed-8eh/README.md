# Browser Acceptance Proof: audio-feed-8eh

## Feature
Admin passkey bootstrap UI: enroll an admin passkey directly from a browser or mobile device using `ADMIN_TOKEN`, with no curl or terminal required.

## Workflow Verified via Headless Chrome & CDP Virtual Authenticator
1. **Discovery / Affordance**: A signed-out administrator visiting `/admin` sees the affordance:
   `Need to enroll with your admin token? Bootstrap passkey` pointing directly to `/login?next=%2Fadmin#bootstrap`.
2. **Deep-Link Fragment State**: Navigating with `#bootstrap` automatically expands the `<details class="more" id="bootstrapDetails">` accordion.
3. **Falsification**: Submitting an incorrect admin token returns 401 and displays readable inline error feedback (`Invalid admin token.`).
4. **Bootstrap & Passkey Enrollment**:
   - Submitting valid `ADMIN_TOKEN` and email calls `POST /api/auth/bootstrap`.
   - The endpoint validates the token timing-safe, ensures an approved admin record exists in storage, and issues a one-time single-use `setupToken`.
   - The browser automatically initiates WebAuthn passkey registration (`navigator.credentials.create`), posts to `/api/auth/register/verify`, establishes the admin session cookie, and navigates directly to `/admin`.
5. **Admin Access**: `/admin` console immediately renders subscriber management and operations data without manual token re-entry.

## Evidence Artifacts
- `01-admin-bootstrap-success.png`: Screenshot of `/admin` console showing the newly bootstrapped admin signed in.
- Test script: `scripts/bootstrap-browser-proof.ts`.
