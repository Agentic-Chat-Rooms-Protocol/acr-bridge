import { createChildLogger } from '@openacp/plugin-sdk'
import type { SignalAdapterConfig } from './types.js'

const log = createChildLogger({ module: 'signal:client' })

// ─── Types ───────────────────────────────────────────────────────────────────

/** Response from signal-cli-rest-api send endpoint. */
export interface SendResponse {
  timestamp?: number | string
}

/** Health check response from /api/v1/about. */
export interface AboutResponse {
  versions?: Record<string, string>
  mode?: string
}

/** Group metadata from signal-cli-rest-api. */
export interface GroupEntry {
  id: string
  name?: string
  description?: string
  isMember?: boolean
  isBlocked?: boolean
  members?: string[]
  admins?: string[]
}

/** Send message payload. */
export interface SendMessagePayload {
  message?: string
  number: string
  recipients?: string[]
  base64_attachments?: string[]
  text_mode?: 'normal' | 'styled'
  quote_timestamp?: number
  quote_author?: string
}

/** Send group message payload. */
export interface SendGroupMessagePayload {
  message?: string
  number: string
  group_id: string
  base64_attachments?: string[]
  text_mode?: 'normal' | 'styled'
  quote_timestamp?: number
  quote_author?: string
}

/** Typing indicator payload. */
export interface TypingIndicatorPayload {
  recipient: string
}

/** Typing indicator payload for groups. */
export interface GroupTypingIndicatorPayload {
  group_id: string
}

/** Reaction payload. */
export interface ReactionPayload {
  recipient: string
  reaction: string
  target_author: string
  target_timestamp: number
}

/** Reaction payload for groups. */
export interface GroupReactionPayload {
  group_id: string
  reaction: string
  target_author: string
  target_timestamp: number
}

// ─── SignalClient ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * REST client for the signal-cli-rest-api Docker container.
 *
 * All endpoints are prefixed with /api/v1/ per the signal-cli-rest-api spec.
 * The client communicates over HTTP only -- no Signal protocol linking happens
 * in this process, so the MIT license applies (no GPL contamination).
 */
export class SignalClient {
  private readonly baseUrl: string
  private readonly number: string
  private readonly authHeader: string | undefined
  private readonly timeoutMs: number

  constructor(config: Pick<SignalAdapterConfig, 'apiUrl' | 'number' | 'authHeader'>, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, '')
    this.number = config.number
    this.authHeader = config.authHeader
    this.timeoutMs = timeoutMs
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /** Health check via GET /api/v1/about. */
  async healthCheck(): Promise<{ ok: boolean; data?: AboutResponse; error?: string }> {
    try {
      const res = await this.request<AboutResponse>('GET', '/api/v1/about')
      return { ok: true, data: res }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── Send ────────────────────────────────────────────────────────────────

  /** Send a text message to a recipient (1:1). */
  async sendMessage(recipient: string, text: string, options?: {
    attachments?: string[]
    quoteTimestamp?: number
    quoteAuthor?: string
  }): Promise<SendResponse> {
    const payload: SendMessagePayload = {
      message: text,
      number: this.number,
      recipients: [recipient],
      text_mode: 'normal',
    }
    if (options?.attachments?.length) {
      payload.base64_attachments = options.attachments
    }
    if (options?.quoteTimestamp) {
      payload.quote_timestamp = options.quoteTimestamp
      payload.quote_author = options.quoteAuthor ?? recipient
    }
    return this.request<SendResponse>('POST', `/api/v2/send`, payload)
  }

  /** Send a text message to a group. */
  async sendGroupMessage(groupId: string, text: string, options?: {
    attachments?: string[]
    quoteTimestamp?: number
    quoteAuthor?: string
  }): Promise<SendResponse> {
    const payload: SendGroupMessagePayload = {
      message: text,
      number: this.number,
      group_id: groupId,
      text_mode: 'normal',
    }
    if (options?.attachments?.length) {
      payload.base64_attachments = options.attachments
    }
    if (options?.quoteTimestamp) {
      payload.quote_timestamp = options.quoteTimestamp
      payload.quote_author = options.quoteAuthor
    }
    return this.request<SendResponse>('POST', `/api/v2/send`, payload)
  }

  // ── Typing Indicator ───────────────────────────────────────────────────

  /** Send typing indicator to a 1:1 recipient. */
  async sendTypingIndicator(recipient: string): Promise<void> {
    const payload: TypingIndicatorPayload = { recipient }
    await this.request<void>('PUT', `/api/v1/typing-indicator/${encodeURIComponent(this.number)}`, payload)
  }

  /** Send typing indicator to a group. */
  async sendGroupTypingIndicator(groupId: string): Promise<void> {
    const payload: GroupTypingIndicatorPayload = { group_id: groupId }
    await this.request<void>('PUT', `/api/v1/typing-indicator/${encodeURIComponent(this.number)}`, payload)
  }

  // ── Reactions ──────────────────────────────────────────────────────────

  /** Send a reaction to a message (1:1). */
  async sendReaction(recipient: string, emoji: string, targetAuthor: string, targetTimestamp: number): Promise<void> {
    const payload: ReactionPayload = {
      recipient,
      reaction: emoji,
      target_author: targetAuthor,
      target_timestamp: targetTimestamp,
    }
    await this.request<void>('PUT', `/api/v1/reactions/${encodeURIComponent(this.number)}`, payload)
  }

  /** Send a reaction to a message in a group. */
  async sendGroupReaction(groupId: string, emoji: string, targetAuthor: string, targetTimestamp: number): Promise<void> {
    const payload: GroupReactionPayload = {
      group_id: groupId,
      reaction: emoji,
      target_author: targetAuthor,
      target_timestamp: targetTimestamp,
    }
    await this.request<void>('PUT', `/api/v1/reactions/${encodeURIComponent(this.number)}`, payload)
  }

  /** Remove a reaction from a message (1:1). */
  async removeReaction(recipient: string, emoji: string, targetAuthor: string, targetTimestamp: number): Promise<void> {
    const payload: ReactionPayload = {
      recipient,
      reaction: emoji,
      target_author: targetAuthor,
      target_timestamp: targetTimestamp,
    }
    await this.request<void>('DELETE', `/api/v1/reactions/${encodeURIComponent(this.number)}`, payload)
  }

  // ── Groups ─────────────────────────────────────────────────────────────

  /** List all groups the account is a member of. */
  async listGroups(): Promise<GroupEntry[]> {
    return this.request<GroupEntry[]>('GET', `/api/v1/groups/${encodeURIComponent(this.number)}`)
  }

  /** Get metadata for a specific group. */
  async getGroup(groupId: string): Promise<GroupEntry> {
    return this.request<GroupEntry>('GET', `/api/v1/groups/${encodeURIComponent(this.number)}/${encodeURIComponent(groupId)}`)
  }

  // ── Read Receipts ──────────────────────────────────────────────────────

  /** Send a read receipt. */
  async sendReadReceipt(recipient: string, timestamps: number[]): Promise<void> {
    await this.request<void>('POST', `/api/v1/receipts/${encodeURIComponent(this.number)}`, {
      receipt_type: 'read',
      recipient,
      timestamps,
    })
  }

  // ── Attachments ────────────────────────────────────────────────────────

  /** Fetch an attachment by ID. Returns a Buffer of the file content. */
  async fetchAttachment(attachmentId: string): Promise<{ data: Buffer; contentType: string }> {
    const url = `${this.baseUrl}/api/v1/attachments/${encodeURIComponent(attachmentId)}`
    const res = await this.rawFetch(url, { method: 'GET' })
    if (!res.ok) {
      throw new Error(`[SIGNAL_CLIENT] Failed to fetch attachment ${attachmentId}: ${res.status} ${res.statusText}`)
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const arrayBuf = await res.arrayBuffer()
    return { data: Buffer.from(arrayBuf), contentType }
  }

  // ── SSE URL ────────────────────────────────────────────────────────────

  /** Build the SSE endpoint URL for receiving messages. */
  getSseUrl(): string {
    return `${this.baseUrl}/api/v1/receive/${encodeURIComponent(this.number)}`
  }

  /** Get the base URL (for diagnostics). */
  getBaseUrl(): string {
    return this.baseUrl
  }

  /** Get the registered phone number. */
  getNumber(): string {
    return this.number
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader
    }
    return headers
  }

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = this.buildHeaders()
      if (init.headers) {
        Object.assign(headers, init.headers)
      }
      return await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private static readonly MAX_RETRIES = 3

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }

    for (let attempt = 0; attempt <= SignalClient.MAX_RETRIES; attempt++) {
      const res = await this.rawFetch(url, init)

      if (res.status === 429) {
        if (attempt >= SignalClient.MAX_RETRIES) {
          throw new Error(`[SIGNAL_CLIENT] ${method} ${path} failed: 429 Too Many Requests (exhausted retries)`)
        }
        const retryAfter = res.headers.get('Retry-After')
        const delayMs = retryAfter
          ? (Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : 5000)
          : Math.min(1000 * Math.pow(2, attempt), 30_000)
        log.warn(
          { method, path, attempt, delayMs },
          '[SIGNAL_CLIENT] Rate limited (429), retrying after delay',
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        log.warn(
          { method, path, status: res.status, body: text.slice(0, 500) },
          '[SIGNAL_CLIENT] Request failed',
        )
        throw new Error(`[SIGNAL_CLIENT] ${method} ${path} failed: ${res.status} ${res.statusText}`)
      }
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        return (await res.json()) as T
      }
      // Some endpoints return empty responses (e.g. typing indicator)
      return undefined as T
    }

    // Unreachable, but TypeScript needs it
    throw new Error(`[SIGNAL_CLIENT] ${method} ${path} failed: exhausted retries`)
  }
}
