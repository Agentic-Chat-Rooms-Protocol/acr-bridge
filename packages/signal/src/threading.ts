/**
 * Threading / session key utilities for Signal.
 *
 * Signal has no native threading. Sessions are keyed by:
 *   - 1:1 chats: the remote phone number (e.g. "+15551234567")
 *   - Groups: "group:<groupId>"
 *
 * This module re-exports the session key functions from events.ts
 * so consumers can import them from a dedicated threading module.
 */

export { extractSessionKey, isGroupMessage } from './events.js'
