import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BridgeIdentity } from '../../../core/src/index.js';
import {
  WhatsAppInboundHandler,
  verifyWhatsAppSignature,
  verifyWhatsAppSubscription,
} from '../whatsapp_inbound.js';

describe('acr-bridge/whatsapp: WhatsApp Cloud API Inbound Bridge Handler', () => {
  const VERIFY_TOKEN = 'acr_wa_verify_token_2026';
  const APP_SECRET = 'wa_app_secret_998877665544332211';

  it('should verify WhatsApp webhook subscription challenge (GET handshake)', () => {
    const handler = new WhatsAppInboundHandler({
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    });

    const resValid = handler.handleChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '1158201244',
    });
    assert.equal(resValid.statusCode, 200);
    assert.equal(resValid.challengeResponse, '1158201244');

    const resInvalid = handler.handleChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong_token',
      'hub.challenge': '1158201244',
    });
    assert.equal(resInvalid.statusCode, 403);
  });

  it('should authenticate webhook signature, scrub PII, and re-sign into valid InboundBridgeEnvelope', async () => {
    const handler = new WhatsAppInboundHandler({
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    });

    const bodyObj = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550001',
                  phone_number_id: 'PHONE_NUMBER_ID_100',
                },
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTQy',
                    timestamp: '1728000000',
                    text: {
                      body: 'Support ticket details: card 4111111111111111 email user@support.corp',
                    },
                    type: 'text',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const rawBody = JSON.stringify(bodyObj);
    const hash = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
    const signature = `sha256=${hash}`;

    const res = await handler.handleWebhook(
      { 'x-hub-signature-256': signature },
      rawBody
    );

    assert.equal(res.statusCode, 200);
    assert.ok(res.envelopes);
    assert.equal(res.envelopes?.length, 1);

    const envelope = res.envelopes![0];
    assert.equal(envelope.platform, 'whatsapp');
    assert.equal(envelope.external_channel_id, 'PHONE_NUMBER_ID_100');
    assert.equal(envelope.external_message_id, 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTQy');
    assert.equal(envelope.author_display, '15551234567');
    assert.equal(envelope.content, 'Support ticket details: card <CARD> email <EMAIL>');

    // Validate Ed25519 signature
    assert.equal(BridgeIdentity.verify(envelope), true);
  });

  it('should reject invalid or tampered signatures with 401', async () => {
    const handler = new WhatsAppInboundHandler({
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    });

    const rawBody = JSON.stringify({ test: 'payload' });
    const res = await handler.handleWebhook(
      { 'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000' },
      rawBody
    );

    assert.equal(res.statusCode, 401);
  });

  it('should prevent message replay via SeenSet deduplication', async () => {
    const handler = new WhatsAppInboundHandler({
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
    });

    const bodyObj = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'P1' },
                messages: [
                  {
                    id: 'msg_repeat_01',
                    from: '12345',
                    text: { body: 'First delivery' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const rawBody = JSON.stringify(bodyObj);
    const hash = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
    const signature = `sha256=${hash}`;

    const first = await handler.handleWebhook({ 'x-hub-signature-256': signature }, rawBody);
    assert.equal(first.envelopes?.length, 1);

    // Replay same webhook payload
    const second = await handler.handleWebhook({ 'x-hub-signature-256': signature }, rawBody);
    assert.equal(second.envelopes?.length, 0);
  });
});
