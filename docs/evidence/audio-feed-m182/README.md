# audio-feed-m182 — the ceiling on total TTS spend, not just on one subscriber

## The problem

khk3 gave every subscriber a daily ceiling (default 50). That bounds one subscriber and leaves the
total linear in the number of _approved_ subscribers — and approving one is a single button. Nothing
else in the deployment bounded the sum: only the admin approval gate and the worker's own
throughput, neither of which is a spending limit.

## What was measured

`scripts/repro_m182_global_ceiling.ts` drives the real synthesis worker over three subscribers with
three episodes each (nine paid calls available) and reports what was actually paid. The counter it
depends on is written when an episode is really synthesised, so this is the only way to see the
ceiling operate.

| nine queued episodes, three subscribers       | before           | after (ceiling 4)                                                        |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| paid TTS calls                                | **9**            | **4**                                                                    |
| episodes still pending (deferred, not failed) | 0                | **5**                                                                    |
| the day's fleet counter                       | (does not exist) | 4                                                                        |
| deferral reason                               | —                | `daily spend ceiling reached across all subscribers (limit: 4, used: 4)` |

`before.json` is the pre-change tree (the option does not exist there, and `deno run` does not
type-check, so it is simply ignored). `repro.json` is the tree with the ceiling. The script fails
rather than reports: it checks that the ceiling was reached exactly, that the remainder is _pending_
and not _failed_, that the day counter agrees with the calls paid, and that some reason named the
fleet ceiling.

## The shape, mirroring khk3

- Resolved `explicit option -> deployment config -> constant`, **inside the worker** at both the
  gather pass and the spend gate, so no entry point that synthesises can forget it (the v2ym lesson:
  a call site that forgot was exactly how the per-subscriber ceiling leaked).
- `DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET = 500`, deliberately ten subscribers' worth at the
  per-subscriber default. High enough that a small deployment never meets it by accident, finite so
  the sum cannot run away while nobody is watching. `GLOBAL_DAILY_EPISODE_BUDGET` sets it; 0 means
  nothing is synthesised.
- An unusable value (NaN, negative, Infinity) counts as ABSENT, not unlimited, so no future refactor
  can hand it a number that means "no ceiling" — the same property khk3 asserts for the
  per-subscriber ceiling, asserted here over the helper.
- Exceeding it DEFERS: the episodes stay pending and the next UTC day serves them. Nothing is failed
  and nothing is spent.
- The day counter is incremented in the **same store write** as the per-user counter, and the
  conformance suite asserts the fleet total equals the sum of the per-user counts, because a ceiling
  measured against a counter that can drift from the per-subscriber ones is a ceiling on the wrong
  number.

## An interaction worth knowing (found by a failing test)

The two ceilings interact, and the first version of the test got it wrong in an instructive way: a
single subscriber on the shipped per-subscriber default stops at 50, so one subscriber can never
reach a fleet ceiling of 500. Ten of them do. That is not a defect — it is the sizing rationale —
and it is now asserted explicitly in both directions: a fleet ceiling is a backstop, not a
replacement, and neither reason is reported as the other.
