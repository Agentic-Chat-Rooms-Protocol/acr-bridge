/**
 * Low-fidelity rendering for Signal.
 *
 * Signal supports only plain text (no HTML, no Markdown rendering in messages).
 * Complex message types (thought, tool_call, tool_update, plan, usage) must be
 * collapsed into concise plain-text summaries.
 *
 * This module mirrors the WhatsApp low-fidelity renderer -- both platforms
 * share the same constraints (no rich formatting, no message editing).
 */

import type { DisplayVerbosity } from '@openacp/plugin-sdk'
import { splitMessage } from './formatting.js'

// ─── Tool Call Summary ───────────────────────────────────────────────────────

interface ToolCallInfo {
  name?: string
  kind?: string
  status?: string
  rawInput?: unknown
  content?: unknown
  displaySummary?: string
  displayTitle?: string
}

/**
 * Collapse a tool_call event into a single-line plain text summary.
 *
 * Low verbosity:  "-- Read file.ts"
 * Medium:         "-- Read file.ts"
 * High:           "-- Read file.ts\n   Input: { path: ... }"
 */
export function formatToolCallPlain(tool: ToolCallInfo, verbosity: DisplayVerbosity = 'medium'): string {
  const icon = toolKindIcon(tool.kind)
  const label = tool.displayTitle ?? tool.displaySummary ?? tool.name ?? 'Tool'
  let line = `${icon} ${label}`

  if (verbosity === 'high' && tool.rawInput) {
    const inputStr = typeof tool.rawInput === 'string'
      ? tool.rawInput
      : JSON.stringify(tool.rawInput, null, 2)
    if (inputStr && inputStr !== '{}') {
      const truncated = inputStr.length > 300 ? inputStr.slice(0, 297) + '...' : inputStr
      line += `\n   Input: ${truncated}`
    }
  }

  return line
}

/**
 * Collapse a tool_update event into a single-line plain text summary.
 */
export function formatToolUpdatePlain(tool: ToolCallInfo, verbosity: DisplayVerbosity = 'medium'): string {
  const icon = toolStatusIcon(tool.status)
  const label = tool.displayTitle ?? tool.displaySummary ?? tool.name ?? 'Tool'
  let line = `${icon} ${label}`

  if (verbosity === 'high' && tool.content) {
    const contentStr = typeof tool.content === 'string'
      ? tool.content
      : JSON.stringify(tool.content)
    if (contentStr) {
      const truncated = contentStr.length > 200 ? contentStr.slice(0, 197) + '...' : contentStr
      line += `\n   Output: ${truncated}`
    }
  }

  return line
}

// ─── Thought Summary ─────────────────────────────────────────────────────────

/**
 * Collapse a thought into a plain text indicator.
 * In low-fidelity mode, we don't relay the full thought content --
 * just an indicator that the agent is thinking.
 */
export function formatThoughtPlain(_text: string, verbosity: DisplayVerbosity = 'medium'): string {
  if (verbosity === 'high') {
    const truncated = _text.length > 500 ? _text.slice(0, 497) + '...' : _text
    return `[Thinking] ${truncated}`
  }
  return '[Thinking...]'
}

// ─── Plan Summary ────────────────────────────────────────────────────────────

interface PlanEntry {
  content: string
  status: string
}

/**
 * Render a plan as a plain text numbered list with status markers.
 */
export function formatPlanPlain(entries: PlanEntry[]): string {
  if (entries.length === 0) return 'Plan: (empty)'

  const statusIcon: Record<string, string> = {
    pending: '[ ]',
    in_progress: '[~]',
    completed: '[x]',
  }

  const lines = entries.map((e, i) => {
    const icon = statusIcon[e.status] ?? '[ ]'
    return `${icon} ${i + 1}. ${e.content}`
  })

  return `Plan:\n${lines.join('\n')}`
}

// ─── Usage Summary ───────────────────────────────────────────────────────────

/**
 * Render usage statistics as a compact plain text line.
 */
export function formatUsagePlain(usage: {
  tokensUsed?: number
  contextSize?: number
  cost?: number
}): string {
  const { tokensUsed, contextSize } = usage
  if (tokensUsed == null) return 'Usage: data unavailable'
  if (contextSize == null) return `Usage: ${formatTokenCount(tokensUsed)} tokens`

  const pct = Math.round((tokensUsed / contextSize) * 100)
  const warning = pct >= 85 ? ' (!)' : ''
  return `Usage: ${formatTokenCount(tokensUsed)} / ${formatTokenCount(contextSize)} tokens (${pct}%)${warning}`
}

// ─── Error Summary ───────────────────────────────────────────────────────────

/**
 * Format an error message for plain text display.
 */
export function formatErrorPlain(text: string): string {
  return `Error: ${text}`
}

// ─── System Message ──────────────────────────────────────────────────────────

/**
 * Format a system message for plain text display.
 */
export function formatSystemPlain(text: string): string {
  return text
}

// ─── Session End ─────────────────────────────────────────────────────────────

/**
 * Format a session-end message.
 */
export function formatSessionEndPlain(text: string): string {
  return `Session ended: ${text || 'completed'}`
}

// ─── Notification ────────────────────────────────────────────────────────────

/**
 * Format a notification message for plain text.
 */
export function formatNotificationPlain(notification: {
  type: string
  sessionName?: string
  summary: string
}): string {
  const typeLabel: Record<string, string> = {
    completed: 'Done',
    error: 'Error',
    permission: 'Permission',
    input_required: 'Input needed',
    budget_warning: 'Warning',
  }
  const label = typeLabel[notification.type] ?? 'Info'
  const session = notification.sessionName ?? 'Session'
  return `[${label}] ${session}: ${notification.summary}`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toolKindIcon(kind?: string): string {
  const map: Record<string, string> = {
    read: '--',
    edit: '>>',
    write: '++',
    delete: 'xx',
    execute: '$>',
    search: '??',
    web: '@@',
  }
  return map[kind ?? ''] ?? '--'
}

function toolStatusIcon(status?: string): string {
  const done = new Set(['completed', 'done'])
  const fail = new Set(['failed', 'error'])
  if (done.has(status ?? '')) return 'OK'
  if (fail.has(status ?? '')) return '!!'
  return '..'
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// ─── Message Chunking ────────────────────────────────────────────────────────

/**
 * Split a long plain-text message into chunks under the given limit.
 *
 * Delegates to the canonical splitMessage in formatting.ts to avoid
 * duplicating the splitting logic.
 */
export function splitPlainText(text: string, maxLength: number): string[] {
  return splitMessage(text, maxLength)
}
