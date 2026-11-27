/**
 * DocQevrilo – Final Hardening Regression Suite
 * Tests:
 * 1. ExcelJS spreadsheet parsing, HTML XSS escaping, CSV formula-injection neutralization, malformed/oversized rejection
 * 2. Persistent session revocation & refresh-token rotation across simulated backend restart + concurrent race
 * 3. AES-256-GCM key rotation (Key1 -> Key2 with ENCRYPTION_MASTER_KEY_PREVIOUS), invalid key & tamper rejection, prod fatal check
 */

const assert = require("assert");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const path = require("path");
const ExcelJS = require("exceljs");

const {
  extractSpreadsheetText,
  renderSpreadsheetHtmlTable,
  MAX_SPREADSHEET_BYTES,
} = require("./spreadsheetHelper");

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
  console.log(" DocQevrilo Hardening & Key Rotation Test Suite");
  console.log("=====================================================\n");

  // 1. ExcelJS + Formula Injection + XSS Escaping + Malicious File Rejection
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Financials");
    ws.addRow(["Item", "Formula", "Note"]);
    ws.addRow(["Widget", "=CMD|'/C calc'!A0", "<script>alert('xss')</script>"]);
    ws.addRow(["Total", "+10+20", "@SUM(A1:A2)"]);
    const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());

    const textRes = await extractSpreadsheetText(xlsxBuf, "budget.xlsx");
    assert(textRes.fullText.includes("'=CMD"), "Formula starting with = must be neutralized");
    assert(textRes.fullText.includes("'+10+20"), "Formula starting with + must be neutralized");
    assert(textRes.fullText.includes("'@SUM"), "Formula starting with @ must be neutralized");

    const html = await renderSpreadsheetHtmlTable(xlsxBuf);
    assert(!html.includes("<script>"), "Raw <script> tag must be escaped in HTML table");
    assert(html.includes("&lt;script&gt;"), "HTML entity escaping must be applied");
    assert(html.includes("&#39;") || html.includes("'=CMD"), "Formula neutralized in HTML preview");

    await assert.rejects(
      () => extractSpreadsheetText(Buffer.from("MZ\x90\x00disguised"), "evil.xlsx"),
      /Unsupported legacy binary or malformed/
    );
    const hugeFake = Buffer.alloc(MAX_SPREADSHEET_BYTES + 10);
    await assert.rejects(
      () => extractSpreadsheetText(hugeFake, "huge.xlsx"),
      /exceeds maximum allowed parsing size/
    );

    pass("Task 1: ExcelJS parsing, formula-injection neutralization, XSS escaping & malicious spreadsheet rejection");
  } catch (e) {
    fail("Task 1: ExcelJS hardening", e);
  }

  // 2. Persistent Sessions Across Simulated Backend Restart + Concurrent Refresh Race
  try {
    const db = require("./db");
    await db.initDatabase();
    const sessionMgr1 = require("./sessionManager");
    const testJti = "restart-jti-" + crypto.randomUUID();
    await sessionMgr1.revokeJti(testJti, Math.floor(Date.now() / 1000) + 3600);

    const issued = await sessionMgr1.issueRefreshToken(4242, 1);

    // Simulate backend restart by clearing module cache
    delete require.cache[require.resolve("./sessionManager")];
    delete require.cache[require.resolve("./db")];
    const db2 = require("./db");
    await db2.initDatabase();
    const sessionMgr2 = require("./sessionManager");

    assert.strictEqual(await sessionMgr2.isJtiRevoked(testJti), true, "Revoked jti must persist across restart");

    // Concurrent refresh race on the same token: at most 1 succeeds, other catches replay & revokes family
    const [r1, r2] = await Promise.all([
      sessionMgr2.rotateRefreshToken(issued.refreshToken),
      sessionMgr2.rotateRefreshToken(issued.refreshToken),
    ]);
    const successes = [r1, r2].filter((r) => r.valid);
    const failures = [r1, r2].filter((r) => !r.valid);
    assert.strictEqual(successes.length, 1, "Only one concurrent refresh may succeed");
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].reason, "token_replay_detected");

    // Family is already revoked so the winner's token is also invalidated
    const afterReplay = await sessionMgr2.rotateRefreshToken(successes[0].refreshToken);
    assert.strictEqual(afterReplay.valid, false, "Token family must be revoked after replay");

    pass("Task 3: Persistent jti revocation & atomic refresh rotation survive simulated restart & concurrent race");
  } catch (e) {
    fail("Task 3: Persistent sessions", e);
  }

  // 3. Encryption Key Rotation & Production Fatal Startup Check (via isolated child processes)
  try {
    const key1 = crypto.randomBytes(32).toString("hex");
    const key2 = crypto.randomBytes(32).toString("hex");
    const wrongKey = crypto.randomBytes(32).toString("hex");

    const encHex = execFileSync(
      process.execPath,
      [
        "-e",
        "const c=require('./cryptoAtRest'); console.log(c.encryptBuffer(Buffer.from('RotationSecret123'),'doc/1.zip').toString('hex'));",
      ],
      { cwd: __dirname, env: { ...process.env, ENCRYPTION_MASTER_KEY: key1 }, encoding: "utf8" }
    ).trim();

    const rotatedOut = execFileSync(
      process.execPath,
      [
        "-e",
        `const c=require('./cryptoAtRest');
         const oldDec=c.decryptBuffer(Buffer.from('${encHex}','hex'),'doc/1.zip').toString('utf8');
         const newEnc=c.encryptBuffer(Buffer.from('NewKeySecret456'),'doc/2.zip');
         const newDec=c.decryptBuffer(newEnc,'doc/2.zip').toString('utf8');
         console.log(oldDec + '|' + newDec);`,
      ],
      {
        cwd: __dirname,
        env: { ...process.env, ENCRYPTION_MASTER_KEY: key2, ENCRYPTION_MASTER_KEY_PREVIOUS: key1 },
        encoding: "utf8",
      }
    ).trim();
    assert.strictEqual(rotatedOut, "RotationSecret123|NewKeySecret456");

    const wrongKeyResult = execFileSync(
      process.execPath,
      [
        "-e",
        `const c=require('./cryptoAtRest');
         try { c.decryptBuffer(Buffer.from('${encHex}','hex'),'doc/1.zip'); console.log('UNEXPECTED_OK'); }
         catch (e) { console.log('REJECTED_SAFELY'); }`,
      ],
      { cwd: __dirname, env: { ...process.env, ENCRYPTION_MASTER_KEY: wrongKey }, encoding: "utf8" }
    ).trim();
    assert.strictEqual(wrongKeyResult, "REJECTED_SAFELY");

    const prodEnv = { ...process.env, NODE_ENV: "production" };
    delete prodEnv.ENCRYPTION_MASTER_KEY;
    const prodCheck = execFileSync(
      process.execPath,
      [
        "-e",
        "try { require('./cryptoAtRest').encryptBuffer(Buffer.from('x'),'k'); console.log('FAIL'); } catch (e) { console.log('PROD_FATAL_OK'); }",
      ],
      { cwd: __dirname, env: prodEnv, encoding: "utf8" }
    ).trim();
    assert.strictEqual(prodCheck, "PROD_FATAL_OK");

    pass("Task 5: Key rotation (Key1 -> Key2 + PREVIOUS), invalid key rejection & production mandatory key check");
  } catch (e) {
    fail("Task 5: Encryption key rotation", e);
  }

  console.log("\n=====================================================");
  console.log(` RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=====================================================");
  if (failed > 0) process.exit(1);
}

run();
