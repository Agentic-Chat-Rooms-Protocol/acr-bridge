import { createChildLogger } from '@openacp/plugin-sdk'
import type { ReconnectConfig, AuthPaths } from './types.js'
import { DEFAULT_RECONNECT_CONFIG } from './types.js'

const log = createChildLogger({ module: 'whatsapp:client' })

/**
 * Baileys module types.
 *
 * We use dynamic import so the module is only loaded at runtime,
 * not at type-check time (helps with optional peer dependency patterns).
 * The types here mirror what we use from @whiskeysockets/baileys.
 */
export interface BaileysSocket {
  ev: {
    on: (event: string, handler: (...args: unknown[]) => void) => void
    off: (event: string, handler: (...args: unknown[]) => void) => void
  }
  sendMessage: (jid: string, content: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>
  sendPresenceUpdate: (type: string, jid?: string) => Promise<void>
  requestPairingCode: (phoneNumber: string) => Promise<string>
  groupMetadata: (jid: string) => Promise<GroupMetadata>
  logout: () => Promise<void>
  end: (error?: Error) => void
  ws: { close: () => void }
}

export interface GroupMetadata {
  id: string
  subject: string
  participants: Array<{ id: string; admin?: string | null }>
}

export interface ConnectionUpdate {
  connection?: 'close' | 'open' | 'connecting'
  lastDisconnect?: { error?: Error & { output?: { statusCode?: number } } }
  qr?: string
  isOnline?: boolean
}

export interface MessageUpsert {
  messages: unknown[]
  type: 'notify' | 'append'
}

/** Listener callbacks provided to BaileysClient. */
export interface BaileysClientListeners {
  onConnectionUpdate: (update: ConnectionUpdate) => void
  onMessagesUpsert: (upsert: MessageUpsert) => void
  onCredsUpdate: () => Promise<void>
}

/** Options for creating BaileysClient. */
export interface BaileysClientOptions {
  authPaths: AuthPaths
  pairingPhoneNumber?: string
  reconnectConfig?: ReconnectConfig
  listeners: BaileysClientListeners
}

/**
 * BaileysClient wraps the Baileys socket with auth, QR/pairing-code flow,
 * and automatic reconnection with exponential backoff.
 *
 * IMPORTANT: WhatsApp Web multi-device protocol is unofficial. Use a
 * disposable SIM for testing. For production/business use, prefer the
 * WhatsApp Cloud API.
 */
export class BaileysClient {
  private sock: BaileysSocket | null = null
  private reconnectAttempt = 0
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly reconnectConfig: ReconnectConfig
  private readonly options: BaileysClientOptions

  constructor(options: BaileysClientOptions) {
    this.options = options
    this.reconnectConfig = options.reconnectConfig ?? DEFAULT_RECONNECT_CONFIG
  }

  /** Start the Baileys socket connection. */
  async connect(): Promise<void> {
    this.stopped = false
    await this.createSocket()
  }

  /** Disconnect and stop reconnecting. */
  async disconnect(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.sock) {
      try {
        this.sock.ws.close()
      } catch {
        // Socket may already be closed
      }
      this.sock = null
    }
  }

  /** Get the active Baileys socket. Throws if not connected. */
  getSocket(): BaileysSocket {
    if (!this.sock) {
      throw new Error('[WHATSAPP_CLIENT] Socket not connected')
    }
    return this.sock
  }

  /** Whether the client is currently connected (socket exists). */
  isConnected(): boolean {
    return this.sock !== null
  }

  private async createSocket(): Promise<void> {
    if (this.stopped) return

    try {
      const baileys = await import('@whiskeysockets/baileys')
      const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } = baileys

      const { state, saveCreds } = await useMultiFileAuthState(this.options.authPaths.authDir)

      // Baileys ILogger-compatible silent logger
      type ILogger = {
        level: string
        child(obj: Record<string, unknown>): ILogger
        trace(obj: unknown, msg?: string): unknown
        debug(obj: unknown, msg?: string): unknown
        info(obj: unknown, msg?: string): unknown
        warn(obj: unknown, msg?: string): unknown
        error(obj: unknown, msg?: string): unknown
      }
      const baileysLogger: ILogger = {
        level: 'silent',
        child: () => baileysLogger,
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }

      const sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: !this.options.pairingPhoneNumber,
        generateHighQualityLinkPreview: false,
      }) as unknown as BaileysSocket

      this.sock = sock

      // Request pairing code for headless auth
      if (this.options.pairingPhoneNumber && !state.creds.registered) {
        try {
          const code = await sock.requestPairingCode(this.options.pairingPhoneNumber)
          log.info({ code }, '[WHATSAPP_CLIENT] Pairing code generated — enter this in WhatsApp > Linked Devices')
        } catch (err) {
          log.error({ err }, '[WHATSAPP_CLIENT] Failed to request pairing code')
        }
      }

      // Wire up event listeners
      sock.ev.on('creds.update', saveCreds as unknown as (...args: unknown[]) => void)
      sock.ev.on('creds.update', this.options.listeners.onCredsUpdate as unknown as (...args: unknown[]) => void)

      sock.ev.on('connection.update', (update: unknown) => {
        const conn = update as ConnectionUpdate
        this.options.listeners.onConnectionUpdate(conn)

        if (conn.connection === 'open') {
          this.reconnectAttempt = 0
          log.info('[WHATSAPP_CLIENT] Connected to WhatsApp')
        }

        if (conn.connection === 'close') {
          const statusCode = conn.lastDisconnect?.error?.output?.statusCode
          this.sock = null

          // Do not reconnect on explicit logout or session replacement
          if (statusCode === DisconnectReason.loggedOut) {
            log.warn('[WHATSAPP_CLIENT] Logged out — not reconnecting. Re-scan QR to link again.')
            this.stopped = true
            return
          }
          if (statusCode === DisconnectReason.connectionReplaced) {
            log.warn('[WHATSAPP_CLIENT] Connection replaced by another session — not reconnecting')
            this.stopped = true
            return
          }
          if (statusCode === DisconnectReason.multideviceMismatch) {
            log.warn('[WHATSAPP_CLIENT] Multi-device mismatch — session invalid, not reconnecting. Re-link device to fix.')
            this.stopped = true
            return
          }

          this.scheduleReconnect()
        }
      })

      sock.ev.on('messages.upsert', (upsert: unknown) => {
        this.options.listeners.onMessagesUpsert(upsert as MessageUpsert)
      })

      // Ignore history sync — we only process live messages
      sock.ev.on('messaging-history.set', () => {
        log.debug('[WHATSAPP_CLIENT] History sync received — ignoring')
      })
    } catch (err) {
      log.error({ err }, '[WHATSAPP_CLIENT] Failed to create socket')
      this.sock = null
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectAttempt >= this.reconnectConfig.maxAttempts) {
      log.error('[WHATSAPP_CLIENT] Max reconnect attempts reached — giving up')
      this.stopped = true
      return
    }

    const delays = this.reconnectConfig.delays
    const delayIdx = Math.min(this.reconnectAttempt, delays.length - 1)
    const delay = delays[delayIdx]!
    // Add jitter: +/- 20% of the delay
    const jitter = delay * 0.2 * (Math.random() * 2 - 1)
    const finalDelay = Math.max(500, Math.round(delay + jitter))

    this.reconnectAttempt++
    log.info(
      { attempt: this.reconnectAttempt, delay: finalDelay },
      '[WHATSAPP_CLIENT] Scheduling reconnect',
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.createSocket()
    }, finalDelay)
  }
}
