/**
 * In-memory OTP Rate Limiter & Cooldown Tracker
 * - Limit: 3 attempts per window
 * - On 4th attempt: 20-minute hold / lockout
 */

const rateLimitStore = new Map();

function checkOtpRateLimit(identifier, purpose = "general", maxAttempts = 3, lockoutMinutes = 20) {
  if (!identifier) return { allowed: true };

  const key = `${purpose}:${String(identifier).toLowerCase().trim()}`;
  const now = Date.now();
  const lockoutMs = lockoutMinutes * 60 * 1000;

  let record = rateLimitStore.get(key);

  if (record) {
    // Check if currently locked out
    if (record.lockedUntil && record.lockedUntil > now) {
      const msRemaining = record.lockedUntil - now;
      const minutesRemaining = Math.max(1, Math.ceil(msRemaining / (60 * 1000)));
      return {
        allowed: false,
        locked: true,
        minutesRemaining,
        message: `Too many OTP requests. Limit is ${maxAttempts} attempts. Please try again in ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`,
      };
    }

    // If lockout has passed, reset record
    if (record.lockedUntil && record.lockedUntil <= now) {
      record = null;
      rateLimitStore.delete(key);
    }
  }

  if (!record) {
    record = {
      attempts: 0,
      firstAttemptAt: now,
      lockedUntil: 0,
    };
    rateLimitStore.set(key, record);
  }

  // Reset if the sliding window has expired without being locked
  if (now - record.firstAttemptAt > lockoutMs) {
    record.attempts = 0;
    record.firstAttemptAt = now;
  }

  // If already reached max attempts, lock out for 20 minutes
  if (record.attempts >= maxAttempts) {
    record.lockedUntil = now + lockoutMs;
    return {
      allowed: false,
      locked: true,
      minutesRemaining: lockoutMinutes,
      message: `Too many OTP requests. Limit is ${maxAttempts} attempts. Please try again in ${lockoutMinutes} minutes.`,
    };
  }

  record.attempts += 1;
  const attemptsRemaining = Math.max(0, maxAttempts - record.attempts);

  return {
    allowed: true,
    locked: false,
    attemptsCount: record.attempts,
    attemptsRemaining,
    maxAttempts,
  };
}

function resetOtpRateLimit(identifier, purpose = "general") {
  if (!identifier) return;
  const key = `${purpose}:${String(identifier).toLowerCase().trim()}`;
  rateLimitStore.delete(key);
}

function getOtpRateLimitStatus(identifier, purpose = "general") {
  if (!identifier) return { locked: false, attemptsRemaining: 3 };
  const key = `${purpose}:${String(identifier).toLowerCase().trim()}`;
  const record = rateLimitStore.get(key);
  if (!record) return { locked: false, attemptsRemaining: 3 };
  const now = Date.now();
  if (record.lockedUntil && record.lockedUntil > now) {
    const msRemaining = record.lockedUntil - now;
    const minutesRemaining = Math.max(1, Math.ceil(msRemaining / (60 * 1000)));
    return {
      locked: true,
      minutesRemaining,
      message: `Too many OTP requests. Limit is 3 attempts. Locked for ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`,
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
