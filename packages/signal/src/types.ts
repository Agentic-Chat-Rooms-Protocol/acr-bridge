import type { MessagingAdapterConfig } from '@openacp/plugin-sdk'

// ─── Adapter Config ──────────────────────────────────────────────────────────

/** Configuration for the Signal adapter. */
export interface SignalAdapterConfig extends MessagingAdapterConfig {
  /**
   * Base URL of the signal-cli-rest-api container.
   * Example: "http://localhost:8080"
   */
  apiUrl: string

  /**
   * Phone number registered with signal-cli (E.164 format).
   * Example: "+15551234567"
   */
  number: string

  /**
   * Optional auth header value (Basic or Bearer) for signal-cli-rest-api.
   * If the REST API is configured with authentication, provide the
   * full header value here, e.g. "Basic dXNlcjpwYXNz".
   */
  authHeader?: string

  /**
   * Phone numbers or UUIDs allowed to interact with the bot.
   * If empty/undefined, all incoming messages are processed.
   */
  allowedSenders?: string[]

  /**
   * Maximum outbound message length before chunking.
   * Signal has no hard limit, but readability drops past ~4000 chars.
   * @default 4000
   */
  maxMessageLength: number

  /**
   * Minimum delay (ms) between outbound messages.
   * Protects against transient rate-limiting.
   * @default 500
   */
  minSendInterval?: number
}

// ─── SSE Envelope Types ──────────────────────────────────────────────────────

/** Attachment in an incoming Signal message. */
export interface SignalAttachment {
  contentType: string
  filename?: string
  id: string
  size?: number
  width?: number
  height?: number
  voiceNote?: boolean
}

/** Quote (reply) in a Signal message. */
export interface SignalQuote {
  id: number
  author: string
  text?: string
}

/** Reaction payload in a Signal message. */
export interface SignalReaction {
  emoji: string
  targetAuthor: string
  targetSentTimestamp: number
  isRemove?: boolean
}

/** Group information in a Signal message. */
export interface SignalGroupInfo {
  groupId: string
  type?: string
}

/** The dataMessage part of a Signal envelope. */
export interface SignalDataMessage {
  message?: string | null
  timestamp: number
  groupInfo?: SignalGroupInfo
  attachments?: SignalAttachment[]
  reaction?: SignalReaction
  quote?: SignalQuote
  expiresInSeconds?: number
}

/** Typing indicator message. */
export interface SignalTypingMessage {
  action: 'STARTED' | 'STOPPED'
  timestamp: number
  groupId?: string
}

/** Receipt message (read/delivery). */
export interface SignalReceiptMessage {
  when: number
  isDelivery?: boolean
  isRead?: boolean
  timestamps: number[]
}

/** Full Signal SSE envelope. */
export interface SignalEnvelope {
  source: string
  sourceNumber?: string
  sourceUuid?: string
  sourceName?: string
  timestamp: number
  dataMessage?: SignalDataMessage
  typingMessage?: SignalTypingMessage
  receiptMessage?: SignalReceiptMessage
}

/** SSE event data wrapper. */
export interface SignalSseEventData {
  envelope: SignalEnvelope
  account?: string
}

// ─── Session Context ─────────────────────────────────────────────────────────

/** Per-chat session context stored in the adapter's session map. */
export interface SignalSessionContext {
  /** Session key: phone number for 1:1, groupId for groups */
  chatId: string
  /** Whether this is a group chat */
  isGroup: boolean
  /** Display name (contact name or group subject) */
  displayName: string
  /** Phone number of the remote party (1:1) or undefined (group) */
  remoteNumber?: string
}

// ─── Reconnect Config ────────────────────────────────────────────────────────

/** SSE reconnect backoff configuration. */
export interface ReconnectConfig {
  /** Base delay in ms before first reconnect */
  initialDelayMs: number
  /** Maximum delay in ms between reconnect attempts */
  maxDelayMs: number
  /** Backoff multiplier */
  factor: number
  /** Jitter factor (0 to 1) */
  jitter: number
  /** Maximum number of consecutive reconnect attempts */
  maxAttempts: number
}

export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: 100,
}

export const DEFAULT_MAX_MESSAGE_LENGTH = 4_000
export const DEFAULT_MIN_SEND_INTERVAL = 500
