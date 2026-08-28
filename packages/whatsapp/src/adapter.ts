import {
  MessagingAdapter,
  SendQueue,
  createChildLogger,
} from '@openacp/plugin-sdk'
import type {
  IRenderer,
  AdapterCapabilities,
  OutgoingMessage,
  PermissionRequest,
  NotificationMessage,
  DisplayVerbosity,
} from '@openacp/plugin-sdk'
import { WhatsAppRenderer } from './renderer.js'
import { BaileysClient } from './client.js'
import type { BaileysSocket, ConnectionUpdate, MessageUpsert } from './client.js'
import { ActivityTracker } from './activity.js'
import { PermissionHandler } from './permissions.js'
import { GroupMetadataCache, isGroupJid, extractSenderJid, extractChatJid, isAllowed, deriveSessionId } from './threading.js'
import { downloadMedia, sendMedia, detectMediaType, hasMedia, isVoiceNote } from './media.js'
import { splitMessage, stripMarkdown } from './formatting.js'
import {
  collapseThought,
  collapseToolCall,
  collapseToolUpdate,
  collapsePlan,
  collapseUsage,
  collapseError,
  collapseSystem,
  collapseModeChange,
  collapseConfigUpdate,
  collapseModelUpdate,
  collapseSessionEnd,
  collapseNotification,
} from './low-fidelity.js'
import type { WhatsAppAdapterConfig, WhatsAppSessionContext, SerializedSessions } from './types.js'
import type { PluginStorage } from '@openacp/plugin-sdk'
import { DEFAULT_PER_JID_MIN_SPACING, DEFAULT_MAX_MESSAGE_LENGTH } from './types.js'

/** Storage key for persisted session map. */
const SESSION_STORAGE_KEY = 'whatsapp:sessions'

const log = createChildLogger({ module: 'whatsapp' })

/** Extract text content from a WhatsApp message object. */
function extractText(message: Record<string, unknown>): string {
  const inner = message.message as Record<string, unknown> | undefined
  if (!inner) return ''
  const conversation = inner.conversation as string | undefined
  if (conversation) return conversation
  const extended = inner.extendedTextMessage as Record<string, unknown> | undefined
  return (extended?.text as string) ?? ''
}

/** M28: Extract mentioned JIDs from contextInfo. */
function extractMentionedJids(message: Record<string, unknown>): string[] {
  const inner = message.message as Record<string, unknown> | undefined
  if (!inner) return []
  const extended = inner.extendedTextMessage as Record<string, unknown> | undefined
  const contextInfo = extended?.contextInfo as Record<string, unknown> | undefined
  if (!contextInfo) return []
  const mentioned = contextInfo.mentionedJid as string[] | undefined
  return mentioned ?? []
}

/** M27: Extract the quoted message key from contextInfo, if present. */
function extractQuotedMessageKey(message: Record<string, unknown>): {
  remoteJid: string
  id: string
  fromMe: boolean
  participant?: string
} | null {
  const inner = message.message as Record<string, unknown> | undefined
  if (!inner) return null
  const extended = inner.extendedTextMessage as Record<string, unknown> | undefined
  const contextInfo = extended?.contextInfo as Record<string, unknown> | undefined
  if (!contextInfo?.quotedMessage) return null

  const stanzaId = contextInfo.stanzaId as string | undefined
  const participant = contextInfo.participant as string | undefined
  const remoteJid = contextInfo.remoteJid as string | undefined

  if (!stanzaId) return null
  return {
    remoteJid: remoteJid ?? '',
    id: stanzaId,
    fromMe: false,
    participant: participant ?? undefined,
  }
}

/**
 * WhatsAppAdapter — full MessagingAdapter implementation backed by Baileys.
 *
 * Key design decisions:
 * - streaming: false — WhatsApp does not support message editing
 * - richFormatting: false — very limited text formatting (bold/italic only)
 * - threads: false — no thread concept, one session per chat
 * - All complex messages collapsed to plain text via low-fidelity renderers
 * - Per-JID send throttling (800ms default) for ban risk mitigation
 * - Exponential backoff reconnect on disconnect
 */
export class WhatsAppAdapter extends MessagingAdapter {
  readonly name = 'whatsapp'
  readonly renderer: IRenderer = new WhatsAppRenderer()
  readonly capabilities: AdapterCapabilities = {
    streaming: false,
    richFormatting: false,
    threads: false,
    reactions: true,
    fileUpload: true,
    voice: true,
  }

  private client: BaileysClient
  private config: WhatsAppAdapterConfig
  private sendQueue: SendQueue
  private activityTracker: ActivityTracker
  private permissionHandler: PermissionHandler
  private groupCache = new GroupMetadataCache()
  private sessions = new Map<string, WhatsAppSessionContext>()
  private storage: PluginStorage | null = null
  private processedMessageIds = new Set<string>()
  /** Limit dedup set size to prevent memory leak */
  private readonly maxDedupSize = 10_000
  private connected = false

  /** Callback invoked when a user message arrives. Set by the host. */
  onInboundMessage?: (sessionId: string, text: string, senderJid: string, meta?: {
    quotedMessageKey?: { remoteJid: string; id: string; fromMe: boolean; participant?: string }
    mentionedJids?: string[]
  }) => void
  /** Callback invoked when media arrives. Set by the host. */
  onInboundMedia?: (sessionId: string, buffer: Buffer, mimetype: string, fileName?: string) => void
  /** Callback invoked when a voice note arrives. Set by the host. */
  onInboundVoiceNote?: (sessionId: string, buffer: Buffer) => void

  constructor(
    core: { configManager: { get(): Record<string, unknown> }; fileService?: unknown },
    config: WhatsAppAdapterConfig,
  ) {
    super(core, config)
    this.config = config
    this.storage = config.storage ?? null

    const perJidSpacing = config.perJidMinSpacing ?? DEFAULT_PER_JID_MIN_SPACING
    this.sendQueue = new SendQueue({ minInterval: perJidSpacing })

    this.client = new BaileysClient({
      authPaths: {
        authDir: config.authDir,
        historyReceivedPath: `${config.authDir}/.history-received`,
      },
      pairingPhoneNumber: config.pairingPhoneNumber,
      listeners: {
        onConnectionUpdate: (update) => this.handleConnectionUpdate(update),
        onMessagesUpsert: (upsert) => this.handleMessagesUpsert(upsert),
        onCredsUpdate: async () => {
          log.debug('[WHATSAPP_ADAPTER] Credentials updated')
        },
      },
    })

    this.activityTracker = new ActivityTracker(
      () => this.client.isConnected() ? this.client.getSocket() : null,
    )

    this.permissionHandler = new PermissionHandler(
      () => this.client.isConnected() ? this.client.getSocket() : null,
      (sessionId, requestId, optionId) => {
        log.info({ sessionId, requestId, optionId }, '[WHATSAPP_ADAPTER] Permission resolved')
      },
    )
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    log.info('[WHATSAPP_ADAPTER] Starting WhatsApp adapter')

    // H06: Restore persisted sessions
    if (this.storage) {
      try {
        const saved = await this.storage.get<SerializedSessions>(SESSION_STORAGE_KEY)
        if (saved && Array.isArray(saved)) {
          for (const [id, ctx] of saved) {
            this.sessions.set(id, ctx)
          }
          log.info({ count: saved.length }, '[WHATSAPP_ADAPTER] Restored persisted sessions')
        }
      } catch (err) {
        log.warn({ err }, '[WHATSAPP_ADAPTER] Failed to restore persisted sessions')
      }
    }

    await this.client.connect()
  }

  async stop(): Promise<void> {
    log.info('[WHATSAPP_ADAPTER] Stopping WhatsApp adapter')
    this.activityTracker.stopAll()
    this.sendQueue.clear()
    await this.client.disconnect()
    this.connected = false
    this.sessions.clear()
    this.processedMessageIds.clear()
    this.groupCache.clear()
  }

  // ─── Session management ─────────────────────────────────────────────────────

  /**
   * WhatsApp has no threads — return the chatJid as the "thread ID".
   */
  async createSessionThread(sessionId: string, _name: string): Promise<string> {
    return sessionId
  }

  /**
   * No-op — WhatsApp has no thread rename concept.
   */
  async renameSessionThread(_sessionId: string, _newName: string): Promise<void> {
    // No-op
  }

  /**
   * Clean up session state.
   */
  async cleanupSessionState(sessionId: string): Promise<void> {
    this.activityTracker.stopTyping(sessionId)
    this.permissionHandler.clearSession(sessionId)
    this.sessions.delete(sessionId)
    this.persistSessions()
  }

  // ─── Permission & Notification ──────────────────────────────────────────────

  async sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void> {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) {
      log.warn({ sessionId }, '[WHATSAPP_ADAPTER] No session context for permission request')
      return
    }
    await this.permissionHandler.sendPermissionRequest(sessionId, ctx.chatJid, request)
  }

  async sendNotification(notification: NotificationMessage): Promise<void> {
    const text = collapseNotification(notification)
    if (!text) return

    // Send to the session's chat if available, otherwise best-effort skip
    const ctx = this.sessions.get(notification.sessionId)
    if (!ctx) {
      log.debug({ sessionId: notification.sessionId }, '[WHATSAPP_ADAPTER] No session for notification — skipping')
      return
    }

    await this.sendText(ctx.chatJid, text)
  }

  // ─── Outbound message handlers ──────────────────────────────────────────────

  protected async handleText(sessionId: string, content: OutgoingMessage): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    this.activityTracker.stopTyping(jid)
    const text = stripMarkdown(content.text)
    if (!text) return
    await this.sendText(jid, text)
  }

  protected async handleThought(
    sessionId: string,
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapseThought(content, verbosity)
    if (!text) return
    await this.sendText(jid, text)
  }

  protected async handleToolCall(
    sessionId: string,
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapseToolCall(content, verbosity)
    if (!text) return
    await this.sendText(jid, text)
  }

  protected async handleToolUpdate(
    sessionId: string,
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapseToolUpdate(content, verbosity)
    if (!text) return
    await this.sendText(jid, text)
  }

  protected async handlePlan(
    sessionId: string,
    content: OutgoingMessage,
    _verbosity: DisplayVerbosity,
  ): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapsePlan(content)
    if (!text) return
    await this.sendText(jid, text)
  }

  protected async handleUsage(
    sessionId: string,
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapseUsage(content, verbosity)
    if (!text) return
    await this.sendText(jid, text)
  }

  protected async handleError(sessionId: string, content: OutgoingMessage): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    this.activityTracker.stopTyping(jid)
    const text = collapseError(content)
    await this.sendText(jid, text)
  }

  protected async handleAttachment(sessionId: string, content: OutgoingMessage): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return

    const meta = content.metadata as {
      buffer?: Buffer
      mimetype?: string
      fileName?: string
    } | undefined

    if (meta?.buffer && meta.mimetype) {
      const sock = this.client.getSocket()
      await this.sendQueue.enqueue(async () => {
        await sendMedia(sock, {
          jid,
          buffer: meta.buffer!,
          type: detectMediaType(meta.mimetype!),
          mimetype: meta.mimetype!,
          fileName: meta.fileName,
          caption: content.text || undefined,
        })
      })
    } else if (content.text) {
      await this.sendText(jid, content.text)
    }
  }

  protected async handleSystem(sessionId: string, content: OutgoingMessage): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapseSystem(content)
    if (text) await this.sendText(jid, text)
  }

  protected async handleSessionEnd(sessionId: string, content: OutgoingMessage): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    this.activityTracker.stopTyping(jid)
    const text = collapseSessionEnd(content)
    if (text) await this.sendText(jid, text)
  }

  protected async handleModeChange(sessionId: string, content: OutgoingMessage): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapseModeChange(content)
    if (text) await this.sendText(jid, text)
  }

  protected async handleConfigUpdate(sessionId: string, _content: OutgoingMessage): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapseConfigUpdate()
    if (text) await this.sendText(jid, text)
  }

  protected async handleModelUpdate(sessionId: string, content: OutgoingMessage): Promise<void> {
    const jid = this.getJid(sessionId)
    if (!jid) return
    const text = collapseModelUpdate(content)
    if (text) await this.sendText(jid, text)
  }

  // ─── Inbound message handling ───────────────────────────────────────────────

  private handleConnectionUpdate(update: ConnectionUpdate): void {
    if (update.connection === 'open') {
      this.connected = true
      log.info('[WHATSAPP_ADAPTER] Connection established')
    } else if (update.connection === 'close') {
      this.connected = false
      log.info('[WHATSAPP_ADAPTER] Connection closed')
    }
  }

  private handleMessagesUpsert(upsert: MessageUpsert): void {
    // Only process live/push messages, not history sync
    if (upsert.type !== 'notify') return

    for (const rawMsg of upsert.messages) {
      void this.processInboundMessage(rawMsg)
    }
  }

  private async processInboundMessage(rawMsg: unknown): Promise<void> {
    const msg = rawMsg as Record<string, unknown>
    const key = msg.key as { remoteJid?: string | null; participant?: string | null; fromMe?: boolean; id?: string } | undefined
    if (!key) return

    // O06: Input validation — guard against undefined/null key fields
    if (typeof key.remoteJid !== 'string' || !key.remoteJid) {
      log.debug('[WHATSAPP_ADAPTER] Ignoring message with missing or invalid remoteJid')
      return
    }
    if (typeof key.id !== 'string' || !key.id) {
      log.debug('[WHATSAPP_ADAPTER] Ignoring message with missing or invalid message id')
      return
    }

    // Skip own messages (self-loop guard)
    if (key.fromMe) return

    // Dedup by message ID
    const msgId = key.id
    if (msgId) {
      if (this.processedMessageIds.has(msgId)) return
      this.processedMessageIds.add(msgId)
      // Prevent memory leak: trim dedup set
      if (this.processedMessageIds.size > this.maxDedupSize) {
        const iter = this.processedMessageIds.values()
        // Remove oldest 20% of entries
        const removeCount = Math.floor(this.maxDedupSize * 0.2)
        for (let i = 0; i < removeCount; i++) {
          const val = iter.next().value
          if (val) this.processedMessageIds.delete(val)
        }
      }
    }

    const chatJid = extractChatJid(key)
    if (!chatJid) return

    // Check allowlist
    if (!isAllowed(chatJid, this.config.allowedJids)) {
      const senderJid = extractSenderJid(key)
      if (!isAllowed(senderJid, this.config.allowedJids)) {
        log.debug({ chatJid, senderJid }, '[WHATSAPP_ADAPTER] Message from non-allowed JID — ignoring')
        return
      }
    }

    const senderJid = extractSenderJid(key)
    const sessionId = deriveSessionId(chatJid)
    const isGroup = isGroupJid(chatJid)

    // Ensure session context
    if (!this.sessions.has(sessionId)) {
      let displayName = chatJid
      if (isGroup) {
        const sock = this.client.isConnected() ? this.client.getSocket() : null
        if (sock) {
          const meta = await this.groupCache.get(chatJid, sock)
          if (meta) displayName = meta.subject
        }
      }
      this.sessions.set(sessionId, { chatJid, isGroup, displayName })
      this.persistSessions()
    }

    // Start typing indicator
    this.activityTracker.startTyping(chatJid)

    // Check if this is a permission reply first
    const text = extractText(msg)
    if (text && this.permissionHandler.tryResolve(chatJid, text)) {
      this.activityTracker.stopTyping(chatJid)
      return
    }

    // Handle text messages
    if (text && this.onInboundMessage) {
      // M27: Extract quoted message key for reply/quote support
      const quotedMessageKey = extractQuotedMessageKey(msg) ?? undefined
      // M28: Extract mentioned JIDs
      const mentionedJids = extractMentionedJids(msg)
      const meta = (quotedMessageKey || mentionedJids.length > 0)
        ? { quotedMessageKey, mentionedJids: mentionedJids.length > 0 ? mentionedJids : undefined }
        : undefined
      this.onInboundMessage(sessionId, text, senderJid, meta)
      return
    }

    // Handle media messages
    if (hasMedia(rawMsg)) {
      if (isVoiceNote(rawMsg) && this.onInboundVoiceNote) {
        const media = await downloadMedia(rawMsg)
        if (media) {
          this.onInboundVoiceNote(sessionId, media.buffer)
        }
        return
      }

      if (this.onInboundMedia) {
        const media = await downloadMedia(rawMsg)
        if (media) {
          this.onInboundMedia(sessionId, media.buffer, media.mimetype, media.fileName)
        }
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** H06: Persist session map to storage. Fire-and-forget. */
  private persistSessions(): void {
    if (!this.storage) return
    const serialized: SerializedSessions = [...this.sessions.entries()]
    this.storage.set(SESSION_STORAGE_KEY, serialized).catch((err) => {
      log.warn({ err }, '[WHATSAPP_ADAPTER] Failed to persist sessions')
    })
  }

  /** Get the JID for a session, or null if session unknown. */
  private getJid(sessionId: string): string | null {
    const ctx = this.sessions.get(sessionId)
    if (!ctx) {
      log.debug({ sessionId }, '[WHATSAPP_ADAPTER] No session context for outbound message')
      return null
    }
    return ctx.chatJid
  }

  /**
   * Send a text message to a JID, with automatic chunking and throttling.
   */
  private async sendText(jid: string, text: string): Promise<void> {
    if (!text) return

    const maxLen = this.config.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
    const chunks = splitMessage(text, maxLen)

    for (const chunk of chunks) {
      await this.sendQueue.enqueue(async () => {
        const sock = this.client.getSocket()
        await this.sendWithRateLimitRetry(sock, jid, { text: chunk })
      })
    }
  }

  /**
   * Send a reaction to a message.
   */
  async sendReaction(
    jid: string,
    emoji: string,
    messageKey: { remoteJid: string; id: string; fromMe: boolean; participant?: string },
  ): Promise<void> {
    await this.sendQueue.enqueue(async () => {
      const sock = this.client.getSocket()
      await sock.sendMessage(jid, {
        react: { text: emoji, key: messageKey },
      })
    })
  }

  /**
   * M27: Send a reply/quote to a specific message.
   *
   * The `quotedMsg` must be the original Baileys message object (or a key-bearing wrapper)
   * that Baileys uses for the `quoted` option in sendMessage.
   */
  async sendReply(
    jid: string,
    text: string,
    quotedMsg: Record<string, unknown>,
  ): Promise<void> {
    if (!text) return
    const maxLen = this.config.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
    const chunks = splitMessage(text, maxLen)

    for (const chunk of chunks) {
      await this.sendQueue.enqueue(async () => {
        const sock = this.client.getSocket()
        await this.sendWithRateLimitRetry(sock, jid, { text: chunk }, { quoted: quotedMsg })
      })
    }
  }

  /**
   * M28: Send a message with @mentions.
   *
   * Formats mention text as `@user` in the message body and includes the
   * corresponding JIDs in the `mentions` array for WhatsApp to render them
   * as tappable mentions.
   */
  async sendWithMentions(
    jid: string,
    text: string,
    mentions: string[],
  ): Promise<void> {
    if (!text) return
    const maxLen = this.config.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
    const chunks = splitMessage(text, maxLen)

    for (const chunk of chunks) {
      await this.sendQueue.enqueue(async () => {
        const sock = this.client.getSocket()
        await this.sendWithRateLimitRetry(sock, jid, { text: chunk, mentions })
      })
    }
  }

  // ─── G10 — Reactive rate limit retry ───────────────────────────────────────

  /**
   * Attempt to send a message; if Baileys throws a rate-limit error,
   * wait 2s and retry once. Complements the proactive 800ms per-JID throttle.
   */
  private async sendWithRateLimitRetry(
    sock: BaileysSocket,
    jid: string,
    content: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await sock.sendMessage(jid, content, options)
    } catch (err: unknown) {
      if (isRateLimitError(err)) {
        log.warn({ jid }, '[WHATSAPP_ADAPTER_RATELIMIT] Rate limited, retrying after 2s')
        await sleep(2000)
        // Retry once — if this also fails, let it propagate
        await sock.sendMessage(jid, content, options)
      } else {
        throw err
      }
    }
  }
}

/** Check if an error looks like a rate-limit response from Baileys/WhatsApp. */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  // Baileys may surface HTTP 429 as a statusCode or output property
  if (e.statusCode === 429 || e.output === 429) return true
  const msg = (e.message as string | undefined) ?? ''
  return /rate/i.test(msg) || /429/.test(msg) || /too many/i.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
