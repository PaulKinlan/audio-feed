# Player source and text filtering

- Script: scripts/listen-filter-browser-proof.ts
- Asserts: initial 5 episodes present; initial count is '5 episodes'; filter by source shows 2 episodes; filter by text shows 1 episode; text filter is case-insensitive; non-matching query shows empty state honestly; empty state UI elements behave exclusively; clear button resets filter and row count; filter state is persisted across reload; filter state is scoped per-user; a11y tree exposes filter controls correctly; mobile layout has zero horizontal overflow at 390px
