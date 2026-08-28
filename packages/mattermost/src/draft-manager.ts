/**
 * MattermostDraftManager — edit-in-place streaming via PUT /posts/{id}.
 *
 * Pattern: send an initial message, get the post ID, then repeatedly
 * update it with new content as streaming chunks arrive. On finalize,
 * perform a final edit to ensure the complete content is displayed.
 */

import { createChildLogger } from '@openacp/plugin-sdk'
import type { SendQueue } from '@openacp/plugin-sdk'
import type { MattermostClient } from './client.js'
import { splitMessage } from './formatting.js'

const log = createChildLogger({ module: 'mattermost:draft' })

const FLUSH_INTERVAL_MS = 3000

export class MattermostDraft {
  private buffer = ''
  private postId: string | null = null
  private firstFlushPending = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> = Promise.resolve()
  private lastSentBuffer = ''
  private displayTruncated = false

  constructor(
    private readonly client: MattermostClient,
    private readonly channelId: string,
    private readonly rootId: string,
    private readonly sendQueue: SendQueue,
    private readonly sessionId: string,
    private readonly props: Record<string, unknown>,
    private readonly maxMessageLength: number,
  ) {}

  /** Append streaming text to the buffer and schedule a flush. */
  append(text: string): void {
    if (!text) return
    this.buffer += text
    this.scheduleFlush()
  }

  /**
   * Finalize the draft: flush remaining content and return the post ID.
   * If the content exceeds the message limit, split into multiple posts.
   */
  async finalize(): Promise<string | null> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    await this.flushPromise

    if (!this.buffer) return this.postId

    // Already fully sent and nothing new appended
    if (this.postId && this.buffer === this.lastSentBuffer && !this.displayTruncated) {
      return this.postId
    }

    // Try single message update
    if (this.buffer.length <= this.maxMessageLength) {
      try {
        if (this.postId) {
          await this.sendQueue.enqueue(() =>
            this.client.updatePost(this.postId!, {
              message: this.buffer,
              props: this.props,
            }),
          )
        } else {
          const post = await this.sendQueue.enqueue(() =>
            this.client.createPost({
              channelId: this.channelId,
              message: this.buffer,
              rootId: this.rootId,
              props: this.props,
            }),
          )
          if (post) this.postId = post.id
        }
        return this.postId
      } catch (err) {
        log.warn({ err, sessionId: this.sessionId }, '[MM_DRAFT] Finalize single send failed')
      }
    }

    // Split into multiple messages
    const chunks = splitMessage(this.buffer, this.maxMessageLength)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      try {
        if (i === 0 && this.postId) {
          await this.sendQueue.enqueue(() =>
            this.client.updatePost(this.postId!, {
              message: chunk,
              props: this.props,
            }),
          )
        } else {
          const post = await this.sendQueue.enqueue(() =>
            this.client.createPost({
              channelId: this.channelId,
              message: chunk,
              rootId: this.rootId,
              props: this.props,
            }),
          )
          if (i === 0 && post) this.postId = post.id
        }
      } catch (err) {
        log.warn({ err, sessionId: this.sessionId, chunk: i }, '[MM_DRAFT] Finalize chunk failed')
      }
    }

    return this.postId
  }

  /** Get the current post ID (if created). */
  getPostId(): string | null {
    return this.postId
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPromise = this.flushPromise
        .then(() => this.flush())
        .catch(() => {})
    }, FLUSH_INTERVAL_MS)
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return
    if (this.firstFlushPending) return

    const snapshot = this.buffer
    let message = snapshot
    let truncated = false

    if (message.length > this.maxMessageLength) {
      const cutAt = message.lastIndexOf('\n', this.maxMessageLength - 10)
      message = cutAt > this.maxMessageLength * 0.5
        ? message.slice(0, cutAt) + '\n\u2026'
        : message.slice(0, this.maxMessageLength - 3) + '\u2026'
      truncated = true
    }

    if (!this.postId) {
      this.firstFlushPending = true
      try {
        const post = await this.sendQueue.enqueue(() =>
          this.client.createPost({
            channelId: this.channelId,
            message,
            rootId: this.rootId,
            props: this.props,
          }),
        )
        if (post) {
          this.postId = post.id
          if (!truncated) {
            this.lastSentBuffer = snapshot
            this.displayTruncated = false
          } else {
            this.displayTruncated = true
          }
        }
      } catch (err) {
        log.warn({ err, sessionId: this.sessionId }, '[MM_DRAFT] Initial send failed')
      } finally {
        this.firstFlushPending = false
      }
    } else {
      try {
        await this.sendQueue.enqueue(() =>
          this.client.updatePost(this.postId!, {
            message,
            props: this.props,
          }),
        )
        if (!truncated) {
          this.lastSentBuffer = snapshot
          this.displayTruncated = false
        } else {
          this.displayTruncated = true
        }
      } catch (err) {
        log.warn({ err, sessionId: this.sessionId }, '[MM_DRAFT] Edit failed')
      }
    }
  }
}

// ─── DraftManager ────────────────────────────────────────────────────────────

/**
 * Manages per-session MattermostDraft instances.
 */
export class MattermostDraftManager {
  private drafts = new Map<string, MattermostDraft>()

  constructor(
    private readonly client: MattermostClient,
    private readonly sendQueue: SendQueue,
    private readonly instanceId: string,
    private readonly maxMessageLength: number,
  ) {}

  /** Get or create a draft for a session. */
  getOrCreate(
    sessionId: string,
    channelId: string,
    rootId: string,
  ): MattermostDraft {
    let draft = this.drafts.get(sessionId)
    if (!draft) {
      draft = new MattermostDraft(
        this.client,
        channelId,
        rootId,
        this.sendQueue,
        sessionId,
        { [`openacp_${this.instanceId}`]: true },
        this.maxMessageLength,
      )
      this.drafts.set(sessionId, draft)
    }
    return draft
  }

  /** Finalize a session's draft and remove it from the map. */
  async finalize(sessionId: string): Promise<string | null> {
    const draft = this.drafts.get(sessionId)
    if (!draft) return null
    const postId = await draft.finalize()
    this.drafts.delete(sessionId)
    return postId
  }

  /** Finalize all active drafts. */
  async finalizeAll(): Promise<void> {
    const entries = [...this.drafts.entries()]
    this.drafts.clear()
    await Promise.allSettled(
      entries.map(([, draft]) => draft.finalize()),
    )
  }

  /** Check if a session has an active draft. */
  has(sessionId: string): boolean {
    return this.drafts.has(sessionId)
  }

  /** Remove a draft without finalizing (e.g., on error). */
  discard(sessionId: string): void {
    this.drafts.delete(sessionId)
  }
}
