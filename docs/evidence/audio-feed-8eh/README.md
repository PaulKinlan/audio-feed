# Browser Acceptance Proof: audio-feed-8eh

- Script: scripts/bootstrap-browser-proof.ts
- Asserts: signed-out /admin links to bootstrap; #bootstrap fragment auto-opens Admin bootstrap details; invalid admin token shows error feedback; bootstrap completes passkey registration and redirects to /admin; admin console is signed in as new bootstrap admin

## Feature
Admin passkey bootstrap UI: enroll an admin passkey directly from a browser using ADMIN_TOKEN.

## Execution Log
```
PASS  signed-out /admin links to bootstrap  found link to /login?next=%2Fadmin#bootstrap
PASS  #bootstrap fragment auto-opens Admin bootstrap details  accordion is open
PASS  invalid admin token shows error feedback  Invalid admin token.
PASS  bootstrap completes passkey registration and redirects to /admin  landed on /admin
PASS  admin console is signed in as new bootstrap admin  signed in header: bootadmin
```

## Evidence Artifacts
- 01-admin-bootstrap-success.png: Screenshot of /admin console showing the newly bootstrapped admin signed in.
