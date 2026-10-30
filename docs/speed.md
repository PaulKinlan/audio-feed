# Audio Feed Gate Speed

## Executed contract

- On this VM, implementers run
  `FLEET_CHECK_CONF=$HOME/.fleet/check-audio-feed.conf fleet-check --fast` (merger: the same
  override without `--fast`, once on the merged union per `AGENTS.md`). The named config sets
  `CHECK_FAST_CMD="deno task test:fast"` and `CHECK_CMD="deno task gate"` (`deno.json:30,34`);
  without the override, machine-global `~/.fleet/check.conf` invokes a missing `tools/fast-gate.sh`,
  so the fast gate exits 127.
- `deno task test:fast` audits the discovered test-module universe, runs `deno fmt --check`,
  `deno lint`, and `deno task check`, then selects tests by code reachability and derived read
  relations (`scripts/fast-check.ts:942-1053,1066-1191`; `scripts/test-selection.ts:164-213`). A
  changed path with no selected reader and no proof that it is inert widens to the full test suite;
  an inert doc with no derived reader selects zero suites and reports **NO SUITES SELECTED**, not a
  test pass. The decision is the `isProvablyInert` return in `scripts/fast-check.ts`, behind the
  `inertContradictions` and incomplete-relation guards, and the marker is emitted by that file's
  `testFiles.length === 0` branch; both are pinned by row NAME (audio-feed-361l7) —
  `tests/fast_gate_subset_test.ts` "the empty state is announced for the coverage line and said out
  loud" and `tests/fast_gate_fmt_test.ts` "audio-feed-8qnu control: formatted file passes gate
  without extra work".
- `.ts` data-read admission is **partial today**: resolver-proven paths (`resolvedPaths`) are
  admitted, while literal `authoredPaths` and dynamic reads are not admitted and the explicit
  declaration escape hatch is **not built** (`scripts/test-selection.ts:1500-1549`). Unresolved read
  hints disable the _inert-document_ shortcut when the planner otherwise has no tests and an inert
  path, not all affected-only selection (the incomplete-relation guard in `scripts/fast-check.ts`,
  pinned by row NAME: `tests/fast_gate_subset_test.ts` "audio-feed-q0ky: while the relation is
  INCOMPLETE no file is inert, and the widening is NAMED").

## Timing evidence, not a latency budget

`run_s` is execution time and `wait_s` is heavy-slot queue time in `fleet-check --status`; each row
below is **one observed gate run**, not a median, target or guaranteed duration. The host runner
caches by commit tree (`~/fleet/bin/fleet-check:14,158-190`): a later run on the same tree can
supersede an earlier status and log, so cite a record that still resolves. The repo tasks in
`deno.json` define no wall-time target. A runner timeout is a ceiling, not a measured speed budget.

| Gate | Exact cached record and reproduction                                                                                              | Observed execution |        Queue | Coverage  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | -----------------: | -----------: | --------- |
| Fast | `fleet-check --status --fast d20fc5c5` (tree `25f34298`, log `~/.fleet/checks/25f342983e281a0587d0c2918c5f1bc62a43ea10.fast.log`) |       `run_s=35` s | `wait_s=7` s | 6 suites  |
| Full | `fleet-check --status 793ea22a` (tree `25f34298`, log `~/.fleet/checks/25f342983e281a0587d0c2918c5f1bc62a43ea10.log`)             |      `run_s=185` s | `wait_s=0` s | full gate |

### Full-gate duration distribution and the CHECK_TIMEOUT default (audio-feed-9jlp3, 2026-10-27)

Per the MERGER's measurement table (the merger runs the gates; do not re-derive from logs), this
window holds TEN full-gate runs — 4830 / 4551 / 3703 / 3602 (INTERRUPTED) / 3259 / 3207 / 2785 /
2608 / 1622 / 1580 seconds — a wide spread (min 1580 s, max 4830 s) because load and queue shape
vary per run. That spread is exactly why the TIMEOUT, not test duration, is the binding
constraint: the bound must clear the observed max, not a typical run, and `run_s` in the cached
fleet-check record is the value the bound is actually compared against. Gates killed at the bound
are recorded as KILLED (not a verdict), which forces a cold re-run and taxes every lane behind it.

**CHECK_TIMEOUT default = 5400 s**, derived from the merger table: the rule `ceil(observed_max ×
1.1)` gives 5313 s from the observed max 4830 s, and the shipped default is the next round
hundred, 5400 s. That clears the slowest observed full gate by the rule's headroom while staying
low enough that a genuinely hung gate still dies within a bounded window (a hung gate holds its
heavy slot and the union behind it). Re-derive from the merger's table whenever a full gate lands
above the current default: the rule is `ceil(observed_max × 1.1)`, from measurements, never from
preference.

## Measured selection scope and suite cost (2026-10-29)

Every figure below names the record it came from: a cached gate job, a per-suite sum over one gate
log, or a counted number of runs. A figure with no record does not belong in this file, and the ones
that could not be attributed were dropped rather than rounded. These are observations of this host
on this day, not budgets.

### Selection scope: how many suites a changed path pulls in

Universe = the full-gate module count printed by the selector's own audit line (`fast-gate:
selection audit ok: N full-gate module(s)`), which was 159 on the tips below and 160 on later ones
(`~/.fleet/checks/34ac2871… .fast.log`). Selection sizes are properties of a TREE, so when two tips
disagree both numbers stay here with their tips attached.

| Changed path                               | Before                                                       | After                                                                                                                                           | Source                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/fixtures/invocation_death_child.ts` | FULL suite, 159 suites (killed at the bound, job `46f091ab`) | 2 suites — its executor plus the relation-policing subset suite                                                                                 | `~/.fleet/checks/46f091ab1e6736aadca5b1978891a455a58a4bb0.fast.log` (`FULL suite (shared test helper(s) changed: …)`, `ran 159 suite`); tip `2c871fbe` commit body (`invocation_death_child.ts -> 2 suites`) |
| `tests/fixtures/listen_client.ts`          | FULL suite, 159 suites                                       | 11 suites per the reviewer's measurement; 6 per the commit's own note (`tests/listen_client.ts -> 6`, tip `2c871fbe`) — both kept, not averaged | merge message for `2c871fbe` (reviewer-measured on that tree) and the `2c871fbe` commit body                                                                                                                 |
| `src/http.ts`                              | FULL suite, 159 suites                                       | 90 of 159 (tip `fe894a2c`); 91 at a later tip, recorded as `src/http.ts 91 -> 91` (the `audio-feed-38f28` landing, universe 160)                | `14f99c68` merge message, quoting the reviewer verdict verbatim (`src/http.ts FULL(159)->90 suites`); later identical-count record in the `audio-feed-38f28` landing message                                 |
| `src/compose/access.ts`                    | FULL suite, 159 suites                                       | 90 of 159 (tip `fe894a2c`)                                                                                                                      | same `14f99c68` merge message / reviewer verdict record                                                                                                                                                      |

Per-entry-point reach measured at `fe894a2c` (the same record): `app` 91, `compose` 90, `router` 90,
`http` 90, `config` 94, `server` 6, `origin` 90 suites. The hardcoded CORE full-suite guard is gone;
the four fail-closed paths (`stillUncovered`, relation failure, `changedFiles === null`, empty set)
still resolve to the FULL suite.

### The three whole-tree scanners are a SUBSET of a `src/` selection, not the selection

Three suites text-read the whole source tree instead of importing one file, so they appear in any
selection for a path under `src/`: `tests/error_screen_test.ts`, `tests/security_audit_test.ts`,
`tests/tokens_test.ts`. They are pinned as exact sets in `tests/fast_gate_subset_test.ts:558`
(`src/` readDir key → exactly `[error_screen_test, security_audit_test]`) and
`tests/fast_gate_subset_test.ts:553` (bare `src` key → `[tokens_test]`). Consequences that matter
when reading a selection number:

- The scanners are the reason an UNREACHED `src/` file selects anything at all, and they are 3 of
  the ~90 that a reached file like `src/http.ts` selects. A `src/http.ts` change does not select
  three suites.
- `audio-feed-sru1b` made that selection explicit and added the missing one: `error_screen_test` had
  been walking from a computed root (`new URL("../src", import.meta.url)`), earned no directory key,
  and was therefore not selected for a `src/http.ts` change. The `2 -> 3` in the sru1b record counts
  the SCANNER subset, not the selection.
- `audio-feed-ngrm6` (`77af4125`) separated selection from coverage: a directory-scan relation still
  SELECTS the scanner, but marks no file as covered, so a changed-but-untested `src/*.ts` fails
  closed to the FULL suite while an unreached `src/*.json` still selects the scanner that text-reads
  it.
- Their cost is small and measured: in gate log `3384e2eb` (2382 tests) the suites' own rows sum to
  `security_audit_test` 9.8 s and `error_screen_test` 0.6 s — 10.4 s combined. `tokens_test` was not
  in that sum. A cost argument against the scanners is not supported by these numbers.

### Suite cost, with the cause named

| Suite                 | Measured cost                                                                                                                                             | Cause and what was NOT weakened                                                                                                                                                                                                                                             | Source                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `proof_helper_test`   | 99.6 s in-gate → 67 s for the deno test phase (2m12.6 s wall) in one cold-compile run on an extracted tree, against a previous 115.69 s standalone median | Each Chrome launch's pre-launch sweep scanned ~16,500 unrelated `/tmp` entries; now it scans only the row's own scratch root, teardown is in `finally`, zero directories left per row, assertions 639 → 643                                                                 | per-suite sum over `~/.fleet/checks/3384e2eb….log`; tip `150cb670` commit body (corrected at review) |
| `tts_long_input_test` | 85.8 s in-gate → 41.88 s median standalone → 18.09 s median over three runs                                                                               | The 64/65-segment rows binary-searched paragraph counts through a superlinear splitter on every run; the fixture sizes (76/77 paragraphs) are now pinned while the real splitter still runs and is still checked against `MAX_TTS_INPUT_BYTES`, so a stale pin fails loudly | per-suite sum over `3384e2eb`; tip `182fa183` commit body and its `41.88s -> 18.09s over three runs` |

These two rows are NOT one before/after series: the in-gate figure and the standalone figure measure
different work (the in-gate run includes a cold compile), which is why no single ratio is stated
here. The in-gate 85.8 s was mostly cold compile, so the wall saving is smaller than the standalone
ratio suggests.

### Gate wall time cannot detect a cost regression below roughly 4x

Four full gates over the same ~2400-test suite set, one day, no change in suite count: **10m32s /
14m44s / 34m35s / 43m35s**. That is a 4x spread on identical work — host and hypervisor contention
dominates wall time, and the longer figure is the `3384e2eb` run itself (2591 s `run_s`, 41m33s of
test time). The ten-run table above shows the same shape over a longer window (1580 s to 4830 s).

The contract consequence: **gate wall time is not a reliable signal of a test-cost regression below
roughly a 4x movement.** A change that doubles one suite's cost is invisible in gate wall time, so
it must be judged on that suite's own measured cost; a gate that gets 2x slower on an unchanged
suite set tells you about the host. This does not license a wider budget — the `CHECK_TIMEOUT` rule
above still derives the bound from observed maxima, which is the one thing wall-time data is good
for.

### Fast-gate bound: `CHECK_FAST_TIMEOUT` is 1800 s

The runner's fast default is `CHECK_FAST_TIMEOUT=${CHECK_FAST_TIMEOUT:-1800}`
(`~/fleet/bin/fleet-check:365`, a fleet-side file outside this repo, so the value is cited there and
not from a repo diff). It previously behaved as a ceiling near 900 s, and legitimate runs died
against it while their suites were still running: eight cached fast records are `INTERRUPTED` with
`run_s` between 901 and 903, for example
`~/.fleet/checks/ccb09239adaa347b911f81cf2649fc7ba3848014.fast.json` (`run_s=901`, sha `a98f44d8`,
2026-10-29) and `~/.fleet/checks/a6d549428c32409198fc12021b20c692a882025e.fast.json` (`run_s=903`,
sha `c1dec379`, 2026-10-29). A bound-killed fast gate is not a verdict: it forces a cold re-run and
taxes every lane behind it. The bound stays a ceiling, not a speed budget, and the cause of those
kills was selection width times host speed, not any single suite.

### Claims this section supersedes

1. **"The two scanners are the fast gate's cost."** Replaced by the 10.4 s combined measurement
   above, and by the cause of the 903 s kill: selection width (22 suites) x host speed on a loaded
   host. The scanners were never the weight.
2. **"Two whole-tree scanners."** Replaced by three — `error_screen_test`, `security_audit_test`
   and `tokens_test`. The two-element set is one of the two keys (`src/`), not the whole scanner
   set; `tokens_test` earns the bare `src` key.
3. **"A cross-cutting `src` file now selects the scanners (3 suites)."** Replaced by ~90 suites of
   159/160 for `src/http.ts`, of which the three scanners are a subset. The `2 -> 3` figure was the
   scanner subset, not the selection size.

## Tests must not assert on elapsed real time (audio-feed-n52j3)

Two of the three union-gate reds on 2026-10-23 had nothing to do with the branches under test: the ROWS
raced wall-clock time. One was `tests/listen_activity_test.ts`, row "the retry button's labels are driven
by real 429 bodies: rate refusal vs spent ceiling vs queued (audio-feed-8jzgl, audio-feed-rvy5n)", fixed
in d9571c40 by injecting the measured 429 bodies. The other was `tests/synthesis_worker_test.ts`, row
"audio-feed-091i: completed staging upload interrupted by budget records a durable cleanup marker that
sweeps on subsequent failure or ready", fixed under audio-feed-krrws by injecting the budget's clock. Each
cost a 20-27 minute full-gate run for every lane queued behind it. A row that can fail because the HOST was
slow while the code was correct is a tax on every landing, so the rule is:

1. **A test asserts on an INJECTED clock, never on elapsed real time.** No `Date.now`/`performance.now`
   pair compared against a bound; no real `sleep(N)` whose adequacy the assertion depends on; no real
   timer raced against a production deadline on `REAL_INVOCATION_CLOCK`. Inject the clock the production
   seam already offers (`SynthesisWorkerOptions.clock` / `InvocationBudgetSpec.clock`, the
   `controlledInvocationClock` pattern in `tests/synthesis_resume_test.ts`; stub `performance.now` where
   that is the seam) and decide in the test WHEN the deadline arrives. The assertion then states an ORDER
   of operations ("the PUT started before the budget aborted the turn"), not a duration.
2. **Where a real bound is genuinely unavoidable** (timer liveness, complexity floors, absence-over-a-window
   proofs), the assertion must carry a comment naming the failure mode it produces on a loaded host and why
   the bound survives it. The compliant shape is `tests/c0gj_linear_complexity_test.ts`: minimum-of-N
   iterations, margins measured in tens of multiples of observed contention, the rationale in the header,
   and a negative control proving the bounds still fail the quadratic implementation. Widening a bound to
   silence a flake is NOT a fix — it moves the failure to a slower host and hides that the row tested
   timing rather than behaviour; the fix is to inject the input.
3. **Order facts beat clock facts.** `putCalls === 0` (preflight refused before any transfer), `putAborted === 1`
   (the deadline aborted the in-flight transfer), a durable marker written before the PUT — these are true
   or false regardless of scheduler noise. When a row currently expresses its property as milliseconds,
   rewrite the property as an order and keep at most a deliberately wide sanity bound with the comment from
   rule 2 (`audio-feed-y2ex` did this for the dv4p rows).

A new test that asserts on elapsed real time without the rule-2 comment is a review finding; a row that
reddens a gate on a loaded host gets the krrws treatment (inject the clock), not a wider bound.

**Cite a row by its `Deno.test` NAME, never by a line number (audio-feed-361l7).** Both pointers above
were first written as line numbers, and both were wrong within a day: `:684` landed on an unrelated CDP
typing interface and `:2000` on the pre-fix position, so a reader following them could not see the row the
rule is about. A row name is unique and line-independent; `grep -n` over the file costs one command and
cannot silently point at different code. The same standard applies to any row cited from a doc or a bead.

## Widening verdict boundary

These records are different gate workloads, not a same-workload before/after widening measurement.
Neither a comparable gate median/headroom nor a numerical changed-path frequency threshold is
established by them; therefore **no budget-backed accept/decline verdict for a proposed selection
widening follows from this document**. A standalone suite timing is not an end-to-end gate delta.
This is an explicit absence of a measured decision criterion, not an assertion that a particular
widening is acceptable.
