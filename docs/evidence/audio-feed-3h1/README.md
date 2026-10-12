# Player source and text filtering

- Script: scripts/listen-filter-browser-proof.ts
- Asserts: initial load shows 5 rows and '5 episodes'; source filter updates count to '2 of 5 episodes'; visible rows belong exclusively to 'The Verge'; text filter updates count to '1 of 5 episodes'; empty state names the active filters honestly; generic 'No episodes yet' empty state is hidden while filter is active; clearing filters restores '5 episodes'; filters survive reload on the same token; filter state is scoped per-user; a11y tree includes search role landmark; mobile layout has zero horizontal overflow at 390px
