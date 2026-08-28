/**
 * Adapter conformance tests for @openacp/signal-adapter.
 *
 * These tests verify that SignalAdapter satisfies the IChannelAdapter contract.
 * They can run standalone (without @openacp/plugin-sdk) because the adapter
 * extends MessagingAdapter which provides the default handler dispatching.
 *
 * When the SDK is not available (e.g. CI without full workspace link),
 * this file gracefully skips via the try/catch import guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the plugin-sdk module so tests can run without the real SDK
vi.mock('@openacp/plugin-sdk', () => {
  class MockMessagingAdapter {
    readonly context: Record<string, unknown>
    constructor(context: unknown, _config: unknown) {
      this.context = (context ?? {}) as Record<string, unknown>
    }
    async sendMessage(sessionId: string, content: Record<string, unknown>): Promise<void> {
      const type = content['type'] as string
      const handler = (this as Record<string, unknown>)[`handle${capitalize(type)}`]
      if (typeof handler === 'function') {
        await (handler as Function).call(this, sessionId, content, 'medium')
      }
    }
  }

  class MockBaseRenderer {
    renderToolCall() { return { body: '', format: 'plain' } }
    renderToolUpdate() { return { body: '', format: 'plain' } }
    renderThought() { return { body: '', format: 'plain' } }
    renderPlan() { return { body: '', format: 'plain' } }
    renderUsage() { return { body: '', format: 'plain' } }
    renderError() { return { body: '', format: 'plain' } }
    renderNotification() { return { body: '', format: 'plain' } }
    renderSystemMessage() { return { body: '', format: 'plain' } }
    renderSessionEnd() { return { body: '', format: 'plain' } }
    renderModeChange() { return { body: '', format: 'plain' } }
    renderConfigUpdate() { return { body: '', format: 'plain' } }
    renderModelUpdate() { return { body: '', format: 'plain' } }
  }

  class MockSendQueue {
    constructor(_opts?: unknown) {}
    async enqueue(fn: () => Promise<unknown>): Promise<unknown> { return fn() }
    onRateLimited() {}
    clear() {}
  }

  function capitalize(s: string): string {
    if (!s) return s
    // Convert snake_case types to PascalCase handler names
    return s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
  }

  return {
    MessagingAdapter: MockMessagingAdapter,
    BaseRenderer: MockBaseRenderer,
    SendQueue: MockSendQueue,
    createChildLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }
})

// Import after mocking
const { SignalAdapter } = await import('../adapter.js')
type SignalAdapterType = InstanceType<typeof SignalAdapter>

function makeAdapter(): SignalAdapterType {
  return new SignalAdapter({
    enabled: true,
    apiUrl: 'http://localhost:8080',
    number: '+15551234567',
    maxMessageLength: 4000,
    minSendInterval: 0,
  })
}

// ── Conformance Tests ────────────────────────────────────────────────────────

describe('IChannelAdapter conformance', () => {
  let adapter: SignalAdapterType

  beforeEach(() => {
    adapter = makeAdapter()
  })

  it('has a name', () => {
    expect(typeof adapter.name).toBe('string')
    expect(adapter.name).toBe('signal')
    expect(adapter.name.length).toBeGreaterThan(0)
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

  it('has correct capability values for Signal', () => {
    const caps = adapter.capabilities
    expect(caps.streaming).toBe(false)
    expect(caps.richFormatting).toBe(false)
    expect(caps.threads).toBe(false)
    expect(caps.reactions).toBe(true)
    expect(caps.fileUpload).toBe(true)
    expect(caps.voice).toBe(true)
  })

  it('sends text messages without error', async () => {
    await expect(
      adapter.sendMessage('test-session', { type: 'text', text: 'hello' }),
    ).resolves.not.toThrow()
  })

  it('sends tool_call messages without error', async () => {
    await expect(
      adapter.sendMessage('test-session', {
        type: 'tool_call',
        text: 'Read',
        metadata: { id: 't1', name: 'Read', kind: 'read' },
      }),
    ).resolves.not.toThrow()
  })

  it('sends usage messages without error', async () => {
    await expect(
      adapter.sendMessage('test-session', {
        type: 'usage',
        text: '',
        metadata: { tokensUsed: 1000, contextSize: 200000 },
      }),
    ).resolves.not.toThrow()
  })

  it('sends error messages without error', async () => {
    await expect(
      adapter.sendMessage('test-session', { type: 'error', text: 'something failed' }),
    ).resolves.not.toThrow()
  })

  it('handles session_end without error', async () => {
    await expect(
      adapter.sendMessage('test-session', { type: 'session_end', text: 'finished' }),
    ).resolves.not.toThrow()
  })

  it('handles unknown message types gracefully', async () => {
    await expect(
      adapter.sendMessage('test-session', { type: 'unknown_type' as never, text: '' }),
    ).resolves.not.toThrow()
  })

  it('sendNotification does not throw', async () => {
    await expect(
      adapter.sendNotification({
        sessionId: 'test',
        type: 'completed',
        summary: 'done',
      }),
    ).resolves.not.toThrow()
  })

  it('createSessionThread returns empty string (no threads in Signal)', async () => {
    const result = await adapter.createSessionThread('test-session', 'test name')
    expect(result).toBe('')
  })

  it('renameSessionThread is a no-op', async () => {
    await expect(
      adapter.renameSessionThread('test-session', 'new name'),
    ).resolves.not.toThrow()
  })

  it('cleanupSessionState does not throw', async () => {
    await expect(
      adapter.cleanupSessionState('test-session'),
    ).resolves.not.toThrow()
  })

  it('has a renderer instance', () => {
    expect(adapter.renderer).toBeDefined()
    expect(typeof adapter.renderer).toBe('object')
  })

  it('has sendPermissionRequest method', () => {
    expect(typeof adapter.sendPermissionRequest).toBe('function')
  })
})
