import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BridgeIdentity } from '@acr/platform-bridge-core';
import { JwksKey, JwksResolver, TeamsInboundHandler } from '../src/jwks_resolver.js';

describe('acr-bridge/teams: Dynamic OpenID JWKS & Teams Inbound Handler', () => {
  // Generate test RSA 2048 keypair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const jwkExport = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const KID = 'test-kid-2026';
  const testJwksKey: JwksKey = {
    kty: 'RSA',
    kid: KID,
    use: 'sig',
    alg: 'RS256',
    n: jwkExport.n,
    e: jwkExport.e,
  };

  function createSignedJwt(payloadOverrides: Record<string, any> = {}, kid = KID): string {
    const header = { alg: 'RS256', kid };
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      iss: 'https://api.botframework.com',
      aud: 'acr-teams-app-01',
      exp: nowSec + 3600,
      nbf: nowSec - 10,
      ...payloadOverrides,
    };

    const hB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const pB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${hB64}.${pB64}`;

    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf-8'), privateKey);
    const sB64 = sig.toString('base64url');
    return `${signingInput}.${sB64}`;
  }

  it('should verify valid RS256 JWT against cached JWKS key', async () => {
    const resolver = new JwksResolver('https://example.com/keys', 3600, [testJwksKey]);
    const token = createSignedJwt();

    const res = await resolver.verifyToken(token, {
      expectedAudience: 'acr-teams-app-01',
      expectedIssuer: 'https://api.botframework.com',
    });

    assert.equal(res.valid, true);
    assert.equal(res.payload?.aud, 'acr-teams-app-01');
    assert.equal(res.payload?.iss, 'https://api.botframework.com');
  });

  it('should reject expired JWT tokens', async () => {
    const resolver = new JwksResolver('https://example.com/keys', 3600, [testJwksKey]);
    const expiredToken = createSignedJwt({ exp: Math.floor(Date.now() / 1000) - 100 });

    const res = await resolver.verifyToken(expiredToken);
    assert.equal(res.valid, false);
    assert.ok(res.error?.includes('expired'));
  });

  it('should reject tampered JWT signatures', async () => {
    const resolver = new JwksResolver('https://example.com/keys', 3600, [testJwksKey]);
    const token = createSignedJwt();
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ iss: 'malicious' })).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const res = await resolver.verifyToken(tamperedToken);
    assert.equal(res.valid, false);
    assert.ok(res.error?.includes('signature verification failed'));
  });

  it('should handle Teams activity webhook, scrub PII, and emit valid InboundBridgeEnvelope', async () => {
    const handler = new TeamsInboundHandler({
      appId: 'acr-teams-app-01',
      expectedIssuer: 'https://api.botframework.com',
      initialKeys: [testJwksKey],
    });

    const token = createSignedJwt();
    const activity = {
      id: 'activity_msg_1001',
      channelId: 'msteams',
      conversation: { id: '19:meeting_thread_01' },
      from: { id: '29:user_bot_1', name: 'Commander Data' },
      text: 'Confidential deployment request: card 4111111111111111 mail data@starfleet.org',
      timestamp: '2026-10-01T20:30:00.000Z',
    };

    const res = await handler.handleWebhook(
      { authorization: `Bearer ${token}` },
      JSON.stringify(activity)
    );

    assert.equal(res.statusCode, 200);
    assert.ok(res.envelope);
    assert.equal(res.envelope.platform, 'teams');
    assert.equal(res.envelope.external_channel_id, '19:meeting_thread_01');
    assert.equal(res.envelope.external_message_id, 'activity_msg_1001');
    assert.equal(res.envelope.author_display, 'Commander Data');
    assert.equal(res.envelope.content, 'Confidential deployment request: card <CARD> mail <EMAIL>');

    // Validate Ed25519 signature
    assert.equal(BridgeIdentity.verify(res.envelope), true);
  });

  it('should prevent replay of duplicate Teams activities', async () => {
    const handler = new TeamsInboundHandler({
      appId: 'acr-teams-app-01',
      initialKeys: [testJwksKey],
    });

    const token = createSignedJwt();
    const activity = {
      id: 'activity_replay_01',
      conversation: { id: 'c1' },
      text: 'First proposal',
    };
    const body = JSON.stringify(activity);

    const first = await handler.handleWebhook({ authorization: `Bearer ${token}` }, body);
    assert.equal(first.statusCode, 200);
    assert.ok(first.envelope);

    const second = await handler.handleWebhook({ authorization: `Bearer ${token}` }, body);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.status, 'IGNORED_DUPLICATE');
    assert.equal(second.envelope, undefined);
  });
});
