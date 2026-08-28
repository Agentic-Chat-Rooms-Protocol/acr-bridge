#!/usr/bin/env bash
# Install patched Telegram adapter into an OpenACP installation.
# Usage: ./install.sh [/path/to/openacp]
#
# This replaces the built-in src/plugins/telegram/ with our multi-chat version.
# After install, run `pnpm build` in the openacp directory.

set -euo pipefail

OPENACP_DIR="${1:-/Users/keer/projects/universal-bridge-openacp}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src"
TARGET="$OPENACP_DIR/src/plugins/telegram"

if [ ! -d "$TARGET" ]; then
  echo "❌ Target not found: $TARGET"
  echo "   Pass the openacp directory as argument: ./install.sh /path/to/openacp"
  exit 1
fi

echo "Installing telegram-adapter-kiros into $OPENACP_DIR"

# Backup original (first time only)
BACKUP="$TARGET.upstream-backup"
if [ ! -d "$BACKUP" ]; then
  echo "  → Creating backup: $BACKUP"
  cp -r "$TARGET" "$BACKUP"
fi

# Copy patched files
echo "  → Copying patched files..."
cp "$SRC"/*.ts "$TARGET/"
cp "$SRC"/commands/*.ts "$TARGET/commands/"

echo "  → Building..."
cd "$OPENACP_DIR"
pnpm build

echo "✅ Installed. Restart openacp to apply."
