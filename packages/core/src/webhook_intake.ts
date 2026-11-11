import crypto from 'node:crypto';

interface SeenEntry {
  expiresAt: number;
}

/**
 * KirschMitzenmacherBloomFilter: Clean-room non-authoritative membership filter
 * using FNV-1a + Murmur3 32-bit finalizer with forced odd step (h2 | 1) over a power-of-two bitset.
 *
 * Architectural Rule (Experiment 8): Keep strictly out of authoritative approval and event-processing
 * decisions. A Bloom positive ("maybe in set") MUST always be verified against the authoritative Tier-2 store.
 */
export class KirschMitzenmacherBloomFilter {
  public readonly bitCount: number;
  public readonly hashCount: number;
  private readonly words: Uint32Array;
  private seed: number;

  constructor(bitCountPowerOfTwo = 65536, hashCount = 4, seed = 0x811c9dc5) {
    if (bitCountPowerOfTwo <= 0 || (bitCountPowerOfTwo & (bitCountPowerOfTwo - 1)) !== 0) {
      throw new Error('bitCountPowerOfTwo must be a positive power of two');
    }
    this.bitCount = bitCountPowerOfTwo;
    this.hashCount = Math.max(1, hashCount);
    this.words = new Uint32Array(Math.ceil(this.bitCount / 32));
    this.seed = seed >>> 0;
  }

  private fnv1a32(input: string): number {
    let hash = this.seed;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  private static murmurMix32(h: number): number {
    let k = h >>> 0;
    k ^= k >>> 16;
    k = Math.imul(k, 0x85ebca6b) >>> 0;
    k ^= k >>> 13;
    k = Math.imul(k, 0xc2b2ae35) >>> 0;
    k ^= k >>> 16;
    return k >>> 0;
  }

  private computeHashes(key: string): [number, number] {
    const h1 = this.fnv1a32(key);
    // Force odd h2 so gcd(h2, 2^p) === 1, preventing short-period bit cycles
    const h2 = (KirschMitzenmacherBloomFilter.murmurMix32(h1 ^ 0x9e3779b9) | 1) >>> 0;
    return [h1, h2];
  }

  public add(key: string): void {
    const [h1, h2] = this.computeHashes(key);
    const mask = this.bitCount - 1;
    for (let i = 0; i < this.hashCount; i++) {
      const bitIndex = (h1 + Math.imul(i, h2)) & mask;
      this.words[bitIndex >>> 5] |= 1 << (bitIndex & 31);
    }
  }

  public mightContain(key: string): boolean {
    const [h1, h2] = this.computeHashes(key);
    const mask = this.bitCount - 1;
    for (let i = 0; i < this.hashCount; i++) {
      const bitIndex = (h1 + Math.imul(i, h2)) & mask;
      if ((this.words[bitIndex >>> 5] & (1 << (bitIndex & 31))) === 0) {
        return false; // 100% guaranteed not in set
      }
    }
    return true; // Maybe in set (requires authoritative Tier-2 confirmation)
  }

  public clear(newSeed?: number): void {
    this.words.fill(0);
    if (newSeed !== undefined) {
      this.seed = newSeed >>> 0;
    }
  }
}

/**
 * SeenSet: Two-tier replay prevention cache with Tier-1 Kirsch-Mitzenmacher Bloom pre-filter
 * and Tier-2 authoritative Map with TTL and capacity bounding.
 *
 * Guarantees zero false-positive event drops: any Bloom positive is verified against Tier-2.
 */
export class SeenSet {
  private readonly cache = new Map<string, SeenEntry>();
  private readonly bloom: KirschMitzenmacherBloomFilter;
  private readonly defaultTtlSeconds: number;
  private readonly maxCapacity: number;
  private lastPruneTime = 0;
  private bloomFalsePositivesReconciled = 0;
  private bloomFastPathNegatives = 0;
  private bloomSeedRotations = 0;

  constructor(defaultTtlSeconds = 300, maxCapacity = 50000, bloomBitCount = 65536, bloomHashCount = 4) {
    this.defaultTtlSeconds = defaultTtlSeconds;
    this.maxCapacity = maxCapacity;
    this.bloom = new KirschMitzenmacherBloomFilter(bloomBitCount, bloomHashCount);
  }

  private makeKey(platform: string, channelId: string, messageId: string): string {
    return `${platform.length}:${platform}:${channelId.length}:${channelId}:${messageId.length}:${messageId}`;
  }

  /**
   * Rotates the Tier-1 Bloom filter cryptographic seed and rebuilds the bitset from
   * active Tier-2 authoritative entries, defeating precomputed collision stream DoS (Challenge E8).
   */
  public rotateBloomSeed(newSeed?: number, now = Date.now()): number {
    const seedToUse =
      newSeed !== undefined
        ? newSeed >>> 0
        : crypto.randomBytes(4).readUInt32LE(0);
    this.bloom.clear(seedToUse);
    this.bloomSeedRotations += 1;
    for (const [k, v] of this.cache.entries()) {
      if (v.expiresAt > now) {
        this.bloom.add(k);
      } else {
        this.cache.delete(k);
      }
    }
    return seedToUse;
  }

  public has(platform: string, channelId: string, messageId: string): boolean {
    const key = this.makeKey(platform, channelId, messageId);
    if (!this.bloom.mightContain(key)) {
      return false;
    }
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
   * If authoritatively replayed, returns false.
   * Bloom false positives are reconciled against Tier-2 and NEVER cause an unseen message to be dropped.
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
    const maybeInBloom = this.bloom.mightContain(key);

    if (maybeInBloom) {
      // Tier-1 Bloom says MAYBE seen -> consult Tier-2 authoritative store
      const existing = this.cache.get(key);
      if (existing && existing.expiresAt > now) {
        return false; // Confirmed authoritative replay!
      }
      // False positive in Bloom filter (or expired TTL entry) -> reconcile without dropping!
      this.bloomFalsePositivesReconciled += 1;
    } else {
      this.bloomFastPathNegatives += 1;
    }

    if (this.cache.size >= this.maxCapacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    this.bloom.add(key);
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

  public getTelemetryStats(): {
    authoritativeSize: number;
    bloomFalsePositivesReconciled: number;
    bloomFastPathNegatives: number;
    bloomSeedRotations: number;
  } {
    return {
      authoritativeSize: this.cache.size,
      bloomFalsePositivesReconciled: this.bloomFalsePositivesReconciled,
      bloomFastPathNegatives: this.bloomFastPathNegatives,
      bloomSeedRotations: this.bloomSeedRotations,
    };
  }

  public size(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
    this.bloom.clear();
    this.bloomFalsePositivesReconciled = 0;
    this.bloomFastPathNegatives = 0;
    this.bloomSeedRotations = 0;
  }
}

export interface WebhookRouteRegistration {
  route_id: string;
  tenant_id: string;
  source: 'github' | 'gitlab' | 'gitea' | 'linear' | 'slack' | 'generic';
  destination_id: string;
  hmac_secret: string;
  allowed_workspace_ids: string[];
  allowed_repositories?: string[];
}

export interface UnprivilegedIngressEvent {
  envelope_version: 'acr.webhook.ingress.v1';
  receipt_id: string;
  route_id: string;
  tenant_id: string;
  workspace_id: string;
  source: string;
  external_delivery_id: string;
  destination_id: string;
  execution_authority: 'NONE';
  trust_level: 'UNTRUSTED_EXTERNAL_EVENT';
  received_at: string;
  sanitized_payload: Record<string, unknown>;
}

export interface WebhookSecurityAuditEvent {
  event_type:
    | 'WEBHOOK_PAYLOAD_TOO_LARGE'
    | 'WEBHOOK_SIGNATURE_INVALID'
    | 'CROSS_WORKSPACE_ROUTING_DENIED'
    | 'WEBHOOK_REPLAY_SUPPRESSED';
  route_id: string;
  tenant_id?: string;
  attempted_workspace_id?: string;
  external_delivery_id?: string;
  status_code: number;
  timestamp: string;
}

export interface WebhookIntakeResult {
  status_code: 202 | 400 | 401 | 403 | 404 | 413;
  accepted: boolean;
  duplicate: boolean;
  dispatched: boolean;
  receipt_id?: string;
  error_code?: string;
  envelope?: UnprivilegedIngressEvent;
}

/**
 * Canonical length-prefixed deterministic webhook ID hash (`wh_sha256`).
 * Format: `${tenantId.length}:${tenantId}:${sourceId.length}:${sourceId}:${deliveryId.length}:${deliveryId}:${destinationId.length}:${destinationId}`
 * Prevents colon-delimiter boundary sliding collision attacks across tenants/sources.
 */
export function wh_sha256(
  tenantId: string,
  sourceId: string,
  deliveryId: string,
  destinationId = ''
): string {
  const canonical = `${tenantId.length}:${tenantId}:${sourceId.length}:${sourceId}:${deliveryId.length}:${deliveryId}:${destinationId.length}:${destinationId}`;
  const digest = crypto
    .createHash('sha256')
    .update(`acr.webhook.v1:${canonical}`, 'utf-8')
    .digest('hex');
  return `wh_sha256_${digest}`;
}

/**
 * WebhookIntakeBoundary: 6-phase authenticated ingestion boundary (Extension 2 & Experiment 4).
 *
 * Sequence:
 * 0. Enforce 64 KB raw byte limit before JSON parsing.
 * 1. Resolve workspace/route tenancy (before HMAC verification, since HMAC secrets are per-tenant).
 * 2. Authenticate sender via constant-time HMAC-SHA256 over raw bytes + zero secret buffer.
 * 3. Validate JSON & establish workspace ownership / enforce route allowlist (reject cross-workspace routing).
 * 4. Compute length-prefixed deterministic receipt ID (`wh_sha256`) and guard against concurrent burst replays via in-flight lock + 2-tier SeenSet.
 * 5. Persist durable receipt record.
 * 6. Schedule unprivileged task input (`execution_authority: 'NONE'`), stripping any self-asserted authority.
 */
export class WebhookIntakeBoundary {
  public static readonly MAX_RAW_BODY_BYTES = 65536; // 64 KB
  private readonly routes = new Map<string, WebhookRouteRegistration>();
  private readonly seenSet: SeenSet;
  private readonly inFlightDeliveries = new Set<string>();
  private readonly receipts = new Map<string, UnprivilegedIngressEvent>();
  private readonly dispatchedWorkflows: UnprivilegedIngressEvent[] = [];
  private readonly auditLog: WebhookSecurityAuditEvent[] = [];

  constructor(seenSet?: SeenSet) {
    this.seenSet = seenSet ?? new SeenSet(86400, 100000);
  }

  public registerRoute(route: WebhookRouteRegistration): void {
    this.routes.set(route.route_id, {
      ...route,
      allowed_workspace_ids: [...route.allowed_workspace_ids],
      allowed_repositories: route.allowed_repositories ? [...route.allowed_repositories] : undefined,
    });
  }

  public static computeSignature(rawBody: Buffer, secret: string): string {
    const keyBuf = Buffer.from(secret, 'utf-8');
    try {
      const digest = crypto.createHmac('sha256', keyBuf).update(rawBody).digest('hex');
      return `sha256=${digest}`;
    } finally {
      keyBuf.fill(0);
    }
  }

  public static verifyHmacConstantTime(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const providedHex = signatureHeader.slice('sha256='.length).trim();
    if (!/^[a-f0-9]{64}$/i.test(providedHex)) {
      return false;
    }

    const keyBuf = Buffer.from(secret, 'utf-8');
    try {
      const expectedBuf = crypto.createHmac('sha256', keyBuf).update(rawBody).digest();
      const providedBuf = Buffer.from(providedHex, 'hex');
      if (expectedBuf.length !== providedBuf.length) {
        return false;
      }
      return crypto.timingSafeEqual(expectedBuf, providedBuf);
    } finally {
      keyBuf.fill(0);
    }
  }

  public static computeDeterministicReceiptId(
    tenantId: string,
    sourceId: string,
    externalDeliveryId: string,
    destinationId = ''
  ): string {
    return wh_sha256(tenantId, sourceId, externalDeliveryId, destinationId);
  }

  public ingestRawWebhook(params: {
    routeId: string;
    rawBody: Buffer | string;
    signatureHeader?: string;
    externalDeliveryId: string;
    nowMs?: number;
  }): WebhookIntakeResult {
    const nowMs = params.nowMs ?? Date.now();
    const rawBuf = Buffer.isBuffer(params.rawBody)
      ? params.rawBody
      : Buffer.from(params.rawBody, 'utf-8');

    // Pre-parse guard: Enforce 64 KB raw byte limit
    if (rawBuf.byteLength > WebhookIntakeBoundary.MAX_RAW_BODY_BYTES) {
      this.auditLog.push({
        event_type: 'WEBHOOK_PAYLOAD_TOO_LARGE',
        route_id: params.routeId,
        external_delivery_id: params.externalDeliveryId,
        status_code: 413,
        timestamp: new Date(nowMs).toISOString(),
      });
      return {
        status_code: 413,
        accepted: false,
        duplicate: false,
        dispatched: false,
        error_code: 'PAYLOAD_TOO_LARGE',
      };
    }

    // Phase 1: Workspace / Route Tenancy Resolution (must precede HMAC verification)
    const route = this.routes.get(params.routeId);
    if (!route) {
      return {
        status_code: 404,
        accepted: false,
        duplicate: false,
        dispatched: false,
        error_code: 'ROUTE_NOT_FOUND',
      };
    }

    // Phase 2: Constant-time HMAC-SHA256 verification over raw bytes using tenant route secret
    if (!WebhookIntakeBoundary.verifyHmacConstantTime(rawBuf, params.signatureHeader, route.hmac_secret)) {
      this.auditLog.push({
        event_type: 'WEBHOOK_SIGNATURE_INVALID',
        route_id: route.route_id,
        tenant_id: route.tenant_id,
        external_delivery_id: params.externalDeliveryId,
        status_code: 401,
        timestamp: new Date(nowMs).toISOString(),
      });
      return {
        status_code: 401,
        accepted: false,
        duplicate: false,
        dispatched: false,
        error_code: 'INVALID_WEBHOOK_SIGNATURE',
      };
    }

    let parsed: Record<string, unknown>;
    try {
      const json = JSON.parse(rawBuf.toString('utf-8'));
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return {
          status_code: 400,
          accepted: false,
          duplicate: false,
          dispatched: false,
          error_code: 'INVALID_JSON_OBJECT',
        };
      }
      parsed = json as Record<string, unknown>;
    } catch {
      return {
        status_code: 400,
        accepted: false,
        duplicate: false,
        dispatched: false,
        error_code: 'MALFORMED_JSON',
      };
    }

    // Phase 3: Establish workspace ownership & validate routing boundaries
    const requestedWorkspaceId =
      typeof parsed.workspace_id === 'string' && parsed.workspace_id.trim().length > 0
        ? parsed.workspace_id.trim()
        : route.allowed_workspace_ids[0];

    if (!requestedWorkspaceId || !route.allowed_workspace_ids.includes(requestedWorkspaceId)) {
      this.auditLog.push({
        event_type: 'CROSS_WORKSPACE_ROUTING_DENIED',
        route_id: route.route_id,
        tenant_id: route.tenant_id,
        attempted_workspace_id: requestedWorkspaceId,
        external_delivery_id: params.externalDeliveryId,
        status_code: 403,
        timestamp: new Date(nowMs).toISOString(),
      });
      return {
        status_code: 403,
        accepted: false,
        duplicate: false,
        dispatched: false,
        error_code: 'CROSS_WORKSPACE_ROUTING_DENIED',
      };
    }

    if (route.allowed_repositories && typeof parsed.repository === 'string') {
      if (!route.allowed_repositories.includes(parsed.repository)) {
        this.auditLog.push({
          event_type: 'CROSS_WORKSPACE_ROUTING_DENIED',
          route_id: route.route_id,
          tenant_id: route.tenant_id,
          attempted_workspace_id: requestedWorkspaceId,
          external_delivery_id: params.externalDeliveryId,
          status_code: 403,
          timestamp: new Date(nowMs).toISOString(),
        });
        return {
          status_code: 403,
          accepted: false,
          duplicate: false,
          dispatched: false,
          error_code: 'REPOSITORY_NOT_ALLOWLISTED',
        };
      }
    }

    // Phase 4: Length-prefixed deterministic receipt ID & atomic in-flight + 2-tier SeenSet deduplication
    const receiptId = WebhookIntakeBoundary.computeDeterministicReceiptId(
      route.tenant_id,
      route.source,
      params.externalDeliveryId,
      route.destination_id
    );

    if (this.inFlightDeliveries.has(receiptId) || this.receipts.has(receiptId)) {
      this.auditLog.push({
        event_type: 'WEBHOOK_REPLAY_SUPPRESSED',
        route_id: route.route_id,
        tenant_id: route.tenant_id,
        attempted_workspace_id: requestedWorkspaceId,
        external_delivery_id: params.externalDeliveryId,
        status_code: 202,
        timestamp: new Date(nowMs).toISOString(),
      });
      return {
        status_code: 202,
        accepted: true,
        duplicate: true,
        dispatched: false,
        receipt_id: receiptId,
      };
    }

    this.inFlightDeliveries.add(receiptId);
    try {
      const isFirstSeen = this.seenSet.checkAndAdd(route.source, route.tenant_id, receiptId);
      if (!isFirstSeen) {
        this.auditLog.push({
          event_type: 'WEBHOOK_REPLAY_SUPPRESSED',
          route_id: route.route_id,
          tenant_id: route.tenant_id,
          attempted_workspace_id: requestedWorkspaceId,
          external_delivery_id: params.externalDeliveryId,
          status_code: 202,
          timestamp: new Date(nowMs).toISOString(),
        });
        return {
          status_code: 202,
          accepted: true,
          duplicate: true,
          dispatched: false,
          receipt_id: receiptId,
        };
      }

      // Strip any privilege-escalation or self-approval fields from untrusted webhook payload
      const sanitizedPayload: Record<string, unknown> = { ...parsed };
      delete sanitizedPayload.execution_authority;
      delete sanitizedPayload.approved_by;
      delete sanitizedPayload.bypass_policy;
      delete sanitizedPayload.admin_override;
      delete sanitizedPayload.operator_signature;

      // Phase 5 & 6: Persist durable receipt & schedule unprivileged task input
      const envelope: UnprivilegedIngressEvent = {
        envelope_version: 'acr.webhook.ingress.v1',
        receipt_id: receiptId,
        route_id: route.route_id,
        tenant_id: route.tenant_id,
        workspace_id: requestedWorkspaceId,
        source: route.source,
        external_delivery_id: params.externalDeliveryId,
        destination_id: route.destination_id,
        execution_authority: 'NONE',
        trust_level: 'UNTRUSTED_EXTERNAL_EVENT',
        received_at: new Date(nowMs).toISOString(),
        sanitized_payload: sanitizedPayload,
      };

      this.receipts.set(receiptId, envelope);
      this.dispatchedWorkflows.push(envelope);

      return {
        status_code: 202,
        accepted: true,
        duplicate: false,
        dispatched: true,
        receipt_id: receiptId,
        envelope,
      };
    } finally {
      this.inFlightDeliveries.delete(receiptId);
    }
  }

  /**
   * Asynchronous ingestion entrypoint that holds the in-flight delivery lock across simulated
   * or real asynchronous outbox commit latency, preventing microsecond Promise.all burst replays
   * from dispatching duplicate workflows before the outbox commit finishes.
   */
  public async ingestRawWebhookAsync(
    params: {
      routeId: string;
      rawBody: Buffer | string;
      signatureHeader?: string;
      externalDeliveryId: string;
      nowMs?: number;
      simulatedOutboxLatencyMs?: number;
    }
  ): Promise<WebhookIntakeResult> {
    const route = this.routes.get(params.routeId);
    if (!route) {
      return this.ingestRawWebhook(params);
    }

    const receiptId = WebhookIntakeBoundary.computeDeterministicReceiptId(
      route.tenant_id,
      route.source,
      params.externalDeliveryId,
      route.destination_id
    );

    if (this.inFlightDeliveries.has(receiptId) || this.receipts.has(receiptId)) {
      const nowMs = params.nowMs ?? Date.now();
      this.auditLog.push({
        event_type: 'WEBHOOK_REPLAY_SUPPRESSED',
        route_id: route.route_id,
        tenant_id: route.tenant_id,
        external_delivery_id: params.externalDeliveryId,
        status_code: 202,
        timestamp: new Date(nowMs).toISOString(),
      });
      return {
        status_code: 202,
        accepted: true,
        duplicate: true,
        dispatched: false,
        receipt_id: receiptId,
      };
    }

    this.inFlightDeliveries.add(receiptId);
    try {
      if (params.simulatedOutboxLatencyMs && params.simulatedOutboxLatencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, params.simulatedOutboxLatencyMs));
      }
      // Temporarily release so synchronous ingestRawWebhook can acquire cleanly within the same turn
      this.inFlightDeliveries.delete(receiptId);
      return this.ingestRawWebhook(params);
    } finally {
      this.inFlightDeliveries.delete(receiptId);
    }
  }

  public getDispatchedWorkflows(): UnprivilegedIngressEvent[] {
    return [...this.dispatchedWorkflows];
  }

  public getAuditLog(): WebhookSecurityAuditEvent[] {
    return [...this.auditLog];
  }
}
