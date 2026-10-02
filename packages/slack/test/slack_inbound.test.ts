import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BridgeIdentity } from '@acr/platform-bridge-core';
import { SlackInboundHandler, verifySlackSignature } from '../src/slack_inbound.js';

describe('acr-bridge/slack: Slack Inbound Bridge Handler', () => {
  const SECRET = 'test_slack_signing_secret_xyz123';

  function signPayload(body: string, ts: number): string {
    const base = `v0:${ts}:${body}`;
    const hmac = crypto.createHmac('sha256', SECRET).update(base).digest('hex');
    return `v0=${hmac}`;
  }

  it('should handle Slack URL verification challenge handshake', async () => {
    const handler = new SlackInboundHandler({ signingSecret: SECRET });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge_token_abc123' });
    const sig = signPayload(body, ts);

    const res = await handler.handleWebhook(
      {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(ts),
      },
      body
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.isChallenge, true);
    assert.equal(res.body.challenge, 'challenge_token_abc123');
  });

  it('should verify signature, scrub PII, and re-sign into valid InboundBridgeEnvelope', async () => {
    const handler = new SlackInboundHandler({ signingSecret: SECRET });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C01234ABCD',
        ts: '1728000000.000100',
        user: 'U98765WXYZ',
        text: 'Operator notice: card 4111111111111111 email test@acr.mesh',
      },
    });
    const sig = signPayload(body, ts);

    const res = await handler.handleWebhook(
      {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(ts),
      },
      body
    );

    assert.equal(res.statusCode, 200);
    assert.ok(res.envelope);
    assert.equal(res.envelope.platform, 'slack');
    assert.equal(res.envelope.external_channel_id, 'C01234ABCD');
    assert.equal(res.envelope.author_display, 'U98765WXYZ');
    assert.equal(res.envelope.content, 'Operator notice: card <CARD> email <EMAIL>');

    // Validate Ed25519 signature
    assert.equal(BridgeIdentity.verify(res.envelope), true);
  });

  it('should reject invalid signatures with 401', async () => {
    const handler = new SlackInboundHandler({ signingSecret: SECRET });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'token' });

    const res = await handler.handleWebhook(
      {
        'x-slack-signature': 'v0=invalid_hex_signature',
        'x-slack-request-timestamp': String(ts),
      },
      body
    );

    assert.equal(res.statusCode, 401);
    assert.ok(res.body.error);
  });

  it('should reject expired request timestamps (> 300s) with 401', async () => {
    const handler = new SlackInboundHandler({ signingSecret: SECRET });
    const expiredTs = Math.floor(Date.now() / 1000) - 350; // 350s old
    const body = JSON.stringify({ type: 'url_verification', challenge: 'token' });
    const sig = signPayload(body, expiredTs);

    const res = await handler.handleWebhook(
      {
        'x-slack-signature': sig,
        'x-slack-request-timestamp': String(expiredTs),
      },
      body
    );

    assert.equal(res.statusCode, 401);
    assert.ok(res.body.error.includes('expired'));
  });

  it('should prevent replay of identical message IDs', async () => {
    const handler = new SlackInboundHandler({ signingSecret: SECRET });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C01',
        ts: '1728000000.000200',
        user: 'U01',
        text: 'Initial proposal',
      },
    });
    const sig = signPayload(body, ts);

    const first = await handler.handleWebhook(
      { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(ts) },
      body
    );
    assert.equal(first.statusCode, 200);
    assert.ok(first.envelope);

    // Replay same event
    const second = await handler.handleWebhook(
      { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(ts) },
      body
    );
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.status, 'IGNORED_DUPLICATE');
    assert.equal(second.envelope, undefined);
  });
});
