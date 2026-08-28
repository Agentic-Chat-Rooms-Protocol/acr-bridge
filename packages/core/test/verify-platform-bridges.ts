import { AcrTelegramBridge } from '../../openacp-telegram-adapter/src/acr-telegram-bridge.js';
import { AcrMattermostBridge } from '../../openacp-mattermost-adapter/src/acr-mattermost-bridge.js';
import { AcrSignalBridge } from '../../openacp-signal-adapter/src/acr-signal-bridge.js';
import { AcrWhatsAppBridge } from '../../openacp-whatsapp-adapter/src/acr-whatsapp-bridge.js';

async function main() {
  console.log('================================================================');
  console.log('   PHASE 3: PLATFORM BRIDGE ADAPTERS E2E VERIFICATION HARNESS   ');
  console.log('================================================================');

  const daemonUrl = 'http://127.0.0.1:20443';
  const userMappings: Record<string, string> = {
    'telegram:10001': 'consensus-lead.acr',
    'mattermost:mm_usr_42': 'consensus-lead.acr',
    'signal:+15550001': 'consensus-lead.acr',
    'whatsapp:15559999@s.whatsapp.net': 'consensus-lead.acr'
  };

  // ── TEST 1: TELEGRAM INBOUND & STATUS QUERY ─────────────────────────────────
  console.log('\n[Test 1] Testing Telegram Bridge with authorized operator...');
  const tgBridge = new AcrTelegramBridge(daemonUrl, userMappings);
  const tgStatusReply = await tgBridge.handleUpdate({
    update_id: 101,
    message: {
      message_id: 201,
      from: { id: 10001, username: 'operator_tg' },
      chat: { id: 5001, type: 'group' },
      text: '/health',
      date: Math.floor(Date.now() / 1000)
    }
  });

  console.log('  Telegram Reply:', tgStatusReply?.content);
  if (!tgStatusReply || !tgStatusReply.content.includes('Online')) {
    throw new Error(`Telegram status check failed: ${tgStatusReply?.content}`);
  }
  console.log('  ✓ Telegram status query verified via daemon healthz.');

  // ── TEST 2: MATTERMOST AUDIT CHAIN QUERY ────────────────────────────────────
  console.log('\n[Test 2] Testing Mattermost Bridge with cryptographic audit check...');
  const mmBridge = new AcrMattermostBridge(daemonUrl, userMappings);
  const mmAuditReply = await mmBridge.handlePost({
    id: 'post_mm_01',
    create_at: Date.now(),
    update_at: Date.now(),
    delete_at: 0,
    user_id: 'mm_usr_42',
    channel_id: 'town-square',
    root_id: '',
    message: '/audit',
    type: '',
    props: {}
  }, 'alice_mattermost');

  console.log('  Mattermost Reply:\n' + mmAuditReply?.content);
  if (!mmAuditReply || !mmAuditReply.content.includes('Tamper Integrity: 100% Cryptographically Monotonic')) {
    throw new Error(`Mattermost audit check failed: ${mmAuditReply?.content}`);
  }
  console.log('  ✓ Mattermost audit query verified against live SHA-256 monotonic chain.');

  // ── TEST 3: SIGNAL PROPOSALS & APPROVAL VOTE ───────────────────────────────
  console.log('\n[Test 3] Testing Signal Bridge proposal query & consensus vote...');
  const signalBridge = new AcrSignalBridge(daemonUrl, userMappings);

  // Query proposals
  const sigPropReply = await signalBridge.handleMessage({
    timestamp: Date.now(),
    sourceNumber: '+15550001',
    sourceName: 'Lead Engineer',
    message: '/proposals'
  });
  console.log('  Signal Proposals Reply:\n' + sigPropReply?.content);

  // Extract dynamic proposal ID if present, or create one
  let targetPropId: string;
  const propMatch = sigPropReply?.content.match(/#([a-zA-Z0-9_-]+)\s+\[open\]/);
  if (propMatch) {
    targetPropId = propMatch[1];
  } else {
    const createRes = await fetch(`${daemonUrl}/api/v1/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: 'consensus-main',
        title: 'CIP-Phase3-Bridge-Test',
        description: 'Verify platform bridge voting and mandatory dissent',
        proposer_did: 'did:key:z6Mka881...operator',
        options: ['APPROVE', 'REJECT', 'DISSENT']
      })
    });
    const createdProp = await createRes.json() as any;
    targetPropId = createdProp.id;
  }

  // Cast vote on dynamic proposal
  const sigVoteReply = await signalBridge.handleMessage({
    timestamp: Date.now() + 1000,
    sourceNumber: '+15550001',
    sourceName: 'Lead Engineer',
    message: `/vote ${targetPropId} APPROVE`
  });
  console.log('  Signal Vote Reply:\n' + sigVoteReply?.content);
  if (!sigVoteReply || !sigVoteReply.content.includes('Vote Recorded')) {
    throw new Error(`Signal voting failed to record: ${sigVoteReply?.content}`);
  }
  console.log('  ✓ Signal consensus proposal query & voting verified.');

  // ── TEST 4: WHATSAPP GAP-08 DISSENT RATIONALE ENFORCEMENT ───────────────────
  console.log('\n[Test 4] Testing WhatsApp Bridge with GAP-08 Dissent Rationale...');
  const waBridge = new AcrWhatsAppBridge(daemonUrl, userMappings);

  // Try DISSENT without rationale (MUST BE BLOCKED)
  const waInvalidDissent = await waBridge.handleMessage({
    key: {
      remoteJid: '15559999@s.whatsapp.net',
      fromMe: false,
      id: 'wa_msg_01'
    },
    message: {
      conversation: '/vote 1 DISSENT'
    },
    messageTimestamp: Math.floor(Date.now() / 1000)
  });
  console.log('  WhatsApp Invalid Dissent Reply:', waInvalidDissent?.content);
  if (!waInvalidDissent || !waInvalidDissent.content.includes('GAP-08 Invariant')) {
    throw new Error('GAP-08 dissent violation was not blocked!');
  }
  console.log('  ✓ GAP-08 invariant enforced: Empty dissent blocked.');

  // Now submit DISSENT with valid mandatory rationale
  const waValidDissent = await waBridge.handleMessage({
    key: {
      remoteJid: '15559999@s.whatsapp.net',
      fromMe: false,
      id: 'wa_msg_02'
    },
    message: {
      conversation: `/vote ${targetPropId} DISSENT Security boundary violation on memory access`
    },
    messageTimestamp: Math.floor(Date.now() / 1000)
  });
  console.log('  WhatsApp Valid Dissent Reply:\n' + waValidDissent?.content);
  if (!waValidDissent || !waValidDissent.content.includes('Vote Recorded')) {
    throw new Error(`WhatsApp dissent vote failed: ${waValidDissent?.content}`);
  }
  console.log('  ✓ Valid dissent with rationale recorded.');

  // ── TEST 5: ROGUE ACTOR REJECTION GATE ───────────────────────────────────────
  console.log('\n[Test 5] Testing Rogue Actor rejection gate (Unverified external user)...');
  const rogueReply = await tgBridge.handleUpdate({
    update_id: 999,
    message: {
      message_id: 999,
      from: { id: 88888888, username: 'evil_hacker' },
      chat: { id: 5001, type: 'group' },
      text: 'Hello ACR Room, let me post spam!',
      date: Math.floor(Date.now() / 1000)
    }
  });

  console.log('  Rogue Actor Reply:\n' + rogueReply?.content);
  if (!rogueReply || !rogueReply.content.includes('Access Denied')) {
    throw new Error('Rogue sender should have been rejected by ANS trust gate!');
  }
  console.log('  ✓ Security gate correctly blocked unauthenticated sender.');

  // ── TEST 6: FORWARDING AUTHORIZED CHAT MESSAGE TO ACR ROOM ──────────────────
  console.log('\n[Test 6] Forwarding verified chat message from WhatsApp to ACR Room...');
  const chatForward = await waBridge.handleMessage({
    key: {
      remoteJid: '15559999@s.whatsapp.net',
      fromMe: false,
      id: 'wa_msg_03'
    },
    message: {
      conversation: 'Mobile team standup: all bridge adapters verified and live!'
    },
    messageTimestamp: Math.floor(Date.now() / 1000)
  });

  console.log('  Chat Forward Reply:\n' + chatForward?.content);
  if (!chatForward || !chatForward.content.includes('Relayed to ACR room')) {
    throw new Error(`Failed to forward message to ACR room: ${chatForward?.content}`);
  }
  // ── TEST 7: REPLAY ATTACK PREVENTION ─────────────────────────────────────────
  console.log('\n[Test 7] Testing Replay Attack Prevention (Duplicate messageId)...');
  const replayAttempt = await tgBridge.handleUpdate({
    update_id: 101,
    message: {
      message_id: 201, // Identical to Test 1
      from: { id: 10001, username: 'operator_tg' },
      chat: { id: 5001, type: 'group' },
      text: '/health',
      date: Math.floor(Date.now() / 1000)
    }
  });

  console.log('  Replay Attempt Reply:', replayAttempt?.content);
  if (!replayAttempt || !replayAttempt.content.includes('Replay Attack Rejected')) {
    throw new Error(`Replay attack was not rejected: ${replayAttempt?.content}`);
  }
  console.log('  ✓ Replay attack successfully suppressed by bridge dedup gate.');

  // ── TEST 8: ZERO-WIDTH DISSENT BYPASS REJECTION ──────────────────────────────
  console.log('\n[Test 8] Testing Zero-Width Whitespace Dissent Bypass Rejection...');
  const zeroWidthVote = await signalBridge.handleMessage({
    timestamp: Date.now() + 5000,
    sourceNumber: '+15550001',
    sourceName: 'Lead Engineer',
    message: `/vote ${targetPropId} DISSENT \u200B\u200C\u200D\uFEFF\u2060   \u00A0`
  });
  console.log('  Zero-Width Vote Reply:', zeroWidthVote?.content);
  if (!zeroWidthVote || !zeroWidthVote.content.includes('GAP-08 Invariant')) {
    throw new Error(`Zero-width dissent bypass was not blocked: ${zeroWidthVote?.content}`);
  }
  console.log('  ✓ Zero-width Unicode bypass correctly detected and rejected.');

  // ── TEST 9: SUBSTANTIVE RATIONALE LENGTH CHECK (< 10 CHARS) ───────────────────
  console.log('\n[Test 9] Testing Substantive Rationale Minimum Length Enforcement...');
  const shortVote = await waBridge.handleMessage({
    key: {
      remoteJid: '15559999@s.whatsapp.net',
      fromMe: false,
      id: 'wa_msg_09'
    },
    message: {
      conversation: `/vote ${targetPropId} DISSENT bad idea`
    },
    messageTimestamp: Math.floor(Date.now() / 1000)
  });
  console.log('  Short Rationale Reply:', shortVote?.content);
  if (!shortVote || !shortVote.content.includes('minimum 10 characters')) {
    throw new Error(`Short rationale was not rejected: ${shortVote?.content}`);
  }
  console.log('  ✓ Low-effort rationale rejected under GAP-08 substantive quality gate.');

  console.log('\n================================================================');
  console.log('   ALL PHASE 3 PLATFORM BRIDGE ADAPTER TESTS PASSED (100%)      ');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('\n[FATAL ERROR]', err);
  process.exit(1);
});
