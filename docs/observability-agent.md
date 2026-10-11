# Observability agent poll (obs-3, audio-feed-yl6b)

An hourly job that reads the [observability API](./observability-api.md) with a durable cursor, asks a
model to rank what is **new** as suggested fixes, and files those as beads. The wanted output is "here is
what is failing and here is the change that makes it resilient" - not a dump of counts.

## Why this is a script and not a Deno.cron job in the app

Two reasons, and the second is the one that decides it:

1. **The app cannot file beads.** `Deno.Command` is not used anywhere in `src/`, and a Deno Deploy isolate
   has neither a git checkout nor a `bd` binary. The thing that files beads has to be the thing that has
   beads.
2. **A model call is long by nature.** `audio-feed-siv1` was a synthesis that died *silently* because it
   outlived the `Deno.cron` isolate lifetime bound. An hourly job whose defining step is a model call
   belongs outside the isolate, where its bound is the timer rather than the platform.

So the job is a script on a VM timer. It reuses the *rule* the fleet's cadence scripts embody - one place
records a run with its caps and its skip reason, one place decides whether this interval runs - rather than
importing app modules that cannot reach the things this job needs.

## Enabling it

**Off unless explicitly enabled.** Both are required:

```sh
export AUDIOFEED_OBSERVABILITY_AGENT_ENABLED=1
export AUDIOFEED_OBSERVABILITY_KEY=...      # the same bearer key the errors API requires
export AUDIOFEED_OBSERVABILITY_BASE_URL=https://your-deployment  # default http://localhost:8000
export GEMINI_API_KEY=...                   # required for the ranking call
```

A disabled poll makes **zero network calls and zero model calls**, and says so in its artifact. A key held
for other reasons cannot start spending: the flag and the key are separate conditions on purpose.

Optional: `AUDIOFEED_AGENT_MODEL` (default `gemini-2.5-flash`), `AUDIOFEED_AGENT_STATE_DIR`,
`--bd-bin <path>`, `--dry-run`, `--json`.

## Scheduling

Install **behind an existing five-minute timer** rather than adding a unit, using the fleet's stamp
convention:

```sh
# in your timer script, alongside the other cadence checks
st="$HOME/.local/state/audio-feed-observability-agent/last-run.stamp"
if [ ! -f "$st" ] || [ $(( $(date +%s) - $(stat -c %Y "$st") )) -gt 3600 ]; then
  bash "$REPO/scripts/observability-agent-run.sh" --interval-seconds 3600
fi
```

`scripts/observability-agent-run.sh` already does this, including touching the stamp **before** the run so a
crash or a model failure costs one skipped hour instead of a retry storm. On a fleet VM the line to add is
in the existing `remote/sync-canonical.sh` cadence block, which is a change in a different repository.

## The cost envelope

Every one of these is a hard bound, and any hit means **no model call, non-zero exit, and a reason in the
artifact**. Nothing is retried inside a run.

| Bound | Value |
| --- | --- |
| Model calls per run | exactly 1 |
| Events sent per run | 200 **oldest**, or 64KB of rendered prompt, whichever comes first |
| Output per call | ~2k tokens |
| Calls per UTC day | 24 (the hourly maximum) |
| Input tokens per UTC day | 400,000 |
| Output tokens per UTC day | 50,000 |

Two properties make the realistic cost far lower than the ceiling:

- **Idle hours cost nothing.** `GET /api/observability/summary` answers "has anything changed" without
  fetching events, so a run with no movement makes **no model call at all**. That is a bound by
  construction, not a cap checked afterwards.
- **Dedupe prevents re-ranking the same root cause.** Before any spend, the run lists open beads and skips
  events whose fingerprint is already open.

The counters are incremented **before** the call, so a run killed mid-call cannot have spent unrecorded.

## Oldest-first, and why the backlog is reported

The run processes the **oldest** unprocessed events, and advances the cursor only past what it actually
sent. Taking the newest would advance the cursor past older events that were never analysed - the same
silent skip the `410` handling exists to prevent. A backlog therefore drains over hours instead of being
lost, and the artifact states the depth, the pages remaining, and the age of the newest unprocessed event.

When the newest unprocessed event is older than six hours, the poll files a bead **about itself**: a
structurally behind poll is an operational signal. That bead carries a **stable constant** fingerprint, so
a backlog persisting for days keeps one open bead instead of filing an hourly one.

## Dedupe fingerprints

A SHA-256 over exactly three normalised fields:

| Field | Example | Why this |
| --- | --- | --- |
| `type` | `synthesis.claim` | the store's own stable dotted classifier; `src/storage/mod.ts` documents it as the thing "obs-1 counts by it and obs-3 ranks by it" |
| severity band | `high` | a 500 and a 503 are one problem, not two beads |
| route | `/api/items/:id` | volatile path segments collapsed so per-request ids do not split one cause |

The raw message, timestamp, correlation id, episode id and cursor are **deliberately excluded**: any of
them changes the fingerprint every hour, which would defeat the mechanism completely.

## The artifact

Two files in the state directory, written on **every** run including the ones that do nothing:

- `state.json` - cursor, daily counters, last run time, and the full artifact
- `digest.md` - the same run in words, for reading without a terminal

The artifact records counts read and sent, which caps applied, skipped/truncated/capped reasons, the
fingerprints seen, filed and skipped, filed bead ids, the backlog depth and pages remaining, and any
retention gap. It is **not** a store of ranked output: beads are primary and the dashboard is the reader,
and the API's own rule is one store and no second index.

## Retention

The cursor is the `seq` of the last event consumed. Every errors response carries
`window: { oldestRetained, newest }`, and expiry is one rule with no empty-store special case. On a `410`
the poll resumes from the sequence the problem body names **and records the gap**, because a poll that
silently skips forward is lying about its own coverage.

## What it does not do

- It does not open GitHub issues: internal work is beads.
- It does not store ranked output anywhere but beads and the digest.
- It does not retry, escalate, or spend past a cap.
- It does not verify the fixes it suggests. A filed bead carries the model's reasoning as a **hypothesis**
  to check against the code, which the bead description says in as many words.
