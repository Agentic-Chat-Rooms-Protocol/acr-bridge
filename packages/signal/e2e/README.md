# Signal Adapter E2E Tests

End-to-end tests for the OpenACP Signal adapter running against a real
`signal-cli-rest-api` container.

## Prerequisites

- Docker and Docker Compose
- Node.js >= 22 with `tsx` available (`npx tsx`)
- Two phone numbers capable of receiving SMS:
  - **Primary**: registered inside the container (the "bot" number)
  - **Recipient**: a second phone that will receive test messages

## Quick Start

```bash
# 1. Start the container and register your phone number
./setup.sh

# 2. Run the E2E test suite
npx tsx e2e-test.ts

# 3. Tear down when done
./teardown.sh
```

## Registration Flow

`setup.sh` handles registration interactively:

1. Starts `signal-cli-rest-api` via Docker Compose.
2. Polls `/api/v1/about` until the API is healthy (up to 120 seconds).
3. Prompts for your phone number in E.164 format (e.g. `+15551234567`).
4. Calls `POST /api/v1/register/{number}` which triggers an SMS verification code.
5. Prompts for the verification code from the SMS.
6. Calls `POST /api/v1/register/{number}/verify/{code}` to complete registration.
7. Prompts for a test recipient number (the second phone).
8. Writes all credentials to `.env`.

If the number is already registered from a previous run (and the volume was
preserved), registration may return HTTP 409 — the script handles this
gracefully.

## Test Scenarios

| # | Test | What It Does |
|---|------|--------------|
| 1 | Health check | `GET /api/v1/about` returns 200 with version info |
| 2 | Send text message | `POST /api/v2/send` to recipient, expects 2xx |
| 3 | Send with attachment | Sends a 1x1 PNG as base64 attachment, expects 2xx |
| 4 | Receive message (SSE) | Connects to the SSE endpoint, validates content-type |
| 5 | Typing indicator | `PUT /api/v1/typing-indicator/{number}`, expects 2xx |
| 6 | Reaction | Sends a message then reacts to it with a thumbs-up |
| 7 | Read receipt | Sends a read receipt for a synthetic timestamp |
| 8 | Group operations | `GET /api/v1/groups/{number}`, expects array (may be empty) |

## Testing with Two Phones

The E2E suite requires a second phone number (`SIGNAL_TEST_RECIPIENT`) to act as
the message destination. This must be a real phone with Signal installed.

- **Send tests (2, 3, 5, 6, 7)**: The recipient phone will receive messages,
  typing indicators, and reactions. No action needed on the recipient side.
- **Receive test (4)**: The test validates that the SSE endpoint is connectable
  and returns the correct content-type. To fully validate incoming message
  parsing, send a message from the recipient phone to the bot number while
  the test is running.
- **Group test (8)**: Lists groups the bot belongs to. If you want to test
  group functionality, create a group on the recipient phone and add the bot
  number before running tests.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SIGNAL_API_URL` | Base URL of signal-cli-rest-api | `http://localhost:8080` |
| `SIGNAL_NUMBER` | Registered bot phone number (E.164) | — |
| `SIGNAL_TEST_RECIPIENT` | Second phone number for receiving (E.164) | — |

## Limitations

- **No programmatic inbound**: Signal does not allow sending messages from the
  recipient side programmatically without registering a second signal-cli
  instance. The SSE receive test validates connectivity, not full message
  parsing.
- **Rate limits**: Signal enforces sending rate limits. Running the suite
  repeatedly in quick succession may trigger 429 errors. Wait a few minutes
  between runs.
- **Captcha**: Some registrations require a captcha. If `setup.sh` registration
  fails, you may need to solve a captcha manually via the signal-cli-rest-api
  Swagger UI at `http://localhost:8080/api`.
- **Phone number reuse**: A phone number can only be registered to one Signal
  client at a time. Registering it in the test container will unregister it
  from your personal Signal app. Use a dedicated test number.
- **Volume persistence**: The Docker volume `signal-cli-data` persists
  registration across restarts. Run `./teardown.sh` (which uses `down -v`)
  to wipe it for a fresh start.
- **Attachment format**: The signal-cli-rest-api expects base64 attachments in
  the format `data:<mime>;filename=<name>;base64,<data>`. The test generates
  a valid 1x1 PNG in this format.
