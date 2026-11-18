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

function isResendConfigured() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  return Boolean(
    apiKey &&
    apiKey !== "YOUR_RESEND_API_KEY" &&
    apiKey.startsWith("re_")
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
    const msg = data.message || `Brevo returned status ${response.status}`;
    const brevoErr = new Error(msg);
    brevoErr.code = "BREVO_DELIVERY_ERROR";
    brevoErr.details = data;
    throw brevoErr;
  }

  return { messageId: data.messageId || "sent", provider: "brevo", otpCode };
}

async function sendResendEmail({ to, subject, html, text, otpCode }) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || "DocQevrilo <onboarding@resend.dev>";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: html || `<p>${text || ""}</p>`,
      text: text || undefined,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("[Resend API Error]", data);
    const resendErr = new Error(data.message || `Resend returned status ${response.status}`);
    resendErr.code = "RESEND_DELIVERY_ERROR";
    resendErr.details = data;
    throw resendErr;
  }

  return { messageId: data.id || "sent", provider: "resend", otpCode };
}

async function sendEmail(message) {
  const errors = [];

  // Priority 1: Resend (no IP restrictions, works on cloud hosts)
  if (isResendConfigured()) {
    try {
      return await sendResendEmail(message);
    } catch (e) {
      console.warn("[Email Provider Fail] Resend failed, trying fallback:", e.message);
      errors.push(`Resend: ${e.message}`);
    }
  }

  // Priority 2: Brevo REST API
  if (isBrevoConfigured()) {
    try {
      return await sendBrevoEmail(message);
    } catch (e) {
      console.warn("[Email Provider Fail] Brevo failed:", e.message);
      errors.push(`Brevo: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    const combinedMsg = errors.join(" | ");
    const isBrevoIpBlocked = combinedMsg.includes("authorised_ips");
    const error = new Error(
      isBrevoIpBlocked
        ? "Brevo IP authorization needed: add your server IP in https://app.brevo.com/security/authorised_ips"
        : combinedMsg
    );
    error.code = isBrevoIpBlocked ? "BREVO_IP_BLOCKED" : "DELIVERY_ERROR";
    throw error;
  }

  const error = new Error(
    "No email service is configured. Configure BREVO_API_KEY or RESEND_API_KEY in backend/.env."
  );
  error.code = "EMAIL_NOT_CONFIGURED";
  throw error;
}

/**
 * Sends a password reset email with both a 6-digit OTP code and a 1-click reset link.
 * @param {string} email - Destination email address
 * @param {string} resetUrl - Complete frontend URL with token, email, and otp parameters
 * @param {string} [otpCode] - 6-digit OTP code
 */
async function sendResetEmail(email, resetUrl, otpCode = "") {
  await sendEmail({
    to: email,
    subject: otpCode
      ? `[DocQevrilo] Password Reset Code: ${otpCode} (Valid for 15 mins)`
      : "Reset your DocQevrilo password (Valid for 15 mins)",
    text: [
      "We received a request to reset your DocQevrilo password.",
      "",
      "TIME LIMIT NOTICE: This verification code and link expire in strictly 15 minutes.",
      "",
      otpCode ? `Your 6-Digit OTP Verification Code is: ${otpCode}` : "",
      "",
      `Or click this direct link (automatically pre-fills your OTP code):`,
      resetUrl,
      "",
      "If the button doesn't work, copy and paste the entire link above into your browser.",
      "After 15 minutes, this verification link will expire and you will need to request a new code.",
      "If you did not request this, you can safely ignore this email.",
    ]
      .filter(Boolean)
      .join("\n"),
    html: `
      <div style="background-color:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fafafa;padding:40px 16px;">
        <div style="max-width:580px;margin:0 auto;background:#141418;border:1px solid #27272a;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
          <!-- Top Accent Line -->
          <div style="height:3px;background:linear-gradient(90deg,#dc2626,#ef4444,#dc2626);"></div>

          <!-- Header -->
          <div style="padding:28px 32px 20px;background:#18181b;border-bottom:1px solid #27272a;text-align:center;">
            <div style="display:inline-block;width:48px;height:48px;line-height:48px;border-radius:12px;background:#dc2626;color:#ffffff;font-size:24px;margin-bottom:12px;box-shadow:0 4px 14px rgba(220,38,38,0.4);">
              🛡️
            </div>
            <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">DocQevrilo</h1>
            <p style="margin:4px 0 0;font-size:12px;color:#a1a1aa;letter-spacing:0.5px;">SECURE DIGITAL DOCUMENT WORKSPACE</p>
          </div>

          <!-- Body -->
          <div style="padding:32px 30px;">
            <!-- Time Limit Badge -->
            <div style="text-align:center;margin-bottom:20px;">
              <span style="display:inline-block;padding:6px 16px;border-radius:20px;background:#2e1014;border:1px solid #ef4444;color:#fca5a5;font-size:12px;font-weight:700;letter-spacing:0.5px;">
                ⏱️ TIME LIMIT: STRICTLY 15 MINUTES
              </span>
            </div>

            <h2 style="margin:0 0 12px;font-size:18px;color:#ffffff;font-weight:700;text-align:center;">
              Reset your account password
            </h2>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#d4d4d8;text-align:center;">
              We received a password reset request for <strong>${email}</strong>. Use the 6-digit OTP code below or click the direct verification link to auto-fill your code.
            </p>

            ${
              otpCode
                ? `
            <!-- OTP Box -->
            <div style="text-align:center;margin:24px 0;background:#09090b;padding:22px;border-radius:14px;border:1px solid #3f3f46;box-shadow:inset 0 2px 6px rgba(0,0,0,0.5);">
              <p style="margin:0 0 6px;font-size:11px;color:#a1a1aa;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Your 6-Digit OTP Verification Code</p>
              <div style="font-size:38px;font-weight:800;letter-spacing:10px;color:#ef4444;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
                ${otpCode}
              </div>
              <p style="margin:8px 0 0;font-size:12px;color:#71717a;">Valid for 15 minutes from issue</p>
            </div>
            `
                : ""
            }

            <!-- 1-Click Link Button -->
            <div style="text-align:center;margin:28px 0 20px;">
              <a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;letter-spacing:0.3px;box-shadow:0 4px 16px rgba(220,38,38,0.45);">
                👉 Click to Auto-Fill OTP &amp; Reset Password
              </a>
            </div>

            <!-- Time Sensitive Alert Callout -->
            <div style="background:#1e1a1c;padding:14px 18px;border-radius:10px;border-left:4px solid #ef4444;margin:24px 0;">
              <p style="margin:0;font-size:13px;color:#fecaca;line-height:1.5;">
                ⏱️ <strong>Time-Sensitive Security Expiration:</strong> Both the 6-digit OTP and direct link expire in <strong>15 minutes</strong>. After that time, this verification link will be permanently invalid and a new request will be required.
              </p>
            </div>

            <!-- Copyable Link Container -->
            <div style="margin:24px 0 16px;background:#0c0c0e;border:1px solid #27272a;border-radius:10px;padding:16px;">
              <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#d4d4d8;">
                🔗 Or copy &amp; paste this direct verification link into your browser:
              </p>
              <div style="font-size:12px;color:#f87171;word-break:break-all;background:#18181b;padding:12px;border-radius:6px;border:1px solid #27272a;font-family:monospace;line-height:1.4;">
                ${resetUrl}
              </div>
              <p style="margin:8px 0 0;font-size:11px;color:#a1a1aa;">
                Opening this link automatically pre-fills your email and OTP code.
              </p>
            </div>

            <p style="margin:0;font-size:12px;color:#71717a;line-height:1.5;border-top:1px solid #27272a;padding-top:20px;text-align:center;">
              If you did not request a password reset, you can safely disregard this email. Your account remains fully secure.
            </p>
          </div>

          <!-- Footer -->
          <div style="padding:14px 28px;background:#0d0d10;border-top:1px solid #222226;text-align:center;font-size:11px;color:#52525b;">
            DocQevrilo · Cryptographic Zero-Knowledge Architecture · <a href="https://kommalapatisivesh.me" style="color:#71717a;text-decoration:none;">kommalapatisivesh.me</a>
          </div>
        </div>
      </div>
    `,
    otpCode,
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
    subject: `[DocQevrilo] Security OTP to ${actionLabel}: ${otpCode} (Valid for 10 mins)`,
    text: [
      `Security verification request for DocQevrilo Vault: "${docName}".`,
      "",
      "TIME LIMIT NOTICE: This verification code expires strictly in 10 minutes.",
      "",
      `Your 6-Digit Verification Code is: ${otpCode}`,
      "",
      "Enter this code along with your account password to authorize this action.",
      "This verification code expires in 10 minutes and can only be used once.",
      "If you did not request this verification, please sign into your DocQevrilo account and update your password immediately.",
    ].join("\n"),
    html: `
      <div style="background-color:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fafafa;padding:36px 16px;">
        <div style="max-width:560px;margin:0 auto;background:#141418;border:1px solid #27272a;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
          <div style="height:3px;background:linear-gradient(90deg,#dc2626,#ef4444,#dc2626);"></div>

          <div style="padding:24px 28px 18px;background:#18181b;border-bottom:1px solid #27272a;text-align:center;">
            <div style="display:inline-block;width:44px;height:44px;line-height:44px;border-radius:10px;background:#dc2626;color:#ffffff;font-size:22px;margin-bottom:10px;">
              🛡️
            </div>
            <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">DocQevrilo Vault Security</h1>
            <p style="margin:4px 0 0;font-size:12px;color:#a1a1aa;">Two-Factor Access Code Authorization</p>
          </div>

          <div style="padding:28px 26px;">
            <!-- Time Limit Badge -->
            <div style="text-align:center;margin-bottom:16px;">
              <span style="display:inline-block;padding:5px 14px;border-radius:20px;background:#2e1014;border:1px solid #ef4444;color:#fca5a5;font-size:11px;font-weight:700;letter-spacing:0.5px;">
                ⏱️ TIME LIMIT: STRICTLY 10 MINUTES
              </span>
            </div>

            <h2 style="margin:0 0 10px;font-size:16px;color:#ffffff;font-weight:600;text-align:center;">Authorize: ${actionLabel}</h2>
            <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#d4d4d8;text-align:center;">
              A request was initiated on your DocQevrilo account to ${action === "regenerate" ? "regenerate a new access code for" : "reveal the protected access code for"}: <strong>${docName}</strong>.
            </p>

            <div style="text-align:center;margin:20px 0;background:#09090b;padding:20px;border-radius:12px;border:1px solid #3f3f46;">
              <p style="margin:0 0 6px;font-size:11px;color:#a1a1aa;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Your 6-Digit Verification OTP</p>
              <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#ef4444;font-family:monospace;">
                ${otpCode}
              </div>
              <p style="margin:8px 0 0;font-size:12px;color:#71717a;">Expires in 10 minutes</p>
            </div>

            <div style="background:#1e1a1c;padding:12px 14px;border-radius:8px;border-left:3px solid #ef4444;margin:18px 0;">
              <p style="margin:0;font-size:12px;color:#fecaca;line-height:1.5;">
                ⏱️ <strong>Time Limit Notice:</strong> This security OTP expires strictly in <strong>10 minutes</strong>. Never share this code with anyone.
              </p>
            </div>

            <p style="margin:20px 0 0;font-size:11px;color:#71717a;line-height:1.5;border-top:1px solid #27272a;padding-top:16px;text-align:center;">
              If you did not request this, please sign into your DocQevrilo account and update your credentials immediately.
            </p>
          </div>
        </div>
      </div>
    `,
    otpCode,
  });

  return { messageId: "sent", otpCode };
}

/**
 * Sends a 6-digit OTP verification email for account registration with 1-click link & copyable URL.
 * @param {string} email - Destination email address
 * @param {string} otpCode - 6-digit OTP code
 * @param {string} [verifyUrl] - Complete 1-click registration verification URL with email & otp parameters
 * @param {number} [expiryMinutes=10] - Time limit in minutes
 */
async function sendVerificationEmail(email, otpCode, verifyUrl = "", expiryMinutes = 10) {
  await sendEmail({
    to: email,
    subject: `[DocQevrilo] Verify your email: ${otpCode} (Valid for ${expiryMinutes} mins)`,
    text: [
      "Welcome to DocQevrilo.",
      "",
      `TIME LIMIT NOTICE: This verification code and link expire strictly in ${expiryMinutes} minutes.`,
      "",
      `Your 6-Digit Email Verification Code is: ${otpCode}`,
      "",
      verifyUrl ? `Or click this link to automatically verify your email:\n${verifyUrl}\n` : "",
      verifyUrl ? `If the link doesn't click, copy & paste the URL above into your browser.` : "",
      "",
      `After ${expiryMinutes} minutes, this verification code will expire.`,
      "If you did not create this account, you can safely ignore this email.",
    ]
      .filter(Boolean)
      .join("\n"),
    html: `
      <div style="background-color:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fafafa;padding:40px 16px;">
        <div style="max-width:560px;margin:0 auto;background:#141418;border:1px solid #27272a;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
          <div style="height:3px;background:linear-gradient(90deg,#dc2626,#ef4444,#dc2626);"></div>

          <div style="padding:28px 30px 20px;background:#18181b;border-bottom:1px solid #27272a;text-align:center;">
            <div style="display:inline-block;width:48px;height:48px;line-height:48px;border-radius:12px;background:#dc2626;color:#ffffff;font-size:24px;margin-bottom:12px;box-shadow:0 4px 14px rgba(220,38,38,0.4);">
              🛡️
            </div>
            <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;">Verify your DocQevrilo email</h1>
            <p style="margin:4px 0 0;font-size:12px;color:#a1a1aa;letter-spacing:0.5px;">ACTIVATE YOUR ZERO-KNOWLEDGE VAULT</p>
          </div>

          <div style="padding:32px 28px;">
            <!-- Time Limit Badge -->
            <div style="text-align:center;margin-bottom:20px;">
              <span style="display:inline-block;padding:6px 16px;border-radius:20px;background:#2e1014;border:1px solid #ef4444;color:#fca5a5;font-size:12px;font-weight:700;letter-spacing:0.5px;">
                ⏱️ TIME LIMIT: STRICTLY ${expiryMinutes} MINUTES
              </span>
            </div>

            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#d4d4d8;text-align:center;">
              Please verify your email address <strong>${email}</strong> to activate your DocQevrilo account. Enter the 6-digit OTP code below or click the direct verification button.
            </p>

            <!-- OTP Box -->
            <div style="text-align:center;margin:24px 0;background:#09090b;padding:22px;border-radius:14px;border:1px solid #3f3f46;box-shadow:inset 0 2px 6px rgba(0,0,0,0.5);">
              <p style="margin:0 0 6px;font-size:11px;color:#a1a1aa;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">Your 6-Digit Verification Code</p>
              <div style="font-size:38px;font-weight:800;letter-spacing:10px;color:#ef4444;font-family:monospace;">
                ${otpCode}
              </div>
              <p style="margin:8px 0 0;font-size:12px;color:#71717a;">Expires in ${expiryMinutes} minutes</p>
            </div>

            ${
              verifyUrl
                ? `
            <!-- 1-Click Verification Button -->
            <div style="text-align:center;margin:26px 0 20px;">
              <a href="${verifyUrl}" style="display:inline-block;padding:14px 32px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;letter-spacing:0.3px;box-shadow:0 4px 16px rgba(220,38,38,0.45);">
                👉 Verify Email &amp; Auto-Fill OTP
              </a>
            </div>

            <!-- Copyable Link Container -->
            <div style="margin:22px 0 16px;background:#0c0c0e;border:1px solid #27272a;border-radius:10px;padding:16px;">
              <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#d4d4d8;">
                🔗 Or copy &amp; paste this direct verification link into your browser:
              </p>
              <div style="font-size:12px;color:#f87171;word-break:break-all;background:#18181b;padding:12px;border-radius:6px;border:1px solid #27272a;font-family:monospace;line-height:1.4;">
                ${verifyUrl}
              </div>
              <p style="margin:8px 0 0;font-size:11px;color:#a1a1aa;">
                Opening this link automatically pre-fills your email and OTP code.
              </p>
            </div>
            `
                : ""
            }

            <!-- Time Sensitive Alert Callout -->
            <div style="background:#1e1a1c;padding:14px 16px;border-radius:10px;border-left:4px solid #ef4444;margin:22px 0 16px;">
              <p style="margin:0;font-size:13px;color:#fecaca;line-height:1.5;">
                ⏱️ <strong>Time Limit Notice:</strong> This verification code and link expire strictly in <strong>${expiryMinutes} minutes</strong>. After that time, the code will be invalid.
              </p>
            </div>

            <p style="margin:0;font-size:12px;color:#71717a;line-height:1.5;border-top:1px solid #27272a;padding-top:18px;text-align:center;">
              If you did not initiate this account creation, you can safely disregard this email.
            </p>
          </div>

          <div style="padding:14px 28px;background:#0d0d10;border-top:1px solid #222226;text-align:center;font-size:11px;color:#52525b;">
            DocQevrilo · Cryptographic Zero-Knowledge Architecture
          </div>
        </div>
      </div>
    `,
    otpCode,
  });
  return { messageId: "sent", otpCode };
}

/**
 * Sends a 4-digit Security PIN recovery OTP email with time limit notice & copyable link.
 * @param {string} email - Destination email address
 * @param {string} otpCode - 6-digit OTP code
 * @param {string} [recoveryUrl] - Optional 1-click recovery link
 * @param {number} [expiryMinutes=10] - Time limit in minutes
 */
async function sendPinRecoveryOtpEmail(email, otpCode, recoveryUrl = "", expiryMinutes = 10) {
  await sendEmail({
    to: email,
    subject: `[DocQevrilo] Security PIN recovery code: ${otpCode} (Valid for ${expiryMinutes} mins)`,
    text: [
      "A request was made to replace your DocQevrilo 4-digit Security PIN.",
      "",
      `TIME LIMIT NOTICE: This verification code expires strictly in ${expiryMinutes} minutes.`,
      "",
      `Your verification code is: ${otpCode}`,
      "",
      recoveryUrl ? `Direct recovery link:\n${recoveryUrl}\n` : "",
      `This code expires in ${expiryMinutes} minutes.`,
      "If you did not request this, sign in and secure your account immediately.",
    ]
      .filter(Boolean)
      .join("\n"),
    html: `
      <div style="background-color:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#fafafa;padding:40px 16px;">
        <div style="max-width:540px;margin:0 auto;background:#141418;border:1px solid #27272a;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
          <div style="height:3px;background:linear-gradient(90deg,#dc2626,#ef4444,#dc2626);"></div>

          <div style="padding:26px 28px 18px;background:#18181b;border-bottom:1px solid #27272a;text-align:center;">
            <div style="display:inline-block;width:44px;height:44px;line-height:44px;border-radius:10px;background:#dc2626;color:#ffffff;font-size:22px;margin-bottom:10px;">
              🔐
            </div>
            <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">Security PIN Recovery</h1>
            <p style="margin:4px 0 0;font-size:12px;color:#a1a1aa;">DocQevrilo Vault Protection</p>
          </div>

          <div style="padding:28px 26px;">
            <!-- Time Limit Badge -->
            <div style="text-align:center;margin-bottom:16px;">
              <span style="display:inline-block;padding:5px 14px;border-radius:20px;background:#2e1014;border:1px solid #ef4444;color:#fca5a5;font-size:11px;font-weight:700;letter-spacing:0.5px;">
                ⏱️ TIME LIMIT: STRICTLY ${expiryMinutes} MINUTES
              </span>
            </div>

            <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#d4d4d8;text-align:center;">
              A request was initiated on your DocQevrilo account to reset your 4-digit Security PIN. Use the verification code below:
            </p>

            <div style="text-align:center;margin:20px 0;background:#09090b;padding:20px;border-radius:12px;border:1px solid #3f3f46;">
              <p style="margin:0 0 6px;font-size:11px;color:#a1a1aa;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Your 6-Digit PIN Recovery OTP</p>
              <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#ef4444;font-family:monospace;">
                ${otpCode}
              </div>
              <p style="margin:8px 0 0;font-size:12px;color:#71717a;">Expires in ${expiryMinutes} minutes</p>
            </div>

            ${
              recoveryUrl
                ? `
            <div style="margin:20px 0 16px;background:#0c0c0e;border:1px solid #27272a;border-radius:10px;padding:14px;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#d4d4d8;">
                🔗 Direct PIN Recovery Link:
              </p>
              <div style="font-size:12px;color:#f87171;word-break:break-all;background:#18181b;padding:10px;border-radius:6px;border:1px solid #27272a;font-family:monospace;">
                ${recoveryUrl}
              </div>
            </div>
            `
                : ""
            }

            <div style="background:#1e1a1c;padding:12px 14px;border-radius:8px;border-left:3px solid #ef4444;margin:18px 0;">
              <p style="margin:0;font-size:12px;color:#fecaca;line-height:1.5;">
                ⏱️ <strong>Time Limit Notice:</strong> This code expires strictly in <strong>${expiryMinutes} minutes</strong>. Never share this recovery code.
              </p>
            </div>

            <p style="margin:20px 0 0;font-size:11px;color:#71717a;line-height:1.5;border-top:1px solid #27272a;padding-top:16px;text-align:center;">
              If you did not request this recovery, please sign in and change your password immediately.
            </p>
          </div>
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
  isEmailConfigured: () => isBrevoConfigured() || isResendConfigured(),
  isBrevoConfigured,
  isResendConfigured,
};
