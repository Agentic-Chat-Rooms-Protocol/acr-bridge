import { MessengerDispatcher } from '../../acr-bridge-core/src/messenger-dispatcher.js';
import type { InboundMessage, OutboundReply } from '../../acr-bridge-core/src/types.js';

export interface SignalDataMessage {
  timestamp: number;
  message?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  groupInfo?: {
    groupId: string;
  };
}

export class AcrSignalBridge {
  private dispatcher: MessengerDispatcher;

  constructor(daemonUrl: string = 'http://127.0.0.1:20443', userMappings: Record<string, string> = {}) {
    this.dispatcher = new MessengerDispatcher({
      daemonUrl,
      defaultRoomId: 'consensus-main',
      userMappings,
      strictAnsRequired: true
    });
  }

  async handleMessage(msg: SignalDataMessage): Promise<OutboundReply | null> {
    if (!msg.message) {
      return null;
    }

    const senderId = msg.sourceUuid || msg.sourceNumber || 'unknown';
    const channelId = msg.groupInfo?.groupId || senderId;

    const inbound: InboundMessage = {
      platform: 'signal',
      platformUserId: senderId,
      platformUserName: msg.sourceName,
      channelId,
      messageId: String(msg.timestamp),
      content: msg.message,
      timestamp: new Date(msg.timestamp).toISOString()
    };

    return this.dispatcher.dispatch(inbound);
  }
}
