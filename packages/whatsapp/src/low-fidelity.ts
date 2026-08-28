import type { DisplayVerbosity } from '@openacp/plugin-sdk'
import type { OutgoingMessage, NotificationMessage } from '@openacp/plugin-sdk'
import {
  formatToolCall,
  formatToolUpdate,
  formatPlan,
  formatUsage,
  formatThought,
  formatError,
  formatNotification,
  stripMarkdown,
  truncate,
} from './formatting.js'

/**
 * Low-fidelity message collapsers for WhatsApp.
 *
 * WhatsApp has no rich formatting (no HTML, no inline buttons, no message editing).
 * All complex message types (thought, tool_call, tool_update, plan, usage) must be
 * collapsed into concise plain text summaries. In "low" verbosity, many of these
 * are suppressed entirely to reduce noise.
 */

/** Collapse a thought message into plain text. Returns empty string to suppress. */
export function collapseThought(content: OutgoingMessage, verbosity: DisplayVerbosity): string {
  return formatThought(content.text, verbosity)
}

/** Collapse a tool_call message into a single summary line. */
export function collapseToolCall(content: OutgoingMessage, verbosity: DisplayVerbosity): string {
  const meta = (content.metadata ?? {}) as { name?: string; rawInput?: unknown; displayTitle?: string }
  return formatToolCall(meta, verbosity)
}

/** Collapse a tool_update message into a single summary line. */
export function collapseToolUpdate(content: OutgoingMessage, verbosity: DisplayVerbosity): string {
  const meta = (content.metadata ?? {}) as { name?: string; content?: unknown; displayTitle?: string; status?: string }
  return formatToolUpdate(meta, verbosity)
}

/** Collapse a plan message into a numbered list. */
export function collapsePlan(content: OutgoingMessage): string {
  const meta = content.metadata as
    | { entries?: Array<{ content: string; status: string }> }
    | undefined
  return formatPlan({ entries: meta?.entries ?? [] })
}

/** Collapse a usage message into a single line. */
export function collapseUsage(content: OutgoingMessage, verbosity: DisplayVerbosity): string {
  const meta = content.metadata as
    | { tokensUsed?: number; contextSize?: number; cost?: number }
    | undefined
  return formatUsage(meta ?? {}, verbosity)
}

/** Collapse an error message. */
export function collapseError(content: OutgoingMessage): string {
  return formatError(content.text)
}

/** Collapse a notification into plain text. */
export function collapseNotification(notification: NotificationMessage): string {
  return formatNotification({
    type: notification.type,
    summary: notification.summary,
    sessionName: notification.sessionName,
  })
}

/** Collapse a system message. */
export function collapseSystem(content: OutgoingMessage): string {
  return stripMarkdown(content.text)
}

/** Collapse a mode change. */
export function collapseModeChange(content: OutgoingMessage): string {
  const modeId = (content.metadata as Record<string, unknown>)?.modeId ?? ''
  return `[Mode] ${String(modeId)}`
}

/** Collapse a config update. */
export function collapseConfigUpdate(): string {
  return '[Config updated]'
}

/** Collapse a model update. */
export function collapseModelUpdate(content: OutgoingMessage): string {
  const modelId = (content.metadata as Record<string, unknown>)?.modelId ?? ''
  return `[Model] ${String(modelId)}`
}

/** Collapse a session_end message. */
export function collapseSessionEnd(content: OutgoingMessage): string {
  if (!content.text) return '[Session ended]'
  return `[Session ended] ${truncate(stripMarkdown(content.text), 200)}`
}
