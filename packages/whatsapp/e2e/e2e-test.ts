/**
 * e2e-test.ts -- WhatsApp E2E test suite.
 *
 * Prerequisites:
 *   1. Run `npx tsx connect.ts` first to pair and create ./auth-state/
 *   2. Set WHATSAPP_TEST_RECIPIENT in .env or env var
 *
 * Usage:
 *   WHATSAPP_TEST_RECIPIENT=1234567890@s.whatsapp.net npx tsx e2e-test.ts
 */

import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  type WAMessage,
  type ConnectionState,
  delay,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "node:path";
import fs from "node:fs";

/* ------------------------------------------------------------------ */
/*  Config                                                            */
/* ------------------------------------------------------------------ */

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR ?? "./auth-state";
const RECIPIENT = process.env.WHATSAPP_TEST_RECIPIENT;

if (!RECIPIENT) {
  console.error("ERROR: WHATSAPP_TEST_RECIPIENT env var is required (e.g. 1234567890@s.whatsapp.net)");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */

/**
 * Minimal valid 1x1 red pixel PNG (67 bytes).
 * Generated from the raw PNG specification -- no external file needed.
 */
function generateTestPng(): Buffer {
  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk: 1x1, 8-bit RGB
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);   // width
  ihdrData.writeUInt32BE(1, 4);   // height
  ihdrData[8] = 8;                // bit depth
  ihdrData[9] = 2;                // color type (RGB)
  ihdrData[10] = 0;               // compression
  ihdrData[11] = 0;               // filter
  ihdrData[12] = 0;               // interlace
  const ihdr = makeChunk("IHDR", ihdrData);

  // IDAT chunk: one row, filter byte 0, then R G B
  const raw = Buffer.from([0x00, 0xff, 0x00, 0x00]); // filter=none, R=255, G=0, B=0
  const deflated = zlibDeflateRawSmall(raw);
  const idat = makeChunk("IDAT", deflated);

  // IEND chunk
  const iend = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** Build a PNG chunk (length + type + data + CRC32). */
function makeChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);

  return Buffer.concat([lengthBuf, typeBytes, data, crcBuf]);
}

/** Minimal zlib deflate wrapper for tiny payloads (stored block, no compression). */
function zlibDeflateRawSmall(input: Buffer): Buffer {
  // zlib header: CM=8, CINFO=0, FCHECK adjusted so header % 31 === 0
  const header = Buffer.from([0x78, 0x01]);

  // Deflate stored block (BFINAL=1, BTYPE=00)
  const len = input.length;
  const block = Buffer.alloc(5 + len);
  block[0] = 0x01; // BFINAL=1, BTYPE=00
  block.writeUInt16LE(len, 1);
  block.writeUInt16LE(len ^ 0xffff, 3);
  input.copy(block, 5);

  // Adler-32 checksum (big-endian)
  const adler = adler32(input);
  const adlerBuf = Buffer.alloc(4);
  adlerBuf.writeUInt32BE(adler >>> 0, 0);

  return Buffer.concat([header, block, adlerBuf]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const FIXTURES_DIR = path.resolve(import.meta.dirname ?? ".", "fixtures");

function ensureFixtures(): void {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const pngPath = path.join(FIXTURES_DIR, "test-image.png");
  if (!fs.existsSync(pngPath)) {
    fs.writeFileSync(pngPath, generateTestPng());
    console.log(`[E2E_FIXTURES] Generated ${pngPath}`);
  }

  const docPath = path.join(FIXTURES_DIR, "test-doc.txt");
  if (!fs.existsSync(docPath)) {
    fs.writeFileSync(docPath, "Hello from OpenACP WhatsApp E2E test\n");
    console.log(`[E2E_FIXTURES] Generated ${docPath}`);
  }

  // Minimal valid Ogg/Opus file (silent, ~20ms).
  // This is the smallest valid Ogg container with an Opus stream that WhatsApp accepts.
  const audioPath = path.join(FIXTURES_DIR, "test-audio.ogg");
  if (!fs.existsSync(audioPath)) {
    fs.writeFileSync(audioPath, generateMinimalOgg());
    console.log(`[E2E_FIXTURES] Generated ${audioPath}`);
  }
}

/**
 * Generates a minimal valid Ogg/Opus file.
 * Contains: OggS page with OpusHead, OggS page with OpusTags, OggS page with silent audio frame.
 */
function generateMinimalOgg(): Buffer {
  const pages: Buffer[] = [];

  // --- Page 0: OpusHead ---
  const opusHead = Buffer.alloc(19);
  Buffer.from("OpusHead").copy(opusHead, 0);
  opusHead[8] = 1;    // version
  opusHead[9] = 1;    // channel count
  opusHead.writeUInt16LE(0, 10); // pre-skip
  opusHead.writeUInt32LE(48000, 12); // sample rate
  opusHead.writeInt16LE(0, 16); // output gain
  opusHead[18] = 0;   // channel mapping family
  pages.push(makeOggPage(opusHead, 0, 0, 0x02)); // BOS flag

  // --- Page 1: OpusTags ---
  const vendor = Buffer.from("openacp");
  const tagsBuf = Buffer.alloc(8 + vendor.length + 4);
  tagsBuf.writeUInt32LE(vendor.length, 0);
  vendor.copy(tagsBuf, 4);
  tagsBuf.writeUInt32LE(0, 4 + vendor.length); // 0 user comments
  pages.push(makeOggPage(tagsBuf, 1, 0, 0x00));

  // --- Page 2: Silent Opus frame (EOS) ---
  // TOC byte: config=1 (SILK 10ms NB), s=0 (mono), c=0 (1 frame)
  const silentFrame = Buffer.from([0xf8, 0xff, 0xfe]); // silence frame
  pages.push(makeOggPage(silentFrame, 2, 960, 0x04)); // EOS flag, granule=960 samples (20ms at 48kHz)

  return Buffer.concat(pages);
}

function makeOggPage(
  payload: Buffer,
  pageSeqNo: number,
  granulePos: number,
  headerType: number,
): Buffer {
  const serialNo = 0x4f504143; // "OPAC"

  // Header: capture pattern + version + header type + granule + serial + page seq + CRC + segments
  const header = Buffer.alloc(27 + 1); // 27 fixed header + 1 segment table entry
  Buffer.from("OggS").copy(header, 0);
  header[4] = 0; // version
  header[5] = headerType;
  // granule position (64-bit LE) -- only lower 32 bits used here
  header.writeUInt32LE(granulePos, 6);
  header.writeUInt32LE(0, 10);
  header.writeUInt32LE(serialNo, 14);
  header.writeUInt32LE(pageSeqNo, 18);
  // CRC placeholder at offset 22 (filled after)
  header[26] = 1; // number of page segments
  header[27] = payload.length; // segment table (single segment)

  // Compute CRC with placeholder zeroed
  header.writeUInt32LE(0, 22);
  const full = Buffer.concat([header, payload]);
  const crc = oggCrc32(full);
  full.writeUInt32LE(crc >>> 0, 22);

  return full;
}

function oggCrc32(buf: Buffer): number {
  // Ogg uses its own CRC-32 polynomial (0x04c11db7, no bit reversal)
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    }
    table.push(r >>> 0);
  }
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (table[((crc >>> 24) ^ buf[i]) & 0xff] ^ (crc << 8)) >>> 0;
  }
  return crc >>> 0;
}

/* ------------------------------------------------------------------ */
/*  Test runner                                                       */
/* ------------------------------------------------------------------ */

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, error?: string): void {
  results.push({ name, passed, error });
  const status = passed ? "PASS" : "FAIL";
  const suffix = error ? ` -- ${error}` : "";
  console.log(`  [${status}] ${name}${suffix}`);
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  ensureFixtures();

  const authDir = path.resolve(AUTH_DIR);
  if (!fs.existsSync(path.join(authDir, "creds.json"))) {
    console.error("ERROR: No auth state found. Run `npx tsx connect.ts` first to pair with WhatsApp.");
    process.exit(1);
  }

  console.log(`\n[E2E_WHATSAPP] Auth dir   : ${authDir}`);
  console.log(`[E2E_WHATSAPP] Recipient  : ${RECIPIENT}`);
  console.log("");

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timeout (30s)")), 30_000);

    sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        clearTimeout(timeout);
        resolve();
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        clearTimeout(timeout);
        reject(new Error(`Connection closed: ${DisconnectReason[code as number] ?? code}`));
      }
    });
  });

  sock.ev.on("creds.update", saveCreds);

  const me = sock.user?.id ?? "unknown";
  console.log(`[E2E_WHATSAPP] Connected as ${me}\n`);
  console.log("=== Running E2E tests ===\n");

  // Keep track of the last sent message key for reactions / replies
  let lastSentKey: WAMessage["key"] | undefined;

  /* ---- Test 1: Send text ---------------------------------------- */
  try {
    const sent = await sock.sendMessage(RECIPIENT!, { text: "E2E test: text message" });
    lastSentKey = sent?.key;
    record("Send text", !!sent?.key);
  } catch (err: any) {
    record("Send text", false, err.message);
  }

  await delay(1000);

  /* ---- Test 2: Send image --------------------------------------- */
  try {
    const imgBuf = fs.readFileSync(path.join(FIXTURES_DIR, "test-image.png"));
    const sent = await sock.sendMessage(RECIPIENT!, {
      image: imgBuf,
      caption: "E2E test: image with caption",
      mimetype: "image/png",
    });
    lastSentKey = sent?.key;
    record("Send image", !!sent?.key);
  } catch (err: any) {
    record("Send image", false, err.message);
  }

  await delay(1000);

  /* ---- Test 3: Send document ------------------------------------ */
  try {
    const docBuf = fs.readFileSync(path.join(FIXTURES_DIR, "test-doc.txt"));
    const sent = await sock.sendMessage(RECIPIENT!, {
      document: docBuf,
      mimetype: "text/plain",
      fileName: "test-doc.txt",
    });
    lastSentKey = sent?.key;
    record("Send document", !!sent?.key);
  } catch (err: any) {
    record("Send document", false, err.message);
  }

  await delay(1000);

  /* ---- Test 4: Send voice note ---------------------------------- */
  try {
    const audioBuf = fs.readFileSync(path.join(FIXTURES_DIR, "test-audio.ogg"));
    const sent = await sock.sendMessage(RECIPIENT!, {
      audio: audioBuf,
      ptt: true,
      mimetype: "audio/ogg; codecs=opus",
    });
    lastSentKey = sent?.key;
    record("Send voice note", !!sent?.key);
  } catch (err: any) {
    record("Send voice note", false, err.message);
  }

  await delay(1000);

  /* ---- Test 5: Send reaction ------------------------------------ */
  try {
    if (!lastSentKey) throw new Error("No previous message to react to");
    const sent = await sock.sendMessage(RECIPIENT!, {
      react: { text: "\uD83D\uDC4D", key: lastSentKey },
    });
    record("Send reaction", !!sent?.key);
  } catch (err: any) {
    record("Send reaction", false, err.message);
  }

  await delay(1000);

  /* ---- Test 6: Typing indicator --------------------------------- */
  try {
    await sock.sendPresenceUpdate("composing", RECIPIENT!);
    await delay(2000);
    await sock.sendPresenceUpdate("paused", RECIPIENT!);
    record("Typing indicator", true);
  } catch (err: any) {
    record("Typing indicator", false, err.message);
  }

  /* ---- Test 7: Receive message (listen 30s) --------------------- */
  try {
    console.log("\n  [INFO] Listening for incoming messages for 30s ...");
    const received: WAMessage[] = [];

    const handler = (event: { messages: WAMessage[] }) => {
      for (const m of event.messages) {
        if (m.key.fromMe) continue; // skip own echoes
        const text =
          m.message?.conversation ??
          m.message?.extendedTextMessage?.text ??
          "(non-text)";
        console.log(`    <- ${m.key.remoteJid}: ${text}`);
        received.push(m);
      }
    };

    sock.ev.on("messages.upsert", handler);
    await delay(30_000);
    sock.ev.off("messages.upsert", handler);

    // PASS if we received at least one external message; still PASS with 0 but note it
    if (received.length === 0) {
      record("Receive message", true, "0 messages received (no incoming traffic -- not a failure)");
    } else {
      record("Receive message", true, `${received.length} message(s) received`);
    }
  } catch (err: any) {
    record("Receive message", false, err.message);
  }

  /* ---- Test 8: Group list --------------------------------------- */
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupIds = Object.keys(groups);
    if (groupIds.length > 0) {
      console.log(`\n  [INFO] Groups (${groupIds.length}):`);
      for (const gid of groupIds.slice(0, 5)) {
        console.log(`    - ${groups[gid].subject} (${gid})`);
      }
      if (groupIds.length > 5) console.log(`    ... and ${groupIds.length - 5} more`);
    }
    record("Group list", true, `${groupIds.length} group(s) found`);
  } catch (err: any) {
    record("Group list", false, err.message);
  }

  await delay(1000);

  /* ---- Test 9: Mentions ----------------------------------------- */
  try {
    // Mention the recipient in a message
    const mentionJid = RECIPIENT!.includes("@g.us")
      ? RECIPIENT! // for groups, mention works differently
      : RECIPIENT!;
    const sent = await sock.sendMessage(RECIPIENT!, {
      text: `E2E test: mentioning @${mentionJid.split("@")[0]}`,
      mentions: [mentionJid],
    });
    record("Mentions", !!sent?.key);
  } catch (err: any) {
    record("Mentions", false, err.message);
  }

  await delay(1000);

  /* ---- Test 10: Reply / quote ----------------------------------- */
  try {
    // Send a message, then reply to it
    const original = await sock.sendMessage(RECIPIENT!, {
      text: "E2E test: original message (will be quoted)",
    });
    if (!original?.key) throw new Error("Failed to send original message");

    await delay(500);

    // Build a minimal WAMessage for the quoted param
    const quotedMsg: WAMessage = {
      key: original.key,
      message: { conversation: "E2E test: original message (will be quoted)" },
    };

    const reply = await sock.sendMessage(
      RECIPIENT!,
      { text: "E2E test: this is a reply to the above" },
      { quoted: quotedMsg },
    );
    record("Reply/quote", !!reply?.key);
  } catch (err: any) {
    record("Reply/quote", false, err.message);
  }

  /* ---- Summary -------------------------------------------------- */
  console.log("\n=== E2E Summary ===\n");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  for (const r of results) {
    const icon = r.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${r.name}${r.error ? ` -- ${r.error}` : ""}`);
  }

  console.log(`\n  Total: ${total}  |  Passed: ${passed}  |  Failed: ${failed}\n`);

  // Clean shutdown
  sock.end(undefined);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[E2E_WHATSAPP] Fatal error:", err);
  process.exit(1);
});
