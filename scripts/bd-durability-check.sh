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
#   0. Auto-backup mode, from .beads/config.yaml (`backup.enabled`). bd's default is
#      ON in embedded mode with a git remote, so an absent/unparseable key means ON.
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
# TWO RULES THIS SCRIPT IS BUILT ON (2026-11-02, audio-feed-<fix>: the first cut
# of this check reported a FALSE PASS and failed the healthy configuration).
#
#   BACKUP ABSENCE. An absent .beads/backup is HEALTHY when auto-backup is
#   deliberately disabled (`backup: enabled: false` — the current audio-feed
#   configuration, disabled while the a1bm8 repair lands) and a FAILURE when it is
#   enabled. A check that reddens the intended end state trains people to ignore it.
#   Checks 1 and 3 are therefore reported as not-applicable while it is disabled.
#
#   READ-BACK. No line may say ok/pass/proven unless the value just read back was
#   COMPARED with the value written. `bd show <id>` echoing the id we passed it
#   proves nothing but argv, so checks 2 and 3 assert the stored TITLE equals the
#   title we created. rc=0 alone is never evidence of durability.
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
# Stdout lands in LAST_OUT and stderr in LAST_ERR, KEPT APART: `bd q` prints only the
# id on stdout, so merging the streams let any dashed word on stderr (a title echo, a
# PATH warning) be parsed as the id.
timed() {
  local label="$1"; shift
  local t0 rc el errf
  errf=$(mktemp "${TMPDIR:-/tmp}/bd-durability-err.XXXXXX")
  t0=$(date +%s)
  LAST_OUT=$(timeout -k 10 "$TIMEOUT" "$@" 2>"$errf")
  rc=$?
  LAST_ERR=$(cat "$errf" 2>/dev/null || true)
  rm -f "$errf"
  el=$(( $(date +%s) - t0 ))
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    fail "$label: timed out after ${el}s (rc=$rc)"
  elif [ "$rc" -ne 0 ]; then
    fail "$label: rc=$rc after ${el}s: $(printf '%s' "${LAST_ERR:-$LAST_OUT}" | tail -2 | tr '\n' ' ')"
  else
    # rc=0 is reported as what it is — the call completed — never as the check passing;
    # each caller asserts the returned VALUE before it prints an ok for the round-trip.
    if [ "$el" -gt "$SLOW" ]; then
      warn "$label: returned rc=0 but took ${el}s (> ${SLOW}s slow threshold)"
    else
      pass "$label returned rc=0 (${el}s)"
    fi
  fi
  return "$rc"
}

# backup_enabled <beads-dir> — echo "on" or "off" from `backup: enabled:` in the
# UNCOMMENTED part of <beads-dir>/config.yaml. Unset (or no config at all) is "on",
# because that is bd's own default in embedded mode with a git remote present.
backup_enabled() {
  local cfg="$1/config.yaml" val
  if [ ! -f "$cfg" ]; then echo on; return; fi
  val=$(awk '
    /^[[:space:]]*#/ { next }
    /^[^[:space:]]/ { inbackup = ($0 ~ /^backup:[[:space:]]*$/); next }
    inbackup && /^[[:space:]]+enabled:[[:space:]]*/ {
      sub(/^[[:space:]]+enabled:[[:space:]]*/, "")
      sub(/[[:space:]]*#.*$/, "")
      print; exit
    }
  ' "$cfg")
  case "$val" in
    false|False|FALSE|no|No|off|0) echo off ;;
    *) echo on ;;
  esac
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
BACKUP_ENABLED=$(backup_enabled "$BEADS_DIR")
echo "== auto-backup: $BACKUP_ENABLED (backup.enabled in $BEADS_DIR/config.yaml)"

# ---- 1. backup manifest consistency (no DB access) ---------------------------
manifest="$BEADS_DIR/backup/manifest"
if [ ! -f "$manifest" ]; then
  # Defect (a) of the first cut: this failed on the healthy configuration. An absent
  # backup destination is the INTENDED state while auto-backup is disabled.
  if [ "$BACKUP_ENABLED" = off ]; then
    pass "backup destination absent and auto-backup disabled (backup.enabled: false) — checks 1 and 3 not applicable"
  else
    fail "backup manifest missing: $manifest (auto-backup is ENABLED, so its destination is not initialised)"
  fi
else
  have=$( { ls "$BEADS_DIR/backup"/*.darc "$BEADS_DIR/backup/oldgen"/*.darc 2>/dev/null | xargs -r -n1 basename; } | sed 's/\.darc$//' | sort -u)
  refs=$(tr ':' '\n' < "$manifest" | grep -E '^[a-z0-9]{32}$' | grep -v '^0\{32\}$' | sort -u)
  total=$(printf '%s\n' "$refs" | grep -c . || true)
  missing=$(printf '%s\n' "$refs" | comm -23 - <(printf '%s\n' "$have") | head -11)
  n_missing=$(printf '%s\n' "$missing" | grep -c . || true)
  if [ "$total" -eq 0 ]; then
    # A manifest we cannot parse is not a manifest we verified: without this guard the
    # next branch printed "all 0 referenced table files present" and passed.
    fail "backup manifest has no parseable 32-char table-file address: $manifest ($(wc -c < "$manifest") bytes)"
  elif [ "$n_missing" -gt 0 ]; then
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
# Defect (b) of the first cut: `grep -oE '[a-z0-9]+-[a-z0-9]+' | tail -1` cannot span
# the SECOND dash of `audio-feed-ro4tg` (it yields `audio-feed`), and `tail -1` let any
# dashed token on the same stream — a title echo, a PATH warning — win instead. Ids are
# whatever `bd q` printed alone on a line, so take the first line that is NOTHING BUT an
# id: lowercase alnum segments joined by dashes, no spaces, whole line.
test_id=$(printf '%s\n' "${LAST_OUT:-}" | grep -xE '[a-z0-9]+(-[a-z0-9]+)+' | head -1)
if [ -z "$test_id" ]; then
  fail "could not parse a bare test bead id from bd q stdout: ${LAST_OUT:-<empty>} (stderr: ${LAST_ERR:-<empty>})"
else
  pass "bd create printed a bare id: $test_id"
  if ! timed "bd show (live read-back of $test_id)" bd show "$test_id" --json; then
    fail "live read-back: bd show $test_id failed, so nothing about the stored bead is proven"
  elif ! printf '%s' "${LAST_OUT:-}" | grep -qF "\"title\": \"$title\""; then
    fail "live read-back: bd show $test_id did not return the title that was created ($title): $(printf '%s' "${LAST_OUT:-}" | head -c 300)"
  else
    pass "live read-back: the title stored in the DB equals the title created"
  fi
fi

# ---- 3. backup sync + restore round-trip --------------------------------------
if [ "$SKIP_RESTORE" -eq 1 ]; then
  echo "skip: --skip-restore set; backup sync/restore round-trip NOT run"
elif [ "$BACKUP_ENABLED" = off ] && [ ! -f "$manifest" ]; then
  # Running `bd backup sync` here would re-initialise the destination the operator
  # deliberately disabled, so the disabled state is reported, not exercised.
  echo "skip: auto-backup disabled (backup.enabled: false) and no backup destination; sync/restore round-trip NOT run"
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
    if ! timed "bd show (RESTORED read-back of $test_id)" env BEADS_DIR="$restored_beads" bd -C "$restored_root" show "$test_id" --json; then
      fail "restored read-back: bd show $test_id failed against $restored_beads"
    elif ! printf '%s' "${LAST_OUT:-}" | grep -qF "\"title\": \"$title\""; then
      fail "restored copy does not hold the created title for $test_id (got: $(printf '%s' "${LAST_OUT:-}" | head -c 300))"
    else
      pass "round-trip proven: the created title is readable from the restored backup"
    fi
  fi
  if [ -n "${BD_DURABILITY_KEEP:-}" ]; then
    echo "keep: scratch restore left at $scratch (BD_DURABILITY_KEEP set)"
  else
    rm -rf "$scratch"
  fi
fi

# The test bead is cleaned up whether or not check 3 ran: --skip-restore and the
# backup-disabled path both used to return without it, leaving beads behind.
if [ -n "$test_id" ]; then
  timed "bd delete (test bead $test_id)" bd delete "$test_id" --force || \
  { timed "bd delete (retry without --force)" bd delete "$test_id" || true; }
fi

echo "== done: $FAILS failure(s)"
exit $([ "$FAILS" -eq 0 ] && echo 0 || echo 1)
