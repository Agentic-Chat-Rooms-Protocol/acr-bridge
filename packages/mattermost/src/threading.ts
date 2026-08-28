/**
 * Mattermost threading helpers — session keying, root ID resolution,
 * DM detection, and thread reply filtering.
 *
 * Mattermost threads are FLAT — all replies share the same root_id.
 * parent_id is deprecated and must never be used.
 */

import type { MattermostPost, MattermostChannel } from './types.js'

/**
 * Resolve the root post ID for threading.
 * If the post is already a root (no root_id), return post.id.
 * If the post is a reply, return its root_id.
 */
export function resolveRootId(post: MattermostPost): string {
  return post.root_id || post.id
}

/**
 * Build the session ID from channel + root post.
 * Format: `channelId:rootPostId` — unique per thread per channel.
 */
export function buildSessionId(channelId: string, rootPostId: string): string {
  return `${channelId}:${rootPostId}`
}

/**
 * Determine if the bot should handle a thread reply.
 *
 * Logic:
 * - If the post is in a thread that already has an active session, handle it.
 * - If the post is a reply in a thread with no session, ignore it
 *   (avoids hijacking random threads).
 * - If the post is a root post (not a reply), the caller decides separately
 *   whether to create a new session (e.g., based on trigger/mention/DM).
 */
export function shouldHandleThreadReply(
  post: MattermostPost,
  sessionExists: boolean,
): boolean {
  // Root posts are not "thread replies" — handled separately
  if (!post.root_id) return false
  // Only handle replies in threads where we have an active session
  return sessionExists
}

/**
 * Check if a channel is a Direct Message (1:1).
 */
export function isDirectMessage(channel: MattermostChannel): boolean {
  return channel.type === 'D'
}

/**
 * Check if a channel is a Direct Message by type string alone.
 */
export function isDirectMessageType(channelType: string): boolean {
  return channelType === 'D'
}

/**
 * Check if a channel is a Group DM.
 */
export function isGroupMessage(channel: MattermostChannel): boolean {
  return channel.type === 'G'
}

/**
 * Check if a channel is a Group DM by type string alone.
 */
export function isGroupMessageType(channelType: string): boolean {
  return channelType === 'G'
}

/**
 * Check if a channel is a public or private team channel.
 */
export function isTeamChannel(channel: MattermostChannel): boolean {
  return channel.type === 'O' || channel.type === 'P'
}

/**
 * Check if a channel is a team channel by type string alone.
 */
export function isTeamChannelType(channelType: string): boolean {
  return channelType === 'O' || channelType === 'P'
}

/**
 * Determine if the bot should auto-respond (no trigger required).
 * - DMs (type D): always auto-respond
 * - Group DMs (type G): auto-respond (small group, usually intentional)
 * - Team channels (type O/P): require trigger or mention
 */
export function shouldAutoRespond(channelType: string): boolean {
  return channelType === 'D' || channelType === 'G'
}

/**
 * Check if a message mentions a specific user ID.
 * Accepts the parsed mentions array from the WS event.
 */
export function isMentioned(mentionedIds: string[], botUserId: string): boolean {
  return mentionedIds.includes(botUserId)
}

/**
 * Check if a message text contains a trigger phrase.
 */
export function containsTrigger(text: string, trigger: string): boolean {
  if (!trigger) return false
  return text.toLowerCase().includes(trigger.toLowerCase())
}

/**
 * Extract the message text with the trigger phrase stripped out.
 */
export function stripTrigger(text: string, trigger: string): string {
  if (!trigger) return text
  const idx = text.toLowerCase().indexOf(trigger.toLowerCase())
  if (idx === -1) return text
  return (text.slice(0, idx) + text.slice(idx + trigger.length)).trim()
}
