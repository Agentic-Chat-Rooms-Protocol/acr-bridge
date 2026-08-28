/**
 * MattermostRenderer — extends BaseRenderer to produce Mattermost-native
 * markdown output for all OpenACP message types.
 */

import { BaseRenderer } from '@openacp/plugin-sdk'
import type { RenderedMessage } from '@openacp/plugin-sdk'
import type {
  OutgoingMessage,
  NotificationMessage,
  DisplayVerbosity,
  ToolCallMeta,
  ToolUpdateMeta,
} from '@openacp/plugin-sdk'
import {
  escapeMd,
  formatToolCall,
  formatToolUpdate,
  formatPlan,
  formatUsage,
  formatError,
  formatNotification,
} from './formatting.js'

export class MattermostRenderer extends BaseRenderer {
  renderToolCall(
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): RenderedMessage {
    const meta = (content.metadata ?? {}) as Partial<ToolCallMeta>
    return {
      body: formatToolCall(meta as ToolCallMeta, verbosity),
      format: 'markdown',
    }
  }

  renderToolUpdate(
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): RenderedMessage {
    const meta = (content.metadata ?? {}) as Partial<ToolUpdateMeta>
    return {
      body: formatToolUpdate(meta as ToolUpdateMeta, verbosity),
      format: 'markdown',
    }
  }

  renderPlan(content: OutgoingMessage): RenderedMessage {
    const meta = content.metadata as
      | { entries?: Array<{ content: string; status: string }> }
      | undefined
    return {
      body: formatPlan({ entries: meta?.entries ?? [] }),
      format: 'markdown',
    }
  }

  renderUsage(
    content: OutgoingMessage,
    verbosity: DisplayVerbosity,
  ): RenderedMessage {
    const meta = content.metadata as
      | { tokensUsed?: number; contextSize?: number; cost?: number }
      | undefined
    return { body: formatUsage(meta ?? {}, verbosity), format: 'markdown' }
  }

  renderError(content: OutgoingMessage): RenderedMessage {
    return {
      body: formatError(content.text),
      format: 'markdown',
    }
  }

  renderNotification(notification: NotificationMessage): RenderedMessage {
    return {
      body: formatNotification(
        notification.type,
        notification.sessionName || 'Session',
        notification.summary,
      ),
      format: 'markdown',
    }
  }

  renderSystemMessage(content: OutgoingMessage): RenderedMessage {
    return { body: escapeMd(content.text), format: 'markdown' }
  }

  renderModeChange(content: OutgoingMessage): RenderedMessage {
    const modeId = (content.metadata as Record<string, unknown>)?.modeId ?? ''
    return {
      body: `:arrows_counterclockwise: **Mode:** ${escapeMd(String(modeId))}`,
      format: 'markdown',
    }
  }

  renderConfigUpdate(): RenderedMessage {
    return { body: ':gear: **Config updated**', format: 'markdown' }
  }

  renderModelUpdate(content: OutgoingMessage): RenderedMessage {
    const modelId =
      (content.metadata as Record<string, unknown>)?.modelId ?? ''
    return {
      body: `:robot_face: **Model:** ${escapeMd(String(modelId))}`,
      format: 'markdown',
    }
  }
}
