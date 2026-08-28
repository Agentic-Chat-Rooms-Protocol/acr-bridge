# Mattermost Adapter E2E Tests

End-to-end tests for the OpenACP Mattermost adapter running against a real
Mattermost server in Docker.

## Prerequisites

- Docker and Docker Compose
- Node.js 22+ (for native `fetch` and `WebSocket`)
- `npx tsx` (ships with `tsx` in npm)

## Quick Start

```bash
# 1. Start Mattermost + PostgreSQL
docker compose up -d

# 2. Bootstrap admin, team, bot, channels, and generate .env
./setup.sh

# 3. Run the E2E test suite
npx tsx e2e-test.ts

# 4. Tear down containers and volumes
./teardown.sh
```

## What the Tests Cover

| # | Scenario | Verifies |
|---|----------|----------|
| 1 | Text message | POST /posts creates a post with correct message |
| 2 | Thread reply | Reply carries correct root_id |
| 3 | Edit message | PUT /posts/{id} updates the message text |
| 4 | File upload | Multipart upload returns file_ids on the post |
| 5 | Reactions | POST /reactions attaches emoji to a post |
| 6 | Direct message | DM channel creation and message delivery |
| 7 | Mentions | @mention populates the metadata.mentions field |
| 8 | Long message | 10 000-char payload is accepted without truncation |
| 9 | Typing indicator | POST /users/me/typing returns 200 |
| 10 | Reconnect | WebSocket close triggers automatic reconnect |

## Environment Variables

See `.env.example` for the full list. `setup.sh` generates a `.env`
automatically; the test script reads it at startup.

## Troubleshooting

- **Mattermost won't start**: Check `docker compose logs mattermost` for
  database connection errors. The PostgreSQL healthcheck must pass first.
- **setup.sh fails at login**: The first user created on a fresh Mattermost
  instance becomes system_admin automatically. If the instance is not fresh,
  you may need to adjust the admin credentials.
- **WebSocket tests flaky**: The reconnect test closes the WS and waits up to
  10 s for re-establishment. If CI is slow, increase `RECONNECT_WAIT_MS`.
