# WhatsApp E2E Tests

End-to-end tests for the OpenACP WhatsApp adapter using [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web API).

Unlike other messenger E2E setups, WhatsApp requires no Docker containers. We connect directly to WhatsApp Web via Baileys using a real phone number.

## Prerequisites

- Node.js >= 22
- pnpm >= 9
- A **dedicated phone number** with WhatsApp (see warnings below)

## Setup

```bash
cd e2e/whatsapp
pnpm install
```

## 1. Connect (first run)

### QR code flow (default)

```bash
npx tsx connect.ts
```

Scan the QR code displayed in the terminal with your phone:
**WhatsApp > Linked Devices > Link a Device**

### Pairing code flow (headless / remote)

```bash
npx tsx connect.ts --pairing-code +1234567890
```

A numeric pairing code will be printed. Enter it on your phone:
**WhatsApp > Linked Devices > Link a Device > Link with phone number**

The session is saved to `./auth-state/`. Subsequent runs reuse it without re-pairing.

## 2. Run E2E tests

```bash
WHATSAPP_TEST_RECIPIENT=1234567890@s.whatsapp.net npx tsx e2e-test.ts
```

Or for a group:

```bash
WHATSAPP_TEST_RECIPIENT=120363012345678901@g.us npx tsx e2e-test.ts
```

You can also place the variable in a `.env` file (copy `.env.example`).

## Test scenarios

| # | Test | Description |
|---|------|-------------|
| 1 | Send text | Plain text message |
| 2 | Send image | 1x1 red PNG with caption |
| 3 | Send document | Text file attachment |
| 4 | Send voice note | Ogg/Opus audio with PTT flag |
| 5 | Send reaction | Thumbs-up on last sent message |
| 6 | Typing indicator | composing -> 2s pause -> paused |
| 7 | Receive message | Listen for incoming messages (30s) |
| 8 | Group list | Fetch all participating groups |
| 9 | Mentions | Send message with @mention |
| 10 | Reply/quote | Send a message, then reply to it |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_AUTH_DIR` | `./auth-state` | Directory for session credentials |
| `WHATSAPP_TEST_RECIPIENT` | (required) | JID to send test messages to |

## Warnings

**Ban risk**: WhatsApp may temporarily or permanently ban accounts that send automated messages. Recommendations:

- Use a **disposable SIM / burner number** -- never your personal number
- Do not run tests in rapid succession or at high volume
- Keep the test recipient to a single known number or a private test group
- If banned, the session in `auth-state/` becomes invalid -- delete it and re-pair with a new number

**Rate limits**: WhatsApp enforces undocumented rate limits. The test suite includes 1-second delays between tests to reduce risk.

## File structure

```
e2e/whatsapp/
  connect.ts          # Standalone connection / pairing script
  e2e-test.ts         # Full E2E test suite
  package.json        # Dependencies
  .env.example        # Environment template
  README.md           # This file
  fixtures/
    test-image.png    # Auto-generated 1x1 red pixel PNG
    test-doc.txt      # Plain text test document
    test-audio.ogg    # Auto-generated minimal Ogg/Opus file
  auth-state/         # Created at runtime (gitignored)
```
