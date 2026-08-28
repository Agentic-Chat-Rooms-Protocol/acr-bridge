import { MessengerDispatcher } from '../../acr-bridge-core/src/messenger-dispatcher.js';
import type { InboundMessage, OutboundReply } from '../../acr-bridge-core/src/types.js';
import type { MattermostPost } from './types.js';

export class AcrMattermostBridge {
  private dispatcher: MessengerDispatcher;

  constructor(daemonUrl: string = 'http://127.0.0.1:20443', userMappings: Record<string, string> = {}) {
    this.dispatcher = new MessengerDispatcher({
      daemonUrl,
      defaultRoomId: 'consensus-main',
      userMappings,
      strictAnsRequired: true
    });
  }

  async handlePost(post: MattermostPost, username?: string): Promise<OutboundReply | null> {
    if (!post.message) {
      return null;
    }

    const inbound: InboundMessage = {
      platform: 'mattermost',
      platformUserId: post.user_id,
      platformUserName: username,
      channelId: post.channel_id,
      messageId: post.id,
      content: post.message,
      timestamp: new Date(post.create_at).toISOString()
    };

    return this.dispatcher.dispatch(inbound);
  }
}
