/**
 * MattermostWebSocket — persistent WebSocket connection to the Mattermost
 * real-time API with auth challenge, ping/pong watchdog, and exponential
 * backoff reconnect.
 *
 * GOTCHA: `data.post`, `data.reaction`, `data.mentions` in WS frames are
 * JSON-encoded STRINGS that must be JSON.parse()-d before use.
 */

import { createChildLogger } from '@openacp/plugin-sdk'
import type { MattermostPost, MattermostWSEvent } from './types.js'

const log = createChildLogger({ module: 'mattermost:ws' })

const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 90_000
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 300_000 // 5 minutes
const JITTER_RATIO = 0.3

export type WSEventHandler = (event: MattermostWSEvent) => void | Promise<void>

export interface MattermostWebSocketOptions {
  /** Full base URL, e.g. "https://mattermost.example.com" */
  baseUrl: string
  /** Bot personal access token */
  token: string
  /** Called for every incoming WS event */
  onEvent: WSEventHandler
  /** Called when the connection is established */
  onConnect?: () => void
  /** Called when the connection drops (before reconnect) */
  onDisconnect?: (code: number, reason: string) => void
  /** Called on fatal error that prevents reconnection */
  onError?: (err: Error) => void
  /** Called on authentication failure — server returned status FAIL for auth challenge */
  onAuthError?: (detail: string) => void
}

/** Timeout for pending request responses (seq_reply matching) */
const SEQ_REPLY_TIMEOUT_MS = 5_000

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * Derive the WebSocket URL from the HTTP base URL.
 * Replace http(s) with ws(s) and append /api/v4/websocket.
 */
function deriveWsUrl(baseUrl: string): string {
  return baseUrl
    .replace(/^http/, 'ws')
    .replace(/\/+$/, '') + '/api/v4/websocket'
}

export class MattermostWebSocket {
  private ws: WebSocket | null = null
  private seq = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private lastPongAt = 0
  private backoffMs = INITIAL_BACKOFF_MS
  private shouldReconnect = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRequests = new Map<number, PendingRequest>()
  private readonly wsUrl: string
  private readonly token: string
  private readonly onEvent: WSEventHandler
  private readonly onConnect?: () => void
  private readonly onDisconnect?: (code: number, reason: string) => void
  private readonly onError?: (err: Error) => void
  private readonly onAuthError?: (detail: string) => void

  constructor(opts: MattermostWebSocketOptions) {
    this.wsUrl = deriveWsUrl(opts.baseUrl)
    this.token = opts.token
    this.onEvent = opts.onEvent
    this.onConnect = opts.onConnect
    this.onDisconnect = opts.onDisconnect
    this.onError = opts.onError
    this.onAuthError = opts.onAuthError
  }

  /** Start the WebSocket connection loop. */
  connect(): void {
    this.shouldReconnect = true
    this.doConnect()
  }

  /** Permanently close the connection and stop reconnecting. */
  disconnect(): void {
    this.shouldReconnect = false
    this.clearTimers()
    this.rejectAllPending('WebSocket disconnected')
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close(1000, 'adapter shutdown') } catch { /* already closed */ }
      this.ws = null
    }
  }

  /** Send a raw JSON action frame. */
  send(action: string, data?: Record<string, unknown>): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return -1
    this.seq++
    const frame = JSON.stringify({ seq: this.seq, action, data })
    this.ws.send(frame)
    return this.seq
  }

  /**
   * Send an action frame and wait for the seq_reply response.
   * Rejects after SEQ_REPLY_TIMEOUT_MS if no response is received.
   */
  sendWithReply(action: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const seqNum = this.send(action, data)
    if (seqNum === -1) {
      return Promise.reject(new Error('WebSocket not connected'))
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(seqNum)
        reject(new Error(`seq_reply timeout for seq ${seqNum} (action: ${action})`))
      }, SEQ_REPLY_TIMEOUT_MS)
      this.pendingRequests.set(seqNum, { resolve, reject, timeout })
    })
  }

  /** Send a typing indicator via WebSocket. */
  sendTyping(channelId: string, parentId?: string): void {
    this.send('user_typing', {
      channel_id: channelId,
      ...(parentId ? { parent_id: parentId } : {}),
    })
  }

  private doConnect(): void {
    if (!this.shouldReconnect) return

    log.info({ url: this.wsUrl }, '[MM_WS] Connecting')

    try {
      this.ws = new WebSocket(this.wsUrl)
    } catch (err) {
      log.error({ err }, '[MM_WS] Failed to create WebSocket')
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      log.info('[MM_WS] Connected, sending auth challenge')
      this.seq = 0
      this.backoffMs = INITIAL_BACKOFF_MS
      this.lastPongAt = Date.now()

      // Auth challenge — first frame after open, tracked via sendWithReply
      this.sendWithReply('authentication_challenge', { token: this.token })
        .then((reply) => {
          const status = reply?.status as string | undefined
          if (status === 'FAIL') {
            const detail = String(reply?.error ?? 'Authentication failed')
            log.error({ detail }, '[MM_WS] Auth challenge failed')
            this.shouldReconnect = false
            this.onAuthError?.(detail)
            try { this.ws?.close(4001, 'auth failed') } catch { /* ignore */ }
            return
          }
          log.info('[MM_WS] Auth challenge succeeded')
          this.startPingLoop()
          this.onConnect?.()
        })
        .catch((err) => {
          log.error({ err }, '[MM_WS] Auth challenge timed out or failed')
          // Still start the ping loop — the connection might work despite timeout
          this.startPingLoop()
          this.onConnect?.()
        })
    }

    this.ws.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string'
        ? event.data
        : String(event.data)

      // Any incoming frame counts as pong
      this.lastPongAt = Date.now()

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return
      }

      // Handle seq_reply responses (match to pending requests)
      const seqReply = parsed.seq_reply as number | undefined
      if (seqReply != null) {
        const pending = this.pendingRequests.get(seqReply)
        if (pending) {
          clearTimeout(pending.timeout)
          this.pendingRequests.delete(seqReply)
          pending.resolve(parsed as Record<string, unknown>)
        }
        // seq_reply frames with no event field are pure responses — skip event dispatch
        if (!parsed.event) return
      }

      // Pong response — no event field
      if (!parsed.event) return

      const wsEvent = parsed as unknown as MattermostWSEvent

      try {
        const result = this.onEvent(wsEvent)
        // Handle async handlers — fire and forget but log errors
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            log.error({ err, event: wsEvent.event }, '[MM_WS] Event handler error')
          })
        }
      } catch (err) {
        log.error({ err, event: wsEvent.event }, '[MM_WS] Event handler error')
      }
    }

    this.ws.onclose = (event: CloseEvent) => {
      log.warn(
        { code: event.code, reason: event.reason },
        '[MM_WS] Connection closed',
      )
      this.clearTimers()
      this.rejectAllPending('WebSocket connection closed')
      this.onDisconnect?.(event.code, event.reason)
      this.scheduleReconnect()
    }

    this.ws.onerror = (event: Event) => {
      const errMsg = (event as ErrorEvent).message ?? 'Unknown WebSocket error'
      log.error({ error: errMsg }, '[MM_WS] WebSocket error')
      this.onError?.(new Error(errMsg))
    }
  }

  private startPingLoop(): void {
    this.clearTimers()
    this.pingTimer = setInterval(() => {
      // Send ping (pong_no_data)
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send('ping')
      }

      // Check pong timeout
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        log.warn('[MM_WS] Pong timeout, forcing reconnect')
        try { this.ws?.close(4000, 'pong timeout') } catch { /* ignore */ }
      }
    }, PING_INTERVAL_MS)
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  /** Reject all pending seq_reply requests with the given reason. */
  private rejectAllPending(reason: string): void {
    for (const [_seq, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(reason))
    }
    this.pendingRequests.clear()
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return
    const jitter = this.backoffMs * JITTER_RATIO * (Math.random() * 2 - 1)
    const delay = Math.max(500, Math.round(this.backoffMs + jitter))
    log.info({ delayMs: delay }, '[MM_WS] Scheduling reconnect')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect()
    }, delay)
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
  }
}

// ─── WS event parsing helpers ────────────────────────────────────────────────

/**
 * Parse the `data.post` JSON-encoded string from a `posted` event.
 * Returns null if parsing fails or event is not a posted event.
 */
export function parsePostedEvent(event: MattermostWSEvent): MattermostPost | null {
  if (event.event !== 'posted' && event.event !== 'post_edited') return null
  const postStr = event.data?.post
  if (!postStr) return null
  try {
    return JSON.parse(postStr) as MattermostPost
  } catch {
    return null
  }
}

/**
 * Parse the `data.reaction` JSON-encoded string from a reaction event.
 */
export function parseReactionEvent(event: MattermostWSEvent): {
  userId: string
  postId: string
  emojiName: string
} | null {
  if (event.event !== 'reaction_added' && event.event !== 'reaction_removed') return null
  const reactionStr = event.data?.reaction
  if (!reactionStr) return null
  try {
    const r = JSON.parse(reactionStr) as Record<string, unknown>
    const userId = String(r.user_id ?? '')
    const postId = String(r.post_id ?? '')
    const emojiName = String(r.emoji_name ?? '')
    if (!userId || !postId || !emojiName) return null
    return { userId, postId, emojiName }
  } catch {
    return null
  }
}

/**
 * Parse the `data.mentions` JSON-encoded string (array of user IDs).
 */
export function parseMentions(event: MattermostWSEvent): string[] {
  const mentionsStr = event.data?.mentions
  if (!mentionsStr) return []
  try {
    const arr = JSON.parse(mentionsStr) as unknown
    if (Array.isArray(arr)) return arr.map(String)
    return []
  } catch {
    return []
  }
}
