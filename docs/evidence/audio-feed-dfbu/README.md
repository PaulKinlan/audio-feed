# Evidence for audio-feed-dfbu

## Overview
Removes `beforeunload` listener for playback position saving in `src/assets/listen.js` and replaces it with `pagehide` and `visibilitychange` (handling `visibilityState === "hidden"`).

## Verification
1. **Automated Unit Test (`tests/playback_position_test.ts`)**:
   - Asserts client script registers `pagehide` and `visibilitychange` listeners.
   - Asserts client script does NOT register any `beforeunload` listener.
2. **Headless Chrome Browser Proof (`scripts/verify_dfbu_pagehide_browser.ts`)**:
   - Drives real headless Chrome over CDP against `scripts/listen-harness.ts`.
   - Starts playback, simulates tab backgrounding via `visibilitychange` (`document.visibilityState === "hidden"`), asserts position is stored to scoped `localStorage`.
   - Advances playback, triggers `pagehide`, asserts updated position is stored.
   - Reloads page, asserts row displays "Resume from 0:42" badge and button is wired to resume.
   - Asserts `window.onbeforeunload` is not set and no `beforeunload` listener is active.
   - Captures screenshot: `01-pagehide-visibilitychange-resume.png`.
