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

Every `docs/evidence/<bead>/README.md` states its own coverage in two lines, so a reviewer can judge
the evidence without reading the script:

```
- Script: scripts/<proof>.ts          # the tool, omitted only for evidence with no script
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
