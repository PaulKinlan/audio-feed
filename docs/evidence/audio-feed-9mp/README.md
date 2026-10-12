# Browser Acceptance Proof: audio-feed-9mp

## Feature
Spend visibility and per-user daily episode budget:
- Surfaces per-user synthesis counts, generated audio bytes, and today's synthesis count in the admin dashboard (`GET /api/admin/stats` and `/admin` console).
- Displays total synthesised episodes in the operations metrics grid (`#statSynthesis`).
- Provides a DOM input field (`#newDailyBudget`) for an optional daily episode budget ceiling per subscriber on creation.

## Evidence Artifacts
- Script: `scripts/spend-visibility-browser-proof.ts`
- Asserts: Admin console contains `#synthesisBody`, `#statSynthesis`, and `#newDailyBudget` DOM elements.
- `01-admin-spend-visibility.png`: Screenshot of `/admin` console showing the "Synthesis by subscriber" table, "Episodes synthesised" metric, and the daily budget input in the subscriber creation form.
