# audio-feed-8u4x1 — the exww run bound, derived from measurement

- Script: scripts/exww-attempt-measure.ts
- Executed by: tests/exww_mutants_test.ts
- Asserts: the committed attempt distribution derives ratio 2 and base 240000 under the stated rules
  — recomputing `deriveLadderConstants` over the uncensored `seconds` in `attempts.json` yields
  exactly the constants in `scripts/exww-mutants.ts` (`EXWW_RUN_LADDER_RATIO`,
  `EXWW_RUN_BASE_GUARD_MS`); no attempt was censored; the ladder top stays inside the fleet's 5400s
  gate budget

## What was measured

The unmutated coao proof (`scripts/exww-live-claims-browser-proof.ts` — the run the mapped suite
guards, and the one killed at 240.6s and 241.2s under gate load on 2026-10-28) was executed **12
times** in the harness's scratch tree, attempts strictly sequential (one headless browser at a
time), each under a 600s per-attempt bound. `attempts.json` carries every attempt's wall seconds,
the 1-minute load average before/after, and the timestamp.

- p50 67.0s, p90 84.2s, p99 88.0s (nearest-rank over uncensored attempts; n=12, so p99 IS the worst
  observed attempt)
- 0 attempts censored
- derived: ratio = max(2, ceil(88.0/67.0)) = **2**; base = max(240s, ceil-to-60s(88s)) = **240s** —
  both constants the tree already carried are the data's answer; nothing moved
- **what actually binds, stated plainly (coord, audio-feed-op6yb):** the RATIO's measured term is
  1.31 and the BASE's measured term is 120s — both sit under their floors, so **the floors bind**
  (ratio: the strictly-increasing floor of 2; base: the r6hft quiet-guard floor of 240s). The
  measurement does not set today's constants; it HOLDS THE FLOORS HONEST — re-measured p99 over
  240s moves the base, p99/p50 at or over 2 raises the ratio, and the pin recomputes both from
  this file so a constant that drifts from the data reds the suite.
- **supersession (audio-feed-op6yb):** main's prose carried an unconditioned three-run figure
  (238.7s / 221.4s / 221.0s, no load regime recorded). It sits ~3x over this campaign's p50 with
  bound-adjacent completions (238.7s under a 240s guard) — the shape full-gate load produces, and
  this VM's full gate swung 28m30s → 54m35s (~1.9x) on identical suite counts the same day. Rather
  than reconcile a figure that recorded no conditions, this conditioned campaign REPLACES it as
  the measurement of record.

## The load regime, stated plainly

The campaign ran 2026-10-29 ~07:07–07:22 UTC alongside the fleet's gates, and the observed 1-minute
load average ranged **1.7–4.7** — quiet to moderate, NOT the 5–13 regime observed through
2026-10-28. The distribution above is honest for the regime it ran in, and the ladder is the
mechanism for the heavier one: a load-driven tail does not move these constants, it produces
bound-kills, and each observed kill doubles the next attempt's bound (audio-feed-ybwj7's
kill-derived design). The constants are the floor the quiet-to-moderate regime measured; the ladder
absorbs the rest. A re-run under a heavier regime is one command (the `reproduce` line in
`attempts.json`), and the pin in `tests/exww_mutants_test.ts` recomputes this file's derivation, so
new data that demands different constants turns the suite red until the constants move with it.

## Derivation rules (the same function the suite runs)

- ratio = max(2, ceil(p99/p50)) — the floor is the ladder's strictly-increasing invariant; the data
  may only raise it. Here p99/p50 = 1.31, so the FLOOR is what set the ratio: the 2x is margin by
  rule, not a property of this distribution.
- base = max(240s, ceil-to-60s(p99)) — the floor is the original r6hft quiet guard, never narrowed
  without cause; p99 (88s) sits far under it, so the guard stands as measured.
- the ladder top (base × ratio^(MAX_ATTEMPTS−1) = 960s) must stay inside the fleet's 5400s gate
  budget (docs/speed.md) — 240 + 480 + 960 fits with room for the mutant run.
- a bound-killed attempt is censored and excluded from the percentiles; more than 20% censored is
  INCONCLUSIVE and derives nothing.

Reproduce:

    deno run --allow-read --allow-write --allow-run=timeout,deno --allow-sys --allow-env scripts/exww-attempt-measure.ts
