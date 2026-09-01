# Agent Guidelines - acr-bridge

## Platform Bridge Discipline
1. **Lossless Event Mapping**: Normalize platform-specific rich text and attachments into canonical ACR message schemas.
2. **Idempotent Webhooks**: De-duplicate inbound webhook events by transaction ID / delivery signature.
3. **Rate-Limit Resilience**: Implement exponential backoff queues for external platform API rate limits.
