/**
 * DocQevrilo Layer 5 – Persistent Session Lifecycle, Revocation & Refresh Token Rotation
 *
 * Persists revoked JWT IDs (`jti`) and hashed refresh tokens in TiDB Cloud
 * (with `local_sessions.json` fallback for local dev) so revocations and
 * replay detection survive backend restarts.
 */

const crypto = require("crypto");
const db = require("./db");

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sessionEvents = [];
const MAX_SESSION_EVENTS = 100;

function recordSessionEvent(type, details = {}) {
  sessionEvents.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    ...details,
  });
  if (sessionEvents.length > MAX_SESSION_EVENTS) {
    sessionEvents.length = MAX_SESSION_EVENTS;
  }
}

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function revokeJti(jti, expSeconds) {
  if (!jti) return;
  const expiresAt = expSeconds ? expSeconds * 1000 : Date.now() + 24 * 60 * 60 * 1000;
  await db.saveRevokedJti(String(jti), expiresAt);
}

async function isJtiRevoked(jti) {
  if (!jti) return false;
  return await db.checkJtiRevoked(String(jti));
}

async function issueRefreshToken(userId, tokenVersion = 1, familyId = null) {
  const rawToken = crypto.randomBytes(40).toString("hex");
  const tokenHash = hashRefreshToken(rawToken);
  const fId = familyId || crypto.randomUUID();
  const expiresAt = Date.now() + REFRESH_TTL_MS;

  await db.insertRefreshToken({
    tokenHash,
    userId: Number(userId),
    familyId: fId,
    tokenVersion: Number(tokenVersion) || 1,
    expiresAt,
  });

  return { refreshToken: rawToken, familyId: fId, expiresAt };
}

async function revokeRefreshFamily(familyId) {
  await db.revokeRefreshFamilyDb(familyId);
}

async function revokeUserRefreshTokens(userId) {
  await db.revokeUserRefreshTokensDb(userId);
}

async function rotateRefreshToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") {
    return { valid: false, reason: "missing_token" };
  }
  const oldHash = hashRefreshToken(rawToken);
  const nextRaw = crypto.randomBytes(40).toString("hex");
  const nextHash = hashRefreshToken(nextRaw);
  const nextExpiresAt = Date.now() + REFRESH_TTL_MS;

  const result = await db.consumeAndRotateRefreshToken(oldHash, {
    tokenHash: nextHash,
    expiresAt: nextExpiresAt,
  });

  if (!result.valid) {
    if (result.reason === "token_replay_detected") {
      recordSessionEvent("REFRESH_TOKEN_REPLAY", {
        userId: result.userId,
        familyId: result.familyId,
      });
    }
    return result;
  }

  return {
    valid: true,
    userId: result.userId,
    familyId: result.familyId,
    tokenVersion: result.tokenVersion,
    refreshToken: nextRaw,
    expiresAt: nextExpiresAt,
  };
}

async function getSessionTelemetry() {
  const dbMetrics = await db.getSessionDbMetrics();
  return {
    ...dbMetrics,
    recentSessionEvents: sessionEvents.slice(0, 25),
  };
}

module.exports = {
  revokeJti,
  isJtiRevoked,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshFamily,
  revokeUserRefreshTokens,
  recordSessionEvent,
  getSessionTelemetry,
};
