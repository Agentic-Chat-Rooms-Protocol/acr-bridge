/**
 * Adapter conformance tests — verify the MattermostAdapter satisfies
 * the IChannelAdapter contract from @openacp/plugin-sdk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MattermostAdapter } from '../adapter.js'

function makeCore(): Record<string, unknown> {
  return {
    configManager: {
      get: () => ({ defaultAgent: 'claude' }),
      resolveWorkspace: () => '/tmp/test',
    },
    sessionManager: {
      getSession: vi.fn(),
      getSessionRecord: vi.fn(),
      patchRecord: vi.fn().mockResolvedValue(undefined),
      listRecords: vi.fn().mockReturnValue([]),
    },
    eventBus: {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    },
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getOrResumeSession: vi.fn().mockResolvedValue(null),
    createSession: vi.fn().mockResolvedValue({ id: 'test-session', name: 'test' }),
    agentManager: {
      getAvailableAgents: vi.fn().mockReturnValue([]),
    },
    fileService: {},
  }
}

function makeConfig() {
  return {
    enabled: true,
    url: 'https://mm.example.com',
    token: 'test-token-12345',
    channelId: 'ch-001',
    maxMessageLength: 4000,
  }
}

describe('MattermostAdapter conformance', () => {
  let adapter: MattermostAdapter

  beforeEach(() => {
    const core = makeCore()
    adapter = new MattermostAdapter(core as never, makeConfig())
  })

  it('has the correct name', () => {
    expect(adapter.name).toBe('mattermost')
  })

  it('declares all 6 capability fields', () => {
    const caps = adapter.capabilities
    expect(caps).toHaveProperty('streaming')
    expect(caps).toHaveProperty('richFormatting')
    expect(caps).toHaveProperty('threads')
    expect(caps).toHaveProperty('reactions')
    expect(caps).toHaveProperty('fileUpload')
    expect(caps).toHaveProperty('voice')
  })

  it('capabilities have correct values', () => {
    expect(adapter.capabilities.streaming).toBe(true)
    expect(adapter.capabilities.richFormatting).toBe(true)
    expect(adapter.capabilities.threads).toBe(true)
    expect(adapter.capabilities.reactions).toBe(true)
    expect(adapter.capabilities.fileUpload).toBe(true)
    expect(adapter.capabilities.voice).toBe(false)
  })

  it('has a renderer', () => {
    expect(adapter.renderer).toBeDefined()
    expect(typeof adapter.renderer.renderToolCall).toBe('function')
    expect(typeof adapter.renderer.renderToolUpdate).toBe('function')
    expect(typeof adapter.renderer.renderPlan).toBe('function')
    expect(typeof adapter.renderer.renderUsage).toBe('function')
    expect(typeof adapter.renderer.renderError).toBe('function')
    expect(typeof adapter.renderer.renderNotification).toBe('function')
    expect(typeof adapter.renderer.renderSystemMessage).toBe('function')
    expect(typeof adapter.renderer.renderModeChange).toBe('function')
    expect(typeof adapter.renderer.renderConfigUpdate).toBe('function')
    expect(typeof adapter.renderer.renderModelUpdate).toBe('function')
  })

  it('has start() and stop() methods', () => {
    expect(typeof adapter.start).toBe('function')
    expect(typeof adapter.stop).toBe('function')
  })

  it('has createSessionThread() method', () => {
    expect(typeof adapter.createSessionThread).toBe('function')
  })

  it('has renameSessionThread() method', () => {
    expect(typeof adapter.renameSessionThread).toBe('function')
  })

  it('has sendPermissionRequest() method', () => {
    expect(typeof adapter.sendPermissionRequest).toBe('function')
  })

  it('has sendNotification() method', () => {
    expect(typeof adapter.sendNotification).toBe('function')
  })

  it('extends MessagingAdapter', () => {
    // MessagingAdapter provides sendMessage() which dispatches to handlers
    expect(typeof adapter.sendMessage).toBe('function')
  })

  it('renderer produces markdown format', () => {
    const result = adapter.renderer.renderError({ text: 'test error', type: 'error' })
    expect(result.format).toBe('markdown')
  })

  it('renderer handles empty/missing text gracefully', () => {
    const result = adapter.renderer.renderSystemMessage({ text: '', type: 'system' })
    expect(result.body).toBe('')
    expect(result.format).toBe('markdown')
  })
})
