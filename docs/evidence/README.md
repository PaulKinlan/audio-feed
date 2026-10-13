# Verification evidence

One directory per bead (`docs/evidence/audio-feed-<id>/`), written by the browser-proof scripts in
`scripts/`. Evidence is how a landing is verified, so it is committed — but it is also binary in
git, so it is budgeted.

## Honesty (audio-feed-q45b)

**No evidence without a check that can fail, and no README claiming more than the check covers.** An
audit of all 42 proof scripts found nine that fail on main, twelve that leak the browser they claim
to clean up, three whose `check()` cannot fail the run, and READMEs carrying ephemeral ports and
stale shas. Every one of those defects was invisible to a reader who trusted the README. Three
obligations, each named after the defect it prevents:

1. **The script must fail when the claim is false** - proven by deliberately breaking the behaviour
   and watching the proof go red. A script that prints the state of the world and always exits 0 is
   a **capture**, not a proof: captures are allowed (and sometimes the right tool) but must be
   declared. A check that cannot fail is worse than no evidence, because it retires the question.
2. **Assert the rendered thing, not the presence of its source.** For UI evidence that means
   visible, inside its box, and interactive - not "the text is in the DOM". A code block whose text
   was present and correct while 74% of it rendered off-screen passed a unit test, a browser proof
   and an independent review.
3. **The script's own hygiene is part of the evidence.** Clean up the browser, its profile and the
   server in a `finally` that runs on failure as well as success; await the browser's exit before
   deleting its profile, and report a failed removal instead of swallowing it. Name no ephemeral
   port and no commit sha in a committed README - both are wrong the moment they are written.
   Instead name the command that regenerates the artifact.

### Declare it in the README

Every `docs/evidence/<bead>/README.md` states its own coverage in two lines (or three when executed
by a test suite), so a reviewer can judge the evidence without reading the script:

```
- Script: scripts/<proof>.ts          # the tool, omitted only for evidence with no script
- Executed by: tests/<suite>_test.ts  # optional: the test suite that executes the proof script
- Asserts: <the claims the script fails on, separated by ; >
```

or, when the artifact only records state:

```
- Capture: no assertions              # this EXACT sentence, when the artifact only records state; put the reason in the prose below
```

`tests/evidence_size_test.ts` enforces the presence and shape of those lines. It cannot check that
they are **true** - only a mutation can - so a reviewer asks for the mutant at review time, the same
way it asks for a test. Evidence directories that predate this rule are listed in that test and are
expected to shrink, not grow.

### Cost, stated plainly

One deliberate break and one extra run per proof (~1-2 minutes); writing the property you need
instead of the easiest DOM query; a `finally` and an awaited browser exit. The alternative is what
the audit found: 45 stale browser profiles on a 2-vCPU VM, and a landed fix that was unusable in
practice with a green suite and a passed review.

## Policy (audio-feed-39k1)

1. **Compress before you commit.** Run
   `deno task evidence:compress <the bead directory you touched>` after capturing screenshots —
   naming the path keeps the pass local, because a bare run recompresses every committed PNG in the
   tree that it can shrink (measured 2026-10-12: eight other beads' directories in one run). It
   recompresses to a 256-colour palette (PNG8 via ImageMagick) and keeps the result only when it is
   smaller — typically ~3x smaller and indistinguishable at review scale (at 1:1, smooth gradients
   may show faint banding; the UI under test is unaffected). **Re-running a proof undoes the
   compression**, because screenshots are captured uncompressed (measured 2026-10-12 on
   audio-feed-8fc — 333KB/313KB/243KB fresh against 131KB/118KB/82KB committed) — and since
   audio-feed-3teu that is REPORTED rather than failed: `tests/evidence_size_test.ts` measures what
   GIT CARRIES (the staged blob, else `HEAD`), so a re-run's raw screenshot is a note
   (`… over the 150KB budget in the WORKING TREE … not a size-gate failure`) and the suite stays
   green. It fails the moment the oversized bytes are STAGED or committed, which is when they would
   land in the tree. So reproduce freely, and compress before you `git add`.
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

## Determinism disposition per proof (audio-feed-959n)

Some proofs capture a render that is not bit-reproducible. That is not automatically a defect, but
pretending it does not happen is: a reviewer who cannot tell a correct capture from a lucky one
cannot review it at all. So every proof gets ONE row here, and the row names its disposition AND the
evidence for that disposition. This is deliberately not a survey - a survey cannot be checked, a row
that carries its own measurement can.

THREE DISPOSITIONS, AND NOTHING IN BETWEEN:

- **deterministic** - re-running produces the same artifact, measured by capturing twice and
  comparing.
- **spread-declared** - the artifact varies, the variation is MEASURED, and the proof's own README
  states the spread so a later reader knows what a re-run can and cannot reproduce.
- **scaffolding** - the artifact is a capture of the harness itself rather than of product
  behaviour, and is labelled as such. These are the ones to delete or fold into a real assertion,
  not to keep.

| proof            | disposition         | evidence                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audio-feed-8eh` | **spread-declared** | THREE DISTINCT IMAGES IN FOUR CAPTURES AT ONE COMMIT (audio-feed-rxo1, filed after a reviewer could not re-derive the committed artifact). The spread is measured; what remains is for `audio-feed-8eh`'s own README to state "three of four captures differ", so the next reviewer reads this table's row instead of rediscovering it. |
| `audio-feed-l7m1` | **spread-declared** | Two sequential proof runs at `0726db0`: `01-admin-observability.png` differed in 9,855 pixels, max channel delta 225, box `1276x3401+0+24` (wall-clock timestamp, waiting age/claim dates, correlation ID and live duration); `02-homepage-bookmarklet-main.png` differed in 432 pixels, max delta 215, box `973x305+304+517` (localhost ports 45961/33807 in bookmarklet and curl snippets). Both have identical dimensions and zero shift is best. `03-listen-web-player.png` and `README.md` were byte-identical. Existing committed-blob pins protect archived artefacts, not regeneration reproducibility. The archive regression gate retains all four committed-blob pins. The **manual, non-gating** `scripts/l7m1-determinism-proof.ts` compares **two fresh runs** of README and raw 03 by bytes, and two fresh raw 01/02 PNGs in decoded colour space outside DOM-derived *whole live-value* text ranges. It asserts the exact live-element census (six admin times, one waiting age, one UUID, one duration; two in-viewport home ports), two CSS pixels of font/device-scale edge inflation, non-palette raw CDP colour type 2/6, and observed outside-mask channel tolerance **0**. The fast-tier `tests/l7m1_determinism_test.ts` is pure and machine-independent: it checks +1 static-pixel and erased-ink negative controls. The browser comparison is deliberately NOT a fast gate pending two contended load-invariant runs. Independent pre-quantisation pairs found seven admin live-field bands in their union (clock, waiting age, claim/failure time, correlation ID, duration); home found two port bands plus a transient sticky-header paint difference. The proof now rounds the home capture's scroll offset and waits two animation frames; two independent settled pairs then differed ONLY in those two port bands, while raw admin static prose y2800..3370 stayed identical. The initial diff-derived fixed boxes later missed a new clock glyph at x312..315 when the hour advanced (delta up to 225); the browser comparison now derives each full text range from the DOM at capture time instead of assuming a width from earlier pixel diffs. Its two-pixel edge inflation accounts for font antialiasing and device-scale rounding; it still allows **zero** decoded-colour changes outside those ranges. Coordinates, failures and source attribution are on audio-feed-3cvy. Palette-encoded PNG bytes are not the determinism instrument: a changed global PLTE can remap indices far outside the changed glyphs even when decoded colours match. Fresh `03` was byte-identical across runs (SHA-256 `549124de...`) but differs from the archived `03` (`7b695440...`): fresh == archive is not a determinism claim, and an intentional historical render change can disagree with the archival pin while fresh runs remain reproducible. The determinism test pins the RAW encoder to non-palette CDP PNG; shipped palette-quantised PNG8 remains byte-pinned only as an archive, NOT claimed byte-reproducible. Whether to change shipped encoding is a separate product decision (audio-feed-f9cy), not smuggled into this proof. Freezing the clock or canonicalising the port would alter live behaviour, and a canonical port risks a collision. |

**NOT YET CLASSIFIED, AND THAT IS THE HONEST STATE OF THIS TABLE:** the remaining proofs have no row
here yet, and every one of them needs its own measurement rather than an inference from the shape of
its script. Rows are added when a proof is measured, never in bulk - a table filled in by inspection
would be exactly the "satisfied by construction rather than observation" defect this section exists
to prevent. `deno task evidence` runs every declared proof, so the measurement for a row is a run of
that task twice and a comparison of the artifacts, which is a bounded and repeatable experiment
rather than an argument.

## Checking a change to a proof script (audio-feed-coao)

A delta that touches only a script in `scripts/` is **not** checked by the fast gate today, and the
reason is measured rather than suspected: the gate's derived relations cover non-TypeScript paths,
and `scripts/` is covered by the import graph instead — which a **spawned** script is invisible to.
Such a delta derives no suite, so the empty-selection guard runs the whole fast tier (115 suites
that never execute the proof, 132s on fjfh slice 3) and the gate passes anyway.

The commands that DO execute proofs, so a reviewer has somewhere to go:

- `deno task evidence` — runs every proof an evidence README declares (31 today) under a per-proof
  bound, and reports which directory failed, with the script, the exit code and the seconds;
- `deno task evidence:mutants` — runs the exww capture-identity mutant matrix, whose rows are what
  prove those checks can fail at all.

**These are checks you can run, not checks the gate runs.** Nothing invokes them automatically, so
"a proof-script delta _should_ be checked this way" is a rule for a reviewer, not coverage: the
difference between _should be checked_ and _is checked_ is the whole subject of audio-feed-coao, and
making the gate red by derivation is audio-feed-4kl3.
