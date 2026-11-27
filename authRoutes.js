const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("./db");
const { sendResetEmail, isEmailConfigured } = require("./mailer");
const { checkOtpRateLimit, resetOtpRateLimit } = require("./otpRateLimiter");

const router = express.Router();

// Rate limiters for protection against brute force and email spamming
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    message: "Too many reset requests from this IP. Please try again in 15 minutes.",
  },
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    message: "Too many password attempts. Please try again later.",
  },
});

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function validEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    email.length <= 254
  );
}

// POST /api/auth/forgot-password
router.post("/forgot-password", forgotLimiter, async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";

  if (!validEmail(email)) {
    return res.status(400).json({
      message: "Please enter a valid email address.",
    });
  }

  // 3-Attempt OTP limit with 20-minute hold on 4th attempt
  const rateLimitCheck = await checkOtpRateLimit(email, "forgot_password", 3, 20);
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({
      message: rateLimitCheck.message,
      locked: true,
      minutesRemaining: rateLimitCheck.minutesRemaining,
    });
  }

  const genericMessage = "If an account exists for that email, a password reset link and 6-digit OTP code will be sent.";

  try {
    const [users] = await db.execute(
      "SELECT id, email FROM users WHERE LOWER(email) = ? LIMIT 1",
      [email]
    );

    if (!users || users.length === 0) {
      return res.json({
        success: true,
        emailSent: true,
        message: `If an account exists for ${email}, a password reset link and 6-digit verification code have been dispatched.`,
        email: email,
        expiresInMinutes: 15,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        expiresTimestamp: Date.now() + 15 * 60 * 1000,
        isEmailConfigured: isEmailConfigured(),
      });
    }

    const user = users[0];

    // Cryptographically secure 6-digit OTP Code (e.g. "849201")
    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const otpHash = hashToken(otpCode);

    // Cryptographically secure 32 random bytes -> 64-character hex token
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);

    // Token & OTP expire strictly in 15 minutes
    const expiresTimestamp = Date.now() + 15 * 60 * 1000;
    const expiresAt = new Date(expiresTimestamp);
    const expiresAtSql = expiresAt.toISOString().slice(0, 19).replace("T", " ");

    // Invalidate any older unused reset tokens for this user
    await db.execute(
      "DELETE FROM password_reset_tokens WHERE user_id = ?",
      [user.id]
    );

    // Securely save token hash and hashed OTP code in TiDB Cloud
    await db.execute(
      "INSERT INTO password_reset_tokens (user_id, email, token_hash, otp_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
      [user.id, user.email.toLowerCase(), tokenHash, otpHash, expiresAtSql]
    );

    // Automatically detect frontend URL from incoming request header
    let callerOrigin = null;
    if (req.headers.origin) {
      callerOrigin = req.headers.origin;
    } else if (req.headers.referer) {
      try {
        callerOrigin = new URL(req.headers.referer).origin;
      } catch (_) {}
    }

    const frontendUrl =
      callerOrigin ||
      process.env.FRONTEND_URL ||
      process.env.FRONTEND_ORIGIN ||
      "http://localhost:5173";

    const resetUrl = new URL("/reset-password", frontendUrl);
    resetUrl.searchParams.set("token", token);
    resetUrl.searchParams.set("email", user.email);
    resetUrl.searchParams.set("otp", otpCode);
    resetUrl.searchParams.set("exp", String(expiresTimestamp));

    console.log(`[Forgot Password OTP] Reset OTP dispatched for ${user.email} (Expires in 15m)`);

    let mailResult;
    let emailSent = false;
    let mailErrorMsg = "";

    try {
      mailResult = await sendResetEmail(user.email, resetUrl.toString(), otpCode);
      emailSent = true;
    } catch (mailError) {
      console.error("[Mail Delivery Error]:", mailError.message);
      mailErrorMsg = mailError.message || "";
    }

    if (!emailSent) {
      const isBrevoIpBlocked = mailErrorMsg.includes("authorised_ips");
      const isLocalDev = process.env.NODE_ENV !== "production" && !process.env.RENDER;

      if (isLocalDev) {
        console.log(`ℹ️ [DEV FALLBACK] Allowing password reset OTP in dev mode even though Brevo email delivery failed.`);
        return res.json({
          success: true,
          emailSent: false,
          devOtp: otpCode,
          email: user.email,
          expiresInMinutes: 15,
          expiresTimestamp,
          message: isBrevoIpBlocked
            ? `Brevo IP authorization needed (IP blocked). For testing, your OTP code is: ${otpCode} (also check backend terminal).`
            : `Email delivery issue. For testing, your OTP code is: ${otpCode} (also check backend terminal).`,
        });
      }

      await db.execute(
        "DELETE FROM password_reset_tokens WHERE token_hash = ?",
        [tokenHash]
      );
      return res.status(502).json({
        message: isBrevoIpBlocked
          ? "Brevo IP authorization needed: add your server IP in https://app.brevo.com/security/authorised_ips"
          : "Failed to deliver reset email. Please try again later.",
      });
    }

    console.log(`[Forgot Password OTP] Reset code issued for ${user.email} (Expires in 15m)`);

    return res.json({
      success: true,
      emailSent: true,
      message: `A 6-digit OTP verification code and reset link have been dispatched to ${user.email}. Please check your email inbox.`,
      email: user.email,
      expiresInMinutes: 15,
      expiresAt: expiresAt.toISOString(),
      expiresTimestamp,
    });
  } catch (error) {
    console.error("[Forgot Password Error]:", error.message);
    return res.status(500).json({
      message: "Unable to process the request right now. Please try again later.",
    });
  }
});

// GET /api/auth/verify-reset-token
// Validates whether an email reset token is still active (< 15 mins and unused)
router.get("/verify-reset-token", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";

  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).json({
      valid: false,
      expired: true,
      message: "A valid email reset verification link is required.",
    });
  }

  try {
    const tokenHash = hashToken(token);
    const [rows] = await db.execute(
      `SELECT id, user_id, email, expires_at, used_at FROM password_reset_tokens 
       WHERE token_hash = ? ORDER BY id DESC LIMIT 1`,
      [tokenHash]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        valid: false,
        expired: true,
        message: "This password reset link is invalid or has already been used.",
      });
    }

    const rec = rows[0];
    const isUsed = Boolean(rec.used_at);
    const isTimeExpired = new Date(rec.expires_at).getTime() <= Date.now();

    if (isUsed || isTimeExpired) {
      return res.status(410).json({
        valid: false,
        expired: true,
        isUsed,
        message: isUsed
          ? "This reset link has already been used and cannot be reused. Please request a new link if needed."
          : "This password reset link has expired after 15 minutes. Please request a new link.",
      });
    }

    const remainingMs = Math.max(0, new Date(rec.expires_at).getTime() - Date.now());

    return res.json({
      valid: true,
      email: rec.email,
      expiresAt: rec.expires_at,
      remainingSeconds: Math.floor(remainingMs / 1000),
    });
  } catch (error) {
    console.error("[Verify Reset Token Error]:", error.message);
    return res.status(500).json({
      valid: false,
      error: "Unable to verify reset link.",
    });
  }
});

// POST /api/auth/reset-password
// Requires valid token verification from email link
router.post("/reset-password", resetLimiter, async (req, res) => {
  const { token, email, otp, password } = req.body;

  // Validation: Must provide a 64-char hex token from the email verification link (or email + 6-digit OTP from email)
  const hasToken = typeof token === "string" && /^[a-f0-9]{64}$/i.test(token.trim());
  const hasOtp =
    typeof email === "string" &&
    validEmail(email.trim().toLowerCase()) &&
    typeof otp === "string" &&
    /^\d{6}$/.test(otp.trim());

  if (!hasToken && !hasOtp) {
    return res.status(400).json({
      message: "Please open the direct reset link sent to your email to choose a new password.",
      expired: true,
    });
  }

  // Password validation: minimum 8 characters, maximum 72 bytes
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    return res.status(400).json({
      message: "Password must be at least 8 characters and no more than 72 bytes.",
    });
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    let rows = [];

    if (hasToken) {
      // Find valid record by 64-char Token Hash
      const tokenHash = hashToken(token.trim());
      const [found] = await connection.execute(
        `SELECT id, user_id, email FROM password_reset_tokens 
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() 
         LIMIT 1 FOR UPDATE`,
        [tokenHash]
      );
      rows = found;
    } else {
      // Find valid record by Email + Hashed OTP
      const cleanEmail = email.trim().toLowerCase();
      const cleanOtp = otp.trim();
      const cleanOtpHash = hashToken(cleanOtp);

      const [found] = await connection.execute(
        `SELECT id, user_id, email FROM password_reset_tokens 
         WHERE LOWER(email) = ? AND (otp_hash = ? OR (otp_hash IS NULL AND otp_code = ?)) AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() 
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [cleanEmail, cleanOtpHash, cleanOtp]
      );
      rows = found;
    }

    if (!rows || rows.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        message: "Invalid or expired reset link. Reset links expire strictly after 15 minutes or after being used. Please request a new one.",
        expired: true,
      });
    }

    const resetRecord = rows[0];

    // Securely hash the new password using bcrypt (12 salt rounds)
    const passwordHash = await bcrypt.hash(password, 12);

    // Update password in users table
    const [updateResult] = await connection.execute(
      "UPDATE users SET password_hash = ? WHERE id = ?",
      [passwordHash, resetRecord.user_id]
    );

    if (updateResult.affectedRows !== 1) {
      throw new Error("User account could not be updated");
    }

    // Mark current token/OTP as consumed immediately
    await connection.execute(
      "UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?",
      [resetRecord.id]
    );

    // Immediately purge all reset tokens for this user so the link can NEVER be reused
    await connection.execute(
      "DELETE FROM password_reset_tokens WHERE user_id = ?",
      [resetRecord.user_id]
    );

    await connection.commit();

    if (resetRecord.email) {
      await resetOtpRateLimit(resetRecord.email, "forgot_password");
    }

    return res.json({
      success: true,
      message: "Password reset successfully! You can now sign in with your new password.",
    });
  } catch (error) {
    await connection.rollback();
    console.error("[Reset Password Error]:", error.message);
    return res.status(500).json({
      message: "Unable to reset the password right now. Please try again.",
    });
  } finally {
    connection.release();
  }
});

module.exports = router;
