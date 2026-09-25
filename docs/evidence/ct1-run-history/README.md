# audio-feed-ct1: each job keeps its own run history

What the admin dashboard's Operations card said in Chrome, before and after the fix.

Method: `scripts/admin-harness.ts` serves the real admin page with three hours of run
history recorded at production cadence, ending when the server starts. The feed poll ran
every 15 minutes and the synthesis cron every 2, and every synthesis tick was idle. Each
page was opened in Chrome at 1280x1500 and logged in with the harness token. The values
below were read back from the rendered DOM at 20:39 on 2026-09-25.

|                | BEFORE `d97c1b9`, poll cron stopped | AFTER `4383814`, poll cron stopped | AFTER `4383814`, both crons healthy |
| -------------- | ----------------------------------- | ---------------------------------- | ----------------------------------- |
| Last feed poll | **never**                           | 2h ago                             | 25m ago                             |
| Avg poll time  | —                                   | 1045ms                             | 1195ms                              |
| Its note       | Mean of the last 10 polls.          | Mean of the last 4 polls.          | Mean of the last 10 polls.          |
| Runs recorded  | 50: "Newest 50 kept."               | 54: "Newest 50 of each job kept."  | 62: "Newest 50 of each job kept."   |
| Runs table     | 20 rows: 0 polls, 20 synthesis      | 14 rows: 4 polls, 10 synthesis     | 20 rows: 10 polls, 10 synthesis     |

Before the fix, the dashboard had three faults:

- A poller whose last run was more than two hours earlier read as one that had never run.
- The average was empty, but its note still said ten polls.
- Every row of the runs table was an idle synthesis tick.

## Reproduce

    deno run --allow-all --unstable-kv scripts/admin-harness.ts 8147           # both crons healthy
    deno run --allow-all --unstable-kv scripts/admin-harness.ts 8148 stopped   # poll cron stops 1 h in

Open `http://localhost:<port>/admin`, paste `harness-admin`, and press **Save token**.

The script was added after `d97c1b9`. For the BEFORE column, copy it into a checkout of
`d97c1b9` and run it there.

From audio-feed-0ob on, a run of idle synthesis ticks is kept as one row, the latest. At
those commits the harness shows one synthesis row where the AFTER columns show ten, and
"Runs recorded" counts that stretch once.
