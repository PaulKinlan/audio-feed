# Request Access Front Door Verification Report: audio-feed-r97

## Verified Criteria
1. **Public Front Door Onboarding**: Prospective subscribers can submit email + optional display name via `#request-access-form` on `/`.
2. **Pending Queue Integration**: The applicant is placed in the admin pending approval queue with `status: "pending"` without operator intervention.
3. **Honest Messaging & Zero Leaks**: Response states the wait honestly ("An administrator will review your account") and does NOT expose feed tokens or unapproved player URLs.
4. **Spend Gate Authority**: Pending tokens are strictly forbidden from triggering synthesis (`POST /api/ingest` -> 403), loading the web player (`GET /listen/:token` -> 403), or fetching RSS feeds (`GET /feed/:token/master.xml` -> 403).
5. **Approval Unlocks Full Experience**: Upon administrator approval, the exact same token unlocks the web player (200), master RSS feed (200), and article ingestion (202).
6. **Abuse Posture & Rate Limiting**: The public unauthenticated endpoint `POST /api/request-access` enforces a sliding-window rate limit per client IP (returning 429 + `Retry-After`) and deduplicates existing emails without row duplication.
7. **Responsive UI**: Verified on desktop (1280x900) and mobile (390x844) with zero horizontal overflow.

## Execution Log
```
PASS  front door has request access section  header: 'Request access'
PASS  subscribing copy links down to request access form  anchor present
PASS  response acknowledges submission honestly  msg: 'Access request received. An administrator will review your request before audio generation is enabled.Nothing generates until an administrator approves your account.'
PASS  response does NOT leak capability URL to unapproved applicant  no token or URL exposed
PASS  user lands in metadata store as pending  status: 'pending'
PASS  pending user cannot ingest (403 forbidden)  status: 403
PASS  pending user cannot access player (403 forbidden)  status: 403
PASS  pending user cannot access feed (403 forbidden)  status: 403
PASS  mobile front door has zero horizontal overflow at 390px  no horizontal scroll
PASS  approved user accesses player (200 OK)  status: 200
PASS  approved user accesses master feed (200 OK)  status: 200
PASS  approved user can ingest (202 Queued)  status: 202
```

## Screenshots
- `01-request-access-desktop.png`: Front door with request access section (1280x900).
- `02-request-access-submitted-desktop.png`: Submitted state showing honest wait message without capability URL (1280x900).
- `03-request-access-mobile-390.png`: Mobile front door with zero overflow (390x844).
- `04-request-access-submitted-mobile.png`: Mobile submitted confirmation state (390x844).
- `05-approved-player-unlocked.png`: Approved player unlocked with subscriber token (390x844).
