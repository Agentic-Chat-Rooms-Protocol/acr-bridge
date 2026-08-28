/**
 * Formatting tests — pure function tests for Mattermost markdown formatting.
 */

import { describe, it, expect } from 'vitest'
import {
  escapeMd,
  formatToolCall,
  formatToolUpdate,
  formatPlan,
  formatUsage,
  formatNotification,
  formatError,
  formatTokens,
  progressBar,
  splitMessage,
  truncateContent,
} from '../formatting.js'
import type { ToolCallMeta, ToolUpdateMeta } from '@openacp/plugin-sdk'

describe('escapeMd', () => {
  it('escapes angle brackets', () => {
    expect(escapeMd('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('returns empty string for null/undefined', () => {
    expect(escapeMd(null)).toBe('')
    expect(escapeMd(undefined)).toBe('')
    expect(escapeMd('')).toBe('')
  })

  it('passes through normal text unchanged', () => {
    expect(escapeMd('Hello, world!')).toBe('Hello, world!')
  })
})

describe('formatToolCall', () => {
  it('formats a basic tool call at medium verbosity', () => {
    const meta = {
      name: 'Read',
      displayTitle: 'Read foo.ts',
      rawInput: '/path/to/foo.ts',
    } as ToolCallMeta
    const result = formatToolCall(meta, 'medium')
    expect(result).toContain('**Read foo.ts**')
    expect(result).toContain(':book:')
  })

  it('formats with high verbosity showing input and output', () => {
    const meta = {
      name: 'Bash',
      displayTitle: 'Run command',
      rawInput: 'ls -la',
      content: 'total 42\ndrwxr-xr-x ...',
    } as ToolCallMeta
    const result = formatToolCall(meta, 'high')
    expect(result).toContain('**Input:**')
    expect(result).toContain('ls -la')
    expect(result).toContain('**Output:**')
    expect(result).toContain('total 42')
  })

  it('hides input/output at low verbosity', () => {
    const meta = {
      name: 'Write',
      displayTitle: 'Write file',
      rawInput: 'some input',
      content: 'some output',
    } as ToolCallMeta
    const result = formatToolCall(meta, 'low')
    expect(result).not.toContain('**Input:**')
    expect(result).not.toContain('**Output:**')
  })

  it('falls back to tool name when no title', () => {
    const meta = { name: 'CustomTool' } as ToolCallMeta
    const result = formatToolCall(meta, 'medium')
    expect(result).toContain('**CustomTool**')
  })

  it('falls back to "Tool" when no name', () => {
    const meta = {} as ToolCallMeta
    const result = formatToolCall(meta, 'medium')
    expect(result).toContain('**Tool**')
  })

  it('uses search icon for grep-like tools', () => {
    const meta = { name: 'Grep', displayTitle: 'Search files' } as ToolCallMeta
    const result = formatToolCall(meta, 'medium')
    expect(result).toContain(':mag:')
  })

  it('uses computer icon for bash/exec tools', () => {
    const meta = { name: 'Bash', displayTitle: 'Run command' } as ToolCallMeta
    const result = formatToolCall(meta, 'medium')
    expect(result).toContain(':computer:')
  })
})

describe('formatToolUpdate', () => {
  it('produces same output as formatToolCall', () => {
    const meta = { name: 'Edit', displayTitle: 'Edit file' } as ToolUpdateMeta
    const callResult = formatToolCall(meta, 'medium')
    const updateResult = formatToolUpdate(meta, 'medium')
    expect(updateResult).toBe(callResult)
  })
})

describe('formatPlan', () => {
  it('renders entries with status icons', () => {
    const plan = {
      entries: [
        { content: 'Step 1', status: 'completed' },
        { content: 'Step 2', status: 'in_progress' },
        { content: 'Step 3', status: 'pending' },
      ],
    }
    const result = formatPlan(plan)
    expect(result).toContain('**Plan:**')
    expect(result).toContain(':white_check_mark: 1. Step 1')
    expect(result).toContain(':arrows_counterclockwise: 2. Step 2')
    expect(result).toContain(':white_large_square: 3. Step 3')
  })

  it('handles empty plan', () => {
    const result = formatPlan({ entries: [] })
    expect(result).toContain('**Plan:**')
  })

  it('handles unknown status with default icon', () => {
    const plan = { entries: [{ content: 'Unknown', status: 'bizarre' }] }
    const result = formatPlan(plan)
    expect(result).toContain(':white_large_square: 1. Unknown')
  })
})

describe('formatUsage', () => {
  it('shows progress bar with tokens and contextSize', () => {
    const result = formatUsage({ tokensUsed: 28000, contextSize: 200000 }, 'high')
    expect(result).toContain('28k / 200k tokens')
    expect(result).toContain('14%')
    expect(result).toContain(':bar_chart:')
  })

  it('shows warning emoji when usage >= 85%', () => {
    const result = formatUsage({ tokensUsed: 85000, contextSize: 100000 }, 'high')
    expect(result).toContain(':warning:')
    expect(result).toContain('85%')
  })

  it('shows 100% with full bar', () => {
    const result = formatUsage({ tokensUsed: 100000, contextSize: 100000 }, 'high')
    expect(result).toContain('100%')
    expect(result).toContain(':warning:')
  })

  it('shows only tokens when no contextSize', () => {
    const result = formatUsage({ tokensUsed: 5000 })
    expect(result).toBe(':bar_chart: 5k tokens')
  })

  it('shows placeholder when no data', () => {
    const result = formatUsage({})
    expect(result).toBe(':bar_chart: Usage data unavailable')
  })

  it('displays small numbers without k suffix', () => {
    const result = formatUsage({ tokensUsed: 500, contextSize: 1000 }, 'high')
    expect(result).toContain('500 / 1k tokens')
    expect(result).toContain('50%')
  })
})

describe('formatNotification', () => {
  it('formats completed notification', () => {
    const result = formatNotification('completed', 'MySession', 'Task done')
    expect(result).toContain(':white_check_mark:')
    expect(result).toContain('**MySession**')
    expect(result).toContain('Task done')
  })

  it('formats error notification', () => {
    const result = formatNotification('error', 'Session', 'Failed')
    expect(result).toContain(':x:')
  })

  it('formats permission notification', () => {
    const result = formatNotification('permission', 'Session', 'Allow?')
    expect(result).toContain(':lock:')
  })

  it('uses info icon for unknown type', () => {
    const result = formatNotification('unknown_type', 'Session', 'Something')
    expect(result).toContain(':information_source:')
  })
})

describe('formatError', () => {
  it('formats error with emoji and bold', () => {
    const result = formatError('Something broke')
    expect(result).toBe(':x: **Error:** Something broke')
  })

  it('escapes angle brackets in error text', () => {
    const result = formatError('<html> injection')
    expect(result).toContain('&lt;html&gt;')
  })
})

describe('formatTokens', () => {
  it('formats thousands with k suffix', () => {
    expect(formatTokens(5000)).toBe('5k')
    expect(formatTokens(28000)).toBe('28k')
  })

  it('formats millions with M suffix', () => {
    expect(formatTokens(1500000)).toBe('1.5M')
  })

  it('shows small numbers as-is', () => {
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(0)).toBe('0')
  })
})

describe('progressBar', () => {
  it('shows empty bar at 0%', () => {
    expect(progressBar(0)).toBe('\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591')
  })

  it('shows full bar at 100%', () => {
    expect(progressBar(1)).toBe('\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593')
  })

  it('clamps ratio above 1', () => {
    expect(progressBar(1.5)).toBe('\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593')
  })

  it('shows half bar at 50%', () => {
    const bar = progressBar(0.5)
    expect(bar.length).toBe(10)
    expect(bar).toContain('\u2593')
    expect(bar).toContain('\u2591')
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = splitMessage('Hello world', 100)
    expect(result).toEqual(['Hello world'])
  })

  it('splits at paragraph boundary', () => {
    const text = 'A'.repeat(50) + '\n\n' + 'B'.repeat(50)
    const result = splitMessage(text, 60)
    expect(result.length).toBe(2)
    expect(result[0]).toBe('A'.repeat(50))
    expect(result[1]).toBe('B'.repeat(50))
  })

  it('splits at line boundary when no paragraph break', () => {
    const text = 'A'.repeat(50) + '\n' + 'B'.repeat(50)
    const result = splitMessage(text, 60)
    expect(result.length).toBe(2)
  })

  it('hard-cuts when no good break point', () => {
    const text = 'A'.repeat(200)
    const result = splitMessage(text, 100)
    expect(result.length).toBe(2)
    expect(result[0]!.length).toBeLessThanOrEqual(100)
  })

  it('preserves all content across chunks', () => {
    const text = 'Word '.repeat(100)
    const chunks = splitMessage(text, 50)
    const rejoined = chunks.join(' ').replace(/\s+/g, ' ').trim()
    const original = text.replace(/\s+/g, ' ').trim()
    // All words should be present (though spacing may differ at split points)
    for (const word of original.split(' ')) {
      expect(rejoined).toContain(word)
    }
  })
})

describe('truncateContent', () => {
  it('returns text unchanged if within limit', () => {
    expect(truncateContent('short', 100)).toBe('short')
  })

  it('truncates with ellipsis when over limit', () => {
    const result = truncateContent('A'.repeat(100), 50)
    expect(result.length).toBe(50)
    expect(result).toMatch(/\u2026$/)
  })
})
