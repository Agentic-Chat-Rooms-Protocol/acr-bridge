import { createChildLogger } from '@openacp/plugin-sdk'
import type { SignalClient } from './client.js'
import type { SignalAttachment } from './types.js'

const log = createChildLogger({ module: 'signal:media' })

// ─── Inbound ─────────────────────────────────────────────────────────────────

/** Resolved attachment with fetched data. */
export interface ResolvedAttachment {
  data: Buffer
  contentType: string
  filename: string
  size: number
  isVoiceNote: boolean
}

/**
 * Fetch and resolve an inbound Signal attachment.
 *
 * Downloads the attachment from the signal-cli-rest-api by its ID
 * and returns the binary data with metadata.
 */
export async function resolveInboundAttachment(
  client: SignalClient,
  attachment: SignalAttachment,
): Promise<ResolvedAttachment | null> {
  try {
    const { data, contentType } = await client.fetchAttachment(attachment.id)
    const filename = attachment.filename ?? generateFilename(attachment.contentType)
    return {
      data,
      contentType: attachment.contentType ?? contentType,
      filename,
      size: data.length,
      isVoiceNote: attachment.voiceNote === true,
    }
  } catch (err) {
    log.warn(
      { err, attachmentId: attachment.id },
      '[SIGNAL_MEDIA] Failed to resolve inbound attachment',
    )
    return null
  }
}

/**
 * Resolve all attachments from an inbound message.
 */
export async function resolveAllAttachments(
  client: SignalClient,
  attachments: SignalAttachment[],
): Promise<ResolvedAttachment[]> {
  const results: ResolvedAttachment[] = []
  for (const attachment of attachments) {
    const resolved = await resolveInboundAttachment(client, attachment)
    if (resolved) {
      results.push(resolved)
    }
  }
  return results
}

// ─── Outbound ────────────────────────────────────────────────────────────────

/**
 * Encode a buffer as a base64 data URI for signal-cli-rest-api.
 * The API expects attachments in the format "data:<mime>;base64,<data>".
 */
export function encodeAttachment(data: Buffer, contentType: string): string {
  const base64 = data.toString('base64')
  return `data:${contentType};base64,${base64}`
}

/**
 * Encode a file path's content as a base64 attachment.
 * Reads the file, determines content type, and returns the data URI.
 */
export function encodeBufferAttachment(buffer: Buffer, filename: string): string {
  const contentType = inferContentType(filename)
  return encodeAttachment(buffer, contentType)
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Generate a filename from a MIME type when none is provided. */
function generateFilename(contentType: string): string {
  const ext = mimeToExtension(contentType)
  return `attachment${ext}`
}

/** Map common MIME types to file extensions. */
function mimeToExtension(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/aac': '.aac',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json',
  }
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return map[base] ?? ''
}

/** Infer content type from a filename extension. */
function inferContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'aac': 'audio/aac',
    'm4a': 'audio/mp4',
    'mp3': 'audio/mpeg',
    'ogg': 'audio/ogg',
    'wav': 'audio/wav',
    'mp4': 'video/mp4',
    '3gp': 'video/3gpp',
    'pdf': 'application/pdf',
    'txt': 'text/plain',
    'json': 'application/json',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * Detect if a content type represents a voice note.
 */
export function isVoiceNoteContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return base.startsWith('audio/')
}

/**
 * Detect if a content type represents an image.
 */
export function isImageContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return base.startsWith('image/')
}
