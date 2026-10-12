# Browser Acceptance Proof: audio-feed-xw7

- Script: scripts/bootstrap-refusal-browser-proof.ts
- Asserts: #bootstrap fragment auto-opens Admin bootstrap details; existing account bootstrap is refused with 409 error message; page stays on login, no redirect occurs; existing pending account bootstrap is also refused with 409; new admin bootstrap completes passkey registration and redirects to /admin; admin console is signed in as new bootstrap admin

## Feature
Admin bootstrap refusal for existing accounts: POST /api/auth/bootstrap refuses any email address that already belongs to an existing account with HTTP 409 Conflict.

## Execution Log
```
PASS  #bootstrap fragment auto-opens Admin bootstrap details  accordion is open
PASS  existing account bootstrap is refused with 409 error message  An account already exists for this email. Bootstrap cannot re-enroll or promote existing accounts.
PASS  page stays on login, no redirect occurs  still on /login
PASS  existing pending account bootstrap is also refused with 409  An account already exists for this email. Bootstrap cannot re-enroll or promote existing accounts.
PASS  new admin bootstrap completes passkey registration and redirects to /admin  landed on /admin
PASS  admin console is signed in as new bootstrap admin  signed in header: freshadmin
```

## Evidence Artifacts
- 01-existing-account-refusal.png: Inline refusal feedback
- 02-new-admin-bootstrap-success.png: Successful redirect to /admin
