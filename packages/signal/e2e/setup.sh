#!/usr/bin/env bash
#
# Signal E2E test environment setup.
#
# Starts signal-cli-rest-api via Docker Compose, waits for it to be healthy,
# and walks the user through phone number registration + SMS verification.
# Writes credentials to .env for use by the E2E test runner.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
API_URL="http://localhost:8080"

# ── Colors ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*"; }
die()   { error "$*"; exit 1; }

# ── Step 1: Start Docker Compose ─────────────────────────────────────────────

info "Starting signal-cli-rest-api via Docker Compose..."
docker compose -f "${COMPOSE_FILE}" up -d

# ── Step 2: Wait for the API to be healthy ───────────────────────────────────

info "Waiting for signal-cli-rest-api to become healthy (polling /api/v1/about)..."

MAX_WAIT=120
ELAPSED=0
INTERVAL=3

while true; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/api/v1/about" 2>/dev/null || echo "000")
  if [ "${HTTP_CODE}" = "200" ]; then
    ok "signal-cli-rest-api is up (HTTP 200 from /api/v1/about)"
    break
  fi

  ELAPSED=$((ELAPSED + INTERVAL))
  if [ "${ELAPSED}" -ge "${MAX_WAIT}" ]; then
    die "Timed out after ${MAX_WAIT}s waiting for signal-cli-rest-api to start."
  fi

  printf "  ... not ready yet (HTTP %s), retrying in %ds (%d/%ds)\n" "${HTTP_CODE}" "${INTERVAL}" "${ELAPSED}" "${MAX_WAIT}"
  sleep "${INTERVAL}"
done

# ── Step 3: Phone number registration ────────────────────────────────────────

echo ""
info "=== Phone Number Registration ==="
echo ""
echo "  You need a phone number that can receive SMS to register with Signal."
echo "  The number must be in E.164 format, e.g. +15551234567"
echo ""

read -rp "  Enter your Signal phone number (E.164): " SIGNAL_NUMBER

if [[ ! "${SIGNAL_NUMBER}" =~ ^\+[0-9]{7,15}$ ]]; then
  die "Invalid phone number format. Must be E.164, e.g. +15551234567"
fi

info "Registering ${SIGNAL_NUMBER} — this will send a verification SMS..."
REG_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "${API_URL}/api/v1/register/${SIGNAL_NUMBER}" \
  -H "Content-Type: application/json" \
  -d '{"use_voice": false}')

REG_BODY=$(echo "${REG_RESPONSE}" | head -n -1)
REG_STATUS=$(echo "${REG_RESPONSE}" | tail -n 1)

if [ "${REG_STATUS}" -ge 200 ] && [ "${REG_STATUS}" -lt 300 ]; then
  ok "Registration request sent (HTTP ${REG_STATUS}). Check your phone for the SMS code."
elif [ "${REG_STATUS}" = "409" ]; then
  warn "Number may already be registered (HTTP 409). Proceeding to verification."
else
  warn "Registration returned HTTP ${REG_STATUS}: ${REG_BODY}"
  echo "  This might be OK if the number is already registered. Continuing..."
fi

echo ""
read -rp "  Enter the verification code from SMS (digits only, e.g. 123456): " VERIFY_CODE

# Strip any non-digit characters the user might have typed (dashes, spaces)
VERIFY_CODE=$(echo "${VERIFY_CODE}" | tr -d '[:space:]-')

info "Verifying ${SIGNAL_NUMBER} with code ${VERIFY_CODE}..."
VER_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "${API_URL}/api/v1/register/${SIGNAL_NUMBER}/verify/${VERIFY_CODE}" \
  -H "Content-Type: application/json")

VER_BODY=$(echo "${VER_RESPONSE}" | head -n -1)
VER_STATUS=$(echo "${VER_RESPONSE}" | tail -n 1)

if [ "${VER_STATUS}" -ge 200 ] && [ "${VER_STATUS}" -lt 300 ]; then
  ok "Verification successful!"
else
  warn "Verification returned HTTP ${VER_STATUS}: ${VER_BODY}"
  echo "  If the number was previously registered, this might be expected."
  echo "  The test suite will verify connectivity below."
fi

# ── Step 4: Verify registration by calling /api/v1/about ─────────────────────

echo ""
info "Verifying API health after registration..."
ABOUT_RESPONSE=$(curl -s "${API_URL}/api/v1/about")
ok "API /about response: ${ABOUT_RESPONSE}"

# ── Step 5: Ask for test recipient ───────────────────────────────────────────

echo ""
info "=== Test Recipient Setup ==="
echo ""
echo "  E2E tests need a second Signal phone number to receive messages."
echo "  This should be a different phone from the one you just registered."
echo ""

read -rp "  Enter test recipient phone number (E.164): " SIGNAL_TEST_RECIPIENT

if [[ ! "${SIGNAL_TEST_RECIPIENT}" =~ ^\+[0-9]{7,15}$ ]]; then
  die "Invalid phone number format. Must be E.164, e.g. +15551234567"
fi

# ── Step 6: Write .env ───────────────────────────────────────────────────────

cat > "${ENV_FILE}" <<ENVEOF
SIGNAL_API_URL=${API_URL}
SIGNAL_NUMBER=${SIGNAL_NUMBER}
SIGNAL_TEST_RECIPIENT=${SIGNAL_TEST_RECIPIENT}
ENVEOF

ok "Credentials saved to ${ENV_FILE}"

# ── Step 7: Summary ──────────────────────────────────────────────────────────

echo ""
echo "  ┌──────────────────────────────────────────────────┐"
echo "  │         Signal E2E Environment Ready             │"
echo "  ├──────────────────────────────────────────────────┤"
printf "  │  API URL:        %-30s│\n" "${API_URL}"
printf "  │  Signal Number:  %-30s│\n" "${SIGNAL_NUMBER}"
printf "  │  Test Recipient: %-30s│\n" "${SIGNAL_TEST_RECIPIENT}"
echo "  │  Env File:       .env                            │"
echo "  ├──────────────────────────────────────────────────┤"
echo "  │  Next steps:                                     │"
echo "  │  1. npx tsx e2e-test.ts                          │"
echo "  │  2. ./teardown.sh (when done)                    │"
echo "  └──────────────────────────────────────────────────┘"
echo ""
