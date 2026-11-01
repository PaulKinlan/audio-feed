# Browser Acceptance Proof: audio-feed-9mp

- Script: scripts/spend-visibility-browser-proof.ts
- Notes: Debt: admitted (audio-feed-tgnu)
- Asserts: synthesis table exists in admin console; statSynthesis exists in operations grid; daily budget input exists in create form

## Feature

Spend visibility and per-user daily episode budget:
- Provides admin console container element for per-user synthesis statistics (`#synthesisBody`).
- Displays operations metrics grid element for synthesised episodes (`#statSynthesis`).
- Provides a DOM input field (`#newDailyBudget`) for an optional daily episode budget ceiling per subscriber on creation.

## Evidence Artifacts

- `01-admin-spend-visibility.png`: Screenshot of `/admin` console showing the "Synthesis by subscriber" table, "Episodes synthesised" metric, and the daily budget input in the subscriber creation form.
