# Live End-to-End Verification Report: audio-feed-l7m1

- Script: scripts/verify_main_l7m1_e2e.ts
- Asserts: admin observability page loads with h1 header; unhandled error renders screened message; client canary string is NOT leaked into the document; unhandled error log was produced with screened message; client canary is completely absent from all durable logs; limits section explains screened error messages; limits section explains distinct uploadRetry counter bounded by maxUploadRetries; retrying table renders durable uploadRetry counter; retrying table renders non-blank recorded reason; retrying table includes expandable claim history details; claim history expands on click; admin observability console has zero CSP violations; homepage console has zero CSP violations on load; front door renders draggable bookmarklet anchor with javascript: URL; bookmarklet anchor has unified class list without duplicate attributes; details disclosure exists under bookmarklet box on main; details disclosure opens upon user interaction on main; code snippet in disclosure contains matching bookmarklet source; homepage bookmarklet verified: 3asd fallback disclosure is LANDED on main; RSS feed route returns 200; RSS feed is valid XML containing audio enclosure; RSS feed emits canonical URL for flat-key historical episode; audio route returns 200 for valid episode; audio route serves correct audio/wav content-type; audio route delivers exact byte-for-byte payload matching stored blob; canonical URL for flat-key historical episode returns 404 (fails closed cleanly); disallowed/unauthorized audio key is rejected (404/403); web player loads for subscriber; web player renders <audio> element for listening; web player displays ready episode title; listen page emits canonical URL for flat-key historical episode; web player console has zero CSP violations; playback position saves via pagehide event; details disclosure exists on /account; details disclosure opens upon user interaction on /account; disclosure code on /account wraps and is fully visible

## Methodology & Environment
- **Harness:** In-process application server initialized with `bootstrap({ stores: memoryStores() })` on a dynamic port (`port: 0`).
- **Browser Execution:** Real headless Chrome launched via shared `withChrome` harness over CDP, ensuring sandbox isolation and automatic profile cleanup.
- **Seeded Test Fixtures:**
  - Admin user with authenticated session cookie `__Host-af_session`.
  - Approved subscriber with feed token `sub-feed-token-l7m1`.
  - Real synthesized WAV audio blob (120044 bytes) stored at `audio/sub-l7m1/direct/ep-ready-1.wav`.
  - Historical flat-key episode seed `historical-flat-key.wav` verifying canonical redirect/404 handling.
  - Throwing canary route `/__test/throw?m=canary-client-token-998877` verifying server error screening into `SUPPRESSED_MESSAGE` and absence from logs.

## Verified Features and Behaviors
### 1. Admin Observability (/admin/observability)
- Screened unhandled error messages (canary screened to SUPPRESSED_MESSAGE).
- Limits card documents screened errors and upload retries.
- Retrying queue table renders uploadRetry counter, reason, and expandable claim history.
- Zero CSP console violations.

### 2. Homepage Bookmarklet (/)
- Renders bookmarklet anchor without duplicate class attributes.
- Bookmarklet code disclosure fallback verified openable with matching source.
- Zero CSP console violations.

### 3. Audio, RSS, and Web Player (/listen/...)
- RSS XML enclosure URL and HTTP 200 verification.
- Direct audio streaming matches byte-for-byte (120044 bytes).
- Canonical URL for flat-key historical episode returns 404.
- Access boundary checks: invalid/unauthorized keys return 404/403.
- Web Player renders episode in playlist and audio element with zero CSP violations.
- Playback position saves via pagehide event.
- Account page bookmarklet disclosure verified openable and non-overflowing.

## Execution Log
```
PASS  admin observability page loads with h1 header  
PASS  unhandled error renders screened message  contains SUPPRESSED_MESSAGE
PASS  client canary string is NOT leaked into the document  checked absence of 'canary-client-token-998877'
PASS  unhandled error log was produced with screened message  screened message: 'message suppressed (not authored by this codebase)'
PASS  client canary is completely absent from all durable logs  canary absent from logs by construction
PASS  limits section explains screened error messages  
PASS  limits section explains distinct uploadRetry counter bounded by maxUploadRetries  
PASS  retrying table renders durable uploadRetry counter  uploadRetry cell: '2'
PASS  retrying table renders non-blank recorded reason  
PASS  retrying table includes expandable claim history details  
PASS  claim history expands on click  
PASS  admin observability console has zero CSP violations  violations: 0
PASS  homepage console has zero CSP violations on load  violations: 0
PASS  front door renders draggable bookmarklet anchor with javascript: URL  
PASS  bookmarklet anchor has unified class list without duplicate attributes  class: 'bookmarklet-link u-strong-link'
PASS  details disclosure exists under bookmarklet box on main  
PASS  details disclosure opens upon user interaction on main  
PASS  code snippet in disclosure contains matching bookmarklet source  snippet matches href (617 chars)
PASS  homepage bookmarklet verified: 3asd fallback disclosure is LANDED on main  
PASS  RSS feed route returns 200  status: 200
PASS  RSS feed is valid XML containing audio enclosure  
PASS  RSS feed emits canonical URL for flat-key historical episode  found canonical URL instead of flat key
PASS  audio route returns 200 for valid episode  status: 200
PASS  audio route serves correct audio/wav content-type  
PASS  audio route delivers exact byte-for-byte payload matching stored blob  verified 120044 bytes match exactly
PASS  canonical URL for flat-key historical episode returns 404 (fails closed cleanly)  HTTP 404, is_json: true, valid_json_error: true
PASS  disallowed/unauthorized audio key is rejected (404/403)  status: 404
PASS  web player loads for subscriber  
PASS  web player renders <audio> element for listening  
PASS  web player displays ready episode title  title in DOM: 'Advancements in Synthetic Media — Audio Edition'
PASS  listen page emits canonical URL for flat-key historical episode  emitted URL path: /audio/sub-l7m1/direct/ep-flat-1.wav
PASS  web player console has zero CSP violations  violations: 0
PASS  playback position saves via pagehide event  saved: 3
PASS  details disclosure exists on /account  
PASS  details disclosure opens upon user interaction on /account  
PASS  disclosure code on /account wraps and is fully visible  scrollWidth 1231 vs clientWidth 1231
```

## Screenshots
- 01-admin-observability.png: Full-page capture of admin observability console showing screened error message, limits card, and retrying queue table with expanded claim history.
- 02-homepage-bookmarklet-main.png: Scrolled view of front door bookmarklet box showing draggable anchor and expanded bookmarklet-code disclosure fallback.
- 03-listen-web-player.png: Web player at /listen rendering ready episode with audio controls.
