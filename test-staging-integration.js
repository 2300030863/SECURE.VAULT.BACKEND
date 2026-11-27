/**
 * DocQevrilo – Stage 5 Live Staging Integration & Security Test Suite
 *
 * Usage:
 *   STAGING_API_URL=https://docqevrilo-staging-api.onrender.com/api \
 *   STAGING_FRONTEND_URL=https://docqevrilo-staging.vercel.app \
 *   node backend/test-staging-integration.js
 */

const assert = require("assert");

const API_BASE = (process.env.STAGING_API_URL || "").trim().replace(/\/+$/, "");
const FRONTEND_URL = (process.env.STAGING_FRONTEND_URL || "").trim().replace(/\/+$/, "");

if (!API_BASE || !FRONTEND_URL) {
  console.error("Usage: Set STAGING_API_URL and STAGING_FRONTEND_URL before running.");
  process.exit(2);
}

if (
  API_BASE.includes("secure-vault-backend-1.onrender.com") ||
  FRONTEND_URL.includes("secure-vault-delta-virid.vercel.app")
) {
  console.error("ABORTED: Refusing to run staging tests against production URLs.");
  process.exit(2);
}

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
  console.log(" DocQevrilo Stage 5 Live Staging Verification");
  console.log(` API:      ${API_BASE}`);
  console.log(` Frontend: ${FRONTEND_URL}`);
  console.log("=====================================================\n");

  // 1. HTTPS & Health Check + HTTP Security Headers
  try {
    assert(API_BASE.startsWith("https://"), "Staging API must use HTTPS");
    assert(FRONTEND_URL.startsWith("https://"), "Staging Frontend must use HTTPS");
    const res = await fetch(`${API_BASE}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, "ok");
    assert.strictEqual(res.headers.get("x-powered-by"), null);
    assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
    assert(res.headers.get("strict-transport-security")?.includes("max-age=31536000"));
    assert(Boolean(res.headers.get("x-request-id")));
    pass("HTTPS health endpoint & Layer 4 security headers verified");
  } catch (e) {
    fail("HTTPS health & headers", e);
  }

  // 2. CORS Allowlist Enforcement
  try {
    const allowed = await fetch(`${API_BASE}/health`, { headers: { Origin: FRONTEND_URL } });
    assert.strictEqual(allowed.headers.get("access-control-allow-origin"), FRONTEND_URL);

    const evil = await fetch(`${API_BASE}/health`, { headers: { Origin: "https://evil-attacker.example" } });
    assert.strictEqual(evil.headers.get("access-control-allow-origin"), null);
    pass("CORS allows staging frontend and rejects untrusted origin");
  } catch (e) {
    fail("CORS enforcement", e);
  }

  // 3. WAF & Probe Protection
  try {
    const probe = await fetch(`${API_BASE.replace(/\/api$/, "")}/.env`);
    assert([403, 404].includes(probe.status));

    const sqli = await fetch(`${API_BASE}/documents/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_code: "' OR 1=1 --" }),
    });
    assert.strictEqual(sqli.status, 403);
    pass("WAF blocks /.env probe and SQLi payload on staging");
  } catch (e) {
    fail("WAF protection", e);
  }

  // 4. Frontend Secret Scan
  try {
    const htmlRes = await fetch(FRONTEND_URL);
    assert.strictEqual(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert(!html.includes("ENCRYPTION_MASTER_KEY"));
    assert(!html.includes("JWT_SECRET"));
    pass("Staging frontend reachable over HTTPS with zero leaked secret keys");
  } catch (e) {
    fail("Frontend reachability & secret scan", e);
  }

  console.log("\n=====================================================");
  console.log(` RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=====================================================");
  process.exit(failed > 0 ? 1 : 0);
}

run();
