# Verification evidence

One directory per bead (`docs/evidence/audio-feed-<id>/`), written by the browser-proof scripts in
`scripts/`. Evidence is how a landing is verified, so it is committed — but it is also binary in
git, so it is budgeted.

## Policy (audio-feed-39k1)

1. **Compress before you commit.** Run `deno task evidence:compress` after capturing screenshots. It
   recompresses every PNG to a 256-colour palette (PNG8 via ImageMagick) and keeps the result only
   when it is smaller — typically ~3x smaller and visually identical at review scale.
2. **Per-file budget: 150KB.** `tests/evidence_size_test.ts` fails the suite when any evidence PNG
   exceeds it. If a compressed screenshot still exceeds the budget, capture a smaller viewport or
   crop to the element under test — do not raise the budget to fit one file.
3. **Prune stale evidence.** Evidence for a bead whose change has since been redesigned (the
   screenshot no longer shows anything that exists) may be deleted outright — the bead comment keeps
   the verification record, and git history keeps the bytes. When in doubt, keep it.
4. **Not everything belongs here.** `article.txt`/`repro.json` fixtures that tests read are data,
   not evidence — keep those small and text-shaped.

## Not done, deliberately

Storing evidence outside git (an R2 bucket with URLs recorded on the bead) would keep binaries out
of the tree entirely, but it moves the Functional Verification Mandate's proof behind a bucket's
availability and retention policy, and beads would point at URLs that can rot. That is a coordinator
decision, not a lane decision — noted on audio-feed-39k1 for the architecture track.
