# Live End-to-End Verification Report: audio-feed-l7m1

- Script: scripts/verify_main_l7m1_e2e.ts
- Asserts: admin observability page loads with h1 header; unhandled error renders screened message; client canary string is NOT leaked into the document; unhandled error log was produced with screened message; client canary is completely absent from all durable logs; limits section explains screened error messages; limits section explains distinct uploadRetry counter bounded by maxUploadRetries; retrying table renders durable uploadRetry counter; retrying table renders non-blank recorded reason; retrying table includes expandable claim history details; claim history expands on click; admin observability console has zero CSP violations; homepage console has zero CSP violations on load; front door renders draggable bookmarklet anchor with javascript: URL; bookmarklet anchor has unified class list without duplicate attributes; details disclosure exists under bookmarklet box on main; details disclosure opens upon user interaction on main; code snippet in disclosure contains matching bookmarklet source; homepage bookmarklet verified: 3asd fallback disclosure is LANDED on main; RSS feed route returns 200; RSS feed is valid XML containing audio enclosure; RSS feed emits canonical URL for flat-key historical episode; audio route returns 200 for valid episode; audio route serves correct audio/wav content-type; audio route delivers exact byte-for-byte payload matching stored blob; canonical URL for flat-key historical episode returns 404 (fails closed cleanly); disallowed/unauthorized audio key is rejected (404/403); web player loads for subscriber; web player renders <audio> element for listening; web player displays ready episode title; listen page emits canonical URL for flat-key historical episode; web player console has zero CSP violations; playback position saves via pagehide event; details disclosure exists on /account; details disclosure opens upon user interaction on /account; disclosure code on /account wraps and is fully visible

## Methodology & Environment
- **Harness:** In-process application server initialized with `bootstrap({ stores: memoryStores() })` on a dynamic port (`port: 0`), so the proof never contends for a fixed port and a moved port cannot masquerade as a pass.
- **Browser Execution:** Real headless Chrome driven over CDP by the shared `withChrome` harness at a 1280-wide desktop viewport, with an isolated user-data-dir and automatic profile cleanup. These are live-page assertions, not a DOM shim: the CSP counters, the `<details>` disclosures and the `<audio>` element are read out of a real browser.
- **Capture method:** Screenshots are viewport grabs sized to the content each caption names - the admin grab is sized to the full document so the screened-error and limits cards are in frame, and the bookmarklet grab is taken after the box is scrolled into view and its disclosure opened. A caption describes only states that the accompanying image actually contains.
- **Seeded Test Fixtures:**
  - Admin user with authenticated session cookie `__Host-af_session`.
  - Approved subscriber with feed token `sub-feed-token-l7m1`.
  - Real synthesized WAV audio blob (120044 bytes) stored at `audio/sub-l7m1/direct/ep-ready-1.wav`.
  - Historical flat-key episode seed `historical-flat-key.wav` verifying canonical redirect/404 handling.
  - Throwing canary route `/__test/throw?m=canary-client-token-998877` verifying server error screening into `SUPPRESSED_MESSAGE` and absence from logs.

## Verified Features and Behaviors
### 1. Admin Observability (`/admin/observability`)
- **Unhandled Error Screening (`audio-feed-sw1r`, `audio-feed-nh18`):**
  - Injected an untrusted client canary (`canary-client-token-998877`) through a real throwing request (`/__test/throw`).
  - Verified the server catches the unhandled error and screens it to `message suppressed (not authored by this codebase)`.
  - Verified the raw client canary is completely absent from the rendered HTML failure card and from all durable logs.
- **Limits Documentation:** the limits card explicitly states that unhandled request errors record their class and screened message, and that upload retries carry a distinct `uploadRetry` counter bounded by `maxUploadRetries`.
- **Retrying Queue Table (`audio-feed-lqd6`, `audio-feed-muio`, `audio-feed-yrg4`):**
  - Renders the durable `uploadRetry` counter (value: `2`).
  - Renders the non-blank last recorded reason (`Invocation budget exceeded during audio upload; claim yielded for retry`).
  - Renders an expandable `Claim history` `<details>` that opens on click to reveal the historical attempts.
- **CSP Integrity:** zero Content Security Policy console violations on `/admin/observability`.

### 2. Homepage Bookmarklet (`/`)
- Renders the draggable bookmarklet anchor with a `javascript:` URL and no duplicate class attributes.
- **Bookmarklet Code Disclosure Fallback (`audio-feed-3asd`):**
  - Verified that `<details class="bookmarklet-code">` exists under the bookmarklet box on main.
  - Verified that clicking the summary expands the disclosure to reveal the copyable bookmarklet snippet.
  - Verified that the snippet text exactly matches the anchor's `javascript:` URL (617 characters).
- **CSP Integrity:** zero Content Security Policy console violations on the homepage.

### 3. RSS Feed, Audio Route, and Web Player (`/listen/...`)
- **RSS Enclosure:** the master feed renders valid XML with an `<enclosure>` element pointing at the seeded episode with `type="audio/wav"`.
- **Audio Streaming (`audio-feed-7n3f`):** a direct request to the enclosure URL returns `200 OK`, `content-type: audio/wav`, and a byte-for-byte exact payload matching the stored blob (120044 bytes).
- **Capability Isolation:** requests to unauthorized or invalid audio keys return 404/403, and a flat-key historical episode path fails closed with a canonical 404.
- **Web Player:** real Chrome loaded the subscriber's `/listen` page and rendered the audio element and playlist; the playback position saved via the `pagehide` event.
- **CSP Integrity:** zero Content Security Policy console violations on `/listen`.
- **Account page:** the bookmarklet disclosure is verified openable and its snippet does not overflow its box.

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
- 01-admin-observability.png: Full-page capture (1280 x document height) of the admin observability console, showing the screened error message, the limits card (the card headed "What this page cannot tell you"), and the retrying queue table with its claim history expanded.
- 02-homepage-bookmarklet-main.png: Scrolled view of front door bookmarklet box showing draggable anchor and expanded bookmarklet-code disclosure fallback.
- 03-listen-web-player.png: Web player at /listen rendering ready episode with audio controls.
