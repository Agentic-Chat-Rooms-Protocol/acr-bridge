import { createChildLogger } from '@openacp/plugin-sdk'
import type { PermissionRequest } from '@openacp/plugin-sdk'
import type { BaileysSocket } from './client.js'

const log = createChildLogger({ module: 'whatsapp:permissions' })

/** TTL for pending permissions before auto-deny (5 minutes). */
const PERMISSION_TTL_MS = 5 * 60 * 1000

/** A pending permission awaiting user reply. */
interface PendingPermission {
  sessionId: string
  requestId: string
  options: Array<{ id: string; label: string; isAllow: boolean }>
  /** JID the permission request was sent to */
  jid: string
  /** Timer for auto-deny on expiry */
  expiryTimer: ReturnType<typeof setTimeout>
}

/**
 * PermissionHandler for WhatsApp.
 *
 * WhatsApp has very limited interactive UI:
 * - Quick-reply buttons: max 3 buttons with short labels
 * - Fallback: numbered text list ("Reply 1 to allow, 2 to deny")
 *
 * Strategy:
 * 1. If <= 3 options, try sending as WhatsApp buttons message
 * 2. If buttons fail (some WA versions don't support them), fall back to numbered list
 * 3. Always fall back to numbered text list
 *
 * Parse inbound numbered replies (e.g. "1", "2") to resolve permissions.
 */
export class PermissionHandler {
  private pending = new Map<string, PendingPermission>()
  /** Maps JID → most recent pending permission key for numbered reply resolution */
  private jidPending = new Map<string, string>()

  constructor(
    private getSocket: () => BaileysSocket | null,
    private resolvePermission: (sessionId: string, requestId: string, optionId: string) => void,
  ) {}

  /**
   * Send a permission request to the user.
   *
   * Uses numbered text list format since button support is unreliable
   * across WhatsApp versions and client types.
   */
  async sendPermissionRequest(
    sessionId: string,
    jid: string,
    request: PermissionRequest,
  ): Promise<void> {
    const sock = this.getSocket()
    if (!sock) {
      log.warn('[WHATSAPP_PERMISSIONS] Cannot send permission request — not connected')
      return
    }

    const key = `${sessionId}:${request.id}`

    // Set up auto-deny timer
    const expiryTimer = setTimeout(() => {
      const pending = this.pending.get(key)
      if (!pending) return
      // Find the first deny option, or fall back to the first option
      const denyOption = pending.options.find((o) => !o.isAllow) ?? pending.options[0]
      if (denyOption) {
        log.info({ requestId: pending.requestId, optionId: denyOption.id }, '[WHATSAPP_PERMISSIONS] Permission expired — auto-denying')
        this.resolvePermission(pending.sessionId, pending.requestId, denyOption.id)
      }
      this.pending.delete(key)
      this.jidPending.delete(jid)
    }, PERMISSION_TTL_MS)

    this.pending.set(key, {
      sessionId,
      requestId: request.id,
      options: request.options.map((o) => ({
        id: o.id,
        label: o.label,
        isAllow: o.isAllow,
      })),
      jid,
      expiryTimer,
    })
    this.jidPending.set(jid, key)

    // Build numbered list
    const lines: string[] = [`*Permission request:*\n${request.description}\n`]
    for (let i = 0; i < request.options.length; i++) {
      const opt = request.options[i]!
      const marker = opt.isAllow ? '+' : '-'
      lines.push(`${marker} Reply *${i + 1}* for: ${opt.label}`)
    }

    const text = lines.join('\n')

    try {
      // Attempt button message (max 3 buttons)
      if (request.options.length <= 3) {
        try {
          await sock.sendMessage(jid, {
            text: `*Permission request:*\n${request.description}`,
            footer: 'Reply with a number or tap a button',
            buttons: request.options.map((opt, i) => ({
              buttonId: `perm:${i}`,
              buttonText: { displayText: opt.label.slice(0, 20) },
              type: 1,
            })),
          })
          log.info({ sessionId, requestId: request.id }, '[WHATSAPP_PERMISSIONS] Sent button permission request')
          return
        } catch {
          // Button messages may not be supported — fall back to text
          log.debug('[WHATSAPP_PERMISSIONS] Button message failed, falling back to numbered list')
        }
      }

      // Fallback: plain numbered list
      await sock.sendMessage(jid, { text })
      log.info({ sessionId, requestId: request.id }, '[WHATSAPP_PERMISSIONS] Sent numbered permission request')
    } catch (err) {
      log.error({ err, sessionId, requestId: request.id }, '[WHATSAPP_PERMISSIONS] Failed to send permission request')
    }
  }

  /**
   * Try to resolve a pending permission from an inbound message.
   * Returns true if the message was consumed as a permission reply.
   */
  tryResolve(jid: string, text: string): boolean {
    const key = this.jidPending.get(jid)
    if (!key) return false

    const pending = this.pending.get(key)
    if (!pending) {
      this.jidPending.delete(jid)
      return false
    }

    const trimmed = text.trim()

    // Check for numbered reply: "1", "2", "3", etc.
    const num = parseInt(trimmed, 10)
    if (!isNaN(num) && num >= 1 && num <= pending.options.length) {
      const option = pending.options[num - 1]!
      clearTimeout(pending.expiryTimer)
      this.resolvePermission(pending.sessionId, pending.requestId, option.id)
      this.pending.delete(key)
      this.jidPending.delete(jid)
      log.info({ requestId: pending.requestId, optionId: option.id }, '[WHATSAPP_PERMISSIONS] Permission resolved by number')
      return true
    }

    // Check for button callback ID: "perm:0", "perm:1", etc.
    if (trimmed.startsWith('perm:')) {
      const idx = parseInt(trimmed.slice(5), 10)
      if (!isNaN(idx) && idx >= 0 && idx < pending.options.length) {
        const option = pending.options[idx]!
        clearTimeout(pending.expiryTimer)
        this.resolvePermission(pending.sessionId, pending.requestId, option.id)
        this.pending.delete(key)
        this.jidPending.delete(jid)
        log.info({ requestId: pending.requestId, optionId: option.id }, '[WHATSAPP_PERMISSIONS] Permission resolved by button')
        return true
      }
    }

    return false
  }

  /** Remove all pending permissions for a session, clearing expiry timers. */
  clearSession(sessionId: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.expiryTimer)
        this.pending.delete(key)
        this.jidPending.delete(pending.jid)
      }
    }
  }

  /** Whether there is a pending permission for a given JID. */
  hasPending(jid: string): boolean {
    return this.jidPending.has(jid)
  }
}
