#!/usr/bin/env bash
set -euo pipefail

GIT_DIR="${GIT_DIR:-$(git rev-parse --git-common-dir 2>/dev/null || git rev-parse --git-dir 2>/dev/null || echo "")}"
if [ -z "$GIT_DIR" ] || [ ! -d "$GIT_DIR" ]; then
  exit 0
fi

HOOK_FILE="$GIT_DIR/hooks/pre-push"
mkdir -p "$GIT_DIR/hooks"

if [ -f "$HOOK_FILE" ]; then
  if ! grep -q "audio-feed-p2la" "$HOOK_FILE"; then
    cat >> "$HOOK_FILE" << 'EOF'

# audio-feed-p2la: chain repo pre-push hook
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -n "$REPO_ROOT" ] && [ -x "$REPO_ROOT/scripts/hooks/pre-push" ]; then
  "$REPO_ROOT/scripts/hooks/pre-push" "$@" || exit $?
fi
EOF
    chmod +x "$HOOK_FILE"
  fi
else
  cat > "$HOOK_FILE" << 'EOF'
#!/usr/bin/env bash
# audio-feed-p2la: chain repo pre-push hook
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -n "$REPO_ROOT" ] && [ -x "$REPO_ROOT/scripts/hooks/pre-push" ]; then
  "$REPO_ROOT/scripts/hooks/pre-push" "$@" || exit $?
fi
EOF
  chmod +x "$HOOK_FILE"
fi
