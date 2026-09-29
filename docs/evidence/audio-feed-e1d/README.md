# Failure Diagnostics and Error Visibility Verification: audio-feed-e1d

## Observed Behavior
1. **Admin Console (/admin)**:
   - The Runs table detects failed item count (`failed > 0`) and renders an expandable `<details class="run-errors">` element.
   - Clicking the summary expands the details in place without page navigation or modal popups.
   - The expanded log visibly renders the list of exact failure reasons (`Gemini API error: 429 Quota Exceeded` and `article content exceeds input limit`).
2. **Web Player (/listen/:token)**:
   - When offline audio download fails (e.g. HTTP 404 from storage), the error reason is not merely flashed in a toast; it is preserved directly on the episode row in `.ep-download-error`.
   - The error text honestly reports `Download failed: HTTP 404`.

## Test Results
```
PASS  admin runs table renders <details class='run-errors'>  run-errors details present
PASS  clicking summary expands the run errors log  details is open
PASS  expanded log visibly renders exact failure reasons  Episode ep-1 ("Autonomous Systems"): Gemini API error: 429 Quota ExceededEpisode ep-2 ("Microservices Review"): article content exceeds input limit
PASS  player renders exact download failure reason on the episode row  got: 'Download failed: HTTP 404'
```

## Screenshots
- `01-admin-runs-expanded-errors.png`: Admin runs table with expanded `<details class="run-errors">` log.
- `02-player-download-error-inline.png`: Web player with inline `.ep-download-error` on the episode row.
