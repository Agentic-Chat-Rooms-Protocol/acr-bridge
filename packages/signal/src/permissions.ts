import { createChildLogger } from '@openacp/plugin-sdk'
import type { PermissionRequest } from '@openacp/plugin-sdk'
import { formatPermissionRequest } from './formatting.js'

const log = createChildLogger({ module: 'signal:permissions' })

// ─── Types ───────────────────────────────────────────────────────────────────

interface PendingPermission {
  sessionId: string
  requestId: string
  options: Array<{ id: string; isAllow: boolean; label: string }>
  /** Timestamp when the request was created. */
  createdAt: number
}

interface PermissionResolveCallback {
  (optionId: string): void
}

// ─── PermissionHandler ───────────────────────────────────────────────────────

/**
 * Text-based permission handler for Signal.
 *
 * Signal has no interactive buttons, so permissions are presented as
 * numbered text options. The user replies with a number to select an option.
 *
 * Example interaction:
 *   Bot: "Permission request:
 *         Allow execution of `rm -rf /tmp/cache`?
 *         Reply 1 to Allow: Yes, proceed
 *         Reply 2 to Deny: No, cancel"
 *   User: "1"
 *   Bot resolves the permission with option 1 (Allow).
 *
 * Pending permissions expire after EXPIRY_MS to prevent stale state.
 */
export class SignalPermissionHandler {
  /** Map of chatId → pending permission. Only one pending permission per chat. */
  private pending = new Map<string, PendingPermission>()
  /** Map of sessionId → resolve callback from the session's permission gate. */
  private resolvers = new Map<string, PermissionResolveCallback>()

  private static readonly EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

  /**
   * Register a permission resolver for a session.
   * Called by the adapter when a session's permission gate is active.
   */
  registerResolver(sessionId: string, resolver: PermissionResolveCallback): void {
    this.resolvers.set(sessionId, resolver)
  }

  /**
   * Unregister a permission resolver when the session ends.
   */
  unregisterResolver(sessionId: string): void {
    this.resolvers.delete(sessionId)
  }

  /**
   * Format and track a permission request for a chat.
   *
   * Returns the formatted text to send to the user. The adapter
   * is responsible for actually sending the message.
   */
  createPermissionRequest(
    chatId: string,
    sessionId: string,
    request: PermissionRequest,
  ): string {
    // Clean up expired pending permissions
    this.cleanupExpired()

    const pending: PendingPermission = {
      sessionId,
      requestId: request.id,
      options: request.options.map((o) => ({
        id: o.id,
        isAllow: o.isAllow,
        label: o.label,
      })),
      createdAt: Date.now(),
    }

    this.pending.set(chatId, pending)

    return formatPermissionRequest(request.description, request.options)
  }

  /**
   * Try to handle an incoming message as a permission response.
   *
   * If the message is a valid number reply that matches a pending
   * permission, resolves the permission and returns true.
   * Otherwise returns false (message is not a permission response).
   */
  tryHandleResponse(chatId: string, messageText: string): boolean {
    const pending = this.pending.get(chatId)
    if (!pending) return false

    // Check expiry
    if (Date.now() - pending.createdAt > SignalPermissionHandler.EXPIRY_MS) {
      this.pending.delete(chatId)
      return false
    }

    // Parse number reply
    const trimmed = messageText.trim()
    const num = parseInt(trimmed, 10)
    if (isNaN(num) || num < 1 || num > pending.options.length) {
      return false
    }

    const selected = pending.options[num - 1]
    if (!selected) return false

    // Resolve the permission
    const resolver = this.resolvers.get(pending.sessionId)
    if (resolver) {
      log.info(
        { sessionId: pending.sessionId, requestId: pending.requestId, optionId: selected.id, isAllow: selected.isAllow },
        '[SIGNAL_PERMISSIONS] Permission responded',
      )
      resolver(selected.id)
    } else {
      log.warn(
        { sessionId: pending.sessionId, requestId: pending.requestId },
        '[SIGNAL_PERMISSIONS] No resolver found for session',
      )
    }

    this.pending.delete(chatId)
    return true
  }

  /**
   * Check if there is a pending permission for a chat.
   */
  hasPending(chatId: string): boolean {
    const pending = this.pending.get(chatId)
    if (!pending) return false
    if (Date.now() - pending.createdAt > SignalPermissionHandler.EXPIRY_MS) {
      this.pending.delete(chatId)
      return false
    }
    return true
  }

  /**
   * Cancel a pending permission for a chat.
   */
  cancel(chatId: string): void {
    this.pending.delete(chatId)
  }

  /**
   * Clear all pending permissions.
   */
  clear(): void {
    this.pending.clear()
    this.resolvers.clear()
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const [chatId, pending] of this.pending) {
      if (now - pending.createdAt > SignalPermissionHandler.EXPIRY_MS) {
        this.pending.delete(chatId)
      }
    }
  }
}
