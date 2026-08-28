# @openacp/mattermost-adapter

OpenACP Mattermost adapter plugin -- full-featured messenger integration with threading, streaming, reactions, and file uploads.

## Features

- **Streaming**: Edit-in-place message updates via `PUT /posts/{id}`
- **Threads**: Collapsed Reply Threads (CRT) with flat `root_id` threading
- **Reactions**: Full reaction API (`POST /reactions`, `DELETE`)
- **File upload**: Multipart upload via `POST /files`
- **Rich formatting**: Native Mattermost markdown
- **Typing indicators**: WebSocket-based typing actions
- **Session isolation**: Per-thread session keying (`channelId:rootPostId`)
- **Loop guard**: `props.openacp_<instanceId>` stamp prevents self-reply loops
- **Rate limiting**: Automatic retry on 429 with `X-Ratelimit-Reset` parsing
- **Reconnect**: Exponential backoff (1s to 5min) with jitter on WebSocket disconnect
- **DM support**: Auto-respond in DMs and group DMs, trigger/mention required in team channels

## Setup

### Prerequisites

1. A Mattermost server (self-hosted or cloud)
2. A bot account with a Personal Access Token (PAT)
3. Bot added to the channels you want to monitor

### Creating a Bot Account

1. Go to **System Console > Integrations > Bot Accounts**
2. Enable bot account creation
3. Create a new bot account
4. Generate a Personal Access Token from the bot's profile

### Installation

```bash
npm install @openacp/mattermost-adapter
```

### Configuration

The adapter is configured through the OpenACP plugin install flow:

```
openacp plugin install @openacp/mattermost-adapter
```

You will be prompted for:
- **Server URL**: e.g. `https://mattermost.example.com`
- **Bot token**: Personal Access Token from the bot account
- **Channel ID** (optional): Specific channel to monitor
- **Trigger phrase** (optional): e.g. `@bot` for team channel activation

### Manual Configuration

```typescript
{
  url: 'https://mattermost.example.com',
  token: 'your-bot-pat-here',
  channelId: 'optional-channel-id',
  trigger: '@bot',
  maxMessageLength: 4000,
}
```

## Architecture

```
src/
  index.ts          -- Plugin entry point (createPlugin -> OpenACPPlugin)
  adapter.ts        -- MattermostAdapter extends MessagingAdapter
  renderer.ts       -- MattermostRenderer extends BaseRenderer (markdown output)
  formatting.ts     -- Pure formatting functions
  activity.ts       -- ThinkingIndicator + ToolCard for live status updates
  permissions.ts    -- Number-based permission request/response
  types.ts          -- MattermostConfig + API types
  client.ts         -- REST API v4 client (native fetch, Bearer auth)
  websocket.ts      -- WebSocket connection with auth, ping, reconnect
  threading.ts      -- resolveRootId, buildSessionId, DM detection
  draft-manager.ts  -- Edit-in-place streaming via PUT /posts/{id}
```

## Message Flow

1. **Inbound**: WebSocket `posted` event -> parse post -> check loop guard -> resolve/create session -> forward to OpenACP core
2. **Outbound**: OpenACP sends OutgoingMessage -> MessagingAdapter dispatches to handler -> draft-manager streams via edit-in-place -> finalize on session end

## Limitations

- Voice messages are not supported (`voice: false`)
- Interactive message buttons use a number-reply pattern (Mattermost lacks generic callback routing like Telegram/Slack)
- WebSocket events for missed messages during disconnect require `since`-based backfill
- Never call `/users/logout` with PAT auth (invalidates the token permanently)

## Development

```bash
pnpm install
pnpm test          # Run tests
pnpm test:watch    # Watch mode
pnpm build         # TypeScript build
pnpm lint          # Type-check
```

## License

MIT
