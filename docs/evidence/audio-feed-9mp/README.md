# Browser Acceptance Proof: audio-feed-9mp

## Feature
Spend visibility and per-user daily episode budget:
- Surfaces per-user synthesis counts, generated audio bytes, and today's synthesis count in the admin dashboard (`GET /api/admin/stats` and `/admin` console).
- Displays total synthesised episodes in the operations metrics grid (`#statSynthesis`).
- Allows setting an optional `dailyEpisodeBudget` per subscriber on creation.
- Enforces an optional daily episode budget ceiling in worker synthesis: when exceeded, new episodes are deferred with a reason stating the budget limit and usage without consuming the attempt budget or billing audio.
- Resets budget counter cleanly at 00:00:00 UTC midnight (`utcDayKey`), picking up previously deferred episodes automatically on the next day.
- Single-user default: `dailyEpisodeBudget` is undefined by default, producing unlimited synthesis with zero behavior change.

## Evidence Artifacts
- `01-admin-spend-visibility.png`: Screenshot of `/admin` console showing the "Synthesis by subscriber" table, "Episodes synthesised" metric, and the daily budget input in the subscriber creation form.
- Automated browser proof: `scripts/spend-visibility-browser-proof.ts`.
