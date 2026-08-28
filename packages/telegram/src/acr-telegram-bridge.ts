import { MessengerDispatcher } from '../../acr-bridge-core/src/messenger-dispatcher.js';
import type { InboundMessage, OutboundReply } from '../../acr-bridge-core/src/types.js';

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    date: number;
  };
}

export class AcrTelegramBridge {
  private dispatcher: MessengerDispatcher;

  constructor(daemonUrl: string = 'http://127.0.0.1:20443', userMappings: Record<string, string> = {}) {
    this.dispatcher = new MessengerDispatcher({
      daemonUrl,
      defaultRoomId: 'consensus-main',
      userMappings,
      strictAnsRequired: true
    });
  }

  async handleUpdate(update: TelegramUpdate): Promise<OutboundReply | null> {
    if (!update.message || !update.message.text) {
      return null;
    }

    const inbound: InboundMessage = {
      platform: 'telegram',
      platformUserId: String(update.message.from?.id || update.message.chat.id),
      platformUserName: update.message.from?.username,
      channelId: String(update.message.chat.id),
      messageId: String(update.message.message_id),
      content: update.message.text,
      timestamp: new Date(update.message.date * 1000).toISOString()
    };

    return this.dispatcher.dispatch(inbound);
  }
}
