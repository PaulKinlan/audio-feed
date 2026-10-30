# Evidence: audio-feed-0cmu

- Script: scripts/repro_0cmu_linger.ts
- Asserts: after a per-attempt deadline fires, each of the three call sites that used the `AbortSignal.any` composite (TTS request, worker batch, script stage) fails with an error that names the deadline it hit and keeps its own classification, and the caller's live lease timer is not re-ref'd by the aborted composite. `repro.json` is the record of the run.
