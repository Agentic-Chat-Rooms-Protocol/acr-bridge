import type { OpenACPPlugin, InstallContext } from '@openacp/plugin-sdk'

function createWhatsAppPlugin(): OpenACPPlugin {
  let adapter: { start(): Promise<void>; stop(): Promise<void> } | null = null

  return {
    name: '@openacp/whatsapp-adapter',
    version: '0.1.0',
    description: 'WhatsApp adapter using Baileys (WhiskeySockets fork)',
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
      terminal.log.info('WhatsApp adapter setup')
      terminal.log.info('')
      terminal.log.warning('IMPORTANT: WhatsApp Web multi-device protocol is unofficial.')
      terminal.log.warning('Use a disposable SIM for testing. For production, use WhatsApp Cloud API.')
      terminal.log.info('')

      // Auth directory
      const authDir = await terminal.text({
        message: 'Auth state directory (absolute path):',
        defaultValue: '/data/whatsapp-auth',
        validate: (val) => {
          if (!val.trim()) return 'Path cannot be empty'
          if (!val.startsWith('/')) return 'Must be an absolute path'
          return undefined
        },
      })

      // Auth method
      const authMethod = await terminal.select({
        message: 'Authentication method:',
        options: [
          { value: 'qr', label: 'QR code (scan with phone)' },
          { value: 'pairing', label: 'Pairing code (headless, enter code on phone)' },
        ],
      })

      let pairingPhoneNumber: string | null = null
      if (authMethod === 'pairing') {
        pairingPhoneNumber = await terminal.text({
          message: 'Phone number (country code + number, no +, e.g. 15551234567):',
          validate: (val) => {
            const cleaned = val.trim().replace(/\D/g, '')
            if (cleaned.length < 10) return 'Phone number too short'
            return undefined
          },
        })
        pairingPhoneNumber = pairingPhoneNumber.trim().replace(/\D/g, '')
      }

      // Allowed JIDs (optional)
      const addAllowlist = await terminal.select({
        message: 'Restrict to specific chats? (recommended for safety)',
        options: [
          { value: 'yes', label: 'Yes — enter allowed JIDs' },
          { value: 'no', label: 'No — accept messages from anyone (higher ban risk)' },
        ],
      })

      let allowedJids: string[] = []
      if (addAllowlist === 'yes') {
        const jidsInput = await terminal.text({
          message: 'Allowed JIDs (comma-separated, e.g. 1234@s.whatsapp.net,group@g.us):',
          validate: (val) => {
            if (!val.trim()) return 'Enter at least one JID'
            return undefined
          },
        })
        allowedJids = jidsInput.split(',').map((j) => j.trim()).filter(Boolean)
      }

      await settings.setAll({
        authDir: authDir.trim(),
        pairingPhoneNumber,
        allowedJids,
      })

      terminal.log.success('WhatsApp settings saved')
      terminal.log.info('Start the adapter and scan the QR code (or enter pairing code) to link your device.')
    },

    async configure(ctx: InstallContext) {
      const { terminal, settings } = ctx
      const current = await settings.getAll()

      const choice = await terminal.select({
        message: 'What to configure?',
        options: [
          { value: 'authDir', label: 'Change auth directory' },
          { value: 'pairingPhone', label: 'Change pairing phone number' },
          { value: 'allowedJids', label: 'Update allowed JIDs' },
          { value: 'done', label: 'Done' },
        ],
      })

      if (choice === 'authDir') {
        const val = await terminal.text({
          message: 'New auth directory:',
          defaultValue: String(current.authDir ?? '/data/whatsapp-auth'),
        })
        await settings.set('authDir', val.trim())
        terminal.log.success('Auth directory updated')
      } else if (choice === 'pairingPhone') {
        const val = await terminal.text({
          message: 'Phone number (empty to use QR):',
          defaultValue: String(current.pairingPhoneNumber ?? ''),
        })
        const cleaned = val.trim().replace(/\D/g, '')
        await settings.set('pairingPhoneNumber', cleaned || null)
        terminal.log.success('Pairing phone updated')
      } else if (choice === 'allowedJids') {
        const val = await terminal.text({
          message: 'Allowed JIDs (comma-separated, empty for all):',
          defaultValue: Array.isArray(current.allowedJids) ? (current.allowedJids as string[]).join(', ') : '',
        })
        const jids = val.split(',').map((j: string) => j.trim()).filter(Boolean)
        await settings.set('allowedJids', jids)
        terminal.log.success('Allowed JIDs updated')
      }
    },

    async uninstall(ctx: InstallContext, opts: { purge: boolean }) {
      if (opts.purge) {
        await ctx.settings.clear()
        ctx.terminal.log.success('WhatsApp settings cleared')
        ctx.terminal.log.info('Note: Auth state directory was NOT deleted. Remove it manually if needed.')
      }
    },

    async setup(ctx) {
      const config = ctx.pluginConfig as Record<string, unknown>
      if (!config.authDir) {
        ctx.log.info('WhatsApp disabled (missing authDir)')
        return
      }

      const { WhatsAppAdapter } = await import('./adapter.js')
      const adapterInstance = new WhatsAppAdapter(
        ctx.core as { configManager: { get(): Record<string, unknown> }; fileService?: unknown },
        {
          ...config,
          enabled: true,
          maxMessageLength: (config.maxMessageLength as number) ?? 4000,
        } as unknown as import('./types.js').WhatsAppAdapterConfig,
      )

      adapter = adapterInstance
      // OpenACP core calls adapter.start() automatically after registerService.
      ctx.registerService('adapter:whatsapp', adapterInstance)
      ctx.log.info('WhatsApp adapter registered')
    },

    async teardown() {
      if (adapter) {
        await adapter.stop()
        adapter = null
      }
    },
  }
}

export default createWhatsAppPlugin()

// Named exports for direct usage
export { WhatsAppAdapter } from './adapter.js'
export { WhatsAppRenderer } from './renderer.js'
export { BaileysClient } from './client.js'
export { ActivityTracker } from './activity.js'
export { PermissionHandler } from './permissions.js'
export { GroupMetadataCache } from './threading.js'
export type { WhatsAppAdapterConfig, WhatsAppSessionContext } from './types.js'
