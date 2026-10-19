<!-- #evidence-readme-generated-begin -->
# Browser Acceptance Proof: audio-feed-kzi

- Script: scripts/playback-position-browser-proof.ts
- Asserts: playback position 45s saved to localStorage; row displays 'Resume from 0:45' badge; play button action is 'resume'; distinct 'Play from start' button is present; clicking resume seeks audio to 45s; clicking 'Play from start' clears stored position; re-saved position 50s; other user cannot resume user-1's playback position (per-user isolation); ended event clears stored position; teardown: nothing still references the Chrome profile (directory removed and no process carries it)
<!-- #evidence-readme-generated-end -->

## Evidence image format

`01-resume-playback-position.png` is written through `quantiseEvidencePng` (scripts/proof-helper.ts), which quantises
and bounds the palette. The committed image was re-captured in audio-feed-6dw2z: 44,450 bytes (md5 `73ffeedf…`) against
the previous un-quantised 125,514-byte file (md5 `c05bbf35…`). The page and its geometry are unchanged (1280x900 both),
so a diff on this file is the compression pipeline (audio-feed-39k1 / the quantise work in 2c9d915d), not a regression,
and re-running the proof reproduces it byte-for-byte.

## Feature
Playback position persistence and resume in the web player:
- Automatically tracks and saves playback position per episode locally.
- Scoped strictly per-token to prevent position leakage across users on a shared device.
- Renders visible resume affordances ("Resume from M:SS") with distinct "Play from start" actions.
- Clears saved positions on episode completion (`ended`) or when rewound/seeked back to the start (`<= 2s`).
- Bounded to 50 newest positions per token.
- Degrades gracefully if `localStorage` throws or is blocked.

## Real-Browser CDP Verification
Executed via `scripts/playback-position-browser-proof.ts` (real headless Chrome driven over CDP):
1. **Save on playback/pause**: Verified playing episode 1 to 45s persists `{ position: 45, updatedAt }` in `audio-feed-positions:harness-token`.
2. **Reload & UI representation**:
   - Episode row renders `<span class="ep-resume-badge">Resume from 0:45</span>`.
   - Play button action reflects `data-action="resume"`.
   - Distinct `<button class="ep-restart" data-action="restart">Play from start</button>` button is present.
3. **Resume action**: Clicking resume seeks `#audio` to 45s and resumes playback. MediaSession position state is synchronized.
4. **Play from start**: Clicking "Play from start" seeks `#audio` to 0s and clears the stored resume position.
5. **Completion clearance**: Episode firing `ended` event automatically deletes the position entry so resume does not haunt completed items.
6. **Per-token isolation**: Loading under another token confirms zero positions leaked from the first token.

## Artifacts
- `01-resume-playback-position.png`: Screenshot showing the playlist row with "Resume from 0:45" badge and "Play from start" action button.
- Test script: `scripts/playback-position-browser-proof.ts`.
