# audio-feed-khk3 — unbounded paid synthesis when no budget is configured

- Script: scripts/repro_khk3_unbounded_budget.ts
- Asserts: cron batch clamps paid TTS calls to deployment default (50); every paid call produced a ready episode; excess episodes deferred past ceiling; deferral reason cites deployment default ceiling; store daily synthesis count matches ceiling; manual route charges configured ceiling of 1; stats endpoint advertises configured ceiling of 1

## Overview

`before.json` and `repro.json` are the same measurement run against the same script
(`scripts/repro_khk3_unbounded_budget.ts`): one approved subscriber with **no**
`dailyEpisodeBudget`, 60 episodes queued, twelve worker ticks that all land in the same UTC day —
the production shape, since the synthesis cron runs every two minutes. The synthesizer counts paid
calls, so `paidTtsCalls` is money rather than a proxy for it.

| | `before.json` (unfixed) | `repro.json` (fixed) |
| --- | --- | --- |
| `paidTtsCalls` | **60** | **50** |
| `readyTotal` | 60 | 50 |
| `deferredTotal` | 0 | 10 |
| `firstTickWithDeferral` | `null` | 10 |
| `deferReasons` | `[]` | `daily episode budget exceeded (limit: 50, used: 50, source: deployment default - no per-user budget configured)` |

Before: every queued episode was synthesised, nothing was ever deferred, and the store's count for
the day reached the queue depth — the ceiling did not exist on this path at all, because the
enforcement condition was `typeof user.dailyEpisodeBudget === "number" && >= 0` and `undefined`
failed it.

After: spend stops at the deployment default, the ten episodes past it are deferred (still
`pending`, so tomorrow serves them), and the reason says the ceiling was a default rather than a
decision somebody made. The fixed run also logs, once per run:

```
[audio-feed] holding work for user unbudgeted-user at the deployment default daily ceiling of 50
(no per-user budget configured; set DEFAULT_DAILY_EPISODE_BUDGET or this subscriber's budget) (audio-feed-khk3)
```

Reproduce either side:

```sh
# measure only
timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_khk3_unbounded_budget.ts
# regression gate: exit 1 if more than 50 paid calls
timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_khk3_unbounded_budget.ts 50
```

`tests/synthesis_budget_test.ts` pins the same properties at the unit and HTTP level: the unset case
is bounded, the configured path's wording and semantics are unchanged (audio-feed-9mp's own test in
`tests/synthesis_worker_test.ts` still reads the exact string it did), an unusable explicit budget
(NaN, negative, Infinity) falls back to the ceiling instead of removing it, the effective ceiling is
a finite number for every input combination, the log fires once per run, and
`GET /api/admin/stats` reports each subscriber's ceiling and its source.

## audio-feed-v2ym — the ceiling on every path, not just cron

`manual-path-v2ym.json` is the reviewer's reproducer, run against the fixed tree: a deployment
ceiling of **1**, 60 episodes queued for one unbudgeted subscriber, and twelve requests to the real
`POST /api/admin/synthesize-now` route. Result: **1 paid call**, and `/api/admin/stats` advertises 1.

The finding was that the first cut resolved the deployment ceiling at the **call sites**, so only
cron honoured `DEFAULT_DAILY_EPISODE_BUDGET`: the manual route and `startSynthesisWorker` charged the
constant (the reviewer measured 50 paid calls where the ceiling was 1), while the dashboard read the
config and advertised the limit they were not applying — visibility making a false claim about the
thing it exists to show.

The fix removes the possibility rather than the instance: `runSynthesisBatch` resolves the ceiling
itself from `ctx.config` (explicit option, then config, then constant), `defaultDailyEpisodeBudget`
is deliberately not a key of the worker's `DEFAULTS` (a default spread into the options object masked
the config — that was the mechanism), and cron no longer threads anything. A new call site cannot get
it wrong, because there is nothing for it to pass. The test drives all three real entry points — the
admin route over HTTP, the poll loop's own first tick, and cron's no-options call — plus the
dashboard, and asserts all four agree on the number.
