# @openacp/telegram-adapter-kiros

Drop-in replacement for OpenACP's built-in Telegram adapter, adding **multi-chat parallel sessions** for DM, groups, and supergroups.

## What's different from upstream

| Feature | Upstream | This version |
|---------|----------|-------------|
| DM support | ❌ Supergroup only | ✅ Full DM support |
| Group support | ❌ Supergroup only | ✅ Plain groups work |
| Parallel sessions | ❌ Single chat | ✅ DM + N groups simultaneously |
| Typing indicators | ✅ Forum topics only | ✅ DM + groups + topics |
| Token usage display | Always shown | Suppressed in DM mode |
| Forum topics | ✅ Required | ✅ Optional (skipped for non-forum) |

## Patched files

- **adapter.ts** — multi-chat session routing, typing pump redesign, per-session chatId
- **draft-manager.ts** — per-session chatId override for message drafts  
- **topics.ts** — DM mode detection, skip forum topic creation for private chats

## Key changes

1. **`ensureDmSession(chatId)`** — creates/resumes sessions per chat, stores chatId for routing
2. **threadId prefix `"c" + chatId`** — makes `Number()` return NaN → 0, so Telegram's `message_thread_id` is stripped by the grammy transformer
3. **Typing pump `(chatId, threadId)` composite key** — parallel pumps for parallel chats, start/stop keys always match
4. **`getSessionChatId(sessionId)`** — routes replies to correct chat (DM/group) instead of global boot chatId
5. **All 5 media handlers** (photo/document/voice/audio/video_note) — full DM/group support with session creation and typing

## Install

```bash
# Into an existing openacp installation:
./install.sh /path/to/universal-bridge-openacp

# Or with default path:
./install.sh

# Then restart openacp
```

## E2E Testing

```bash
# Bot API smoke test (no credentials needed):
bash /tmp/kir-bridges/test-openacp.sh both

# Full telethon E2E (needs TELEGRAM_API_ID/HASH in ~/.nth-kir-keys.env):
python3 /tmp/kir-bridges/test-openacp-e2e.py
```
