# Audio Feed Gate Speed

## Executed contract

- On this VM, implementers run
  `FLEET_CHECK_CONF=$HOME/.fleet/check-audio-feed.conf fleet-check --fast`; the merger uses the same
  override with `fleet-check` once on the merged union (`AGENTS.md`, “Fast test tier”).
  `~/.fleet/check-audio-feed.conf` sets `CHECK_FAST_CMD="deno task test:fast"` and
  `CHECK_CMD="deno task gate"` (both tasks exist in `deno.json:30,34`). The fleet default
  `~/.fleet/check.conf` names `tools/fast-gate.sh` and `tools/full-gate.sh`, which do **not** exist
  in this repository; unqualified `fleet-check` is not this repo's gate.
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
below is **one observed gate run**, not a median, target or guaranteed duration. The repo tasks in
`deno.json` define no wall-time target. A runner timeout is a ceiling, not a measured speed budget.

| Gate | Exact cached record and reproduction                                                                                              | Observed execution |         Queue | Coverage  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | -----------------: | ------------: | --------- |
| Fast | `fleet-check --status --fast b1fcb837` (tree `f970ad7b`, log `~/.fleet/checks/f970ad7be3ac467a8fbbf5be1a6e6062d0816e24.fast.log`) |       `run_s=11` s | `wait_s=14` s | 2 suites  |
| Fast | `fleet-check --status --fast d20fc5c5` (tree `25f34298`, log `~/.fleet/checks/25f342983e281a0587d0c2918c5f1bc62a43ea10.fast.log`) |       `run_s=35` s |  `wait_s=7` s | 6 suites  |
| Full | `fleet-check --status 793ea22a` (tree `25f34298`, log `~/.fleet/checks/25f342983e281a0587d0c2918c5f1bc62a43ea10.log`)             |      `run_s=185` s |  `wait_s=0` s | full gate |

## Widening verdict boundary

These records are different gate workloads, not a same-workload before/after widening measurement.
Neither a comparable gate median/headroom nor a numerical changed-path frequency threshold is
established by them; therefore **no budget-backed accept/decline verdict for a proposed selection
widening follows from this document**. A standalone suite timing is not an end-to-end gate delta.
This is an explicit absence of a measured decision criterion, not an assertion that a particular
widening is acceptable.
