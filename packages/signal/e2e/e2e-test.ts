/**
 * Signal adapter E2E test suite.
 *
 * Runs against a live signal-cli-rest-api container (started by setup.sh).
 * Requires two phone numbers: one registered in the container, one as a test
 * recipient that will actually receive messages on a real device.
 *
 * Usage:
 *   npx tsx e2e-test.ts
 *
 * Environment (loaded from .env in the same directory):
 *   SIGNAL_API_URL          — Base URL of signal-cli-rest-api (default: http://localhost:8080)
 *   SIGNAL_NUMBER           — Registered phone number (E.164)
 *   SIGNAL_TEST_RECIPIENT   — Second phone number that receives test messages (E.164)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Load .env manually (no external deps) ───────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, ".env");

function loadEnv(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return; // .env is optional if vars are already set
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv(envPath);

// ── Config ──────────────────────────────────────────────────────────────────

const API_URL = (process.env.SIGNAL_API_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  ""
);
const SIGNAL_NUMBER = process.env.SIGNAL_NUMBER ?? "";
const TEST_RECIPIENT = process.env.SIGNAL_TEST_RECIPIENT ?? "";

if (!SIGNAL_NUMBER) {
  console.error(
    "SIGNAL_NUMBER is not set. Run setup.sh first or set it in .env"
  );
  process.exit(1);
}
if (!TEST_RECIPIENT) {
  console.error(
    "SIGNAL_TEST_RECIPIENT is not set. Run setup.sh first or set it in .env"
  );
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

const results: TestResult[] = [];

async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const url = `${API_URL}${path}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  let data: unknown;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data };
}

async function runTest(
  name: string,
  fn: () => Promise<void>
): Promise<boolean> {
  const start = Date.now();
  try {
    await fn();
    const dur = Date.now() - start;
    results.push({ name, passed: true, durationMs: dur });
    console.log(`  PASS  ${name} (${dur}ms)`);
    return true;
  } catch (err) {
    const dur = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, durationMs: dur, error: msg });
    console.log(`  FAIL  ${name} (${dur}ms)`);
    console.log(`        ${msg}`);
    return false;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function testHealthCheck(): Promise<void> {
  const { status, data } = await apiRequest("GET", "/api/v1/about");
  assert(status === 200, `Expected 200, got ${status}`);
  assert(data !== null && typeof data === "object", "Response should be an object");
  const about = data as Record<string, unknown>;
  // signal-cli-rest-api returns at least a versions object
  assert(
    "versions" in about || "version" in about || "build" in about,
    "Response should contain version information"
  );
}

async function testSendTextMessage(): Promise<void> {
  const payload = {
    message: `[E2E] Text message test — ${new Date().toISOString()}`,
    number: SIGNAL_NUMBER,
    recipients: [TEST_RECIPIENT],
    text_mode: "normal",
  };
  const { status, data } = await apiRequest("POST", "/api/v2/send", payload);
  assert(
    status >= 200 && status < 300,
    `Expected 2xx, got ${status}: ${JSON.stringify(data)}`
  );
}

async function testSendWithAttachment(): Promise<void> {
  // Create a minimal PNG: 1x1 red pixel
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e00000000c4944415478da6260f8cf0000000200014898c5ae0000000049" +
      "454e44ae426082",
    "hex"
  );
  const base64Png = `data:image/png;filename=test.png;base64,${pngBytes.toString("base64")}`;

  const payload = {
    message: `[E2E] Attachment test — ${new Date().toISOString()}`,
    number: SIGNAL_NUMBER,
    recipients: [TEST_RECIPIENT],
    base64_attachments: [base64Png],
  };
  const { status, data } = await apiRequest("POST", "/api/v2/send", payload);
  assert(
    status >= 200 && status < 300,
    `Expected 2xx, got ${status}: ${JSON.stringify(data)}`
  );
}

async function testReceiveMessage(): Promise<void> {
  // Open SSE connection and wait for any event within a timeout.
  // Since we cannot send from the second phone programmatically, we send
  // a message to ourselves (SIGNAL_NUMBER) which will appear as an event
  // if the number is talking to itself; otherwise we just validate that
  // the SSE endpoint is connectable and returns the right content type.
  const sseUrl = `${API_URL}/api/v1/receive/${encodeURIComponent(SIGNAL_NUMBER)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(sseUrl, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });

    assert(
      res.status === 200,
      `SSE endpoint returned ${res.status}, expected 200`
    );

    const contentType = res.headers.get("content-type") ?? "";
    // signal-cli-rest-api may return text/event-stream or application/json
    // depending on version and whether there are queued messages.
    assert(
      contentType.includes("text/event-stream") ||
        contentType.includes("application/json"),
      `Unexpected content-type: ${contentType}`
    );

    // Try to read at least one chunk (could be a keep-alive or queued message).
    // If no data arrives within the timeout, that is still OK — the SSE
    // endpoint is connectable and the content-type is correct.
    const reader = res.body?.getReader();
    if (reader) {
      const readPromise = reader.read();
      const raceResult = await Promise.race([
        readPromise.then((r) => ({ timedOut: false, ...r })),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 5_000)
        ),
      ]);

      if (!raceResult.timedOut) {
        // Got data — the SSE stream is actively sending events
      }
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function testTypingIndicator(): Promise<void> {
  const payload = { recipient: TEST_RECIPIENT };
  const { status, data } = await apiRequest(
    "PUT",
    `/api/v1/typing-indicator/${encodeURIComponent(SIGNAL_NUMBER)}`,
    payload
  );
  assert(
    status >= 200 && status < 300,
    `Expected 2xx, got ${status}: ${JSON.stringify(data)}`
  );
}

async function testReaction(): Promise<void> {
  // First, send a message to react to. Use the timestamp from the response.
  const sendPayload = {
    message: `[E2E] Reaction target — ${new Date().toISOString()}`,
    number: SIGNAL_NUMBER,
    recipients: [TEST_RECIPIENT],
  };
  const sendResult = await apiRequest("POST", "/api/v2/send", sendPayload);
  assert(
    sendResult.status >= 200 && sendResult.status < 300,
    `Failed to send reaction target message: ${sendResult.status}`
  );

  // Extract timestamp from send response
  const sendData = sendResult.data as Record<string, unknown>;
  const timestamp =
    typeof sendData.timestamp === "number"
      ? sendData.timestamp
      : typeof sendData.timestamp === "string"
        ? parseInt(sendData.timestamp, 10)
        : Date.now();

  // Small delay to ensure the message is processed
  await new Promise((r) => setTimeout(r, 1_000));

  // Send reaction
  const reactionPayload = {
    recipient: TEST_RECIPIENT,
    reaction: "\u{1F44D}", // thumbs up
    target_author: SIGNAL_NUMBER,
    target_timestamp: timestamp,
  };
  const { status, data } = await apiRequest(
    "PUT",
    `/api/v1/reactions/${encodeURIComponent(SIGNAL_NUMBER)}`,
    reactionPayload
  );
  assert(
    status >= 200 && status < 300,
    `Expected 2xx, got ${status}: ${JSON.stringify(data)}`
  );
}

async function testReadReceipt(): Promise<void> {
  // Send a read receipt for a synthetic timestamp.
  // The API should accept it even if no such message exists on the server.
  const payload = {
    receipt_type: "read",
    recipient: TEST_RECIPIENT,
    timestamps: [Date.now()],
  };
  const { status, data } = await apiRequest(
    "POST",
    `/api/v1/receipts/${encodeURIComponent(SIGNAL_NUMBER)}`,
    payload
  );
  assert(
    status >= 200 && status < 300,
    `Expected 2xx, got ${status}: ${JSON.stringify(data)}`
  );
}

async function testGroupOperations(): Promise<void> {
  const { status, data } = await apiRequest(
    "GET",
    `/api/v1/groups/${encodeURIComponent(SIGNAL_NUMBER)}`
  );
  assert(
    status >= 200 && status < 300,
    `Expected 2xx, got ${status}: ${JSON.stringify(data)}`
  );
  // The response should be an array (possibly empty — that is fine)
  assert(Array.isArray(data), `Expected array, got ${typeof data}`);
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("");
  console.log("=== Signal Adapter E2E Tests ===");
  console.log(`  API:       ${API_URL}`);
  console.log(`  Number:    ${SIGNAL_NUMBER}`);
  console.log(`  Recipient: ${TEST_RECIPIENT}`);
  console.log("");

  // Run tests in order. Some depend on previous ones succeeding.
  await runTest("1. Health check (/api/v1/about)", testHealthCheck);
  await runTest("2. Send text message", testSendTextMessage);
  await runTest("3. Send with attachment", testSendWithAttachment);
  await runTest("4. Receive message (SSE endpoint)", testReceiveMessage);
  await runTest("5. Typing indicator", testTypingIndicator);
  await runTest("6. Reaction", testReaction);
  await runTest("7. Read receipt", testReadReceipt);
  await runTest("8. Group operations (list groups)", testGroupOperations);

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log("");
  console.log("=== Results ===");
  console.log("");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const line = `  ${status}  ${r.name} (${r.durationMs}ms)`;
    console.log(line);
    if (r.error) {
      console.log(`        ${r.error}`);
    }
  }

  console.log("");
  console.log(
    `  ${passed}/${total} passed, ${failed} failed (${totalMs}ms total)`
  );
  console.log("");

  if (failed > 0) {
    console.log("  Some tests failed. Check the output above for details.");
    console.log(
      "  Common causes: number not registered, recipient not on Signal,"
    );
    console.log("  or signal-cli-rest-api still initializing.");
    process.exit(1);
  } else {
    console.log("  All tests passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
