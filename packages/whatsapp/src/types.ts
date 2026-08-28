import type { MessagingAdapterConfig, PluginStorage } from '@openacp/plugin-sdk'

/** Per-chat session context stored in the adapter's session map. */
export interface WhatsAppSessionContext {
  /** WhatsApp JID for this chat (e.g. "1234@s.whatsapp.net" or "group@g.us") */
  chatJid: string
  /** Whether this chat is a group chat */
  isGroup: boolean
  /** Display name of the chat (contact name or group subject) */
  displayName: string
}

/** Serializable form of WhatsAppSessionContext for persistence. */
export type SerializedSessions = Array<[string, WhatsAppSessionContext]>

/** Configuration for the WhatsApp adapter. */
export interface WhatsAppAdapterConfig extends MessagingAdapterConfig {
  /** Absolute path to the directory for storing Baileys auth state */
  authDir: string
  /**
   * Phone number for pairing code auth (headless mode).
   * If provided, QR code display is skipped and pairing code is used instead.
   * Format: country code + number, no leading +. Example: "15551234567"
   */
  pairingPhoneNumber?: string
  /**
   * JIDs allowed to interact with the bot.
   * If empty, all incoming messages are processed (dangerous for ban risk).
   * Accepts both individual JIDs and group JIDs.
   */
  allowedJids?: string[]
  /**
   * Maximum outbound message length before chunking.
   * WhatsApp has a soft limit around 65536, but readability drops past 4000.
   */
  maxMessageLength: number
  /**
   * Minimum delay (ms) between outbound messages to the same JID.
   * Protects against WhatsApp rate limits and ban detection.
   * @default 800
   */
  perJidMinSpacing?: number
  /**
   * Optional plugin storage for session persistence.
   * When provided, session map is saved on changes and restored on start().
   */
  storage?: PluginStorage
}

/** Auth state persistence paths. */
export interface AuthPaths {
  authDir: string
  historyReceivedPath: string
}

/** Reconnect backoff configuration. */
export interface ReconnectConfig {
  /** Backoff delays in ms, used in order. Last value is the cap. */
  delays: number[]
  /** Maximum number of consecutive reconnect attempts before giving up. */
  maxAttempts: number
}

export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  delays: [1_000, 2_000, 5_000, 15_000, 60_000],
  maxAttempts: 50,
}

export const DEFAULT_PER_JID_MIN_SPACING = 800
export const DEFAULT_MAX_MESSAGE_LENGTH = 4_000
