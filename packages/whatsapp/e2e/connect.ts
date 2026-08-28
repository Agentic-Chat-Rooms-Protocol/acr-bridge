/**
 * connect.ts -- Standalone WhatsApp connection helper.
 *
 * Usage:
 *   npx tsx connect.ts                          # QR-code flow
 *   npx tsx connect.ts --pairing-code +1234567890  # pairing-code flow
 *
 * On success the session is persisted to ./auth-state/ so subsequent
 * runs (and e2e-test.ts) can reconnect without scanning again.
 */

import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as qrcode from "qrcode-terminal";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  CLI args                                                          */
/* ------------------------------------------------------------------ */

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR ?? "./auth-state";

function parsePairingPhone(): string | undefined {
  const idx = process.argv.indexOf("--pairing-code");
  if (idx === -1) return undefined;
  const phone = process.argv[idx + 1];
  if (!phone || phone.startsWith("-")) {
    console.error("ERROR: --pairing-code requires a phone number argument (e.g. +1234567890)");
    process.exit(1);
  }
  // Strip leading + and any spaces/dashes
  return phone.replace(/[^0-9]/g, "");
}

const pairingPhone = parsePairingPhone();
const usePairingCode = pairingPhone !== undefined;

/* ------------------------------------------------------------------ */
/*  Connection loop                                                   */
/* ------------------------------------------------------------------ */

async function connect(): Promise<void> {
  const authDir = path.resolve(AUTH_DIR);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  console.log(`[WA_CONNECT] Auth directory : ${authDir}`);
  console.log(`[WA_CONNECT] Mode           : ${usePairingCode ? "pairing-code" : "qr-code"}`);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we handle QR ourselves for nicer output
  });

  /* -- Pairing code request (before connection opens) ------------- */
  if (usePairingCode && !sock.authState.creds.registered) {
    console.log(`[WA_CONNECT] Requesting pairing code for ${pairingPhone} ...`);
    const code = await sock.requestPairingCode(pairingPhone!);
    console.log(`\n  *** PAIRING CODE: ${code} ***\n`);
    console.log("Enter this code on your phone: WhatsApp > Linked Devices > Link a Device > Link with phone number\n");
  }

  /* -- Connection state ------------------------------------------- */
  sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      console.log("\n[WA_CONNECT] Scan this QR code with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
      console.log("");
    }

    if (connection === "open") {
      const me = sock.user;
      console.log(`[WA_CONNECT] Connected as ${me?.id ?? "unknown"} (${me?.name ?? "no-name"})`);
      console.log("[WA_CONNECT] Session saved. Press Ctrl+C to exit.\n");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const reason = DisconnectReason[statusCode as number] ?? `unknown (${statusCode})`;
      console.log(`[WA_CONNECT] Disconnected: ${reason}`);

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("[WA_CONNECT] Reconnecting ...\n");
        connect();
      } else {
        console.log("[WA_CONNECT] Logged out. Delete auth-state/ and re-run to pair again.");
        process.exit(0);
      }
    }
  });

  /* -- Persist credentials on every update ------------------------ */
  sock.ev.on("creds.update", saveCreds);

  /* -- Log incoming messages (useful for verifying the link) ------ */
  sock.ev.on("messages.upsert", (event: { messages: any[]; type: string }) => {
    for (const msg of event.messages) {
      const from = msg.key.remoteJid ?? "?";
      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        "(non-text)";
      console.log(`[WA_CONNECT] Message from ${from}: ${text}`);
    }
  });
}

/* -- Entry -------------------------------------------------------- */
connect().catch((err) => {
  console.error("[WA_CONNECT] Fatal error:", err);
  process.exit(1);
});

// Keep the process alive
process.on("SIGINT", () => {
  console.log("\n[WA_CONNECT] Shutting down.");
  process.exit(0);
});
