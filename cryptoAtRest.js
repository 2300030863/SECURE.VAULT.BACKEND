/**
 * DocQevrilo Layer 6 – Presentation Security (AES-256-GCM At-Rest Encryption)
 *
 * Encrypts confidential archives and secret text BEFORE writing to disk or Backblaze B2.
 * Envelope format ("DQVENC1"):
 *   [0..6]   : ASCII "DQVENC1" (7 bytes)
 *   [7]      : Key version (uint8, currently 1)
 *   [8..19]  : 96-bit unique random IV/nonce (12 bytes)
 *   [20..35] : 128-bit GCM authentication tag (16 bytes)
 *   [36..]   : AES-256-GCM ciphertext
 *
 * Legacy unencrypted objects (without "DQVENC1" magic) remain readable for 100%
 * backward compatibility with existing B2/disk records.
 */

const crypto = require("crypto");
const fs = require("fs");

const MAGIC = Buffer.from("DQVENC1", "ascii"); // 7 bytes
const HEADER_LEN = MAGIC.length + 1 + 12 + 16; // 36 bytes
const KEY_VERSION = 1;

let cachedKey = null;
let cachedPreviousKey = null;

function deriveKeyFromInput(raw) {
  const trimmed = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length === 32) {
    return b64;
  }
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(trimmed, "utf8"),
      Buffer.from("docqevrilo-at-rest-salt-v1", "utf8"),
      Buffer.from("aes-256-gcm-master", "utf8"),
      32
    )
  );
}

function getMasterKey() {
  if (cachedKey) return cachedKey;

  const envKey = process.env.ENCRYPTION_MASTER_KEY;
  if (envKey && envKey.trim()) {
    cachedKey = deriveKeyFromInput(envKey);
    return cachedKey;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[Layer 6 Fatal] ENCRYPTION_MASTER_KEY is mandatory in production and must not fall back to JWT_SECRET."
    );
  }

  // Non-production convenience fallback only
  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret && jwtSecret.length >= 32) {
    cachedKey = deriveKeyFromInput(jwtSecret);
    return cachedKey;
  }

  console.warn("[Layer 6 Security] ENCRYPTION_MASTER_KEY not set; using ephemeral dev key.");
  cachedKey = crypto.randomBytes(32);
  return cachedKey;
}

function getPreviousMasterKey() {
  if (cachedPreviousKey !== null) return cachedPreviousKey || null;
  const prev = process.env.ENCRYPTION_MASTER_KEY_PREVIOUS;
  if (prev && prev.trim()) {
    cachedPreviousKey = deriveKeyFromInput(prev);
    return cachedPreviousKey;
  }
  cachedPreviousKey = false;
  return null;
}

function isEncryptedBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= HEADER_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Encrypts a Buffer using AES-256-GCM with a fresh 96-bit random nonce and AAD.
 */
function encryptBuffer(plainBuffer, aadContext = "") {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aadContext) {
    cipher.setAAD(Buffer.from(String(aadContext), "utf8"));
  }
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.allocUnsafe(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(KEY_VERSION, MAGIC.length);
  iv.copy(header, MAGIC.length + 1);
  tag.copy(header, MAGIC.length + 1 + 12);
  return Buffer.concat([header, encrypted]);
}

/**
 * Decrypts a DQVENC1 Buffer. Throws if tampered or wrong AAD.
 * If buffer does not start with DQVENC1, returns it unchanged (legacy compatibility).
 */
function decryptBuffer(inputBuffer, aadContext = "") {
  if (!isEncryptedBuffer(inputBuffer)) {
    return inputBuffer;
  }
  const key = getMasterKey();
  const iv = inputBuffer.subarray(MAGIC.length + 1, MAGIC.length + 1 + 12);
  const tag = inputBuffer.subarray(MAGIC.length + 1 + 12, HEADER_LEN);
  const ciphertext = inputBuffer.subarray(HEADER_LEN);

  const tryDecryptWith = (k) => {
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
    if (aadContext) {
      decipher.setAAD(Buffer.from(String(aadContext), "utf8"));
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  };

  try {
    return tryDecryptWith(key);
  } catch (primaryErr) {
    const prevKey = getPreviousMasterKey();
    if (prevKey) {
      return tryDecryptWith(prevKey);
    }
    throw primaryErr;
  }
}

/**
 * Encrypts a file on disk to a target encrypted file path.
 */
function encryptFileSync(srcPath, destPath, aadContext = "") {
  const plain = fs.readFileSync(srcPath);
  const sha256 = crypto.createHash("sha256").update(plain).digest("hex");
  const enc = encryptBuffer(plain, aadContext);
  fs.writeFileSync(destPath, enc);
  return {
    encryptedSize: enc.length,
    plaintextSize: plain.length,
    plaintextSha256: sha256,
    algorithm: "AES-256-GCM",
    keyVersion: KEY_VERSION,
  };
}

/**
 * Reads and decrypts a file from disk (supports legacy unencrypted files transparently).
 */
function readDecryptedFileSync(filePath, aadContext = "") {
  const raw = fs.readFileSync(filePath);
  return decryptBuffer(raw, aadContext);
}

/**
 * Collects a Readable stream into a Buffer and decrypts if DQVENC1-encrypted.
 */
async function streamToDecryptedBuffer(stream, aadContext = "") {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const combined = Buffer.concat(chunks);
  return decryptBuffer(combined, aadContext);
}

function getEncryptionStatus() {
  return {
    atRestAlgorithm: "AES-256-GCM",
    envelopeFormat: "DQVENC1",
    keyVersion: KEY_VERSION,
    explicitMasterKeyConfigured: Boolean(process.env.ENCRYPTION_MASTER_KEY),
    nonceSizeBits: 96,
    authTagBits: 128,
    p2pE2eeAlgorithm: "Argon2id + AES-256-GCM + SHA-256",
  };
}

module.exports = {
  MAGIC,
  HEADER_LEN,
  isEncryptedBuffer,
  encryptBuffer,
  decryptBuffer,
  encryptFileSync,
  readDecryptedFileSync,
  streamToDecryptedBuffer,
  getEncryptionStatus,
};
