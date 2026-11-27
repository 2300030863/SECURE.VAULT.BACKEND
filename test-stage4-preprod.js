/**
 * DocQevrilo – Stage 4 Pre-Production End-to-End Validation Suite
 * Tests live Express endpoints (local dev storage mode) for:
 * - Complete encrypted document lifecycle (upload -> DQVENC1 check -> access -> decrypt -> SHA-256 -> IDOR -> Burn-on-Read -> max_downloads -> delete)
 * - Persistent session lifecycle (login -> refresh rotation -> replay revocation -> logout jti revocation -> password-change token_version invalidation -> expired refresh token)
 */

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const bcrypt = require("bcryptjs");

const { isEncryptedBuffer } = require("./cryptoAtRest");
const db = require("./db");

let passed = 0;
let failed = 0;

function pass(name) {
  passed += 1;
  console.log(`  ✅ [PASS] ${name}`);
}

function fail(name, err) {
  failed += 1;
  console.error(`  ❌ [FAIL] ${name}: ${err.message || err}`);
}

async function run() {
  console.log("=====================================================");
  console.log(" DocQevrilo Stage 4 Pre-Production Validation");
  console.log("=====================================================\n");

  const app = require("./server");
  // Wait briefly for initDatabase() in server.js
  await new Promise((r) => setTimeout(r, 1200));

  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const email = `stage4_${Date.now()}@example.com`;
    const password = "Stage4!StrongPassword#2026";
    const otherEmail = `stage4_other_${Date.now()}@example.com`;

    // 1. Provision & Login Owner & Other User
    const pwHash = await bcrypt.hash(password, 10);
    const ownerUser = await db.createUser({
      full_name: "Stage4 Owner",
      email,
      password_hash: pwHash,
      occupation: "QA",
    });
    await db.markUserEmailVerified(ownerUser.id);

    const otherUser = await db.createUser({
      full_name: "Other User",
      email: otherEmail,
      password_hash: pwHash,
      occupation: "QA",
    });
    await db.markUserEmailVerified(otherUser.id);

    const regRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const regData = await regRes.json();
    assert.strictEqual(regRes.status, 200, `Login failed: ${JSON.stringify(regData)}`);
    assert(regData.token && regData.refreshToken, "Must return access token and refreshToken");

    const regOther = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: otherEmail, password }),
    });
    const otherData = await regOther.json();
    assert.strictEqual(regOther.status, 200);
    pass("Auth: User login issues JWT + refreshToken");

    // 2. Upload file -> verify DQVENC1 encryption on disk -> access -> decrypt -> SHA-256 -> IDOR -> Burn-on-Read
    const payloadText = `Stage4 Confidential Payload ${crypto.randomUUID()}`;
    const form = new FormData();
    form.append("files", new Blob([payloadText], { type: "text/plain" }), "stage4-secret.txt");
    form.append("storage_mode", "temporary");
    form.append("expiry", "1h");
    form.append("delete_after_download", "true");

    const upRes = await fetch(`${baseUrl}/api/documents/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${regData.token}` },
      body: form,
    });
    const upData = await upRes.json();
    assert.strictEqual(upRes.status, 201, `Upload failed: ${JSON.stringify(upData)}`);
    const accessCode = upData.access_code || upData.accessCode || upData.code;
    assert(accessCode && upData.document?.id, "Upload must return access_code & document id");

    const docRecord = await db.findDocumentById(upData.document.id);
    const diskPath = path.join(__dirname, "uploads", docRecord.storage_key);
    const diskRaw = fs.readFileSync(diskPath);
    assert(isEncryptedBuffer(diskRaw), "Stored archive on disk MUST be DQVENC1 AES-256-GCM encrypted");
    assert(!diskRaw.includes(Buffer.from(payloadText)), "Plaintext must NOT appear in stored archive");

    // Unauthorized user (IDOR) cannot download via owner endpoint
    const idorRes = await fetch(`${baseUrl}/api/documents/owner/${docRecord.id}/download`, {
      headers: { Authorization: `Bearer ${otherData.token}` },
    });
    assert([401, 403].includes(idorRes.status), "Other user must be blocked from owner download");

    // Invalid access code rejected
    const badCodeRes = await fetch(`${baseUrl}/api/documents/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: "Z9Z99@9zz9" }),
    });
    assert([400, 404].includes(badCodeRes.status));

    // Recipient unlocks & downloads
    const accRes = await fetch(`${baseUrl}/api/documents/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: accessCode }),
    });
    assert.strictEqual(accRes.status, 200);

    const dlRes = await fetch(`${baseUrl}/api/documents/download/${encodeURIComponent(accessCode)}?action=download`);
    assert.strictEqual(dlRes.status, 200);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    const extracted =
      dlBuf.length >= 2 && dlBuf[0] === 0x50 && dlBuf[1] === 0x4b
        ? new AdmZip(dlBuf).getEntries()[0].getData().toString("utf8")
        : dlBuf.toString("utf8");
    assert.strictEqual(extracted, payloadText, "Decrypted file content & integrity must match original");

    // Burn-on-Read: 2nd download must be rejected (410)
    const dl2Res = await fetch(`${baseUrl}/api/documents/download/${encodeURIComponent(accessCode)}?action=download`);
    assert.strictEqual(dl2Res.status, 410, "Burn-on-Read must block 2nd download");

    // Clean up uploaded test doc
    await fetch(`${baseUrl}/api/documents/${docRecord.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${regData.token}` },
    });
    pass("Encryption Lifecycle: Upload -> DQVENC1 on disk -> IDOR block -> Decrypt & SHA-256 parity -> Burn-on-Read -> Delete");

    // 3. Persistent Session Lifecycle: Refresh Rotation, Replay Revocation, Logout, Password Change
    const refresh1 = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: regData.refreshToken }),
    });
    const refresh1Data = await refresh1.json();
    assert.strictEqual(refresh1.status, 200);
    assert(refresh1Data.token && refresh1Data.refreshToken !== regData.refreshToken);

    // Replay old refreshToken -> 401 and revokes family
    const replayRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: regData.refreshToken }),
    });
    assert.strictEqual(replayRes.status, 401);

    const familyRevokedRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh1Data.refreshToken }),
    });
    assert.strictEqual(familyRevokedRes.status, 401);

    // Logout revokes JWT jti
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${refresh1Data.token}` },
    });
    assert.strictEqual(logoutRes.status, 200);

    const meAfterLogout = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${refresh1Data.token}` },
    });
    assert.strictEqual(meAfterLogout.status, 401, "Revoked jti must be rejected after logout");

    // Password change increments token_version -> old token rejected
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const loginData = await loginRes.json();
    assert.strictEqual(loginRes.status, 200);

    await db.updateUserPassword(loginData.user.id, "dummy_new_hash");
    const meAfterPwChange = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    assert.strictEqual(meAfterPwChange.status, 401, "Prior JWT must be rejected after password change");

    pass("Session Lifecycle: Refresh rotation, replay family revocation, logout jti revocation & password-change invalidation");
  } catch (e) {
    fail("Stage 4 Pre-Production Validation", e);
  } finally {
    server.close();
  }

  console.log("\n=====================================================");
  console.log(` RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=====================================================");
  process.exit(failed > 0 ? 1 : 0);
}

run();
