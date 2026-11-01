/**
 * Persistent OTP Rate Limiter & Cooldown Tracker
 * - Limit: 3 attempts per window
 * - On 4th attempt: 20-minute hold / lockout
 * - Backed by TiDB Cloud MySQL `otp_rate_limits` & local JSON fallback to survive server restarts.
 */

const {
  getOtpRateLimitRecord,
  saveOtpRateLimitRecord,
  removeOtpRateLimitRecord,
} = require("./db");

const rateLimitMemoryCache = new Map();

async function checkOtpRateLimit(identifier, purpose = "general", maxAttempts = 3, lockoutMinutes = 20) {
  if (!identifier) return { allowed: true };

  const key = `${purpose}:${String(identifier).toLowerCase().trim()}`;
  const now = Date.now();
  const lockoutMs = lockoutMinutes * 60 * 1000;

  let record = rateLimitMemoryCache.get(key);

  // If not found in memory cache, retrieve from persistent storage
  if (!record) {
    try {
      const persisted = await getOtpRateLimitRecord(key);
      if (persisted) {
        record = {
          attempts: Number(persisted.attempts || 0),
          firstAttemptAt: Number(persisted.firstAttemptAt || now),
          lockedUntil: Number(persisted.lockedUntil || 0),
        };
        rateLimitMemoryCache.set(key, record);
      }
    } catch (err) {
      console.warn("[OTP Rate Limiter Persistent Load Warning]:", err.message);
    }
  }

  if (record) {
    // Check if currently locked out
    if (record.lockedUntil && record.lockedUntil > now) {
      const msRemaining = record.lockedUntil - now;
      const minutesRemaining = Math.max(1, Math.ceil(msRemaining / (60 * 1000)));
      return {
        allowed: false,
        locked: true,
        minutesRemaining,
        message: `Too many OTP requests. Limit is ${maxAttempts} attempts. Please try again in ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}.`,
      };
    }

    // If lockout has passed, reset record
    if (record.lockedUntil && record.lockedUntil <= now) {
      record = null;
      rateLimitMemoryCache.delete(key);
      try {
        await removeOtpRateLimitRecord(key);
      } catch (_) {}
    }
  }

  if (!record) {
    record = {
      attempts: 0,
      firstAttemptAt: now,
      lockedUntil: 0,
    };
    rateLimitMemoryCache.set(key, record);
  }

  // Reset if the sliding window has expired without being locked
  if (now - record.firstAttemptAt > lockoutMs) {
    record.attempts = 0;
    record.firstAttemptAt = now;
  }

  // If already reached max attempts, lock out for lockoutMinutes
  if (record.attempts >= maxAttempts) {
    record.lockedUntil = now + lockoutMs;
    try {
      await saveOtpRateLimitRecord(key, record.attempts, record.firstAttemptAt, record.lockedUntil);
    } catch (err) {
      console.warn("[OTP Rate Limiter Persistent Save Warning]:", err.message);
    }
    return {
      allowed: false,
      locked: true,
      minutesRemaining: lockoutMinutes,
      message: `Too many OTP requests. Limit is ${maxAttempts} attempts. Please try again in ${lockoutMinutes} minutes.`,
    };
  }

  record.attempts += 1;
  const attemptsRemaining = Math.max(0, maxAttempts - record.attempts);

  try {
    await saveOtpRateLimitRecord(key, record.attempts, record.firstAttemptAt, record.lockedUntil);
  } catch (err) {
    console.warn("[OTP Rate Limiter Persistent Save Warning]:", err.message);
  }

  return {
    allowed: true,
    locked: false,
    attemptsCount: record.attempts,
    attemptsRemaining,
    maxAttempts,
  };
}

async function resetOtpRateLimit(identifier, purpose = "general") {
  if (!identifier) return;
  const key = `${purpose}:${String(identifier).toLowerCase().trim()}`;
  rateLimitMemoryCache.delete(key);
  try {
    await removeOtpRateLimitRecord(key);
  } catch (err) {
    console.warn("[OTP Rate Limiter Reset Warning]:", err.message);
  }
}

async function getOtpRateLimitStatus(identifier, purpose = "general") {
  if (!identifier) return { locked: false, attemptsRemaining: 3 };
  const key = `${purpose}:${String(identifier).toLowerCase().trim()}`;
  let record = rateLimitMemoryCache.get(key);

  if (!record) {
    try {
      const persisted = await getOtpRateLimitRecord(key);
      if (persisted) {
        record = {
          attempts: Number(persisted.attempts || 0),
          firstAttemptAt: Number(persisted.firstAttemptAt || Date.now()),
          lockedUntil: Number(persisted.lockedUntil || 0),
        };
        rateLimitMemoryCache.set(key, record);
      }
    } catch (_) {}
  }

  if (!record) return { locked: false, attemptsRemaining: 3 };
  const now = Date.now();
  if (record.lockedUntil && record.lockedUntil > now) {
    const msRemaining = record.lockedUntil - now;
    const minutesRemaining = Math.max(1, Math.ceil(msRemaining / (60 * 1000)));
    return {
      locked: true,
      minutesRemaining,
      message: `Too many OTP requests. Limit is 3 attempts. Locked for ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}.`,
    };
  }
  return {
    locked: false,
    attemptsCount: record.attempts,
    attemptsRemaining: Math.max(0, 3 - record.attempts),
  };
}

module.exports = {
  checkOtpRateLimit,
  resetOtpRateLimit,
  getOtpRateLimitStatus,
};
