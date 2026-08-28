# @openacp/signal-adapter

OpenACP Signal adapter using [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) as the transport layer.

## Prerequisites

1. **signal-cli-rest-api** running as a Docker container:

   ```bash
   docker run -d --name signal-cli-rest-api \
     -p 8080:8080 \
     -v signal-cli-data:/home/.local/share/signal-cli \
     -e MODE=json-rpc \
     bbernhard/signal-cli-rest-api
   ```

2. A registered Signal phone number linked to the signal-cli instance.
   Register via the REST API or the signal-cli CLI tool.

## Installation

```bash
pnpm add @openacp/signal-adapter
```

## Configuration

The adapter is configured via the OpenACP plugin system. During `openacp install`, you will be prompted for:

| Setting          | Description                                        | Required |
|------------------|----------------------------------------------------|----------|
| `apiUrl`         | Base URL of signal-cli-rest-api (e.g. `http://localhost:8080`) | Yes |
| `number`         | Signal phone number in E.164 format (e.g. `+15551234567`) | Yes |
| `authHeader`     | Authorization header if REST API requires auth      | No |
| `allowedSenders` | Array of phone numbers/UUIDs allowed to interact    | No |

## Features

- **Inbound messages**: Text, attachments, reactions, voice notes via SSE stream
- **Outbound messages**: Text, attachments (base64), reactions, typing indicators
- **Groups**: Full group v2 support with member resolution and caching
- **Permissions**: Text-based numbered-option permission UI
- **Reconnect**: Automatic SSE reconnection with exponential backoff and jitter
- **Low-fidelity rendering**: Complex types (tools, plans, usage) collapsed to plain text

## Capabilities

```
streaming:      false  (Signal has no message editing)
richFormatting: false  (Plain text only)
threads:        false  (No native thread concept)
reactions:      true   (Emoji reactions supported)
fileUpload:     true   (Base64 attachments)
voice:          true   (Voice note attachments)
```

## Architecture

The adapter communicates with Signal exclusively through the signal-cli-rest-api HTTP REST interface. No Signal protocol code is linked into this package, so the MIT license applies without GPL concerns.

```
Signal Network <-> signal-cli daemon <-> signal-cli-rest-api (HTTP) <-> @openacp/signal-adapter
                   (GPLv3, external)      (GPLv3, external Docker)     (MIT, this package)
```

## Development

```bash
pnpm install
pnpm test        # Run tests
pnpm build       # Build TypeScript
pnpm lint        # Type check
```

## License

MIT -- see [LICENSE](./LICENSE).
