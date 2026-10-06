# Browser Acceptance Proof: audio-feed-xw7

## Feature
Admin bootstrap refusal for existing accounts: POST /api/auth/bootstrap refuses any email address that already belongs to an existing account (approved, pending, or suspended) with HTTP 409 Conflict and an explicit refusal message.

## Paul's Ruling (2026-10-06)
> REFUSE. An account that already exists must NOT be re-bootstrapped — do not silently promote/reinstate/approve it. Bootstrap now returns an explicit refusal for existing accounts (409), and a code comment states the rule so it cannot silently regress. Rationale to be recorded in the response and the code comment.

## Rationale
- Bootstrap is strictly intended for enrolling the initial administrator passkey when setting up the server.
- Silently promoting or reinstating an existing account (e.g. pending subscriber or suspended account) upon bootstrap request with `ADMIN_TOKEN` bypasses the explicit admin console role and approval workflow.
- It also risks accidental account takeover or unintended privilege escalation if an operator mistypes an email address corresponding to an existing user.
- Existing accounts must be managed through standard admin console role and setup-link actions, or sign in normally.

## Workflow Verified via Headless Chrome & CDP Virtual Authenticator
1. **Existing Approved Reader**: Submitting valid `ADMIN_TOKEN` with `rita@example.com` (existing approved non-admin) immediately fails with HTTP 409 and displays inline feedback: `An account already exists for this email. Bootstrap cannot re-enroll or promote existing accounts.`. The browser remains on `/login#bootstrap` and no passkey ceremony is initiated.
2. **Existing Pending Reader**: Submitting valid `ADMIN_TOKEN` with `sam@example.com` (existing pending non-admin) is similarly refused with HTTP 409 and inline feedback; the user remains pending and is not promoted or approved.
3. **New Admin Bootstrap**: Submitting valid `ADMIN_TOKEN` with `freshadmin@example.com` (a new address) succeeds, triggers WebAuthn passkey registration, sets session cookie, redirects to `/admin`, and signs in as the new admin.

## Evidence Artifacts
- `01-existing-account-refusal.png`: Screenshot showing inline refusal feedback on `/login#bootstrap` when attempting to bootstrap an existing account (`rita@example.com`).
- `02-new-admin-bootstrap-success.png`: Screenshot showing successful redirect to `/admin` for a brand new administrator (`freshadmin`).
- Browser proof script: `scripts/bootstrap-refusal-browser-proof.ts`.
- Unit / integration test: `tests/auth_routes_test.ts` (`admin bootstrap: existing user is refused with 409 and not promoted (audio-feed-xw7)` and `admin bootstrap: existing approved, suspended, or admin users are also refused with 409 (audio-feed-xw7)`).
