# Browser Acceptance Proof: Cross-Origin CSP Playback (audio-feed-zwqrx)

- Script: scripts/playback-csp-browser-proof.ts
- Asserts: precondition: /listen's media-src names the blob store's cross-origin direct-URL origin; precondition: a no-cors player request for the enclosure 302s to the store origin; the browser followed the 302 to the cross-origin store origin (the media server was asked); the media element raised no error (audio.error is null, no error event); zero CSP refusals for media-src (no securitypolicyviolation, no security console entry); the audio element reached a PLAYING state: currentTime advanced and readyState >= 2
- Timeout: 120s

## Verified Criteria
1. **CSP media-src configuration**: /listen Content-Security-Policy header includes the blob store's cross-origin direct-URL origin.
2. **Redirect on playback**: No-cors player request to /audio/<key> returns 302 redirect to the cross-origin store origin.
3. **Browser redirect handling**: Real headless Chrome follows the redirect to the secondary origin.
4. **Media element stability**: Audio element raises zero errors (`audio.error === null` and no `error` event).
5. **Zero CSP violations**: No `securitypolicyviolation` events for `media-src` and no security console errors.
6. **Playback progress**: Real audio playback advances `currentTime` by > 0.25s with `readyState >= 2`.
