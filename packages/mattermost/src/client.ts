/**
 * MattermostClient — REST API v4 wrapper using native fetch with Bearer auth.
 *
 * Handles rate limiting (429 + X-Ratelimit-Reset), JSON parsing, multipart
 * file uploads, and structured error extraction.
 */

import { createChildLogger } from '@openacp/plugin-sdk'
import type {
  MattermostUser,
  MattermostChannel,
  MattermostPost,
  MattermostFileInfo,
  MattermostReaction,
} from './types.js'

const log = createChildLogger({ module: 'mattermost:client' })

const MAX_RETRIES = 3
const DEFAULT_RETRY_AFTER_S = 5

export interface MattermostClientOptions {
  /** Base URL without trailing slash, e.g. "https://mattermost.example.com" */
  url: string
  /** Bot personal access token */
  token: string
  /** Optional custom fetch implementation (for testing) */
  fetchImpl?: typeof fetch
}

/**
 * Normalize a Mattermost base URL: strip trailing slashes and `/api/v4` suffix.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  url = url.replace(/\/api\/v4$/i, '')
  return url
}

/**
 * Extract a human-readable error message from a Mattermost API error response.
 */
async function readApiError(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const data = (await res.json()) as { message?: string; id?: string } | undefined
    if (data?.message) return data.message
    return JSON.stringify(data)
  }
  return await res.text()
}

export class MattermostClient {
  private readonly baseUrl: string
  private readonly apiBase: string
  private readonly token: string
  private readonly fetchFn: typeof fetch

  constructor(opts: MattermostClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.url)
    this.apiBase = `${this.baseUrl}/api/v4`
    this.token = opts.token.trim()
    this.fetchFn = opts.fetchImpl ?? fetch
  }

  /** The normalized base URL (for WS URL derivation) */
  getBaseUrl(): string {
    return this.baseUrl
  }

  /** The bearer token */
  getToken(): string {
    return this.token
  }

  /**
   * Execute a request against the Mattermost API v4 with automatic
   * rate-limit handling (retry on 429).
   */
  async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const url = `${this.apiBase}${path.startsWith('/') ? path : `/${path}`}`
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    if (typeof init?.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await this.fetchFn(url, { ...init, headers })

      if (res.ok) {
        if (res.status === 204) return undefined as T
        const ct = res.headers.get('content-type') ?? ''
        if (ct.includes('application/json')) return (await res.json()) as T
        return (await res.text()) as T
      }

      // Rate limited
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const resetHeader = res.headers.get('X-Ratelimit-Reset')
        let waitMs: number
        if (resetHeader) {
          const resetEpoch = parseInt(resetHeader, 10)
          waitMs = Math.max(1000, (resetEpoch * 1000) - Date.now())
        } else {
          waitMs = (DEFAULT_RETRY_AFTER_S + 1) * 1000
        }
        log.warn(
          { url, attempt: attempt + 1, waitMs },
          '[MM_CLIENT_RATELIMIT] Rate limited, retrying',
        )
        await sleep(waitMs)
        continue
      }

      // Auth error detection — emit structured error for 401
      if (res.status === 401) {
        const detail = await readApiError(res)
        throw new MattermostApiError(res.status, res.statusText, detail, url)
      }

      const detail = await readApiError(res)
      throw new MattermostApiError(res.status, res.statusText, detail, url)
    }

    // Should not reach here, but satisfy TypeScript
    throw new Error('Max retries exceeded')
  }

  // ─── Convenience methods ─────────────────────────────────────────────────

  /** Get the currently authenticated user (bot user) */
  async getMe(): Promise<MattermostUser> {
    return this.request<MattermostUser>('/users/me')
  }

  /** Get a user by ID */
  async getUser(userId: string): Promise<MattermostUser> {
    return this.request<MattermostUser>(`/users/${userId}`)
  }

  /** Get a user by username */
  async getUserByUsername(username: string): Promise<MattermostUser> {
    return this.request<MattermostUser>(
      `/users/username/${encodeURIComponent(username)}`,
    )
  }

  /** Bulk resolve usernames to users */
  async getUsersByUsernames(usernames: string[]): Promise<MattermostUser[]> {
    return this.request<MattermostUser[]>('/users/usernames', {
      method: 'POST',
      body: JSON.stringify(usernames),
    })
  }

  /** Get a channel by ID */
  async getChannel(channelId: string): Promise<MattermostChannel> {
    return this.request<MattermostChannel>(`/channels/${channelId}`)
  }

  /** Create or get a direct message channel (idempotent) */
  async createDirectChannel(userIds: [string, string]): Promise<MattermostChannel> {
    return this.request<MattermostChannel>('/channels/direct', {
      method: 'POST',
      body: JSON.stringify(userIds),
    })
  }

  /** Create a post */
  async createPost(params: {
    channelId: string
    message: string
    rootId?: string
    fileIds?: string[]
    props?: Record<string, unknown>
  }): Promise<MattermostPost> {
    const payload: Record<string, unknown> = {
      channel_id: params.channelId,
      message: params.message,
    }
    if (params.rootId) payload.root_id = params.rootId
    if (params.fileIds?.length) payload.file_ids = params.fileIds
    if (params.props) payload.props = params.props
    return this.request<MattermostPost>('/posts', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  /** Update (edit) a post in-place */
  async updatePost(postId: string, params: {
    message: string
    props?: Record<string, unknown>
  }): Promise<MattermostPost> {
    return this.request<MattermostPost>(`/posts/${postId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: postId,
        message: params.message,
        ...(params.props ? { props: params.props } : {}),
      }),
    })
  }

  /** Delete a post */
  async deletePost(postId: string): Promise<void> {
    await this.request<unknown>(`/posts/${postId}`, {
      method: 'DELETE',
    })
  }

  /** Get a single post */
  async getPost(postId: string): Promise<MattermostPost> {
    return this.request<MattermostPost>(`/posts/${postId}`)
  }

  /** Get posts in a channel since a given timestamp (for backfill after reconnect) */
  async getPostsSince(channelId: string, since: number): Promise<{
    order: string[]
    posts: Record<string, MattermostPost>
  }> {
    return this.request(`/channels/${channelId}/posts?since=${since}`)
  }

  /** Upload a file to a channel (multipart form) */
  async uploadFile(params: {
    channelId: string
    buffer: Uint8Array
    fileName: string
    contentType?: string
  }): Promise<MattermostFileInfo> {
    const form = new FormData()
    // Cast to BlobPart-compatible Uint8Array. Node's FormData accepts Uint8Array
    // but TS strict mode wants ArrayBuffer-backed. The runtime works either way.
    const blobData: BlobPart = params.buffer as unknown as BlobPart
    const blob = params.contentType
      ? new Blob([blobData], { type: params.contentType })
      : new Blob([blobData])
    form.append('files', blob, params.fileName)
    form.append('channel_id', params.channelId)

    const res = await this.fetchFn(`${this.apiBase}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    })

    if (!res.ok) {
      const detail = await readApiError(res)
      throw new MattermostApiError(res.status, res.statusText, detail, `${this.apiBase}/files`)
    }

    const data = (await res.json()) as { file_infos?: MattermostFileInfo[] }
    const info = data.file_infos?.[0]
    if (!info?.id) throw new Error('Mattermost file upload returned no file info')
    return info
  }

  /** Add a reaction to a post */
  async addReaction(userId: string, postId: string, emojiName: string): Promise<MattermostReaction> {
    return this.request<MattermostReaction>('/reactions', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        post_id: postId,
        emoji_name: emojiName,
      }),
    })
  }

  /** Remove a reaction from a post */
  async removeReaction(userId: string, postId: string, emojiName: string): Promise<void> {
    const emoji = encodeURIComponent(emojiName)
    await this.request<unknown>(
      `/users/${userId}/posts/${postId}/reactions/${emoji}`,
      { method: 'DELETE' },
    )
  }

  /** Get file metadata by ID */
  async getFileInfo(fileId: string): Promise<MattermostFileInfo> {
    return this.request<MattermostFileInfo>(`/files/${fileId}/info`)
  }

  /** Download file contents as ArrayBuffer */
  async getFile(fileId: string): Promise<ArrayBuffer> {
    const url = `${this.apiBase}/files/${fileId}`
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${this.token}`)
    const res = await this.fetchFn(url, { headers })
    if (!res.ok) {
      const detail = await readApiError(res)
      throw new MattermostApiError(res.status, res.statusText, detail, url)
    }
    return res.arrayBuffer()
  }

  /** Set a user's online status. Pass the actual user ID, not "me" — Mattermost
   *  API requires the user_id in both URL and body to match a real user. */
  async setStatus(userId: string, status: 'online' | 'away' | 'offline' | 'dnd'): Promise<void> {
    await this.request<unknown>(`/users/${userId}/status`, {
      method: 'PUT',
      body: JSON.stringify({
        user_id: userId,
        status,
      }),
    })
  }

  /** Send typing indicator via REST (alternative to WS action) */
  async sendTyping(channelId: string, parentId?: string): Promise<void> {
    const payload: Record<string, string> = { channel_id: channelId }
    if (parentId?.trim()) payload.parent_id = parentId
    await this.request<unknown>('/users/me/typing', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }
}

// ─── Error class ─────────────────────────────────────────────────────────────

export class MattermostApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly detail: string,
    public readonly url: string,
  ) {
    super(`Mattermost API ${status} ${statusText}: ${detail}`)
    this.name = 'MattermostApiError'
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
