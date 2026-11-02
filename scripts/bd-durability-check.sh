#!/usr/bin/env bash
# bd-durability-check.sh — repeatable durability check for the beads Dolt database.
#
# WHY THIS EXISTS (2026-11-02, audio-feed-a1bm8): bd auto-backup failed with
# "error opening table file: table file not found" because the Dolt-native backup
# destination (.beads/backup, archive format) was truncated: its manifest referenced
# 197 table-file addresses but only 3 .darc chunks were present on disk. Because
# auto-backup turns ON by default in embedded mode when a git remote exists, every
# write-capable bd invocation walks this broken backup path, so bd writes time out
# or drop silently. The same error text ("table file not found") is the fleet's
# known signature of concurrent embedded-Dolt access corrupting table files.
#
# WHAT IT CHECKS (exit non-zero on any failure):
#   1. Backup-manifest consistency (pure file check, cheap, no DB lock):
#      every 32-char table-file address referenced by .beads/backup/manifest
#      must exist as a .darc chunk in backup/ or backup/oldgen/. The all-zeros
#      address is the journal marker and never exists as a file — that is normal.
#   2. Timed live round-trip: bd create -> bd show read-back -> bd delete,
#      each bounded by BD_DURABILITY_TIMEOUT (default 60s; bd is wrapped by the
#      fleet shim's flock, so a timeout here means real contention or a hang).
#      Warns (does not fail) on any call slower than BD_DURABILITY_SLOW (default 5s).
#   3. Backup round-trip: bd backup sync, then bd backup restore into a scratch
#      directory, then read the test bead back FROM THE RESTORED COPY.
#      Skippable with --skip-restore for fast cycles (then check 3 is not run and
#      this is reported; exit code still reflects 1 and 2 only).
#
# Usage (nightly):
#   scripts/bd-durability-check.sh                 # full check
#   scripts/bd-durability-check.sh --skip-restore  # manifest + live round-trip only
# Env:
#   BEADS_DIR                    bead DB dir (default: discovered via `bd where`)
#   BD_DURABILITY_TIMEOUT=60     per-bd-call timeout in seconds
#   BD_DURABILITY_SLOW=5         warn threshold per call in seconds
#   BD_DURABILITY_KEEP=1         keep the scratch restore dir for inspection
set -u

SKIP_RESTORE=0
for arg in "$@"; do
  case "$arg" in
    --skip-restore) SKIP_RESTORE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

TIMEOUT="${BD_DURABILITY_TIMEOUT:-60}"
SLOW="${BD_DURABILITY_SLOW:-5}"
FAILS=0

fail()  { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }
pass()  { echo "ok:   $*"; }
warn()  { echo "warn: $*" >&2; }

# timed <label> <cmd...> — run under the shim as the nightly would, bound and timed.
timed() {
  local label="$1"; shift
  local t0 rc el out
  t0=$(date +%s)
  out=$(timeout -k 10 "$TIMEOUT" "$@" 2>&1)
  rc=$?
  el=$(( $(date +%s) - t0 ))
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    fail "$label: timed out after ${el}s (rc=$rc)"
  elif [ "$rc" -ne 0 ]; then
    fail "$label: rc=$rc after ${el}s: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  else
    if [ "$el" -gt "$SLOW" ]; then
      warn "$label: succeeded but took ${el}s (> ${SLOW}s slow threshold)"
    else
      pass "$label (${el}s)"
    fi
  fi
  LAST_OUT="$out"
  return "$rc"
}

# ---- locate the bead DB -------------------------------------------------------
if [ -z "${BEADS_DIR:-}" ]; then
  BEADS_DIR=$(bd where 2>/dev/null | awk '{print $NF}')
fi
if [ -z "${BEADS_DIR}" ] || [ ! -d "$BEADS_DIR" ]; then
  fail "cannot locate beads DB (set BEADS_DIR; bd where said: '${BEADS_DIR:-nothing}')"
  exit 1
fi
echo "== bd durability check against $BEADS_DIR ($(date -u +%FT%TZ))"

# ---- 1. backup manifest consistency (no DB access) ---------------------------
manifest="$BEADS_DIR/backup/manifest"
if [ ! -f "$manifest" ]; then
  fail "backup manifest missing: $manifest (auto-backup destination not initialised?)"
else
  have=$( { ls "$BEADS_DIR/backup"/*.darc "$BEADS_DIR/backup/oldgen"/*.darc 2>/dev/null | xargs -r -n1 basename; } | sed 's/\.darc$//' | sort -u)
  refs=$(tr ':' '\n' < "$manifest" | grep -E '^[a-z0-9]{32}$' | grep -v '^0\{32\}$' | sort -u)
  total=$(printf '%s\n' "$refs" | grep -c . || true)
  missing=$(printf '%s\n' "$refs" | comm -23 - <(printf '%s\n' "$have") | head -11)
  n_missing=$(printf '%s\n' "$missing" | grep -c . || true)
  if [ "$n_missing" -gt 0 ]; then
    fail "backup manifest references $total table files, $n_missing+ missing on disk (truncated backup); first: $(printf '%s' "$missing" | head -3 | tr '\n' ' ')"
    echo "      -> rebuild with: bd backup remove && rm -rf '$BEADS_DIR/backup' && bd backup init && bd backup sync"
  else
    pass "backup manifest: all $total referenced table files present"
  fi
fi

# ---- 2. timed live round-trip -------------------------------------------------
ts=$(date -u +%Y%m%dT%H%M%SZ)
title="bd-durability-check $ts (auto-created by scripts/bd-durability-check.sh; safe to delete)"
timed "bd create (test bead)" bd q "$title" || true
test_id=$(printf '%s' "${LAST_OUT:-}" | grep -oE '[a-z0-9]+-[a-z0-9]+' | tail -1)
if [ -z "$test_id" ]; then
  fail "could not parse test bead id from bd q output: ${LAST_OUT:-<empty>}"
else
  timed "bd show (live read-back of $test_id)" bd show "$test_id"
  if ! printf '%s' "${LAST_OUT:-}" | grep -q "$test_id"; then
    fail "live read-back: bd show output does not contain $test_id"
  else
    pass "live read-back contains $test_id"
  fi
fi

# ---- 3. backup sync + restore round-trip --------------------------------------
if [ "$SKIP_RESTORE" -eq 1 ]; then
  echo "skip: --skip-restore set; backup sync/restore round-trip NOT run"
elif [ -z "$test_id" ]; then
  fail "backup round-trip: no test bead to verify, skipping sync/restore"
else
  timed "bd backup sync" bd backup sync || true
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/bd-durability-restore.XXXXXX")
  timed "bd backup restore -> $scratch" bd backup restore "$scratch" || true
  # find the restored project dir (contains a .beads dir)
  restored_beads=$(find "$scratch" -maxdepth 4 -type d -name .beads 2>/dev/null | head -1)
  if [ -z "$restored_beads" ]; then
    fail "backup round-trip: no .beads found under restore dir $scratch: $(ls -la "$scratch" 2>&1 | head -5 | tr '\n' ' ')"
  else
    restored_root=$(dirname "$restored_beads")
    timed "bd show (RESTORED read-back of $test_id)" env BEADS_DIR="$restored_beads" bd -C "$restored_root" show "$test_id"
    if ! printf '%s' "${LAST_OUT:-}" | grep -q "$test_id"; then
      fail "restored copy does not contain test bead $test_id"
    else
      pass "round-trip proven: $test_id readable from restored backup"
    fi
  fi
  if [ -n "${BD_DURABILITY_KEEP:-}" ]; then
    echo "keep: scratch restore left at $scratch (BD_DURABILITY_KEEP set)"
  else
    rm -rf "$scratch"
  fi
  timed "bd delete (test bead $test_id)" bd delete "$test_id" --force || \
  { timed "bd delete (retry without --force)" bd delete "$test_id" || true; }
fi

echo "== done: $FAILS failure(s)"
exit $([ "$FAILS" -eq 0 ] && echo 0 || echo 1)
