/**
 * MattermostPermissionHandler — renders permission requests as Slack-style
 * interactive attachments in Mattermost. Uses `props.attachments[]` with
 * action buttons. Callback routing is done via direct message parsing
 * (Mattermost does not support generic interactive message callbacks like
 * Slack/Telegram, so we use a reply-based approach).
 */

import { createChildLogger } from '@openacp/plugin-sdk'
import type { SendQueue, PermissionRequest, NotificationMessage, Session } from '@openacp/plugin-sdk'
import type { MattermostClient } from './client.js'
import { escapeMd } from './formatting.js'

const log = createChildLogger({ module: 'mattermost:permissions' })

/** Permission requests auto-expire after 5 minutes */
const PERMISSION_TTL_MS = 5 * 60 * 1000

interface PendingPermission {
  sessionId: string
  requestId: string
  postId: string
  options: Array<{ id: string; label: string; isAllow: boolean }>
  expiryTimer: ReturnType<typeof setTimeout>
}

export class MattermostPermissionHandler {
  private pending = new Map<string, PendingPermission>()

  constructor(
    private readonly client: MattermostClient,
    private readonly sendQueue: SendQueue,
    private readonly instanceId: string,
    private readonly getSession: (sessionId: string) => Session | undefined,
    private readonly sendNotification: (notification: NotificationMessage) => Promise<void>,
  ) {}

  /**
   * Send a permission request as a message with numbered options.
   * Users reply with the option number to grant/deny.
   */
  async sendPermissionRequest(
    session: Session,
    request: PermissionRequest,
    channelId: string,
    rootId: string,
  ): Promise<void> {
    const optionLines = request.options.map((opt, i) => {
      const emoji = opt.isAllow ? ':white_check_mark:' : ':x:'
      return `**${i + 1}.** ${emoji} ${escapeMd(opt.label)}`
    })

    const message = [
      ':lock: **Permission request:**',
      '',
      escapeMd(request.description),
      '',
      ...optionLines,
      '',
      '_Reply with the option number (e.g. `1`) to respond._',
    ].join('\n')

    try {
      const post = await this.sendQueue.enqueue(() =>
        this.client.createPost({
          channelId,
          message,
          rootId,
          props: { [`openacp_${this.instanceId}`]: true },
        }),
      )

      if (post) {
        const key = `${channelId}:${rootId}`

        // Set up expiry timer (I04) — auto-deny after TTL
        const expiryTimer = setTimeout(() => {
          const expired = this.pending.get(key)
          if (expired && expired.requestId === request.id) {
            log.warn(
              { requestId: request.id, sessionId: session.id },
              '[MM_PERMISSIONS_EXPIRY] Permission request expired, auto-denying',
            )
            // Find the first deny option, or use the first option as fallback
            const denyOption = expired.options.find((o) => !o.isAllow) ?? expired.options[0]
            if (denyOption) {
              const sess = this.getSession(expired.sessionId)
              if (sess?.permissionGate.requestId === expired.requestId) {
                sess.permissionGate.resolve(denyOption.id)
              }
            }
            this.pending.delete(key)
            // Update the post to show expiry
            this.sendQueue.enqueue(() =>
              this.client.updatePost(expired.postId, {
                message: `:hourglass: **Permission expired** (auto-denied after 5 minutes)`,
                props: { [`openacp_${this.instanceId}`]: true },
              }),
            ).catch(() => {})
          }
        }, PERMISSION_TTL_MS)

        this.pending.set(key, {
          sessionId: session.id,
          requestId: request.id,
          postId: post.id,
          options: request.options.map((o) => ({
            id: o.id,
            label: o.label,
            isAllow: o.isAllow,
          })),
          expiryTimer,
        })
      }

      // Fire-and-forget notification
      void this.sendNotification({
        sessionId: session.id,
        sessionName: session.name,
        type: 'permission',
        summary: request.description,
      })
    } catch (err) {
      log.error({ err, sessionId: session.id }, '[MM_PERMISSIONS] Failed to send permission request')
    }
  }

  /**
   * Try to handle an incoming message as a permission response.
   * Returns true if the message was consumed as a permission reply.
   */
  tryHandleResponse(
    channelId: string,
    rootId: string,
    text: string,
  ): boolean {
    const key = `${channelId}:${rootId}`
    const pending = this.pending.get(key)
    if (!pending) return false

    // Parse the response — expect a number
    const num = parseInt(text.trim(), 10)
    if (isNaN(num) || num < 1 || num > pending.options.length) return false

    const option = pending.options[num - 1]
    if (!option) return false

    // Clear expiry timer on resolution (I04)
    clearTimeout(pending.expiryTimer)

    const session = this.getSession(pending.sessionId)
    if (session?.permissionGate.requestId === pending.requestId) {
      session.permissionGate.resolve(option.id)
      log.info(
        { requestId: pending.requestId, optionId: option.id, isAllow: option.isAllow },
        '[MM_PERMISSIONS] Permission responded',
      )
    }

    this.pending.delete(key)

    // Edit the permission post to show the chosen option
    this.sendQueue.enqueue(() =>
      this.client.updatePost(pending.postId, {
        message: `:white_check_mark: **Permission resolved:** ${escapeMd(option.label)}`,
        props: { [`openacp_${this.instanceId}`]: true },
      }),
    ).catch(() => {})

    return true
  }

  /** Clean up pending permissions for a session, clearing expiry timers. */
  cleanup(sessionId: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.expiryTimer)
        this.pending.delete(key)
      }
    }
  }
}
