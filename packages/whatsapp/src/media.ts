import { createChildLogger } from '@openacp/plugin-sdk'
import type { BaileysSocket } from './client.js'

const log = createChildLogger({ module: 'whatsapp:media' })

/**
 * Supported outbound media types for WhatsApp.
 */
export type MediaType = 'image' | 'audio' | 'video' | 'document'

/**
 * Options for sending media.
 */
export interface SendMediaOptions {
  jid: string
  buffer: Buffer
  type: MediaType
  mimetype: string
  fileName?: string
  caption?: string
  /** Whether this audio should be sent as a voice note (push-to-talk). */
  ptt?: boolean
}

/**
 * Download media from an inbound WhatsApp message.
 *
 * Uses Baileys' `downloadMediaMessage` utility to fetch the decrypted media buffer.
 * Returns null if the message has no downloadable media.
 */
export async function downloadMedia(message: unknown): Promise<{
  buffer: Buffer
  mimetype: string
  fileName?: string
} | null> {
  try {
    const baileys = await import('@whiskeysockets/baileys')
    const { downloadMediaMessage } = baileys

    const buffer = await downloadMediaMessage(
      message as Parameters<typeof downloadMediaMessage>[0],
      'buffer',
      {},
    ) as Buffer

    // Extract mimetype from message
    const msg = message as Record<string, unknown>
    const mediaMsg =
      (msg.message as Record<string, unknown>)?.imageMessage ??
      (msg.message as Record<string, unknown>)?.audioMessage ??
      (msg.message as Record<string, unknown>)?.videoMessage ??
      (msg.message as Record<string, unknown>)?.documentMessage ??
      (msg.message as Record<string, unknown>)?.stickerMessage

    const media = mediaMsg as Record<string, unknown> | undefined
    const mimetype = (media?.mimetype as string) ?? 'application/octet-stream'
    const fileName = (media?.fileName as string) ?? undefined

    return { buffer, mimetype, fileName }
  } catch (err) {
    log.warn({ err }, '[WHATSAPP_MEDIA] Failed to download media')
    return null
  }
}

/**
 * Send media message via WhatsApp.
 *
 * Routes to the correct Baileys message type based on media type.
 */
export async function sendMedia(
  sock: BaileysSocket,
  options: SendMediaOptions,
): Promise<void> {
  const { jid, buffer, type, mimetype, fileName, caption, ptt } = options

  try {
    switch (type) {
      case 'image':
        await sock.sendMessage(jid, {
          image: buffer,
          caption: caption ?? undefined,
          mimetype,
        })
        break

      case 'audio':
        await sock.sendMessage(jid, {
          audio: buffer,
          ptt: ptt ?? false,
          mimetype,
        })
        break

      case 'video':
        await sock.sendMessage(jid, {
          video: buffer,
          caption: caption ?? undefined,
          mimetype,
        })
        break

      case 'document':
        await sock.sendMessage(jid, {
          document: buffer,
          fileName: fileName ?? 'file',
          mimetype,
        })
        break
    }
  } catch (err) {
    log.error({ err, jid, type, mimetype }, '[WHATSAPP_MEDIA] Failed to send media')
    throw err
  }
}

/**
 * Detect media type from mimetype string.
 */
export function detectMediaType(mimetype: string): MediaType {
  if (mimetype.startsWith('image/')) return 'image'
  if (mimetype.startsWith('audio/')) return 'audio'
  if (mimetype.startsWith('video/')) return 'video'
  return 'document'
}

/**
 * Check if an inbound message is a voice note (push-to-talk).
 */
export function isVoiceNote(message: unknown): boolean {
  const msg = message as Record<string, unknown>
  const audioMsg = (msg.message as Record<string, unknown>)?.audioMessage as Record<string, unknown> | undefined
  return audioMsg?.ptt === true
}

/**
 * Check if an inbound message has downloadable media.
 */
export function hasMedia(message: unknown): boolean {
  const msg = message as Record<string, unknown>
  const inner = msg.message as Record<string, unknown> | undefined
  if (!inner) return false
  return !!(
    inner.imageMessage ??
    inner.audioMessage ??
    inner.videoMessage ??
    inner.documentMessage ??
    inner.stickerMessage
  )
}
