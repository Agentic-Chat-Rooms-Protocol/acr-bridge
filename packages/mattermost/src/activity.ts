/**
 * Mattermost ActivityTracker — manages thinking indicators and tool card
 * display during agent processing. Uses Mattermost's edit-in-place
 * (PUT /posts/{id}) for live updates.
 */

import { createChildLogger } from '@openacp/plugin-sdk'
import type { SendQueue } from '@openacp/plugin-sdk'
import type { MattermostClient } from './client.js'
import { formatToolCall, splitMessage } from './formatting.js'
import type { ToolCallMeta, DisplayVerbosity } from '@openacp/plugin-sdk'

const log = createChildLogger({ module: 'mattermost:activity' })

const THINKING_REFRESH_MS = 15_000
const THINKING_MAX_MS = 3 * 60 * 1000

// ─── ThinkingIndicator ──────────────────────────────────────────────────────

export class ThinkingIndicator {
  private postId: string | null = null
  private sending = false
  private dismissed = false
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private showTime = 0

  constructor(
    private readonly client: MattermostClient,
    private readonly channelId: string,
    private readonly rootId: string,
    private readonly sendQueue: SendQueue,
    private readonly props: Record<string, unknown>,
  ) {}

  async show(): Promise<void> {
    if (this.sending || this.dismissed || this.postId) return
    this.sending = true
    this.showTime = Date.now()

    try {
      const post = await this.sendQueue.enqueue(() =>
        this.client.createPost({
          channelId: this.channelId,
          message: ':thought_balloon: *Thinking...*',
          rootId: this.rootId,
          props: this.props,
        }),
      )
      if (post) {
        if (this.dismissed) {
          // Dismissed during queue wait — delete the message
          this.sendQueue.enqueue(() =>
            this.client.deletePost(post.id),
          ).catch(() => {})
        } else {
          this.postId = post.id
          this.startRefreshTimer()
        }
      }
    } catch (err) {
      log.warn({ err }, '[MM_THINKING] show() failed')
    } finally {
      this.sending = false
    }
  }

  async dismiss(): Promise<void> {
    if (this.dismissed) return
    this.dismissed = true
    this.stopRefreshTimer()
    if (this.postId) {
      const id = this.postId
      this.postId = null
      try {
        await this.sendQueue.enqueue(() => this.client.deletePost(id))
      } catch {
        // Best effort — message may already be deleted
      }
    }
  }

  reset(): void {
    this.dismissed = false
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer()
    this.refreshTimer = setInterval(() => {
      if (
        this.dismissed ||
        !this.postId ||
        Date.now() - this.showTime >= THINKING_MAX_MS
      ) {
        this.stopRefreshTimer()
        return
      }
      const elapsed = Math.round((Date.now() - this.showTime) / 1000)
      const text = `:thought_balloon: *Still thinking... (${elapsed}s)*`
      this.sendQueue
        .enqueue(() => {
          if (this.dismissed || !this.postId) return Promise.resolve(undefined)
          return this.client.updatePost(this.postId, {
            message: text,
            props: this.props,
          })
        })
        .catch(() => {})
    }, THINKING_REFRESH_MS)
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }
}

// ─── ToolCard ───────────────────────────────────────────────────────────────

interface ToolEntry {
  id: string
  meta: ToolCallMeta
  status: string
}

export class ToolCard {
  private postId: string | null = null
  private tools: ToolEntry[] = []
  private lastSentText = ''

  constructor(
    private readonly client: MattermostClient,
    private readonly channelId: string,
    private readonly rootId: string,
    private readonly sendQueue: SendQueue,
    private readonly props: Record<string, unknown>,
    private readonly maxMessageLength: number,
  ) {}

  addTool(id: string, meta: ToolCallMeta): void {
    const existing = this.tools.find((t) => t.id === id)
    if (existing) {
      existing.meta = meta
    } else {
      this.tools.push({ id, meta, status: 'running' })
    }
    this.scheduleRender()
  }

  updateTool(id: string, status: string, meta?: Partial<ToolCallMeta>): void {
    const entry = this.tools.find((t) => t.id === id)
    if (entry) {
      entry.status = status
      if (meta) entry.meta = { ...entry.meta, ...meta }
      this.scheduleRender()
    }
  }

  hasContent(): boolean {
    return this.tools.length > 0
  }

  getPostId(): string | null {
    return this.postId
  }

  async finalize(): Promise<void> {
    await this.render()
  }

  destroy(): void {
    // No-op — no timers to clear in this simplified version
  }

  private renderTimer: ReturnType<typeof setTimeout> | null = null

  private scheduleRender(): void {
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.render().catch(() => {})
    }, 500)
  }

  private async render(): Promise<void> {
    if (this.tools.length === 0) return

    const total = this.tools.length
    const completed = this.tools.filter((t) =>
      ['completed', 'done', 'failed', 'error'].includes(t.status),
    ).length
    const allComplete = total > 0 && completed === total
    const headerCheck = allComplete ? ' :white_check_mark:' : ''
    const lines: string[] = [`**:clipboard: Tools (${completed}/${total})**${headerCheck}`]

    for (const entry of this.tools) {
      const statusPrefix =
        entry.status === 'error' || entry.status === 'failed'
          ? ':x: '
          : ['completed', 'done'].includes(entry.status)
            ? ':white_check_mark: '
            : ':arrows_counterclockwise: '
      const title = entry.meta.displayTitle ?? entry.meta.displaySummary ?? entry.meta.name ?? 'Tool'
      lines.push(`${statusPrefix}${title}`)
    }

    const text = lines.join('\n')
    if (text === this.lastSentText) return
    this.lastSentText = text

    // Truncate if exceeds limit
    const message = text.length > this.maxMessageLength
      ? text.slice(0, this.maxMessageLength - 3) + '\u2026'
      : text

    try {
      if (this.postId) {
        await this.sendQueue.enqueue(() =>
          this.client.updatePost(this.postId!, {
            message,
            props: this.props,
          }),
        )
      } else {
        const post = await this.sendQueue.enqueue(() =>
          this.client.createPost({
            channelId: this.channelId,
            message,
            rootId: this.rootId,
            props: this.props,
          }),
        )
        if (post) this.postId = post.id
      }
    } catch (err) {
      log.warn({ err }, '[MM_TOOLCARD] render failed')
    }
  }
}

// ─── ActivityTracker ────────────────────────────────────────────────────────

export class MattermostActivityTracker {
  private thinking: ThinkingIndicator
  private toolCard: ToolCard
  private isFirstEvent = true

  constructor(
    private readonly client: MattermostClient,
    private readonly channelId: string,
    private readonly rootId: string,
    private readonly sendQueue: SendQueue,
    private readonly props: Record<string, unknown>,
    private readonly maxMessageLength: number,
  ) {
    this.thinking = new ThinkingIndicator(client, channelId, rootId, sendQueue, props)
    this.toolCard = new ToolCard(client, channelId, rootId, sendQueue, props, maxMessageLength)
  }

  async onNewPrompt(): Promise<void> {
    this.isFirstEvent = true
    await this.thinking.dismiss()
    this.thinking.reset()
    await this.toolCard.finalize()
    this.toolCard = new ToolCard(
      this.client,
      this.channelId,
      this.rootId,
      this.sendQueue,
      this.props,
      this.maxMessageLength,
    )
  }

  async onThought(): Promise<void> {
    this.isFirstEvent = false
    await this.thinking.show()
  }

  async onTextStart(): Promise<void> {
    this.isFirstEvent = false
    await this.thinking.dismiss()
  }

  async onToolCall(id: string, meta: ToolCallMeta): Promise<void> {
    this.isFirstEvent = false
    await this.thinking.dismiss()
    this.thinking.reset()
    this.toolCard.addTool(id, meta)
  }

  async onToolUpdate(id: string, status: string, meta?: Partial<ToolCallMeta>): Promise<void> {
    this.toolCard.updateTool(id, status, meta)
  }

  async cleanup(): Promise<void> {
    await this.thinking.dismiss()
    await this.toolCard.finalize()
    this.toolCard.destroy()
  }

  destroy(): void {
    void this.thinking.dismiss()
    this.toolCard.destroy()
  }
}
