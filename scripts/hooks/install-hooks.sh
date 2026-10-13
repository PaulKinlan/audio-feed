#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_DIR="${GIT_DIR:-$(git rev-parse --git-common-dir 2>/dev/null || git rev-parse --git-dir 2>/dev/null || echo "")}"
if [ -z "$GIT_DIR" ] || [ ! -d "$GIT_DIR" ]; then
  exit 0
fi

HOOK_FILE="$GIT_DIR/hooks/pre-push"
STANDALONE_HOOK="$GIT_DIR/hooks/audio-feed-pre-push"
mkdir -p "$GIT_DIR/hooks"

# audio-feed-25hc: copy guard into stable $GIT_DIR/hooks location so older/stale worktrees run it
if [ -f "$SCRIPT_DIR/pre-push" ]; then
  cp "$SCRIPT_DIR/pre-push" "$STANDALONE_HOOK"
  chmod +x "$STANDALONE_HOOK"
fi

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
