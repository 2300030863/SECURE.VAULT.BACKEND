const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("./db");
const { sendResetEmail, isEmailConfigured } = require("./mailer");

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

  const genericMessage = "If an account exists for that email, a password reset link and 6-digit OTP code will be sent.";

  try {
    const [users] = await db.execute(
      "SELECT id, email FROM users WHERE LOWER(email) = ? LIMIT 1",
      [email]
    );

    if (!users || users.length === 0) {
      return res.json({
        message: genericMessage,
        isEmailConfigured: isEmailConfigured(),
      });
    }

    const user = users[0];

    // Generate 6-digit OTP Code (e.g. "849201")
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Cryptographically secure 32 random bytes -> 64-character hex token
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);

    // Token & OTP expire strictly in 15 minutes
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const expiresAtSql = expiresAt.toISOString().slice(0, 19).replace("T", " ");

    // Invalidate any older unused reset tokens for this user
    await db.execute(
      "DELETE FROM password_reset_tokens WHERE user_id = ?",
      [user.id]
    );

    // Save token hash and 6-digit OTP code in TiDB Cloud
    await db.execute(
      "INSERT INTO password_reset_tokens (user_id, email, token_hash, otp_code, expires_at) VALUES (?, ?, ?, ?, ?)",
      [user.id, user.email.toLowerCase(), tokenHash, otpCode, expiresAtSql]
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

    let mailResult;
    try {
      mailResult = await sendResetEmail(user.email, resetUrl.toString(), otpCode);
    } catch (mailError) {
      console.error("[SMTP Mail Delivery Error]:", mailError.message);
      // Invalidate the token immediately if sending fails
      await db.execute(
        "DELETE FROM password_reset_tokens WHERE token_hash = ?",
        [tokenHash]
      );
      return res.status(500).json({
        message: mailError.code === "SMTP_NOT_CONFIGURED"
          ? "Gmail credentials are not configured. Please enter your GMAIL_USER and GMAIL_APP_PASSWORD in backend/.env to send OTP emails."
          : `Failed to deliver email: ${mailError.message}. Check your GMAIL_USER & GMAIL_APP_PASSWORD in backend/.env.`,
      });
    }

    return res.json({
      success: true,
      message: `A 6-digit OTP verification code has been sent to ${user.email}. Please check your email inbox.`,
      email: user.email,
    });
  } catch (error) {
    console.error("[Forgot Password Error]:", error.message);
    return res.status(500).json({
      message: "Unable to process the request right now. Please try again later.",
    });
  }
});

// POST /api/auth/reset-password
// Supports both 6-digit OTP code verification AND token link verification!
router.post("/reset-password", resetLimiter, async (req, res) => {
  const { token, email, otp, password } = req.body;

  // Validation: Must provide either a 64-char hex token OR (email + 6-digit OTP)
  const hasToken = typeof token === "string" && /^[a-f0-9]{64}$/i.test(token.trim());
  const hasOtp =
    typeof email === "string" &&
    validEmail(email.trim().toLowerCase()) &&
    typeof otp === "string" &&
    /^\d{6}$/.test(otp.trim());

  if (!hasToken && !hasOtp) {
    return res.status(400).json({
      message: "Please provide a valid 6-digit OTP code with your email, or use a valid reset link.",
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

    if (hasOtp) {
      // Find valid record by Email + 6-Digit OTP
      const cleanEmail = email.trim().toLowerCase();
      const cleanOtp = otp.trim();

      const [found] = await connection.execute(
        `SELECT id, user_id FROM password_reset_tokens 
         WHERE LOWER(email) = ? AND otp_code = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() 
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [cleanEmail, cleanOtp]
      );
      rows = found;
    } else {
      // Find valid record by 64-char Token Hash
      const tokenHash = hashToken(token.trim());
      const [found] = await connection.execute(
        `SELECT id, user_id FROM password_reset_tokens 
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() 
         LIMIT 1 FOR UPDATE`,
        [tokenHash]
      );
      rows = found;
    }

    if (!rows || rows.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        message: "Invalid or expired OTP / reset link. Please request a new one.",
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

    // Mark current token/OTP as consumed
    await connection.execute(
      "UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?",
      [resetRecord.id]
    );

    // Invalidate any remaining reset records for this user
    await connection.execute(
      "DELETE FROM password_reset_tokens WHERE user_id = ? AND id <> ?",
      [resetRecord.user_id, resetRecord.id]
    );

    await connection.commit();

    return res.json({
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
