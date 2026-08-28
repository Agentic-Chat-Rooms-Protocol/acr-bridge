import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the plugin-sdk so client.ts can be imported without the real SDK
vi.mock('@openacp/plugin-sdk', () => ({
  createChildLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

import { SignalClient } from '../client.js'

// ── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeClient(overrides?: Partial<{ apiUrl: string; number: string; authHeader: string }>): SignalClient {
  return new SignalClient({
    apiUrl: overrides?.apiUrl ?? 'http://localhost:8080',
    number: overrides?.number ?? '+15551234567',
    authHeader: overrides?.authHeader,
  })
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status, headers: {} })
}

// ─── Health Check ────────────────────────────────────────────────────────────

describe('SignalClient.healthCheck', () => {
  it('returns ok: true when API is healthy', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ versions: { signal: '0.13.0' } }))
    const client = makeClient()
    const result = await client.healthCheck()
    expect(result.ok).toBe(true)
    expect(result.data?.versions).toEqual({ signal: '0.13.0' })
  })

  it('returns ok: false on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    const client = makeClient()
    const result = await client.healthCheck()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('returns ok: false on HTTP error', async () => {
    mockFetch.mockResolvedValue(new Response('Internal Server Error', { status: 500 }))
    const client = makeClient()
    const result = await client.healthCheck()
    expect(result.ok).toBe(false)
  })
})

// ─── Send Message ────────────────────────────────────────────────────────────

describe('SignalClient.sendMessage', () => {
  it('sends text message to recipient', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ timestamp: 1234567890 }))
    const client = makeClient()
    const result = await client.sendMessage('+15559876543', 'Hello!')
    expect(result.timestamp).toBe(1234567890)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toBe('http://localhost:8080/api/v2/send')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string)
    expect(body.message).toBe('Hello!')
    expect(body.recipients).toEqual(['+15559876543'])
    expect(body.number).toBe('+15551234567')
  })

  it('includes base64 attachments', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ timestamp: 123 }))
    const client = makeClient()
    await client.sendMessage('+1', 'File:', {
      attachments: ['data:image/png;base64,iVBOR...'],
    })

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(body.base64_attachments).toEqual(['data:image/png;base64,iVBOR...'])
  })

  it('includes quote parameters', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ timestamp: 123 }))
    const client = makeClient()
    await client.sendMessage('+1', 'Reply', {
      quoteTimestamp: 999,
      quoteAuthor: '+15559876543',
    })

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(body.quote_timestamp).toBe(999)
    expect(body.quote_author).toBe('+15559876543')
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValue(new Response('Bad Request', { status: 400, statusText: 'Bad Request' }))
    const client = makeClient()
    await expect(client.sendMessage('+1', 'fail')).rejects.toThrow('400')
  })
})

// ─── Send Group Message ──────────────────────────────────────────────────────

describe('SignalClient.sendGroupMessage', () => {
  it('sends message to group', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ timestamp: 456 }))
    const client = makeClient()
    const result = await client.sendGroupMessage('grp-abc', 'Hello group!')
    expect(result.timestamp).toBe(456)

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(body.group_id).toBe('grp-abc')
    expect(body.message).toBe('Hello group!')
  })
})

// ─── Typing Indicator ────────────────────────────────────────────────────────

describe('SignalClient.sendTypingIndicator', () => {
  it('sends typing indicator to recipient', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = makeClient()
    await client.sendTypingIndicator('+15559876543')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toContain('/api/v1/typing-indicator/')
    expect(opts.method).toBe('PUT')
    const body = JSON.parse(opts.body as string)
    expect(body.recipient).toBe('+15559876543')
  })
})

describe('SignalClient.sendGroupTypingIndicator', () => {
  it('sends typing indicator to group', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = makeClient()
    await client.sendGroupTypingIndicator('grp-xyz')

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(body.group_id).toBe('grp-xyz')
  })
})

// ─── Reactions ───────────────────────────────────────────────────────────────

describe('SignalClient.sendReaction', () => {
  it('sends reaction to a message', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = makeClient()
    await client.sendReaction('+1', '👍', '+15559876543', 1234567890)

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(url).toContain('/api/v1/reactions/')
    expect(opts.method).toBe('PUT')
    const body = JSON.parse(opts.body as string)
    expect(body.reaction).toBe('👍')
    expect(body.target_author).toBe('+15559876543')
    expect(body.target_timestamp).toBe(1234567890)
  })
})

describe('SignalClient.removeReaction', () => {
  it('removes reaction from a message', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = makeClient()
    await client.removeReaction('+1', '👍', '+15559876543', 1234567890)

    const [url, opts] = mockFetch.mock.calls[0]!
    expect(opts.method).toBe('DELETE')
  })
})

describe('SignalClient.sendGroupReaction', () => {
  it('sends reaction in a group', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = makeClient()
    await client.sendGroupReaction('grp-1', '❤️', '+1', 123)

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(body.group_id).toBe('grp-1')
    expect(body.reaction).toBe('❤️')
  })
})

// ─── Groups ──────────────────────────────────────────────────────────────────

describe('SignalClient.listGroups', () => {
  it('lists groups', async () => {
    mockFetch.mockResolvedValue(jsonResponse([
      { id: 'g1', name: 'Group One', isMember: true },
      { id: 'g2', name: 'Group Two', isMember: false },
    ]))
    const client = makeClient()
    const groups = await client.listGroups()
    expect(groups).toHaveLength(2)
    expect(groups[0]!.name).toBe('Group One')
  })
})

describe('SignalClient.getGroup', () => {
  it('fetches group metadata', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      id: 'g1',
      name: 'Test Group',
      members: ['+1', '+2'],
      admins: ['+1'],
    }))
    const client = makeClient()
    const group = await client.getGroup('g1')
    expect(group.name).toBe('Test Group')
    expect(group.members).toEqual(['+1', '+2'])
    expect(group.admins).toEqual(['+1'])
  })
})

// ─── Read Receipts ───────────────────────────────────────────────────────────

describe('SignalClient.sendReadReceipt', () => {
  it('sends read receipt', async () => {
    mockFetch.mockResolvedValue(emptyResponse())
    const client = makeClient()
    await client.sendReadReceipt('+1', [123, 456])

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(body.receipt_type).toBe('read')
    expect(body.timestamps).toEqual([123, 456])
  })
})

// ─── Auth Header ─────────────────────────────────────────────────────────────

describe('SignalClient auth header', () => {
  it('includes auth header when configured', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    const client = makeClient({ authHeader: 'Basic dXNlcjpwYXNz' })
    await client.healthCheck()

    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['Authorization']).toBe('Basic dXNlcjpwYXNz')
  })

  it('does not include auth header when not configured', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    const client = makeClient()
    await client.healthCheck()

    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
})

// ─── URL Construction ────────────────────────────────────────────────────────

describe('SignalClient URL construction', () => {
  it('strips trailing slashes from base URL', () => {
    const client = makeClient({ apiUrl: 'http://localhost:8080///' })
    expect(client.getBaseUrl()).toBe('http://localhost:8080')
  })

  it('builds correct SSE URL', () => {
    const client = makeClient()
    expect(client.getSseUrl()).toBe('http://localhost:8080/api/v1/receive/%2B15551234567')
  })

  it('returns the configured phone number', () => {
    const client = makeClient({ number: '+4915112345678' })
    expect(client.getNumber()).toBe('+4915112345678')
  })
})
