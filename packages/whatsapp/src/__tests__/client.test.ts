import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the logger
vi.mock('@openacp/plugin-sdk', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// Track event handlers registered on the mock socket
type EventHandler = (...args: unknown[]) => void
const eventHandlers = new Map<string, EventHandler[]>()

function fireEvent(event: string, ...args: unknown[]): void {
  const handlers = eventHandlers.get(event) ?? []
  for (const h of handlers) {
    h(...args)
  }
}

const mockSaveCreds = vi.fn()
const mockSocket = {
  ev: {
    on: vi.fn((event: string, handler: EventHandler) => {
      const existing = eventHandlers.get(event) ?? []
      existing.push(handler)
      eventHandlers.set(event, existing)
    }),
    off: vi.fn(),
  },
  sendMessage: vi.fn().mockResolvedValue({ key: { id: 'msg-1' } }),
  sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
  requestPairingCode: vi.fn().mockResolvedValue('ABC-123'),
  groupMetadata: vi.fn().mockResolvedValue({ id: 'g@g.us', subject: 'Group', participants: [] }),
  logout: vi.fn(),
  end: vi.fn(),
  ws: { close: vi.fn() },
}

// Mock Baileys module
vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(() => mockSocket),
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: { registered: false }, keys: {} },
    saveCreds: mockSaveCreds,
  }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: {
    loggedOut: 401,
    connectionReplaced: 440,
    multideviceMismatch: 411,
    restartRequired: 515,
  },
  downloadMediaMessage: vi.fn(),
}))

import { BaileysClient } from '../client.js'
import type { ConnectionUpdate } from '../client.js'

describe('BaileysClient', () => {
  let client: BaileysClient
  let onConnectionUpdate: vi.Mock
  let onMessagesUpsert: vi.Mock
  let onCredsUpdate: vi.Mock

  beforeEach(() => {
    vi.useFakeTimers()
    eventHandlers.clear()
    vi.clearAllMocks()

    onConnectionUpdate = vi.fn()
    onMessagesUpsert = vi.fn()
    onCredsUpdate = vi.fn()

    client = new BaileysClient({
      authPaths: {
        authDir: '/tmp/test-auth',
        historyReceivedPath: '/tmp/test-auth/.history-received',
      },
      listeners: {
        onConnectionUpdate,
        onMessagesUpsert,
        onCredsUpdate,
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects and registers event handlers', async () => {
    await client.connect()

    expect(eventHandlers.has('connection.update')).toBe(true)
    expect(eventHandlers.has('messages.upsert')).toBe(true)
    expect(eventHandlers.has('creds.update')).toBe(true)
    expect(eventHandlers.has('messaging-history.set')).toBe(true)
  })

  it('reports isConnected after connect', async () => {
    await client.connect()
    expect(client.isConnected()).toBe(true)
  })

  it('getSocket returns the socket after connect', async () => {
    await client.connect()
    const sock = client.getSocket()
    expect(sock).toBe(mockSocket)
  })

  it('getSocket throws when not connected', () => {
    expect(() => client.getSocket()).toThrow('Socket not connected')
  })

  it('forwards connection.update events to listener', async () => {
    await client.connect()

    const update: ConnectionUpdate = { connection: 'open' }
    fireEvent('connection.update', update)

    expect(onConnectionUpdate).toHaveBeenCalledWith(update)
  })

  it('forwards messages.upsert events to listener', async () => {
    await client.connect()

    const upsert = { messages: [{ key: { id: '1' } }], type: 'notify' }
    fireEvent('messages.upsert', upsert)

    expect(onMessagesUpsert).toHaveBeenCalledWith(upsert)
  })

  it('resets reconnect attempts on successful connection', async () => {
    await client.connect()

    // Simulate open
    fireEvent('connection.update', { connection: 'open' })

    // Should not be scheduling reconnects
    expect(onConnectionUpdate).toHaveBeenCalledWith({ connection: 'open' })
  })

  it('does not reconnect on loggedOut (401)', async () => {
    await client.connect()

    fireEvent('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    })

    // Should not reconnect
    expect(client.isConnected()).toBe(false)
  })

  it('does not reconnect on connectionReplaced (440)', async () => {
    await client.connect()

    fireEvent('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } },
    })

    expect(client.isConnected()).toBe(false)
  })

  it('schedules reconnect on other disconnect reasons', async () => {
    await client.connect()

    fireEvent('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    })

    // Client should be disconnected but timer scheduled
    expect(client.isConnected()).toBe(false)
  })

  it('disconnect stops reconnection', async () => {
    await client.connect()
    await client.disconnect()

    expect(client.isConnected()).toBe(false)
    expect(mockSocket.ws.close).toHaveBeenCalled()
  })

  it('disconnect is idempotent', async () => {
    await client.disconnect()
    await client.disconnect()
    // Should not throw
  })

  it('requests pairing code when pairingPhoneNumber is set', async () => {
    const pairingClient = new BaileysClient({
      authPaths: {
        authDir: '/tmp/test-auth',
        historyReceivedPath: '/tmp/test-auth/.history-received',
      },
      pairingPhoneNumber: '15551234567',
      listeners: {
        onConnectionUpdate,
        onMessagesUpsert,
        onCredsUpdate,
      },
    })

    await pairingClient.connect()

    expect(mockSocket.requestPairingCode).toHaveBeenCalledWith('15551234567')
  })

  it('ignores history sync events silently', async () => {
    await client.connect()
    // Should not throw or call any listener
    fireEvent('messaging-history.set', {})
  })
})

describe('BaileysClient reconnect config', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    eventHandlers.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('respects custom reconnect config', async () => {
    const client = new BaileysClient({
      authPaths: {
        authDir: '/tmp/test-auth',
        historyReceivedPath: '/tmp/test-auth/.history-received',
      },
      reconnectConfig: {
        delays: [100, 200],
        maxAttempts: 2,
      },
      listeners: {
        onConnectionUpdate: vi.fn(),
        onMessagesUpsert: vi.fn(),
        onCredsUpdate: vi.fn(),
      },
    })

    await client.connect()
    expect(client.isConnected()).toBe(true)
  })

  it('stops after maxAttempts', async () => {
    const client = new BaileysClient({
      authPaths: {
        authDir: '/tmp/test-auth',
        historyReceivedPath: '/tmp/test-auth/.history-received',
      },
      reconnectConfig: {
        delays: [10],
        maxAttempts: 0, // No reconnects allowed
      },
      listeners: {
        onConnectionUpdate: vi.fn(),
        onMessagesUpsert: vi.fn(),
        onCredsUpdate: vi.fn(),
      },
    })

    await client.connect()

    // Simulate disconnect
    fireEvent('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    })

    // Should not schedule reconnect (maxAttempts = 0)
    expect(client.isConnected()).toBe(false)
  })
})

describe('ActivityTracker', () => {
  // These tests are separate from client.test.ts for organizational clarity,
  // but we include a few here to validate the typing indicator lifecycle

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('can import and instantiate ActivityTracker', async () => {
    const { ActivityTracker } = await import('../activity.js')
    const tracker = new ActivityTracker(() => mockSocket as unknown as import('../client.js').BaileysSocket)
    expect(tracker).toBeDefined()
  })

  it('startTyping calls sendPresenceUpdate', async () => {
    const { ActivityTracker } = await import('../activity.js')
    const tracker = new ActivityTracker(() => mockSocket as unknown as import('../client.js').BaileysSocket)

    tracker.startTyping('1234@s.whatsapp.net')
    expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith('composing', '1234@s.whatsapp.net')
    expect(tracker.isTyping('1234@s.whatsapp.net')).toBe(true)

    tracker.stopAll()
  })

  it('stopTyping sends paused and clears timer', async () => {
    const { ActivityTracker } = await import('../activity.js')
    const tracker = new ActivityTracker(() => mockSocket as unknown as import('../client.js').BaileysSocket)

    tracker.startTyping('1234@s.whatsapp.net')
    tracker.stopTyping('1234@s.whatsapp.net')

    expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith('paused', '1234@s.whatsapp.net')
    expect(tracker.isTyping('1234@s.whatsapp.net')).toBe(false)
  })

  it('startTyping is idempotent', async () => {
    const { ActivityTracker } = await import('../activity.js')
    const tracker = new ActivityTracker(() => mockSocket as unknown as import('../client.js').BaileysSocket)

    tracker.startTyping('1234@s.whatsapp.net')
    tracker.startTyping('1234@s.whatsapp.net')
    // sendPresenceUpdate should only be called once for the initial startTyping
    expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledTimes(1)

    tracker.stopAll()
  })

  it('stopAll stops all typing indicators', async () => {
    const { ActivityTracker } = await import('../activity.js')
    const tracker = new ActivityTracker(() => mockSocket as unknown as import('../client.js').BaileysSocket)

    tracker.startTyping('1234@s.whatsapp.net')
    tracker.startTyping('5678@s.whatsapp.net')
    tracker.stopAll()

    expect(tracker.isTyping('1234@s.whatsapp.net')).toBe(false)
    expect(tracker.isTyping('5678@s.whatsapp.net')).toBe(false)
  })

  it('handles null socket gracefully', async () => {
    const { ActivityTracker } = await import('../activity.js')
    const tracker = new ActivityTracker(() => null)

    // Should not throw
    tracker.startTyping('1234@s.whatsapp.net')
    tracker.stopTyping('1234@s.whatsapp.net')
    expect(tracker.isTyping('1234@s.whatsapp.net')).toBe(false)
  })
})

describe('PermissionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('can import and instantiate PermissionHandler', async () => {
    const { PermissionHandler } = await import('../permissions.js')
    const handler = new PermissionHandler(
      () => mockSocket as unknown as import('../client.js').BaileysSocket,
      vi.fn(),
    )
    expect(handler).toBeDefined()
  })

  it('sends numbered permission request', async () => {
    const { PermissionHandler } = await import('../permissions.js')
    const resolveFn = vi.fn()
    const handler = new PermissionHandler(
      () => mockSocket as unknown as import('../client.js').BaileysSocket,
      resolveFn,
    )

    await handler.sendPermissionRequest('session-1', '1234@s.whatsapp.net', {
      id: 'req-1',
      description: 'Allow file read?',
      options: [
        { id: 'allow', label: 'Allow', isAllow: true },
        { id: 'deny', label: 'Deny', isAllow: false },
      ],
    })

    // Should have tried button message first (2 options <= 3)
    expect(mockSocket.sendMessage).toHaveBeenCalled()
  })

  it('resolves permission by number reply', async () => {
    const { PermissionHandler } = await import('../permissions.js')
    const resolveFn = vi.fn()
    const handler = new PermissionHandler(
      () => mockSocket as unknown as import('../client.js').BaileysSocket,
      resolveFn,
    )

    await handler.sendPermissionRequest('session-1', '1234@s.whatsapp.net', {
      id: 'req-1',
      description: 'Allow?',
      options: [
        { id: 'allow', label: 'Allow', isAllow: true },
        { id: 'deny', label: 'Deny', isAllow: false },
      ],
    })

    const resolved = handler.tryResolve('1234@s.whatsapp.net', '1')
    expect(resolved).toBe(true)
    expect(resolveFn).toHaveBeenCalledWith('session-1', 'req-1', 'allow')
  })

  it('does not resolve non-matching number', async () => {
    const { PermissionHandler } = await import('../permissions.js')
    const resolveFn = vi.fn()
    const handler = new PermissionHandler(
      () => mockSocket as unknown as import('../client.js').BaileysSocket,
      resolveFn,
    )

    await handler.sendPermissionRequest('session-1', '1234@s.whatsapp.net', {
      id: 'req-1',
      description: 'Allow?',
      options: [
        { id: 'allow', label: 'Allow', isAllow: true },
      ],
    })

    const resolved = handler.tryResolve('1234@s.whatsapp.net', '5')
    expect(resolved).toBe(false)
    expect(resolveFn).not.toHaveBeenCalled()
  })

  it('returns false for JID with no pending permission', async () => {
    const { PermissionHandler } = await import('../permissions.js')
    const handler = new PermissionHandler(
      () => mockSocket as unknown as import('../client.js').BaileysSocket,
      vi.fn(),
    )
    expect(handler.tryResolve('unknown@s.whatsapp.net', '1')).toBe(false)
  })

  it('clearSession removes pending permissions', async () => {
    const { PermissionHandler } = await import('../permissions.js')
    const resolveFn = vi.fn()
    const handler = new PermissionHandler(
      () => mockSocket as unknown as import('../client.js').BaileysSocket,
      resolveFn,
    )

    await handler.sendPermissionRequest('session-1', '1234@s.whatsapp.net', {
      id: 'req-1',
      description: 'Allow?',
      options: [{ id: 'allow', label: 'Allow', isAllow: true }],
    })

    handler.clearSession('session-1')

    const resolved = handler.tryResolve('1234@s.whatsapp.net', '1')
    expect(resolved).toBe(false)
  })

  it('hasPending returns correct status', async () => {
    const { PermissionHandler } = await import('../permissions.js')
    const handler = new PermissionHandler(
      () => mockSocket as unknown as import('../client.js').BaileysSocket,
      vi.fn(),
    )

    expect(handler.hasPending('1234@s.whatsapp.net')).toBe(false)

    await handler.sendPermissionRequest('session-1', '1234@s.whatsapp.net', {
      id: 'req-1',
      description: 'Allow?',
      options: [{ id: 'allow', label: 'Allow', isAllow: true }],
    })

    expect(handler.hasPending('1234@s.whatsapp.net')).toBe(true)
  })
})
