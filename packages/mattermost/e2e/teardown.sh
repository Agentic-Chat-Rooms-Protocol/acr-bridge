#!/usr/bin/env bash
#
# teardown.sh — Remove the local Mattermost E2E environment.
#
# Stops and removes all containers, networks, and volumes created by
# docker-compose.yml. Also removes the generated .env file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

info()  { printf "\033[1;34m[INFO]\033[0m  %s\n" "$*"; }
ok()    { printf "\033[1;32m[OK]\033[0m    %s\n" "$*"; }

info "Stopping Mattermost E2E containers and removing volumes..."

cd "$SCRIPT_DIR"
docker compose down -v --remove-orphans 2>/dev/null || docker-compose down -v --remove-orphans 2>/dev/null || true

ok "Containers and volumes removed"

if [ -f "${SCRIPT_DIR}/.env" ]; then
  info "Removing generated .env file..."
  rm -f "${SCRIPT_DIR}/.env"
  ok ".env removed"
fi

echo ""
echo "Mattermost E2E environment torn down."
