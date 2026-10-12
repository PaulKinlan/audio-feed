# Browser Acceptance Proof: audio-feed-8eh

- Script: scripts/bootstrap-browser-proof.ts
- Asserts: signed-out /admin links to bootstrap; #bootstrap fragment auto-opens Admin bootstrap
  details; invalid admin token shows error feedback; bootstrap completes passkey registration and
  redirects to /admin; admin console is signed in as new bootstrap admin

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

## Reproducibility (audio-feed-rxo1)

**THIS CAPTURE IS NOT BIT-REPRODUCIBLE, AND THAT IS DECLARED RATHER THAN HIDDEN.** The same proof
run at one commit produced **THREE DISTINCT IMAGES IN FOUR CAPTURES**, so the PNG below is a record
of a correct run rather than a fixture - a re-run whose pixels differ is EXPECTED and is not a
failure.

What IS deterministic is the part the proof exists for: the five assertions in the Execution Log
above. They are the check; the screenshot is the receipt. This row is the `spread-declared`
disposition in `docs/evidence/README.md`'s determinism table, and this paragraph is the declaration
that row requires - a reader who compares this PNG byte-for-byte against a fresh capture would
otherwise conclude, wrongly, that the proof had regressed.

## Evidence Artifacts

- 01-admin-bootstrap-success.png: Screenshot of /admin console showing the newly bootstrapped admin
  signed in.
