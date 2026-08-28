/**
 * Client tests — MattermostClient API operations with mocked fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MattermostClient, MattermostApiError, normalizeBaseUrl } from '../client.js'

function makeJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 429 ? 'Too Many Requests' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  } as unknown as Response
}

function make429Response(retryAfter = 2): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    'X-Ratelimit-Reset': String(Math.floor(Date.now() / 1000) + retryAfter),
  })
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers,
    json: vi.fn().mockResolvedValue({ message: 'rate limited' }),
    text: vi.fn().mockResolvedValue('rate limited'),
  } as unknown as Response
}

function make204Response(): Response {
  return {
    ok: true,
    status: 204,
    statusText: 'No Content',
    headers: new Headers(),
    json: vi.fn(),
    text: vi.fn(),
  } as unknown as Response
}

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://mm.example.com/')).toBe('https://mm.example.com')
    expect(normalizeBaseUrl('https://mm.example.com///')).toBe('https://mm.example.com')
  })

  it('strips /api/v4 suffix', () => {
    expect(normalizeBaseUrl('https://mm.example.com/api/v4')).toBe('https://mm.example.com')
  })

  it('handles clean URLs', () => {
    expect(normalizeBaseUrl('https://mm.example.com')).toBe('https://mm.example.com')
  })
})

describe('MattermostClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let client: MattermostClient

  beforeEach(() => {
    fetchMock = vi.fn()
    client = new MattermostClient({
      url: 'https://mm.example.com',
      token: 'test-token',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
  })

  it('sends Authorization header on requests', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ id: 'user-1', username: 'bot' }))
    await client.getMe()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer test-token')
  })

  it('builds correct API URL', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ id: 'user-1', username: 'bot' }))
    await client.getMe()
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://mm.example.com/api/v4/users/me')
  })

  it('getMe returns user data', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ id: 'u1', username: 'mybot' }))
    const me = await client.getMe()
    expect(me.id).toBe('u1')
    expect(me.username).toBe('mybot')
  })

  it('createPost sends correct payload', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ id: 'p1', message: 'hello' }))
    const post = await client.createPost({
      channelId: 'ch-1',
      message: 'hello',
      rootId: 'root-1',
    })
    expect(post.id).toBe('p1')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.channel_id).toBe('ch-1')
    expect(body.message).toBe('hello')
    expect(body.root_id).toBe('root-1')
  })

  it('updatePost uses PUT method', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ id: 'p1', message: 'updated' }))
    await client.updatePost('p1', { message: 'updated' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/posts/p1')
    expect(init.method).toBe('PUT')
  })

  it('deletePost uses DELETE method', async () => {
    fetchMock.mockResolvedValueOnce(make204Response())
    await client.deletePost('p1')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/posts/p1')
    expect(init.method).toBe('DELETE')
  })

  it('handles 204 No Content responses', async () => {
    fetchMock.mockResolvedValueOnce(make204Response())
    const result = await client.deletePost('p1')
    expect(result).toBeUndefined()
  })

  it('retries on 429 rate limit', async () => {
    fetchMock
      .mockResolvedValueOnce(make429Response(0))
      .mockResolvedValueOnce(makeJsonResponse({ id: 'p1' }))

    const post = await client.createPost({ channelId: 'ch-1', message: 'hi' })
    expect(post.id).toBe('p1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws MattermostApiError on non-429 failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue({ message: 'Access denied' }),
    } as unknown as Response)

    await expect(client.getMe()).rejects.toThrow(MattermostApiError)
    await expect(client.getMe()).rejects.toThrow(/403/)
  })

  it('throws MattermostApiError with status 401 on auth failure', async () => {
    const make401 = () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue({ message: 'Invalid or expired token' }),
    } as unknown as Response)

    fetchMock.mockResolvedValueOnce(make401())
    await expect(client.getMe()).rejects.toThrow(MattermostApiError)

    fetchMock.mockResolvedValueOnce(make401())
    try {
      await client.getMe()
    } catch (err) {
      expect(err).toBeInstanceOf(MattermostApiError)
      expect((err as MattermostApiError).status).toBe(401)
    }
  })

  it('does not retry on 401 (auth errors should not be retried)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue({ message: 'Invalid token' }),
    } as unknown as Response)

    await expect(client.getMe()).rejects.toThrow(MattermostApiError)
    // 401 should throw immediately without retrying
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws on network failure (fetch rejects)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(client.getMe()).rejects.toThrow('fetch failed')
  })

  it('getUserByUsername URL-encodes the username', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ id: 'u1', username: 'some.user' }))
    await client.getUserByUsername('some.user')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/users/username/some.user')
  })

  it('createDirectChannel sends user IDs array', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ id: 'dm-ch', type: 'D' }))
    const ch = await client.createDirectChannel(['u1', 'u2'])
    expect(ch.id).toBe('dm-ch')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual(['u1', 'u2'])
  })

  it('addReaction sends correct payload', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ user_id: 'u1', post_id: 'p1', emoji_name: 'thumbsup' }))
    const reaction = await client.addReaction('u1', 'p1', 'thumbsup')
    expect(reaction.emoji_name).toBe('thumbsup')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, string>
    expect(body.user_id).toBe('u1')
    expect(body.post_id).toBe('p1')
  })

  it('removeReaction uses DELETE with correct URL', async () => {
    fetchMock.mockResolvedValueOnce(make204Response())
    await client.removeReaction('u1', 'p1', 'thumbsup')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/users/u1/posts/p1/reactions/thumbsup')
    expect(init.method).toBe('DELETE')
  })

  it('sendTyping sends correct payload', async () => {
    fetchMock.mockResolvedValueOnce(make204Response())
    await client.sendTyping('ch-1', 'root-1')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, string>
    expect(body.channel_id).toBe('ch-1')
    expect(body.parent_id).toBe('root-1')
  })

  it('getPostsSince builds correct URL', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ order: [], posts: {} }))
    await client.getPostsSince('ch-1', 1234567890)
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/channels/ch-1/posts?since=1234567890')
  })

  it('sets Content-Type for JSON body', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ id: 'p1' }))
    await client.createPost({ channelId: 'ch-1', message: 'hi' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
  })
})

describe('MattermostClient.uploadFile', () => {
  it('uses multipart form and POST', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue({
        file_infos: [{ id: 'f1', name: 'test.txt', mime_type: 'text/plain', size: 5 }],
      }),
    } as unknown as Response)

    const client = new MattermostClient({
      url: 'https://mm.example.com',
      token: 'token',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const result = await client.uploadFile({
      channelId: 'ch-1',
      buffer: new Uint8Array([72, 101, 108, 108, 111]),
      fileName: 'test.txt',
      contentType: 'text/plain',
    })

    expect(result.id).toBe('f1')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/files')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
  })
})
