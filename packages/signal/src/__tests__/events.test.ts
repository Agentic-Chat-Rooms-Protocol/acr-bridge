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

import {
  parseSseChunk,
  parseEnvelopeData,
  extractSessionKey,
  isGroupMessage,
  extractSenderName,
  extractSenderId,
  computeBackoff,
} from '../events.js'
import type { SignalEnvelope } from '../types.js'
import { DEFAULT_RECONNECT_CONFIG } from '../types.js'

// ─── parseSseChunk ───────────────────────────────────────────────────────────

describe('parseSseChunk', () => {
  it('parses a single SSE event', () => {
    const chunk = 'event: message\ndata: {"envelope":{"source":"+1"}}\n\n'
    const frames = parseSseChunk(chunk)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.event).toBe('message')
    expect(frames[0]!.data).toBe('{"envelope":{"source":"+1"}}')
  })

  it('parses multiple SSE events', () => {
    const chunk = 'data: {"a":1}\n\ndata: {"b":2}\n\n'
    const frames = parseSseChunk(chunk)
    expect(frames).toHaveLength(2)
    expect(frames[0]!.data).toBe('{"a":1}')
    expect(frames[1]!.data).toBe('{"b":2}')
  })

  it('handles multi-line data fields', () => {
    const chunk = 'data: line1\ndata: line2\n\n'
    const frames = parseSseChunk(chunk)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.data).toBe('line1\nline2')
  })

  it('ignores comment lines', () => {
    const chunk = ': this is a comment\ndata: hello\n\n'
    const frames = parseSseChunk(chunk)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.data).toBe('hello')
  })

  it('handles carriage returns', () => {
    const chunk = 'data: hello\r\n\r\n'
    const frames = parseSseChunk(chunk)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.data).toBe('hello')
  })

  it('extracts event ID', () => {
    const chunk = 'id: 42\ndata: test\n\n'
    const frames = parseSseChunk(chunk)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.id).toBe('42')
    expect(frames[0]!.data).toBe('test')
  })

  it('returns empty array for empty input', () => {
    expect(parseSseChunk('')).toHaveLength(0)
    expect(parseSseChunk('\n')).toHaveLength(0)
  })

  it('handles data field with leading space after colon', () => {
    const chunk = 'data: hello\n\n'
    const frames = parseSseChunk(chunk)
    expect(frames[0]!.data).toBe('hello')
  })

  it('handles data field without leading space after colon', () => {
    const chunk = 'data:hello\n\n'
    const frames = parseSseChunk(chunk)
    expect(frames[0]!.data).toBe('hello')
  })

  it('flushes remaining event without trailing blank line', () => {
    const chunk = 'data: trailing'
    const frames = parseSseChunk(chunk)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.data).toBe('trailing')
  })
})

// ─── parseEnvelopeData ───────────────────────────────────────────────────────

describe('parseEnvelopeData', () => {
  it('parses valid envelope data', () => {
    const data = JSON.stringify({
      envelope: {
        source: '+15551234567',
        sourceNumber: '+15551234567',
        timestamp: 1234567890000,
        dataMessage: { message: 'Hello', timestamp: 1234567890000 },
      },
    })
    const result = parseEnvelopeData(data)
    expect(result).not.toBeNull()
    expect(result!.envelope.source).toBe('+15551234567')
    expect(result!.envelope.dataMessage?.message).toBe('Hello')
  })

  it('extracts account field', () => {
    const data = JSON.stringify({
      envelope: { source: '+1', timestamp: 0 },
      account: '+15551234567',
    })
    const result = parseEnvelopeData(data)
    expect(result!.account).toBe('+15551234567')
  })

  it('returns null for invalid JSON', () => {
    expect(parseEnvelopeData('not json')).toBeNull()
  })

  it('returns null for missing envelope', () => {
    expect(parseEnvelopeData('{"foo":"bar"}')).toBeNull()
  })

  it('returns null for non-object envelope', () => {
    expect(parseEnvelopeData('{"envelope":"string"}')).toBeNull()
  })
})

// ─── extractSessionKey ───────────────────────────────────────────────────────

describe('extractSessionKey', () => {
  it('returns group key for group messages', () => {
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

  it('falls back to source if sourceNumber is absent', () => {
    const envelope: SignalEnvelope = {
      source: '+15559876543',
      timestamp: 0,
      dataMessage: { timestamp: 0, message: 'hi' },
    }
    expect(extractSessionKey(envelope)).toBe('+15559876543')
  })

  it('returns null for envelope without identifiers', () => {
    const envelope = { timestamp: 0 } as SignalEnvelope
    expect(extractSessionKey(envelope)).toBeNull()
  })
})

// ─── isGroupMessage ──────────────────────────────────────────────────────────

describe('isGroupMessage', () => {
  it('returns true for group messages', () => {
    const envelope: SignalEnvelope = {
      source: '+1',
      timestamp: 0,
      dataMessage: {
        timestamp: 0,
        groupInfo: { groupId: 'grp1' },
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

  it('returns false for envelopes without dataMessage', () => {
    const envelope: SignalEnvelope = {
      source: '+1',
      timestamp: 0,
    }
    expect(isGroupMessage(envelope)).toBe(false)
  })
})

// ─── extractSenderName ───────────────────────────────────────────────────────

describe('extractSenderName', () => {
  it('prefers sourceName', () => {
    const envelope: SignalEnvelope = {
      source: '+1',
      sourceNumber: '+15551234567',
      sourceName: 'Alice',
      timestamp: 0,
    }
    expect(extractSenderName(envelope)).toBe('Alice')
  })

  it('falls back to sourceNumber', () => {
    const envelope: SignalEnvelope = {
      source: '+15551234567',
      sourceNumber: '+15551234567',
      timestamp: 0,
    }
    expect(extractSenderName(envelope)).toBe('+15551234567')
  })

  it('falls back to source', () => {
    const envelope: SignalEnvelope = {
      source: 'uuid-123',
      timestamp: 0,
    }
    expect(extractSenderName(envelope)).toBe('uuid-123')
  })

  it('returns Unknown for empty envelope', () => {
    const envelope = { timestamp: 0 } as SignalEnvelope
    expect(extractSenderName(envelope)).toBe('Unknown')
  })
})

// ─── extractSenderId ─────────────────────────────────────────────────────────

describe('extractSenderId', () => {
  it('prefers sourceNumber', () => {
    const envelope: SignalEnvelope = {
      source: 'src',
      sourceNumber: '+15551234567',
      sourceUuid: 'uuid-abc',
      timestamp: 0,
    }
    expect(extractSenderId(envelope)).toBe('+15551234567')
  })

  it('falls back to sourceUuid', () => {
    const envelope: SignalEnvelope = {
      source: 'src',
      sourceUuid: 'uuid-abc',
      timestamp: 0,
    }
    expect(extractSenderId(envelope)).toBe('uuid-abc')
  })

  it('falls back to source', () => {
    const envelope: SignalEnvelope = {
      source: 'fallback',
      timestamp: 0,
    }
    expect(extractSenderId(envelope)).toBe('fallback')
  })

  it('returns empty string for empty envelope', () => {
    const envelope = { timestamp: 0 } as SignalEnvelope
    expect(extractSenderId(envelope)).toBe('')
  })
})

// ─── computeBackoff ──────────────────────────────────────────────────────────

describe('computeBackoff', () => {
  it('returns at least 500ms', () => {
    const delay = computeBackoff(DEFAULT_RECONNECT_CONFIG, 0)
    expect(delay).toBeGreaterThanOrEqual(500)
  })

  it('increases with attempt number', () => {
    const delay0 = computeBackoff({ ...DEFAULT_RECONNECT_CONFIG, jitter: 0 }, 0)
    const delay3 = computeBackoff({ ...DEFAULT_RECONNECT_CONFIG, jitter: 0 }, 3)
    expect(delay3).toBeGreaterThan(delay0)
  })

  it('caps at maxDelayMs', () => {
    const config = { ...DEFAULT_RECONNECT_CONFIG, jitter: 0, maxDelayMs: 5000 }
    const delay = computeBackoff(config, 100)
    expect(delay).toBeLessThanOrEqual(5000)
  })

  it('applies jitter within expected range', () => {
    const config = { ...DEFAULT_RECONNECT_CONFIG, jitter: 0.5 }
    const delays = new Set<number>()
    for (let i = 0; i < 20; i++) {
      delays.add(computeBackoff(config, 2))
    }
    // With 50% jitter, we should see variation
    expect(delays.size).toBeGreaterThan(1)
  })
})
