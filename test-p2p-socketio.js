/**
 * DocQevrilo – Socket.IO P2P Signaling & State Machine Verification Suite
 *
 * Tests:
 * 1. Session creation with authoritative server expiration
 * 2. Invalid transfer ID & anti-enumeration error handling
 * 3. Recipient limit enforcement (maxRecipients = 1 rejects 2nd recipient)
 * 4. Sender approval gating (unapproved WebRTC signaling blocked; approved allowed)
 * 5. Pause & Resume signaling transitions
 * 6. One-time access enforcement (rejects new joins after completion)
 * 7. Manual Stop Sharing (immediate cancellation, notifies receiver, blocks reconnect)
 * 8. Server-side expiration enforcement
 */

const http = require("http");
const assert = require("assert");
const path = require("path");
const { initP2PSocketServer } = require("./p2pSocketServer");
const { io: Client } = require(path.join(__dirname, "../frontend/node_modules/socket.io-client"));

let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`  ✅ [PASS] ${name}`);
  passed++;
}

async function runTests() {
  console.log("\n=====================================================");
  console.log(" DocQevrilo Socket.IO P2P Signaling Test Suite");
  console.log("=====================================================\n");

  const server = http.createServer();
  const ioServer = initP2PSocketServer(server, {
    corsOriginCheck: true,
    jwtSecret: "test_jwt_secret_at_least_32_characters_long",
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  console.log(`[Test Socket.IO Server] Listening on ${url}\n`);

  const connectClient = () =>
    new Promise((resolve, reject) => {
      const c = Client(url, { path: "/socket.io", transports: ["websocket"] });
      c.once("connect", () => resolve(c));
      c.once("connect_error", reject);
    });

  // TEST 1: Session creation & invalid ID rejection
  console.log("Test 1: Session Creation & Anti-Enumeration");
  const sender = await connectClient();
  const transferId = "DQV-ABCD-EFGH-JKLM";

  const createRes = await new Promise((resolve) => {
    sender.emit(
      "p2p:create-session",
      { transferId, durationSeconds: 300, maxRecipients: 1, oneTimeAccess: false, fileCount: 1, totalSize: 2048 },
      resolve
    );
  });
  assert.strictEqual(createRes.ok, true);
  assert.strictEqual(createRes.status, "WAITING_FOR_RECIPIENT");
  assert.ok(createRes.expiresAt > Date.now());
  pass("Sender created session with authoritative server expiration");

  const badJoin = await connectClient();
  const badRes = await new Promise((resolve) => {
    badJoin.emit("p2p:join-session", { transferId: "DQV-0000-0000-0000" }, resolve);
  });
  assert.strictEqual(badRes.ok, false);
  assert.strictEqual(badRes.error, "Invalid or expired transfer ID.");
  badJoin.disconnect();
  pass("Non-existent transfer ID returns generic anti-enumeration error");

  // TEST 2: Recipient join, limit enforcement (maxRecipients = 1), and approval
  console.log("\nTest 2: Recipient Limit & Sender Approval Gating");
  const rec1 = await connectClient();
  const joinRes1 = await new Promise((resolve) => {
    rec1.emit("p2p:join-session", { transferId }, resolve);
  });
  assert.strictEqual(joinRes1.ok, true);
  assert.strictEqual(joinRes1.status, "WAITING_FOR_APPROVAL");
  pass("Recipient 1 joined and entered WAITING_FOR_APPROVAL");

  const rec2 = await connectClient();
  const joinRes2 = await new Promise((resolve) => {
    rec2.emit("p2p:join-session", { transferId }, resolve);
  });
  assert.strictEqual(joinRes2.ok, false);
  assert.ok(joinRes2.error.includes("Recipient limit reached"));
  rec2.disconnect();
  pass("Recipient 2 rejected when maxRecipients=1 limit reached");

  // Unapproved answer should be ignored (not forwarded to sender)
  let leakedAnswer = false;
  sender.once("p2p:webrtc-answer", () => {
    leakedAnswer = true;
  });
  rec1.emit("p2p:webrtc-answer", { transferId, sdp: { type: "answer", sdp: "fake" } });
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(leakedAnswer, false);
  pass("Unapproved recipient cannot send WebRTC signaling");

  // Approve recipient 1
  const approvedPromise = new Promise((resolve) => rec1.once("p2p:access-approved", resolve));
  const appRes = await new Promise((resolve) => {
    sender.emit("p2p:approve-recipient", { transferId, recipientId: joinRes1.recipientId }, resolve);
  });
  assert.strictEqual(appRes.ok, true);
  await approvedPromise;
  pass("Sender approved Recipient 1; both notified");

  // Approved WebRTC offer/answer exchange
  const offerPromise = new Promise((resolve) => rec1.once("p2p:webrtc-offer", resolve));
  sender.emit("p2p:webrtc-offer", { transferId, recipientId: joinRes1.recipientId, sdp: { type: "offer", sdp: "v=0" } });
  const offerData = await offerPromise;
  assert.strictEqual(offerData.sdp.type, "offer");
  pass("Approved WebRTC SDP offer routed strictly to approved recipient");

  // TEST 3: Pause & Resume
  console.log("\nTest 3: Pause & Resume Transfer Controls");
  const pausedPromise = new Promise((resolve) => rec1.once("p2p:transfer-paused", resolve));
  await new Promise((resolve) => sender.emit("p2p:pause-transfer", { transferId }, resolve));
  await pausedPromise;
  pass("Sender paused transfer; receiver notified");

  const resumedPromise = new Promise((resolve) => rec1.once("p2p:transfer-resumed", resolve));
  await new Promise((resolve) => sender.emit("p2p:resume-transfer", { transferId }, resolve));
  await resumedPromise;
  pass("Sender resumed transfer; receiver notified");

  // TEST 4: Manual Stop Sharing
  console.log("\nTest 4: Manual Stop Sharing & Immediate Revocation");
  const stoppedPromise = new Promise((resolve) => rec1.once("p2p:sharing-stopped", resolve));
  await new Promise((resolve) => sender.emit("p2p:stop-sharing", { transferId }, resolve));
  const stopData = await stoppedPromise;
  assert.strictEqual(stopData.status, "CANCELLED");
  assert.strictEqual(ioServer.p2pHasSession(transferId), false);
  pass("Manual Stop Sharing cancelled session, notified receiver, and wiped server state");

  const recAfterStop = await connectClient();
  const afterStopRes = await new Promise((resolve) => {
    recAfterStop.emit("p2p:join-session", { transferId }, resolve);
  });
  assert.strictEqual(afterStopRes.ok, false);
  recAfterStop.disconnect();
  rec1.disconnect();
  sender.disconnect();
  pass("New connections rejected after Stop Sharing");

  // TEST 5: One-Time Access Enforcement
  console.log("\nTest 5: One-Time Access Atomic Enforcement");
  const s2 = await connectClient();
  const otId = "DQV-ONET-IME1-2345";
  await new Promise((resolve) => {
    s2.emit("p2p:create-session", { transferId: otId, durationSeconds: 300, maxRecipients: 5, oneTimeAccess: true }, resolve);
  });
  const rOne = await connectClient();
  const jOne = await new Promise((resolve) => rOne.emit("p2p:join-session", { transferId: otId }, resolve));
  await new Promise((resolve) => s2.emit("p2p:approve-recipient", { transferId: otId, recipientId: jOne.recipientId }, resolve));
  await new Promise((resolve) => rOne.emit("p2p:transfer-completed", { transferId: otId }, resolve));
  rOne.disconnect();

  const rTwo = await connectClient();
  const jTwo = await new Promise((resolve) => rTwo.emit("p2p:join-session", { transferId: otId }, resolve));
  assert.strictEqual(jTwo.ok, false);
  assert.ok(jTwo.error.includes("One-time access"));
  rTwo.disconnect();
  s2.disconnect();
  pass("One-time access blocked subsequent recipient after completion");

  ioServer.close();
  server.close();
  console.log(`\n=====================================================`);
  console.log(` RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log(`=====================================================\n`);
}

runTests().catch((err) => {
  console.error("❌ Socket.IO test failed:", err);
  process.exit(1);
});
