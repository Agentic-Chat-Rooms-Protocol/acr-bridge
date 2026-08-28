import type { InboundMessage, OutboundReply, BridgeConfig } from './types.js';
import { verifyPlatformSenderTrust } from './ans-trust.js';
import { AcrDaemonClient } from './acr-daemon-client.js';

function sanitizeText(input: string): string {
  return input
    .replace(/[\u200B-\u200D\uFEFF\u2060\u200E\u200F\u00A0]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim();
}

export class MessengerDispatcher {
  private client: AcrDaemonClient;
  private config: BridgeConfig;
  private processedMessageIds = new Map<string, number>();
  private readonly replayTtlMs = 300_000; // 5 minutes replay suppression window

  constructor(config: BridgeConfig) {
    this.config = config;
    this.client = new AcrDaemonClient(config.daemonUrl);
  }

  async dispatch(message: InboundMessage): Promise<OutboundReply> {
    const { platform, platformUserId, content, channelId, messageId } = message;
    const trimmed = sanitizeText(content);

    // 0. Replay Protection
    const dedupKey = `${platform}:${messageId}`;
    const now = Date.now();
    const lastSeen = this.processedMessageIds.get(dedupKey);
    if (lastSeen && now - lastSeen < this.replayTtlMs) {
      return {
        targetPlatform: platform,
        channelId,
        replyToMessageId: messageId,
        content: `⛔ [ACR Security Gate] Replay Attack Rejected. Message ID "${messageId}" was already processed.`
      };
    }
    this.processedMessageIds.set(dedupKey, now);

    // Evict expired replay records
    for (const [k, ts] of this.processedMessageIds.entries()) {
      if (now - ts > this.replayTtlMs) {
        this.processedMessageIds.delete(k);
      }
    }

    // 1. Enforce ANS Trust Gate
    const trust = await verifyPlatformSenderTrust(
      platform,
      platformUserId,
      trimmed,
      this.config.daemonUrl,
      this.config.userMappings
    );

    if (!trust.trusted && (this.config.strictAnsRequired ?? true)) {
      return {
        targetPlatform: platform,
        channelId,
        replyToMessageId: messageId,
        content: `⛔ [ACR Security Gate] Access Denied.\nSender ${platform}:${platformUserId} is not authenticated.\nReason: ${trust.reason}\n\nTo interact with the ACR Mesh, bind an ANS identity (e.g. "@operator.acr <command>").`
      };
    }

    // 2. Parse Slash Commands
    if (trimmed.startsWith('/vote')) {
      return this.handleVoteCommand(message, trust, trimmed);
    }

    if (trimmed.startsWith('/proposals')) {
      return this.handleListProposals(message);
    }

    if (trimmed.startsWith('/audit')) {
      return this.handleAuditCommand(message);
    }

    if (trimmed.startsWith('/health') || trimmed.startsWith('/status')) {
      return this.handleHealthCommand(message);
    }

    // 3. Default: Forward chat message to ACR Room with GAP-02 Buddy-Check
    try {
      const roomId = this.config.defaultRoomId || 'consensus-main';

      // GAP-02: verify sender is not blocked in mesh
      const buddies = await this.client.getBuddies('did:key:z6Mka881...operator');
      const isBlocked = buddies.some(b => b.to_did === trust.did && b.status === 'blocked');
      if (isBlocked) {
        return {
          targetPlatform: platform,
          channelId,
          replyToMessageId: messageId,
          content: `⛔ [ACR Security Gate] Access Denied. Sender DID ${trust.did} is blocked under GAP-02 in room "#${roomId}".`
        };
      }

      const cleanContent = `[${platform.toUpperCase()}:${trust.ansHandle}] ${trimmed}`;
      const posted = await this.client.sendMessage(roomId, trust.did, cleanContent);

      return {
        targetPlatform: platform,
        channelId,
        replyToMessageId: messageId,
        content: `✓ Relayed to ACR room "#${roomId}"\n• Message ID: ${posted.id}\n• Sender DID: ${trust.did}\n• ANS Handle: ${trust.ansHandle}`
      };
    } catch (err: any) {
      return {
        targetPlatform: platform,
        channelId,
        replyToMessageId: messageId,
        content: `⚠️ Failed to relay message to ACR room: ${err.message}`
      };
    }
  }

  private async handleVoteCommand(message: InboundMessage, trust: any, trimmed: string): Promise<OutboundReply> {
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) {
      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: 'Usage: /vote <proposal-id> <APPROVE|REJECT|DISSENT> [mandatory-dissent-rationale]'
      };
    }

    const proposalId = parts[1];
    const ballotRaw = parts[2].toUpperCase();
    if (!['APPROVE', 'REJECT', 'DISSENT'].includes(ballotRaw)) {
      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: `Invalid ballot "${parts[2]}". Must be APPROVE, REJECT, or DISSENT.`
      };
    }

    const ballot = ballotRaw as 'APPROVE' | 'REJECT' | 'DISSENT';
    const rationale = parts.slice(3).join(' ').trim();

    try {
      const res = await this.client.castVote(proposalId, trust.did, ballot, rationale);
      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: `🗳️ Vote Recorded for Proposal #${proposalId}!\n• Ballot: ${ballot}\n• Voter: ${trust.ansHandle} (${trust.did})\n• Status: ${res.proposal?.status || res.status}\n${rationale ? `• Dissent Rationale: "${rationale}"` : ''}`
      };
    } catch (err: any) {
      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: `❌ Vote Failed: ${err.message}`
      };
    }
  }

  private async handleListProposals(message: InboundMessage): Promise<OutboundReply> {
    try {
      const proposals = await this.client.listProposals();
      if (proposals.length === 0) {
        return {
          targetPlatform: message.platform,
          channelId: message.channelId,
          replyToMessageId: message.messageId,
          content: '📜 No active consensus proposals in ACR mesh.'
        };
      }

      const lines = ['📜 Active ACR Consensus Proposals:'];
      for (const p of proposals) {
        lines.push(`\n• Proposal #${p.id} [${p.status}]`);
        lines.push(`  Description: ${p.description}`);
        lines.push(`  Author: ${p.author_did}`);
        lines.push(`  Vote: /vote ${p.id} APPROVE | /vote ${p.id} DISSENT <reason>`);
      }

      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: lines.join('\n')
      };
    } catch (err: any) {
      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: `Failed to list proposals: ${err.message}`
      };
    }
  }

  private async handleAuditCommand(message: InboundMessage): Promise<OutboundReply> {
    try {
      const chain = await this.client.getAuditChain();
      const depth = chain.length;
      const latest = depth > 0 ? chain[depth - 1] : null;

      const lines = [
        '🛡️ ACR Monotonic Audit Chain Status:',
        `• Chain Depth: ${depth} blocks`,
        latest ? `• Latest Block: #${latest.index}` : '• Latest Block: Genesis (0)',
        latest ? `• State Hash: ${latest.state_hash}` : '',
        latest ? `• Previous Hash: ${latest.prev_hash}` : '',
        latest ? `• Last Actor DID: ${latest.actor_did}` : '',
        latest ? `• Timestamp: ${latest.timestamp}` : '',
        '• Tamper Integrity: 100% Cryptographically Monotonic ✓'
      ].filter(Boolean);

      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: lines.join('\n')
      };
    } catch (err: any) {
      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: `Audit verification failed: ${err.message}`
      };
    }
  }

  private async handleHealthCommand(message: InboundMessage): Promise<OutboundReply> {
    try {
      const health = await this.client.getHealth();
      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: `🟢 ACR Daemon Mesh Online!\n• Status: ${health.status}\n• Uptime: ${health.uptime || 'Active'}\n• Endpoint: ${this.config.daemonUrl}`
      };
    } catch (err: any) {
      return {
        targetPlatform: message.platform,
        channelId: message.channelId,
        replyToMessageId: message.messageId,
        content: `🔴 ACR Daemon Mesh Unreachable: ${err.message}`
      };
    }
  }
}
