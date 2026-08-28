import { createChildLogger } from '@openacp/plugin-sdk'
import type { SignalSseEventData, SignalEnvelope, ReconnectConfig } from './types.js'
import { DEFAULT_RECONNECT_CONFIG } from './types.js'

const log = createChildLogger({ module: 'signal:events' })

// ─── SSE Event Parsing ───────────────────────────────────────────────────────

/** Raw SSE field accumulator. */
interface SseFrame {
  event?: string
  data?: string
  id?: string
}

/**
 * Parse raw SSE text into individual event frames.
 *
 * SSE events are separated by blank lines. Each field within an event
 * is on its own line in the format `field: value`.
 */
export function parseSseChunk(chunk: string): SseFrame[] {
  const frames: SseFrame[] = []
  let current: SseFrame = {}

  const lines = chunk.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line === '') {
      // Blank line = event boundary
      if (current.data !== undefined || current.event !== undefined || current.id !== undefined) {
        frames.push(current)
        current = {}
      }
      continue
    }

    // Comment lines (prefixed with `:`) are ignored per SSE spec
    if (line.startsWith(':')) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      // Fieldname only, no value
      continue
    }

    const field = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1)
    // Per SSE spec, strip single leading space after colon
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }

    if (field === 'event') {
      current.event = value
    } else if (field === 'data') {
      // SSE spec: multiple data fields are joined with newlines
      current.data = current.data !== undefined ? `${current.data}\n${value}` : value
    } else if (field === 'id') {
      current.id = value
    }
  }

  // Flush any remaining event (stream may not end with a blank line)
  if (current.data !== undefined || current.event !== undefined || current.id !== undefined) {
    frames.push(current)
  }

  return frames
}

/**
 * Parse a single SSE data payload into a SignalSseEventData.
 * Returns null if the data is not valid JSON or doesn't contain an envelope.
 */
export function parseEnvelopeData(data: string): SignalSseEventData | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null

    const envelope = parsed['envelope'] as SignalEnvelope | undefined
    if (!envelope || typeof envelope !== 'object') return null

    return {
      envelope,
      account: typeof parsed['account'] === 'string' ? parsed['account'] : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Extract the session key from an envelope.
 * Uses groupId for group messages, sourceNumber for 1:1 chats.
 */
export function extractSessionKey(envelope: SignalEnvelope): string | null {
  const groupId = envelope.dataMessage?.groupInfo?.groupId
  if (groupId) return `group:${groupId}`

  const number = envelope.sourceNumber ?? envelope.source
  if (number) return number

  return null
}

/**
 * Determine if an envelope is a group message.
 */
export function isGroupMessage(envelope: SignalEnvelope): boolean {
  return !!envelope.dataMessage?.groupInfo?.groupId
}

/**
 * Extract the sender's display name from an envelope.
 */
export function extractSenderName(envelope: SignalEnvelope): string {
  return envelope.sourceName ?? envelope.sourceNumber ?? envelope.source ?? 'Unknown'
}

/**
 * Extract the sender's identifier (phone number or UUID).
 */
export function extractSenderId(envelope: SignalEnvelope): string {
  return envelope.sourceNumber ?? envelope.sourceUuid ?? envelope.source ?? ''
}

// ─── SSE Stream Handler ──────────────────────────────────────────────────────

export interface SseStreamOptions {
  /** Full SSE URL to connect to. */
  url: string
  /** Authorization header value. */
  authHeader?: string
  /** AbortSignal to cancel the stream. */
  signal?: AbortSignal
  /** Called for each parsed Signal event. */
  onEvent: (event: SignalSseEventData) => void
  /** Called when the stream encounters an error (before reconnect). */
  onError?: (error: Error) => void
  /** Called when the stream connects successfully. */
  onConnected?: () => void
}

/** Error subclass for authentication failures (401/403). */
export class SseAuthError extends Error {
  readonly statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'SseAuthError'
    this.statusCode = statusCode
  }
}

/**
 * Connect to the signal-cli-rest-api SSE endpoint and process events.
 *
 * This function handles a single connection lifecycle. It reads the
 * response body as a stream, parses SSE frames, and emits parsed
 * Signal events via the onEvent callback.
 *
 * Throws on connection failure or stream abort.
 * Throws SseAuthError on 401/403 responses.
 */
export async function connectSseStream(options: SseStreamOptions): Promise<void> {
  const headers: Record<string, string> = {
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache',
  }
  if (options.authHeader) {
    headers['Authorization'] = options.authHeader
  }

  const res = await fetch(options.url, {
    method: 'GET',
    headers,
    signal: options.signal,
  })

  if (res.status === 401 || res.status === 403) {
    throw new SseAuthError(res.status, `[SIGNAL_SSE] Authentication failed: ${res.status} ${res.statusText}`)
  }

  if (!res.ok) {
    throw new Error(`[SIGNAL_SSE] Connection failed: ${res.status} ${res.statusText}`)
  }

  if (!res.body) {
    throw new Error('[SIGNAL_SSE] Response has no body')
  }

  options.onConnected?.()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE frames (separated by double newline)
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary + 2)
        buffer = buffer.slice(boundary + 2)

        const frames = parseSseChunk(chunk)
        for (const frame of frames) {
          if (!frame.data) continue
          const event = parseEnvelopeData(frame.data)
          if (event) {
            options.onEvent(event)
          }
        }

        boundary = buffer.indexOf('\n\n')
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const frames = parseSseChunk(buffer)
      for (const frame of frames) {
        if (!frame.data) continue
        const event = parseEnvelopeData(frame.data)
        if (event) {
          options.onEvent(event)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── Reconnecting SSE Loop ──────────────────────────────────────────────────

export interface SseLoopOptions {
  /** Full SSE URL. */
  url: string
  /** Authorization header. */
  authHeader?: string
  /** AbortSignal to stop the loop. */
  signal?: AbortSignal
  /** Called for each parsed Signal event. */
  onEvent: (event: SignalSseEventData) => void
  /** Called on connection error. */
  onError?: (error: Error) => void
  /** Called when connection is established. */
  onConnected?: () => void
  /** Called when reconnecting (with attempt number). */
  onReconnecting?: (attempt: number) => void
  /** Called on authentication failure (401/403). Loop will stop. */
  onAuthError?: (error: Error) => void
  /** Reconnect configuration. */
  reconnect?: Partial<ReconnectConfig>
}

/**
 * Compute backoff delay with jitter.
 */
export function computeBackoff(config: ReconnectConfig, attempt: number): number {
  const baseDelay = Math.min(
    config.initialDelayMs * Math.pow(config.factor, attempt),
    config.maxDelayMs,
  )
  const jitterRange = baseDelay * config.jitter
  const jitter = (Math.random() * 2 - 1) * jitterRange
  return Math.max(500, Math.round(baseDelay + jitter))
}

/**
 * Run a reconnecting SSE loop.
 *
 * Connects to the SSE endpoint and automatically reconnects on failure
 * with exponential backoff. Stops when the AbortSignal is triggered or
 * when max reconnect attempts are exceeded.
 */
export async function runSseLoop(options: SseLoopOptions): Promise<void> {
  const config: ReconnectConfig = {
    ...DEFAULT_RECONNECT_CONFIG,
    ...options.reconnect,
  }
  let reconnectAttempt = 0

  while (!options.signal?.aborted) {
    try {
      await connectSseStream({
        url: options.url,
        authHeader: options.authHeader,
        signal: options.signal,
        onEvent: (event) => {
          // Reset reconnect counter on successful event
          reconnectAttempt = 0
          options.onEvent(event)
        },
        onError: options.onError,
        onConnected: () => {
          reconnectAttempt = 0
          options.onConnected?.()
        },
      })

      // Stream ended gracefully
      if (options.signal?.aborted) return
    } catch (err) {
      if (options.signal?.aborted) return

      const error = err instanceof Error ? err : new Error(String(err))

      // Auth failures are non-recoverable -- do not reconnect
      if (error instanceof SseAuthError) {
        log.error(
          { statusCode: error.statusCode },
          '[SIGNAL_SSE] Authentication failure -- stopping SSE loop',
        )
        options.onAuthError?.(error)
        return
      }

      options.onError?.(error)
    }

    // Check reconnect limit
    reconnectAttempt++
    if (reconnectAttempt > config.maxAttempts) {
      log.error(
        { attempts: reconnectAttempt },
        '[SIGNAL_SSE] Max reconnect attempts exceeded -- giving up',
      )
      return
    }

    const delayMs = computeBackoff(config, reconnectAttempt)
    options.onReconnecting?.(reconnectAttempt)
    log.info(
      { attempt: reconnectAttempt, delayMs },
      '[SIGNAL_SSE] Reconnecting...',
    )

    // Wait before reconnecting
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      if (options.signal) {
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}
