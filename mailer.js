function isBrevoConfigured() {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const senderEmail = process.env.BREVO_SENDER_EMAIL?.trim();
  return Boolean(
    apiKey &&
    apiKey !== "YOUR_COPIED_API_KEY" &&
    senderEmail &&
    senderEmail !== "your_verified_sender_email"
  );
}

function getBrevoSender() {
  return {
    name: process.env.BREVO_SENDER_NAME?.trim() || "DocQevrilo",
    email: process.env.BREVO_SENDER_EMAIL?.trim(),
  };
}

async function sendBrevoEmail({ to, subject, html, text, otpCode }) {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const sender = getBrevoSender();

  if (!apiKey || !sender.email) {
    const error = new Error(
      "Brevo email service is not configured. Add BREVO_API_KEY and BREVO_SENDER_EMAIL to backend/.env."
    );
    error.code = "BREVO_NOT_CONFIGURED";
    throw error;
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject: subject,
      htmlContent: html || `<p>${text || ""}</p>`,
      textContent: text || undefined,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("[Brevo API Error]", data);
    const deliveryError = new Error(data.message || `Brevo returned status ${response.status}`);
    deliveryError.code = "BREVO_DELIVERY_ERROR";
    deliveryError.details = data;
    throw deliveryError;
  }

  return { messageId: data.messageId || "sent", provider: "brevo", otpCode };
}

async function sendEmail(message) {
  if (!isBrevoConfigured()) {
    const error = new Error(
      "Brevo email service is not configured. Add BREVO_API_KEY & BREVO_SENDER_EMAIL to backend/.env."
    );
    error.code = "BREVO_NOT_CONFIGURED";
    throw error;
  }

  return await sendBrevoEmail(message);
}

/**
 * Sends a password reset email with both a 6-digit OTP code and a 1-click reset link.
 * @param {string} email - Destination email address
 * @param {string} resetUrl - Complete frontend URL with token parameter
 * @param {string} [otpCode] - 6-digit OTP code
 */
async function sendResetEmail(email, resetUrl, otpCode = "") {
  await sendEmail({
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

/**
 * Sends a 6-digit OTP email to verify revealing or regenerating a document access code.
 * @param {string} email - Destination email address
 * @param {string} otpCode - 6-digit OTP code
 * @param {string} docName - Document name or title
 * @param {string} action - 'reveal' or 'regenerate'
 */
async function sendAccessCodeOtpEmail(email, otpCode, docName = "Document Archive", action = "reveal") {
  const actionLabel = action === "regenerate" ? "Regenerate Vault Access Code" : "Reveal Vault Access Code";

  await sendEmail({
    to: email,
    subject: `Your Security OTP to ${actionLabel}: ${otpCode}`,
    text: [
      `Security verification request for DocQevrilo Vault: "${docName}".`,
      "",
      `Your 6-Digit Verification Code is: ${otpCode}`,
      "",
      "Enter this code along with your account password to authorize this action.",
      "This verification code expires in 10 minutes and can only be used once.",
      "If you did not request this verification, please sign into your DocQevrilo account and update your password immediately.",
    ].join("\n"),
    html: `
      <div style="background-color:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fafafa;padding:32px 16px;">
        <div style="max-width:540px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.5);">
          <div style="padding:24px 28px;background:linear-gradient(180deg,#1f1f23 0%,#18181b 100%);border-bottom:1px solid #27272a;text-align:center;">
            <div style="display:inline-block;width:44px;height:44px;line-height:44px;border-radius:10px;background:#dc2626;color:#ffffff;font-size:22px;margin-bottom:10px;">
              🛡️
            </div>
            <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">DocQevrilo Vault Security</h1>
            <p style="margin:4px 0 0;font-size:12px;color:#a1a1aa;">Two-Factor Access Code Authorization</p>
          </div>
          <div style="padding:28px;">
            <h2 style="margin:0 0 10px;font-size:16px;color:#ffffff;font-weight:600;">Authorize: ${actionLabel}</h2>
            <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#d4d4d8;">
              A request was initiated on your DocQevrilo account to ${action === "regenerate" ? "regenerate a new access code for" : "reveal the protected access code for"}: <strong>${docName}</strong>.
            </p>
            <div style="text-align:center;margin:20px 0;background:#09090b;padding:18px;border-radius:12px;border:1px solid #3f3f46;">
              <p style="margin:0 0 6px;font-size:11px;color:#a1a1aa;text-transform:uppercase;letter-spacing:1px;">Your 6-Digit Verification OTP</p>
              <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#f87171;font-family:monospace;">
                ${otpCode}
              </div>
            </div>
            <div style="background:#27272a;padding:12px 14px;border-radius:8px;border-left:3px solid #dc2626;margin:18px 0;">
              <p style="margin:0;font-size:12px;color:#e4e4e7;line-height:1.5;">
                ⏱️ This security OTP expires in <strong>10 minutes</strong>. Never share this code with anyone.
              </p>
            </div>
            <p style="margin:20px 0 0;font-size:11px;color:#71717a;line-height:1.5;border-top:1px solid #27272a;padding-top:16px;">
              If you did not request this, please secure your account immediately.
            </p>
          </div>
        </div>
      </div>
    `,
  });

  return { messageId: "sent", otpCode };
}

async function sendVerificationEmail(email, otpCode) {
  await sendEmail({
    to: email,
    subject: `Verify your DocQevrilo email: ${otpCode}`,
    text: [
      "Welcome to DocQevrilo.",
      "",
      `Your email verification code is: ${otpCode}`,
      "This code expires in 10 minutes.",
      "If you did not create this account, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="background:#09090b;font-family:Arial,sans-serif;color:#fafafa;padding:32px 16px;">
        <div style="max-width:520px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;text-align:center;">
          <div style="font-size:28px;margin-bottom:12px;">🛡️</div>
          <h1 style="margin:0 0 8px;color:#fff;">Verify your DocQevrilo email</h1>
          <p style="color:#a1a1aa;line-height:1.6;">Use this one-time code to activate your secure vault account.</p>
          <div style="margin:24px 0;padding:18px;background:#09090b;border:1px solid #3f3f46;border-radius:12px;font-size:34px;font-weight:800;letter-spacing:8px;color:#f87171;font-family:monospace;">${otpCode}</div>
          <p style="color:#a1a1aa;font-size:13px;">This code expires in 10 minutes.</p>
        </div>
      </div>
    `,
    otpCode,
  });
  return { messageId: "sent", otpCode };
}

async function sendPinRecoveryOtpEmail(email, otpCode) {
  await sendEmail({
    to: email,
    subject: `Your DocQevrilo Security PIN recovery code: ${otpCode}`,
    text: [
      "A request was made to replace your DocQevrilo 4-digit Security PIN.",
      "",
      `Your verification code is: ${otpCode}`,
      "This code expires in 10 minutes.",
      "If you did not request this, sign in and secure your account.",
    ].join("\n"),
    html: `
      <div style="background:#09090b;font-family:Arial,sans-serif;color:#fafafa;padding:32px 16px;">
        <div style="max-width:520px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;text-align:center;">
          <div style="font-size:28px;margin-bottom:12px;">🔐</div>
          <h1 style="margin:0 0 8px;color:#fff;">Security PIN recovery</h1>
          <p style="color:#a1a1aa;line-height:1.6;">Use this code to create a new 4-digit Security PIN.</p>
          <div style="margin:24px 0;padding:18px;background:#09090b;border:1px solid #3f3f46;border-radius:12px;font-size:34px;font-weight:800;letter-spacing:8px;color:#f87171;font-family:monospace;">${otpCode}</div>
          <p style="color:#a1a1aa;font-size:13px;">This code expires in 10 minutes. Never share it.</p>
        </div>
      </div>
    `,
    otpCode,
  });
  return { messageId: "sent", otpCode };
}

/**
 * Sends a custom administrator notification email (or broadcast).
 * @param {string} to - Destination email address
 * @param {string} subject - Email subject
 * @param {string} message - Email message body
 * @param {object} [options] - Optional category, recipientName, etc.
 */
async function sendAdminCustomEmail(to, subject, message, options = {}) {
  const category = options.category || "announcement";
  const recipientName = options.recipientName || "DocQevrilo User";

  const categoryBadgeColor =
    category === "security" ? "#dc2626" :
    category === "maintenance" ? "#d97706" :
    category === "urgent" ? "#b91c1c" : "#e50936";

  const categoryLabel =
    category === "security" ? "SECURITY ADVISORY" :
    category === "maintenance" ? "MAINTENANCE NOTICE" :
    category === "urgent" ? "URGENT SYSTEM UPDATE" : "SYSTEM ANNOUNCEMENT";

  const formattedHtmlContent = String(message || "")
    .split(/\n\s*\n/)
    .map((para) => `<p style="margin:0 0 14px;color:#d4d4d8;font-size:14px;line-height:1.7;">${para.replace(/\n/g, "<br/>")}</p>`)
    .join("");

  const html = `
    <div style="background-color:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fafafa;padding:36px 16px;">
      <div style="max-width:580px;margin:0 auto;background:#141418;border:1px solid #27272a;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
        <div style="height:3px;background:linear-gradient(90deg,#e50936,#ff365c,#e50936);"></div>
        <div style="padding:24px 28px 18px;background:#18181b;border-bottom:1px solid #27272a;">
          <div style="margin-bottom:10px;">
            <span style="font-size:10px;font-weight:700;letter-spacing:1px;padding:3px 8px;border-radius:4px;background:#1e1e24;color:${categoryBadgeColor};border:1px solid ${categoryBadgeColor}40;">
              ${categoryLabel}
            </span>
          </div>
          <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;line-height:1.3;">
            ${subject}
          </h1>
        </div>
        <div style="padding:24px 28px;">
          <div style="font-size:13px;color:#a1a1aa;margin-bottom:16px;">
            Hello <strong>${recipientName}</strong>,
          </div>
          <div style="background:#0c0c0e;border:1px solid #27272a;border-radius:12px;padding:18px;margin-bottom:18px;">
            ${formattedHtmlContent}
          </div>
          <div style="background:#18181b;border:1px solid #27272a;border-radius:8px;padding:12px 14px;font-size:11px;color:#71717a;">
            🔒 This official communication was sent by the DocQevrilo Platform Administrator. For inquiries, sign in to your dashboard.
          </div>
        </div>
        <div style="padding:14px 28px;background:#0d0d10;border-top:1px solid #222226;text-align:center;font-size:11px;color:#52525b;">
          DocQevrilo · End-to-End Cryptographic Document Exchange
        </div>
      </div>
    </div>
  `;

  return await sendEmail({
    to,
    subject: `[DocQevrilo] ${subject}`,
    text: `[${categoryLabel}]\n\nHello ${recipientName},\n\n${message}\n\n---\nDocQevrilo Platform Administration`,
    html,
  });
}

module.exports = {
  sendResetEmail,
  sendAccessCodeOtpEmail,
  sendVerificationEmail,
  sendPinRecoveryOtpEmail,
  sendAdminCustomEmail,
  isEmailConfigured: () => isBrevoConfigured(),
  isBrevoConfigured,
};
