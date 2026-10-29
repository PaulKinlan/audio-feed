# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **Architecture in one line:** Issues live in a local Dolt database (`.beads/dolt/`); cross-machine
> sync uses `bd dolt push/pull` (a git-compatible protocol), stored under `refs/dolt/data` on your
> git remote — separate from `refs/heads/*` where your code lives. `.beads/issues.jsonl` is a
> passive export, not the wire protocol.
>
> See [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md) for
> the one-screen overview and anti-patterns (don't treat JSONL as the source of truth; don't
> `bd import` during normal operation; don't reach for third-party Dolt hosting before trying the
> default).

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Fast test tier (`deno task test:fast`)

The full gate (`deno task gate`) costs ~108s on a fleet VM; a one-file change should not pay all of
it while iterating. `deno task test:fast` (scripts/fast-check.ts, audio-feed-pubd) runs fmt + lint +
the whole-repo type-check, then only the tests a change can affect: tests that reach a changed file
in the static import graph without crossing the app/compose hubs, plus the name-convention tests
(`<stem>_test.ts`, `<stem>_*_test.ts`, mirrored test subdirectories). Changed scripts/ modules
select the tests that import them. It falls back to the FULL suite when a module-graph config file
changes (`deno.json`, `deno.jsonc`, `deno.lock`, `import_map.json`, `tsconfig.json` — checked by
name, because a change there can move what every suite resolves and no suite's own code can show
that), when a cross-cutting file (app/compose/router/http/config/server/origin) is reached by NO suite -
core files select their observers now (audio-feed-zyrug): the reverse-graph walk CROSSES hubs when the
changed file IS the hub (a suite that boots through `src/http.ts` exercises it on every request; the hub
cut stays for route changes, where booting through the hub exercises the app but not the route), plus the
suites the derived relation names as reading it, and a core file nothing reaches still runs the FULL
suite by name. A suite that declares a WHOLE-TREE scan (a literal `Deno.readDir("src")` earns a directory
relation key, `"src"` or `"src/"`) observes every file under it and is selected for ANY change under it
(audio-feed-sru1b; the parameterised `scan("src")` shape earns nothing - the resolver cannot see through
a parameter - so a scanner's ENTRY read carries the literal). SELECTION IS NOT COVERAGE, though
(audio-feed-ngrm6): the uncovered-code fallback asks the EXACT relation (`suitesObservingExact`), so a
directory key can never green a source file nothing otherwise reaches - an unreached .ts under a scanned
tree still runs the FULL suite by name, scanners included - while non-TypeScript data keeps scanner
coverage (audio-feed-a5n0q's ruling: a tree scanner genuinely text-reads data). A suite whose dynamic
import's SPECIFIER
is not a literal (`await import(name)`) is attributed to itself and selected for EVERY code change
(audio-feed-8kiar): the specifier resolves at runtime, so nothing can prove what it reads, and a
name-matched observer must not hide the drop the way it did once zyrug's hardcoded FULL fallback was
gone; the gate output names the suite, and a literal specifier turns it back into an ordinary edge -
followed by the relation's closure walk too, so a dynamically-imported module's own read sites are
derived - when a
changed src file has no covering test, when a changed script has importers but no reachable test,
when a changed test helper (`tests/*.ts` that is not `*_test.ts`) is observed by NO suite - helpers
select their observers now (audio-feed-3e4s0): the importers the reverse graph walks from the `tests/`
start, plus the suites the derived relation names as reading or EXECUTING the helper (a spawned fixture
like `tests/fixtures/invocation_death_child.ts` has no import edge, and the old blanket rule cost that
one-file change the FULL gate), so only a helper neither channel connects to any suite falls back - when
a non-TypeScript file
under src/ or tests/ changes (assets, HTML fixtures — the import graph cannot see them), or when the
git diff itself fails (a stale/missing origin/main must never read as "no changes"). Safe beats
fast.

Two things about that selection are CHECKED rather than assumed (audio-feed-es8y). First, the fast
gate's selection is a proven SUBSET of the full gate's: both derive from
`scripts/test-selection.ts`, which discovers what `deno test` with no arguments would run, and
`deno task gate` runs that audit (plus a proof over a planted corpus that the universe really equals
`deno test --no-run`'s own scan, using this repo's exclude list) as its FIRST step, so a suite the
fast gate could never select (a `tests/x.test.ts`, a `src/x_test.ts`) is a NAMED gate failure that
says what to do rather than a suite that quietly never runs on a lane. A module genuinely run
elsewhere belongs in `FAST_GATE_EXCLUSIONS` with the reason. Second, a non-TypeScript change OUTSIDE
`src/` and `tests/` is no longer assumed unobservable, and the relation is not a list kept beside
the suites: `scripts/test-selection.ts` DERIVES who reads what by scanning the suites' own code
(and, one hop out, the modules they import) for read/execute call sites with statically resolvable
paths - string literals, `new URL("<literal>", import.meta.url)`, and templates or path constants
built from `${import.meta.dirname}` (that last one is how `docs/evidence/` is found: the suite calls
`evidencePngs()`, whose `dir = EVIDENCE_DIR` default points at `../docs/evidence`). A screenshot
under `docs/evidence/` therefore selects `tests/evidence_size_test.ts`, and
`scripts/observability-agent-run.sh` selects the suite that executes it, without anyone maintaining
that mapping. There is NOTHING hand-written: the `UNREAD_DECLARATIONS` list and the audit that
policed it are DELETED (audio-feed-r9fe), because a standing "nothing reads this" assertion is
exactly the kind of claim a later suite can contradict silently. The whole-life cost of removing it
is a full suite on the rare change to tooling config - those paths change 15 times in 652 commits -
so the optimisation was worth seconds and cost a silent hole. Anything the derivation cannot see
runs the FULL suite and names itself, because the old rule ("not a .ts file, so no test can care")
gave a fast-gate PASS on a tree where the full gate failed. The module-graph config list is a NET,
not the safety mechanism: the config files the resolver actually reads are DERIVED from
`deno.json(c)` (`extends` recursively, its `lock` field, the default `deno.lock`) and the list is
audited against them, so a config the family does not name is a NAMED gate failure rather than a
quiet gap - and the protection remains the unclassified default, where an unmatched path runs the
full suite.

THE ORDERING RULE, because the bug that produced this design was an ordering bug (audio-feed-38sn,
found in review): for a non-TypeScript path the gate asks the DERIVED relation first - "is a suite
seen to read this?" - and only a path that no suite is seen to read falls through to a category
heuristic (documentation is inert). The derived relation therefore outranks every "what kind of file
is this" guess, and `inertContradictions()` makes an inversion of that order a NAMED failure that
runs the full suite rather than a silent empty selection.

The audit line's two numbers are CHECKED rather than printed: the universe the audit measured is
compared with the universe the run selects from, using the same `universeDrift()` that fails by
name. That comparison is a GATE-LEVEL check whose call site is not covered by a unit test -
neutering it leaves the suite green (measured) - so it is a known gap rather than an implied
guarantee, and the same is true of the selection cross-check call site. A reviewer should read those
two lines as checks that run, not as checks that are themselves verified.

An EMPTY selection is never a silent pass (audio-feed-es8y condition 2). It is only allowed when
every changed file is documentation that no suite is DERIVED to read — markdown is the only inert
class left after `UNREAD_DECLARATIONS` was deleted — and even then the run says so plainly
(`NO SUITES SELECTED — 0 of N test module(s) ran`) and emits `fast-gate: unmapped: <files>`, which
the fleet's coverage reporter turns into a COVERAGE WARNING, so a gate that ran nothing is visibly
not a gate that ran suites and passed. Anything not provably inert runs the FULL suite instead: the
old "a script NOTHING imports selects none, the type-check is its gate" carve-out is GONE, so
`scripts/smoke.ts` runs the full suite.

AN INCOMPLETE RELATION MAKES THE INERT CLASS UNREACHABLE (audio-feed-q0ky, coord's decision (b)). An
unread `.md` was inert, so a markdown read the detector could not resolve left the file inert and selected
NOTHING - and the gate DESCRIBED that as a fact ("no suite is derived to read it") when the truth was "some
suite reads something here and I could not confirm what". That is the same defect as the reporter printing
`unmapped` for a run that executed every suite, and the same as a blank admin cell: A REPORT MUST NOT RENDER
AN INABILITY TO KNOW AS A FACT. So: while the detector has UNRESOLVED read hints - path hints the scan
produced that name nothing in the tree - NO file may be classified inert, and a change otherwise treated as
inert widens to the FULL suite. The run says so twice, in words an operator can act on: the audit line
`fast-gate: read relation INCOMPLETE: N read path hint(s) do not name anything in the tree (...)` and the
plan's own reason (`the read relation is INCOMPLETE (...), so no file may be called inert: <files>`). A
resolvable markdown read is still caught by the derived relation, and a COMPLETE relation still allows the
inert class, so the rule keys on incompleteness rather than on markdown.

THE HINTS THEREFORE HAVE TO BE ACCURATE, WHICH IS WHAT MAKES THE RULE USABLE (audio-feed-lm4d). The rule
above was right and the hints were wrong: this tree carried ELEVEN hints that named nothing, so no change
could ever be inert and a one-line docs edit paid the full suite (measured: 112 suites, 125s, for one line
in `docs/ingest.md`). Each was a mis-parse, and each is now removed where it is produced, not by relaxing
the rule: (1) a read call that exists only inside STRING CONTENT is data, not a read site - the detector's
own fixture suite was contributing its fixtures' reads as its own; a read inside a `${}` interpolation is
CODE and is still found. (2) A base bound OUTSIDE the repository (`Deno.makeTempDir()`, `$HOME`, `TMPDIR`) is not a repo path, so
`${dir}/state.json` is no longer offered as `state.json`: it is REPORTED in the `outOfRepo` bucket (reported,
never silent - q0ky's lesson), and does not disable the inert class, because a hint based outside the repo
cannot name a file a change touches. That classification belongs to a BINDING and is resolved by LEXICAL
SCOPE (audio-feed-7l9m): the read's INNERMOST binding of the name decides, so a SHADOWED name that holds a
repo path keeps its relation (rev-27's fixture - a `home` bound to `$HOME` at module scope and to a repo path
inside the reader - now selects that reader exactly), a PARAMETER is its own binding and never inherits an
out-of-repo name, and when a value cannot be PROVED out-of-repo the hint is OFFERED as a fragment rather than
suppressed: the same safe direction as the guard, because an extra relation costs a test run and a missing
one costs a skipped test. (3) A SUFFIX after an interpolation is a candidate, not the path an author wrote,
so when it names nothing it is reported in the `unattributed` bucket rather than counted as a read the
detector could not resolve. The guard is NOT weakened by (3): `unresolved` hints still disable the inert
class, and a fragment blocks only when it could hide an INERT-ELIGIBLE read AND could BE the file being
changed - markdown, or an extension-less prefix that could be a directory of it, whose basename matches a
changed file (`couldHideInertRead` and `couldBeTheChangedFile` in `scripts/fast-check.ts`). Both reasons are
printed, so no fragment is dropped in silence. (4) A runtime-assembled suffix that NO OTHER BUCKET accounts for is printed in the `unclassified` bucket
(audio-feed-snww, audio-feed-3ttu) and, like `outOfRepo`, it neither enters the relation nor disables the inert
class: it is not a repo path, so the tree cannot be searched for it, and it has no extension, so it cannot be the
markdown file a change touches. THE RULE IS "UNACCOUNTED FOR", NOT "MATCHES A SHAPE": the first version asked
whether a candidate looked like a bare name (`[\w@.-]+`, no slash, no extension), and rev-27 measured its
complement - a name containing `+`, `#`, an accent or a space - landing in NO bucket at all, which is exactly the
silence q0ky forbids. A shape test always leaves a silent complement; "is this accounted for?" does not. The
reported value is the WHOLE candidate, never a prefix the whitespace split cut, because a bucket that reports the
wrong thing looks like a bucket that works. The boundary that keeps it readable is the CLASS, not a pattern - tail
candidates are the text after an interpolation in a path-shaped token, so a literal argument (a command name, a
CLI flag, an encoding, a URL) is rejected before a candidate exists and stays silent on purpose. Measured on this
tree: one member (`DevToolsActivePort`) against eight out-of-repo and two fragments. The relation itself is asserted UNCHANGED by the fix
(byte-identical on this tree, same 18 entries and observers), and `tests/read_relation_hints_test.ts` pins
both directions: an inert change IS inert, and a change touching something a suite reads STILL selects it.
If a lane ever sees a docs-only change pay the full suite again, READ THE AUDIT LINE - it names the hints
that did it, and they are now a signal about the tree rather than background noise.

The fast tier is an ITERATION aid. The merger still runs the full gate on the merged union before
anything lands, so a selection miss is caught there, not shipped.

Fleet wiring: the VM-local `~/.fleet/check.conf` carries `CHECK_FAST_CMD="deno task test:fast"`
(with `CHECK_FAST_TIMEOUT=600`). That file is reprovisioned, so if `fleet-check --fast` reports no
fast command, re-add the line — the durable deliverable is the repo task, not the VM file.

## The pre-push guard is armed by the gates (audio-feed-p2la)

`scripts/hooks/pre-push` refuses an ungated push and a copy of `origin/main` onto a `fleet/*` branch.
A hook that is not INSTALLED protects nothing, and until audio-feed-p2la the only installation path
was a best-effort call inside `scripts/fast-check.ts` — behind `Deno.permissions.querySync`, which is
always DENIED under `test:fast`'s `--allow-run=git,deno`, with the child's exit status and every error
discarded. The installer existed, the guard did not, and the gate went green saying nothing.

Both gates now ARM it (`deno task hooks:install`, a shell step in the task string, so no Deno
permission list is widened for the installer) and then VERIFY it (`deno task hooks:verify` →
`deno run --allow-read --allow-run=git scripts/hooks/guard-status.ts`, fewer permissions than the gate
that hosts it) as their FIRST two steps. Verification reads what git will actually execute: the hooks
directory git will use (`--git-path hooks`, so `core.hooksPath` cannot make it claim a guard that
would never run), the chain marker in that directory's `pre-push`, and the executable guard the chain
block runs. If the guard is not armed the verify step exits 1 naming the missing file, because the
gate must not vouch for a tree whose pushes are unguarded, and `scripts/fast-check.ts` repeats the
same measurement in-process so a deleted wiring step still reddens the fast path. A tree that is not
a git worktree is a stated limit (it cannot push, so there is nothing to guard) rather than a
failure. `scripts/hooks/install-hooks.sh` fails closed the same way: a clone it cannot arm exits
non-zero by name instead of exiting 0 quietly. Run `deno task hooks:install` alone to arm a clone by
hand, `deno task hooks:verify` to ask whether a clone is armed. A `core.hooksPath` that moves git's
hooks directory elsewhere is a named installation failure, not something the installer will write
around: it will not write into a hooks directory shared with other repositories. Since a clone the
gate cannot arm does not gate green, a fixture that runs the selector in a disposable clone arms it
first (`git clone` copies no hooks) — tests/fast_gate_fmt_test.ts does exactly that.

### Concurrency: several lanes gate at once on one VM (audio-feed-qqs6)

Every lane's gate runs the installer, lanes share a VM, and a linked worktree's hooks directory is the
common git dir — so two installs overlap routinely, and an installer that only usually works reddens an
unrelated lane's gate. It therefore serialises and writes atomically: one `mkdir` lock at
`$GIT_DIR/audio-feed-p2la.lock` (atomic on every POSIX filesystem, no extra tooling; `flock` is absent on
macOS, where this script also runs) with a bounded wait that steals a lock whose recorded pid is gone, and
every write is a private `mktemp` file in the target directory `mv`-ed into place, so no reader can see a
half-written hook. A second install that finds the artefacts byte-identical to what this tree would install
reports `already armed` and writes nothing. The lock's pid file is its identity, so a lock whose recorded
holder is gone, or (audio-feed-pvjg) a lock directory with no recorded holder at all after the full wait, is
stolen rather than reported as a holder that does not exist: `mkdir` and the pid write are two syscalls, so
a kill in between leaves a directory that names nobody, and treating that as a live holder wedged every
later gate on the VM until someone removed it by hand. What it never does is decline to check because it
detected
contention: that would trade a loud failure for a silent pass, which is the defect this bead exists to
close. Measured on the reviewed tip d43c263c before the fix, 240 overlapping installs produced 83 named
failures (35%); after it, 0 — the suite runs the overlap in two worktrees of one clone as
`audio-feed-qqs6`.

Failure messages say what was measured and nothing more. The old text asserted "The guard is NOT armed" on
every failure, including races in which the guard WAS armed and the very next verify step said so: a
message that contradicts the state it describes is a false alarm, and readers who see false alarms stop
believing the real ones. A failed install now names its cause, states that it did not establish the guard's
state, and points at `deno task hooks:verify` as the authority, which is the next step of both gate tasks.

## Modern-web bead closures record a premise verdict

Every `[modern-web]` bead the daily audit creates carries its canonical feature id in the title (the
trailing `(<guide-id>)`). The factory dedupes only by its own per-run findings fingerprint, which is
rebuilt on every CI run — so the same modernization CAN be emitted more than once (three
anchor-positioning beads, two scroll-driven-animations and two dialog-closedby exist today). Before
working a [modern-web] bead, search closed bead titles for its canonical id: a bead with the same id
may already be implemented, superseded or closed.

When closing one of these beads, record the **premise verdict** — what the scanner matched and what
the code actually has — as `bd close --reason "<line>"` or as a comment:

```
premise verdict: no producer of <thing> in src/; scanner artefact — canonical id <id>, already carried by <bead-id>
```

Measured examples: `no tooltip implementation in src/` (1vi, anchor-positioning) and
`no scroll-driven animation machinery in src/` (t8p, scroll-driven-animations). Without the line the
next lane re-derives the premise — two lanes did that in one week, and one implemented a contract
nothing produces (pzwe).

`scripts/check-modern-web-verdicts.ts` enforces it: the modern-web workflow fails when a closed
`[modern-web]` bead has neither a comment nor a substantive close reason. Run it by hand with
`deno run -A scripts/check-modern-web-verdicts.ts`.

## Ungated verify_* scripts are bannerred, not evidence (audio-feed-byh4j)

`scripts/verify_*.ts` is the name future readers cite as proof, and a script no suite executes or
reads is never kept true (verify_i7vi_events.ts once asserted severity bands a later landing had
moved). The whole-tree scanners "observing" such a script is selection, not coverage (ngrm6): a
text-scan of scripts/ proves nothing about the script's claims. So the ledger is binary and
enforced by `tests/verify_script_ledger_test.ts`: every `scripts/verify_*.ts` either has an EXACT
derived relation from a suite (someone really runs or reads it - c0gj, live_tts, live_e2e_tts,
main_l7m1_e2e, s3uk today) or carries the line-1 `audio-feed-byh4j: HISTORICAL` banner stating it
is not evidence of current behaviour. A row that reds names the file and both cures. To promote a
bannerred script to live evidence, wire it into a suite; never cite a bannerred script as proof.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some
systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**

```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**

- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Reclaiming leaked test temp entries (audio-feed-qdm95)

Test scratch roots (`<bead>-scratch-<hex>` dirs) and Chromium crashpad leftovers accumulate in
the temp root when a row dies before its own teardown — 14,519 entries / 4.3 GB were measured
on one VM before this existed. The reclaimer targets EXACTLY those pattern classes (plus stale
`audiofeed-chrome-*` profile dirs) and nothing else — never a general /tmp sweep:

```bash
# DRY RUN by default: lists what it would remove, changes nothing.
deno run --allow-read --allow-write --allow-run --allow-sys scripts/cleanup-test-temp.ts
# Execute. Exits 0 when every candidate's fate is proven, 3 when some candidates' liveness
could NOT be proven (busy host; nothing was deleted for them — re-run when quiet), 1 for
# real errors. It also fails closed per candidate: an inconclusive liveness probe (lsof
timed out/missing) SKIPS the candidate and counts it as skipped-unknown, never deletes.
deno run --allow-read --allow-write --allow-run --allow-sys scripts/cleanup-test-temp.ts --yes
```

Safe without root (only the current user's entries are touched), idempotent, and every skip is
logged. Run it before long test sessions on a lane VM that has seen gate crashes.

## Verifying a landing against production

`GET /health` returns **`deploy`** (the identifier), **`deploySource`** (the variable that
supplied it: `DENO_DEPLOYMENT_ID` on a Deno Deploy deployment, whichever commit variable supplied it
when injected (`GIT_COMMIT_SHA`, `GIT_COMMIT`, `DENO_DEPLOY_GIT_COMMIT`, or `COMMIT_SHA`), or `dev`),
and **`commit`** (the Git commit SHA when injected by the deployment pipeline, or `null` if the deploy
environment supplies no commit variable). **`dev` or `commit: null` is not a match on its own — seeing
it without an exact Deploy API mapping or a distinctive public marker means production is UNVERIFIED,
not verified.**

```bash
curl -s https://audio-feed.paulkinlan-ea.deno.net/health | python3 -m json.tool
# { "status": "ok", "storage": "...", "deploy": "<id>", "deploySource": "DENO_DEPLOYMENT_ID", "commit": "<sha>|null", "time": "..." }

# when commit is present and non-null in /health, it names the exact Git commit SHA running in production.
# when commit is null and deploySource is DENO_DEPLOYMENT_ID, map the opaque id back to a revision
# (with DENO_DEPLOY_TOKEN set to the configured ddo_ org token):
deno deploy deployments list --app audio-feed --org paulkinlan-ea --json --non-interactive
# The old deployment CLI and classic dash.deno.com API reject ddo_ organization tokens by design;
# the classic API was retired 2026-07-20. Use the v2 deno deploy CLI above.
# when deploySource is any injected commit variable (see above) the id IS the commit:
git log --oneline -1 <id>
```

Content-addressed assets and distinctive public markup prove code presence without any token, but
their limits must be understood:
1. Public reads (e.g. `/assets/<hash>.<name>`, public `/login` styles and markup) prove that the
   deployed build *contains* a commit's change set, but they do not establish a deployment identity,
   and they do not prove authenticated behavior (authenticated routes such as `/account` or `/admin`
   are out of scope for unauthenticated reads).
2. Public reads cannot distinguish between commits when the net source diff across public surfaces is
   zero: for example, across `103a2498..fc8851e0` (where the commit list is 13 entries, and a merge
   commit's first-parent diff can touch served routes without the net diff changing), the net source
   diff for `shell`, `account` and `assets` is zero, so public responses are byte-identical across the
   entire window.
3. Establishing the exact running SHA requires either the unauthenticated `/health` `commit` field (when
   supplied by CI/deploy env) or querying the Deno Deploy API using `DENO_DEPLOY_TOKEN`.

For content-addressed assets:
`deno eval 'import {assetUrl} from "./src/routes/assets.ts"; console.log(assetUrl("listen.js"))'`
prints the URL the landed tree expects, and that URL's `sha256sum` must equal
`sha256sum src/assets/listen.js` at the landed commit. Caveat (measured): `listen.css` is served
COMPOSED — design tokens prepended — so compare the tail after the token block, or fetch the file's
own route.

**Rule: landed ≠ live.** A change is verified only when the live commit field (or Deploy API mapping,
or distinctive asset/markup hash) matches the landed revision. Otherwise record production as
UNVERIFIED on the bead and say so in the handoff, rather than treating a passing gate on the landed
tree as proof of what is serving.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and
commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git
remote; `.beads/issues.jsonl` is a passive export. See
https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or
orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or
  Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and
  suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git
  policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run
  quality gates, commit, and push as part of session close. A current "do not commit" or "do not
  push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit
user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**

- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.

<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->

## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at
`.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global
install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context
  automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git
remote; `.beads/issues.jsonl` is a passive export. See
https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

<!-- END BEADS CODEX SETUP -->
