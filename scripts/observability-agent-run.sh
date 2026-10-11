#!/bin/sh
# Observability agent poll - stamp-guarded runner (audio-feed-yl6b).
#
# Installed BEHIND AN EXISTING TIMER rather than as its own unit, which is the convention the fleet's
# cadence scripts use: a cheap five-minute timer calls this, and the stamp decides whether the hourly
# job actually runs. Two properties fall out of that, and both matter for a job that spends money:
#
#   1. THE STAMP IS TOUCHED BEFORE THE RUN, so a crash or a model failure costs one skipped hour rather
#      than a retry storm. A cap that retries is not a cap, and a runner that retries is how a cap
#      becomes decorative.
#   2. Writes nothing when there is nothing to do. An idle hour exits immediately and silently.
#
# Usage: observability-agent-run.sh [--interval-seconds N] [--dry-run]
#   Env: AUDIOFEED_OBSERVABILITY_AGENT_ENABLED=1 and AUDIOFEED_OBSERVABILITY_KEY are required, or the
#        poll exits having done nothing at all (it makes no network call and no model call when disabled).
set -eu

INTERVAL=3600
DRY_RUN=""
STATE_DIR="${AUDIOFEED_AGENT_STATE_DIR:-$HOME/.local/state/audio-feed-observability-agent}"
REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --interval-seconds) INTERVAL="$2"; shift 2 ;;
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

mkdir -p "$STATE_DIR"
STAMP="$STATE_DIR/last-run.stamp"
LOG="$STATE_DIR/last-run.log"

now=$(date +%s)
if [ -f "$STAMP" ]; then
  last=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$INTERVAL" ]; then
    # Not due yet. Exit silently: this path runs every five minutes and must not produce log noise.
    exit 0
  fi
fi

# Touch the stamp FIRST so a failure cannot lead to a retry loop, then bound the run.
touch "$STAMP"

# The poll has its own hard ceilings; this timeout is the outer bound so a hung fetch cannot hold a
# timer slot. 137 means it was killed, which the artifact will show as no completed run.
timeout -k 30 600 deno run -A "$REPO_DIR/scripts/observability-agent-poll.ts" \
  --state-dir "$STATE_DIR" $DRY_RUN >"$LOG" 2>&1 || status=$?

status=${status:-0}
case "$status" in
  0) : ;; # idle, disabled, ranked, or nothing to do
  2) echo "[observability-agent] a spend cap stopped this run; see $LOG" >&2 ;;
  *) echo "[observability-agent] run failed with status $status; see $LOG" >&2 ;;
esac

# PROPAGATE, do not swallow (audio-feed-9l6v). Ending with exit 0 here made a capped or failed run look
# like a success to whatever scheduled it, which is the opposite of fail-closed: a cap is only real if
# the run is observably not-ok. The stamp above is touched BEFORE the run, so a non-zero exit cannot
# cause a retry storm - it costs one skipped interval, which is the intended trade.
exit "$status"
