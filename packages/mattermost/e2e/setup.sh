#!/usr/bin/env bash
#
# setup.sh — Bootstrap a local Mattermost instance for E2E testing.
#
# Prerequisites: docker compose up -d (Mattermost + Postgres running)
#
# This script:
#   1. Waits for Mattermost to be healthy (polls /api/v4/system/ping)
#   2. Creates an admin user via REST API
#   3. Creates a team ("test-team")
#   4. Creates a bot account ("e2e-bot")
#   5. Generates a personal access token for the bot
#   6. Creates test channels: bot-testing
#   7. Adds the bot to channels
#   8. Saves credentials to .env
#   9. Prints connection info

set -euo pipefail

BASE_URL="${MATTERMOST_URL:-http://localhost:8065}"
API="${BASE_URL}/api/v4"

ADMIN_USER="admin"
ADMIN_PASS="Admin1234!"
ADMIN_EMAIL="admin@test.local"

BOT_USERNAME="e2e-bot"
BOT_DISPLAY_NAME="E2E Test Bot"

TEAM_NAME="test-team"
TEAM_DISPLAY_NAME="Test Team"

CHANNEL_NAME="bot-testing"
CHANNEL_DISPLAY_NAME="Bot Testing"

ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { printf "\033[1;34m[INFO]\033[0m  %s\n" "$*"; }
ok()    { printf "\033[1;32m[OK]\033[0m    %s\n" "$*"; }
fail()  { printf "\033[1;31m[FAIL]\033[0m  %s\n" "$*"; exit 1; }
warn()  { printf "\033[1;33m[WARN]\033[0m  %s\n" "$*"; }

# JSON field extractor using pure bash (no jq dependency for portability).
# Falls back to jq if available.
json_field() {
  local json="$1" field="$2"
  if command -v jq &>/dev/null; then
    echo "$json" | jq -r ".$field // empty"
  else
    # Minimal grep-based extraction (handles simple flat JSON)
    echo "$json" | grep -oP "\"${field}\"\s*:\s*\"?\K[^\"',}\s]+" | head -1
  fi
}

api_get() {
  local path="$1"
  shift
  curl -sSf -H "Authorization: Bearer ${AUTH_TOKEN:-}" "$@" "${API}${path}"
}

api_post() {
  local path="$1" body="$2"
  shift 2
  curl -sSf -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN:-}" \
    -d "$body" \
    "$@" "${API}${path}"
}

# ── 1. Wait for Mattermost ──────────────────────────────────────────────────

info "Waiting for Mattermost at ${BASE_URL} ..."

MAX_WAIT=120
WAITED=0
while true; do
  STATUS=$(curl -sf "${API}/system/ping" 2>/dev/null || echo "")
  if echo "$STATUS" | grep -q '"status"'; then
    break
  fi
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    fail "Mattermost did not become healthy within ${MAX_WAIT}s"
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  printf "."
done
echo ""
ok "Mattermost is up (waited ${WAITED}s)"

# ── 2. Create admin user ────────────────────────────────────────────────────

info "Creating admin user: ${ADMIN_USER}"

# First user on a fresh instance gets system_admin automatically
ADMIN_RESP=$(curl -sS -X POST \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${ADMIN_EMAIL}\",
    \"username\": \"${ADMIN_USER}\",
    \"password\": \"${ADMIN_PASS}\"
  }" \
  "${API}/users" 2>&1) || true

ADMIN_ID=$(json_field "$ADMIN_RESP" "id")

if [ -z "$ADMIN_ID" ]; then
  # User might already exist; try to log in
  warn "Admin creation returned no ID (may already exist). Attempting login..."
fi

# Log in to get a session token
LOGIN_RESP=$(curl -sS -X POST \
  -H "Content-Type: application/json" \
  -d "{
    \"login_id\": \"${ADMIN_USER}\",
    \"password\": \"${ADMIN_PASS}\"
  }" \
  -D - \
  "${API}/users/login" 2>&1) || true

AUTH_TOKEN=$(echo "$LOGIN_RESP" | grep -i '^token:' | awk '{print $2}' | tr -d '\r\n')

if [ -z "$AUTH_TOKEN" ]; then
  fail "Failed to obtain admin auth token. Login response:\n${LOGIN_RESP}"
fi

# Re-fetch admin ID using the token
ADMIN_ME=$(api_get "/users/me" 2>&1) || true
ADMIN_ID=$(json_field "$ADMIN_ME" "id")

if [ -z "$ADMIN_ID" ]; then
  fail "Failed to resolve admin user ID"
fi

ok "Admin user ready: id=${ADMIN_ID}"

# Ensure the admin has system_admin role
ROLES_RESP=$(curl -sS -X PUT \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -d "{\"roles\": \"system_admin system_user\"}" \
  "${API}/users/${ADMIN_ID}/roles" 2>&1) || true

# ── 3. Create team ──────────────────────────────────────────────────────────

info "Creating team: ${TEAM_NAME}"

TEAM_RESP=$(api_post "/teams" "{
  \"name\": \"${TEAM_NAME}\",
  \"display_name\": \"${TEAM_DISPLAY_NAME}\",
  \"type\": \"O\"
}" 2>&1) || true

TEAM_ID=$(json_field "$TEAM_RESP" "id")

if [ -z "$TEAM_ID" ]; then
  # Team may already exist; look it up by name
  warn "Team creation returned no ID, looking up by name..."
  TEAM_LOOKUP=$(api_get "/teams/name/${TEAM_NAME}" 2>&1) || true
  TEAM_ID=$(json_field "$TEAM_LOOKUP" "id")
fi

if [ -z "$TEAM_ID" ]; then
  fail "Failed to create or find team '${TEAM_NAME}'"
fi

ok "Team ready: id=${TEAM_ID}"

# ── 4. Create bot account ───────────────────────────────────────────────────

info "Creating bot: ${BOT_USERNAME}"

BOT_RESP=$(api_post "/bots" "{
  \"username\": \"${BOT_USERNAME}\",
  \"display_name\": \"${BOT_DISPLAY_NAME}\",
  \"description\": \"E2E testing bot for OpenACP Mattermost adapter\"
}" 2>&1) || true

BOT_USER_ID=$(json_field "$BOT_RESP" "user_id")

if [ -z "$BOT_USER_ID" ]; then
  # Bot may already exist; look it up
  warn "Bot creation returned no user_id, looking up existing bot..."
  BOTS_LIST=$(api_get "/bots" 2>&1) || true
  BOT_USER_ID=$(echo "$BOTS_LIST" | grep -oP "\"user_id\"\s*:\s*\"\K[^\"]+(?=\".*\"username\"\s*:\s*\"${BOT_USERNAME}\")" | head -1)

  if [ -z "$BOT_USER_ID" ]; then
    # Try reverse pattern matching
    if command -v jq &>/dev/null; then
      BOT_USER_ID=$(echo "$BOTS_LIST" | jq -r ".[] | select(.username == \"${BOT_USERNAME}\") | .user_id // empty" 2>/dev/null || echo "")
    fi
  fi
fi

if [ -z "$BOT_USER_ID" ]; then
  fail "Failed to create or find bot '${BOT_USERNAME}'"
fi

ok "Bot ready: user_id=${BOT_USER_ID}"

# ── 5. Generate personal access token for the bot ────────────────────────────

info "Generating access token for bot..."

# Grant the bot the ability to have personal access tokens
curl -sS -X PUT \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -d "{\"roles\": \"system_user\"}" \
  "${API}/users/${BOT_USER_ID}/roles" >/dev/null 2>&1 || true

TOKEN_RESP=$(api_post "/users/${BOT_USER_ID}/tokens" "{
  \"description\": \"E2E test token\"
}" 2>&1) || true

BOT_TOKEN=$(json_field "$TOKEN_RESP" "token")

if [ -z "$BOT_TOKEN" ]; then
  fail "Failed to generate bot access token. Response:\n${TOKEN_RESP}"
fi

ok "Bot token generated (starts with ${BOT_TOKEN:0:8}...)"

# ── 6. Create test channels ─────────────────────────────────────────────────

info "Creating channel: ${CHANNEL_NAME}"

CHAN_RESP=$(api_post "/channels" "{
  \"team_id\": \"${TEAM_ID}\",
  \"name\": \"${CHANNEL_NAME}\",
  \"display_name\": \"${CHANNEL_DISPLAY_NAME}\",
  \"type\": \"O\"
}" 2>&1) || true

CHANNEL_ID=$(json_field "$CHAN_RESP" "id")

if [ -z "$CHANNEL_ID" ]; then
  # Channel may already exist; look it up
  warn "Channel creation returned no ID, looking up by name..."
  CHAN_LOOKUP=$(api_get "/teams/${TEAM_ID}/channels/name/${CHANNEL_NAME}" 2>&1) || true
  CHANNEL_ID=$(json_field "$CHAN_LOOKUP" "id")
fi

if [ -z "$CHANNEL_ID" ]; then
  fail "Failed to create or find channel '${CHANNEL_NAME}'"
fi

ok "Channel ready: id=${CHANNEL_ID}"

# Also get the #town-square (default general) channel
GENERAL_RESP=$(api_get "/teams/${TEAM_ID}/channels/name/town-square" 2>&1) || true
GENERAL_ID=$(json_field "$GENERAL_RESP" "id")
if [ -n "$GENERAL_ID" ]; then
  ok "General channel (town-square): id=${GENERAL_ID}"
fi

# ── 7. Add bot to team and channels ─────────────────────────────────────────

info "Adding bot to team and channels..."

# Add bot to team
api_post "/teams/${TEAM_ID}/members" "{
  \"team_id\": \"${TEAM_ID}\",
  \"user_id\": \"${BOT_USER_ID}\"
}" >/dev/null 2>&1 || warn "Bot may already be a team member"

# Add bot to bot-testing channel
api_post "/channels/${CHANNEL_ID}/members" "{
  \"user_id\": \"${BOT_USER_ID}\"
}" >/dev/null 2>&1 || warn "Bot may already be in #${CHANNEL_NAME}"

# Add bot to general channel if it exists
if [ -n "$GENERAL_ID" ]; then
  api_post "/channels/${GENERAL_ID}/members" "{
    \"user_id\": \"${BOT_USER_ID}\"
  }" >/dev/null 2>&1 || warn "Bot may already be in #town-square"
fi

ok "Bot added to channels"

# ── 8. Save credentials to .env ─────────────────────────────────────────────

info "Writing credentials to ${ENV_FILE}"

cat > "$ENV_FILE" <<EOF
# Mattermost E2E test environment — generated by setup.sh
# $(date -u +"%Y-%m-%dT%H:%M:%SZ")

MATTERMOST_URL=${BASE_URL}
MATTERMOST_TOKEN=${BOT_TOKEN}
MATTERMOST_TEAM=${TEAM_NAME}
MATTERMOST_CHANNEL=${CHANNEL_NAME}
MATTERMOST_CHANNEL_ID=${CHANNEL_ID}
MATTERMOST_TEAM_ID=${TEAM_ID}
MATTERMOST_BOT_USER_ID=${BOT_USER_ID}
MATTERMOST_ADMIN_TOKEN=${AUTH_TOKEN}
MATTERMOST_ADMIN_USER=${ADMIN_USER}
MATTERMOST_ADMIN_PASS=${ADMIN_PASS}
MATTERMOST_ADMIN_ID=${ADMIN_ID}
EOF

ok "Credentials saved to .env"

# ── 9. Print connection info ────────────────────────────────────────────────

echo ""
echo "=============================================="
echo "  Mattermost E2E Environment Ready"
echo "=============================================="
echo ""
echo "  Server:     ${BASE_URL}"
echo "  Admin:      ${ADMIN_USER} / ${ADMIN_PASS}"
echo "  Team:       ${TEAM_NAME} (${TEAM_ID})"
echo "  Channel:    #${CHANNEL_NAME} (${CHANNEL_ID})"
echo "  Bot:        @${BOT_USERNAME} (${BOT_USER_ID})"
echo "  Bot Token:  ${BOT_TOKEN:0:12}..."
echo ""
echo "  Web UI:     ${BASE_URL}/${TEAM_NAME}/channels/${CHANNEL_NAME}"
echo ""
echo "  Run tests:  npx tsx e2e-test.ts"
echo "=============================================="
