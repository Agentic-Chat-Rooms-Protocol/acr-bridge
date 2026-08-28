#!/usr/bin/env bash
#
# Tear down the Signal E2E test environment.
# Stops containers and removes volumes to ensure a clean slate.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
ok()   { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }

info "Stopping Signal E2E containers and removing volumes..."
docker compose -f "${COMPOSE_FILE}" down -v

ok "Signal E2E environment torn down."
ok "Volume data removed. Next setup.sh run will start fresh."
