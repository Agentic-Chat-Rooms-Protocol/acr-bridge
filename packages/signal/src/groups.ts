import { createChildLogger } from '@openacp/plugin-sdk'
import type { SignalClient, GroupEntry } from './client.js'
import type { SignalEnvelope } from './types.js'

const log = createChildLogger({ module: 'signal:groups' })

/**
 * Group membership cache with TTL-based expiry.
 * Avoids hammering the signal-cli-rest-api on every inbound group message.
 */
export class GroupCache {
  private cache = new Map<string, { entry: GroupEntry; expiresAt: number }>()
  private readonly ttlMs: number

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  get(groupId: string): GroupEntry | null {
    const cached = this.cache.get(groupId)
    if (!cached) return null
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(groupId)
      return null
    }
    return cached.entry
  }

  set(groupId: string, entry: GroupEntry): void {
    this.cache.set(groupId, {
      entry,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  invalidate(groupId: string): void {
    this.cache.delete(groupId)
  }

  clear(): void {
    this.cache.clear()
  }
}

/**
 * Group manager -- resolves group metadata and member information
 * via the signal-cli-rest-api.
 */
export class GroupManager {
  private readonly client: SignalClient
  private readonly cache: GroupCache

  constructor(client: SignalClient, cacheTtlMs?: number) {
    this.client = client
    this.cache = new GroupCache(cacheTtlMs)
  }

  /**
   * Resolve group metadata, using cache when available.
   */
  async getGroup(groupId: string): Promise<GroupEntry | null> {
    const cached = this.cache.get(groupId)
    if (cached) return cached

    try {
      const entry = await this.client.getGroup(groupId)
      this.cache.set(groupId, entry)
      return entry
    } catch (err) {
      log.warn({ err, groupId }, '[SIGNAL_GROUPS] Failed to fetch group metadata')
      return null
    }
  }

  /**
   * List all groups the account is a member of.
   */
  async listGroups(): Promise<GroupEntry[]> {
    try {
      const groups = await this.client.listGroups()
      for (const group of groups) {
        this.cache.set(group.id, group)
      }
      return groups
    } catch (err) {
      log.warn({ err }, '[SIGNAL_GROUPS] Failed to list groups')
      return []
    }
  }

  /**
   * Resolve the display name for a group.
   * Returns the group name or a fallback with the groupId prefix.
   */
  async resolveGroupName(groupId: string): Promise<string> {
    const group = await this.getGroup(groupId)
    return group?.name ?? `Group ${groupId.slice(0, 8)}...`
  }

  /**
   * Check if a sender is an admin of a group.
   */
  async isGroupAdmin(groupId: string, senderId: string): Promise<boolean> {
    const group = await this.getGroup(groupId)
    if (!group?.admins) return false
    return group.admins.includes(senderId)
  }

  /**
   * Check if a sender is a member of a group.
   */
  async isGroupMember(groupId: string, senderId: string): Promise<boolean> {
    const group = await this.getGroup(groupId)
    if (!group?.members) return false
    return group.members.includes(senderId)
  }

  /**
   * Invalidate cached metadata for a group.
   * Useful when group membership changes are detected.
   */
  invalidateGroup(groupId: string): void {
    this.cache.invalidate(groupId)
  }

  /** Clear all cached group data. */
  clearCache(): void {
    this.cache.clear()
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract group ID from an envelope, if present.
 */
export function extractGroupId(envelope: SignalEnvelope): string | null {
  return envelope.dataMessage?.groupInfo?.groupId ?? null
}

/**
 * Determine if an envelope represents a group message.
 */
export function isGroupEnvelope(envelope: SignalEnvelope): boolean {
  return !!envelope.dataMessage?.groupInfo?.groupId
}
