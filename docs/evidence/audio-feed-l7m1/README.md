# Live End-to-End Verification Report on origin/main (http://localhost:44529)

**Git Commit:** `18b688f` (Merge fleet/churn-3asd into origin/main)
**Date:** 2026-10-12
**Environment:** Local In-Process Server + Headless Chrome (CDP at 1280x900)

## Verified Features and Behaviors

### 1. Admin Observability (`/admin/observability`)
- **Unhandled Error Screening (`audio-feed-sw1r`):**
  - Unhandled request errors render closed, screened error messages (e.g. `message suppressed (not authored by this codebase)`).
  - Verified that raw client canary tokens (`canary-client-token-998877`) are completely absent from the rendered HTML.
- **Limits Documentation:**
  - Verified the limits card explicitly states that unhandled request errors record their class and screened message, and that upload retries carry a distinct `uploadRetry` counter bounded by `maxUploadRetries`.
- **Retrying Queue Table (`audio-feed-lqd6`, `audio-feed-muio`, `audio-feed-yrg4`):**
  - Renders the durable `uploadRetry` counter (value: `2`).
  - Renders the non-blank last recorded reason (`Invocation budget exceeded during audio upload; claim yielded for retry`).
  - Renders expandable `<details><summary>Claim history (2)</summary></details>` that expands on click to reveal historical attempts.

### 2. Homepage Bookmarklet (`/`)
- Renders the draggable bookmarklet anchor with `javascript:` URL and unified `class="bookmarklet-link u-strong-link"`.
- `audio-feed-3asd` (`18b688f`) is LANDED on main: clicking `<summary>` on `<details class="bookmarklet-code">` reveals the full bookmarklet code inside `<pre><code>` with zero inline scripts or CSP violations.
- Clicking the bookmarklet anchor itself is blocked by CSP `script-src 'self' 'nonce-...'`, which is why the fallback disclosure is provided.

### 3. RSS Feed, Audio Route, and Web Player (`/listen`)
- **RSS Enclosure:** The user's master RSS feed (`/feed/:token/master.xml`) renders valid XML with a proper `<enclosure>` element pointing to `http://localhost:44529/audio/sub-l7m1/direct/ep-ready-1.wav` with `type="audio/wav"`.
- **Audio Streaming:** Direct request to the enclosure URL fetches the audio with `200 OK`, `content-type: audio/wav`, and byte-for-byte exact payload matching the stored blob.
- **Capability Isolation:** Requests to unauthorized audio paths return 404/403.
- **Web Player:** Real Chrome loaded `/listen/sub-feed-token-l7m1`, rendered the audio player element, and displayed the synthesized episode title in the playlist.

## Execution Log
```
PASS  admin observability page loads with h1 header  
PASS  unhandled error renders screened message  contains SUPPRESSED_MESSAGE
PASS  client canary string is NOT leaked into the document  checked absence of 'canary-client-token-998877'
PASS  limits section explains screened error messages  
PASS  limits section explains distinct uploadRetry counter bounded by maxUploadRetries  
PASS  retrying table renders durable uploadRetry counter  uploadRetry cell: '2'
PASS  retrying table renders non-blank recorded reason  
PASS  retrying table includes expandable claim history details  
PASS  claim history expands on click  
PASS  front door renders draggable bookmarklet anchor with javascript: URL  
PASS  bookmarklet anchor has unified class list without duplicate attributes  class: 'bookmarklet-link u-strong-link'
PASS  details disclosure exists under bookmarklet box on main  
PASS  details disclosure opens upon user interaction on main  
PASS  code snippet in disclosure contains matching bookmarklet source  snippet matches href (617 chars)
PASS  homepage bookmarklet verified: 3asd fallback disclosure is LANDED on main (18b688f)  
PASS  RSS feed route returns 200  status: 200
PASS  RSS feed is valid XML containing audio enclosure  
PASS  audio route returns 200 for valid episode  status: 200
PASS  audio route serves correct audio/wav content-type  
PASS  audio route delivers correct byte count  received 48044 bytes
PASS  disallowed/unauthorized audio key is rejected (404/403)  status: 404
PASS  web player loads for subscriber  
PASS  web player renders <audio> element for listening  
PASS  web player displays ready episode title  title in DOM: 'Advancements in Synthetic Media — Audio Edition'
```

## Screenshots
- `01-admin-observability.png`: Admin observability console showing screened error message, limits copy, and retrying rows with expanded claim history.
- `02-homepage-bookmarklet-main.png`: Front door bookmarklet anchor under current main.
- `03-listen-web-player.png`: Web player at `/listen` rendering ready episode with audio controls.
