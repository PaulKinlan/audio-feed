# Evidence: regenerate button (audio-feed-8oz)

- Capture: no assertions
- Reason: Historical visual capture artifacts from regenerate button implementation (audio-feed-8oz). Generating script scripts/regenerate-browser-proof.ts is stale against current admin session/passkey auth and custom dialogs, crashing at removed admin-token inputs; script migration is held separately under fleet/ufg9 and blocked by audio-feed-ebyy.

## What the historical run checked (not asserted now)

The capture was produced once by a proof that ran ten checks, all of which passed on
2026-10-11. They are listed here as the record of what the artifacts demonstrate, not as
coverage: nothing checks them today, because the generating script is stale against the
admin console's session/passkey auth and its custom dialogs.

- before: counts
- before: feed serves the old key
- confirm dialog raised and states the spend
- queued: feed still serves the old key, old audio plays
- during synthesis: old audio still served
- after: feed serves a NEW key, same GUID
- after: old blob is gone
- after: new audio plays
- stub synthesizer called once
- after: console shows it current

Restoring these as live assertions requires the script work held under `fleet/ufg9` and
the underlying blocker `audio-feed-ebyy`, not a change to this README.


Historical capture artifacts from the original regenerate button implementation (audio-feed-8oz).
The directory contains captured screenshots (`01-before.png` through `07-feed-after.png`) and
historical `evidence.json`. It declares no live browser assertions because the generating proof script
is stale against subsequent admin console migrations: `/admin` removed `#adminToken` and `#saveToken`
inputs in favor of session cookie authentication (audio-feed-0jp / audio-feed-8fc), and native
confirm dialogs were replaced by custom HTML dialog elements (audio-feed-0r0s).
Live script maintenance is tracked and held under `fleet/ufg9` (finding `audio-feed-ebyy`).

The original capture drove the real admin console, feed and `/audio` routes in headless Chrome for Testing
(153.0.8010.36) over raw CDP. In-memory stores seeded with one approved subscriber and two
ready episodes: one made by old prompts (`promptVersion` `0ld0ld0ld0ld`) and one made by the
current prompts. The synthesizer is a stub that blocks until released: no Gemini key, no
spend.

Historical reproduce command (stale against current auth):

```sh
CHROME=$(ls -d $HOME/.cache/puppeteer/chrome/*/chrome-linux64/chrome | sort -V | tail -1)
deno run --allow-all --unstable-kv scripts/regenerate-browser-proof.ts \
  "$CHROME" "$HOME/cap-evidence/audiofeed-8oz/chrome-profile" docs/evidence/audio-feed-8oz
```

`scripts/regenerate-harness.ts [port]` serves the same seed for clicking by hand; there the
stub is released 3 s after synthesis starts.

| Screenshot                       | What it shows                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `01-before.png`                  | Manage panel: "Regenerate outdated (1)", "Regenerate all (2)"; the old episode is `ready`, `outdated`.           |
| `02-feed-before.png`             | Master feed: the enclosure is `audio/sub-1/direct/ep-old.wav`.                                                   |
| `03-queued.png`                  | After clicking Regenerate and accepting the confirm dialog: `regenerating`, "Queued 1 episode for regeneration." |
| `04-feed-during-synthesis.png`   | Feed while the stub is mid-synthesis (episode `synthesizing`): still the old enclosure, same GUID.               |
| `05-admin-during-synthesis.png`  | Console during synthesis.                                                                                        |
| `06-after.png`                   | After release: both episodes `current`; "Regenerate outdated (0)".                                               |
| `07-feed-after.png`              | Feed: same GUID `ep-old`, NEW enclosure `audio/sub-1/direct/ep-old-f66f3f11.wav`.                                |

`evidence.json` records the ten checks, and all ten passed. The confirm dialog stated the
spend. While queued and while synthesising, the old key was in the feed and
`GET /audio/sub-1/direct/ep-old.wav` returned 200. After the swap the feed had the new key
under the same GUID, the old blob returned 404 and the new one 200. The stub was called once,
and the console reports the episode as current.
