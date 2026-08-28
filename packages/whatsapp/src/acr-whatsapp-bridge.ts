import { MessengerDispatcher } from '../../acr-bridge-core/src/messenger-dispatcher.js';
import type { InboundMessage, OutboundReply } from '../../acr-bridge-core/src/types.js';

export interface WhatsAppIncomingMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
    participant?: string;
  };
  message?: {
    conversation?: string;
    extendedTextMessage?: {
      text?: string;
    };
  };
  messageTimestamp?: number;
}

export class AcrWhatsAppBridge {
  private dispatcher: MessengerDispatcher;

  constructor(daemonUrl: string = 'http://127.0.0.1:20443', userMappings: Record<string, string> = {}) {
    this.dispatcher = new MessengerDispatcher({
      daemonUrl,
      defaultRoomId: 'consensus-main',
      userMappings,
      strictAnsRequired: true
    });
  }

  async handleMessage(msg: WhatsAppIncomingMessage): Promise<OutboundReply | null> {
    if (msg.key.fromMe) {
      return null;
    }

    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!text) {
      return null;
    }

    const senderId = msg.key.participant || msg.key.remoteJid;
    const channelId = msg.key.remoteJid;

    const inbound: InboundMessage = {
      platform: 'whatsapp',
      platformUserId: senderId,
      channelId,
      messageId: msg.key.id,
      content: text,
      timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString()
    };

    return this.dispatcher.dispatch(inbound);
  }
}
