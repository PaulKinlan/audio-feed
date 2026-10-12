# Browser Acceptance Proof: audio-feed-py5

- Script: scripts/listen-browser-proof.ts
- Asserts: rendered episode row count is 5; header count text displays '5 episodes'; empty state is hidden; play button loads audio URL into #audio element; enclosure audio URL returns 200 with non-empty RIFF/WAVE bytes

## Problem & Solution
listen-harness was omitting contentType on seeded episodes, filtering out episodes. Fixed by ensuring contentType: 'audio/wav', self-verifying harness startup, and asserting playlist rendering.

## Execution Log
```
PASS  rendered episode row count is 5  found 5 rows
PASS  header count text displays '5 episodes'  got '5 episodes'
PASS  empty state is hidden  empty hidden: true
PASS  play button loads audio URL into #audio element  audio src endpoint: /audio/user-1/direct/ep-1.wav
PASS  enclosure audio URL returns 200 with non-empty RIFF/WAVE bytes  status 200, size 960044 bytes, format: RIFF/WAVE
```

## Evidence Artifacts
- 01-listen-harness-5-episodes.png: Screenshot of /listen/harness-token rendered in real headless Chrome showing 5 episode rows.
