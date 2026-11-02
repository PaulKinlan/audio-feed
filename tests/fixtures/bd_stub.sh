#!/usr/bin/env bash
# bd_stub.sh — a `bd` test double for tests/bd_durability_check_test.ts.
#
# It exists so scripts/bd-durability-check.sh can be tested WITHOUT a real bead DB
# and without needing the DB to be wedged: each row below is a value the real bd
# would have to be mid-failure to produce. Every knob is an env var, so a row states
# its own lie explicitly:
#
# COVERAGE DECLARATION (audio-feed-45s45): .fleet/coverage-contract.json maps this fixture to
# tests/bd_durability_check_test.ts - the suite copies it with copyFile, and the fleet's
# independent oracle cannot place a .sh path from a .ts suite (its stem arm requires compatible
# extensions), so the declaration is what names the edge. The suite's last row checks it.
#
#   BD_STUB_DIR         scratch dir the stub keeps its state in (required)
#   BD_STUB_SHOW_TITLE  title `bd show` returns, when it should DIFFER from the one
#                       `bd q` recorded — the wrong-read-back row
#   BD_STUB_SHOW_FORMAT compact makes `bd show` emit COMPACT JSON (`{"id":"x"}`) instead
#                       of the spaced default — the read-back-tolerant row
#   BD_STUB_CREATE_RC   exit status for `bd q` (default 0)
#   BEADS_DIR           only used by `bd where`, which echoes it
#
# Deliberately dumb: it never invents durability. If a row wants a passing check it
# has to give the stub the RIGHT title back.
set -u

state="${BD_STUB_DIR:?BD_STUB_DIR must be set}"
mkdir -p "$state"
id_file="$state/id"
title_file="$state/title"

# Global flags come BEFORE the subcommand: the restored read-back is invoked as
# `bd -C <root> show <id> --json`, exactly as the real binary is.
if [ "${1:-}" = "-C" ]; then shift 2; fi
cmd="${1:-}"
case "$cmd" in
  where)
    printf '%s\n' "${BEADS_DIR:-}"
    ;;
  q)
    title="${2:-}"
    printf '%s' "$title" > "$title_file"
    printf '%s' "audio-feed-tst01" > "$id_file"
    # bd q prints ONLY the id on stdout; a PATH warning on stderr is what the
    # first cut of the check mis-parsed, so the stub emits one here too.
    echo "Warning: multiple 'bd' binaries found in PATH:" >&2
    echo "  /opt/stub-bin/bd" >&2
    if [ "${BD_STUB_CREATE_RC:-0}" -ne 0 ]; then exit "${BD_STUB_CREATE_RC}"; fi
    printf 'audio-feed-tst01\n'
    ;;
  show)
    want="${2:-}"
    have_id=$(cat "$id_file" 2>/dev/null || true)
    if [ "$want" != "$have_id" ]; then
      echo "Error: no issue found matching \"$want\"" >&2
      exit 1
    fi
    title=$(cat "$title_file" 2>/dev/null || true)
    if [ -n "${BD_STUB_SHOW_TITLE:-}" ]; then title="$BD_STUB_SHOW_TITLE"; fi
    if [ "${BD_STUB_SHOW_FORMAT:-pretty}" = compact ]; then
      printf '[{"id":"%s","title":"%s"}]\n' "$have_id" "$title"
    else
      printf '[{"id": "%s", "title": "%s"}]\n' "$have_id" "$title"
    fi
    ;;
  delete)
    exit 0
    ;;
  backup)
    sub="${2:-}"
    case "$sub" in
      sync) exit 0 ;;
      restore)
        # The real restore writes a project tree containing .beads; the check looks
        # for exactly that, then reads the bead back through this same stub.
        mkdir -p "${3:?restore needs a directory}/.beads"
        exit 0
        ;;
      *) exit 0 ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
