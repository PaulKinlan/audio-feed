# Admin and Player Failed Episode Retry Verification: audio-feed-6y9

## Observed Behavior
1. **Admin Console (/admin)**:
   - Header provides a dedicated `#regenFailed` button: **"Retry failed (1)"**.
   - Episode row with `status: "failed"` displays a red **failed** badge and the exact error explanation (`Gemini API error: 429 Quota Exceeded for audio model`).
   - Episode row renders an inline **"Retry"** button that prompts confirmation and re-queues the episode for synthesis.
2. **Web Player (/listen/:token)**:
   - Activity panel is visible and lists the failed episode.
   - Highlights the exact failure reason in `.act-error` alongside the **"Try again"** button.
   - Paging does not displace failed episodes because `listEpisodes({ status: "failed" })` feeds the activity panel explicitly.
3. **Subscriber Account (/account)**:
   - Header renders **"Retry failed (1)"** button.
   - Failed episode row renders inline **"Retry"** button and error detail.

## Test Results
```
PASS  admin shows 'Retry failed (1)' button in header  got: 'Retry failed (1)'
PASS  failed episode row renders inline 'Retry' button  Retry button present
PASS  failed episode row displays error detail  error: 'Gemini API error: 429 Quota Exceeded for audio model'
PASS  player activity panel displays failed episode error detail  activity error: 'Gemini API error: 429 Quota Exceeded for audio model'
PASS  player activity panel renders 'Try again' button  Try again button present
PASS  account page shows 'Retry failed (1)' button in header  got: 'Retry failed (1)'
PASS  account page renders inline 'Retry' button on failed episode  Retry button present
```

## Screenshots
- `01-admin-retry-failed-episodes.png`: Admin console with "Retry failed (1)" and inline "Retry" button.
- `02-player-activity-failed-episode.png`: Web player activity panel showing failed episode, error message, and "Try again" button.
- `03-account-retry-failed-episodes.png`: Account page showing "Retry failed (1)" and inline "Retry" button.
