# Browser Acceptance Proof: audio-feed-3h1

## Feature
Client-side source and text filtering over the player's loaded episode and activity list:
- Source dropdown populated dynamically from unique subscribed sources across episodes and activity items.
- Text search input matching case-insensitively across title, author, and source.
- Clear action button to reset all active filters.
- Consistent filtering: filters apply to both episodes and activity panels so the entire view represents the chosen publication/query.
- Honest counts: header displays "X episodes" when unfiltered, and "N of X episodes" when filtered.
- Honest empty state: when filtering yields 0 results, `#filterEmpty` displays "No episodes match source \"...\" and search \"...\"" with a "Clear filters" button, while generic `#empty` ("No episodes yet") stays hidden.
- Per-token persistence: stored in `localStorage["audio-feed-filter:${TOKEN}"]`, surviving reloads and isolating subscribers on shared devices.
- Fully accessible and responsive with zero horizontal overflow at 390px.

## Accessibility Tree Extract (CDP Accessibility.getFullAXTree)
```json
{
  "role": { "type": "internalRole", "value": "search" },
  "name": { "type": "computedString", "value": "Filter episodes" },
  "children": [
    {
      "role": { "type": "internalRole", "value": "searchbox" },
      "name": { "type": "computedString", "value": "Filter episodes by title or author" },
      "focusable": true
    },
    {
      "role": { "type": "internalRole", "value": "combobox" },
      "name": { "type": "computedString", "value": "Filter by publication" },
      "focusable": true
    }
  ]
}
```

## Evidence Artifacts
- `01-listen-filter-desktop.png`: Screenshot of desktop view (1280x900) showing filtered Stratechery episodes, "3 of 5 episodes" count, and active search controls.
- `02-listen-filter-mobile-390.png`: Screenshot of mobile view (390x844) showing clean wrapped filter inputs with zero horizontal overflow.
- Automated proof: `scripts/listen-filter-browser-proof.ts`.
