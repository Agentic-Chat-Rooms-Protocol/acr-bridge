/**
 * Threading tests — session keying, root ID resolution, DM detection,
 * and thread reply filtering for Mattermost.
 */

import { describe, it, expect } from 'vitest'
import {
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
} from '../threading.js'
import type { MattermostPost, MattermostChannel } from '../types.js'

function makePost(overrides: Partial<MattermostPost> = {}): MattermostPost {
  return {
    id: 'post-1',
    create_at: Date.now(),
    update_at: Date.now(),
    delete_at: 0,
    user_id: 'user-1',
    channel_id: 'ch-1',
    root_id: '',
    message: 'Hello',
    type: '',
    props: {},
    ...overrides,
  }
}

function makeChannel(overrides: Partial<MattermostChannel> = {}): MattermostChannel {
  return {
    id: 'ch-1',
    name: 'test-channel',
    display_name: 'Test Channel',
    type: 'O',
    team_id: 'team-1',
    ...overrides,
  }
}

describe('resolveRootId', () => {
  it('returns post.id for root posts (no root_id)', () => {
    const post = makePost({ id: 'post-abc', root_id: '' })
    expect(resolveRootId(post)).toBe('post-abc')
  })

  it('returns root_id for reply posts', () => {
    const post = makePost({ id: 'post-xyz', root_id: 'post-root' })
    expect(resolveRootId(post)).toBe('post-root')
  })

  it('handles root_id being undefined-ish (empty string)', () => {
    const post = makePost({ root_id: '' })
    expect(resolveRootId(post)).toBe(post.id)
  })
})

describe('buildSessionId', () => {
  it('builds channelId:rootPostId format', () => {
    expect(buildSessionId('ch-123', 'post-456')).toBe('ch-123:post-456')
  })

  it('produces unique keys for different channels', () => {
    const a = buildSessionId('ch-a', 'post-1')
    const b = buildSessionId('ch-b', 'post-1')
    expect(a).not.toBe(b)
  })

  it('produces unique keys for different threads', () => {
    const a = buildSessionId('ch-1', 'post-a')
    const b = buildSessionId('ch-1', 'post-b')
    expect(a).not.toBe(b)
  })
})

describe('shouldHandleThreadReply', () => {
  it('returns false for root posts (not a reply)', () => {
    const post = makePost({ root_id: '' })
    expect(shouldHandleThreadReply(post, true)).toBe(false)
  })

  it('returns true for reply in active session', () => {
    const post = makePost({ root_id: 'root-1' })
    expect(shouldHandleThreadReply(post, true)).toBe(true)
  })

  it('returns false for reply in unknown thread', () => {
    const post = makePost({ root_id: 'root-unknown' })
    expect(shouldHandleThreadReply(post, false)).toBe(false)
  })
})

describe('isDirectMessage / isDirectMessageType', () => {
  it('detects DM channel', () => {
    expect(isDirectMessage(makeChannel({ type: 'D' }))).toBe(true)
    expect(isDirectMessageType('D')).toBe(true)
  })

  it('rejects non-DM channels', () => {
    expect(isDirectMessage(makeChannel({ type: 'O' }))).toBe(false)
    expect(isDirectMessageType('O')).toBe(false)
    expect(isDirectMessageType('G')).toBe(false)
    expect(isDirectMessageType('P')).toBe(false)
  })
})

describe('isGroupMessage / isGroupMessageType', () => {
  it('detects group DM channel', () => {
    expect(isGroupMessage(makeChannel({ type: 'G' }))).toBe(true)
    expect(isGroupMessageType('G')).toBe(true)
  })

  it('rejects non-group channels', () => {
    expect(isGroupMessage(makeChannel({ type: 'D' }))).toBe(false)
    expect(isGroupMessage(makeChannel({ type: 'O' }))).toBe(false)
  })
})

describe('isTeamChannel / isTeamChannelType', () => {
  it('detects public channels', () => {
    expect(isTeamChannel(makeChannel({ type: 'O' }))).toBe(true)
    expect(isTeamChannelType('O')).toBe(true)
  })

  it('detects private channels', () => {
    expect(isTeamChannel(makeChannel({ type: 'P' }))).toBe(true)
    expect(isTeamChannelType('P')).toBe(true)
  })

  it('rejects DM and group channels', () => {
    expect(isTeamChannel(makeChannel({ type: 'D' }))).toBe(false)
    expect(isTeamChannel(makeChannel({ type: 'G' }))).toBe(false)
  })
})

describe('shouldAutoRespond', () => {
  it('auto-responds in DMs', () => {
    expect(shouldAutoRespond('D')).toBe(true)
  })

  it('auto-responds in group DMs', () => {
    expect(shouldAutoRespond('G')).toBe(true)
  })

  it('does NOT auto-respond in team channels', () => {
    expect(shouldAutoRespond('O')).toBe(false)
    expect(shouldAutoRespond('P')).toBe(false)
  })
})

describe('isMentioned', () => {
  it('detects mention in list', () => {
    expect(isMentioned(['user-1', 'user-2', 'bot-1'], 'bot-1')).toBe(true)
  })

  it('returns false when not mentioned', () => {
    expect(isMentioned(['user-1', 'user-2'], 'bot-1')).toBe(false)
  })

  it('handles empty mentions', () => {
    expect(isMentioned([], 'bot-1')).toBe(false)
  })
})

describe('containsTrigger', () => {
  it('detects trigger in message', () => {
    expect(containsTrigger('Hey @bot help me', '@bot')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(containsTrigger('Hey @BOT help', '@bot')).toBe(true)
  })

  it('returns false when trigger absent', () => {
    expect(containsTrigger('Just chatting', '@bot')).toBe(false)
  })

  it('returns false for empty trigger', () => {
    expect(containsTrigger('Hello', '')).toBe(false)
  })
})

describe('stripTrigger', () => {
  it('removes trigger from text', () => {
    expect(stripTrigger('@bot hello world', '@bot')).toBe('hello world')
  })

  it('handles trigger in the middle', () => {
    expect(stripTrigger('hey @bot help', '@bot')).toBe('hey help')
  })

  it('returns text unchanged if no trigger', () => {
    expect(stripTrigger('just text', '')).toBe('just text')
  })

  it('returns text unchanged if trigger not found', () => {
    expect(stripTrigger('hello world', '@bot')).toBe('hello world')
  })

  it('is case-insensitive', () => {
    expect(stripTrigger('@BOT do stuff', '@bot')).toBe('do stuff')
  })
})
