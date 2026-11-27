/**
 * DocQevrilo – Safe At-Rest Encryption Migration Script (Local Disk + Backblaze B2)
 *
 * Usage:
 *   node migrate-encrypt-at-rest.js --dry-run   (Inspects plaintext vs DQVENC1 files without modifying)
 *   node migrate-encrypt-at-rest.js --apply     (Backs up, encrypts with AES-256-GCM, verifies round-trip)
 *   node migrate-encrypt-at-rest.js --rollback  (Restores from .pre-enc.bak backups if needed)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { encryptBuffer, decryptBuffer, isEncryptedBuffer } = require("./cryptoAtRest");

const UPLOADS_DIR = path.join(__dirname, "uploads");
const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--rollback")
  ? "rollback"
  : "dry-run";

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (!entry.name.endsWith(".pre-enc.bak")) {
      results.push(full);
    }
  }
  return results;
}

function run() {
  const files = walkFiles(UPLOADS_DIR);
  console.log(`[At-Rest Migration] Mode=${mode} | Local files scanned=${files.length}`);

  let alreadyEncrypted = 0;
  let plaintextFound = 0;
  let migrated = 0;
  let rolledBack = 0;

  for (const filePath of files) {
    const relKey = path.relative(UPLOADS_DIR, filePath).replace(/\\/g, "/");
    const raw = fs.readFileSync(filePath);
    const encrypted = isEncryptedBuffer(raw);

    if (mode === "rollback") {
      const bakPath = `${filePath}.pre-enc.bak`;
      if (fs.existsSync(bakPath)) {
        fs.copyFileSync(bakPath, filePath);
        rolledBack += 1;
        console.log(`  [ROLLBACK] Restored ${relKey} from backup`);
      }
      continue;
    }

    if (encrypted) {
      alreadyEncrypted += 1;
      console.log(`  [OK] Already encrypted (DQVENC1): ${relKey} (${raw.length} bytes)`);
      continue;
    }

    plaintextFound += 1;
    if (mode === "dry-run") {
      console.log(`  [PLAINTEXT] Needs encryption: ${relKey} (${raw.length} bytes)`);
      continue;
    }

    // --apply: create backup, encrypt, verify round-trip SHA-256 parity
    const bakPath = `${filePath}.pre-enc.bak`;
    if (!fs.existsSync(bakPath)) {
      fs.copyFileSync(filePath, bakPath);
    }
    const origSha = crypto.createHash("sha256").update(raw).digest("hex");
    const encBuf = encryptBuffer(raw, relKey);
    const verifiedPlain = decryptBuffer(encBuf, relKey);
    const decSha = crypto.createHash("sha256").update(verifiedPlain).digest("hex");
    if (origSha !== decSha) {
      throw new Error(`Verification SHA-256 mismatch for ${relKey}`);
    }
    fs.writeFileSync(filePath, encBuf);
    migrated += 1;
    console.log(`  [MIGRATED] ${relKey}: ${raw.length}B -> ${encBuf.length}B (SHA-256 verified)`);
  }

  console.log(
    `[Summary] alreadyEncrypted=${alreadyEncrypted}, plaintextFound=${plaintextFound}, migrated=${migrated}, rolledBack=${rolledBack}`
  );
}

run();
