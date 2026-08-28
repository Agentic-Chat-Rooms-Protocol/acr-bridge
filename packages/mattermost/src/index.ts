/**
 * @openacp/mattermost-adapter — OpenACP plugin entry point.
 *
 * Exports the plugin object as default export, following the standard
 * OpenACP plugin pattern: createPlugin() → OpenACPPlugin.
 */

import type {
  OpenACPPlugin,
  InstallContext,
  OpenACPCore,
} from '@openacp/plugin-sdk'
import type { MattermostConfig } from './types.js'

function createMattermostPlugin(): OpenACPPlugin {
  let adapter: { start(): Promise<void>; stop(): Promise<void> } | null = null

  return {
    name: '@openacp/mattermost-adapter',
    version: '0.1.0',
    description: 'Mattermost adapter with threads, streaming, and reactions',
    essential: false,
    pluginDependencies: {
      '@openacp/security': '^1.0.0',
      '@openacp/notifications': '^1.0.0',
    },
    optionalPluginDependencies: {
      '@openacp/speech': '^1.0.0',
    },
    permissions: ['services:register', 'kernel:access', 'events:read', 'storage:read', 'storage:write'],
    inheritableKeys: [],

    async install(ctx: InstallContext) {
      const { terminal, settings } = ctx

      // Interactive setup
      const url = await terminal.text({
        message: 'Mattermost server URL (e.g. https://mattermost.example.com):',
        validate: (val) => {
          const trimmed = val.trim()
          if (!trimmed) return 'URL cannot be empty'
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            return 'URL must start with http:// or https://'
          }
          return undefined
        },
      })

      const token = await terminal.text({
        message: 'Bot personal access token (from System Console > Integrations):',
        validate: (val) => {
          if (!val.trim()) return 'Token cannot be empty'
          return undefined
        },
      })

      // Validate connection
      const spin = terminal.spinner()
      spin.start('Validating connection...')
      try {
        const { MattermostClient } = await import('./client.js')
        const client = new MattermostClient({ url: url.trim(), token: token.trim() })
        const me = await client.getMe()
        spin.stop(`Connected as @${me.username}`)
      } catch (err) {
        spin.fail(`Connection failed: ${String(err)}`)
        const action = await terminal.select({
          message: 'What to do?',
          options: [
            { label: 'Re-enter credentials', value: 'retry' },
            { label: 'Save as-is (skip validation)', value: 'skip' },
          ],
        })
        if (action === 'retry') {
          // Recursive retry is complex in this pattern; save and let user reconfigure
          terminal.log.info('Saving current values. Use /configure to update.')
        }
      }

      // Channel ID (optional)
      const channelId = await terminal.text({
        message: 'Channel ID to monitor (leave empty for all channels):',
        validate: () => undefined,
      })

      // Trigger phrase (optional)
      const trigger = await terminal.text({
        message: 'Trigger phrase for team channels (leave empty for mention-only):',
        validate: () => undefined,
      })

      await settings.setAll({
        url: url.trim(),
        token: token.trim(),
        channelId: channelId.trim() || null,
        trigger: trigger.trim() || null,
        maxMessageLength: 4000,
      })
      terminal.log.success('Mattermost settings saved')
    },

    async configure(ctx: InstallContext) {
      const { terminal, settings } = ctx

      const choice = await terminal.select({
        message: 'What to configure?',
        options: [
          { value: 'url', label: 'Change server URL' },
          { value: 'token', label: 'Change bot token' },
          { value: 'channel', label: 'Change monitored channel' },
          { value: 'trigger', label: 'Change trigger phrase' },
          { value: 'done', label: 'Done' },
        ],
      })

      if (choice === 'url') {
        const url = await terminal.text({
          message: 'New server URL:',
          validate: (v) => (!v.trim() ? 'URL cannot be empty' : undefined),
        })
        await settings.set('url', url.trim())
        terminal.log.success('Server URL updated')
      } else if (choice === 'token') {
        const token = await terminal.text({
          message: 'New bot token:',
          validate: (v) => (!v.trim() ? 'Token cannot be empty' : undefined),
        })
        await settings.set('token', token.trim())
        terminal.log.success('Bot token updated')
      } else if (choice === 'channel') {
        const channelId = await terminal.text({
          message: 'New channel ID (empty for all):',
          validate: () => undefined,
        })
        await settings.set('channelId', channelId.trim() || null)
        terminal.log.success('Channel ID updated')
      } else if (choice === 'trigger') {
        const trigger = await terminal.text({
          message: 'New trigger phrase (empty for mention-only):',
          validate: () => undefined,
        })
        await settings.set('trigger', trigger.trim() || null)
        terminal.log.success('Trigger phrase updated')
      }
    },

    async uninstall(ctx: InstallContext, opts: { purge: boolean }) {
      if (opts.purge) {
        await ctx.settings.clear()
        ctx.terminal.log.success('Mattermost settings cleared')
      }
    },

    async setup(ctx) {
      const config = ctx.pluginConfig as Record<string, unknown>
      if (!config.url || !config.token) {
        ctx.log.info('Mattermost disabled (missing url or token)')
        return
      }

      const core = ctx.core as OpenACPCore

      const { MattermostAdapter } = await import('./adapter.js')
      adapter = new MattermostAdapter(core, {
        enabled: true,
        url: String(config.url),
        token: String(config.token),
        channelId: config.channelId ? String(config.channelId) : undefined,
        trigger: config.trigger ? String(config.trigger) : undefined,
        maxMessageLength: Number(config.maxMessageLength) || 4000,
        instanceId: config.instanceId ? String(config.instanceId) : undefined,
      })

      // OpenACP core calls adapter.start() automatically after registerService.
      // Do NOT call start() here — it would cause double-start.
      ctx.registerService('adapter:mattermost', adapter)
      ctx.log.info('Mattermost adapter registered')
    },

    async teardown() {
      if (adapter) {
        await adapter.stop()
        adapter = null
      }
    },
  }
}

export default createMattermostPlugin()

// Named exports for direct imports
export { MattermostAdapter } from './adapter.js'
export { MattermostClient, MattermostApiError, normalizeBaseUrl } from './client.js'
export { MattermostWebSocket, parsePostedEvent, parseReactionEvent, parseMentions } from './websocket.js'
export { MattermostRenderer } from './renderer.js'
export { MattermostDraftManager, MattermostDraft } from './draft-manager.js'
export { MattermostActivityTracker, ThinkingIndicator, ToolCard } from './activity.js'
export { MattermostPermissionHandler } from './permissions.js'
export {
  resolveRootId,
  buildSessionId,
  shouldHandleThreadReply,
  isDirectMessage,
  isDirectMessageType,
  isGroupMessage,
  isGroupMessageType,
  isTeamChannel,
  isTeamChannelType,
  shouldAutoRespond,
  isMentioned,
  containsTrigger,
  stripTrigger,
} from './threading.js'
export {
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
} from './formatting.js'
export type {
  MattermostConfig,
  MattermostUser,
  MattermostChannel,
  MattermostPost,
  MattermostFileInfo,
  MattermostReaction,
  MattermostWSEvent,
  MattermostSessionContext,
} from './types.js'
