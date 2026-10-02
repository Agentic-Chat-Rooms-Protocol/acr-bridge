import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PiiScrubber, scrubPiiText, scrubPii } from '../src/pii_scrubber.js';
import { BridgeIdentity, SeenSet } from '../src/inbound_mesh.js';

describe('acr-bridge/core: PiiScrubber', () => {
  it('should scrub credit card (Luhn validated), email, and phone in mask mode', () => {
    const text = 'Card: 4111111111111111, email: alice@example.com, phone: 555-867-5309';
    const res = scrubPiiText(text, { mode: 'mask' });
    assert.equal(res.text, 'Card: <CARD>, email: <EMAIL>, phone: <PHONE>');
    assert.equal(res.redactions.length, 3);
  });

  it('should reject non-Luhn 16-digit sequences from CARD redaction', () => {
    const text = 'Order 1234567890123456 confirmed.';
    const res = scrubPiiText(text);
    assert.equal(res.text, 'Order 1234567890123456 confirmed.');
  });

  it('should support deterministic HMAC-SHA256 hash mode and partial mode', () => {
    const secret = 'custom-bridge-secret';
    const scrubberHash = new PiiScrubber({ mode: 'hash', secret });
    const res1 = scrubberHash.scrubText('user@test.org');
    const res2 = scrubberHash.scrubText('user@test.org');
    assert.equal(res1.text, res2.text);
    assert.match(res1.text, /^<EMAIL:[a-f0-9]{8}>$/);

    const scrubberPartial = new PiiScrubber({ mode: 'partial' });
    const partRes = scrubberPartial.scrubText('Card 4111111111111111');
    assert.equal(partRes.text, 'Card <CARD:****1111>');
  });

  it('should recursively scrub sensitive keys in complex payloads', () => {
    const payload = {
      messageId: 'msg-99',
      author: 'alice',
      password: 'mypassword',
      token: 'jwt-or-opaque-token',
      data: {
        email: 'alice@corp.net',
        note: 'Customer phone: 555-867-5309',
      },
    };

    const result = scrubPii(payload);
    assert.ok(result.redacted_keys_count >= 3);
    assert.equal(result.sanitized_payload.password, '[redacted]');
    assert.equal(result.sanitized_payload.token, '[redacted]');
    assert.equal(result.sanitized_payload.data.email, '[redacted]');
    assert.equal(result.sanitized_payload.data.note, 'Customer phone: <PHONE>');
  });

  it('should enforce block_on fail-closed behavior', () => {
    const scrubber = new PiiScrubber({ blockOn: ['CARD'] });
    assert.throws(
      () => scrubber.scrubText('Payment with card 4111111111111111'),
      /PII Scrubber blocked/
    );
  });
});

describe('acr-bridge/core: Inbound Bridge Mesh & SeenSet', () => {
  it('should produce cryptographic Ed25519 InboundBridgeEnvelope and verify successfully', () => {
    const identity = new BridgeIdentity();
    assert.match(identity.publicKeyHex, /^[a-f0-9]{64}$/);

    const envelope = identity.signEvent({
      platform: 'slack',
      external_channel_id: 'C12345',
      external_message_id: 'M98765',
      author_display: 'Alice Smith',
      content: 'Proposal to deploy agent pod to cluster-01',
      target_room_topic: 'ops-general',
      timestamp: '2026-10-01T20:00:00.000Z',
    });

    assert.equal(envelope.bridge_version, 'acr.bridge.inbound.v1');
    assert.equal(envelope.platform, 'slack');
    assert.equal(envelope.bridge_subpubkey, identity.publicKeyHex);
    assert.match(envelope.bridged_signature, /^[a-f0-9]{128}$/);

    const isValid = BridgeIdentity.verify(envelope);
    assert.equal(isValid, true);
  });

  it('should reject tampered InboundBridgeEnvelope', () => {
    const identity = new BridgeIdentity();
    const envelope = identity.signEvent({
      platform: 'teams',
      external_channel_id: '19:team-meeting',
      external_message_id: 'activity-001',
      author_display: 'Bob',
      content: 'Original message',
      target_room_topic: 'engineering',
    });

    // Tamper with content
    const tampered = { ...envelope, content: 'Tampered malicious message' };
    assert.equal(BridgeIdentity.verify(tampered), false);

    // Tamper with signature
    const tamperedSig = { ...envelope, bridged_signature: '0'.repeat(128) };
    assert.equal(BridgeIdentity.verify(tamperedSig), false);
  });

  it('should prevent replay attacks using SeenSet', () => {
    const seen = new SeenSet(10); // 10 second TTL

    const firstSeen = seen.checkAndAdd('slack', 'C100', 'msg-1');
    assert.equal(firstSeen, true);

    // Duplicate message in same channel should be rejected as replay
    const replayed = seen.checkAndAdd('slack', 'C100', 'msg-1');
    assert.equal(replayed, false);

    // Different message ID should be accepted
    const secondMsg = seen.checkAndAdd('slack', 'C100', 'msg-2');
    assert.equal(secondMsg, true);

    // Same message ID in different platform should be distinct
    const otherPlatform = seen.checkAndAdd('teams', 'C100', 'msg-1');
    assert.equal(otherPlatform, true);
  });
});
