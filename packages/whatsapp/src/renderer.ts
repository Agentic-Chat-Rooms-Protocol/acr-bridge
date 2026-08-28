import { BaseRenderer } from '@openacp/plugin-sdk'
import type { RenderedMessage, OutgoingMessage, NotificationMessage } from '@openacp/plugin-sdk'
import type { DisplayVerbosity } from '@openacp/plugin-sdk'
import {
  collapseThought,
  collapseToolCall,
  collapseToolUpdate,
  collapsePlan,
  collapseUsage,
  collapseError,
  collapseNotification,
  collapseSystem,
  collapseModeChange,
  collapseConfigUpdate,
  collapseModelUpdate,
} from './low-fidelity.js'
import { stripMarkdown } from './formatting.js'

/**
 * WhatsAppRenderer — low-fidelity plain text renderer.
 *
 * WhatsApp does NOT support HTML or markdown rendering in bot messages.
 * All output is format: 'plain'. Complex message types (thought, tool_call,
 * plan, usage) are collapsed into concise single-line summaries.
 */
export class WhatsAppRenderer extends BaseRenderer {
  renderText(content: OutgoingMessage): RenderedMessage {
    return { body: stripMarkdown(content.text), format: 'plain' }
  }

  renderThought(content: OutgoingMessage, verbosity: DisplayVerbosity): RenderedMessage {
    return { body: collapseThought(content, verbosity), format: 'plain' }
  }

  renderToolCall(content: OutgoingMessage, verbosity: DisplayVerbosity): RenderedMessage {
    return { body: collapseToolCall(content, verbosity), format: 'plain' }
  }

  renderToolUpdate(content: OutgoingMessage, verbosity: DisplayVerbosity): RenderedMessage {
    return { body: collapseToolUpdate(content, verbosity), format: 'plain' }
  }

  renderPlan(content: OutgoingMessage): RenderedMessage {
    return { body: collapsePlan(content), format: 'plain' }
  }

  renderUsage(content: OutgoingMessage, verbosity: DisplayVerbosity): RenderedMessage {
    return { body: collapseUsage(content, verbosity), format: 'plain' }
  }

  renderError(content: OutgoingMessage): RenderedMessage {
    return { body: collapseError(content), format: 'plain' }
  }

  renderNotification(notification: NotificationMessage): RenderedMessage {
    return { body: collapseNotification(notification), format: 'plain' }
  }

  renderSystemMessage(content: OutgoingMessage): RenderedMessage {
    return { body: collapseSystem(content), format: 'plain' }
  }

  renderModeChange(content: OutgoingMessage): RenderedMessage {
    return { body: collapseModeChange(content), format: 'plain' }
  }

  renderConfigUpdate(): RenderedMessage {
    return { body: collapseConfigUpdate(), format: 'plain' }
  }

  renderModelUpdate(content: OutgoingMessage): RenderedMessage {
    return { body: collapseModelUpdate(content), format: 'plain' }
  }
}
