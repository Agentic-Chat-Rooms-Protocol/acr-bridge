import { createChildLogger } from '@openacp/plugin-sdk'
import type { BaileysSocket, GroupMetadata } from './client.js'

const log = createChildLogger({ module: 'whatsapp:threading' })

/** Group JID suffix for WhatsApp group chats. */
export const GROUP_JID_SUFFIX = '@g.us'

/** Individual JID suffix for WhatsApp 1:1 chats. */
export const INDIVIDUAL_JID_SUFFIX = '@s.whatsapp.net'

/**
 * Check whether a JID belongs to a group chat.
 */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith(GROUP_JID_SUFFIX)
}

/**
 * Check whether a JID belongs to a 1:1 chat.
 */
export function isIndividualJid(jid: string): boolean {
  return jid.endsWith(INDIVIDUAL_JID_SUFFIX)
}

/**
 * Extract the actual sender JID from a message.
 *
 * In group chats, `msg.key.participant` contains the sender.
 * In 1:1 chats, the sender is `msg.key.remoteJid`.
 */
export function extractSenderJid(messageKey: {
  remoteJid?: string | null
  participant?: string | null
  fromMe?: boolean
}): string {
  const chatJid = messageKey.remoteJid ?? ''
  if (isGroupJid(chatJid) && messageKey.participant) {
    return messageKey.participant
  }
  return chatJid
}

/**
 * Extract the chat JID from a message key.
 */
export function extractChatJid(messageKey: {
  remoteJid?: string | null
}): string {
  return messageKey.remoteJid ?? ''
}

/**
 * Cached group metadata to reduce API calls.
 */
export class GroupMetadataCache {
  private cache = new Map<string, { data: GroupMetadata; fetchedAt: number }>()
  private readonly ttlMs: number

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  /**
   * Get group metadata, fetching from the socket if not cached or expired.
   */
  async get(jid: string, sock: BaileysSocket): Promise<GroupMetadata | null> {
    const cached = this.cache.get(jid)
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.data
    }

    try {
      const data = await sock.groupMetadata(jid)
      this.cache.set(jid, { data, fetchedAt: Date.now() })
      return data
    } catch (err) {
      log.warn({ err, jid }, '[WHATSAPP_GROUPS] Failed to fetch group metadata')
      return cached?.data ?? null
    }
  }

  /** Clear all cached metadata. */
  clear(): void {
    this.cache.clear()
  }

  /** Remove a specific group from cache. */
  invalidate(jid: string): void {
    this.cache.delete(jid)
  }
}

/**
 * Check whether a JID is in the allowlist.
 *
 * If the allowlist is empty or undefined, all JIDs are allowed.
 * Supports both individual and group JIDs in the allowlist.
 */
export function isAllowed(jid: string, allowedJids?: string[]): boolean {
  if (!allowedJids || allowedJids.length === 0) return true
  return allowedJids.includes(jid)
}

/**
 * Check if a participant is an admin in a group.
 */
export function isGroupAdmin(
  participantJid: string,
  metadata: GroupMetadata,
): boolean {
  const participant = metadata.participants.find((p) => p.id === participantJid)
  return participant?.admin === 'admin' || participant?.admin === 'superadmin'
}

/**
 * Derive a session ID from a WhatsApp chat.
 *
 * WhatsApp has no threads — each chat (1:1 or group) is a single session.
 * The session ID is simply the chat JID.
 */
export function deriveSessionId(chatJid: string): string {
  return chatJid
}
