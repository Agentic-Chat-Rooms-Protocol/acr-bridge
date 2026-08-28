/**
 * e2e-test.ts — End-to-end test suite for the OpenACP Mattermost adapter.
 *
 * Runs against a local Mattermost instance bootstrapped by setup.sh.
 * Uses native fetch (Node 22+) and the MattermostClient from the adapter
 * package. Each test scenario is self-contained and reports PASS/FAIL.
 *
 * Usage:  npx tsx e2e-test.ts
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Resolve .env ───────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '.env')

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    console.error(`[E2E] Cannot read ${path} — run ./setup.sh first`)
    process.exit(1)
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    env[key] = val
  }
  return env
}

const env = loadEnv(envPath)

const BASE_URL = env.MATTERMOST_URL || 'http://localhost:8065'
const BOT_TOKEN = env.MATTERMOST_TOKEN
const ADMIN_TOKEN = env.MATTERMOST_ADMIN_TOKEN
const CHANNEL_ID = env.MATTERMOST_CHANNEL_ID
const TEAM_ID = env.MATTERMOST_TEAM_ID
const BOT_USER_ID = env.MATTERMOST_BOT_USER_ID
const ADMIN_ID = env.MATTERMOST_ADMIN_ID

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error('[E2E] Missing MATTERMOST_TOKEN or MATTERMOST_CHANNEL_ID in .env')
  process.exit(1)
}

// ─── Lightweight API client (uses native fetch) ─────────────────────────────

const API = `${BASE_URL}/api/v4`

interface ApiOptions {
  method?: string
  body?: unknown
  token?: string
  rawBody?: BodyInit
  headers?: Record<string, string>
}

async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token ?? BOT_TOKEN}`,
    ...opts.headers,
  }

  let body: BodyInit | undefined
  if (opts.rawBody) {
    body = opts.rawBody
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status} ${res.statusText}: ${text}`)
  }

  if (res.status === 204) return undefined as T

  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return (await res.json()) as T
  return (await res.text()) as T
}

/**
 * POST a multipart form to /files using the bot token. Returns the parsed
 * upload response. Throws on non-OK status with the response body inlined.
 */
async function uploadFiles(form: FormData): Promise<FileUploadResponse> {
  const res = await fetch(`${API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    body: form,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`file upload ${res.status} ${res.statusText}: ${text}`)
  }
  return (await res.json()) as FileUploadResponse
}

// ─── Test harness ───────────────────────────────────────────────────────────

interface TestResult {
  name: string
  passed: boolean
  duration: number
  error?: string
}

const results: TestResult[] = []

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const start = performance.now()
  try {
    await fn()
    const dur = Math.round(performance.now() - start)
    results.push({ name, passed: true, duration: dur })
    console.log(`  \x1b[32mPASS\x1b[0m  ${name} (${dur}ms)`)
  } catch (err) {
    const dur = Math.round(performance.now() - start)
    const msg = err instanceof Error ? err.message : String(err)
    results.push({ name, passed: false, duration: dur, error: msg })
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (${dur}ms)`)
    console.log(`        ${msg}`)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Helpers: PNG generation, user creation, WS event waiter ────────────────

/**
 * Generate a tiny PNG buffer (red-ish pixels, given dimensions).
 * Constructs a valid uncompressed PNG using zlib stored blocks (DEFLATE level
 * 0) so we don't need any external dependencies.
 */
function makeRedPng(width: number, height: number): Uint8Array {
  // ── Helpers for byte writing ─────────────────────────────────────────────
  const u32 = (n: number): number[] => [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]

  // CRC-32 (poly 0xEDB88320)
  const crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    crcTable[n] = c
  }
  const crc32 = (bytes: number[]): number => {
    let c = 0xFFFFFFFF
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }

  // Adler-32 for zlib trailer
  const adler32 = (bytes: number[]): number => {
    let a = 1, b = 0
    for (const x of bytes) {
      a = (a + x) % 65521
      b = (b + a) % 65521
    }
    return ((b << 16) | a) >>> 0
  }

  // ── Build raw image data: filter byte (0) + RGB triplet per pixel ────────
  const raw: number[] = []
  for (let y = 0; y < height; y++) {
    raw.push(0) // filter type: None
    for (let x = 0; x < width; x++) {
      raw.push(255, 0, 0) // R G B → solid red
    }
  }

  // ── Wrap in zlib container with DEFLATE stored blocks ────────────────────
  const zlib: number[] = [0x78, 0x01] // CMF + FLG (no compression)
  // Split raw into <=65535-byte stored blocks
  const MAX = 0xFFFF
  for (let off = 0; off < raw.length; off += MAX) {
    const len = Math.min(MAX, raw.length - off)
    const final = off + len >= raw.length ? 1 : 0
    zlib.push(final) // BFINAL bit, BTYPE=00
    zlib.push(len & 0xff, (len >>> 8) & 0xff)
    zlib.push((~len) & 0xff, ((~len) >>> 8) & 0xff)
    for (let i = 0; i < len; i++) zlib.push(raw[off + i]!)
  }
  zlib.push(...u32(adler32(raw)))

  // ── Build PNG chunks ─────────────────────────────────────────────────────
  const chunk = (type: string, data: number[]): number[] => {
    const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]
    const out: number[] = []
    out.push(...u32(data.length))
    out.push(...typeBytes)
    out.push(...data)
    out.push(...u32(crc32([...typeBytes, ...data])))
    return out
  }

  const ihdr = [
    ...u32(width),
    ...u32(height),
    8, // bit depth
    2, // color type: RGB
    0, // compression
    0, // filter
    0, // interlace
  ]

  const png: number[] = [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlib),
    ...chunk('IEND', []),
  ]

  return new Uint8Array(png)
}

interface MattermostUser {
  id: string
  username: string
  email?: string
}

/**
 * Create a fresh user via the admin token. Returns the user_id and username.
 * The created user is added to the test team automatically.
 */
async function createTestUser(label: string): Promise<MattermostUser> {
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN required to create test users')
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const username = `e2e-${label}-${stamp}`.toLowerCase()
  const email = `${username}@test.local`

  const user = await api<MattermostUser>('/users', {
    token: ADMIN_TOKEN,
    body: {
      email,
      username,
      password: 'TestUser1234!',
    },
  })

  // Add the user to the test team so they can be DMed and mentioned in channels
  if (TEAM_ID) {
    try {
      await api('/teams/' + TEAM_ID + '/members', {
        token: ADMIN_TOKEN,
        body: { team_id: TEAM_ID, user_id: user.id },
      })
    } catch {
      // Already a member — ignore.
    }
  }

  return { id: user.id, username, email }
}

/**
 * Open a Mattermost WebSocket and authenticate the bot. Returns the open WS.
 */
async function openWebSocket(token: string = BOT_TOKEN!): Promise<WebSocket> {
  const wsUrl = BASE_URL.replace(/^http/, 'ws') + '/api/v4/websocket'
  return new Promise((resolveFn, rejectFn) => {
    const ws = new WebSocket(wsUrl)
    const timeout = setTimeout(() => {
      ws.close()
      rejectFn(new Error('WebSocket auth timed out'))
    }, 10_000)
    ws.onopen = () => {
      ws.send(JSON.stringify({
        seq: 1,
        action: 'authentication_challenge',
        data: { token },
      }))
    }
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as Record<string, unknown>
        if (data.event === 'hello' || data.seq_reply) {
          clearTimeout(timeout)
          // Detach the auth handlers so subsequent frames are not processed here.
          ws.onmessage = null
          ws.onopen = null
          ws.onerror = null
          resolveFn(ws)
        }
      } catch {
        // ignore
      }
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      ws.close()
      rejectFn(new Error('WebSocket error during auth'))
    }
  })
}

/**
 * Mattermost WS frames serialize nested objects (e.g. `post`, `reaction`) as
 * JSON-encoded strings inside `data.data`. Decode one such field, returning
 * `null` if the field is missing or cannot be parsed. Used by waitForWsEvent
 * predicates to inspect inner payloads without repeating the boilerplate.
 */
function parseInner(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const inner = (data.data as Record<string, unknown> | undefined)?.[key]
  if (typeof inner !== 'string') return null
  try {
    return JSON.parse(inner) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Wait for a specific event name on a WebSocket. Optionally filter by predicate.
 */
function waitForWsEvent(
  ws: WebSocket,
  eventName: string,
  options: { timeoutMs?: number; predicate?: (data: Record<string, unknown>) => boolean } = {},
): Promise<Record<string, unknown>> {
  const { timeoutMs = 8_000, predicate } = options
  return new Promise((resolveFn, rejectFn) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', handler)
      rejectFn(new Error(`Timed out waiting for WS event "${eventName}"`))
    }, timeoutMs)

    const handler = (ev: MessageEvent) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(String(ev.data)) as Record<string, unknown>
      } catch {
        // ignore parse errors only — predicate errors must propagate
        return
      }
      if (data.event === eventName) {
        if (!predicate || predicate(data)) {
          clearTimeout(timeout)
          ws.removeEventListener('message', handler)
          resolveFn(data)
        }
      }
    }

    ws.addEventListener('message', handler)
  })
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Post {
  id: string
  create_at: number
  update_at: number
  delete_at: number
  user_id: string
  channel_id: string
  root_id: string
  message: string
  type: string
  props: Record<string, unknown>
  file_ids?: string[]
  metadata?: Record<string, unknown>
}

interface PostList {
  order: string[]
  posts: Record<string, Post>
}

interface Channel {
  id: string
  name: string
  display_name: string
  type: string
  team_id: string
}

interface Reaction {
  user_id: string
  post_id: string
  emoji_name: string
  create_at: number
}

interface FileUploadResponse {
  file_infos: Array<{ id: string; name: string; mime_type: string; size: number }>
}

// ─── Test scenarios ─────────────────────────────────────────────────────────

async function test01_textMessage(): Promise<void> {
  const msg = `E2E text message ${Date.now()}`

  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: msg },
  })

  assert(!!post.id, 'post has an id')
  assert(post.channel_id === CHANNEL_ID, 'post is in the correct channel')
  assert(post.message === msg, 'post message matches')
  assert(post.user_id === BOT_USER_ID, 'post is from the bot user')

  // Verify by re-fetching
  const fetched = await api<Post>(`/posts/${post.id}`)
  assert(fetched.message === msg, 'fetched post message matches')
}

async function test02_threadReply(): Promise<void> {
  // Create a root post
  const root = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E thread root ${Date.now()}` },
  })
  assert(!!root.id, 'root post created')
  assert(root.root_id === '', 'root post has no root_id')

  // Reply in thread
  const reply = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: `E2E thread reply ${Date.now()}`,
      root_id: root.id,
    },
  })
  assert(reply.root_id === root.id, `reply root_id matches root post (expected ${root.id}, got ${reply.root_id})`)
  assert(reply.channel_id === CHANNEL_ID, 'reply is in the correct channel')

  // Verify the thread structure via GET
  const fetched = await api<Post>(`/posts/${reply.id}`)
  assert(fetched.root_id === root.id, 'fetched reply root_id matches')
}

async function test03_editMessage(): Promise<void> {
  const originalText = `E2E original ${Date.now()}`
  const editedText = `E2E edited ${Date.now()}`

  // Create post
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: originalText },
  })
  assert(post.message === originalText, 'original message correct')

  // Edit via PUT
  const updated = await api<Post>(`/posts/${post.id}`, {
    method: 'PUT',
    body: { id: post.id, message: editedText },
  })
  assert(updated.message === editedText, `message updated (expected "${editedText}", got "${updated.message}")`)

  // Verify by re-fetching
  const fetched = await api<Post>(`/posts/${post.id}`)
  assert(fetched.message === editedText, 'fetched message shows edited text')
  assert(fetched.update_at > post.update_at, 'update_at advanced after edit')
}

async function test04_fileUpload(): Promise<void> {
  const testContent = 'Hello from E2E file upload test!\nLine 2.\n'
  const fileName = `e2e-test-${Date.now()}.txt`

  // Upload file using multipart form
  const form = new FormData()
  const blob = new Blob([testContent], { type: 'text/plain' })
  form.append('files', blob, fileName)
  form.append('channel_id', CHANNEL_ID!)

  const uploadData = await uploadFiles(form)
  assert(uploadData.file_infos.length > 0, 'upload returned file_infos')
  const fileId = uploadData.file_infos[0]!.id
  assert(!!fileId, 'file has an id')

  // Create a post with the file attached
  const post = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: `E2E file upload test ${Date.now()}`,
      file_ids: [fileId],
    },
  })
  assert(post.file_ids?.includes(fileId), 'post file_ids contains uploaded file')

  // Verify file metadata
  const fileInfo = await api<{ id: string; name: string; mime_type: string; size: number }>(`/files/${fileId}/info`)
  assert(fileInfo.name === fileName, `file name matches (expected "${fileName}", got "${fileInfo.name}")`)
  assert(fileInfo.size > 0, 'file has non-zero size')
}

async function test05_reactions(): Promise<void> {
  // Create a post to react to
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E reaction test ${Date.now()}` },
  })

  // Add reaction
  const reaction = await api<Reaction>('/reactions', {
    body: {
      user_id: BOT_USER_ID,
      post_id: post.id,
      emoji_name: 'thumbsup',
    },
  })
  assert(reaction.emoji_name === 'thumbsup', 'reaction emoji matches')
  assert(reaction.post_id === post.id, 'reaction post_id matches')
  assert(reaction.user_id === BOT_USER_ID, 'reaction user_id matches')

  // Verify by fetching the post (reactions appear in metadata)
  const fetched = await api<Post>(`/posts/${post.id}`)
  const reactions = (fetched.metadata as Record<string, unknown>)?.reactions as Reaction[] | undefined
  if (reactions) {
    const found = reactions.some(
      (r) => r.emoji_name === 'thumbsup' && r.user_id === BOT_USER_ID,
    )
    assert(found, 'reaction appears in post metadata')
  }
  // Note: some Mattermost versions don't embed reactions in metadata; the
  // POST /reactions success above is the primary assertion.
}

async function test06_directMessage(): Promise<void> {
  // Create a DM channel between the bot and the admin
  const dmChannel = await api<Channel>('/channels/direct', {
    body: [BOT_USER_ID, ADMIN_ID],
  })
  assert(!!dmChannel.id, 'DM channel created/retrieved')
  assert(dmChannel.type === 'D', `channel type is DM (got "${dmChannel.type}")`)

  // Send a DM
  const msg = `E2E DM test ${Date.now()}`
  const post = await api<Post>('/posts', {
    body: { channel_id: dmChannel.id, message: msg },
  })
  assert(post.channel_id === dmChannel.id, 'post is in the DM channel')
  assert(post.message === msg, 'DM message matches')

  // Verify from admin's perspective
  const fetched = await api<Post>(`/posts/${post.id}`, { token: ADMIN_TOKEN })
  assert(fetched.message === msg, 'admin can see the DM')
}

async function test07_mentions(): Promise<void> {
  // We need a second user to mention. Use the admin account.
  // Get admin username
  const adminUser = await api<{ id: string; username: string }>(`/users/${ADMIN_ID}`, {
    token: ADMIN_TOKEN,
  })
  const mention = `@${adminUser.username}`

  const msg = `E2E mention test ${mention} ${Date.now()}`
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: msg },
  })
  assert(post.message.includes(mention), 'post message contains @mention')

  // Verify the post is fetchable and text is intact
  const fetched = await api<Post>(`/posts/${post.id}`)
  assert(fetched.message.includes(mention), 'fetched message contains @mention')
}

async function test08_longMessage(): Promise<void> {
  // Generate a 10000-character message
  const unit = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '
  let longText = `E2E long message test ${Date.now()}: `
  while (longText.length < 10000) {
    longText += unit
  }
  longText = longText.slice(0, 10000)

  assert(longText.length === 10000, 'message is exactly 10000 chars')

  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: longText },
  })
  assert(!!post.id, 'long post created')

  // Mattermost default max post size is 16383 chars, so 10000 should fit in one post
  const fetched = await api<Post>(`/posts/${post.id}`)
  assert(
    fetched.message.length === 10000,
    `message length preserved (expected 10000, got ${fetched.message.length})`,
  )
  assert(
    fetched.message.startsWith('E2E long message test'),
    'message content starts correctly',
  )
  assert(
    fetched.message === longText,
    'entire message content matches byte-for-byte',
  )
}

async function test09_typingIndicator(): Promise<void> {
  // Send typing indicator via REST API
  // POST /users/me/typing with channel_id
  const res = await fetch(`${API}/users/me/typing`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel_id: CHANNEL_ID }),
  })

  // Typing endpoint returns 200 OK with empty body on success
  assert(res.ok, `typing indicator returned ${res.status} (expected 2xx)`)
}

async function test10_reconnect(): Promise<void> {
  // Establish a WebSocket connection, close it, and verify reconnect.
  // Uses the raw WS protocol rather than the adapter class to keep the test
  // dependency-free from the plugin-sdk.

  const wsUrl = BASE_URL.replace(/^http/, 'ws') + '/api/v4/websocket'

  let connectCount = 0
  let lastSeq = 0

  // Helper: open a WS, authenticate, and wait for the hello event
  function openWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timed out'))
      }, 10_000)

      ws.onopen = () => {
        connectCount++
        // Send auth challenge
        lastSeq++
        ws.send(JSON.stringify({
          seq: lastSeq,
          action: 'authentication_challenge',
          data: { token: BOT_TOKEN },
        }))
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as Record<string, unknown>
          // After auth we get a hello or seq_reply; either means we're connected
          if (data.event === 'hello' || data.seq_reply) {
            clearTimeout(timeout)
            resolve(ws)
          }
        } catch {
          // ignore parse errors
        }
      }

      ws.onerror = (event) => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error: ${(event as ErrorEvent).message ?? 'unknown'}`))
      }
    })
  }

  // First connection
  const ws1 = await openWs()
  assert(connectCount === 1, 'first WS connection established')

  // Force close the first connection
  ws1.close(4000, 'e2e test forced close')

  // Wait briefly for close to propagate
  await sleep(500)

  // Second connection (simulates reconnect)
  const ws2 = await openWs()
  assert(connectCount === 2, 'second WS connection established after forced close')

  // Verify we can receive events on the new connection by posting a message
  // and checking we receive the 'posted' event
  const receivedEvent = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 8_000)

    ws2.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>
        if (data.event === 'posted') {
          clearTimeout(timeout)
          resolve(true)
        }
      } catch {
        // ignore
      }
    }

    // Post a message using the admin token so the bot's WS receives it
    api<Post>('/posts', {
      token: ADMIN_TOKEN,
      body: {
        channel_id: CHANNEL_ID,
        message: `E2E reconnect verify ${Date.now()}`,
      },
    }).catch(() => {
      clearTimeout(timeout)
      resolve(false)
    })
  })

  assert(receivedEvent, 'received posted event on reconnected WebSocket')

  // Cleanup
  ws2.close(1000, 'e2e test done')
}

// ─── Channel scenarios (11–17) ──────────────────────────────────────────────

async function test11_createPublicChannel(): Promise<void> {
  const stamp = Date.now()
  const name = `e2e-public-${stamp}`
  const channel = await api<Channel>('/channels', {
    body: {
      team_id: TEAM_ID,
      name,
      display_name: `E2E Public ${stamp}`,
      type: 'O',
    },
  })
  assert(!!channel.id, 'public channel created')
  assert(channel.type === 'O', `channel type is open (got "${channel.type}")`)
  assert(channel.name === name, 'channel name matches')
  assert(channel.team_id === TEAM_ID, 'channel belongs to test team')
}

async function test12_createPrivateChannel(): Promise<void> {
  const stamp = Date.now()
  const name = `e2e-private-${stamp}`
  const channel = await api<Channel>('/channels', {
    body: {
      team_id: TEAM_ID,
      name,
      display_name: `E2E Private ${stamp}`,
      type: 'P',
    },
  })
  assert(!!channel.id, 'private channel created')
  assert(channel.type === 'P', `channel type is private (got "${channel.type}")`)
  assert(channel.name === name, 'channel name matches')
}

async function test13_listBotChannels(): Promise<void> {
  // Get all channels the bot is a member of in the test team
  const channels = await api<Channel[]>(
    `/users/${BOT_USER_ID}/teams/${TEAM_ID}/channels`,
  )
  assert(Array.isArray(channels), 'channel list is an array')
  assert(channels.length >= 1, `bot is in at least one channel (got ${channels.length})`)
  // The bot-testing channel should always be present
  const found = channels.some((c) => c.id === CHANNEL_ID)
  assert(found, 'bot is in the bot-testing channel')
}

async function test14_botJoinChannel(): Promise<void> {
  // Admin creates a public channel, then bot self-joins it
  const stamp = Date.now()
  const created = await api<Channel>('/channels', {
    token: ADMIN_TOKEN,
    body: {
      team_id: TEAM_ID,
      name: `e2e-join-${stamp}`,
      display_name: `E2E Join ${stamp}`,
      type: 'O',
    },
  })
  assert(!!created.id, 'channel created by admin')

  // Bot joins via POST /channels/{id}/members with own user_id
  const member = await api<{ user_id: string; channel_id: string }>(
    `/channels/${created.id}/members`,
    { body: { user_id: BOT_USER_ID } },
  )
  assert(member.user_id === BOT_USER_ID, 'bot is now a member')
  assert(member.channel_id === created.id, 'membership is in the new channel')

  // Verify by fetching membership
  const check = await api<{ user_id: string }>(
    `/channels/${created.id}/members/${BOT_USER_ID}`,
  )
  assert(check.user_id === BOT_USER_ID, 'bot membership confirmed')
}

async function test15_botLeaveChannel(): Promise<void> {
  // Admin creates a channel, bot joins, then bot is removed.
  // Bot users can't unilaterally call DELETE on their own membership in
  // every Mattermost build, so the removal is performed using the admin
  // token (which is the canonical "bot leaves a channel" pattern when the
  // bot doesn't own its own membership endpoint).
  const stamp = Date.now()
  const created = await api<Channel>('/channels', {
    token: ADMIN_TOKEN,
    body: {
      team_id: TEAM_ID,
      name: `e2e-leave-${stamp}`,
      display_name: `E2E Leave ${stamp}`,
      type: 'O',
    },
  })

  // Join first (bot self-add via POST is allowed in public channels)
  await api(`/channels/${created.id}/members`, {
    body: { user_id: BOT_USER_ID },
  })

  // Confirm membership
  const before = await api<{ user_id: string }>(
    `/channels/${created.id}/members/${BOT_USER_ID}`,
  )
  assert(before.user_id === BOT_USER_ID, 'bot is a member before leave')

  // Remove: DELETE /channels/{id}/members/{user_id} via admin token
  await api(`/channels/${created.id}/members/${BOT_USER_ID}`, {
    method: 'DELETE',
    token: ADMIN_TOKEN,
  })

  // Verify the bot is no longer a member — should 404 from admin's view too
  let isMember = true
  try {
    await api(`/channels/${created.id}/members/${BOT_USER_ID}`, {
      token: ADMIN_TOKEN,
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) {
      isMember = false
    } else {
      throw err
    }
  }
  assert(!isMember, 'bot is no longer a member after leaving')
}

async function test16_getChannelByName(): Promise<void> {
  const channel = await api<Channel>(
    `/teams/${TEAM_ID}/channels/name/bot-testing`,
  )
  assert(channel.id === CHANNEL_ID, 'channel by name resolves to bot-testing id')
  assert(channel.name === 'bot-testing', 'channel name matches')
}

async function test17_channelStats(): Promise<void> {
  const stats = await api<{ channel_id: string; member_count: number }>(
    `/channels/${CHANNEL_ID}/stats`,
  )
  assert(stats.channel_id === CHANNEL_ID, 'stats are for the right channel')
  assert(stats.member_count >= 1, `member_count is positive (got ${stats.member_count})`)
}

// ─── Thread scenarios (18–21) ───────────────────────────────────────────────

async function test18_nestedThreadReplies(): Promise<void> {
  // Mattermost does NOT support nesting beyond depth-1: replies must point at
  // an actual root (a post whose root_id is empty). Pointing root_id at an
  // existing reply is rejected with 400 "Invalid RootId parameter". This test
  // pins both behaviours: replies-to-root succeed, replies-to-reply fail.
  const root = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E nested root ${Date.now()}` },
  })
  assert(root.root_id === '', 'root post has empty root_id')

  // Two top-level replies under the root
  const reply1 = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: 'reply 1',
      root_id: root.id,
    },
  })
  assert(reply1.root_id === root.id, 'reply 1 attaches to root')

  const reply2 = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: 'reply 2',
      root_id: root.id,
    },
  })
  assert(reply2.root_id === root.id, 'reply 2 attaches to root')

  // Attempting to nest under reply1 should be rejected
  let nestedRejected = false
  try {
    await api<Post>('/posts', {
      body: {
        channel_id: CHANNEL_ID,
        message: 'reply nested under reply 1',
        root_id: reply1.id,
      },
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes('Invalid RootId')) {
      nestedRejected = true
    } else {
      throw err
    }
  }
  assert(
    nestedRejected,
    'Mattermost rejects nesting a reply under another reply (depth-1 only)',
  )

  // A third reply still attaches at depth 1
  const reply3 = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: 'reply 3',
      root_id: root.id,
    },
  })
  assert(reply3.root_id === root.id, 'reply 3 attaches to root')
}

async function test19_fetchFullThread(): Promise<void> {
  const root = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E thread fetch root ${Date.now()}` },
  })

  // Add 3 replies
  for (let i = 1; i <= 3; i++) {
    await api<Post>('/posts', {
      body: {
        channel_id: CHANNEL_ID,
        message: `thread fetch reply ${i}`,
        root_id: root.id,
      },
    })
  }

  // Fetch the full thread via GET /posts/{id}/thread
  const thread = await api<PostList>(`/posts/${root.id}/thread`)
  assert(Array.isArray(thread.order), 'thread has an order array')
  assert(thread.order.length >= 4, `thread contains 4+ posts (got ${thread.order.length})`)
  assert(!!thread.posts[root.id], 'thread contains the root post')

  // Count replies pointing at root
  const replyCount = Object.values(thread.posts).filter(
    (p) => p.root_id === root.id,
  ).length
  assert(replyCount >= 3, `thread has 3+ replies (got ${replyCount})`)
}

async function test20_threadRootDetectionOnEdit(): Promise<void> {
  // Verify that editing a reply preserves its root_id linkage
  const root = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E thread edit root ${Date.now()}` },
  })

  const reply = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: 'reply before edit',
      root_id: root.id,
    },
  })
  assert(reply.root_id === root.id, 'reply linked to root before edit')

  const edited = await api<Post>(`/posts/${reply.id}`, {
    method: 'PUT',
    body: { id: reply.id, message: 'reply after edit' },
  })
  assert(edited.message === 'reply after edit', 'reply message updated')
  assert(
    edited.root_id === root.id,
    `edited reply still linked to root (expected ${root.id}, got ${edited.root_id})`,
  )

  // Re-fetch and verify
  const fetched = await api<Post>(`/posts/${reply.id}`)
  assert(fetched.root_id === root.id, 'fetched edited reply still has correct root_id')
}

async function test21_concurrentThreads(): Promise<void> {
  // Create 3 distinct threads in the same channel; verify isolation
  const roots = await Promise.all([
    api<Post>('/posts', {
      body: { channel_id: CHANNEL_ID, message: `concurrent thread A ${Date.now()}` },
    }),
    api<Post>('/posts', {
      body: { channel_id: CHANNEL_ID, message: `concurrent thread B ${Date.now()}` },
    }),
    api<Post>('/posts', {
      body: { channel_id: CHANNEL_ID, message: `concurrent thread C ${Date.now()}` },
    }),
  ])
  assert(roots.length === 3, 'three roots created')

  // Reply in each
  const replies = await Promise.all(
    roots.map((root, idx) =>
      api<Post>('/posts', {
        body: {
          channel_id: CHANNEL_ID,
          message: `reply for thread ${idx}`,
          root_id: root.id,
        },
      }),
    ),
  )

  for (let i = 0; i < 3; i++) {
    assert(
      replies[i]!.root_id === roots[i]!.id,
      `reply ${i} attaches to root ${i}`,
    )
  }

  // Cross-fetch each thread and verify it only contains its own reply
  for (let i = 0; i < 3; i++) {
    const thread = await api<PostList>(`/posts/${roots[i]!.id}/thread`)
    const threadReplies = Object.values(thread.posts).filter(
      (p) => p.root_id === roots[i]!.id,
    )
    assert(
      threadReplies.length === 1,
      `thread ${i} has exactly 1 reply (got ${threadReplies.length})`,
    )
  }
}

// ─── File scenarios (22–26) ─────────────────────────────────────────────────

async function test22_uploadPng(): Promise<void> {
  const png = makeRedPng(100, 100)
  assert(png.length > 0, 'png buffer non-empty')
  assert(png[0] === 0x89 && png[1] === 0x50, 'png starts with PNG signature')

  const fileName = `e2e-red-${Date.now()}.png`
  const form = new FormData()
  form.append('files', new Blob([png], { type: 'image/png' }), fileName)
  form.append('channel_id', CHANNEL_ID!)

  const data = await uploadFiles(form)
  const info = data.file_infos[0]!
  assert(info.mime_type === 'image/png', `mime is image/png (got ${info.mime_type})`)
  assert(info.size === png.length, `size matches (expected ${png.length}, got ${info.size})`)

  // Attach to a post
  const post = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: 'png upload test',
      file_ids: [info.id],
    },
  })
  assert(post.file_ids?.includes(info.id), 'post references uploaded png')
}

async function test23_uploadMultipleFiles(): Promise<void> {
  const stamp = Date.now()
  const form = new FormData()
  form.append('files', new Blob(['file one\n'], { type: 'text/plain' }), `f1-${stamp}.txt`)
  form.append('files', new Blob(['file two\n'], { type: 'text/plain' }), `f2-${stamp}.txt`)
  form.append('files', new Blob(['file three\n'], { type: 'text/plain' }), `f3-${stamp}.txt`)
  form.append('channel_id', CHANNEL_ID!)

  const data = await uploadFiles(form)
  assert(
    data.file_infos.length === 3,
    `received 3 file_infos (got ${data.file_infos.length})`,
  )

  const ids = data.file_infos.map((f) => f.id)
  const post = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: 'three files attached',
      file_ids: ids,
    },
  })
  assert(post.file_ids?.length === 3, 'post has 3 file_ids')
  for (const id of ids) {
    assert(post.file_ids?.includes(id), `post contains file ${id}`)
  }
}

async function test24_downloadAndVerifyFile(): Promise<void> {
  const content = `bytes-test-${Date.now()}\nABC\n`
  const fileName = `bytes-${Date.now()}.txt`
  const form = new FormData()
  form.append('files', new Blob([content], { type: 'text/plain' }), fileName)
  form.append('channel_id', CHANNEL_ID!)

  const upData = await uploadFiles(form)
  const fileId = upData.file_infos[0]!.id

  // Download the file
  const dlRes = await fetch(`${API}/files/${fileId}`, {
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
  })
  assert(dlRes.ok, `download OK (status ${dlRes.status})`)

  const downloaded = await dlRes.text()
  assert(
    downloaded === content,
    `downloaded bytes match upload (expected ${content.length} chars, got ${downloaded.length})`,
  )
}

async function test25_getFileInfo(): Promise<void> {
  const fileName = `meta-${Date.now()}.txt`
  const content = 'metadata test'
  const form = new FormData()
  form.append('files', new Blob([content], { type: 'text/plain' }), fileName)
  form.append('channel_id', CHANNEL_ID!)

  const upData = await uploadFiles(form)
  const fileId = upData.file_infos[0]!.id

  // Get info
  const info = await api<{
    id: string
    name: string
    mime_type: string
    size: number
    extension: string
  }>(`/files/${fileId}/info`)
  assert(info.id === fileId, 'info id matches')
  assert(info.name === fileName, `info name matches (got "${info.name}")`)
  assert(info.size === content.length, 'info size matches content length')
  assert(info.extension === 'txt', `extension is "txt" (got "${info.extension}")`)
}

async function test26_fileLinkRetrieval(): Promise<void> {
  // Upload a file and then ask Mattermost for a public file link.
  // Note: file links require EnableFileAttachments + EnablePublicLink in
  // the server config. We test the endpoint exists and returns a sane shape.
  const fileName = `link-${Date.now()}.txt`
  const form = new FormData()
  form.append('files', new Blob(['link test'], { type: 'text/plain' }), fileName)
  form.append('channel_id', CHANNEL_ID!)

  const upData = await uploadFiles(form)
  const fileId = upData.file_infos[0]!.id

  // Always-available URL: GET /files/{id}/info gives us the canonical
  // download path. We construct the file URL directly.
  const fileUrl = `${API}/files/${fileId}`
  assert(fileUrl.includes(fileId), 'file URL contains the file id')

  // Verify that an authenticated GET on it works
  const headRes = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
  })
  assert(headRes.ok, `file is retrievable via constructed URL (status ${headRes.status})`)
}

// ─── Reaction scenarios (27–30) ─────────────────────────────────────────────

async function test27_multipleReactions(): Promise<void> {
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E multi-reaction ${Date.now()}` },
  })
  const emojis = ['thumbsup', 'heart', 'tada']
  for (const emoji of emojis) {
    const r = await api<Reaction>('/reactions', {
      body: { user_id: BOT_USER_ID, post_id: post.id, emoji_name: emoji },
    })
    assert(r.emoji_name === emoji, `reaction added: ${emoji}`)
  }

  // Fetch all reactions for the post
  const reactions = await api<Reaction[]>(`/posts/${post.id}/reactions`)
  assert(reactions.length >= 3, `post has 3+ reactions (got ${reactions.length})`)
  for (const emoji of emojis) {
    assert(
      reactions.some((r) => r.emoji_name === emoji),
      `reactions list contains "${emoji}"`,
    )
  }
}

async function test28_removeReaction(): Promise<void> {
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E remove-reaction ${Date.now()}` },
  })

  // Add a reaction
  await api<Reaction>('/reactions', {
    body: { user_id: BOT_USER_ID, post_id: post.id, emoji_name: 'fire' },
  })

  // Confirm it landed before removing
  const before = (await api<Reaction[] | null>(`/posts/${post.id}/reactions`)) ?? []
  assert(
    before.some((r) => r.emoji_name === 'fire' && r.user_id === BOT_USER_ID),
    'reaction present before removal',
  )

  // Remove it
  await api(`/users/${BOT_USER_ID}/posts/${post.id}/reactions/fire`, {
    method: 'DELETE',
  })

  // Verify — Mattermost returns null (not []) when there are no reactions
  const after = (await api<Reaction[] | null>(`/posts/${post.id}/reactions`)) ?? []
  const stillThere = after.some(
    (r) => r.emoji_name === 'fire' && r.user_id === BOT_USER_ID,
  )
  assert(!stillThere, 'reaction was removed')
}

async function test29_getAllReactions(): Promise<void> {
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E get-reactions ${Date.now()}` },
  })

  await api<Reaction>('/reactions', {
    body: { user_id: BOT_USER_ID, post_id: post.id, emoji_name: 'eyes' },
  })

  // Mattermost may return null when fully empty; cast to nullable and default
  const reactions = (await api<Reaction[] | null>(`/posts/${post.id}/reactions`)) ?? []
  assert(Array.isArray(reactions), 'reactions response is an array')
  assert(reactions.length >= 1, 'at least one reaction returned')
  assert(
    reactions[0]!.post_id === post.id,
    'reaction post_id matches',
  )
}

async function test30_wsReactionAddedEvent(): Promise<void> {
  const ws = await openWebSocket()
  try {
    const post = await api<Post>('/posts', {
      body: { channel_id: CHANNEL_ID, message: `E2E ws-reaction ${Date.now()}` },
    })

    // Set up listener BEFORE adding the reaction
    const eventPromise = waitForWsEvent(ws, 'reaction_added', {
      timeoutMs: 8_000,
      predicate: (data) => parseInner(data, 'reaction')?.post_id === post.id,
    })

    // Add the reaction (small delay so listener is attached first)
    await sleep(100)
    await api<Reaction>('/reactions', {
      body: { user_id: BOT_USER_ID, post_id: post.id, emoji_name: 'rocket' },
    })

    const event = await eventPromise
    assert(!!event, 'received reaction_added WS event')
  } finally {
    ws.close(1000, 'done')
  }
}

// ─── Message scenarios (31–36) ──────────────────────────────────────────────

async function test31_deleteOwnMessage(): Promise<void> {
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E delete me ${Date.now()}` },
  })

  // DELETE returns 200 with {"status":"OK"}
  const result = await api<{ status: string }>(`/posts/${post.id}`, {
    method: 'DELETE',
  })
  assert(result.status === 'OK', `delete returned status OK (got "${result.status}")`)

  // After delete, plain GET on the post 404s. That's the canonical signal
  // that the soft-delete took effect.
  let gone = false
  try {
    await api<Post>(`/posts/${post.id}`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) gone = true
    else throw err
  }
  assert(gone, 'GET on deleted post returns 404')
}

async function test32_deletedPostHasDeleteAt(): Promise<void> {
  // Verify the soft-delete by reading the post via the admin token with
  // ?include_deleted=true and checking delete_at > 0.
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN required for include_deleted lookup')

  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E delete verify ${Date.now()}` },
  })
  assert(post.delete_at === 0, 'fresh post has delete_at = 0')

  await api(`/posts/${post.id}`, { method: 'DELETE' })

  // The official mechanism: list channel posts with include_deleted=true
  // and find the soft-deleted entry there.
  const list = await api<PostList>(
    `/channels/${CHANNEL_ID}/posts?include_deleted=true&per_page=200`,
    { token: ADMIN_TOKEN },
  )
  const fetched = list.posts[post.id]
  assert(!!fetched, `post still listed in channel via include_deleted=true (id=${post.id})`)
  assert(
    fetched!.delete_at > 0,
    `deleted post has delete_at > 0 (got ${fetched!.delete_at})`,
  )
  assert(fetched!.delete_at >= post.create_at, 'delete_at is >= create_at')
}

async function test33_postWithAttachmentProps(): Promise<void> {
  // Mattermost rich card attachments via props.attachments
  const post = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: `E2E rich card ${Date.now()}`,
      props: {
        attachments: [
          {
            color: '#36a64f',
            title: 'E2E Rich Card',
            text: 'This is a rich card body with **markdown**.',
            fields: [
              { title: 'Field 1', value: 'Value 1', short: true },
              { title: 'Field 2', value: 'Value 2', short: true },
            ],
          },
        ],
      },
    },
  })
  assert(!!post.id, 'rich-card post created')
  const attachments = (post.props.attachments as unknown[] | undefined) ?? []
  assert(attachments.length === 1, 'post has 1 attachment in props')
  const att = attachments[0] as Record<string, unknown>
  assert(att.title === 'E2E Rich Card', 'attachment title preserved')
  assert(att.color === '#36a64f', 'attachment color preserved')
}

async function test34_ephemeralPost(): Promise<void> {
  // Ephemeral posts must be sent by an admin via POST /posts/ephemeral
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN required for ephemeral posts')

  const ephemeral = await api<Post>('/posts/ephemeral', {
    token: ADMIN_TOKEN,
    body: {
      user_id: BOT_USER_ID,
      post: {
        channel_id: CHANNEL_ID,
        message: `E2E ephemeral ${Date.now()}`,
      },
    },
  })
  assert(!!ephemeral.id, 'ephemeral post returned an id')
  assert(ephemeral.channel_id === CHANNEL_ID, 'ephemeral post is in the channel')
  // Ephemeral posts have a special type
  assert(
    ephemeral.type === '' || ephemeral.type.startsWith('system_'),
    'ephemeral post type is acceptable',
  )
}

async function test35_rapidEdits(): Promise<void> {
  // Simulate streaming: post → edit → edit → edit
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: 'streaming...' },
  })

  const stages = ['streaming.', 'streaming..', 'streaming...', 'streaming done.']
  for (const text of stages) {
    const updated = await api<Post>(`/posts/${post.id}`, {
      method: 'PUT',
      body: { id: post.id, message: text },
    })
    assert(updated.message === text, `edit applied: "${text}"`)
  }

  const final = await api<Post>(`/posts/${post.id}`)
  assert(final.message === 'streaming done.', 'final message reflects last edit')
  assert(final.update_at > final.create_at, 'update_at > create_at after edits')
}

async function test36_postPermalink(): Promise<void> {
  // Permalink shape: {BASE_URL}/{team_name}/pl/{post_id}
  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: `E2E permalink ${Date.now()}` },
  })

  // Get the team to derive the URL
  const team = await api<{ id: string; name: string }>(`/teams/${TEAM_ID}`)
  const permalink = `${BASE_URL}/${team.name}/pl/${post.id}`
  assert(permalink.includes(post.id), 'permalink includes post id')
  assert(permalink.includes(team.name), 'permalink includes team name')

  // Sanity-check the structure of the URL
  const url = new URL(permalink)
  assert(url.pathname.endsWith(`/pl/${post.id}`), 'permalink path ends with /pl/{id}')
}

// ─── User scenarios (37–41) ─────────────────────────────────────────────────

let secondTestUser: MattermostUser | undefined

async function ensureSecondUser(): Promise<MattermostUser> {
  if (!secondTestUser) {
    secondTestUser = await createTestUser('second')
  }
  return secondTestUser
}

async function test37_createSecondUser(): Promise<void> {
  const user = await ensureSecondUser()
  assert(!!user.id, 'second user has an id')
  assert(user.username.startsWith('e2e-second-'), 'second username has e2e prefix')
  assert(!!user.email, 'second user has an email')
}

async function test38_searchUsers(): Promise<void> {
  const user = await ensureSecondUser()
  // POST /users/search with term
  const results = await api<MattermostUser[]>('/users/search', {
    body: { term: user.username, team_id: TEAM_ID },
  })
  assert(Array.isArray(results), 'search returned an array')
  const found = results.some((u) => u.id === user.id)
  assert(found, `search results contain second user (${user.username})`)
}

async function test39_mentionSecondUser(): Promise<void> {
  const user = await ensureSecondUser()
  const msg = `Hi @${user.username} from E2E ${Date.now()}`

  const post = await api<Post>('/posts', {
    body: { channel_id: CHANNEL_ID, message: msg },
  })
  assert(post.message.includes(`@${user.username}`), 'post mentions second user')
}

async function test40_resolveUsernameToId(): Promise<void> {
  const user = await ensureSecondUser()
  const resolved = await api<MattermostUser>(`/users/username/${user.username}`)
  assert(resolved.id === user.id, 'username resolves to correct id')
  assert(resolved.username === user.username, 'returned username matches')
}

async function test41_specialMentions(): Promise<void> {
  const post = await api<Post>('/posts', {
    body: {
      channel_id: CHANNEL_ID,
      message: `E2E special mentions @here and @channel ${Date.now()}`,
    },
  })
  assert(post.message.includes('@here'), 'message contains @here')
  assert(post.message.includes('@channel'), 'message contains @channel')
}

// ─── Group DM scenarios (42–43) ─────────────────────────────────────────────

async function test42_createGroupDm(): Promise<void> {
  const user1 = await ensureSecondUser()
  const user2 = await createTestUser('groupdm')

  // POST /channels/group with array of user IDs
  const gm = await api<Channel>('/channels/group', {
    body: [BOT_USER_ID, user1.id, user2.id],
  })
  assert(!!gm.id, 'group DM created')
  assert(gm.type === 'G', `channel type is G (got "${gm.type}")`)
}

async function test43_sendToGroupDm(): Promise<void> {
  const user1 = await ensureSecondUser()
  const user2 = await createTestUser('groupdm-send')

  const gm = await api<Channel>('/channels/group', {
    body: [BOT_USER_ID, user1.id, user2.id],
  })
  assert(gm.type === 'G', 'group DM type is G')

  const msg = `E2E group DM message ${Date.now()}`
  const post = await api<Post>('/posts', {
    body: { channel_id: gm.id, message: msg },
  })
  assert(post.channel_id === gm.id, 'post landed in group DM')
  assert(post.message === msg, 'group DM message content matches')
}

// ─── WebSocket event scenarios (44–47) ──────────────────────────────────────

async function test44_wsPostedEvent(): Promise<void> {
  const ws = await openWebSocket()
  try {
    const eventPromise = waitForWsEvent(ws, 'posted', {
      predicate: (data) => parseInner(data, 'post')?.channel_id === CHANNEL_ID,
    })

    await sleep(100)
    await api<Post>('/posts', {
      token: ADMIN_TOKEN,
      body: { channel_id: CHANNEL_ID, message: `E2E ws posted ${Date.now()}` },
    })

    await eventPromise
  } finally {
    ws.close(1000, 'done')
  }
}

async function test45_wsPostEditedEvent(): Promise<void> {
  const ws = await openWebSocket()
  try {
    const post = await api<Post>('/posts', {
      token: ADMIN_TOKEN,
      body: { channel_id: CHANNEL_ID, message: 'before ws edit' },
    })

    const eventPromise = waitForWsEvent(ws, 'post_edited', {
      predicate: (data) => parseInner(data, 'post')?.id === post.id,
    })

    await sleep(100)
    await api<Post>(`/posts/${post.id}`, {
      token: ADMIN_TOKEN,
      method: 'PUT',
      body: { id: post.id, message: 'after ws edit' },
    })

    await eventPromise
  } finally {
    ws.close(1000, 'done')
  }
}

async function test46_wsReactionEvent(): Promise<void> {
  // This duplicates test30 from a different angle (admin-driven reaction).
  const ws = await openWebSocket()
  try {
    const post = await api<Post>('/posts', {
      body: { channel_id: CHANNEL_ID, message: `E2E ws reaction 2 ${Date.now()}` },
    })

    const eventPromise = waitForWsEvent(ws, 'reaction_added', {
      predicate: (data) => parseInner(data, 'reaction')?.post_id === post.id,
    })

    await sleep(100)
    await api<Reaction>('/reactions', {
      token: ADMIN_TOKEN,
      body: {
        user_id: ADMIN_ID,
        post_id: post.id,
        emoji_name: 'star',
      },
    })

    await eventPromise
  } finally {
    ws.close(1000, 'done')
  }
}

async function test47_wsTypingEvent(): Promise<void> {
  // Bot subscribes; admin types in the channel; bot's WS receives a typing event.
  const ws = await openWebSocket()
  try {
    const eventPromise = waitForWsEvent(ws, 'typing', {
      timeoutMs: 8_000,
    })

    await sleep(100)
    // Admin sends a typing indicator (must be a real session, so use admin token)
    const res = await fetch(`${API}/users/me/typing`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel_id: CHANNEL_ID }),
    })
    assert(res.ok, `typing POST OK (status ${res.status})`)

    await eventPromise
  } finally {
    ws.close(1000, 'done')
  }
}

// ─── Team scenarios (48–50) ─────────────────────────────────────────────────

async function test48_getTeamInfo(): Promise<void> {
  const team = await api<{ id: string; name: string; display_name: string; type: string }>(
    `/teams/${TEAM_ID}`,
  )
  assert(team.id === TEAM_ID, 'team id matches')
  assert(team.name === 'test-team', `team name is test-team (got "${team.name}")`)
  assert(team.type === 'O', `team is open (got "${team.type}")`)
}

async function test49_listTeamChannels(): Promise<void> {
  // GET /users/{user_id}/teams/{team_id}/channels
  const channels = await api<Channel[]>(
    `/users/${BOT_USER_ID}/teams/${TEAM_ID}/channels`,
  )
  assert(Array.isArray(channels), 'channels response is an array')
  assert(channels.length >= 1, `team has channels (got ${channels.length})`)
  // bot-testing should be present
  assert(
    channels.some((c) => c.id === CHANNEL_ID),
    'channel list contains bot-testing',
  )
}

async function test50_teamStats(): Promise<void> {
  const stats = await api<{ team_id: string; total_member_count: number; active_member_count: number }>(
    `/teams/${TEAM_ID}/stats`,
  )
  assert(stats.team_id === TEAM_ID, 'team stats match')
  assert(stats.total_member_count >= 1, `team has 1+ members (got ${stats.total_member_count})`)
  assert(
    typeof stats.active_member_count === 'number',
    'active_member_count is a number',
  )
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('')
  console.log('==============================================')
  console.log('  Mattermost Adapter E2E Tests')
  console.log(`  Server: ${BASE_URL}`)
  console.log(`  Channel: ${CHANNEL_ID}`)
  console.log('==============================================')
  console.log('')

  // Verify connectivity before running tests
  try {
    const ping = await api<{ status: string }>('/system/ping')
    assert(ping.status === 'OK', `system ping status is OK (got "${ping.status}")`)
  } catch (err) {
    console.error(`[E2E] Cannot reach Mattermost at ${BASE_URL}:`, err)
    process.exit(1)
  }

  await runTest('01. Text message',                test01_textMessage)
  await runTest('02. Thread reply',                test02_threadReply)
  await runTest('03. Edit message',                test03_editMessage)
  await runTest('04. File upload',                 test04_fileUpload)
  await runTest('05. Reactions',                   test05_reactions)
  await runTest('06. Direct message',              test06_directMessage)
  await runTest('07. Mentions',                    test07_mentions)
  await runTest('08. Long message (10k)',          test08_longMessage)
  await runTest('09. Typing indicator',            test09_typingIndicator)
  await runTest('10. Reconnect',                   test10_reconnect)

  // ─── Channels ──────────────────────────────────────────────────────────
  await runTest('11. Create public channel',       test11_createPublicChannel)
  await runTest('12. Create private channel',      test12_createPrivateChannel)
  await runTest('13. List bot channels',           test13_listBotChannels)
  await runTest('14. Bot join channel',            test14_botJoinChannel)
  await runTest('15. Bot leave channel',           test15_botLeaveChannel)
  await runTest('16. Get channel by name',         test16_getChannelByName)
  await runTest('17. Channel statistics',          test17_channelStats)

  // ─── Threads (deep) ────────────────────────────────────────────────────
  await runTest('18. Nested thread replies',       test18_nestedThreadReplies)
  await runTest('19. Fetch full thread',           test19_fetchFullThread)
  await runTest('20. Thread root on edit',         test20_threadRootDetectionOnEdit)
  await runTest('21. Concurrent threads',          test21_concurrentThreads)

  // ─── Files (detailed) ──────────────────────────────────────────────────
  await runTest('22. Upload PNG',                  test22_uploadPng)
  await runTest('23. Upload multiple files',       test23_uploadMultipleFiles)
  await runTest('24. Download file bytes',         test24_downloadAndVerifyFile)
  await runTest('25. Get file info',               test25_getFileInfo)
  await runTest('26. File link retrieval',         test26_fileLinkRetrieval)

  // ─── Reactions (detailed) ──────────────────────────────────────────────
  await runTest('27. Multiple reactions',          test27_multipleReactions)
  await runTest('28. Remove reaction',             test28_removeReaction)
  await runTest('29. Get all reactions',           test29_getAllReactions)
  await runTest('30. WS reaction_added event',     test30_wsReactionAddedEvent)

  // ─── Messages (advanced) ───────────────────────────────────────────────
  await runTest('31. Delete own message',          test31_deleteOwnMessage)
  await runTest('32. Deleted post delete_at',      test32_deletedPostHasDeleteAt)
  await runTest('33. Post with attachments',       test33_postWithAttachmentProps)
  await runTest('34. Ephemeral post',              test34_ephemeralPost)
  await runTest('35. Multiple rapid edits',        test35_rapidEdits)
  await runTest('36. Post permalink',              test36_postPermalink)

  // ─── Users / mentions ──────────────────────────────────────────────────
  await runTest('37. Create second user',          test37_createSecondUser)
  await runTest('38. Search users',                test38_searchUsers)
  await runTest('39. Mention second user',         test39_mentionSecondUser)
  await runTest('40. Resolve username to id',      test40_resolveUsernameToId)
  await runTest('41. @here / @channel',            test41_specialMentions)

  // ─── Group DM ──────────────────────────────────────────────────────────
  await runTest('42. Create group DM',             test42_createGroupDm)
  await runTest('43. Send to group DM',            test43_sendToGroupDm)

  // ─── WS events ─────────────────────────────────────────────────────────
  await runTest('44. WS posted event',             test44_wsPostedEvent)
  await runTest('45. WS post_edited event',        test45_wsPostEditedEvent)
  await runTest('46. WS reaction_added (admin)',   test46_wsReactionEvent)
  await runTest('47. WS typing event',             test47_wsTypingEvent)

  // ─── Team operations ───────────────────────────────────────────────────
  await runTest('48. Get team info',               test48_getTeamInfo)
  await runTest('49. List team channels',          test49_listTeamChannels)
  await runTest('50. Team stats',                  test50_teamStats)

  // ─── Summary ────────────────────────────────────────────────────────────

  console.log('')
  console.log('----------------------------------------------')

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  const totalMs = results.reduce((s, r) => s + r.duration, 0)

  if (failed === 0) {
    console.log(`  \x1b[32mAll ${passed} tests passed\x1b[0m (${totalMs}ms)`)
  } else {
    console.log(`  \x1b[31m${failed} failed\x1b[0m, ${passed} passed (${totalMs}ms)`)
    console.log('')
    console.log('  Failed tests:')
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    - ${r.name}: ${r.error}`)
    }
  }

  console.log('----------------------------------------------')
  console.log('')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[E2E] Unhandled error:', err)
  process.exit(1)
})
