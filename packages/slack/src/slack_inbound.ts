import crypto from 'node:crypto';
import { BridgeIdentity, InboundBridgeEnvelope, PiiScrubber, SeenSet } from '@acr/platform-bridge-core';

export interface SlackInboundConfig {
  signingSecret: string;
  bridgeIdentity?: BridgeIdentity;
  seenSet?: SeenSet;
  piiScrubber?: PiiScrubber;
  maxTimestampAgeSeconds?: number;
  targetRoomTopic?: string;
}

export interface SlackWebhookResult {
  statusCode: number;
  body: Record<string, any>;
  envelope?: InboundBridgeEnvelope;
  isChallenge?: boolean;
}

/**
 * Validates Slack Events API request signatures using HMAC-SHA256.
 * Signature base string format: "v0:{timestamp}:{body}"
 */
export function verifySlackSignature(options: {
  signingSecret: string;
  signatureHeader: string;
  timestampHeader: string | number;
  rawBody: string | Buffer;
  maxAgeSeconds?: number;
}): { valid: boolean; error?: string } {
  const { signingSecret, signatureHeader, timestampHeader, rawBody, maxAgeSeconds = 300 } = options;

  if (!signingSecret) {
    return { valid: false, error: 'Missing Slack signing secret' };
  }
  if (!signatureHeader || !signatureHeader.startsWith('v0=')) {
    return { valid: false, error: 'Invalid or missing X-Slack-Signature header' };
  }

  const tsNum = typeof timestampHeader === 'string' ? parseInt(timestampHeader, 10) : timestampHeader;
  if (isNaN(tsNum)) {
    return { valid: false, error: 'Invalid X-Slack-Request-Timestamp header' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - tsNum) > maxAgeSeconds) {
    return { valid: false, error: `Slack request timestamp expired (> ${maxAgeSeconds}s difference)` };
  }

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : rawBody;
  const sigBaseString = `v0:${tsNum}:${bodyStr}`;

  const hmac = crypto.createHmac('sha256', signingSecret).update(sigBaseString).digest('hex');
  const expectedSig = `v0=${hmac}`;

  try {
    const expectedBuf = Buffer.from(expectedSig, 'utf-8');
    const actualBuf = Buffer.from(signatureHeader, 'utf-8');

    if (expectedBuf.length !== actualBuf.length) {
      return { valid: false, error: 'Slack signature mismatch' };
    }

    const matches = crypto.timingSafeEqual(expectedBuf, actualBuf);
    return matches ? { valid: true } : { valid: false, error: 'Slack signature mismatch' };
  } catch {
    return { valid: false, error: 'Slack signature verification failed' };
  }
}

/**
 * Enterprise Slack Inbound Bridge Handler:
 * Authenticates Slack webhook events, avoids replays, scrubs egress PII, and re-signs into ACR envelopes.
 */
export class SlackInboundHandler {
  private readonly signingSecret: string;
  public readonly bridgeIdentity: BridgeIdentity;
  public readonly seenSet: SeenSet;
  public readonly piiScrubber: PiiScrubber;
  private readonly maxAgeSeconds: number;
  private readonly defaultTargetTopic: string;

  constructor(config: SlackInboundConfig) {
    this.signingSecret = config.signingSecret;
    this.bridgeIdentity = config.bridgeIdentity || new BridgeIdentity();
    this.seenSet = config.seenSet || new SeenSet(300);
    this.piiScrubber = config.piiScrubber || new PiiScrubber({ mode: 'mask' });
    this.maxAgeSeconds = config.maxTimestampAgeSeconds ?? 300;
    this.defaultTargetTopic = config.targetRoomTopic || 'slack-general';
  }

  public async handleWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string | Buffer
  ): Promise<SlackWebhookResult> {
    const getHeader = (name: string): string | undefined => {
      const val = headers[name.toLowerCase()] ?? headers[name];
      return Array.isArray(val) ? val[0] : val;
    };

    const signature = getHeader('x-slack-signature');
    const timestamp = getHeader('x-slack-request-timestamp');

    if (!signature || !timestamp) {
      return {
        statusCode: 401,
        body: { error: 'Missing required Slack authentication headers (X-Slack-Signature / X-Slack-Request-Timestamp)' },
      };
    }

    const verification = verifySlackSignature({
      signingSecret: this.signingSecret,
      signatureHeader: signature,
      timestampHeader: timestamp,
      rawBody,
      maxAgeSeconds: this.maxAgeSeconds,
    });

    if (!verification.valid) {
      return {
        statusCode: 401,
        body: { error: verification.error || 'Slack signature verification failed' },
      };
    }

    let payload: any;
    try {
      const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : rawBody;
      payload = JSON.parse(bodyStr);
    } catch {
      return {
        statusCode: 400,
        body: { error: 'Invalid JSON payload from Slack' },
      };
    }

    // 1. URL Verification Challenge
    if (payload.type === 'url_verification') {
      return {
        statusCode: 200,
        body: { challenge: payload.challenge },
        isChallenge: true,
      };
    }

    // 2. Event Callback Processing
    if (payload.type === 'event_callback' && payload.event) {
      const event = payload.event;
      const channelId = event.channel || 'general';
      const messageId = event.client_msg_id || event.ts || payload.event_id || `slack_${Date.now()}`;
      const user = event.user || 'slack_user';
      const rawText = event.text || '';

      // Replay prevention check
      const isFresh = this.seenSet.checkAndAdd('slack', channelId, messageId, this.maxAgeSeconds);
      if (!isFresh) {
        return {
          statusCode: 200,
          body: { status: 'IGNORED_DUPLICATE', reason: 'Replay prevention: event already processed' },
        };
      }

      // Egress PII Scrubbing
      const scrubResult = this.piiScrubber.scrubText(rawText);
      const sanitizedText = scrubResult.text;

      // Re-sign into cryptographically verifiable ACR envelope
      const envelope = this.bridgeIdentity.signEvent({
        platform: 'slack',
        external_channel_id: channelId,
        external_message_id: messageId,
        author_display: user,
        content: sanitizedText,
        target_room_topic: this.defaultTargetTopic,
        timestamp: new Date().toISOString(),
      });

      return {
        statusCode: 200,
        body: {
          ok: true,
          envelope_signature: envelope.bridged_signature,
          redacted_count: scrubResult.redactions.length,
        },
        envelope,
      };
    }

    return {
      statusCode: 200,
      body: { ok: true, ignored: true, type: payload.type },
    };
  }
}
