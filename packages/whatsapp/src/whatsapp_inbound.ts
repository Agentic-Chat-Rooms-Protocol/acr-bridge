import crypto from 'node:crypto';
import { BridgeIdentity, InboundBridgeEnvelope, PiiScrubber, SeenSet } from '../../core/src/index.js';

export interface WhatsAppInboundConfig {
  verifyToken: string;
  appSecret: string;
  bridgeIdentity?: BridgeIdentity;
  seenSet?: SeenSet;
  piiScrubber?: PiiScrubber;
  targetRoomTopic?: string;
}

export interface WhatsAppWebhookResult {
  statusCode: number;
  body: Record<string, any> | string;
  envelopes?: InboundBridgeEnvelope[];
}

/**
 * Validates WhatsApp Cloud API subscription verification handshake (GET).
 */
export function verifyWhatsAppSubscription(options: {
  mode?: string;
  token?: string;
  challenge?: string;
  expectedToken: string;
}): { verified: boolean; challenge?: string; error?: string } {
  const { mode, token, challenge, expectedToken } = options;

  if (mode === 'subscribe' && token === expectedToken) {
    return { verified: true, challenge: challenge || '' };
  }

  return { verified: false, error: 'Subscription verification failed: token or mode mismatch' };
}

/**
 * Validates WhatsApp Cloud API webhook request signature using HMAC-SHA256 (POST).
 * Header: X-Hub-Signature-256: sha256={hash}
 */
export function verifyWhatsAppSignature(options: {
  signatureHeader?: string;
  rawBody: string | Buffer;
  appSecret: string;
}): { valid: boolean; error?: string } {
  const { signatureHeader, rawBody, appSecret } = options;

  if (!appSecret) {
    return { valid: false, error: 'Missing WhatsApp app secret' };
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return { valid: false, error: 'Missing or invalid X-Hub-Signature-256 header' };
  }

  const expectedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const expectedHeader = `sha256=${expectedHash}`;

  try {
    const expectedBuf = Buffer.from(expectedHeader, 'utf-8');
    const actualBuf = Buffer.from(signatureHeader, 'utf-8');

    if (expectedBuf.length !== actualBuf.length) {
      return { valid: false, error: 'WhatsApp signature mismatch' };
    }

    const matches = crypto.timingSafeEqual(expectedBuf, actualBuf);
    return matches ? { valid: true } : { valid: false, error: 'WhatsApp signature mismatch' };
  } catch {
    return { valid: false, error: 'WhatsApp signature verification failed' };
  }
}

/**
 * Enterprise WhatsApp Cloud API Inbound Bridge Handler:
 * Authenticates webhooks, deduplicates messages via SeenSet, scrubs PII, and re-signs into ACR envelopes.
 */
export class WhatsAppInboundHandler {
  private readonly verifyToken: string;
  private readonly appSecret: string;
  public readonly bridgeIdentity: BridgeIdentity;
  public readonly seenSet: SeenSet;
  public readonly piiScrubber: PiiScrubber;
  private readonly defaultTargetTopic: string;

  constructor(config: WhatsAppInboundConfig) {
    this.verifyToken = config.verifyToken;
    this.appSecret = config.appSecret;
    this.bridgeIdentity = config.bridgeIdentity || new BridgeIdentity();
    this.seenSet = config.seenSet || new SeenSet(300);
    this.piiScrubber = config.piiScrubber || new PiiScrubber({ mode: 'mask' });
    this.defaultTargetTopic = config.targetRoomTopic || 'whatsapp-general';
  }

  public handleChallenge(queryParams: Record<string, string | undefined>): {
    statusCode: number;
    challengeResponse?: string;
    error?: string;
  } {
    const mode = queryParams['hub.mode'];
    const token = queryParams['hub.verify_token'];
    const challenge = queryParams['hub.challenge'];

    const verification = verifyWhatsAppSubscription({
      mode,
      token,
      challenge,
      expectedToken: this.verifyToken,
    });

    if (verification.verified) {
      return { statusCode: 200, challengeResponse: verification.challenge };
    }

    return { statusCode: 403, error: verification.error || 'Forbidden' };
  }

  public async handleWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string | Buffer
  ): Promise<WhatsAppWebhookResult> {
    const getHeader = (name: string): string | undefined => {
      const val = headers[name.toLowerCase()] ?? headers[name];
      return Array.isArray(val) ? val[0] : val;
    };

    const signature = getHeader('x-hub-signature-256');
    const verification = verifyWhatsAppSignature({
      signatureHeader: signature,
      rawBody,
      appSecret: this.appSecret,
    });

    if (!verification.valid) {
      return {
        statusCode: 401,
        body: { error: verification.error || 'WhatsApp signature validation failed' },
      };
    }

    let payload: any;
    try {
      const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : rawBody;
      payload = JSON.parse(bodyStr);
    } catch {
      return {
        statusCode: 400,
        body: { error: 'Invalid JSON payload from WhatsApp' },
      };
    }

    const envelopes: InboundBridgeEnvelope[] = [];

    if (payload.object === 'whatsapp_business_account' && Array.isArray(payload.entry)) {
      for (const entry of payload.entry) {
        if (!Array.isArray(entry.changes)) continue;
        for (const change of entry.changes) {
          const value = change.value;
          if (!value || !Array.isArray(value.messages)) continue;

          for (const msg of value.messages) {
            const messageId = msg.id || `wa_${Date.now()}`;
            const from = msg.from || 'unknown_wa_sender';
            const channelId = value.metadata?.phone_number_id || 'whatsapp_channel';
            const text = msg.text?.body || '';

            // Check replay
            const isFresh = this.seenSet.checkAndAdd('whatsapp', channelId, messageId);
            if (!isFresh) {
              continue;
            }

            // Scrub egress PII
            const scrubResult = this.piiScrubber.scrubText(text);

            // Re-sign into ACR envelope
            const envelope = this.bridgeIdentity.signEvent({
              platform: 'whatsapp',
              external_channel_id: channelId,
              external_message_id: messageId,
              author_display: from,
              content: scrubResult.text,
              target_room_topic: this.defaultTargetTopic,
              timestamp: msg.timestamp
                ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
                : new Date().toISOString(),
            });

            envelopes.push(envelope);
          }
        }
      }
    }

    return {
      statusCode: 200,
      body: { ok: true, processedCount: envelopes.length },
      envelopes,
    };
  }
}
