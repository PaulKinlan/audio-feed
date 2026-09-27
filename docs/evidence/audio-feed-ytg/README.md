# Browser Acceptance Proof: audio-feed-ytg

## Feature
Front door links to the web player:
- Links from homepage header navigation and hero copy directly to `/listen`.
- Replaces dead-end instructions on Pocket Casts / podcast apps with immediate browser web player access.
- Surfaces returning subscriber banner on the homepage if `audio-feed-token` is found in `localStorage`, offering one-click "Open your Web Player →" and pre-populating the ingest token field.
- Offers an immediate "Open in Web Player →" link in the success feedback after queuing an article or subscribing to a feed.
- Preserves capability security: public pages never interpolate or expose tokens in SSR; the link to `/listen/:token` is generated strictly client-side using the token the user just submitted or already has stored locally.

## Evidence Artifacts
- `01-home-player-link-desktop.png`: Desktop view of `/` showing the Web Player header nav link, hero player link, returning subscriber banner, and the "Open in Web Player →" action in the ingest success feedback.
- `02-home-player-link-mobile-390.png`: Mobile view at 390px showing responsive layout with zero horizontal overflow.
- Automated browser proof: `scripts/home-player-link-browser-proof.ts`.
