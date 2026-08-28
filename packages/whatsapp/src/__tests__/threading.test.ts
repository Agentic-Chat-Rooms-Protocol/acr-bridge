import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isGroupJid,
  isIndividualJid,
  extractSenderJid,
  extractChatJid,
  isAllowed,
  isGroupAdmin,
  deriveSessionId,
  GroupMetadataCache,
  GROUP_JID_SUFFIX,
  INDIVIDUAL_JID_SUFFIX,
} from '../threading.js'
import type { GroupMetadata, BaileysSocket } from '../client.js'

// Mock the logger
vi.mock('@openacp/plugin-sdk', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

describe('JID detection', () => {
  it('identifies group JIDs', () => {
    expect(isGroupJid('120363012345@g.us')).toBe(true)
    expect(isGroupJid('1234@s.whatsapp.net')).toBe(false)
    expect(isGroupJid('')).toBe(false)
  })

  it('identifies individual JIDs', () => {
    expect(isIndividualJid('1234@s.whatsapp.net')).toBe(true)
    expect(isIndividualJid('120363012345@g.us')).toBe(false)
    expect(isIndividualJid('')).toBe(false)
  })

  it('exports correct JID suffixes', () => {
    expect(GROUP_JID_SUFFIX).toBe('@g.us')
    expect(INDIVIDUAL_JID_SUFFIX).toBe('@s.whatsapp.net')
  })
})

describe('extractSenderJid', () => {
  it('returns participant for group messages', () => {
    const result = extractSenderJid({
      remoteJid: '120363012345@g.us',
      participant: '1234@s.whatsapp.net',
    })
    expect(result).toBe('1234@s.whatsapp.net')
  })

  it('returns remoteJid for 1:1 messages', () => {
    const result = extractSenderJid({
      remoteJid: '1234@s.whatsapp.net',
      participant: null,
    })
    expect(result).toBe('1234@s.whatsapp.net')
  })

  it('returns remoteJid when participant is missing in non-group', () => {
    const result = extractSenderJid({
      remoteJid: '1234@s.whatsapp.net',
    })
    expect(result).toBe('1234@s.whatsapp.net')
  })

  it('handles null remoteJid', () => {
    const result = extractSenderJid({ remoteJid: null })
    expect(result).toBe('')
  })

  it('handles undefined remoteJid', () => {
    const result = extractSenderJid({})
    expect(result).toBe('')
  })
})

describe('extractChatJid', () => {
  it('extracts chat JID from message key', () => {
    expect(extractChatJid({ remoteJid: '1234@s.whatsapp.net' })).toBe('1234@s.whatsapp.net')
  })

  it('extracts group JID', () => {
    expect(extractChatJid({ remoteJid: 'group@g.us' })).toBe('group@g.us')
  })

  it('handles null remoteJid', () => {
    expect(extractChatJid({ remoteJid: null })).toBe('')
  })
})

describe('isAllowed', () => {
  it('allows all when no allowlist', () => {
    expect(isAllowed('1234@s.whatsapp.net')).toBe(true)
    expect(isAllowed('1234@s.whatsapp.net', undefined)).toBe(true)
  })

  it('allows all when allowlist is empty', () => {
    expect(isAllowed('1234@s.whatsapp.net', [])).toBe(true)
  })

  it('allows JID in allowlist', () => {
    expect(isAllowed('1234@s.whatsapp.net', ['1234@s.whatsapp.net', 'group@g.us'])).toBe(true)
  })

  it('rejects JID not in allowlist', () => {
    expect(isAllowed('5678@s.whatsapp.net', ['1234@s.whatsapp.net'])).toBe(false)
  })

  it('supports group JIDs in allowlist', () => {
    expect(isAllowed('group@g.us', ['group@g.us'])).toBe(true)
  })
})

describe('isGroupAdmin', () => {
  const metadata: GroupMetadata = {
    id: 'group@g.us',
    subject: 'Test Group',
    participants: [
      { id: 'admin@s.whatsapp.net', admin: 'admin' },
      { id: 'superadmin@s.whatsapp.net', admin: 'superadmin' },
      { id: 'member@s.whatsapp.net', admin: null },
      { id: 'member2@s.whatsapp.net' },
    ],
  }

  it('identifies admin', () => {
    expect(isGroupAdmin('admin@s.whatsapp.net', metadata)).toBe(true)
  })

  it('identifies superadmin', () => {
    expect(isGroupAdmin('superadmin@s.whatsapp.net', metadata)).toBe(true)
  })

  it('identifies non-admin member', () => {
    expect(isGroupAdmin('member@s.whatsapp.net', metadata)).toBe(false)
  })

  it('identifies member without admin field', () => {
    expect(isGroupAdmin('member2@s.whatsapp.net', metadata)).toBe(false)
  })

  it('returns false for unknown participant', () => {
    expect(isGroupAdmin('unknown@s.whatsapp.net', metadata)).toBe(false)
  })
})

describe('deriveSessionId', () => {
  it('uses chatJid as session ID', () => {
    expect(deriveSessionId('1234@s.whatsapp.net')).toBe('1234@s.whatsapp.net')
  })

  it('uses group JID as session ID', () => {
    expect(deriveSessionId('group@g.us')).toBe('group@g.us')
  })
})

describe('GroupMetadataCache', () => {
  let cache: GroupMetadataCache
  let mockSock: BaileysSocket

  const mockMetadata: GroupMetadata = {
    id: 'group@g.us',
    subject: 'Test Group',
    participants: [{ id: '1234@s.whatsapp.net', admin: 'admin' }],
  }

  beforeEach(() => {
    cache = new GroupMetadataCache(5000) // 5s TTL
    mockSock = {
      groupMetadata: vi.fn().mockResolvedValue(mockMetadata),
    } as unknown as BaileysSocket
  })

  it('fetches metadata on first call', async () => {
    const result = await cache.get('group@g.us', mockSock)
    expect(result).toEqual(mockMetadata)
    expect(mockSock.groupMetadata).toHaveBeenCalledWith('group@g.us')
  })

  it('returns cached metadata on second call', async () => {
    await cache.get('group@g.us', mockSock)
    await cache.get('group@g.us', mockSock)
    expect(mockSock.groupMetadata).toHaveBeenCalledTimes(1)
  })

  it('invalidates specific group', async () => {
    await cache.get('group@g.us', mockSock)
    cache.invalidate('group@g.us')
    await cache.get('group@g.us', mockSock)
    expect(mockSock.groupMetadata).toHaveBeenCalledTimes(2)
  })

  it('clears all cache', async () => {
    await cache.get('group@g.us', mockSock)
    cache.clear()
    await cache.get('group@g.us', mockSock)
    expect(mockSock.groupMetadata).toHaveBeenCalledTimes(2)
  })

  it('returns null when fetch fails and no cache', async () => {
    const failSock = {
      groupMetadata: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as BaileysSocket

    const result = await cache.get('group@g.us', failSock)
    expect(result).toBeNull()
  })

  it('returns stale cache when fetch fails', async () => {
    // First call succeeds
    await cache.get('group@g.us', mockSock)
    cache.invalidate('group@g.us')

    // Manually re-add expired entry
    ;(cache as unknown as { cache: Map<string, { data: GroupMetadata; fetchedAt: number }> })
      .cache.set('group@g.us', { data: mockMetadata, fetchedAt: 0 })

    // Second call with failing socket
    const failSock = {
      groupMetadata: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as BaileysSocket

    const result = await cache.get('group@g.us', failSock)
    expect(result).toEqual(mockMetadata)
  })
})
