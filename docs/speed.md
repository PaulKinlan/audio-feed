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
  test pass (`scripts/fast-check.ts:811-849,1149-1177`).
- `.ts` data-read admission is **partial today**: resolver-proven paths (`resolvedPaths`) are
  admitted, while literal `authoredPaths` and dynamic reads are not admitted and the explicit
  declaration escape hatch is **not built** (`scripts/test-selection.ts:1500-1549`). Unresolved read
  hints disable the _inert-document_ shortcut when the planner otherwise has no tests and an inert
  path, not all affected-only selection (`scripts/fast-check.ts:818-841`).

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

## Tests must not assert on elapsed real time (audio-feed-n52j3)

Two of the three union-gate reds on 2026-10-23 had nothing to do with the branches under test: the ROWS
raced wall-clock time (`tests/listen_activity_test.ts:684`, fixed in d9571c40 by injecting the measured
429 bodies; `tests/synthesis_worker_test.ts:2000`, fixed under audio-feed-krrws by injecting the budget's
clock). Each cost a 20-27 minute full-gate run for every lane queued behind it. A row that can fail
because the HOST was slow while the code was correct is a tax on every landing, so the rule is:

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

## Widening verdict boundary

These records are different gate workloads, not a same-workload before/after widening measurement.
Neither a comparable gate median/headroom nor a numerical changed-path frequency threshold is
established by them; therefore **no budget-backed accept/decline verdict for a proposed selection
widening follows from this document**. A standalone suite timing is not an end-to-end gate delta.
This is an explicit absence of a measured decision criterion, not an assertion that a particular
widening is acceptable.
