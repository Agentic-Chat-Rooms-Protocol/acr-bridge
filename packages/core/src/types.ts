/**
 * ACR Platform Bridge Core Types
 */

export type PlatformType = 'telegram' | 'mattermost' | 'signal' | 'whatsapp';

export interface InboundMessage {
  platform: PlatformType;
  platformUserId: string;
  platformUserName?: string;
  channelId: string;
  messageId: string;
  content: string;
  timestamp?: string;
}

export interface OutboundReply {
  targetPlatform: PlatformType;
  channelId: string;
  content: string;
  replyToMessageId?: string;
  formattedContent?: {
    telegram?: string;
    mattermost?: string;
    signal?: string;
    whatsapp?: string;
  };
}

export interface PlatformTrustResult {
  trusted: boolean;
  reason: string;
  ansHandle: string;
  did: string;
  stateHash?: string;
  auditBlockIndex?: number;
}

export interface BridgeConfig {
  daemonUrl: string;
  defaultRoomId: string;
  userMappings?: Record<string, string>; // platformUserId -> ansHandle
  strictAnsRequired?: boolean;
}
