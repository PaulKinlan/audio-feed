# THREAT_MODEL.md

Documented security decisions live here so a reviewer does not have to rediscover the reasoning from
diffs. This file is a seed: the software factory's threat-model station owns growing it into the
full model; entries below are decisions that were made and reviewed on specific beads, not an
exhaustive analysis.

## CSP report endpoint (`/api/reports/csp`) — origin policy

- **Decision** (audio-feed-cspreports; review delta ruled by coord, 2026-10-29): reports arriving
  with an UNTRUSTED or ABSENT `Origin` header are accepted with **204** — so the browser flushes and
  does not retry — but are **never stored** and **never consume** the visitor's per-window write
  budget (`reports:budget:*`), and are not attributed to the visitor.
  - Trusted means the origin host is in the configured allowlist or a loopback host
    (`src/origin.ts`, `isTrustedReportOrigin`); `Origin: null` and a missing header are untrusted.
  - The drop is narrated through the app's logger seam (`src/log.ts`, sink `appendLog`; record type
    `csp_report.origin_untrusted_dropped`), carrying the origin value or the literal `(absent)` in
    its reason, so "no CSP violations today" cannot silently mean "every report was discarded by the
    origin policy".
- **Residual (documented, accepted):** legacy WebKit engines that POST CSP reports without an
  `Origin` header are indistinguishable from the untrusted case and are dropped the same way — their
  violations are invisible by policy. Accepting them would require trusting origin-less requests on
  a cross-origin reporting endpoint, which is the surface this policy exists to close.

## Unauthenticated `/health` — deploy fingerprint and backend-kind disclosure

- **Decision** (audio-feed-1552, audio-feed-ciia; fallback behaviour on audio-feed-j9j1; section recorded on audio-feed-vaw6n): the
  unauthenticated `/health` route (`src/app.ts`) deliberately returns, to any caller without a
  token or session: the storage backend KIND (`ctx.stores.describe`, e.g. `blobs=s3`), the deploy
  id and its source, and the exact source commit SHA (`deploy.commit`).
- **Why accepted:** production has no other observable identity — every other surface is token- or
  session-gated — so this disclosure is what lets a landing be verified against the live deployment
  ("which revision is actually running?") without Deno Deploy API tokens.
- **Residual (documented, accepted):** the endpoint is an unauthenticated reconnaissance signal: it
  names the storage backend and pins the running revision, which tells an attacker exactly which
  version's bug classes to try. That is judged low-sensitivity operational metadata, not a secret.
- **Scope note:** an earlier revision leaked the blob-store BUCKET NAME through the same route;
  that leak is fixed and `Stores.describe` deliberately publishes the backend kind only
  (audio-feed-tra9d).

## Offline audio cache — survives an update, not a sign-out (audio-feed-vnu4g)

- **Decision:** the offline audio cache (`audio-feed-offline-v1`, written by the player and served
  cache-first by the service worker for `/audio/`) deliberately survives a service-worker update —
  "the subscriber's own downloaded library must survive an update". That is NOT "must survive
  sign-out". The worker now deletes the whole cache when the server confirms a DEVICE-initiated
  `POST /api/auth/logout` (either the no-script form, which 303s, or the JSON call) or a
  device-initiated `POST /api/account/rotate-token` passing through its fetch handler; a failed
  call changes nothing. Only device-initiated calls can purge: admin/remote token rotation and
  session expiry never contact the device, which keeps playing its downloaded library until it
  next connects. On `activate` the worker also sweeps superseded `audio-feed-shell-*` AND
  `audio-feed-offline-*` generations, so a future cache version bump cannot leave the old
  generation installed forever.
- **Why purge by name instead of sweeping keys:** the audio URLs in this cache are public capability
  URLs (`/audio/<key>`; the key IS the capability) and carry no feed token, so there are no
  token-bearing keys to match — a key sweep would be a no-op with extra reads. The navigation cache
  never stores token-bearing paths in the first place (`/listen/`, `/feed/` are excluded,
  audio-feed-s3f0).
- **Residual (documented, accepted):** admin suspension stops a subscriber's feed server-side but
  cannot reach a device to purge it — the device is never contacted — so a suspended account's
  already-downloaded episodes stay on disk until sign-out. Admin token rotation
  (`POST /api/admin/users/:id/rotate-token`, which rotates another subscriber's feed token
  remotely) has the same shape: the stale feed fails on the device's next refresh, but the
  already-downloaded episodes stay on disk and keep playing there until it next connects. Separately, the cache has no size bound:
  a device that downloads every episode grows without limit until sign-out (nightly audit
  2026-11-05); an app-driven write-time eviction is the follow-up mechanism if that bites.
