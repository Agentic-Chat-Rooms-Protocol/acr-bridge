/**
 * Signal formatting utilities.
 *
 * Signal supports limited inline formatting via text styles (bold, italic,
 * monospace, strikethrough, spoiler) but these require out-of-band style
 * ranges. For the adapter's outbound messages, we use plain text only
 * since the signal-cli-rest-api v2 send endpoint handles basic text.
 *
 * All formatting is plain text. No HTML, no Markdown rendering.
 */

// ─── Text Escaping ───────────────────────────────────────────────────────────

/**
 * Escape special characters for plain-text Signal messages.
 *
 * Signal messages are plain text, so there's no HTML/Markdown to escape.
 * However, we strip control characters and normalize whitespace to prevent
 * rendering issues in the Signal client.
 */
export function escapePlainText(text: string | undefined | null): string {
  if (!text) return ''
  // Strip zero-width characters and other invisible Unicode
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + '...'
}

// ─── Message Formatting ──────────────────────────────────────────────────────

/**
 * Format a permission request as plain text with numbered options.
 */
export function formatPermissionRequest(description: string, options: Array<{
  id: string
  label: string
  isAllow: boolean
}>): string {
  const lines: string[] = [
    'Permission request:',
    '',
    description,
    '',
  ]
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!
    const marker = opt.isAllow ? 'Allow' : 'Deny'
    lines.push(`Reply ${i + 1} to ${marker}: ${opt.label}`)
  }
  return lines.join('\n')
}

/**
 * Format a notification message for Signal.
 */
export function formatNotification(notification: {
  type: string
  sessionName?: string
  summary: string
}): string {
  const typeLabel: Record<string, string> = {
    completed: 'Completed',
    error: 'Error',
    permission: 'Permission needed',
    input_required: 'Input needed',
    budget_warning: 'Budget warning',
  }
  const label = typeLabel[notification.type] ?? 'Notification'
  const session = notification.sessionName ? ` (${notification.sessionName})` : ''
  return `[${label}]${session}\n${notification.summary}`
}

/**
 * Format an error message.
 */
export function formatError(text: string): string {
  return `Error: ${escapePlainText(text)}`
}

/**
 * Format a mode change message.
 */
export function formatModeChange(modeId: string): string {
  return `Mode changed: ${modeId}`
}

/**
 * Format a model update message.
 */
export function formatModelUpdate(modelId: string): string {
  return `Model changed: ${modelId}`
}

/**
 * Format a config update message.
 */
export function formatConfigUpdate(): string {
  return 'Configuration updated'
}

// ─── Message Splitting ───────────────────────────────────────────────────────

/**
 * Split a message into chunks respecting the maximum length.
 *
 * Prefers splitting at paragraph boundaries, then line breaks,
 * then word boundaries. Falls back to hard cut.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    const window = remaining.slice(0, maxLength)
    let splitIdx = window.lastIndexOf('\n\n')
    if (splitIdx <= 0) splitIdx = window.lastIndexOf('\n')
    if (splitIdx <= 0) splitIdx = window.lastIndexOf(' ')
    if (splitIdx <= 0) splitIdx = maxLength

    chunks.push(remaining.slice(0, splitIdx).trimEnd())
    remaining = remaining.slice(splitIdx).trimStart()
  }

  return chunks
}
