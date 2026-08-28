import type { OpenACPPlugin, InstallContext, PluginContext } from '@openacp/plugin-sdk'
import type { SignalAdapterConfig } from './types.js'

function createSignalPlugin(): OpenACPPlugin {
  let adapter: { stop(): Promise<void> } | null = null

  return {
    name: '@openacp/signal-adapter',
    version: '0.1.0',
    description: 'Signal adapter for OpenACP via signal-cli-rest-api',
    pluginDependencies: {
      '@openacp/security': '^1.0.0',
      '@openacp/notifications': '^1.0.0',
    },
    optionalPluginDependencies: {
      '@openacp/speech': '^1.0.0',
    },
    permissions: ['services:register', 'kernel:access', 'events:read', 'storage:read', 'storage:write'],

    async install(ctx: InstallContext) {
      const { terminal, settings } = ctx

      // Interactive setup
      const apiUrl = await terminal.text({
        message: 'signal-cli-rest-api URL (e.g. http://localhost:8080):',
        validate: (val) => {
          if (!val.trim()) return 'URL cannot be empty'
          try {
            new URL(val.trim())
          } catch {
            return 'Invalid URL format'
          }
          return undefined
        },
      })

      // Validate connection
      const spin = terminal.spinner()
      spin.start('Testing connection to signal-cli-rest-api...')
      try {
        const res = await fetch(`${apiUrl.trim().replace(/\/+$/, '')}/api/v1/about`)
        if (res.ok) {
          spin.stop('Connected to signal-cli-rest-api')
        } else {
          spin.fail(`Connection returned HTTP ${res.status}`)
          terminal.log.warning('Continuing anyway -- you can reconfigure later')
        }
      } catch (err) {
        spin.fail(`Connection failed: ${err instanceof Error ? err.message : String(err)}`)
        terminal.log.warning('Continuing anyway -- make sure signal-cli-rest-api is running')
      }

      const number = await terminal.text({
        message: 'Signal phone number (E.164 format, e.g. +15551234567):',
        validate: (val) => {
          const trimmed = val.trim()
          if (!trimmed) return 'Phone number cannot be empty'
          if (!trimmed.startsWith('+')) return 'Phone number must start with +'
          if (!/^\+\d{7,15}$/.test(trimmed)) return 'Invalid E.164 format'
          return undefined
        },
      })

      const needAuth = await terminal.select({
        message: 'Does signal-cli-rest-api require authentication?',
        options: [
          { value: 'no', label: 'No authentication' },
          { value: 'yes', label: 'Yes, configure auth header' },
        ],
      })

      let authHeader: string | null = null
      if (needAuth === 'yes') {
        authHeader = await terminal.text({
          message: 'Authorization header value (e.g. "Basic dXNlcjpwYXNz"):',
          validate: (val) => (!val.trim() ? 'Auth header cannot be empty' : undefined),
        })
      }

      await settings.setAll({
        apiUrl: apiUrl.trim(),
        number: number.trim(),
        authHeader,
        allowedSenders: null,
      })
      terminal.log.success('Signal settings saved')
    },

    async configure(ctx: InstallContext) {
      const { terminal, settings } = ctx

      const choice = await terminal.select({
        message: 'What to configure?',
        options: [
          { value: 'apiUrl', label: 'Change API URL' },
          { value: 'number', label: 'Change phone number' },
          { value: 'auth', label: 'Change authentication' },
          { value: 'done', label: 'Done' },
        ],
      })

      if (choice === 'apiUrl') {
        const val = await terminal.text({
          message: 'New signal-cli-rest-api URL:',
          validate: (v) => {
            if (!v.trim()) return 'URL cannot be empty'
            try { new URL(v.trim()) } catch { return 'Invalid URL format' }
            return undefined
          },
        })
        await settings.set('apiUrl', val.trim())
        terminal.log.success('API URL updated')
      } else if (choice === 'number') {
        const val = await terminal.text({
          message: 'New Signal phone number:',
          validate: (v) => {
            const t = v.trim()
            if (!t) return 'Phone number cannot be empty'
            if (!/^\+\d{7,15}$/.test(t)) return 'Invalid E.164 format'
            return undefined
          },
        })
        await settings.set('number', val.trim())
        terminal.log.success('Phone number updated')
      } else if (choice === 'auth') {
        const val = await terminal.text({
          message: 'New auth header value (leave empty to disable):',
        })
        await settings.set('authHeader', val.trim() || null)
        terminal.log.success('Authentication updated')
      }
    },

    async uninstall(ctx: InstallContext, opts: { purge: boolean }) {
      if (opts.purge) {
        await ctx.settings.clear()
        ctx.terminal.log.success('Signal settings cleared')
      }
    },

    async setup(ctx: PluginContext) {
      const config = ctx.pluginConfig as Record<string, unknown>
      if (!config['apiUrl'] || !config['number']) {
        ctx.log.info('Signal disabled (missing apiUrl or number)')
        return
      }

      const { SignalAdapter } = await import('./adapter.js')
      const adapterConfig: SignalAdapterConfig = {
        enabled: true,
        apiUrl: config['apiUrl'] as string,
        number: config['number'] as string,
        authHeader: (config['authHeader'] as string | null) ?? undefined,
        allowedSenders: (config['allowedSenders'] as string[] | null) ?? undefined,
        maxMessageLength: (config['maxMessageLength'] as number | undefined) ?? 4000,
        minSendInterval: (config['minSendInterval'] as number | undefined) ?? 500,
      }

      const signalAdapter = new SignalAdapter(adapterConfig)

      // Inject core when available
      if (ctx.core) {
        signalAdapter.setCore(ctx.core as unknown as import('./adapter.js').SignalAdapterCore)
      }

      // Inject storage for session persistence
      if (ctx.storage) {
        signalAdapter.setStorage(ctx.storage)
      }

      adapter = signalAdapter
      // OpenACP core calls adapter.start() automatically after registerService.
      ctx.registerService('adapter:signal', signalAdapter)
      ctx.log.info('Signal adapter registered')
    },

    async teardown() {
      if (adapter) {
        await adapter.stop()
        adapter = null
      }
    },
  }
}

export default createSignalPlugin()

// ── Named Exports ─────────────────────────────────────────────────────────────

export { SignalAdapter } from './adapter.js'
export type { SignalAdapterCore, SignalAdapterStorage } from './adapter.js'
export { SignalClient } from './client.js'
export { SignalRenderer } from './renderer.js'
export { SignalPermissionHandler } from './permissions.js'
export { SignalActivityTracker, TypingPump } from './activity.js'
export { GroupManager, GroupCache } from './groups.js'
export {
  connectSseStream,
  runSseLoop,
  parseSseChunk,
  parseEnvelopeData,
  extractSessionKey,
  isGroupMessage,
  extractSenderName,
  extractSenderId,
  computeBackoff,
  SseAuthError,
} from './events.js'
export {
  resolveInboundAttachment,
  resolveAllAttachments,
  encodeAttachment,
  encodeBufferAttachment,
  isVoiceNoteContentType,
  isImageContentType,
} from './media.js'
export {
  escapePlainText,
  truncateText,
  formatPermissionRequest,
  formatNotification,
  formatError,
  formatModeChange,
  formatModelUpdate,
  formatConfigUpdate,
  splitMessage,
} from './formatting.js'
export {
  formatToolCallPlain,
  formatToolUpdatePlain,
  formatThoughtPlain,
  formatPlanPlain,
  formatUsagePlain,
  formatErrorPlain,
  formatSystemPlain,
  formatSessionEndPlain,
  formatNotificationPlain,
  splitPlainText,
} from './low-fidelity.js'
export type {
  SignalAdapterConfig,
  SignalSessionContext,
  SignalEnvelope,
  SignalDataMessage,
  SignalAttachment,
  SignalReaction,
  SignalQuote,
  SignalGroupInfo,
  SignalTypingMessage,
  SignalReceiptMessage,
  SignalSseEventData,
  ReconnectConfig,
} from './types.js'
export type {
  SendResponse,
  AboutResponse,
  GroupEntry,
} from './client.js'
export {
  extractSessionKey as threadingExtractSessionKey,
  isGroupMessage as threadingIsGroupMessage,
} from './threading.js'
export type { SseStreamOptions, SseLoopOptions } from './events.js'
export type { ResolvedAttachment } from './media.js'
