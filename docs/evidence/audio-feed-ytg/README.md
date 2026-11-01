# Front door player links

- Script: scripts/home-player-link-browser-proof.ts
- Notes: Captures are 256-colour PNG8, quantised in place by the proof before the run record is
  sealed (audio-feed-s6w2q)
- Asserts: header navigation links to /listen; hero lede links to /listen; /listen landing page
  explains how to listen; returning subscriber banner is visible on /; no home-page form field is
  pre-filled with a feed token (privacy invariant); the session's own feed token is never pre-filled
  into a home form (privacy invariant); /listen with stored token restores directly to
  /listen/:token; submitting an article reports a queued success state (/account); mobile layout has
  zero horizontal overflow at 390px
