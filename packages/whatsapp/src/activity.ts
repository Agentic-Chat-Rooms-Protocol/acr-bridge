import { createChildLogger } from '@openacp/plugin-sdk'
import type { BaileysSocket } from './client.js'

const log = createChildLogger({ module: 'whatsapp:activity' })

/**
 * Typing indicator interval in ms.
 * WhatsApp "composing" presence lasts ~25 seconds, but we re-fire every
 * 20 seconds to maintain continuous typing indication.
 */
const TYPING_INTERVAL_MS = 20_000

/**
 * ActivityTracker manages WhatsApp presence updates (typing indicators).
 *
 * WhatsApp uses `sendPresenceUpdate("composing", jid)` to show typing,
 * and `sendPresenceUpdate("paused", jid)` to stop it. Unlike Telegram,
 * there is no message editing or "thinking" indicator — just typing.
 */
export class ActivityTracker {
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(
    private getSocket: () => BaileysSocket | null,
  ) {}

  /**
   * Start showing "typing..." for a specific JID.
   * Idempotent — safe to call multiple times for the same JID.
   */
  startTyping(jid: string): void {
    if (this.typingTimers.has(jid)) return

    const sock = this.getSocket()
    if (!sock) return

    // Send immediately
    sock.sendPresenceUpdate('composing', jid).catch((err) => {
      log.debug({ err, jid }, '[WHATSAPP_ACTIVITY] Failed to send composing presence')
    })

    // Re-send periodically to keep the indicator alive
    const timer = setInterval(() => {
      const s = this.getSocket()
      if (!s) {
        this.stopTyping(jid)
        return
      }
      s.sendPresenceUpdate('composing', jid).catch((err) => {
        log.debug({ err, jid }, '[WHATSAPP_ACTIVITY] Failed to refresh composing presence')
      })
    }, TYPING_INTERVAL_MS)

    this.typingTimers.set(jid, timer)
  }

  /**
   * Stop showing "typing..." for a specific JID.
   * Sends a "paused" presence update and clears the timer.
   */
  stopTyping(jid: string): void {
    const timer = this.typingTimers.get(jid)
    if (timer) {
      clearInterval(timer)
      this.typingTimers.delete(jid)
    }

    const sock = this.getSocket()
    if (sock) {
      sock.sendPresenceUpdate('paused', jid).catch((err) => {
        log.debug({ err, jid }, '[WHATSAPP_ACTIVITY] Failed to send paused presence')
      })
    }
  }

  /**
   * Stop all active typing indicators.
   * Called during shutdown/cleanup.
   */
  stopAll(): void {
    const keys = [...this.typingTimers.keys()]
    for (const key of keys) {
      this.stopTyping(key)
    }
  }

  /** Whether typing is currently active for a JID. */
  isTyping(jid: string): boolean {
    return this.typingTimers.has(jid)
  }
}
