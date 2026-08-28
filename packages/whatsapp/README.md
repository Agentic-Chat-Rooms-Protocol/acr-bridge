# @openacp/whatsapp-adapter

WhatsApp adapter for OpenACP using the [Baileys](https://github.com/WhiskeySockets/Baileys) library (WhatsApp Web multi-device protocol).

## Features

- QR code and pairing code authentication
- 1:1 and group chat support
- Voice notes (push-to-talk)
- Media messages (image, audio, video, document)
- Reactions
- Low-fidelity plain text rendering for tool calls, plans, usage, thoughts
- Permission requests via numbered replies (fallback from buttons)
- Per-JID send throttling (800ms default) for ban risk mitigation
- Exponential backoff reconnection
- Message deduplication
- Allowlist filtering (individual and group JIDs)

## Capabilities

| Capability     | Value   | Notes                          |
|---------------|---------|--------------------------------|
| streaming     | `false` | No message editing support     |
| richFormatting| `false` | Very limited text formatting   |
| threads       | `false` | No native thread concept       |
| reactions     | `true`  | Emoji reactions on messages    |
| fileUpload    | `true`  | Image, audio, video, document  |
| voice         | `true`  | Voice notes (PTT)              |

## Setup

### Install

```bash
pnpm add @openacp/whatsapp-adapter
```

### Configuration

The adapter requires an auth directory for storing Baileys session state:

```typescript
{
  authDir: '/data/whatsapp-auth',       // Required: absolute path
  pairingPhoneNumber: '15551234567',    // Optional: for headless pairing code auth
  allowedJids: ['1234@s.whatsapp.net'], // Optional: restrict to specific chats
  maxMessageLength: 4000,               // Optional: chunk long messages
  perJidMinSpacing: 800,                // Optional: ms between messages to same JID
}
```

### Authentication

**QR Code (default):** Start the adapter and scan the QR code displayed in the terminal with WhatsApp > Linked Devices > Link a Device.

**Pairing Code (headless):** Set `pairingPhoneNumber` in config. The adapter will print a pairing code to the log. Enter it in WhatsApp > Linked Devices > Link a Device > Link with phone number.

## Limitations

- **Unofficial protocol**: WhatsApp Web multi-device protocol is reverse-engineered. Use a disposable SIM for testing.
- **No message editing**: WhatsApp does not support editing sent messages. All output is sent as new messages.
- **No threads**: Each chat (1:1 or group) is a single session. No sub-thread concept.
- **Limited formatting**: Only `*bold*`, `_italic_`, `~strikethrough~`, `` `monospace` `` are supported natively. This adapter renders everything as plain text.
- **Button limitations**: Quick-reply buttons (max 3) are unreliable across WhatsApp versions. The adapter falls back to numbered text lists.
- **Multi-device expiry**: Linked device sessions expire if the primary phone is offline for more than 14 days.
- **Ban risk**: Automated messaging on WhatsApp carries ban risk. The adapter includes throttling and human-like delays, but use WhatsApp Cloud API for production/business.

## Auth State Security

The auth directory contains credentials equivalent to a logged-in WhatsApp session. Treat it as a sensitive secret:

- Do not commit it to version control
- Restrict file system permissions
- Consider encrypting at rest
- Back up periodically (re-linking requires QR scan)

## Development

```bash
pnpm install
pnpm test        # Run tests
pnpm build       # Compile TypeScript
pnpm lint        # Type check
```

## License

MIT
