# Verification evidence

One directory per bead (`docs/evidence/audio-feed-<id>/`), written by the browser-proof scripts in
`scripts/`. Evidence is how a landing is verified, so it is committed — but it is also binary in
git, so it is budgeted.

## Policy (audio-feed-39k1)

1. **Compress before you commit.** Run `deno task evidence:compress` after capturing screenshots. It
   recompresses every PNG to a 256-colour palette (PNG8 via ImageMagick) and keeps the result only
   when it is smaller — typically ~3x smaller and indistinguishable at review scale (at 1:1, smooth
   gradients may show faint banding; the UI under test is unaffected).
2. **Budgets: 150KB per file, 8MB for the whole tree.** `tests/evidence_size_test.ts` fails the
   suite over either. If a compressed screenshot still exceeds the per-file budget, capture a
   smaller viewport or crop to the element under test — do not raise the budget to fit one file.
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

## Proof harness (audio-feed-lru1)

New browser evidence is written on the shared proof harness (`scripts/proof-helper.ts`). Hand-rolled
CDP proofs require a stated reason in their header that the independent reviewer checks. Profile
teardown, the run-failing assertion helper (`createChecker()`), DOM visibility and clipping
measurement (`assertVisibleExpression()`, `isVisible()`), and evidence README declarations
(`writeEvidenceReadme()`) all come from the harness. Legitimate escape hatches remain: repro scripts
with no browser, and live-proxy checks, are not required to use the harness.

### Deliberate trade-offs & lifecycle guarantees (audio-feed-ptid, audio-feed-pul6)

- **Fail-fast assertions vs. deferred summary:** `check()` throws `CheckFailureError` on the first
  failure rather than collecting all of them, ensuring an unhandled failure immediately ends the
  process non-zero even if a script omits `finish()`. A proof that reports everything but can be
  silently discarded on early return is the defect. Proofs that need to collect all failures must
  use `runProof(name, body)`, which creates a deferred checker and enforces `finish()` in `finally`.
  For scoped blocks, `using checker = createChecker()` guarantees disposal invocation of `finish()`.
- **Loud cleanup throw with guaranteed finally:** `createTempChromeProfile`'s `cleanup()` throws
  descriptive errors on persistent removal failure (measured across 12 scripts and 3 tests in the
  audit) rather than silently swallowing leaks. Loud-over-silent teardown is justified only by
  pairing it with a guaranteed `finally` wrapper (`withChrome`): the harness owns the browser and
  profile lifecycle, so cleanup is unconditionally attempted before any assertion or body failure
  surfaces.
