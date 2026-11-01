# Browser Acceptance Proof: audio-feed-py5

- Script: scripts/listen-browser-proof.ts
- Asserts: rendered episode row count is 5; header count text displays '5 episodes'; empty state is hidden; play button loads audio URL into #audio element; enclosure audio URL returns 200 with non-empty RIFF/WAVE bytes; the row play button starts real playback (element muted, so the autoplay policy permits it); capture is playback-invariant: the audio element was paused at 0s across the shot; capture is repaint-invariant: no transition or autoplay notice is mid-flight across the shot

## Problem & Solution

listen-harness was omitting contentType on seeded episodes, filtering out episodes. Fixed by ensuring contentType: 'audio/wav', self-verifying harness startup, and asserting playlist rendering.

## Execution Log

```
PASS  rendered episode row count is 5  found 5 rows
PASS  header count text displays '5 episodes'  got '5 episodes'
PASS  empty state is hidden  empty hidden: true
PASS  play button loads audio URL into #audio element  audio src endpoint: /audio/user-1/direct/ep-1.wav
PASS  enclosure audio URL returns 200 with non-empty RIFF/WAVE bytes  status 200, size 960044 bytes, format: RIFF/WAVE
PASS  the row play button starts real playback (element muted, so the autoplay policy permits it)  paused false, notice ''
PASS  capture is playback-invariant: the audio element was paused at 0s across the shot  paused true, currentTime 0s, readyState 4, duration 60s
PASS  capture is repaint-invariant: no transition or autoplay notice is mid-flight across the shot  notice '', 0 animation(s) still running
```

## Evidence Artifacts

- 01-listen-harness-5-episodes.png: Screenshot of /listen/harness-token rendered in real headless Chrome showing 5 episode rows. Taken with #audio paused at 0s (asserted before and after the capture) so the player row is a fixed state rather than an instant of playback - the element would otherwise advance the seek thumb between runs (audio-feed-xsvti).
