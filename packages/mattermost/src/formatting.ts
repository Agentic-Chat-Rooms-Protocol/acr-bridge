/**
 * Mattermost-specific formatting functions.
 *
 * Mattermost uses native markdown, so most output is passed through
 * directly. These helpers provide structured formatting for tool calls,
 * usage, plans, and message splitting.
 */

import type {
  ToolCallMeta,
  ToolUpdateMeta,
  DisplayVerbosity,
} from '@openacp/plugin-sdk'

// ─── Escaping ────────────────────────────────────────────────────────────────

/**
 * Escape special markdown characters in user-provided text.
 * Only escape characters that would break Mattermost markdown parsing.
 */
export function escapeMd(text: string | undefined | null): string {
  if (!text) return ''
  // Mattermost markdown is permissive — only escape backticks and
  // angle brackets that could break code blocks or links.
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ─── Tool formatting ─────────────────────────────────────────────────────────

/**
 * Format a tool call for display in Mattermost.
 */
export function formatToolCall(
  tool: ToolCallMeta,
  verbosity: DisplayVerbosity = 'medium',
): string {
  const icon = resolveToolIcon(tool.name)
  const name = tool.name || 'Tool'
  const title = tool.displayTitle ?? tool.displaySummary ?? name

  let text = `${icon} **${escapeMd(title)}**`

  if (verbosity === 'high') {
    if (tool.rawInput) {
      const inputStr = typeof tool.rawInput === 'string'
        ? tool.rawInput
        : JSON.stringify(tool.rawInput, null, 2)
      if (inputStr && inputStr !== '{}') {
        text += `\n**Input:**\n\`\`\`\n${truncateContent(inputStr, 3800)}\n\`\`\``
      }
    }
    const content = extractContentText(tool.content)
    if (content) {
      text += `\n**Output:**\n\`\`\`\n${truncateContent(content, 3800)}\n\`\`\``
    }
  }

  return text
}

/**
 * Format a tool update for display in Mattermost.
 */
export function formatToolUpdate(
  update: ToolUpdateMeta,
  verbosity: DisplayVerbosity = 'medium',
): string {
  return formatToolCall(update, verbosity)
}

// ─── Plan formatting ─────────────────────────────────────────────────────────

/**
 * Format a plan with entries for display.
 */
export function formatPlan(plan: {
  entries: Array<{ content: string; status: string }>
}): string {
  const statusIcon: Record<string, string> = {
    pending: ':white_large_square:',
    in_progress: ':arrows_counterclockwise:',
    completed: ':white_check_mark:',
  }
  const lines = plan.entries.map(
    (e, i) =>
      `${statusIcon[e.status] ?? ':white_large_square:'} ${i + 1}. ${escapeMd(e.content)}`,
  )
  return `**Plan:**\n${lines.join('\n')}`
}

// ─── Usage formatting ────────────────────────────────────────────────────────

/**
 * Format usage statistics.
 */
export function formatUsage(
  usage: { tokensUsed?: number; contextSize?: number; cost?: number },
  _verbosity: DisplayVerbosity = 'medium',
): string {
  const { tokensUsed, contextSize } = usage
  if (tokensUsed == null) return ':bar_chart: Usage data unavailable'
  if (contextSize == null) return `:bar_chart: ${formatTokens(tokensUsed)} tokens`

  const ratio = tokensUsed / contextSize
  const pct = Math.round(ratio * 100)
  const bar = progressBar(ratio)
  const emoji = pct >= 85 ? ':warning:' : ':bar_chart:'
  return `${emoji} ${formatTokens(tokensUsed)} / ${formatTokens(contextSize)} tokens\n${bar} ${pct}%`
}

// ─── Notification formatting ─────────────────────────────────────────────────

/**
 * Format a notification message.
 */
export function formatNotification(
  type: string,
  sessionName: string,
  summary: string,
): string {
  const emoji: Record<string, string> = {
    completed: ':white_check_mark:',
    error: ':x:',
    permission: ':lock:',
    input_required: ':speech_balloon:',
    budget_warning: ':warning:',
  }
  return `${emoji[type] ?? ':information_source:'} **${escapeMd(sessionName)}**\n${escapeMd(summary)}`
}

// ─── Error formatting ────────────────────────────────────────────────────────

/**
 * Format an error message.
 */
export function formatError(text: string): string {
  return `:x: **Error:** ${escapeMd(text)}`
}

// ─── Message splitting ───────────────────────────────────────────────────────

/**
 * Represents a code block found within a message.
 */
interface CodeBlock {
  /** Start index in the original text */
  start: number
  /** End index (exclusive) in the original text */
  end: number
  /** The language tag (e.g. "js", "python", or empty) */
  lang: string
}

/**
 * Find all code fence blocks (``` ... ```) in the text.
 * Returns their positions so the splitter can avoid breaking inside them.
 */
function findCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const regex = /^(`{3,})(\w*)\s*$/gm
  const fences: Array<{ index: number; ticks: string; lang: string; isOpen: boolean }> = []

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    fences.push({
      index: match.index,
      ticks: match[1]!,
      lang: match[2] ?? '',
      isOpen: false,
    })
  }

  // Pair opening/closing fences
  let openFence: { index: number; ticks: string; lang: string } | null = null
  for (const fence of fences) {
    if (!openFence) {
      openFence = fence
    } else if (fence.ticks.length >= openFence.ticks.length && !fence.lang) {
      // Closing fence — ticks must be at least as long and have no language tag
      const endOfClosingLine = text.indexOf('\n', fence.index)
      blocks.push({
        start: openFence.index,
        end: endOfClosingLine === -1 ? text.length : endOfClosingLine + 1,
        lang: openFence.lang,
      })
      openFence = null
    }
  }

  // If there's an unclosed fence, treat from start to end of text as a block
  if (openFence) {
    blocks.push({
      start: openFence.index,
      end: text.length,
      lang: openFence.lang,
    })
  }

  return blocks
}

/**
 * Check if an index falls inside any code block.
 * Returns the code block if found, or undefined.
 */
function isInsideCodeBlock(index: number, blocks: CodeBlock[]): CodeBlock | undefined {
  return blocks.find((b) => index > b.start && index < b.end)
}

/**
 * Split a long message into chunks that fit within the platform limit.
 * Code-fence-aware: avoids splitting inside code blocks (``` ... ```).
 * If a split point would land inside a code block, moves it before or after
 * the block. Split code blocks that exceed maxLength are re-wrapped with the
 * language tag.
 */
export function splitMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text]

  const codeBlocks = findCodeBlocks(text)
  const chunks: string[] = []
  let remaining = text
  let offset = 0 // tracks position in original text for code block lookups

  while (remaining.length > maxLength) {
    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength)
    if (splitIdx < maxLength * 0.3) {
      // Try line boundary
      splitIdx = remaining.lastIndexOf('\n', maxLength)
    }
    if (splitIdx < maxLength * 0.3) {
      // Try space boundary
      splitIdx = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitIdx < maxLength * 0.3) {
      // Hard cut
      splitIdx = maxLength
    }

    // Code-fence awareness: check if splitIdx lands inside a code block
    const absoluteIdx = offset + splitIdx
    const insideBlock = isInsideCodeBlock(absoluteIdx, codeBlocks)
    if (insideBlock) {
      // Option 1: move split before the code block
      const beforeBlock = insideBlock.start - offset
      // Option 2: move split after the code block
      const afterBlock = insideBlock.end - offset

      if (beforeBlock > maxLength * 0.2) {
        // Split before the code block
        splitIdx = beforeBlock
      } else if (afterBlock <= remaining.length) {
        // The code block itself may be very large; if it fits in remaining, split after
        if (afterBlock <= maxLength * 2) {
          splitIdx = afterBlock
        } else {
          // Code block is huge — hard-split inside it but re-wrap
          const chunk = remaining.slice(0, splitIdx)
          const lang = insideBlock.lang
          // Close the code fence in this chunk and re-open in the next
          chunks.push(chunk + '\n```')
          remaining = '```' + (lang ? lang : '') + '\n' + remaining.slice(splitIdx).trimStart()
          offset += splitIdx
          continue
        }
      }
    }

    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).trimStart()
    offset += splitIdx
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve an icon for a tool by name. */
function resolveToolIcon(name: string | undefined): string {
  if (!name) return ':wrench:'
  const lower = name.toLowerCase()
  if (lower.includes('read') || lower.includes('view')) return ':book:'
  if (lower.includes('write') || lower.includes('edit') || lower.includes('create')) return ':pencil2:'
  if (lower.includes('delete') || lower.includes('remove')) return ':wastebasket:'
  if (lower.includes('search') || lower.includes('find') || lower.includes('grep')) return ':mag:'
  if (lower.includes('run') || lower.includes('exec') || lower.includes('bash') || lower.includes('command')) return ':computer:'
  if (lower.includes('list') || lower.includes('glob')) return ':card_index_dividers:'
  return ':wrench:'
}

/** Format token count with k/M suffix. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Create a text-based progress bar. */
export function progressBar(ratio: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return '\u2593'.repeat(filled) + '\u2591'.repeat(width - filled)
}

/** Truncate content with ellipsis. */
export function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '\u2026'
}

/** Extract text content from various content formats. */
function extractContentText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        if (typeof item === 'object' && item !== null && 'text' in item) {
          return String((item as { text: unknown }).text)
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object' && content !== null && 'text' in content) {
    return String((content as { text: unknown }).text)
  }
  return ''
}
