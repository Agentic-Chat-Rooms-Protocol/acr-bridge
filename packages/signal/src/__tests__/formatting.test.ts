import { describe, it, expect, vi } from 'vitest'

// Mock the plugin-sdk so transitive imports resolve without the real SDK
vi.mock('@openacp/plugin-sdk', () => ({
  createChildLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

import {
  escapePlainText,
  truncateText,
  formatPermissionRequest,
  formatNotification,
  formatError,
  formatModeChange,
  formatModelUpdate,
  formatConfigUpdate,
  splitMessage,
} from '../formatting.js'
import {
  formatToolCallPlain,
  formatToolUpdatePlain,
  formatThoughtPlain,
  formatPlanPlain,
  formatUsagePlain,
  formatErrorPlain,
  formatSessionEndPlain,
  formatNotificationPlain,
  splitPlainText,
} from '../low-fidelity.js'

// ─── escapePlainText ─────────────────────────────────────────────────────────

describe('escapePlainText', () => {
  it('returns empty string for null/undefined', () => {
    expect(escapePlainText(null)).toBe('')
    expect(escapePlainText(undefined)).toBe('')
    expect(escapePlainText('')).toBe('')
  })

  it('strips zero-width characters', () => {
    expect(escapePlainText('hello\u200Bworld')).toBe('helloworld')
    expect(escapePlainText('a\u200Cb\u200Dc\uFEFFd')).toBe('abcd')
  })

  it('normalizes line endings', () => {
    expect(escapePlainText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('passes through normal text', () => {
    expect(escapePlainText('Hello, World!')).toBe('Hello, World!')
  })
})

// ─── truncateText ────────────────────────────────────────────────────────────

describe('truncateText', () => {
  it('returns text as-is if under limit', () => {
    expect(truncateText('hello', 10)).toBe('hello')
  })

  it('truncates with ellipsis if over limit', () => {
    expect(truncateText('hello world', 8)).toBe('hello...')
  })

  it('handles exact limit length', () => {
    expect(truncateText('hello', 5)).toBe('hello')
  })
})

// ─── formatPermissionRequest ─────────────────────────────────────────────────

describe('formatPermissionRequest', () => {
  it('formats a permission request with numbered options', () => {
    const result = formatPermissionRequest('Allow file write?', [
      { id: 'allow', label: 'Yes, proceed', isAllow: true },
      { id: 'deny', label: 'No, cancel', isAllow: false },
    ])
    expect(result).toContain('Permission request:')
    expect(result).toContain('Allow file write?')
    expect(result).toContain('Reply 1 to Allow: Yes, proceed')
    expect(result).toContain('Reply 2 to Deny: No, cancel')
  })

  it('handles single option', () => {
    const result = formatPermissionRequest('Continue?', [
      { id: 'ok', label: 'OK', isAllow: true },
    ])
    expect(result).toContain('Reply 1 to Allow: OK')
  })
})

// ─── formatNotification ──────────────────────────────────────────────────────

describe('formatNotification', () => {
  it('formats completed notification with session name', () => {
    const result = formatNotification({
      type: 'completed',
      sessionName: 'Build task',
      summary: 'Build succeeded',
    })
    expect(result).toBe('[Completed] (Build task)\nBuild succeeded')
  })

  it('formats error notification without session name', () => {
    const result = formatNotification({
      type: 'error',
      summary: 'Something broke',
    })
    expect(result).toBe('[Error]\nSomething broke')
  })

  it('uses "Notification" for unknown types', () => {
    const result = formatNotification({
      type: 'custom',
      summary: 'Info',
    })
    expect(result).toBe('[Notification]\nInfo')
  })
})

// ─── Other formatting helpers ────────────────────────────────────────────────

describe('formatError', () => {
  it('prefixes with Error:', () => {
    expect(formatError('network timeout')).toBe('Error: network timeout')
  })
})

describe('formatModeChange', () => {
  it('formats mode change message', () => {
    expect(formatModeChange('code')).toBe('Mode changed: code')
  })
})

describe('formatModelUpdate', () => {
  it('formats model update message', () => {
    expect(formatModelUpdate('claude-4.5-haiku')).toBe('Model changed: claude-4.5-haiku')
  })
})

describe('formatConfigUpdate', () => {
  it('returns config update text', () => {
    expect(formatConfigUpdate()).toBe('Configuration updated')
  })
})

// ─── splitMessage ────────────────────────────────────────────────────────────

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello'])
  })

  it('splits at paragraph boundaries', () => {
    const text = 'First paragraph.\n\nSecond paragraph.'
    const chunks = splitMessage(text, 20)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe('First paragraph.')
    expect(chunks[1]).toBe('Second paragraph.')
  })

  it('splits at line breaks if no paragraph boundary', () => {
    const text = 'Line one\nLine two\nLine three'
    const chunks = splitMessage(text, 15)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toBe('Line one')
  })

  it('hard cuts if no break point found', () => {
    const longWord = 'a'.repeat(50)
    const chunks = splitMessage(longWord, 20)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.length).toBeLessThanOrEqual(20)
  })
})

// ─── Low-Fidelity Formatters ─────────────────────────────────────────────────

describe('formatToolCallPlain', () => {
  it('formats with tool kind icon and name', () => {
    const result = formatToolCallPlain({ name: 'Read', kind: 'read' })
    expect(result).toBe('-- Read')
  })

  it('uses displayTitle over name', () => {
    const result = formatToolCallPlain({ name: 'Read', displayTitle: 'Read config.ts' })
    expect(result).toBe('-- Read config.ts')
  })

  it('uses displaySummary when no displayTitle', () => {
    const result = formatToolCallPlain({ name: 'Read', displaySummary: 'Reading config' })
    expect(result).toBe('-- Reading config')
  })

  it('shows input at high verbosity', () => {
    const result = formatToolCallPlain(
      { name: 'Edit', kind: 'edit', rawInput: { file: 'test.ts' } },
      'high',
    )
    expect(result).toContain('>> Edit')
    expect(result).toContain('Input:')
    expect(result).toContain('test.ts')
  })

  it('hides input at medium verbosity', () => {
    const result = formatToolCallPlain(
      { name: 'Edit', kind: 'edit', rawInput: { file: 'test.ts' } },
      'medium',
    )
    expect(result).toBe('>> Edit')
  })

  it('uses fallback icon for unknown kind', () => {
    const result = formatToolCallPlain({ name: 'CustomTool', kind: 'custom' })
    expect(result).toBe('-- CustomTool')
  })
})

describe('formatToolUpdatePlain', () => {
  it('shows OK status for completed tools', () => {
    const result = formatToolUpdatePlain({ name: 'Read', status: 'completed' })
    expect(result).toBe('OK Read')
  })

  it('shows !! status for failed tools', () => {
    const result = formatToolUpdatePlain({ name: 'Write', status: 'error' })
    expect(result).toBe('!! Write')
  })

  it('shows .. status for in-progress tools', () => {
    const result = formatToolUpdatePlain({ name: 'Build', status: 'running' })
    expect(result).toBe('.. Build')
  })

  it('shows output at high verbosity', () => {
    const result = formatToolUpdatePlain(
      { name: 'Build', status: 'completed', content: 'Built in 2.5s' },
      'high',
    )
    expect(result).toContain('Output: Built in 2.5s')
  })
})

describe('formatThoughtPlain', () => {
  it('returns indicator at medium verbosity', () => {
    expect(formatThoughtPlain('I need to read the file', 'medium')).toBe('[Thinking...]')
  })

  it('returns truncated thought at high verbosity', () => {
    const result = formatThoughtPlain('Analyzing the code structure', 'high')
    expect(result).toBe('[Thinking] Analyzing the code structure')
  })

  it('truncates long thoughts at high verbosity', () => {
    const longThought = 'x'.repeat(600)
    const result = formatThoughtPlain(longThought, 'high')
    expect(result.length).toBeLessThan(520)
    expect(result).toContain('...')
  })
})

describe('formatPlanPlain', () => {
  it('renders empty plan', () => {
    expect(formatPlanPlain([])).toBe('Plan: (empty)')
  })

  it('renders plan with status markers', () => {
    const result = formatPlanPlain([
      { content: 'Read files', status: 'completed' },
      { content: 'Write code', status: 'in_progress' },
      { content: 'Test', status: 'pending' },
    ])
    expect(result).toContain('[x] 1. Read files')
    expect(result).toContain('[~] 2. Write code')
    expect(result).toContain('[ ] 3. Test')
  })
})

describe('formatUsagePlain', () => {
  it('formats usage with tokens and context size', () => {
    const result = formatUsagePlain({ tokensUsed: 28000, contextSize: 200000 })
    expect(result).toBe('Usage: 28k / 200k tokens (14%)')
  })

  it('shows warning at 85%+', () => {
    const result = formatUsagePlain({ tokensUsed: 85000, contextSize: 100000 })
    expect(result).toContain('(!)')
  })

  it('shows only tokens when no context size', () => {
    const result = formatUsagePlain({ tokensUsed: 5000 })
    expect(result).toBe('Usage: 5k tokens')
  })

  it('shows placeholder when no data', () => {
    expect(formatUsagePlain({})).toBe('Usage: data unavailable')
  })

  it('handles small token counts without k suffix', () => {
    const result = formatUsagePlain({ tokensUsed: 500, contextSize: 1000 })
    expect(result).toBe('Usage: 500 / 1k tokens (50%)')
  })

  it('handles M suffix for large counts', () => {
    const result = formatUsagePlain({ tokensUsed: 1500000, contextSize: 2000000 })
    expect(result).toContain('1.5M')
    expect(result).toContain('2.0M')
  })
})

describe('formatErrorPlain', () => {
  it('formats error message', () => {
    expect(formatErrorPlain('network timeout')).toBe('Error: network timeout')
  })
})

describe('formatSessionEndPlain', () => {
  it('formats session end message', () => {
    expect(formatSessionEndPlain('completed')).toBe('Session ended: completed')
  })

  it('uses fallback for empty text', () => {
    expect(formatSessionEndPlain('')).toBe('Session ended: completed')
  })
})

describe('formatNotificationPlain', () => {
  it('formats notification with type label', () => {
    const result = formatNotificationPlain({
      type: 'completed',
      sessionName: 'Build',
      summary: 'Build succeeded',
    })
    expect(result).toBe('[Done] Build: Build succeeded')
  })

  it('uses Session as default name', () => {
    const result = formatNotificationPlain({
      type: 'error',
      summary: 'Failed',
    })
    expect(result).toBe('[Error] Session: Failed')
  })
})

// ─── splitPlainText ──────────────────────────────────────────────────────────

describe('splitPlainText', () => {
  it('returns single chunk for short text', () => {
    expect(splitPlainText('hello', 100)).toEqual(['hello'])
  })

  it('splits at paragraph boundaries', () => {
    const text = 'A'.repeat(30) + '\n\n' + 'B'.repeat(30)
    const chunks = splitPlainText(text, 35)
    expect(chunks.length).toBe(2)
  })

  it('hard cuts when no break point exists', () => {
    const text = 'x'.repeat(100)
    const chunks = splitPlainText(text, 40)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40)
    }
  })
})
