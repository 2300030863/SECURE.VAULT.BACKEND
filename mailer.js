const nodemailer = require("nodemailer");

function createTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  // Check if credentials are placeholder or missing
  const isConfigured =
    user &&
    pass &&
    user !== "your-email@gmail.com" &&
    pass !== "your-16-character-app-password" &&
    !user.includes("example.com");

  if (!isConfigured) {
    return null;
  }

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: user.trim(),
      pass: pass.trim().replace(/\s+/g, ""), // Remove any accidental spaces in app password
    },
    tls: {
      rejectUnauthorized: true,
    },
  });
}

/**
 * Sends a password reset email with both a 6-digit OTP code and a 1-click reset link.
 * @param {string} email - Destination email address
 * @param {string} resetUrl - Complete frontend URL with token parameter
 * @param {string} [otpCode] - 6-digit OTP code
 */
async function sendResetEmail(email, resetUrl, otpCode = "") {
  const transporter = createTransporter();

  // If Gmail SMTP credentials are not configured, throw a clear error
  if (!transporter) {
    const error = new Error("Gmail credentials are not configured. Please enter your GMAIL_USER and GMAIL_APP_PASSWORD in backend/.env to send OTP emails.");
    error.code = "SMTP_NOT_CONFIGURED";
    throw error;
  }

  const sender = process.env.GMAIL_USER.trim();

  await transporter.sendMail({
    from: `"DocQevrilo" <${sender}>`,
    to: email,
    subject: otpCode
      ? `Your DocQevrilo Password Reset Code: ${otpCode}`
      : "Reset your DocQevrilo password",
    text: [
      "We received a request to reset your DocQevrilo password.",
      "",
      otpCode ? `Your 6-Digit OTP Verification Code is: ${otpCode}` : "",
      "",
      `Or click this link to choose a new password: ${resetUrl}`,
      "",
      "This code and link expire in 15 minutes and can only be used once.",
      "If you did not request this, you can ignore this email.",
    ]
      .filter(Boolean)
      .join("\n"),
    html: `
      <div style="background-color:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fafafa;padding:40px 16px;">
        <div style="max-width:560px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.5);">
          <!-- Header -->
          <div style="padding:28px 32px;background:linear-gradient(180deg,#1f1f23 0%,#18181b 100%);border-bottom:1px solid #27272a;text-align:center;">
            <div style="display:inline-block;width:44px;height:44px;line-height:44px;border-radius:10px;background:#dc2626;color:#ffffff;font-size:22px;font-weight:bold;margin-bottom:12px;">
              🛡️
            </div>
            <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">DocQevrilo</h1>
            <p style="margin:4px 0 0;font-size:13px;color:#a1a1aa;">One Code. Simple Sharing. — Secure Document Sharing Platform</p>
          </div>

          <!-- Body -->
          <div style="padding:32px;">
            <h2 style="margin:0 0 12px;font-size:18px;color:#ffffff;font-weight:600;">Reset your account password</h2>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#d4d4d8;">
              We received a request to reset the password for your DocQevrilo account. Use the 6-digit OTP code below or click the direct reset link.
            </p>

            ${
              otpCode
                ? `
            <!-- OTP Box -->
            <div style="text-align:center;margin:24px 0;background:#09090b;padding:20px;border-radius:12px;border:1px solid #3f3f46;">
              <p style="margin:0 0 8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:1px;">Your 6-Digit OTP Code</p>
              <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#f87171;font-family:monospace;">
                ${otpCode}
              </div>
            </div>
            `
                : ""
            }

            <!-- 1-Click Link Button -->
            <div style="text-align:center;margin:28px 0;">
              <a href="${resetUrl}" style="display:inline-block;padding:13px 28px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;box-shadow:0 4px 14px rgba(220,38,38,0.4);">
                Reset Password Directly
              </a>
            </div>

            <div style="background:#27272a;padding:14px 16px;border-radius:8px;border-left:3px solid #dc2626;margin:24px 0;">
              <p style="margin:0;font-size:13px;color:#e4e4e7;line-height:1.5;">
                ⏱️ <strong>Time-sensitive security notice:</strong> This OTP code and link expire in <strong>15 minutes</strong> and can only be used once.
              </p>
            </div>

            <p style="margin:24px 0 8px;font-size:12px;color:#a1a1aa;">
              If the button does not work, copy and paste this URL into your browser:
            </p>
            <p style="margin:0 0 24px;font-size:12px;color:#f87171;word-break:break-all;background:#09090b;padding:10px;border-radius:6px;border:1px solid #27272a;">
              ${resetUrl}
            </p>

            <p style="margin:0;font-size:12px;color:#71717a;line-height:1.5;border-top:1px solid #27272a;padding-top:20px;">
              If you did not request a password reset, you can safely ignore this email. No changes will be made to your account.
            </p>
          </div>
        </div>
      </div>
    `,
  });

  return { messageId: "sent", simulated: false, otpCode };
}

module.exports = { sendResetEmail, isEmailConfigured: () => Boolean(createTransporter()) };
