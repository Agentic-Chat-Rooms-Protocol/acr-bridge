#!/usr/bin/env bash
# Show diff between our patched version and upstream OpenACP telegram plugin.
# Usage: ./diff.sh [/path/to/openacp]

set -euo pipefail

OPENACP_DIR="${1:-/Users/keer/projects/universal-bridge-openacp}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP="$OPENACP_DIR/src/plugins/telegram.upstream-backup"

if [ -d "$BACKUP" ]; then
  echo "=== Diff vs upstream backup ==="
  diff -rq "$BACKUP" "$SCRIPT_DIR/src" 2>/dev/null | grep -v __tests__ || echo "(no differences)"
  echo ""
  echo "=== Detailed diff (patched files only) ==="
  for f in adapter.ts draft-manager.ts topics.ts; do
    if [ -f "$BACKUP/$f" ] && [ -f "$SCRIPT_DIR/src/$f" ]; then
      CHANGES=$(diff "$BACKUP/$f" "$SCRIPT_DIR/src/$f" | wc -l | tr -d ' ')
      if [ "$CHANGES" -gt 0 ]; then
        echo "--- $f ($CHANGES lines changed) ---"
        diff -u "$BACKUP/$f" "$SCRIPT_DIR/src/$f" | head -60
        echo ""
      fi
    fi
  done
else
  echo "No upstream backup found. Run install.sh first to create one."
fi
