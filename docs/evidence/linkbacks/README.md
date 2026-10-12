# linkbacks — read-along links (audio-feed-585)

Driven in Chrome on the branch, not inferred from a route test.

- Harness: `scripts/listen-harness.ts` on `/listen/harness-token` (port 8177 in the recorded run was illustrative; the actual port is chosen dynamically at run time) (5 episodes,
  each article seeded with a source URL).
- Result of the drive: **5/5 rows carry a "Read along" anchor**, and the dock link appears when an
  episode is selected:
  - row anchor: `text="Read along"`, `href="https://example.com/ep-1"`, `target="_blank"`,
    `rel="noopener noreferrer"`, `aria-label="Read the article: Aggregation theory and the shape of
    the modern platform"`, visible.
  - dock anchor (`#nowRead`): hidden before selection, then `hidden:false`,
    `href="https://example.com/ep-1"`, same label, visible.
- `player-read-along.png` is the viewport at that moment.
- A `javascript:` article URL never reaches the page (route test pins that); the server sends
  `articleUrl` only for http(s).
