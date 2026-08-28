import type { DisplayVerbosity } from '@openacp/plugin-sdk'

/**
 * WhatsApp formatting utilities.
 *
 * WhatsApp supports *very* limited formatting:
 *   *bold*, _italic_, ~strikethrough~, ```monospace```
 *
 * For safety and readability, we render everything as plain text
 * with minimal decoration. No HTML, no markdown conversion.
 */

/** Strip markdown syntax to produce clean plain text. */
export function stripMarkdown(text: string): string {
  if (!text) return ''
  return text
    // Remove fenced code blocks markers (keep content)
    .replace(/```[\w]*\n?/g, '')
    // Remove inline code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Remove bold **text** → text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // Remove italic *text* → text (not ** which is bold)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    // Remove links [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // Remove heading markers
    .replace(/^#{1,6}\s+/gm, '')
    // Clean up excessive whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Truncate text to maxLen, adding ellipsis if truncated. */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '\u2026'
}

/**
 * Format a tool call for WhatsApp plain text display.
 * Returns a single concise line.
 */
export function formatToolCall(
  meta: { name?: string; rawInput?: unknown; displayTitle?: string },
  _verbosity: DisplayVerbosity = 'medium',
): string {
  const name = meta.displayTitle ?? meta.name ?? 'Tool'
  const input = meta.rawInput
  if (!input) return `[Tool] ${name}`

  const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
  const brief = truncate(inputStr.replace(/\n/g, ' '), 80)
  return `[Tool] ${name}: ${brief}`
}

/**
 * Format a tool update for WhatsApp plain text display.
 * Returns a single concise line.
 */
export function formatToolUpdate(
  meta: { name?: string; content?: unknown; displayTitle?: string; status?: string },
  _verbosity: DisplayVerbosity = 'medium',
): string {
  const name = meta.displayTitle ?? meta.name ?? 'Tool'
  const status = meta.status ?? 'done'
  if (!meta.content) return `[${status}] ${name}`

  const contentStr = typeof meta.content === 'string' ? meta.content : JSON.stringify(meta.content)
  const brief = truncate(contentStr.replace(/\n/g, ' '), 80)
  return `[${status}] ${name}: ${brief}`
}

/**
 * Format a plan for WhatsApp plain text display.
 * Numbered list with status icons.
 */
export function formatPlan(plan: {
  entries: Array<{ content: string; status: string }>
}): string {
  const { entries } = plan
  if (entries.length === 0) return '[Plan] (empty)'

  const statusIcon: Record<string, string> = {
    pending: '[ ]',
    in_progress: '[~]',
    completed: '[x]',
  }

  const lines = entries.map(
    (e, i) => `${statusIcon[e.status] ?? '[ ]'} ${i + 1}. ${e.content}`,
  )
  return `Plan (${entries.length} steps):\n${lines.join('\n')}`
}

/**
 * Format usage info for WhatsApp plain text display.
 */
export function formatUsage(
  usage: { tokensUsed?: number; contextSize?: number; cost?: number },
  _verbosity: DisplayVerbosity = 'medium',
): string {
  const { tokensUsed, contextSize } = usage
  if (tokensUsed == null) return 'Usage data unavailable'
  const tokStr = formatTokenCount(tokensUsed)
  if (contextSize == null) return `Tokens: ${tokStr}`

  const pct = Math.round((tokensUsed / contextSize) * 100)
  const ctxStr = formatTokenCount(contextSize)
  return `Tokens: ${tokStr}/${ctxStr} (${pct}%)`
}

/** Format a token count: 1500 → "1.5k", 500 → "500" */
export function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`
  }
  return String(n)
}

/**
 * Format a thought for WhatsApp plain text display.
 * In low-fidelity mode, thoughts are heavily summarized or skipped.
 */
export function formatThought(text: string, verbosity: DisplayVerbosity = 'medium'): string {
  if (verbosity === 'low') return ''
  const brief = truncate(stripMarkdown(text).replace(/\n/g, ' '), 120)
  return `[Thinking] ${brief}`
}

/**
 * Format an error for WhatsApp plain text display.
 */
export function formatError(text: string): string {
  return `[Error] ${text}`
}

/**
 * Format a notification for WhatsApp plain text display.
 */
export function formatNotification(
  notification: { type: string; summary: string; sessionName?: string },
): string {
  const prefix: Record<string, string> = {
    completed: '[Done]',
    error: '[Error]',
    permission: '[Permission]',
    input_required: '[Input needed]',
    budget_warning: '[Budget]',
  }
  const tag = prefix[notification.type] ?? '[Info]'
  const session = notification.sessionName ? ` ${notification.sessionName}:` : ''
  return `${tag}${session} ${notification.summary}`
}

/**
 * Split a long message into chunks at paragraph/sentence boundaries.
 * Respects maxLength per chunk (default 4000 for readability).
 */
export function splitMessage(text: string, maxLength = 4_000): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  const paragraphs = text.split(/\n\n/)
  let current = ''

  for (const para of paragraphs) {
    // If a single paragraph exceeds max, split it further
    if (para.length > maxLength) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      // Split by sentences
      const sentences = para.split(/(?<=[.!?])\s+/)
      for (const sentence of sentences) {
        if (sentence.length > maxLength) {
          // Hard split at maxLength
          if (current) {
            chunks.push(current)
            current = ''
          }
          for (let i = 0; i < sentence.length; i += maxLength) {
            chunks.push(sentence.slice(i, i + maxLength))
          }
        } else if (current.length + sentence.length + 1 > maxLength) {
          chunks.push(current)
          current = sentence
        } else {
          current = current ? `${current} ${sentence}` : sentence
        }
      }
      continue
    }

    const candidate = current ? `${current}\n\n${para}` : para
    if (candidate.length > maxLength && current) {
      chunks.push(current)
      current = para
    } else {
      current = candidate
    }
  }

  if (current) chunks.push(current)
  return chunks
}
