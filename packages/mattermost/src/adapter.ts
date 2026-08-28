/**
 * MattermostAdapter — full-featured OpenACP adapter for Mattermost.
 *
 * Connects via WebSocket for real-time events and REST API v4 for
 * message operations. Supports threading (CRT), streaming (edit-in-place),
 * reactions, file uploads, and interactive permission requests.
 */

import {
  MessagingAdapter,
  SendQueue,
  BaseRenderer,
  createChildLogger,
} from '@openacp/plugin-sdk'
import type {
  AdapterCapabilities,
  OutgoingMessage,
  IRenderer,
  PermissionRequest,
  NotificationMessage,
  DisplayVerbosity,
  ToolCallMeta,
  ToolUpdateMeta,
  OpenACPCore,
  Session,
} from '@openacp/plugin-sdk'
import type { MattermostConfig, MattermostSessionContext, MattermostPost, MattermostWSEvent, MattermostFileInfo } from './types.js'
import { MattermostClient, MattermostApiError } from './client.js'
import { MattermostWebSocket, parseMentions } from './websocket.js'
import { MattermostRenderer } from './renderer.js'
import { MattermostDraftManager } from './draft-manager.js'
import { MattermostActivityTracker } from './activity.js'
import { MattermostPermissionHandler } from './permissions.js'
import {
  resolveRootId,
  buildSessionId,
  shouldHandleThreadReply,
  shouldAutoRespond,
  isMentioned,
  containsTrigger,
  stripTrigger,
} from './threading.js'
import { escapeMd, splitMessage } from './formatting.js'

const log = createChildLogger({ module: 'mattermost' })

export class MattermostAdapter extends MessagingAdapter {
  readonly name = 'mattermost'
  readonly renderer: IRenderer = new MattermostRenderer()
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    richFormatting: true,
    threads: true,
    reactions: true,
    fileUpload: true,
    voice: false,
  }

  private readonly core: OpenACPCore
  private readonly config: MattermostConfig
  private client!: MattermostClient
  private ws!: MattermostWebSocket
  private botUserId = ''
  private instanceId: string
  private sendQueue = new SendQueue({ minInterval: 1000 })
  private draftManager!: MattermostDraftManager
  private sessionContexts = new Map<string, MattermostSessionContext>()
  private sessionTrackers = new Map<string, MattermostActivityTracker>()
  private channelTypeCache = new Map<string, string>()
  private channelTeamCache = new Map<string, string>()
  private permissionHandler!: MattermostPermissionHandler
  private typingPumps = new Map<string, ReturnType<typeof setInterval>>()
  /** Timestamp of the last processed WS event (for since-based backfill) */
  private lastEventTimestamp = Date.now()
  /** Dedup set of recently processed event/post IDs, capped at max size */
  private processedEventIds = new Set<string>()
  private static readonly MAX_DEDUP_SIZE = 1000

  constructor(core: OpenACPCore, config: MattermostConfig) {
    super(
      { configManager: core.configManager },
      {
        enabled: config.enabled ?? true,
        maxMessageLength: config.maxMessageLength ?? 4000,
      },
    )
    this.core = core
    this.config = config
    this.instanceId = config.instanceId ?? generateInstanceId()
  }

  async start(): Promise<void> {
    this.client = new MattermostClient({
      url: this.config.url,
      token: this.config.token,
    })

    // Resolve bot user identity
    const me = await this.client.getMe()
    this.botUserId = me.id
    log.info(
      { botUserId: this.botUserId, username: me.username },
      '[MM_ADAPTER] Bot user resolved',
    )

    // Restore persisted session contexts (H06)
    await this.restoreSessionContexts()

    // Initialize managers
    this.draftManager = new MattermostDraftManager(
      this.client,
      this.sendQueue,
      this.instanceId,
      this.config.maxMessageLength ?? 4000,
    )

    this.permissionHandler = new MattermostPermissionHandler(
      this.client,
      this.sendQueue,
      this.instanceId,
      (sessionId) => this.core.sessionManager.getSession(sessionId),
      (notification) => this.sendNotification(notification),
    )

    // Connect WebSocket
    this.ws = new MattermostWebSocket({
      baseUrl: this.client.getBaseUrl(),
      token: this.client.getToken(),
      onEvent: (event) => this.handleWSEvent(event),
      onConnect: () => {
        log.info('[MM_ADAPTER] WebSocket connected')
        // Set presence online (G08) — only after we have the bot user id
        if (this.botUserId) {
          this.client.setStatus(this.botUserId, 'online').catch((err) =>
            log.warn({ err }, '[MM_ADAPTER_PRESENCE] Failed to set online status'),
          )
        }
        // Backfill missed posts since last event (M16)
        this.backfillMissedPosts().catch((err) =>
          log.warn({ err }, '[MM_ADAPTER_BACKFILL] Failed to backfill after reconnect'),
        )
      },
      onDisconnect: (code, reason) => {
        log.warn({ code, reason }, '[MM_ADAPTER] WebSocket disconnected')
      },
      onError: (err) => {
        log.error({ err }, '[MM_ADAPTER] WebSocket error')
      },
      onAuthError: (detail) => {
        log.error({ detail }, '[MM_ADAPTER_AUTH] Authentication failed — stopping adapter')
        // Do not reconnect; shut down cleanly
        this.stop().catch(() => {})
      },
    })

    this.lastEventTimestamp = Date.now()
    this.ws.connect()

    log.info('[MM_ADAPTER] Mattermost adapter started')
  }

  async stop(): Promise<void> {
    // Set presence offline (G08)
    if (this.botUserId) {
      try {
        await this.client.setStatus(this.botUserId, 'offline')
      } catch {
        // Best effort — client may already be unavailable
      }
    }

    // Stop typing pumps
    for (const timer of this.typingPumps.values()) clearInterval(timer)
    this.typingPumps.clear()

    // Destroy activity trackers
    for (const tracker of this.sessionTrackers.values()) tracker.destroy()
    this.sessionTrackers.clear()

    // Finalize all drafts
    await this.draftManager.finalizeAll()

    // Persist session contexts before shutdown (H06)
    await this.persistSessionContexts()

    // Disconnect WebSocket
    this.ws.disconnect()

    // Clear send queue
    this.sendQueue.clear()

    log.info('[MM_ADAPTER] Mattermost adapter stopped')
  }

  // ─── Session thread management ───────────────────────────────────────────

  async createSessionThread(
    sessionId: string,
    name: string,
  ): Promise<string> {
    // In Mattermost, a "thread" is just a root post. Create a root post
    // as the thread anchor, return its ID.
    const channelId = this.config.channelId
    if (!channelId) {
      throw new Error('Cannot create session thread: no channelId configured')
    }

    const post = await this.client.createPost({
      channelId,
      message: `:robot_face: **${escapeMd(name)}**\n_Session started_`,
      props: { [`openacp_${this.instanceId}`]: true },
    })

    this.sessionContexts.set(sessionId, {
      channelId,
      rootPostId: post.id,
      channelType: 'O',
      lastActivityTs: Date.now(),
    })

    return post.id
  }

  async renameSessionThread(
    sessionId: string,
    newName: string,
  ): Promise<void> {
    const ctx = this.sessionContexts.get(sessionId)
    if (!ctx) return

    // Edit the root post to show the new name
    try {
      await this.client.updatePost(ctx.rootPostId, {
        message: `:robot_face: **${escapeMd(newName)}**\n_Session active_`,
        props: { [`openacp_${this.instanceId}`]: true },
      })
    } catch (err) {
      log.warn({ err, sessionId }, '[MM_ADAPTER] Failed to rename session thread')
    }
  }

  async sendPermissionRequest(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<void> {
    const ctx = this.sessionContexts.get(sessionId)
    if (!ctx) return
    // Resolve the Session object via the core for the permission handler
    const session = await this.core.sessionManager.getSession(sessionId)
    if (!session) {
      log.warn({ sessionId, requestId: request.id }, '[MM_ADAPTER] Permission request for unknown session')
      return
    }
    await this.permissionHandler.sendPermissionRequest(
      session,
      request,
      ctx.channelId,
      ctx.rootPostId,
    )
  }

  async sendNotification(
    notification: NotificationMessage,
  ): Promise<void> {
    const channelId = this.config.channelId
    if (!channelId) return

    const rendered = this.renderer.renderNotification(notification)
    try {
      await this.sendQueue.enqueue(() =>
        this.client.createPost({
          channelId,
          message: rendered.body,
          props: { [`openacp_${this.instanceId}`]: true },
        }),
      )
    } catch (err) {
      log.warn({ err }, '[MM_ADAPTER] Failed to send notification')
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  protected async cleanupSessionState(sessionId: string): Promise<void> {
    const ctx = this.sessionContexts.get(sessionId)
    if (ctx) {
      this.stopTypingPump(ctx.channelId, ctx.rootPostId)
    }
    this.sessionContexts.delete(sessionId)
    this.persistSessionContexts().catch(() => {})
    this.permissionHandler.cleanup(sessionId)
    const tracker = this.sessionTrackers.get(sessionId)
    if (tracker) {
      await tracker.cleanup()
      this.sessionTrackers.delete(sessionId)
    }
    this.draftManager.discard(sessionId)
  }

  // ─── Message handlers ────────────────────────────────────────────────────

  protected async handleText(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return

    const tracker = this.sessionTrackers.get(sessionId)
    if (tracker) await tracker.onTextStart()

    const draft = this.draftManager.getOrCreate(
      sessionId,
      ctx.channelId,
      ctx.rootPostId,
    )
    draft.append(content.text)
  }

  protected async handleThought(
    sessionId: string,
    _content: OutgoingMessage,
    _verbosity: DisplayVerbosity,
  ): Promise<void> {
    const tracker = this.getOrCreateTracker(sessionId)
    if (tracker) await tracker.onThought()
  }

  protected async handleToolCall(
    sessionId: string,
    content: OutgoingMessage,
    _verbosity: DisplayVerbosity,
  ): Promise<void> {
    const meta = (content.metadata ?? {}) as Partial<ToolCallMeta>
    const tracker = this.getOrCreateTracker(sessionId)
    if (tracker && meta.id) {
      await tracker.onToolCall(meta.id, meta as ToolCallMeta)
    }
  }

  protected async handleToolUpdate(
    sessionId: string,
    content: OutgoingMessage,
    _verbosity: DisplayVerbosity,
  ): Promise<void> {
    const meta = (content.metadata ?? {}) as Partial<ToolUpdateMeta>
    const tracker = this.sessionTrackers.get(sessionId)
    if (tracker && meta.id) {
      await tracker.onToolUpdate(meta.id, meta.status ?? 'completed', meta)
    }
  }

  protected async handlePlan(
    sessionId: string,
    content: OutgoingMessage,
    _verbosity: DisplayVerbosity,
  ): Promise<void> {
    // Render plan as a standalone message
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return
    const rendered = this.renderer.renderPlan(content)
    await this.postMessage(ctx, rendered.body)
  }

  protected async handleUsage(
    sessionId: string,
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return
    const rendered = this.renderer.renderUsage(content, verbosity)
    await this.postMessage(ctx, rendered.body)
  }

  protected async handleError(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return
    this.stopTypingPump(ctx.channelId, ctx.rootPostId)
    const rendered = this.renderer.renderError(content)
    await this.postMessage(ctx, rendered.body)

    // Finalize any active draft
    await this.draftManager.finalize(sessionId)
    const tracker = this.sessionTrackers.get(sessionId)
    if (tracker) await tracker.cleanup()
  }

  protected async handleAttachment(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return

    // If there's attachment data, upload and post
    const meta = content.metadata as { filePath?: string; fileName?: string; mimeType?: string } | undefined
    if (meta?.filePath) {
      try {
        const fs = await import('node:fs')
        const buffer = fs.readFileSync(meta.filePath)
        const fileInfo = await this.client.uploadFile({
          channelId: ctx.channelId,
          buffer: new Uint8Array(buffer),
          fileName: meta.fileName ?? 'file',
          contentType: meta.mimeType,
        })
        await this.sendQueue.enqueue(() =>
          this.client.createPost({
            channelId: ctx.channelId,
            message: content.text || '',
            rootId: ctx.rootPostId,
            fileIds: [fileInfo.id],
            props: { [`openacp_${this.instanceId}`]: true },
          }),
        )
      } catch (err) {
        log.warn({ err, sessionId }, '[MM_ADAPTER] Failed to upload attachment')
        // Fallback: send text only
        if (content.text) await this.postMessage(ctx, content.text)
      }
    } else if (content.text) {
      await this.postMessage(ctx, content.text)
    }
  }

  protected async handleSystem(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return
    const rendered = this.renderer.renderSystemMessage?.(content)
    if (!rendered) return
    await this.postMessage(ctx, rendered.body)
  }

  protected async handleSessionEnd(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (ctx) {
      this.stopTypingPump(ctx.channelId, ctx.rootPostId)
    }

    // Finalize draft
    await this.draftManager.finalize(sessionId)

    // Cleanup tracker
    const tracker = this.sessionTrackers.get(sessionId)
    if (tracker) await tracker.cleanup()

    // Send session end message if there's text
    if (ctx && content.text) {
      await this.postMessage(ctx, content.text)
    }

    await this.cleanupSessionState(sessionId)
  }

  protected async handleModeChange(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return
    const verbosity = this.getVerbosity()
    const rendered = this.renderer.renderModeChange?.(content, verbosity)
    if (!rendered) return
    await this.postMessage(ctx, rendered.body)
  }

  protected async handleConfigUpdate(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return
    const verbosity = this.getVerbosity()
    const rendered = this.renderer.renderConfigUpdate?.(content, verbosity)
    if (!rendered) return
    await this.postMessage(ctx, rendered.body)
  }

  protected async handleModelUpdate(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    const ctx = this.getSessionContext(sessionId)
    if (!ctx) return
    const verbosity = this.getVerbosity()
    const rendered = this.renderer.renderModelUpdate?.(content, verbosity)
    if (!rendered) return
    await this.postMessage(ctx, rendered.body)
  }

  // ─── WebSocket event handling ────────────────────────────────────────────

  private async handleWSEvent(event: { event: string; data: Record<string, string>; broadcast: { channel_id?: string; team_id?: string; user_id?: string } }): Promise<void> {
    // Track last event time for since-based backfill (M16)
    this.lastEventTimestamp = Date.now()

    switch (event.event) {
      case 'posted':
      case 'post_edited':
        // For post_edited, backfill team_id if missing (M13)
        if (event.event === 'post_edited' && !event.broadcast.team_id) {
          const channelId = event.broadcast.channel_id
          if (channelId) {
            const teamId = await this.resolveTeamId(channelId)
            if (teamId) {
              event.broadcast.team_id = teamId
            }
          }
        }
        await this.handlePostedEvent(event)
        break
      // Other events (reaction_added, etc.) can be handled here
      default:
        break
    }
  }

  private async handlePostedEvent(event: { event: string; data: Record<string, string>; broadcast: { channel_id?: string } }): Promise<void> {
    const postStr = event.data?.post
    if (!postStr) return

    let post: MattermostPost
    try {
      post = JSON.parse(postStr) as MattermostPost
    } catch {
      return
    }

    // Event dedup (G13) — skip already-processed posts
    if (post.id && this.processedEventIds.has(post.id)) {
      return
    }
    this.addProcessedEventId(post.id)

    // Loop guard: ignore our own messages
    if (post.user_id === this.botUserId) return
    if (post.props?.[`openacp_${this.instanceId}`]) return

    // Ignore system posts
    if (post.type && post.type !== '') return

    // Ignore empty messages (but allow posts with only file attachments)
    if (!post.message?.trim() && !(post.file_ids?.length)) return

    const channelId = post.channel_id
    if (!channelId) return

    // If we have a specific channel configured, only handle that channel (plus DMs)
    const channelType = await this.resolveChannelType(channelId)

    // Check if this is a permission response first
    const rootId = resolveRootId(post)
    if (this.permissionHandler.tryHandleResponse(channelId, rootId, post.message)) {
      return
    }

    // Build session key
    const sessionKey = buildSessionId(channelId, rootId)
    const sessionExists = this.sessionContexts.has(sessionKey) ||
      !!(await this.core.getOrResumeSession('mattermost', rootId))

    // Thread reply handling
    if (post.root_id) {
      if (!shouldHandleThreadReply(post, sessionExists)) return
    } else {
      // Root post — check if we should engage
      if (!shouldAutoRespond(channelType)) {
        // Team channel — check for mention or trigger
        const mentionIds = parseMentions(event as MattermostWSEvent)
        const mentioned = isMentioned(mentionIds, this.botUserId)
        const triggered = this.config.trigger
          ? containsTrigger(post.message, this.config.trigger)
          : false

        if (!mentioned && !triggered) return
      }
    }

    // Resolve or create session
    let session = await this.core.getOrResumeSession('mattermost', rootId)
    if (!session) {
      try {
        const cfg = this.core.configManager
        const agentName = cfg.get().defaultAgent ?? 'claude'
        const workingDirectory = cfg.resolveWorkspace?.() ?? process.cwd()
        session = await this.core.createSession({
          channelId: 'mattermost',
          agentName,
          workingDirectory,
          threadId: rootId,
          initialName: `mm:${channelId.slice(0, 8)}`,
        })
        log.info(
          { sessionId: session.id, channelId, rootId },
          '[MM_ADAPTER] Created session for post',
        )
      } catch (err) {
        log.error({ err, channelId }, '[MM_ADAPTER] Failed to create session')
        return
      }
    }

    // Store session context and persist (H06)
    this.sessionContexts.set(session.id, {
      channelId,
      rootPostId: rootId,
      channelType,
      lastActivityTs: Date.now(),
    })
    this.persistSessionContexts().catch(() => {})

    // Start typing pump
    this.startTypingPump(channelId, rootId)

    // Finalize any previous draft for this session
    await this.draftManager.finalize(session.id)
    const tracker = this.sessionTrackers.get(session.id)
    if (tracker) await tracker.onNewPrompt()

    // Download inbound file attachments (G06)
    const attachments = await this.resolveInboundFiles(post)

    // Strip trigger if present
    let text = post.message
    if (this.config.trigger) {
      text = stripTrigger(text, this.config.trigger)
    }

    // Forward to core
    this.core.handleMessage({
      channelId: 'mattermost',
      threadId: rootId,
      userId: post.user_id,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    }).catch((err) => log.error({ err }, '[MM_ADAPTER] handleMessage error'))
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private getSessionContext(sessionId: string): MattermostSessionContext | undefined {
    return this.sessionContexts.get(sessionId)
  }

  private getOrCreateTracker(sessionId: string): MattermostActivityTracker | undefined {
    let tracker = this.sessionTrackers.get(sessionId)
    if (!tracker) {
      const ctx = this.getSessionContext(sessionId)
      if (!ctx) return undefined
      tracker = new MattermostActivityTracker(
        this.client,
        ctx.channelId,
        ctx.rootPostId,
        this.sendQueue,
        { [`openacp_${this.instanceId}`]: true },
        this.config.maxMessageLength ?? 4000,
      )
      this.sessionTrackers.set(sessionId, tracker)
    }
    return tracker
  }

  private async postMessage(
    ctx: MattermostSessionContext,
    message: string,
  ): Promise<void> {
    const chunks = splitMessage(message, this.config.maxMessageLength ?? 4000)
    for (const chunk of chunks) {
      try {
        await this.sendQueue.enqueue(() =>
          this.client.createPost({
            channelId: ctx.channelId,
            message: chunk,
            rootId: ctx.rootPostId,
            props: { [`openacp_${this.instanceId}`]: true },
          }),
        )
      } catch (err) {
        // H07 — Stale session handling: on 404, remove the session context
        if (err instanceof MattermostApiError && err.status === 404) {
          log.warn(
            { channelId: ctx.channelId, rootPostId: ctx.rootPostId },
            '[MM_ADAPTER_STALE] Post target not found (404), removing stale session context',
          )
          // Find and remove the session context that references this channel+root
          for (const [sessionId, sessionCtx] of this.sessionContexts) {
            if (sessionCtx.channelId === ctx.channelId && sessionCtx.rootPostId === ctx.rootPostId) {
              this.sessionContexts.delete(sessionId)
              this.persistSessionContexts().catch(() => {})
              break
            }
          }
          return
        }
        log.warn({ err }, '[MM_ADAPTER] Failed to post message chunk')
      }
    }
  }

  private async resolveChannelType(channelId: string): Promise<string> {
    const cached = this.channelTypeCache.get(channelId)
    if (cached) return cached

    try {
      const channel = await this.client.getChannel(channelId)
      this.channelTypeCache.set(channelId, channel.type)
      return channel.type
    } catch {
      return 'O' // Default to public channel
    }
  }

  private startTypingPump(channelId: string, rootId: string): void {
    const key = `${channelId}:${rootId}`
    if (this.typingPumps.has(key)) return

    const fire = () => {
      this.client.sendTyping(channelId, rootId).catch(() => {})
    }
    fire()
    const timer = setInterval(fire, 4000)
    this.typingPumps.set(key, timer)
  }

  private stopTypingPump(channelId: string, rootId: string): void {
    const key = `${channelId}:${rootId}`
    const timer = this.typingPumps.get(key)
    if (timer) {
      clearInterval(timer)
      this.typingPumps.delete(key)
    }
  }

  // ─── M13 — team_id backfill ──────────────────────────────────────────────

  private async resolveTeamId(channelId: string): Promise<string | undefined> {
    const cached = this.channelTeamCache.get(channelId)
    if (cached) return cached
    try {
      const channel = await this.client.getChannel(channelId)
      if (channel.team_id) {
        this.channelTeamCache.set(channelId, channel.team_id)
        return channel.team_id
      }
    } catch (err) {
      log.warn({ err, channelId }, '[MM_ADAPTER_TEAM_BACKFILL] Failed to resolve team_id')
    }
    return undefined
  }

  // ─── G06 — Inbound file handling ─────────────────────────────────────────

  private async resolveInboundFiles(
    post: MattermostPost,
  ): Promise<Array<{ type: 'image' | 'audio' | 'file'; filePath: string; fileName: string; mimeType: string; size: number }>> {
    const fileIds = post.file_ids
    if (!fileIds?.length) return []

    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const os = await import('node:os')

    const results: Array<{ type: 'image' | 'audio' | 'file'; filePath: string; fileName: string; mimeType: string; size: number }> = []
    for (const fileId of fileIds) {
      try {
        const info: MattermostFileInfo = await this.client.getFileInfo(fileId)
        const data: ArrayBuffer = await this.client.getFile(fileId)
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-attach-'))
        const filePath = path.join(tmpDir, info.name)
        await fs.writeFile(filePath, Buffer.from(data))
        const mime = info.mime_type
        const type: 'image' | 'audio' | 'file' = mime.startsWith('image/')
          ? 'image'
          : mime.startsWith('audio/')
            ? 'audio'
            : 'file'
        results.push({
          type,
          filePath,
          fileName: info.name,
          mimeType: mime,
          size: info.size,
        })
      } catch (err) {
        log.warn({ err, fileId }, '[MM_ADAPTER_FILES] Failed to download inbound file')
      }
    }
    return results
  }

  // ─── G13 — Event dedup ───────────────────────────────────────────────────

  private addProcessedEventId(id: string): void {
    if (!id) return
    this.processedEventIds.add(id)
    // Trim to max size — remove oldest entries (Set preserves insertion order)
    if (this.processedEventIds.size > MattermostAdapter.MAX_DEDUP_SIZE) {
      const excess = this.processedEventIds.size - MattermostAdapter.MAX_DEDUP_SIZE
      let removed = 0
      for (const oldId of this.processedEventIds) {
        if (removed >= excess) break
        this.processedEventIds.delete(oldId)
        removed++
      }
    }
  }

  // ─── M16 — since-based backfill after WS reconnect ───────────────────────

  private async backfillMissedPosts(): Promise<void> {
    if (!this.lastEventTimestamp) return
    const since = this.lastEventTimestamp

    // Collect unique channel IDs from active sessions
    const channelIds = new Set<string>()
    for (const ctx of this.sessionContexts.values()) {
      channelIds.add(ctx.channelId)
    }
    // Also include the configured channel if any
    if (this.config.channelId) {
      channelIds.add(this.config.channelId)
    }

    if (channelIds.size === 0) return

    log.info(
      { since, channelCount: channelIds.size },
      '[MM_ADAPTER_BACKFILL] Backfilling missed posts since last event',
    )

    for (const channelId of channelIds) {
      try {
        const result = await this.client.getPostsSince(channelId, since)
        if (!result?.order?.length) continue

        // Process posts in chronological order (order is newest-first)
        const sortedIds = [...result.order].reverse()
        for (const postId of sortedIds) {
          const post = result.posts[postId]
          if (!post) continue

          // Construct a synthetic WS event and process through the normal handler
          const syntheticEvent = {
            event: 'posted' as const,
            data: { post: JSON.stringify(post) },
            broadcast: { channel_id: channelId },
          }
          await this.handlePostedEvent(syntheticEvent)
        }
      } catch (err) {
        log.warn(
          { err, channelId },
          '[MM_ADAPTER_BACKFILL] Failed to backfill channel',
        )
      }
    }
  }

  // ─── H06 — Session persistence ───────────────────────────────────────────

  private async persistSessionContexts(): Promise<void> {
    try {
      const storage = (this.core as unknown as { storage?: { set(key: string, value: unknown): Promise<void> } }).storage
      if (!storage) return
      const serialized: Record<string, { channelId: string; rootPostId: string; threadId?: string }> = {}
      for (const [sessionId, ctx] of this.sessionContexts) {
        serialized[sessionId] = {
          channelId: ctx.channelId,
          rootPostId: ctx.rootPostId,
        }
      }
      await storage.set('mattermost:sessionContexts', serialized)
    } catch (err) {
      log.warn({ err }, '[MM_ADAPTER_PERSIST] Failed to persist session contexts')
    }
  }

  private async restoreSessionContexts(): Promise<void> {
    try {
      const storage = (this.core as unknown as { storage?: { get(key: string): Promise<unknown> } }).storage
      if (!storage) return
      const raw = await storage.get('mattermost:sessionContexts')
      if (!raw || typeof raw !== 'object') return
      const stored = raw as Record<string, { channelId: string; rootPostId: string; threadId?: string }>
      for (const [sessionId, data] of Object.entries(stored)) {
        if (data.channelId && data.rootPostId) {
          this.sessionContexts.set(sessionId, {
            channelId: data.channelId,
            rootPostId: data.rootPostId,
            channelType: 'O', // Will be resolved on next event
            lastActivityTs: 0,
          })
        }
      }
      if (this.sessionContexts.size > 0) {
        log.info(
          { count: this.sessionContexts.size },
          '[MM_ADAPTER_PERSIST] Restored session contexts from storage',
        )
      }
    } catch (err) {
      log.warn({ err }, '[MM_ADAPTER_PERSIST] Failed to restore session contexts')
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function generateInstanceId(): string {
  return `mm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

