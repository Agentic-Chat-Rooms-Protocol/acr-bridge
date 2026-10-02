import crypto from 'node:crypto';

export type InboundPlatform = 'slack' | 'teams' | 'whatsapp' | 'irc';

export interface InboundBridgeEnvelope {
  bridge_version: 'acr.bridge.inbound.v1';
  platform: InboundPlatform;
  external_channel_id: string;
  external_message_id: string;
  author_display: string;
  content: string;
  target_room_topic: string;
  bridge_subpubkey: string;
  bridged_signature: string;
  timestamp: string;
}

export interface InboundEventInput {
  platform: InboundPlatform;
  external_channel_id: string;
  external_message_id: string;
  author_display: string;
  content: string;
  target_room_topic: string;
  timestamp?: string;
}

export function canonicalEnvelopePayload(
  platform: string,
  channelId: string,
  messageId: string,
  authorDisplay: string,
  targetRoomTopic: string,
  timestamp: string,
  content: string
): Buffer {
  const canonical = [
    'acr.bridge.inbound.v1',
    platform,
    channelId,
    messageId,
    authorDisplay,
    targetRoomTopic,
    timestamp,
    content,
  ].join('\n');
  return Buffer.from(canonical, 'utf-8');
}

/**
 * BridgeIdentity: Manages Ed25519 signing keys and produces verified InboundBridgeEnvelopes.
 */
export class BridgeIdentity {
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKey: crypto.KeyObject;
  public readonly publicKeyHex: string;

  constructor(seedOrPrivateKey?: string | Buffer) {
    if (seedOrPrivateKey) {
      const seedBuf =
        typeof seedOrPrivateKey === 'string' && seedOrPrivateKey.length === 64
          ? Buffer.from(seedOrPrivateKey, 'hex')
          : Buffer.isBuffer(seedOrPrivateKey) && seedOrPrivateKey.length === 32
          ? seedOrPrivateKey
          : null;

      if (seedBuf) {
        // Standard Ed25519 PKCS#8 prefix: 302e020100300506032b657004220420 + 32-byte raw private key
        const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
        const pkcs8Der = Buffer.concat([pkcs8Prefix, seedBuf]);
        this.privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
        this.publicKey = crypto.createPublicKey(this.privateKey);
      } else if (Buffer.isBuffer(seedOrPrivateKey)) {
        this.privateKey = crypto.createPrivateKey(seedOrPrivateKey);
        this.publicKey = crypto.createPublicKey(this.privateKey);
      } else {
        const pair = crypto.generateKeyPairSync('ed25519');
        this.privateKey = pair.privateKey;
        this.publicKey = pair.publicKey;
      }
    } else {
      const pair = crypto.generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }

    const exportedRaw = this.publicKey.export({ type: 'spki', format: 'der' });
    // In Ed25519 SPKI DER, raw 32-byte public key is the last 32 bytes
    const rawPub = exportedRaw.subarray(exportedRaw.length - 32);
    this.publicKeyHex = rawPub.toString('hex').toLowerCase();
  }

  public sign(payload: Buffer): string {
    const signature = crypto.sign(null, payload, this.privateKey);
    return signature.toString('hex').toLowerCase();
  }

  public signEvent(input: InboundEventInput): InboundBridgeEnvelope {
    const timestamp = input.timestamp || new Date().toISOString();
    const payload = canonicalEnvelopePayload(
      input.platform,
      input.external_channel_id,
      input.external_message_id,
      input.author_display,
      input.target_room_topic,
      timestamp,
      input.content
    );

    const bridged_signature = this.sign(payload);

    return {
      bridge_version: 'acr.bridge.inbound.v1',
      platform: input.platform,
      external_channel_id: input.external_channel_id,
      external_message_id: input.external_message_id,
      author_display: input.author_display,
      content: input.content,
      target_room_topic: input.target_room_topic,
      bridge_subpubkey: this.publicKeyHex,
      bridged_signature,
      timestamp,
    };
  }

  public static verify(envelope: InboundBridgeEnvelope): boolean {
    if (envelope.bridge_version !== 'acr.bridge.inbound.v1') {
      return false;
    }

    if (
      !/^[a-f0-9]{64}$/i.test(envelope.bridge_subpubkey) ||
      !/^[a-f0-9]{128}$/i.test(envelope.bridged_signature)
    ) {
      return false;
    }

    try {
      // Reconstruct SPKI DER from raw 32-byte Ed25519 public key
      // Standard Ed25519 SPKI header prefix: 302a300506032b6570032100
      const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
      const rawPub = Buffer.from(envelope.bridge_subpubkey, 'hex');
      const fullDer = Buffer.concat([spkiHeader, rawPub]);
      const keyObj = crypto.createPublicKey({ key: fullDer, format: 'der', type: 'spki' });

      const payload = canonicalEnvelopePayload(
        envelope.platform,
        envelope.external_channel_id,
        envelope.external_message_id,
        envelope.author_display,
        envelope.target_room_topic,
        envelope.timestamp,
        envelope.content
      );

      const sigBuf = Buffer.from(envelope.bridged_signature, 'hex');
      return crypto.verify(null, payload, keyObj, sigBuf);
    } catch {
      return false;
    }
  }
}

interface SeenEntry {
  expiresAt: number;
}

/**
 * SeenSet: Replay prevention cache with TTL and capacity bounding.
 */
export class SeenSet {
  private readonly cache = new Map<string, SeenEntry>();
  private readonly defaultTtlSeconds: number;
  private readonly maxCapacity: number;
  private lastPruneTime = 0;

  constructor(defaultTtlSeconds = 300, maxCapacity = 50000) {
    this.defaultTtlSeconds = defaultTtlSeconds;
    this.maxCapacity = maxCapacity;
  }

  private makeKey(platform: string, channelId: string, messageId: string): string {
    return `${platform}:${channelId}:${messageId}`;
  }

  public has(platform: string, channelId: string, messageId: string): boolean {
    const key = this.makeKey(platform, channelId, messageId);
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Checks if message was already seen. If not seen, records it and returns true.
   * If replayed, returns false.
   */
  public checkAndAdd(
    platform: string,
    channelId: string,
    messageId: string,
    ttlSeconds?: number
  ): boolean {
    const now = Date.now();
    if (now - this.lastPruneTime > 5000 || this.cache.size >= this.maxCapacity) {
      this.pruneExpired(now);
      this.lastPruneTime = now;
    }

    const key = this.makeKey(platform, channelId, messageId);
    const existing = this.cache.get(key);
    if (existing && existing.expiresAt > now) {
      return false; // Replay detected!
    }

    if (this.cache.size >= this.maxCapacity) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    this.cache.set(key, { expiresAt: now + ttl * 1000 });
    return true;
  }

  public pruneExpired(now = Date.now()): void {
    for (const [k, v] of this.cache.entries()) {
      if (v.expiresAt <= now) {
        this.cache.delete(k);
      }
    }
  }

  public size(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
  }
}
