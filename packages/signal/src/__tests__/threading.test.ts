import { describe, it, expect, vi } from 'vitest'

// Mock the plugin-sdk so events.ts can be imported without the real SDK
vi.mock('@openacp/plugin-sdk', () => ({
  createChildLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

import { extractSessionKey, isGroupMessage } from '../threading.js'
import type { SignalEnvelope } from '../types.js'

// ─── extractSessionKey (via threading re-export) ────────────────────────────

describe('threading: extractSessionKey', () => {
  it('returns "group:<id>" for group messages', () => {
    const envelope: SignalEnvelope = {
      source: '+15551234567',
      timestamp: 0,
      dataMessage: {
        timestamp: 0,
        groupInfo: { groupId: 'abc123' },
      },
    }
    expect(extractSessionKey(envelope)).toBe('group:abc123')
  })

  it('returns phone number for 1:1 messages', () => {
    const envelope: SignalEnvelope = {
      source: '+15551234567',
      sourceNumber: '+15551234567',
      timestamp: 0,
      dataMessage: { timestamp: 0, message: 'hello' },
    }
    expect(extractSessionKey(envelope)).toBe('+15551234567')
  })

  it('returns null when no identifiers present', () => {
    const envelope = { timestamp: 0 } as SignalEnvelope
    expect(extractSessionKey(envelope)).toBeNull()
  })

  it('prefers group key over phone number', () => {
    const envelope: SignalEnvelope = {
      source: '+15551234567',
      sourceNumber: '+15551234567',
      timestamp: 0,
      dataMessage: {
        timestamp: 0,
        message: 'hi group',
        groupInfo: { groupId: 'grp-xyz' },
      },
    }
    expect(extractSessionKey(envelope)).toBe('group:grp-xyz')
  })
})

// ─── isGroupMessage (via threading re-export) ───────────────────────────────

describe('threading: isGroupMessage', () => {
  it('returns true when groupInfo is present', () => {
    const envelope: SignalEnvelope = {
      source: '+1',
      timestamp: 0,
      dataMessage: {
        timestamp: 0,
        groupInfo: { groupId: 'g1' },
      },
    }
    expect(isGroupMessage(envelope)).toBe(true)
  })

  it('returns false for 1:1 messages', () => {
    const envelope: SignalEnvelope = {
      source: '+1',
      timestamp: 0,
      dataMessage: { timestamp: 0, message: 'hi' },
    }
    expect(isGroupMessage(envelope)).toBe(false)
  })

  it('returns false when no dataMessage', () => {
    const envelope: SignalEnvelope = {
      source: '+1',
      timestamp: 0,
    }
    expect(isGroupMessage(envelope)).toBe(false)
  })
})
