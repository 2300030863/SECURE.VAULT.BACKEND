/**
 * DocQevrilo – E2EE Cryptography Verification Suite
 * Verifies Argon2id + AES-256-GCM + unique 96-bit nonces + AAD + SHA-256
 */
const assert = require("assert");
const path = require("path");
const { webcrypto, randomBytes } = require("crypto");
const { argon2id, createSHA256 } = require(path.join(__dirname, "../frontend/node_modules/hash-wasm"));

async function runCryptoTests() {
  console.log("\n=====================================================");
  console.log(" DocQevrilo E2EE Cryptography Test Suite");
  console.log("=====================================================\n");

  const secret = "K9M2P-7Q4W8-X3N6V-R5T9Y-B2C4D-F8G7H";
  const wrongSecret = "WRONG-SECRET-CODE-12345-67890-ABCDE";
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const transferId = "DQV-TEST-1234-5678";
  const fileId = "f_0_65536";

  // 1. Derive AES-256-GCM keys via Argon2id
  const kdfOpts = { parallelism: 1, iterations: 3, memorySize: 32768, hashLength: 32, outputType: "binary" };
  const senderRawKey = await argon2id({ password: secret, salt, ...kdfOpts });
  const receiverRawKey = await argon2id({ password: secret, salt, ...kdfOpts });
  const wrongRawKey = await argon2id({ password: wrongSecret, salt, ...kdfOpts });

  assert.strictEqual(Buffer.from(senderRawKey).toString("hex"), Buffer.from(receiverRawKey).toString("hex"));
  assert.notStrictEqual(Buffer.from(senderRawKey).toString("hex"), Buffer.from(wrongRawKey).toString("hex"));
  console.log("  ✅ [PASS] Argon2id derives identical 256-bit key for sender & receiver, distinct for wrong secret");

  const senderKey = await webcrypto.subtle.importKey("raw", senderRawKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const receiverKey = await webcrypto.subtle.importKey("raw", receiverRawKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const wrongKey = await webcrypto.subtle.importKey("raw", wrongRawKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);

  // 2. Encrypt & decrypt 3 chunks (70 KB total) with unique nonces + AAD + streaming SHA-256
  const originalData = new Uint8Array(randomBytes(70 * 1024));
  const chunkSize = 24 * 1024;
  const senderHash = await createSHA256();
  senderHash.init();
  const receiverHash = await createSHA256();
  receiverHash.init();

  const encryptedFrames = [];
  const usedNonces = new Set();

  for (let i = 0, off = 0; off < originalData.length; i++, off += chunkSize) {
    const slice = originalData.subarray(off, Math.min(off + chunkSize, originalData.length));
    senderHash.update(slice);
    const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const nonceHex = Buffer.from(nonce).toString("hex");
    assert.strictEqual(usedNonces.has(nonceHex), false, "Nonce must never be reused");
    usedNonces.add(nonceHex);

    const aad = new TextEncoder().encode(`${transferId}|${fileId}|${i}|${slice.byteLength}`);
    const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, senderKey, slice);
    encryptedFrames.push({ index: i, plainLen: slice.byteLength, nonce, ct: new Uint8Array(ct) });
  }

  const decryptedParts = [];
  for (const frame of encryptedFrames) {
    const aad = new TextEncoder().encode(`${transferId}|${fileId}|${frame.index}|${frame.plainLen}`);
    const pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: frame.nonce, additionalData: aad }, receiverKey, frame.ct);
    const ptBytes = new Uint8Array(pt);
    receiverHash.update(ptBytes);
    decryptedParts.push(ptBytes);
  }

  assert.strictEqual(senderHash.digest("hex"), receiverHash.digest("hex"));
  console.log("  ✅ [PASS] Multi-chunk AES-256-GCM encryption/decryption + streaming SHA-256 parity verified");

  // 3. Reject wrong secret
  let wrongFailed = false;
  try {
    const f0 = encryptedFrames[0];
    const aad = new TextEncoder().encode(`${transferId}|${fileId}|0|${f0.plainLen}`);
    await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: f0.nonce, additionalData: aad }, wrongKey, f0.ct);
  } catch (_) {
    wrongFailed = true;
  }
  assert.strictEqual(wrongFailed, true);
  console.log("  ✅ [PASS] Wrong unlock secret rejected by AES-256-GCM authentication tag");

  // 4. Reject reordered chunk (AAD index mismatch)
  let reorderFailed = false;
  try {
    const f0 = encryptedFrames[0];
    const wrongIndexAad = new TextEncoder().encode(`${transferId}|${fileId}|1|${f0.plainLen}`);
    await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: f0.nonce, additionalData: wrongIndexAad }, receiverKey, f0.ct);
  } catch (_) {
    reorderFailed = true;
  }
  assert.strictEqual(reorderFailed, true);
  console.log("  ✅ [PASS] Reordered/tampered chunk rejected via AAD verification");

  console.log("\n=====================================================");
  console.log(" ALL 4 E2EE CRYPTOGRAPHY TESTS PASSED!");
  console.log("=====================================================\n");
}

runCryptoTests().catch((err) => {
  console.error("❌ Crypto test failed:", err);
  process.exit(1);
});
