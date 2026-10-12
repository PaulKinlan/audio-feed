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
- Capture: no assertions              # say it plainly rather than implying verification
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
