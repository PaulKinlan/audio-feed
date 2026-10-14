#!/usr/bin/env bash
# audio-feed-ng60 / audio-feed-25hc / audio-feed-f5c0 / audio-feed-p2la:
# install the repo's pre-push guard into this clone's git hooks, and VERIFY it is armed.
#
# Run as the FIRST step of both gate tasks (`deno task test:fast` and `deno task gate` both begin
# with `deno task hooks:install`). Until audio-feed-p2la the only installation path was a
# best-effort call inside scripts/fast-check.ts that could not run under test:fast's permissions
# and discarded its own exit status and errors — so this script existed, the guard did not, and the
# gate reported green. Everything below therefore fails LOUDLY (non-zero, by name) rather than
# leaving an unarmed clone looking guarded.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAIN_MARKER="# audio-feed-p2la: chain repo pre-push hook"

fail() {
  echo "pre-push guard installation FAILED (audio-feed-p2la): $1" >&2
  echo "The guard is NOT armed, so an ungated push or a copy of main onto a fleet/* branch will not be refused." >&2
  echo "Fix the cause and re-run 'deno task hooks:install'; do not push from an unguarded clone." >&2
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

# audio-feed-25hc: copy guard into a stable $GIT_DIR/hooks location so older/stale worktrees run it
cp -f "$SCRIPT_DIR/pre-push" "$STANDALONE_HOOK"
chmod +x "$STANDALONE_HOOK"

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
    printf '%s\n\n%s\n\n%s\n' "$first_line" "$CHAIN_BLOCK" "$rest_lines" > "$HOOK_FILE.tmp"
  else
    printf '#!/usr/bin/env bash\n\n%s\n\n%s\n\n%s\n' "$CHAIN_BLOCK" "$first_line" "$rest_lines" > "$HOOK_FILE.tmp"
  fi
  mv -f "$HOOK_FILE.tmp" "$HOOK_FILE"
  chmod +x "$HOOK_FILE"
else
  printf '#!/usr/bin/env bash\n\n%s\n' "$CHAIN_BLOCK" > "$HOOK_FILE"
  chmod +x "$HOOK_FILE"
fi

# audio-feed-p2la: an installer that RAN is not a guard that is INSTALLED. Everything the chained
# block needs at push time is read back from disk here, and any gap is a named failure rather than a
# gate that reports the guard as armed while the hook would never fire.
[ -x "$HOOK_FILE" ] || fail "'$HOOK_FILE' was written but is not executable"
grep -qF "$CHAIN_MARKER" "$HOOK_FILE" || fail "'$HOOK_FILE' does not carry the chain block ('$CHAIN_MARKER')"
[ -x "$STANDALONE_HOOK" ] || fail "'$STANDALONE_HOOK' (the file the chain block executes) is not executable"
cmp -s "$SCRIPT_DIR/pre-push" "$STANDALONE_HOOK" || fail "'$STANDALONE_HOOK' is not the guard from this tree ('$SCRIPT_DIR/pre-push'), so a stale copy would enforce old rules"

echo "pre-push guard armed (audio-feed-p2la): $HOOK_FILE runs $STANDALONE_HOOK"
