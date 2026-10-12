# audio-feed-1zfv — evidence READMEs commit ephemeral ports and stale commit shas

- Capture: no assertions
- Reason: Historical bug record for ephemeral port and stale commit sha citations in evidence READMEs. Contains no generating script, assertions, or visual evidence files.

Committed evidence READMEs carry ephemeral ports and commit shas as if they were reproducible - a reader cannot re-run what they describe. Found by the audio-feed-q45b audit. Durable validation rule and generator hygiene are codified in `scripts/proof-helper.ts` (`writeEvidenceReadme`).
