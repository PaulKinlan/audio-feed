# Evidence: regenerate button (audio-feed-8oz)

Real admin console, real feed and `/audio` routes, driven in headless Chrome for Testing
(153.0.8010.36) over raw CDP. In-memory stores seeded with one approved subscriber and two
ready episodes: one made by old prompts (`promptVersion` `0ld0ld0ld0ld`) and one made by the
current prompts. The synthesizer is a stub that blocks until released: no Gemini key, no
spend.

Reproduce:

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
