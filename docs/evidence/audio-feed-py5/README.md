# Browser Acceptance Proof: audio-feed-py5

## Problem
`scripts/listen-harness.ts` was omitting `contentType` on its seeded episodes. Because `isPublishable()` in `src/types.ts` requires both `audioKey` and `contentType`, the listing logic filtered out all seeded episodes, rendering 0 episodes and showing the empty state ("No episodes yet") despite the harness claiming to serve 5 episodes.

## Solution
1. Added `contentType: "audio/wav"` to all seeded episodes in `scripts/listen-harness.ts`.
2. Added harness startup self-verification: requests `/listen/:token`, parses `#player-data`, and asserts that the number of playable episodes matches the seeded count (`seeds.length`), failing loudly if 0 or mismatched.
3. Verified blob existence for each seeded episode.

## Evidence Artifacts
- `01-listen-harness-5-episodes.png`: Screenshot of `/listen/harness-token` rendered in real headless Chrome showing 5 episode rows, active duration, play controls, and hidden empty state.
- Automated proof: `scripts/listen-browser-proof.ts`.
