# audio-feed-6piu — the capture hatch is an admission, not free text

- Capture: no assertions
- Reason: Historical review finding record establishing that the capture hatch is an admission requiring the literal sentence '- Capture: no assertions'. Contains no generating script, assertions, or visual evidence files.

Found in review by rev-legacy2: enforcement previously accepted `- Capture: <any non-empty text>`, so a README could declare `- Capture: fully tested and guaranteed`, assert nothing, and pass. The capture line is now enforced as the literal sentence `/^- Capture:\s*no assertions\s*$/m` in `tests/evidence_size_test.ts`.
