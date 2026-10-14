#!/usr/bin/env bash
# audio-feed-ng60 / audio-feed-25hc / audio-feed-f5c0 / audio-feed-p2la / audio-feed-qqs6:
# install the repo's pre-push guard into this clone's git hooks, and VERIFY it is armed.
#
# Run as the FIRST step of both gate tasks (`deno task test:fast` and `deno task gate` both begin
# with `deno task hooks:install`). Until audio-feed-p2la the only installation path was a
# best-effort call inside scripts/fast-check.ts that could not run under test:fast's permissions
# and discarded its own exit status and errors — so this script existed, the guard did not, and the
# gate reported green. Everything below therefore fails LOUDLY (non-zero, by name) rather than
# leaving an unarmed clone looking guarded.
#
# CONCURRENCY (audio-feed-qqs6). Every lane's gate runs this, several lanes share one VM, and a
# linked worktree's hooks directory is the COMMON git dir, so two installs overlap here routinely.
# An installer that only usually works reddens an unrelated lane's gate, and a false "the guard is
# NOT armed" message next to a verify step that reports armed teaches operators to ignore both — the
# same class of defect as the silence this bead exists to remove. So the shared state is written
# under one lock and every write is an atomic rename, and the message says what was measured:
#   * LOCK: mkdir on "$GIT_DIR/audio-feed-p2la.lock" (atomic on every POSIX filesystem, no extra
#     tooling) with a bounded wait, plus a dead-holder steal. flock(1) was rejected: it is absent on
#     macOS, where this script also runs.
#   * ATOMIC WRITES: each write goes to a private `mktemp` file IN THE TARGET DIRECTORY and is
#     `mv`-ed into place (a rename), so no reader can observe a half-written hook. A fixed
#     "$HOOK_FILE.tmp" name or a bare `cp -f` (open, truncate, write) is what let one installer's
#     read-back see another's partial file — and it fails closed by abandoning the write with a
#     named failure, not by skipping the check when a race is detected, which would be a silent pass.
#   * IDENTITY FAST PATH: if every artefact is already byte-identical to what this tree would
#     install, there is nothing to write and the install says so. The comparison IS the check.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAIN_MARKER="# audio-feed-p2la: chain repo pre-push hook"

temps=()
lock_held=0
LOCK_DIR=""

cleanup() {
  local t
  for t in ${temps[@]+"${temps[@]}"}; do
    rm -f "$t" 2>/dev/null || true
  done
  if [ "$lock_held" = 1 ] && [ -n "$LOCK_DIR" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# audio-feed-qqs6: this message must NOT claim a state it did not measure. The earlier text ("The
# guard is NOT armed, so an ungated push ... will not be refused") was printed on every failure,
# including the concurrency races, at the same moment `deno task hooks:verify` reported armed and the
# push was refused — a message that contradicts the state it describes is a false alarm, and a reader
# who sees false alarms stops believing the real ones. What is true here is only what this installer
# knows: it did not establish that the guard is installed.
fail() {
  echo "pre-push guard installation FAILED (audio-feed-p2la): $1" >&2
  echo "  this installer did not establish that the guard is installed, so it exits non-zero rather than report a state it did not measure." >&2
  echo "  'deno task hooks:verify' reports the state MEASURED right now and is authoritative; it is the next step of both gate tasks." >&2
  echo "  fix the cause and re-run 'deno task hooks:install'; do not push from a clone whose guard you cannot verify." >&2
  exit 1
}
trap 'fail "step failed: $BASH_COMMAND"' ERR

# An explicit GIT_DIR is an override (scratch clones in tests, provision.sh): trust it and skip the
# discovery below, which needs a real repository to answer with.
explicit_git_dir="${GIT_DIR:-}"
if [ -n "$explicit_git_dir" ]; then
  GIT_DIR="$explicit_git_dir"
else
  # --path-format=absolute first, then the relative form (resolved against pwd below), so an older
  # git that does not know the flag still lands on the COMMON dir rather than a worktree's own.
  GIT_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --git-common-dir 2>/dev/null || git rev-parse --git-dir 2>/dev/null || echo "")"
fi

if [ -z "$GIT_DIR" ]; then
  echo "pre-push guard NOT armed (audio-feed-p2la): no git directory (GIT_DIR unset and 'git rev-parse' found none), so this tree cannot push and there is nothing to guard." >&2
  exit 0
fi

# git prints a relative path in the primary checkout; the checks below read back what was written,
# so resolve the path once here instead of depending on the caller's cwd.
case "$GIT_DIR" in
/*) ;;
*) GIT_DIR="$(pwd)/$GIT_DIR" ;;
esac

if [ ! -d "$GIT_DIR" ]; then
  echo "pre-push guard NOT armed (audio-feed-p2la): GIT_DIR '$GIT_DIR' is not a directory, so this tree cannot push and there is nothing to guard." >&2
  exit 0
fi

# WHERE GIT WILL ACTUALLY LOOK. `git rev-parse --git-path hooks` honours core.hooksPath, so a
# core.hooksPath that points somewhere else means the hook written below is never executed: a check
# that only read $GIT_DIR/hooks/pre-push would then announce a guard that cannot fire, which is the
# same class of false claim as the one this bead exists for. Writing into a hooks directory shared
# with other repositories is not something this installer will do, so a mismatch is a NAMED failure
# with the path git will use in the message — a stated limit, not a silent pass.
default_hooks_dir="$GIT_DIR/hooks"
if [ -n "$explicit_git_dir" ]; then
  # An override names the directory to install into; there is no repository to ask about
  # core.hooksPath, and the override IS the caller's statement of where the hooks live.
  resolved_hooks_dir="$default_hooks_dir"
else
  resolved_hooks_dir="$(git rev-parse --path-format=absolute --git-path hooks 2>/dev/null || echo "")"
  [ -n "$resolved_hooks_dir" ] || fail "could not determine the hooks directory git will use ('git rev-parse --git-path hooks' produced nothing), so the guard cannot be verified as armed"
fi
if [ "$resolved_hooks_dir" != "$default_hooks_dir" ]; then
  fail "git resolves the hooks directory to '$resolved_hooks_dir' (core.hooksPath), not '$default_hooks_dir', so the guard written here would never run. Unset core.hooksPath for this clone, or chain '$CHAIN_MARKER' into '$resolved_hooks_dir/pre-push' deliberately."
fi

HOOK_FILE="$default_hooks_dir/pre-push"
STANDALONE_HOOK="$default_hooks_dir/audio-feed-pre-push"

if [ ! -f "$SCRIPT_DIR/pre-push" ]; then
  fail "the guard itself is missing: '$SCRIPT_DIR/pre-push' does not exist, so there is nothing to install"
fi

mkdir -p "$default_hooks_dir"

# ---------------------------------------------------------------------------------------------
# THE LOCK (audio-feed-qqs6). The shared resource is the common git dir, so the lock lives there:
# every worktree of this clone, and every lane's gate, serialises on the same path. `mkdir` is the
# atomic primitive; the wait is bounded so a wedged holder cannot hang a gate, and a holder whose pid
# is gone is not a lock at all (a killed install must not wedge the next one).
# ---------------------------------------------------------------------------------------------
LOCK_DIR="$GIT_DIR/audio-feed-p2la.lock"
LOCK_WAIT_STEPS="${AF_INSTALL_LOCK_WAIT_STEPS:-600}" # 600 x 25ms = 15s

acquire_lock() {
  local waited=0 holder=""
  while :; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
      lock_held=1
      return 0
    fi
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      # A DEAD HOLDER IS NOT A LOCK: remove it and try again (bounded by the same wait).
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    if [ "$waited" -ge "$LOCK_WAIT_STEPS" ]; then
      fail "another install${holder:+ (pid $holder)} has held the lock '$LOCK_DIR' for ~$((LOCK_WAIT_STEPS * 25))ms. This install did not write, so it cannot claim the guard is installed — and it does not skip the checks below to produce a green run anyway."
    fi
    waited=$((waited + 1))
    sleep 0.025
  done
}

# EVERY WRITE IS AN ATOMIC RENAME. A private temp file in the target directory, then `mv`: a reader
# sees the old file or the new one, never a truncated one. (The temp names are unique per process, so
# two installers cannot collide on one, which is what produced "cannot stat '<hook>.tmp'".)
stage_file() { # $1 = source file, $2 = target
  local tmp
  tmp="$(mktemp "${2%/*}/.af-install.XXXXXX")" || fail "could not create a temp file beside '$2' to write it atomically"
  temps+=("$tmp")
  cp "$1" "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$2"
}

stage_text() { # $1 = target, $2 = content
  local tmp
  tmp="$(mktemp "${1%/*}/.af-install.XXXXXX")" || fail "could not create a temp file beside '$1' to write it atomically"
  temps+=("$tmp")
  printf '%s\n' "$2" > "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$1"
}

CHAIN_BLOCK=$(cat << 'EOF'
# audio-feed-p2la: chain repo pre-push hook
_af_git_dir="$(git rev-parse --git-common-dir 2>/dev/null || git rev-parse --git-dir 2>/dev/null || echo "")"
_af_repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -n "$_af_git_dir" ] && [ -x "$_af_git_dir/hooks/audio-feed-pre-push" ]; then
  "$_af_git_dir/hooks/audio-feed-pre-push" "$@" || exit $?
elif [ -n "$_af_repo_root" ] && [ -x "$_af_repo_root/scripts/hooks/pre-push" ]; then
  "$_af_repo_root/scripts/hooks/pre-push" "$@" || exit $?
fi
EOF
)

# THE CONTENT THIS TREE WOULD INSTALL, computed before anything is written so the identity check and
# the write cannot disagree about what "installed" means.
if [ -f "$HOOK_FILE" ]; then
  # Strip existing audio-feed-p2la block if present
  cleaned=$(awk '
    BEGIN { in_block = 0 }
    /# audio-feed-p2la: chain repo pre-push hook/ { in_block = 1; next }
    in_block && /^fi/ { in_block = 0; next }
    !in_block { print }
  ' "$HOOK_FILE")

  # audio-feed-f5c0: insert chain block shebang-adjacent so early exits in existing hook do not skip guards
  first_line=$(head -n 1 <<< "$cleaned")
  rest_lines=$(tail -n +2 <<< "$cleaned")

  if [[ "$first_line" =~ ^#! ]]; then
    desired="$(printf '%s\n\n%s\n\n%s' "$first_line" "$CHAIN_BLOCK" "$rest_lines")"
  else
    desired="$(printf '#!/usr/bin/env bash\n\n%s\n\n%s\n\n%s' "$CHAIN_BLOCK" "$first_line" "$rest_lines")"
  fi
else
  desired="$(printf '#!/usr/bin/env bash\n\n%s' "$CHAIN_BLOCK")"
fi

acquire_lock

# ALREADY ARMED, EXACTLY? This is a comparison, not a shortcut: it runs on every install, inside the
# lock, and only an exact match on both artefacts (chain hook content, executable bit, and the
# standalone guard byte-identical to THIS tree's guard) skips the writes. Declining to check because
# a race was detected would trade a loud failure for a silent pass, so nothing here is conditional on
# detecting contention.
already=1
[ -x "$HOOK_FILE" ] || already=0
if [ "$already" = 1 ] && ! cmp -s <(printf '%s\n' "$desired") "$HOOK_FILE"; then already=0; fi
[ -x "$STANDALONE_HOOK" ] || already=0
if [ "$already" = 1 ] && ! cmp -s "$SCRIPT_DIR/pre-push" "$STANDALONE_HOOK"; then already=0; fi

if [ "$already" = 1 ]; then
  echo "pre-push guard already armed (audio-feed-p2la): $HOOK_FILE runs $STANDALONE_HOOK (byte-identical to this tree's guard; nothing to install)"
  exit 0
fi

stage_file "$SCRIPT_DIR/pre-push" "$STANDALONE_HOOK"
stage_text "$HOOK_FILE" "$desired"

# audio-feed-p2la: an installer that RAN is not a guard that is INSTALLED. Everything the chained
# block needs at push time is read back from disk here, and any gap is a named failure rather than a
# gate that reports the guard as armed while the hook would never fire. These read-backs are sound
# only because the writes above are atomic renames under the lock: they can observe a complete old or
# new file, never the half-written one that made this check flaky (audio-feed-qqs6).
[ -x "$HOOK_FILE" ] || fail "'$HOOK_FILE' was written but is not executable"
grep -qF "$CHAIN_MARKER" "$HOOK_FILE" || fail "'$HOOK_FILE' does not carry the chain block ('$CHAIN_MARKER')"
[ -x "$STANDALONE_HOOK" ] || fail "'$STANDALONE_HOOK' (the file the chain block executes) is not executable"
cmp -s "$SCRIPT_DIR/pre-push" "$STANDALONE_HOOK" || fail "'$STANDALONE_HOOK' is not the guard from this tree ('$SCRIPT_DIR/pre-push'), so a stale copy would enforce old rules"

echo "pre-push guard armed (audio-feed-p2la): $HOOK_FILE runs $STANDALONE_HOOK"
