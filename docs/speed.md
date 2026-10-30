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
vary per run. That spread is exactly why the TIMEOUT, not test duration, is the binding constraint:
the bound must clear the observed max, not a typical run, and `run_s` in the cached fleet-check
record is the value the bound is actually compared against. Gates killed at the bound are recorded
as KILLED (not a verdict), which forces a cold re-run and taxes every lane behind it.

**CHECK_TIMEOUT default = 5400 s**, derived from the merger table: the rule
`ceil(observed_max ×
1.1)` gives 5313 s from the observed max 4830 s, and the shipped default is the
next round hundred, 5400 s. That clears the slowest observed full gate by the rule's headroom while
staying low enough that a genuinely hung gate still dies within a bounded window (a hung gate holds
its heavy slot and the union behind it). Re-derive from the merger's table whenever a full gate
lands above the current default: the rule is `ceil(observed_max × 1.1)`, from measurements, never
from preference.

## Measured selection scope and suite cost (2026-10-29)

Every figure below names the record it came from: a cached gate job, a per-suite sum over one gate
log, or a counted number of runs. A figure with no record does not belong in this file, and the ones
that could not be attributed were dropped rather than rounded. These are observations of this host
on this day, not budgets.

### Selection scope: how many suites a changed path pulls in

Universe = the full-gate module count printed by the selector's own audit line
(`fast-gate:
selection audit ok: N full-gate module(s)`), which was 159 on the tips below and 160 on
later ones (`~/.fleet/checks/34ac2871… .fast.log`). Selection sizes are properties of a TREE, so
when two tips disagree both numbers stay here with their tips attached.

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

Four full gates over the same ~2400-test suite set, all between 15:07Z and 16:57Z on 2026-10-29.
Each figure is the test-phase duration in that gate's own summary line, and each resolves to its own
job record:

| Test-phase time | Job record                                                                    | Same summary line in that log      |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------- |
| 10m32s          | `f8fc0472e2d4dd9fb39d713d84f3e65a74e8eb58` (run_s 660, sha `ff19542d`, PASS)  | 2402 passed / 0 failed / 2 ignored |
| 14m44s          | `d2f1e1011cd2d58e312673a188b57a326aeff36a` (run_s 958, sha `4efecfae`, PASS)  | 2400 passed / 0 failed / 2 ignored |
| 34m35s          | `b94f4b4eb9fc1bd9d55168fe87413104c97b8d3b` (run_s 2147, sha `7d0445cb`, FAIL) | 2399 passed / 1 failed / 2 ignored |
| 43m35s          | `f301171b4acacac9dbcdf9de30a9d18216b08a18` (run_s 2761, sha `ed00fa6b`, PASS) | 2400 passed / 0 failed / 2 ignored |

That is a 4x spread on identical work: host and hypervisor contention dominates wall time, and the
difference is not in the suite set the four runs carried. The ten-run table above shows the same
shape over a longer window (1580 s to 4830 s).

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
kills was selection width times host speed, not any single suite. Raising it did not change that
cause: at 1800 s a fast gate was killed at `run_s=1801` on a small diff
(`~/.fleet/checks/844ed4e3b932d9298d9f37d0b24cb230e2b25ede.fast.json`, sha `f47f7fa4`, 2026-10-30),
which is the record behind the ruling below that a wider bound only moves the wall.

### Claims this section supersedes

1. **"The two scanners are the fast gate's cost."** Replaced by the 10.4 s combined measurement
   above, and by what the 903 s kill was actually spending its bound on: that record had widened to
   23 test files (`fast-check: 23 test file(s)` in
   `~/.fleet/checks/a6d549428c32409198fc12021b20c692a882025e.fast.log`, the `run_s=903` job cited in
   the previous section), so the wall time was selection width on a loaded host, not one heavy
   suite. The scanners were never the weight.
2. **"Two whole-tree scanners."** Replaced by three — `error_screen_test`, `security_audit_test` and
   `tokens_test`. The two-element set is one of the two keys (`src/`), not the whole scanner set;
   `tokens_test` earns the bare `src` key.
3. **"A cross-cutting `src` file now selects the scanners (3 suites)."** Replaced by ~90 suites of
   159/160 for `src/http.ts`, of which the three scanners are a subset. The `2 -> 3` figure was the
   scanner subset, not the selection size.

## Where the gate's time goes, and why the bound is not the lever (2026-10-30)

Four measurements, each naming its record: a commit body, a cross-family clearance record
(host-local, outside this repo, cited by branch and tip), or a cached fleet-check job. Together they
answer the question this file previously left open: a slow gate is fixed by making the gate cheaper.

### Derivation cost: 13,008 stats to find 12 paths (`fleet/ci-cost-verify`, tip `eb47024f`)

The selector's constant resolver stat'd every `const X = <rhs>` initialiser once per mentioning
line: **13,008 `statSync` calls per full-tree derivation, 12 hits, and ~10.9 s of ENOENT throwing**
(commit body `eb47024f`; the WIP it replaced, `f61a7dc3`, recorded the same counts with no
after-measurement). Memoising those lookups — and gating the survivors on the `REPO_PATH_SHAPE`
class `toRepoPath` already applies — took the selector-audit median **44.6 s -> 33.3 s (-25 %)** and
`tests/read_relation_hints_test` from **~121 s to ~92 s (-24 %)**, medians and not best runs (the
cross-family clearance record for `eb47024f`; that record's single same-workload run read 48.2 s ->
38.1 s, the same direction, and is not the figure used here).

Equivalence is a record, not an argument: `--list-relations` output is identical at parent
`c5cd7121` and tip `eb47024f` — 154 lines, 181 modules (clearance record; the commit body counts 151
of those lines as derived data paths). Safety was checked in the direction that actually loses a
test, under-selection: **0 tracked paths fail the guard** under `git ls-files`, under `LC_ALL=C` (so
locale matching cannot hide a high byte), and against a direct non-ASCII probe.

### Parallel execution: 1.92x wall at equal CPU (`fleet/parallel`, tip `8bd44611`)

Before this branch the gate ran ONE `deno test` invocation, sequential across files. Over a
~10-suite closure slice: **sequential 5:34.29 wall / user 300.94 s vs `--parallel` 2:54.09 wall /
user 318.73 s, both exit 0** — ~1.92x wall at equal CPU, so the win is overlap, not less work
(commit body `8bd44611`; the branch's own source comment records the same pair as 5m34s vs 2m54s on
8 CPUs). Deno 2.9.7 `--parallel` parallelises across test MODULES only; rows inside a file stay
serial. The two suites that mutate process-global state — `tests/verify_live_e2e_tts_output_test.ts`
(`Deno.chdir`) and `tests/temporal_test.ts` (`Deno.env` TZ) — are carved into a second sequential
batch in the same run loop and skipped entirely when not selected (`splitProcessGlobalSuites` over
`PROCESS_GLOBAL_SUITES`, `scripts/fast-check.ts` on that branch).

### Selection width is a deliberate NON-CHANGE, and this is the ruling

Fast gates keep dying at their bound on small diffs: **901 s and 903 s against the 900 s bound**
(the `ccb09239...` and `a6d54942...` records cited in the `CHECK_FAST_TIMEOUT` section above) and,
once the bound was 1800 s, **1801 s against it**
(`~/.fleet/checks/844ed4e3b932d9298d9f37d0b24cb230e2b25ede.fast.json`, `run_s=1801`, sha `f47f7fa4`,
2026-10-30T12:36:06Z, `INTERRUPTED`).

The weight is selection width, not a heavy suite. A change to a hub like `src/worker/script.ts` or
`src/tts/gemini.ts` selects that hub's whole relation closure — **~21 behavioural suites** — plus
the **nine computed-import suites that are selected for EVERY code change** as a fail-closed default
(`scripts/test-selection.ts`, audio-feed-8kiar, which attributes a computed import to every suite
whose closure reaches it; selection audit of 2026-10-30). The 1801 s record has the same shape on a
real diff: two hubs, a script and its pinned suite selected **124 test files** of a **165-module**
universe (`fast-gate: selection audit ok: 165 full-gate module(s)`, `fast-check: 124 test file(s)`,
same log).

Making comment-only diffs cheap was investigated on 2026-10-30 and **REJECTED**, on four grounds:

1. The comment-wording rows (beads audio-feed-ju820, audio-feed-f8o5o) are rows, so a comment-only
   diff must still be selected: it can legitimately red them.
2. Directive comments — `@ts-expect-error`, `deno-lint-ignore`, `/// <reference>` — change compiler
   outcomes with no code change, so "comment-only" is not "outcome-free".
3. Comment insertion shifts line numbers, and suites pin line numbers.
4. The only stripper available, `scripts/source-mask.ts:57-62`, documents its own silent
   under-detection holes: a regex literal is not masked, and a template nested inside another
   template's `${...}` is treated as code. Skipping suites with it would under-select in the silent
   direction.

**Ruling: raising the bound only moves the wall.** 900 s -> 1800 s produced a 1801 s kill on the
same kind of diff, so a wider bound is not a fix and must not become the lever. Narrowing the
fail-closed selection rules would trade slowness for a skipped test, and this repo refuses that
trade: a skipped test is the one outcome no bound can detect. **The correct lever is cost** — the
derivation figure and the overlap figure above. A slow gate is answered by making the gate cheaper,
never by widening what it may skip or how long it may run.

### A wait ceiling is a failure bound, never a delay (`fleet/waits`, tip `3b95c0c2`)

Nine fixed 5 s `waitFor` ceilings in `tests/synthesis_claim_lifecycle_test.ts` and
`tests/synthesis_worker_test.ts` became 45 s ABSENCE ceilings measured from the row's own action
start, keeping the 5 ms poll and making expiry name the waited-for signal plus the hook state at
expiry through a lazy describer (commit body and clearance record for `3b95c0c2`: all seven
claim-lifecycle sites and both worker sites enter `waitFor` synchronously after an un-awaited
kickoff, so each bound measures its own action; no assertion that follows a wait changed). One of
the replaced 5 s ceilings had reddened a gate after 66 minutes of work on a loaded host (the zy3j
record, `b8c0610c`).

**Rule: a ceiling is a FAILURE BOUND, measured from the action it bounds, never a delay.** A fixed 5
s ceiling is a delay claim — "this normally finishes in 5 s" — and on a loaded host it turns correct
code into a red gate, which is the same class as the elapsed-time rows in the section below.

## Tests must not assert on elapsed real time (audio-feed-n52j3)

Two of the three union-gate reds on 2026-10-23 had nothing to do with the branches under test: the
ROWS raced wall-clock time. One was `tests/listen_activity_test.ts`, row "the retry button's labels
are driven by real 429 bodies: rate refusal vs spent ceiling vs queued (audio-feed-8jzgl,
audio-feed-rvy5n)", fixed in d9571c40 by injecting the measured 429 bodies. The other was
`tests/synthesis_worker_test.ts`, row "audio-feed-091i: completed staging upload interrupted by
budget records a durable cleanup marker that sweeps on subsequent failure or ready", fixed under
audio-feed-krrws by injecting the budget's clock. Each cost a 20-27 minute full-gate run for every
lane queued behind it. A row that can fail because the HOST was slow while the code was correct is a
tax on every landing, so the rule is:

1. **A test asserts on an INJECTED clock, never on elapsed real time.** No
   `Date.now`/`performance.now` pair compared against a bound; no real `sleep(N)` whose adequacy the
   assertion depends on; no real timer raced against a production deadline on
   `REAL_INVOCATION_CLOCK`. Inject the clock the production seam already offers
   (`SynthesisWorkerOptions.clock` / `InvocationBudgetSpec.clock`, the `controlledInvocationClock`
   pattern in `tests/synthesis_resume_test.ts`; stub `performance.now` where that is the seam) and
   decide in the test WHEN the deadline arrives. The assertion then states an ORDER of operations
   ("the PUT started before the budget aborted the turn"), not a duration.
2. **Where a real bound is genuinely unavoidable** (timer liveness, complexity floors,
   absence-over-a-window proofs), the assertion must carry a comment naming the failure mode it
   produces on a loaded host and why the bound survives it. The compliant shape is
   `tests/c0gj_linear_complexity_test.ts`: minimum-of-N iterations, margins measured in tens of
   multiples of observed contention, the rationale in the header, and a negative control proving the
   bounds still fail the quadratic implementation. Widening a bound to silence a flake is NOT a fix
   — it moves the failure to a slower host and hides that the row tested timing rather than
   behaviour; the fix is to inject the input.
3. **Order facts beat clock facts.** `putCalls === 0` (preflight refused before any transfer),
   `putAborted === 1` (the deadline aborted the in-flight transfer), a durable marker written before
   the PUT — these are true or false regardless of scheduler noise. When a row currently expresses
   its property as milliseconds, rewrite the property as an order and keep at most a deliberately
   wide sanity bound with the comment from rule 2 (`audio-feed-y2ex` did this for the dv4p rows).

A new test that asserts on elapsed real time without the rule-2 comment is a review finding; a row
that reddens a gate on a loaded host gets the krrws treatment (inject the clock), not a wider bound.

**Cite a row by its `Deno.test` NAME, never by a line number (audio-feed-361l7).** Both pointers
above were first written as line numbers, and both were wrong within a day: `:684` landed on an
unrelated CDP typing interface and `:2000` on the pre-fix position, so a reader following them could
not see the row the rule is about. A row name is unique and line-independent; `grep -n` over the
file costs one command and cannot silently point at different code. The same standard applies to any
row cited from a doc or a bead.

## Real-clock budget rows: the census (`fleet/realtimeclock`, 2026-10-30)

Tonight's gate reds came from one shape: a row armed a product budget on the REAL clock and then
waited for an event that the budget could abort before, so the wait's condition was permanently
false and no ceiling could help (audio-feed-ugak, `src/synthesis/limits.ts`; the row is
`audio-feed-zy3j: terminal
completion invocation bound fires when delay exceeds budget (mirror)`). A
static sweep of `tests/` for that shape — `maxInvocationDurationMs`, `startTimeMonotonicMs`,
`withInvocationBudget`, `leaseMs`/`ttl`/`retryDelay`/`jitter`, `AbortSignal.timeout`, real timer
waits, `Date.now()` / `performance.now()` deltas, and polling helpers whose predicate depends on any
of those — classifies **79 sites (rows and guards) across 16 files**:

- **(a) immune, 28 sites** — the row passes the shared `clock`
  (`tests/fixtures/invocation_clock.ts`) or drives the shipped fake clock: the `dv4p`, `mv1d`,
  `avgc`, `o88z`, `091i`, `uswe0`, `5dxrk`, `flkk`/`4qmm` and `72nv9`-clocked rows, plus the
  `invocation_death_child` survive control.
- **(b) mostly safe, 43 sites** — real time is tolerated but only a boolean, an order, or a
  product-computed figure is asserted: preflight arithmetic pinned above the whole budget (`dv4p`
  preflight, `aqms` cannot-fit), state read after the batch settles, `observedMs`-style readings the
  product computes (monotone under load, never an upper bound), the `withInvocationBudget` block
  whose elapsed figure is reported and never asserted (`4qmm`), the rule-2 commented sanity/hang
  guards in `tts_hardening_test.ts`, `grounded_script_test.ts`, `s3_abort_socket_test.ts`,
  `storage_chunk_surrogate_test.ts`, `run_history_test.ts` and `c0gj_linear_complexity_test.ts`, and
  the "lower bound only" shape (`durationMs >= 25`).
- **(c) asserts a timing outcome on a real clock, 8 sites** — ranked, and only the first is fixed
  here:
  1. `audio-feed-lqd6: repeated terminal upload budget aborts advance uploadRetry counter and fail
     terminally upon exceeding maxUploadRetries`
     (`tests/synthesis_upload_budget_test.ts`). Real 1800 ms budget, 100 ms flush, and a terminal
     estimate of 1501 ms for 15 MB (ceil(15,000,044 / 10,000) = 1501 ms, correcting the 1511 ms slip
     in commit 2b0c91f2), so the preflight refuses once the pre-put path exceeds **199 ms** (1800 -
     100 - 1501 = 199 ms, correcting the 189 ms slip). Measured on this VM: the put is entered
     603-903 ms after tick start, so all three ticks paid 199 ms of margin against 600-900 ms of
     work — the hanging put was **never entered** and the row passed on the preflight-refusal path
     while its name and comment describe an interrupted transfer (probe: 0 put entries across 3
     ticks). **Fixed** by injecting the clock and firing the 1700 ms deadline after the put is
     observed in flight; every assertion unchanged; the probe now shows one put entry per tick.
  2. `audio-feed-lqd6: lost claim when exceeding retry cap reports superseded rather than failed (P1
     review finding)`
     — same 1800 ms budget and estimate, one tick; it asserts `superseded` on the same
     interrupted-upload path. Not fixed here (one-row budget).
  3. `audio-feed-zy3j: terminal completion invocation bound fires when delay exceeds budget (mirror)`
     — tonight's red; fixed on `fleet/starve` (audio-feed-zy3j round three) and not on `main` when
     this census was taken. Left alone so the unmerged fix is not duplicated.
  4. `audio-feed-vvwb: a stage that would take longer than the budget is aborted at the budget deadline
     and yields with progress checkpointed`
     (`tests/synthesis_claim_lifecycle_test.ts`) — readings half-injected (`performance.now`
     stubbed, the scheduler real): a real 40 ms deadline against a real 200 ms stage timer. Due
     order keeps it truthful at 5x, but it asserts `simulatedMs <= 45`, an elapsed figure. **Fixed**
     on `fleet/hazards` by injecting `controlledInvocationClock` through `runSynthesisBatch`'s
     `clock` option; the 40 ms deadline fires virtually while the script stage is in flight,
     removing `performance.now` stubbing and real timer races entirely.
  5. The hang rounds of `synthesis_invocation_death_test.ts` (`audio-feed-aqms` control and the
     child's 30 s budget) — the premise "the marker reaches the parent before the deadline" is a
     real-clock race, deliberately given ~30 s of headroom and a marker bound derived from the
     previous round's observed time (3x, min 20 s) rather than a clock.
  6. `retries honour Retry-After instead of the default backoff` (`tests/tts_hardening_test.ts`) —
     real clock, 5 s ceiling against a 0 ms backoff. **Fixed** on `fleet/hazards`: raised ceiling to
     10 s so scheduler contention on a loaded host cannot plausibly consume the margin, safely below the
     15,000 ms minimum default backoff (60,000 ms base capped at 30,000 ms with min 0.5 jitter =
     15,000 ms), with order assertion that 2 attempts occurred and returned valid audio.
  7. `a hung request is killed by the per-attempt timeout` (same file) — 5 s ceiling against a 150
     ms product timeout. **Fixed** on `fleet/hazards`: replaced the 5 s real-clock ceiling with an
     order assertion that the fetch signal was aborted, the timeout error message matches
     `/timed out after 150ms/`, and a lower-bound floor (`elapsed >= 100ms`). Load delay only
     increases elapsed time, making the assertion load-independent.
  8. `chunking completes promptly rather than spinning when a chunk cannot advance`
     (`tests/storage_chunk_surrogate_test.ts`) — a 10 s promptness bound on in-memory work.

Rows 4, 6 and 7 are fixed on `fleet/hazards`. Rows 5 and 8 carry the rule-2 comment and are kept as
written; they are listed so the next census does not have to rediscover them. What the fix in row 1
cost: no timing tolerance was added and no number was raised — the row's wall time is unchanged
within noise (5.9 s -> 6.6 s including the type-check), because the real budget it used to arm was
never the mechanism.

## Widening verdict boundary

These records are different gate workloads, not a same-workload before/after widening measurement.
Neither a comparable gate median/headroom nor a numerical changed-path frequency threshold is
established by them; therefore **no budget-backed accept/decline verdict for a proposed selection
widening follows from this document**. A standalone suite timing is not an end-to-end gate delta.
This is an explicit absence of a measured decision criterion, not an assertion that a particular
widening is acceptable.
