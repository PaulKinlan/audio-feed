# Evidence for audio-feed-dfbu & bfcache lifecycle (audio-feed-sxlt)

- Script: scripts/verify_dfbu_pagehide_browser.ts
- Asserts: visibilitychange (hidden) saved position 35s to localStorage; real navigation away fires pagehide with persisted=true and saves position 42s to localStorage; history.back() restores page from bfcache with pageshow persisted=true; row displays 'Resume from 0:42' badge; window.onbeforeunload is not set

## Overview
Replaces the deprecated and bfcache-ineligible `beforeunload` listener with `pagehide` and `visibilitychange` (handling `visibilityState === "hidden"`) for playback position saving in `src/assets/listen.js`. Drives real browser navigation away and back to prove bfcache eligibility (`persisted === true`) and position persistence.

## Verification
1. **Automated Unit Test (`tests/playback_position_test.ts`)**:
   - Asserts client script registers `pagehide` and `visibilitychange` listeners.
   - Asserts client script does NOT register any `beforeunload` listener.
2. **Headless Chrome Browser Proof (`scripts/verify_dfbu_pagehide_browser.ts`)**:
   - Drives real headless Chrome over CDP against `scripts/listen-harness.ts`.
   - Starts playback, simulates tab backgrounding via `visibilitychange` (`document.visibilityState === "hidden"`), asserts position is stored to scoped `localStorage`.
   - Advances playback, navigates away to `about:blank` (real browser navigation), asserts `pagehide` fires with `persisted: true` and saves updated position to `localStorage`.
   - Navigates back via `history.back()`, asserts `pageshow` fires with `persisted: true` (restored from bfcache), preserving in-memory state.
   - Reloads page, asserts row displays "Resume from 0:42" badge and button is wired to resume.
   - Asserts `window.onbeforeunload` is not set.
   - Captures screenshot: `01-pagehide-visibilitychange-resume.png`.
