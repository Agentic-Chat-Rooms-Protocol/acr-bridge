import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Conformance tests for the WhatsApp adapter.
 *
 * Since the adapter depends on Baileys (which requires auth state),
 * we test against a minimal mock that satisfies the IChannelAdapter contract.
 * This mirrors the Telegram conformance pattern: a TestAdapter subclass
 * that stubs all platform-specific operations.
 */

// Mock the Baileys import so the adapter module loads without the real dependency
vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
  }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: { loggedOut: 401, connectionReplaced: 440, multideviceMismatch: 411 },
  downloadMediaMessage: vi.fn(),
}))

// Mock plugin-sdk logger
vi.mock('@openacp/plugin-sdk', async () => {
  const actual = {} as Record<string, unknown>
  return {
    ...actual,
    createChildLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    MessagingAdapter: class {
      constructor(_core: unknown, _config: unknown) {}
      async sendMessage(sessionId: string, content: { type: string; text: string; metadata?: unknown }) {
        // Dispatch to handler based on type — mirrors real MessagingAdapter
        const type = content.type
        const handler = (this as Record<string, unknown>)[`handle${capitalize(type)}`]
        if (typeof handler === 'function') {
          await (handler as Function).call(this, sessionId, content, 'medium')
        }
      }
    },
    SendQueue: class {
      constructor() {}
      async enqueue(fn: () => Promise<unknown>) { return fn() }
      clear() {}
    },
    BaseRenderer: class {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }
})

function capitalize(s: string): string {
  if (s === 'tool_call') return 'ToolCall'
  if (s === 'tool_update') return 'ToolUpdate'
  if (s === 'session_end') return 'SessionEnd'
  if (s === 'mode_change') return 'ModeChange'
  if (s === 'config_update') return 'ConfigUpdate'
  if (s === 'model_update') return 'ModelUpdate'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

import { WhatsAppAdapter } from '../adapter.js'
import { WhatsAppRenderer } from '../renderer.js'

function createTestAdapter() {
  const adapter = new WhatsAppAdapter(
    { configManager: { get: () => ({}) } },
    {
      enabled: true,
      maxMessageLength: 4000,
      authDir: '/tmp/test-wa-auth',
    },
  )
  return adapter
}

describe('WhatsApp adapter conformance', () => {
  let adapter: WhatsAppAdapter

  beforeEach(() => {
    adapter = createTestAdapter()
  })

  it('has the name "whatsapp"', () => {
    expect(adapter.name).toBe('whatsapp')
  })

  it('declares all 6 capability fields', () => {
    const caps = adapter.capabilities
    expect(typeof caps.streaming).toBe('boolean')
    expect(typeof caps.richFormatting).toBe('boolean')
    expect(typeof caps.threads).toBe('boolean')
    expect(typeof caps.reactions).toBe('boolean')
    expect(typeof caps.fileUpload).toBe('boolean')
    expect(typeof caps.voice).toBe('boolean')
  })

  it('streaming is false (no message editing)', () => {
    expect(adapter.capabilities.streaming).toBe(false)
  })

  it('richFormatting is false (limited formatting)', () => {
    expect(adapter.capabilities.richFormatting).toBe(false)
  })

  it('threads is false (no native threads)', () => {
    expect(adapter.capabilities.threads).toBe(false)
  })

  it('reactions is true', () => {
    expect(adapter.capabilities.reactions).toBe(true)
  })

  it('fileUpload is true', () => {
    expect(adapter.capabilities.fileUpload).toBe(true)
  })

  it('voice is true', () => {
    expect(adapter.capabilities.voice).toBe(true)
  })

  it('has a renderer instance', () => {
    expect(adapter.renderer).toBeDefined()
    expect(adapter.renderer).toBeInstanceOf(WhatsAppRenderer)
  })

  it('createSessionThread returns sessionId (no threads)', async () => {
    const threadId = await adapter.createSessionThread('chat@s.whatsapp.net', 'Test Session')
    expect(threadId).toBe('chat@s.whatsapp.net')
  })

  it('renameSessionThread is a no-op', async () => {
    await expect(
      adapter.renameSessionThread('session-1', 'New Name'),
    ).resolves.not.toThrow()
  })

  it('cleanupSessionState does not throw', async () => {
    await expect(
      adapter.cleanupSessionState('session-1'),
    ).resolves.not.toThrow()
  })

  it('sendNotification does not throw for unknown session', async () => {
    await expect(
      adapter.sendNotification({
        sessionId: 'unknown',
        type: 'completed',
        summary: 'done',
      }),
    ).resolves.not.toThrow()
  })

  it('sendPermissionRequest does not throw for unknown session', async () => {
    await expect(
      adapter.sendPermissionRequest('unknown', {
        id: 'req-1',
        description: 'Allow read?',
        options: [
          { id: 'allow', label: 'Allow', isAllow: true },
          { id: 'deny', label: 'Deny', isAllow: false },
        ],
      }),
    ).resolves.not.toThrow()
  })
})
