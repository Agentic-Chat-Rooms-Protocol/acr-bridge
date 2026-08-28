import { BaseRenderer } from '@openacp/plugin-sdk'
import type { RenderedMessage, OutgoingMessage, NotificationMessage } from '@openacp/plugin-sdk'
import type { DisplayVerbosity } from '@openacp/plugin-sdk'
import {
  formatToolCallPlain,
  formatToolUpdatePlain,
  formatThoughtPlain,
  formatPlanPlain,
  formatUsagePlain,
  formatErrorPlain,
  formatSessionEndPlain,
  formatNotificationPlain,
} from './low-fidelity.js'
import { escapePlainText, formatModeChange, formatModelUpdate, formatConfigUpdate } from './formatting.js'

// ─── Signal Renderer ─────────────────────────────────────────────────────────

/**
 * Low-fidelity renderer for Signal.
 *
 * Signal supports only plain text in messages. All complex types
 * (tool calls, plans, usage) are collapsed into compact text summaries.
 * The format is always "plain" (never "html" or "markdown").
 */
export class SignalRenderer extends BaseRenderer {
  renderToolCall(
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): RenderedMessage {
    const meta = (content.metadata ?? {}) as Record<string, unknown>
    return {
      body: formatToolCallPlain({
        name: meta['name'] as string | undefined ?? content.text,
        kind: meta['kind'] as string | undefined,
        status: meta['status'] as string | undefined,
        rawInput: meta['rawInput'],
        displaySummary: meta['displaySummary'] as string | undefined,
        displayTitle: meta['displayTitle'] as string | undefined,
      }, verbosity),
      format: 'plain',
    }
  }

  renderToolUpdate(
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): RenderedMessage {
    const meta = (content.metadata ?? {}) as Record<string, unknown>
    return {
      body: formatToolUpdatePlain({
        name: meta['name'] as string | undefined ?? content.text,
        kind: meta['kind'] as string | undefined,
        status: meta['status'] as string | undefined,
        content: meta['content'],
        displaySummary: meta['displaySummary'] as string | undefined,
        displayTitle: meta['displayTitle'] as string | undefined,
      }, verbosity),
      format: 'plain',
    }
  }

  renderThought(
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): RenderedMessage {
    return {
      body: formatThoughtPlain(content.text, verbosity),
      format: 'plain',
    }
  }

  renderPlan(content: OutgoingMessage): RenderedMessage {
    const meta = content.metadata as
      | { entries?: Array<{ content: string; status: string }> }
      | undefined
    return {
      body: formatPlanPlain(meta?.entries ?? []),
      format: 'plain',
    }
  }

  renderUsage(
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): RenderedMessage {
    const meta = content.metadata as
      | { tokensUsed?: number; contextSize?: number; cost?: number }
      | undefined
    return {
      body: formatUsagePlain(meta ?? {}),
      format: 'plain',
    }
  }

  renderError(content: OutgoingMessage): RenderedMessage {
    return {
      body: formatErrorPlain(content.text),
      format: 'plain',
    }
  }

  renderNotification(notification: NotificationMessage): RenderedMessage {
    return {
      body: formatNotificationPlain(notification),
      format: 'plain',
    }
  }

  renderSystemMessage(content: OutgoingMessage): RenderedMessage {
    return {
      body: escapePlainText(content.text),
      format: 'plain',
    }
  }

  renderSessionEnd(content: OutgoingMessage): RenderedMessage {
    return {
      body: formatSessionEndPlain(content.text),
      format: 'plain',
    }
  }

  renderModeChange(content: OutgoingMessage): RenderedMessage {
    const modeId = (content.metadata as Record<string, unknown>)?.['modeId'] ?? ''
    return {
      body: formatModeChange(String(modeId)),
      format: 'plain',
    }
  }

  renderConfigUpdate(): RenderedMessage {
    return {
      body: formatConfigUpdate(),
      format: 'plain',
    }
  }

  renderModelUpdate(content: OutgoingMessage): RenderedMessage {
    const modelId = (content.metadata as Record<string, unknown>)?.['modelId'] ?? ''
    return {
      body: formatModelUpdate(String(modelId)),
      format: 'plain',
    }
  }
}
