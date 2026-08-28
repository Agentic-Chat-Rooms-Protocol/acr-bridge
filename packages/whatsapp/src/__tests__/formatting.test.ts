import { describe, it, expect } from 'vitest'
import {
  stripMarkdown,
  truncate,
  formatToolCall,
  formatToolUpdate,
  formatPlan,
  formatUsage,
  formatThought,
  formatError,
  formatNotification,
  splitMessage,
  formatTokenCount,
} from '../formatting.js'

describe('stripMarkdown', () => {
  it('removes bold markers', () => {
    expect(stripMarkdown('Hello **world**')).toBe('Hello world')
  })

  it('removes italic markers', () => {
    expect(stripMarkdown('Hello *world*')).toBe('Hello world')
  })

  it('removes inline code backticks', () => {
    expect(stripMarkdown('Run `npm install`')).toBe('Run npm install')
  })

  it('removes fenced code block markers', () => {
    expect(stripMarkdown('```js\nconsole.log("hi")\n```')).toBe('console.log("hi")')
  })

  it('converts links to text (url) format', () => {
    expect(stripMarkdown('[Click here](https://example.com)')).toBe('Click here (https://example.com)')
  })

  it('removes heading markers', () => {
    expect(stripMarkdown('## Section Title')).toBe('Section Title')
  })

  it('handles empty string', () => {
    expect(stripMarkdown('')).toBe('')
  })

  it('handles null/undefined gracefully', () => {
    expect(stripMarkdown(null as unknown as string)).toBe('')
    expect(stripMarkdown(undefined as unknown as string)).toBe('')
  })

  it('collapses excessive newlines', () => {
    expect(stripMarkdown('A\n\n\n\nB')).toBe('A\n\nB')
  })

  it('preserves text with no markdown', () => {
    expect(stripMarkdown('Just plain text here')).toBe('Just plain text here')
  })
})

describe('truncate', () => {
  it('returns text unchanged if under limit', () => {
    expect(truncate('short', 100)).toBe('short')
  })

  it('truncates with ellipsis at maxLen', () => {
    const result = truncate('a'.repeat(200), 50)
    expect(result.length).toBe(50)
    expect(result.endsWith('\u2026')).toBe(true)
  })

  it('handles exact length', () => {
    expect(truncate('exact', 5)).toBe('exact')
  })

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('')
  })
})

describe('formatTokenCount', () => {
  it('formats small numbers without suffix', () => {
    expect(formatTokenCount(500)).toBe('500')
  })

  it('formats exact thousands with k suffix', () => {
    expect(formatTokenCount(5000)).toBe('5k')
  })

  it('formats non-integer thousands with decimal', () => {
    expect(formatTokenCount(1500)).toBe('1.5k')
  })

  it('formats large numbers', () => {
    expect(formatTokenCount(200000)).toBe('200k')
  })

  it('formats 999 without k', () => {
    expect(formatTokenCount(999)).toBe('999')
  })

  it('formats 1000 as 1k', () => {
    expect(formatTokenCount(1000)).toBe('1k')
  })
})

describe('formatToolCall', () => {
  it('formats tool call with name only', () => {
    expect(formatToolCall({ name: 'Read' })).toBe('[Tool] Read')
  })

  it('formats tool call with displayTitle', () => {
    expect(formatToolCall({ displayTitle: 'Read file.ts', name: 'Read' })).toBe('[Tool] Read file.ts')
  })

  it('formats tool call with rawInput string', () => {
    const result = formatToolCall({ name: 'Bash', rawInput: 'ls -la' })
    expect(result).toBe('[Tool] Bash: ls -la')
  })

  it('truncates long rawInput', () => {
    const result = formatToolCall({ name: 'Bash', rawInput: 'x'.repeat(200) })
    expect(result.length).toBeLessThan(120)
    expect(result).toContain('\u2026')
  })

  it('handles missing name', () => {
    expect(formatToolCall({})).toBe('[Tool] Tool')
  })
})

describe('formatToolUpdate', () => {
  it('formats tool update with status', () => {
    expect(formatToolUpdate({ name: 'Read', status: 'completed' })).toBe('[completed] Read')
  })

  it('formats with content', () => {
    const result = formatToolUpdate({ name: 'Read', content: '42 lines', status: 'done' })
    expect(result).toBe('[done] Read: 42 lines')
  })

  it('defaults to "done" status', () => {
    expect(formatToolUpdate({ name: 'Read' })).toBe('[done] Read')
  })
})

describe('formatPlan', () => {
  it('formats empty plan', () => {
    expect(formatPlan({ entries: [] })).toBe('[Plan] (empty)')
  })

  it('formats plan with entries', () => {
    const result = formatPlan({
      entries: [
        { content: 'Read code', status: 'completed' },
        { content: 'Write tests', status: 'in_progress' },
        { content: 'Deploy', status: 'pending' },
      ],
    })
    expect(result).toContain('Plan (3 steps)')
    expect(result).toContain('[x] 1. Read code')
    expect(result).toContain('[~] 2. Write tests')
    expect(result).toContain('[ ] 3. Deploy')
  })
})

describe('formatUsage', () => {
  it('formats usage with tokens and context', () => {
    const result = formatUsage({ tokensUsed: 28000, contextSize: 200000 })
    expect(result).toBe('Tokens: 28k/200k (14%)')
  })

  it('formats usage with tokens only', () => {
    expect(formatUsage({ tokensUsed: 5000 })).toBe('Tokens: 5k')
  })

  it('shows unavailable when no data', () => {
    expect(formatUsage({})).toBe('Usage data unavailable')
  })

  it('formats 100% usage', () => {
    const result = formatUsage({ tokensUsed: 100000, contextSize: 100000 })
    expect(result).toBe('Tokens: 100k/100k (100%)')
  })

  it('formats small token counts', () => {
    const result = formatUsage({ tokensUsed: 500, contextSize: 1000 })
    expect(result).toBe('Tokens: 500/1k (50%)')
  })
})

describe('formatThought', () => {
  it('returns empty for low verbosity', () => {
    expect(formatThought('thinking hard', 'low')).toBe('')
  })

  it('returns summary for medium verbosity', () => {
    const result = formatThought('I need to analyze this code carefully', 'medium')
    expect(result).toContain('[Thinking]')
    expect(result).toContain('analyze this code')
  })

  it('truncates long thoughts', () => {
    const result = formatThought('x'.repeat(300), 'high')
    expect(result.length).toBeLessThan(150)
  })
})

describe('formatError', () => {
  it('formats error message', () => {
    expect(formatError('Connection failed')).toBe('[Error] Connection failed')
  })
})

describe('formatNotification', () => {
  it('formats completed notification', () => {
    const result = formatNotification({ type: 'completed', summary: 'Task done', sessionName: 'MySession' })
    expect(result).toBe('[Done] MySession: Task done')
  })

  it('formats error notification', () => {
    const result = formatNotification({ type: 'error', summary: 'Failed' })
    expect(result).toBe('[Error] Failed')
  })

  it('formats permission notification', () => {
    const result = formatNotification({ type: 'permission', summary: 'Need access' })
    expect(result).toBe('[Permission] Need access')
  })

  it('formats unknown type', () => {
    const result = formatNotification({ type: 'custom', summary: 'Something' })
    expect(result).toBe('[Info] Something')
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello'])
  })

  it('splits at paragraph boundaries', () => {
    const text = 'Paragraph one.\n\nParagraph two.'
    const chunks = splitMessage(text, 20)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe('Paragraph one.')
    expect(chunks[1]).toBe('Paragraph two.')
  })

  it('handles text larger than maxLength with no paragraphs', () => {
    const text = 'a'.repeat(100)
    const chunks = splitMessage(text, 30)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30)
    }
  })

  it('does not split when text equals maxLength', () => {
    const text = 'a'.repeat(50)
    expect(splitMessage(text, 50)).toEqual([text])
  })

  it('handles empty string', () => {
    expect(splitMessage('')).toEqual([''])
  })

  it('respects default maxLength of 4000', () => {
    const text = 'a'.repeat(8000)
    const chunks = splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000)
    }
  })

  it('splits sentence-heavy paragraphs correctly', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1}.`).join(' ')
    const chunks = splitMessage(sentences, 80)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80)
    }
  })
})
