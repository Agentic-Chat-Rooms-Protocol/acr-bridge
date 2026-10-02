import crypto from 'node:crypto';
import { BridgeIdentity, InboundBridgeEnvelope, PiiScrubber, SeenSet } from '@acr/platform-bridge-core';

export interface JwksKey {
  kty: 'RSA';
  kid: string;
  use: 'sig';
  alg: 'RS256';
  n: string;
  e: string;
}

export interface DynamicJwksCache {
  endpoint_url: string;
  keys: JwksKey[];
  last_fetched_at: string;
  ttl_seconds: number;
}

export interface TeamsActivityVerification {
  bearer_token: string;
  app_id?: string;
  issuer?: string;
}

export interface TeamsInboundConfig {
  jwksEndpointUrl?: string;
  appId?: string;
  expectedIssuer?: string;
  bridgeIdentity?: BridgeIdentity;
  seenSet?: SeenSet;
  piiScrubber?: PiiScrubber;
  targetRoomTopic?: string;
  cacheTtlSeconds?: number;
  initialKeys?: JwksKey[];
}

export interface TeamsWebhookResult {
  statusCode: number;
  body: Record<string, any>;
  envelope?: InboundBridgeEnvelope;
}

/**
 * Resolves, caches, and validates dynamic OpenID JWKS RSA keys.
 */
export class JwksResolver {
  public readonly endpointUrl: string;
  private readonly ttlSeconds: number;
  private cachedKeys = new Map<string, JwksKey>();
  private keyObjects = new Map<string, crypto.KeyObject>();
  private lastFetchedAt: number = 0;

  constructor(endpointUrl = 'https://login.botframework.com/v1/.well-known/keys', ttlSeconds = 3600, initialKeys?: JwksKey[]) {
    this.endpointUrl = endpointUrl;
    this.ttlSeconds = ttlSeconds;
    if (initialKeys) {
      this.populateKeys(initialKeys);
      this.lastFetchedAt = Date.now();
    }
  }

  private populateKeys(keys: JwksKey[]): void {
    for (const k of keys) {
      if (k.kty === 'RSA' && k.kid && k.n && k.e) {
        this.cachedKeys.set(k.kid, k);
        try {
          const keyObj = crypto.createPublicKey({
            key: {
              kty: 'RSA',
              n: k.n,
              e: k.e,
            },
            format: 'jwk',
          });
          this.keyObjects.set(k.kid, keyObj);
        } catch {
          // ignore invalid jwk key
        }
      }
    }
  }

  public async fetchKeys(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.cachedKeys.size > 0 && now - this.lastFetchedAt < this.ttlSeconds * 1000) {
      return;
    }

    try {
      const resp = await fetch(this.endpointUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        throw new Error(`JWKS fetch failed with status ${resp.status}`);
      }
      const data = (await resp.json()) as { keys?: JwksKey[] };
      if (Array.isArray(data.keys)) {
        this.populateKeys(data.keys);
        this.lastFetchedAt = now;
      }
    } catch (err: any) {
      // In offline / air-gapped test environments, log or preserve existing cache
      if (this.cachedKeys.size === 0) {
        throw new Error(`Failed to resolve OpenID JWKS from ${this.endpointUrl}: ${err.message}`);
      }
    }
  }

  public getCacheMetadata(): DynamicJwksCache {
    return {
      endpoint_url: this.endpointUrl,
      keys: Array.from(this.cachedKeys.values()),
      last_fetched_at: new Date(this.lastFetchedAt || Date.now()).toISOString(),
      ttl_seconds: this.ttlSeconds,
    };
  }

  public async getKeyObject(kid: string): Promise<crypto.KeyObject | undefined> {
    let keyObj = this.keyObjects.get(kid);
    if (!keyObj) {
      await this.fetchKeys(true);
      keyObj = this.keyObjects.get(kid);
    }
    return keyObj;
  }

  /**
   * Validates an RS256 signed JWT against the dynamic JWKS keys.
   */
  public async verifyToken(
    token: string,
    options?: { expectedAudience?: string; expectedIssuer?: string }
  ): Promise<{ valid: boolean; payload?: Record<string, any>; error?: string }> {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Token missing or invalid' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Malformed JWT structure' };
    }

    let header: any;
    let payload: any;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    } catch {
      return { valid: false, error: 'Failed to decode JWT base64url segments' };
    }

    if (header.alg !== 'RS256') {
      return { valid: false, error: `Unsupported JWT algorithm: ${header.alg} (expected RS256)` };
    }

    if (!header.kid) {
      return { valid: false, error: 'Missing kid in JWT header' };
    }

    const keyObj = await this.getKeyObject(header.kid);
    if (!keyObj) {
      return { valid: false, error: `Key ID "${header.kid}" not found in JWKS cache` };
    }

    const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf-8');
    const signature = Buffer.from(parts[2], 'base64url');

    const isValidSig = crypto.verify('RSA-SHA256', data, keyObj, signature);
    if (!isValidSig) {
      return { valid: false, error: 'RS256 cryptographic signature verification failed' };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSeconds) {
      return { valid: false, error: 'JWT token expired' };
    }
    if (payload.nbf && payload.nbf > nowSeconds + 60) {
      return { valid: false, error: 'JWT token not yet valid (nbf)' };
    }

    if (options?.expectedIssuer && payload.iss !== options.expectedIssuer) {
      return { valid: false, error: `Issuer mismatch: got "${payload.iss}", expected "${options.expectedIssuer}"` };
    }

    if (options?.expectedAudience && payload.aud !== options.expectedAudience) {
      return { valid: false, error: `Audience mismatch: got "${payload.aud}", expected "${options.expectedAudience}"` };
    }

    return { valid: true, payload };
  }
}

/**
 * Enterprise Microsoft Teams Inbound Bridge Handler:
 * Authenticates Teams activities via dynamic JWKS RS256 tokens, scrubs egress PII, and re-signs into ACR envelopes.
 */
export class TeamsInboundHandler {
  public readonly jwks: JwksResolver;
  public readonly bridgeIdentity: BridgeIdentity;
  public readonly seenSet: SeenSet;
  public readonly piiScrubber: PiiScrubber;
  private readonly appId?: string;
  private readonly expectedIssuer: string;
  private readonly defaultTargetTopic: string;

  constructor(config: TeamsInboundConfig = {}) {
    this.jwks = new JwksResolver(
      config.jwksEndpointUrl || 'https://login.botframework.com/v1/.well-known/keys',
      config.cacheTtlSeconds || 3600,
      config.initialKeys
    );
    this.bridgeIdentity = config.bridgeIdentity || new BridgeIdentity();
    this.seenSet = config.seenSet || new SeenSet(300);
    this.piiScrubber = config.piiScrubber || new PiiScrubber({ mode: 'mask' });
    this.appId = config.appId;
    this.expectedIssuer = config.expectedIssuer || 'https://api.botframework.com';
    this.defaultTargetTopic = config.targetRoomTopic || 'teams-general';
  }

  public async handleWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string | Buffer
  ): Promise<TeamsWebhookResult> {
    const getHeader = (name: string): string | undefined => {
      const val = headers[name.toLowerCase()] ?? headers[name];
      return Array.isArray(val) ? val[0] : val;
    };

    const authHeader = getHeader('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        body: { error: 'Missing or malformed Authorization Bearer header' },
      };
    }

    const token = authHeader.slice(7).trim();
    const tokenResult = await this.jwks.verifyToken(token, {
      expectedAudience: this.appId,
      expectedIssuer: this.expectedIssuer,
    });

    if (!tokenResult.valid) {
      return {
        statusCode: 401,
        body: { error: tokenResult.error || 'Teams RS256 JWT validation failed' },
      };
    }

    let activity: any;
    try {
      const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : rawBody;
      activity = JSON.parse(bodyStr);
    } catch {
      return {
        statusCode: 400,
        body: { error: 'Invalid JSON payload from Teams' },
      };
    }

    // Process activity
    const messageId = activity.id || `teams_${Date.now()}`;
    const channelId = activity.conversation?.id || activity.channelId || 'general';
    const author = activity.from?.name || activity.from?.id || 'teams_user';
    const text = activity.text || '';

    // Replay prevention
    const isFresh = this.seenSet.checkAndAdd('teams', channelId, messageId);
    if (!isFresh) {
      return {
        statusCode: 200,
        body: { status: 'IGNORED_DUPLICATE', reason: 'Replay prevention: activity already processed' },
      };
    }

    // Egress PII scrubbing
    const scrubbed = this.piiScrubber.scrubText(text);

    // Re-sign into ACR envelope
    const envelope = this.bridgeIdentity.signEvent({
      platform: 'teams',
      external_channel_id: channelId,
      external_message_id: messageId,
      author_display: author,
      content: scrubbed.text,
      target_room_topic: this.defaultTargetTopic,
      timestamp: activity.timestamp || new Date().toISOString(),
    });

    return {
      statusCode: 200,
      body: {
        ok: true,
        envelope_signature: envelope.bridged_signature,
        redacted_count: scrubbed.redactions.length,
      },
      envelope,
    };
  }
}
