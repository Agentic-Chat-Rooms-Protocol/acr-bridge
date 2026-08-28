/**
 * Mattermost adapter configuration and platform types.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

export interface MattermostConfig {
  /** Whether this adapter is enabled */
  enabled: boolean
  /** Mattermost server base URL (e.g. "https://mattermost.example.com") */
  url: string
  /** Bot personal access token (PAT) */
  token: string
  /** Channel ID to listen on. If empty, listens on all channels the bot belongs to */
  channelId?: string
  /** Maximum message length before splitting (default 4000, some servers allow 16000) */
  maxMessageLength: number
  /** Trigger phrase that activates the bot in non-DM channels (e.g. "@botname" or "!ai") */
  trigger?: string
  /** Instance ID for loop-guard props stamp (defaults to random) */
  instanceId?: string
}

// ─── Mattermost API types ────────────────────────────────────────────────────

export interface MattermostUser {
  id: string
  username: string
  nickname?: string
  first_name?: string
  last_name?: string
  email?: string
  roles?: string
}

export interface MattermostChannel {
  id: string
  name: string
  display_name: string
  type: string
  team_id: string
  header?: string
  purpose?: string
}

export interface MattermostPost {
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

export interface MattermostFileInfo {
  id: string
  name: string
  mime_type: string
  size: number
}

export interface MattermostReaction {
  user_id: string
  post_id: string
  emoji_name: string
  create_at: number
}

// ─── WebSocket event types ───────────────────────────────────────────────────

export interface MattermostWSEvent {
  event: string
  seq: number
  data: Record<string, string>
  broadcast: {
    channel_id?: string
    team_id?: string
    user_id?: string
    omit_users?: Record<string, boolean>
  }
}

// ─── Session context ─────────────────────────────────────────────────────────

export interface MattermostSessionContext {
  channelId: string
  rootPostId: string
  channelType: string
  lastActivityTs: number
}
