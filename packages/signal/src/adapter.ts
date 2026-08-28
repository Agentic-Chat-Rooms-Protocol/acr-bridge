import {
  MessagingAdapter,
  SendQueue,
  createChildLogger,
  type IRenderer,
  type AdapterCapabilities,
  type OutgoingMessage,
  type PermissionRequest,
  type NotificationMessage,
  type MessagingAdapterConfig,
  type DisplayVerbosity,
  type Session,
} from '@openacp/plugin-sdk'
import { SignalRenderer } from './renderer.js'
import { SignalClient } from './client.js'
import { runSseLoop } from './events.js'
import {
  extractSessionKey,
  extractSenderName,
  extractSenderId,
  isGroupMessage,
} from './events.js'
import { GroupManager } from './groups.js'
import { SignalPermissionHandler } from './permissions.js'
import { SignalActivityTracker } from './activity.js'
import { splitMessage, formatNotification, escapePlainText } from './formatting.js'
import { encodeAttachment, isVoiceNoteContentType, resolveAllAttachments } from './media.js'
import {
  formatToolCallPlain,
  formatToolUpdatePlain,
  formatThoughtPlain,
  formatPlanPlain,
  formatUsagePlain,
  splitPlainText,
} from './low-fidelity.js'
import type {
  SignalAdapterConfig,
  SignalSseEventData,
  SignalEnvelope,
  SignalSessionContext,
} from './types.js'

/** Minimal storage interface for session persistence (matches PluginStorage). */
export interface SignalAdapterStorage {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
}
import { DEFAULT_MAX_MESSAGE_LENGTH, DEFAULT_MIN_SEND_INTERVAL } from './types.js'

const log = createChildLogger({ module: 'signal' })

// ─── Core interface expected from PluginContext ──────────────────────────────

/**
 * Minimal core interface the adapter needs from PluginContext.
 *
 * In the plugin model, the adapter receives a PluginContext at setup time.
 * We extract just the methods we need to decouple from the full OpenACPCore type.
 */
export interface SignalAdapterCore {
  handleMessage(msg: {
    channelId: string
    threadId: string
    userId: string
    text: string
    attachments?: Array<{ filename: string; contentType: string; data: Buffer }>
  }): Promise<void>
  getOrResumeSession(channelId: string, threadId: string): Promise<Session | null>
  createSession(opts: {
    channelId: string
    agentName: string
    workingDirectory: string
    threadId: string
    initialName?: string
  }): Promise<Session>
  sessionManager: {
    getSession(id: string): Session | undefined
  }
  configManager: {
    get(): Record<string, unknown>
  }
}

// ─── Signal Adapter ──────────────────────────────────────────────────────────

export class SignalAdapter extends MessagingAdapter {
  readonly name = 'signal'
  readonly renderer: IRenderer = new SignalRenderer()
  readonly capabilities: AdapterCapabilities = {
    streaming: false,
    richFormatting: false,
    threads: false,
    reactions: true,
    fileUpload: true,
    voice: true,
  }

  private readonly signalConfig: SignalAdapterConfig
  private readonly client: SignalClient
  private readonly groupManager: GroupManager
  private readonly permissionHandler = new SignalPermissionHandler()
  private readonly sendQueue: SendQueue
  private readonly sessionContexts = new Map<string, SignalSessionContext>()
  private readonly activityTrackers = new Map<string, SignalActivityTracker>()
  private sseAbortController: AbortController | null = null
  private core: SignalAdapterCore | null = null
  private storage: SignalAdapterStorage | null = null

  constructor(
    config: SignalAdapterConfig,
    core?: SignalAdapterCore,
  ) {
    const adapterConfig: MessagingAdapterConfig = {
      enabled: config.enabled ?? true,
      maxMessageLength: config.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH,
    }
    super({ configManager: core?.configManager ?? { get: () => ({}) } }, adapterConfig)
    this.signalConfig = config
    this.core = core ?? null
    this.client = new SignalClient(config)
    this.groupManager = new GroupManager(this.client)
    this.sendQueue = new SendQueue({
      minInterval: config.minSendInterval ?? DEFAULT_MIN_SEND_INTERVAL,
    })
  }

  /** Inject the core after construction (used in plugin setup). */
  setCore(core: SignalAdapterCore): void {
    this.core = core
  }

  /** Inject storage for session persistence (used in plugin setup). */
  setStorage(storage: SignalAdapterStorage): void {
    this.storage = storage
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private static readonly SESSIONS_STORAGE_KEY = 'sessions'

  /** Persist current session contexts to storage. */
  private async persistSessions(): Promise<void> {
    if (!this.storage) return
    try {
      const serialized = Object.fromEntries(this.sessionContexts)
      await this.storage.set(SignalAdapter.SESSIONS_STORAGE_KEY, serialized)
    } catch (err) {
      log.warn({ err }, '[SIGNAL_ADAPTER] Failed to persist session contexts')
    }
  }

  /** Restore session contexts from storage. */
  private async restoreSessions(): Promise<void> {
    if (!this.storage) return
    try {
      const data = await this.storage.get<Record<string, SignalSessionContext>>(
        SignalAdapter.SESSIONS_STORAGE_KEY,
      )
      if (data && typeof data === 'object') {
        for (const [key, ctx] of Object.entries(data)) {
          this.sessionContexts.set(key, ctx)
        }
        log.info(
          { count: this.sessionContexts.size },
          '[SIGNAL_ADAPTER] Restored session contexts from storage',
        )
      }
    } catch (err) {
      log.warn({ err }, '[SIGNAL_ADAPTER] Failed to restore session contexts')
    }
  }

  async start(): Promise<void> {
    log.info(
      { apiUrl: this.signalConfig.apiUrl, number: this.signalConfig.number },
      '[SIGNAL_ADAPTER] Starting Signal adapter',
    )

    // Restore persisted sessions
    await this.restoreSessions()

    // Health check
    const health = await this.client.healthCheck()
    if (!health.ok) {
      log.error(
        { error: health.error },
        '[SIGNAL_ADAPTER] signal-cli-rest-api health check failed',
      )
      throw new Error(`Signal health check failed: ${health.error}`)
    }
    log.info('[SIGNAL_ADAPTER] signal-cli-rest-api is healthy')

    // Start SSE event loop
    this.sseAbortController = new AbortController()
    void this.startEventLoop()
  }

  async stop(): Promise<void> {
    log.info('[SIGNAL_ADAPTER] Stopping Signal adapter')

    // Stop SSE stream
    if (this.sseAbortController) {
      this.sseAbortController.abort()
      this.sseAbortController = null
    }

    // Clean up activity trackers
    for (const tracker of this.activityTrackers.values()) {
      tracker.cleanup()
    }
    this.activityTrackers.clear()

    // Clear permission state
    this.permissionHandler.clear()

    // Clear send queue
    this.sendQueue.clear()

    // Clear caches
    this.groupManager.clearCache()
    this.sessionContexts.clear()

    log.info('[SIGNAL_ADAPTER] Signal adapter stopped')
  }

  // ── SSE Event Processing ─────────────────────────────────────────────────

  private async startEventLoop(): Promise<void> {
    if (!this.sseAbortController) return

    await runSseLoop({
      url: this.client.getSseUrl(),
      authHeader: this.signalConfig.authHeader,
      signal: this.sseAbortController.signal,
      onEvent: (event) => {
        void this.handleSseEvent(event)
      },
      onConnected: () => {
        log.info('[SIGNAL_ADAPTER] SSE stream connected')
      },
      onError: (error) => {
        log.warn({ err: error }, '[SIGNAL_ADAPTER] SSE stream error')
      },
      onReconnecting: (attempt) => {
        log.info({ attempt }, '[SIGNAL_ADAPTER] SSE reconnecting')
      },
    })
  }

  private async handleSseEvent(event: SignalSseEventData): Promise<void> {
    const { envelope } = event
    if (!envelope) return

    // Check sender allowlist
    if (this.signalConfig.allowedSenders?.length) {
      const senderId = extractSenderId(envelope)
      if (!this.signalConfig.allowedSenders.includes(senderId)) {
        log.debug({ senderId }, '[SIGNAL_ADAPTER] Ignoring message from non-allowed sender')
        return
      }
    }

    // Ignore self-messages
    if (extractSenderId(envelope) === this.signalConfig.number) return

    // Route by message type
    if (envelope.dataMessage) {
      await this.handleDataMessage(envelope)
    } else if (envelope.typingMessage) {
      // Typing indicators from remote -- currently ignored
      log.debug(
        { sender: extractSenderId(envelope), action: envelope.typingMessage.action },
        '[SIGNAL_ADAPTER] Remote typing indicator',
      )
    } else if (envelope.receiptMessage) {
      // Read/delivery receipts -- currently ignored
      log.debug(
        { sender: extractSenderId(envelope) },
        '[SIGNAL_ADAPTER] Receipt message',
      )
    }
  }

  private async handleDataMessage(envelope: SignalEnvelope): Promise<void> {
    if (!this.core) {
      log.warn('[SIGNAL_ADAPTER] Core not set, ignoring inbound message')
      return
    }

    const data = envelope.dataMessage
    if (!data) return

    // Handle reactions separately
    if (data.reaction) {
      log.info(
        { emoji: data.reaction.emoji, sender: extractSenderId(envelope) },
        '[SIGNAL_ADAPTER] Received reaction',
      )
      return
    }

    const sessionKey = extractSessionKey(envelope)
    if (!sessionKey) {
      log.warn('[SIGNAL_ADAPTER] Could not extract session key from envelope')
      return
    }

    const text = data.message?.trim() ?? ''
    const isGroup = isGroupMessage(envelope)
    const senderId = extractSenderId(envelope)
    const senderName = extractSenderName(envelope)

    // Store session context and persist
    this.sessionContexts.set(sessionKey, {
      chatId: sessionKey,
      isGroup,
      displayName: isGroup
        ? await this.groupManager.resolveGroupName(
            data.groupInfo?.groupId ?? sessionKey,
          )
        : senderName,
      remoteNumber: isGroup ? undefined : senderId,
    })
    void this.persistSessions()

    // Try handling as permission response first
    if (text && this.permissionHandler.tryHandleResponse(sessionKey, text)) {
      // Send confirmation
      await this.sendTextToChat(sessionKey, 'Permission response recorded.')
      return
    }

    // Get or create session
    let session = await this.core.getOrResumeSession('signal', sessionKey)
    if (!session) {
      try {
        const config = this.core.configManager.get()
        const agentName = (config['defaultAgent'] as string | undefined) ?? 'claude'
        const workingDirectory = (config['workspace'] as string | undefined) ?? process.cwd()
        session = await this.core.createSession({
          channelId: 'signal',
          agentName,
          workingDirectory,
          threadId: sessionKey,
          initialName: isGroup
            ? `Signal group: ${senderName}`
            : `Signal: ${senderName}`,
        })
        log.info(
          { sessionId: session.id, chatId: sessionKey },
          '[SIGNAL_ADAPTER] Created new session',
        )
      } catch (err) {
        log.error({ err, chatId: sessionKey }, '[SIGNAL_ADAPTER] Failed to create session')
        await this.sendTextToChat(sessionKey, 'Error: Failed to start session')
        return
      }
    }

    // Reset activity tracker for new prompt
    const tracker = this.getOrCreateTracker(session.id, sessionKey, isGroup)
    tracker.onNewPrompt()

    // Resolve inbound attachments (including voice notes)
    const resolvedAttachments: Array<{
      filename: string
      contentType: string
      data: Buffer
      isVoiceNote?: boolean
    }> = []
    if (data.attachments?.length) {
      const resolved = await resolveAllAttachments(this.client, data.attachments)
      for (const att of resolved) {
        resolvedAttachments.push({
          filename: att.filename,
          contentType: att.contentType,
          data: att.data,
          isVoiceNote: att.isVoiceNote,
        })
      }
    }

    // Forward to core
    await this.core.handleMessage({
      channelId: 'signal',
      threadId: sessionKey,
      userId: senderId,
      text,
      attachments: resolvedAttachments.length > 0 ? resolvedAttachments : undefined,
    }).catch((err) => {
      log.error({ err, sessionId: session!.id }, '[SIGNAL_ADAPTER] handleMessage error')
    })
  }

  // ── MessagingAdapter Handler Overrides ────────────────────────────────────

  protected async handleText(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const tracker = this.activityTrackers.get(sessionId)
    tracker?.onTextStart()

    const maxLen = this.signalConfig.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
    const chunks = splitPlainText(escapePlainText(content.text), maxLen)
    for (const chunk of chunks) {
      await this.sendTextToChat(chatId, chunk)
    }
  }

  protected async handleThought(
    sessionId: string,
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): Promise<void> {
    const tracker = this.activityTrackers.get(sessionId)
    tracker?.onThought()

    // In low-fidelity mode, thoughts are only sent at high verbosity
    if (verbosity === 'high') {
      const chatId = this.resolveSessionChatId(sessionId)
      if (!chatId) return
      const text = formatThoughtPlain(content.text, verbosity)
      await this.sendTextToChat(chatId, text)
    }
  }

  protected async handleToolCall(
    sessionId: string,
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): Promise<void> {
    // In low-fidelity mode, only send tool calls at medium or high verbosity
    if (verbosity === 'low') return

    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const tracker = this.activityTrackers.get(sessionId)
    tracker?.onToolCall()

    const meta = (content.metadata ?? {}) as Record<string, unknown>
    const text = formatToolCallPlain({
      name: meta['name'] as string | undefined ?? content.text,
      kind: meta['kind'] as string | undefined,
      status: meta['status'] as string | undefined,
      rawInput: meta['rawInput'],
      displaySummary: meta['displaySummary'] as string | undefined,
      displayTitle: meta['displayTitle'] as string | undefined,
    }, verbosity)
    await this.sendTextToChat(chatId, text)
  }

  protected async handleToolUpdate(
    sessionId: string,
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): Promise<void> {
    // Only show tool updates at high verbosity in low-fidelity mode
    if (verbosity !== 'high') return

    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const meta = (content.metadata ?? {}) as Record<string, unknown>
    const text = formatToolUpdatePlain({
      name: meta['name'] as string | undefined ?? content.text,
      kind: meta['kind'] as string | undefined,
      status: meta['status'] as string | undefined,
      content: meta['content'],
      displaySummary: meta['displaySummary'] as string | undefined,
      displayTitle: meta['displayTitle'] as string | undefined,
    }, verbosity)
    await this.sendTextToChat(chatId, text)
  }

  protected async handlePlan(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const meta = content.metadata as
      | { entries?: Array<{ content: string; status: string }> }
      | undefined
    const text = formatPlanPlain(meta?.entries ?? [])
    await this.sendTextToChat(chatId, text)
  }

  protected async handleUsage(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const meta = content.metadata as
      | { tokensUsed?: number; contextSize?: number; cost?: number }
      | undefined
    const text = formatUsagePlain(meta ?? {})
    await this.sendTextToChat(chatId, text)
  }

  protected async handleError(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const tracker = this.activityTrackers.get(sessionId)
    tracker?.cleanup()

    await this.sendTextToChat(chatId, `Error: ${escapePlainText(content.text)}`)
  }

  protected async handleAttachment(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const meta = (content.metadata ?? {}) as Record<string, unknown>
    const attachmentData = meta['data'] as Buffer | undefined
    const contentType = (meta['contentType'] as string | undefined) ?? 'application/octet-stream'
    const filename = (meta['filename'] as string | undefined) ?? 'attachment'

    if (attachmentData && Buffer.isBuffer(attachmentData)) {
      const isVoice = isVoiceNoteContentType(contentType)
      const encoded = encodeAttachment(attachmentData, contentType)
      const caption = isVoice ? (content.text || 'Voice message') : (content.text || filename)
      const isGroup = chatId.startsWith('group:')

      try {
        if (isGroup) {
          const groupId = chatId.slice(6)
          await this.client.sendGroupMessage(groupId, caption, {
            attachments: [encoded],
          })
        } else {
          await this.client.sendMessage(chatId, caption, {
            attachments: [encoded],
          })
        }
      } catch (err) {
        log.warn({ err, chatId, filename, isVoice }, '[SIGNAL_ADAPTER] Failed to send attachment, falling back to text')
        await this.sendTextToChat(chatId, `[Attachment] ${escapePlainText(content.text || filename)}`)
      }
    } else {
      // No binary data available -- send text placeholder
      const text = content.text || 'Attachment'
      await this.sendTextToChat(chatId, `[Attachment] ${escapePlainText(text)}`)
    }
  }

  protected async handleSystem(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return
    await this.sendTextToChat(chatId, escapePlainText(content.text))
  }

  protected async handleSessionEnd(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const tracker = this.activityTrackers.get(sessionId)
    tracker?.cleanup()
    this.activityTrackers.delete(sessionId)

    const text = content.text ? `Session ended: ${content.text}` : 'Session ended'
    await this.sendTextToChat(chatId, text)
  }

  protected async handleModeChange(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return
    const modeId = (content.metadata as Record<string, unknown>)?.['modeId'] ?? ''
    await this.sendTextToChat(chatId, `Mode changed: ${String(modeId)}`)
  }

  protected async handleConfigUpdate(
    sessionId: string,
    _content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return
    await this.sendTextToChat(chatId, 'Configuration updated')
  }

  protected async handleModelUpdate(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return
    const modelId = (content.metadata as Record<string, unknown>)?.['modelId'] ?? ''
    await this.sendTextToChat(chatId, `Model changed: ${String(modelId)}`)
  }

  // ── IChannelAdapter Methods ──────────────────────────────────────────────

  async sendPermissionRequest(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<void> {
    const chatId = this.resolveSessionChatId(sessionId)
    if (!chatId) return

    const session = this.core?.sessionManager.getSession(sessionId)
    if (session?.permissionGate) {
      this.permissionHandler.registerResolver(
        sessionId,
        (optionId) => {
          if (session.permissionGate?.requestId === request.id) {
            session.permissionGate.resolve(optionId)
          }
        },
      )
    }

    const text = this.permissionHandler.createPermissionRequest(chatId, sessionId, request)
    await this.sendTextToChat(chatId, text)

    // Trigger cross-session notification so other channels are aware
    await this.sendNotification({
      sessionId,
      type: 'permission',
      summary: request.description,
      sessionName: sessionId,
    })
  }

  async sendNotification(notification: NotificationMessage): Promise<void> {
    // Send notification to the session's chat if available, otherwise log it
    const sessionId = notification.sessionId
    const chatId = sessionId ? this.resolveSessionChatId(sessionId) : null
    const text = formatNotification(notification)

    if (chatId) {
      await this.sendTextToChat(chatId, text)
    } else {
      log.info({ notification: text }, '[SIGNAL_ADAPTER] Notification (no chat target)')
    }
  }

  async createSessionThread(
    _sessionId: string,
    _name: string,
  ): Promise<string> {
    // Signal has no threads. Return the session's chat ID.
    return ''
  }

  async renameSessionThread(
    _sessionId: string,
    _newName: string,
  ): Promise<void> {
    // Signal has no threads. No-op.
  }

  async cleanupSessionState(sessionId: string): Promise<void> {
    const tracker = this.activityTrackers.get(sessionId)
    tracker?.cleanup()
    this.activityTrackers.delete(sessionId)
    this.permissionHandler.unregisterResolver(sessionId)
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  private getOrCreateTracker(
    sessionId: string,
    chatId: string,
    isGroup: boolean,
  ): SignalActivityTracker {
    let tracker = this.activityTrackers.get(sessionId)
    if (!tracker) {
      tracker = new SignalActivityTracker(this.client, chatId, isGroup)
      this.activityTrackers.set(sessionId, tracker)
    }
    return tracker
  }

  private resolveSessionChatId(sessionId: string): string | null {
    // Try to find the session context
    for (const [chatId, ctx] of this.sessionContexts) {
      // Simple reverse lookup -- in practice we'd maintain a sessionId -> chatId map
      if (chatId) {
        const session = this.core?.sessionManager.getSession(sessionId)
        if (session?.threadId === chatId) {
          return chatId
        }
      }
    }
    // Fallback: check if sessionId is itself a chatId
    if (this.sessionContexts.has(sessionId)) {
      return sessionId
    }
    log.warn({ sessionId }, '[SIGNAL_ADAPTER] Could not resolve chat ID for session')
    return null
  }

  private async sendTextToChat(chatId: string, text: string): Promise<void> {
    const isGroup = chatId.startsWith('group:')
    const maxLen = this.signalConfig.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
    const chunks = splitMessage(text, maxLen)

    for (const chunk of chunks) {
      await this.sendQueue.enqueue(async () => {
        try {
          if (isGroup) {
            const groupId = chatId.slice(6) // strip "group:" prefix
            await this.client.sendGroupMessage(groupId, chunk)
          } else {
            await this.client.sendMessage(chatId, chunk)
          }
        } catch (err) {
          log.warn({ err, chatId }, '[SIGNAL_ADAPTER] Failed to send message')
        }
      })
    }
  }

  // ── Accessors (for testing) ──────────────────────────────────────────────

  /** Get the underlying SignalClient instance. */
  getClient(): SignalClient {
    return this.client
  }

  /** Get the group manager. */
  getGroupManager(): GroupManager {
    return this.groupManager
  }

  /** Get the permission handler. */
  getPermissionHandler(): SignalPermissionHandler {
    return this.permissionHandler
  }
}
