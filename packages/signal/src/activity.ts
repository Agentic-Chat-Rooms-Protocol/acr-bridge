import { createChildLogger } from '@openacp/plugin-sdk'
import type { SignalClient } from './client.js'

const log = createChildLogger({ module: 'signal:activity' })

// ─── Typing Indicator ────────────────────────────────────────────────────────

/**
 * Signal typing indicators expire after ~15 seconds.
 * We re-send every 12 seconds to keep the indicator alive.
 */
const TYPING_REFRESH_MS = 12_000

/**
 * Manages typing indicators for a Signal conversation.
 *
 * Signal's typing indicators expire automatically after ~15s, so this
 * class periodically re-fires them while the agent is processing.
 * Each session gets its own TypingPump instance.
 */
export class TypingPump {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly client: SignalClient
  private readonly chatId: string
  private readonly isGroup: boolean

  constructor(client: SignalClient, chatId: string, isGroup: boolean) {
    this.client = client
    this.chatId = chatId
    this.isGroup = isGroup
  }

  /**
   * Start sending periodic typing indicators.
   * Idempotent -- safe to call multiple times.
   */
  start(): void {
    if (this.timer) return

    // Fire immediately
    this.fire()

    // Then fire periodically
    this.timer = setInterval(() => {
      this.fire()
    }, TYPING_REFRESH_MS)
  }

  /**
   * Stop sending typing indicators.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Whether the typing pump is currently active. */
  isActive(): boolean {
    return this.timer !== null
  }

  private fire(): void {
    if (this.isGroup) {
      // For groups, extract the group ID from the chatId (strip "group:" prefix)
      const groupId = this.chatId.startsWith('group:') ? this.chatId.slice(6) : this.chatId
      this.client.sendGroupTypingIndicator(groupId).catch((err) => {
        log.debug({ err, chatId: this.chatId }, '[SIGNAL_ACTIVITY] Group typing indicator failed')
      })
    } else {
      this.client.sendTypingIndicator(this.chatId).catch((err) => {
        log.debug({ err, chatId: this.chatId }, '[SIGNAL_ACTIVITY] Typing indicator failed')
      })
    }
  }
}

// ─── Activity Tracker ────────────────────────────────────────────────────────

/**
 * Per-session activity tracker for Signal.
 *
 * Manages typing indicators and thinking state. Unlike the Telegram
 * adapter, Signal has no message editing, so there is no ThinkingIndicator
 * message or ToolCard. The tracker only manages the typing pump.
 */
export class SignalActivityTracker {
  private typingPump: TypingPump
  private thinking = false

  constructor(client: SignalClient, chatId: string, isGroup: boolean) {
    this.typingPump = new TypingPump(client, chatId, isGroup)
  }

  /**
   * Called when a new user prompt arrives.
   * Starts the typing indicator.
   */
  onNewPrompt(): void {
    this.thinking = false
    this.typingPump.start()
  }

  /**
   * Called when the agent starts thinking.
   * Typing indicator should already be active from onNewPrompt.
   */
  onThought(): void {
    this.thinking = true
    if (!this.typingPump.isActive()) {
      this.typingPump.start()
    }
  }

  /**
   * Called when the agent starts generating text output.
   * Stop the typing indicator since we're about to send messages.
   */
  onTextStart(): void {
    this.thinking = false
    this.typingPump.stop()
  }

  /**
   * Called when tool execution starts.
   * Keep typing indicator active.
   */
  onToolCall(): void {
    if (!this.typingPump.isActive()) {
      this.typingPump.start()
    }
  }

  /**
   * Called when the session ends or on cleanup.
   */
  cleanup(): void {
    this.thinking = false
    this.typingPump.stop()
  }

  /** Whether the agent is currently in a thinking state. */
  isThinking(): boolean {
    return this.thinking
  }
}
