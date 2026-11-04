const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const {
  getDbStatus,
  findUserById,
  findUserByEmail,
  getAllUsersAdmin,
  updateUserStatus,
  updateUserRole,
  updateUserPassword,
  markUserEmailVerified,
  deleteUser,
  getAllDocumentsAdmin,
  forceDeleteDocument,
  findDocumentById,
  getAdminOverview,
  recordAuditLog,
  getAuditLogs,
  clearAuditLogs,
} = require("./db");
const { deleteFromB2, isB2Configured, testB2Connection } = require("./b2");
const { sendAdminCustomEmail, isEmailConfigured } = require("./mailer");

const router = express.Router();
const rawJwtSecret = process.env.JWT_SECRET;
if (!rawJwtSecret || rawJwtSecret.length < 32) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[Admin Security Fatal] JWT_SECRET must be configured with at least 32 characters in production.");
  }
  console.warn("[Admin Security Warning] Set a unique JWT_SECRET (32+ characters) before deployment.");
}
const JWT_SECRET = rawJwtSecret || "default_jwt_secret_dev_32characters_min!";
const UPLOADS_DIR = path.join(__dirname, "uploads");

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin login attempts from this IP. Try again in 15 minutes." },
});

function signAdminToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: "admin", tokenType: "admin" },
    JWT_SECRET,
    { expiresIn: "8h", issuer: "docqevrilo-admin" }
  );
}

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Admin sign-in required." });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, { issuer: "docqevrilo-admin" });
    } catch (_) {
      payload = jwt.verify(token, JWT_SECRET);
    }

    if (!payload || !payload.id) {
      return res.status(403).json({ error: "Admin access required." });
    }

    const admin = await findUserById(payload.id);
    if (!admin || admin.role !== "admin" || admin.status !== "active") {
      return res.status(403).json({ error: "Admin access is not available for this account." });
    }
    req.admin = admin;
    next();
  } catch (_) {
    return res.status(401).json({ error: "Admin session expired. Please sign in again." });
  }
}

// Bootstrap administrator account on server startup (only if explicitly set in environment)
async function bootstrapAdmin() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const name = String(process.env.ADMIN_NAME || "Administrator").trim();

  // If no ADMIN_EMAIL is configured in .env, do not auto-seed any default admin
  if (!email || !password) {
    return;
  }

  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      if (existing.role !== "admin" || existing.status !== "active") {
        await updateUserRole(existing.id, "admin");
        await updateUserStatus(existing.id, "active");
        console.log(`[Admin] Existing account ${email} upgraded to active admin.`);
      }
      return;
    }

    const hash = await bcrypt.hash(password, 12);
    const dbStatus = getDbStatus();

    if (dbStatus.isTiDBConnected) {
      const mysql = require("mysql2/promise");
      const { execute } = require("./db");
      await execute(
        "INSERT INTO users (full_name, email, password_hash, email_verified, role, status) VALUES (?, ?, ?, 1, 'admin', 'active')",
        [name, email, hash]
      );
      console.log(`[Admin] Initial admin account provisioned in TiDB: ${email}`);
    } else {
      // Local development fallback
      const fs = require("fs");
      const LOCAL_USERS_FILE = path.join(__dirname, "local_users.json");
      let users = [];
      try {
        if (fs.existsSync(LOCAL_USERS_FILE)) {
          users = JSON.parse(fs.readFileSync(LOCAL_USERS_FILE, "utf8"));
        }
      } catch (_) {}

      const newAdmin = {
        id: users.length ? Math.max(...users.map((u) => u.id || 0)) + 1 : 1,
        full_name: name,
        email,
        password_hash: hash,
        occupation: "Administrator",
        security_pin_hash: null,
        email_verified: true,
        role: "admin",
        status: "active",
        created_at: new Date().toISOString(),
      };
      users.push(newAdmin);
      fs.writeFileSync(LOCAL_USERS_FILE, JSON.stringify(users, null, 2), "utf8");
      console.log(`[Admin] Initial admin account provisioned in local storage: ${email}`);
    }
  } catch (err) {
    console.error("[Admin Bootstrap Error]", err.message);
  }
}

// ---------------------------------------------------------------------------
// Public Admin Routes
// ---------------------------------------------------------------------------

router.post("/login", adminLoginLimiter, async (req, res) => {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await findUserByEmail(email);
    if (!user || user.role !== "admin" || user.status !== "active") {
      return res.status(401).json({ error: "Invalid admin credentials or account is suspended." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid admin credentials." });
    }

    const token = signAdminToken(user);
    await recordAuditLog(user.id, "admin.login", null, {}, req.ip);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: "admin",
      },
    });
  } catch (err) {
    console.error("[Admin Login Error]", err.message);
    res.status(500).json({ error: "Admin sign-in is temporarily unavailable: " + err.message });
  }
});

// ---------------------------------------------------------------------------
// Protected Admin Routes (Require Valid Admin JWT)
// ---------------------------------------------------------------------------
router.use(requireAdmin);

// Admin Profile
router.get("/me", (req, res) => {
  res.json({
    user: {
      id: req.admin.id,
      name: req.admin.full_name,
      email: req.admin.email,
      role: "admin",
    },
  });
});

// System Overview & Metrics
router.get("/overview", async (_req, res) => {
  try {
    const overview = await getAdminOverview();
    const dbStatus = getDbStatus();
    res.json({
      ...overview,
      system: {
        databaseMode: dbStatus.dbMode,
        isTiDBConnected: dbStatus.isTiDBConnected,
        isB2Configured: isB2Configured(),
        serverUptime: Math.floor(process.uptime()),
      },
    });
  } catch (err) {
    console.error("[Admin Overview Error]", err.message);
    res.status(500).json({ error: "Unable to load admin overview." });
  }
});

// Live System Health & Diagnostics
router.get("/system-status", async (_req, res) => {
  try {
    const dbStatus = getDbStatus();
    let b2Status = { connected: false, configured: false };
    try {
      b2Status = await testB2Connection();
    } catch (_) {}

    const mem = process.memoryUsage();
    res.json({
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      database: dbStatus,
      storage: b2Status,
      environment: process.env.NODE_ENV || "development",
    });
  } catch (err) {
    console.error("[Admin Health Error]", err.message);
    res.status(500).json({ error: "Unable to load system status." });
  }
});

// List Users with Filters and Search
router.get("/users", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().slice(0, 100);
    const status = ["active", "suspended"].includes(req.query.status) ? req.query.status : null;
    const role = ["user", "admin"].includes(req.query.role) ? req.query.role : null;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

    const users = await getAllUsersAdmin({ search, status, role, limit, offset });
    res.json({ users });
  } catch (err) {
    console.error("[Admin Users Error]", err.message);
    res.status(500).json({ error: "Unable to load users." });
  }
});

// Update User Account Status (Suspend / Activate)
router.patch("/users/:id/status", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const status = req.body.status;
  if (!Number.isSafeInteger(id) || id < 1 || !["active", "suspended"].includes(status)) {
    return res.status(400).json({ error: "Invalid user ID or status." });
  }
  if (id === Number(req.admin.id)) {
    return res.status(400).json({ error: "You cannot change your own account status." });
  }

  try {
    const target = await findUserById(id);
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.role === "admin") {
      return res.status(403).json({ error: "Administrator account status cannot be modified here." });
    }

    await updateUserStatus(id, status);
    await recordAuditLog(req.admin.id, `user.${status}`, id, { email: target.email }, req.ip);

    res.json({
      success: true,
      status,
      message: `User ${target.email} has been ${status === "active" ? "activated" : "suspended"}.`,
    });
  } catch (err) {
    console.error("[Admin Update User Status Error]", err.message);
    res.status(500).json({ error: "Unable to update user status." });
  }
});

// Change User Role (Promote to Admin / Demote to User)
router.patch("/users/:id/role", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const role = req.body.role;
  if (!Number.isSafeInteger(id) || id < 1 || !["user", "admin"].includes(role)) {
    return res.status(400).json({ error: "Invalid user ID or role." });
  }
  if (id === Number(req.admin.id) && role !== "admin") {
    return res.status(400).json({ error: "You cannot revoke your own administrator privileges." });
  }

  try {
    const target = await findUserById(id);
    if (!target) return res.status(404).json({ error: "User not found." });

    await updateUserRole(id, role);
    await recordAuditLog(req.admin.id, `user.role_${role}`, id, { email: target.email, role }, req.ip);

    res.json({
      success: true,
      role,
      message: `User ${target.email} role updated to ${role}.`,
    });
  } catch (err) {
    console.error("[Admin Update Role Error]", err.message);
    res.status(500).json({ error: "Unable to update user role." });
  }
});

// Manually Mark User Email as Verified
router.patch("/users/:id/verify", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid user ID." });
  }

  try {
    const target = await findUserById(id);
    if (!target) return res.status(404).json({ error: "User not found." });

    await markUserEmailVerified(id);
    await recordAuditLog(req.admin.id, "user.verify_email", id, { email: target.email }, req.ip);

    res.json({
      success: true,
      message: `Email for ${target.email} marked as verified.`,
    });
  } catch (err) {
    console.error("[Admin Verify Email Error]", err.message);
    res.status(500).json({ error: "Unable to verify user email." });
  }
});

// Admin Reset User Password
router.post("/users/:id/reset-password", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid user ID." });
  }

  try {
    const target = await findUserById(id);
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.role === "admin" && Number(id) !== Number(req.admin.id)) {
      return res.status(403).json({ error: "Cannot reset password of another administrator." });
    }

    const tempPassword =
      typeof req.body.password === "string" && req.body.password.length >= 8
        ? req.body.password
        : `DocQ@${crypto.randomBytes(4).toString("hex").toUpperCase()}!`;

    const hash = await bcrypt.hash(tempPassword, 12);
    await updateUserPassword(id, hash);
    await recordAuditLog(req.admin.id, "user.reset_password", id, { targetEmail: target.email }, req.ip);

    res.json({
      success: true,
      message: `Password for ${target.email} has been reset.`,
      tempPassword,
    });
  } catch (err) {
    console.error("[Admin Reset Password Error]", err.message);
    res.status(500).json({ error: "Unable to reset user password." });
  }
});

// Delete User Account
router.delete("/users/:id", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid user ID." });
  }
  if (id === Number(req.admin.id)) {
    return res.status(400).json({ error: "You cannot delete your own administrator account." });
  }

  try {
    const target = await findUserById(id);
    if (!target) return res.status(404).json({ error: "User not found." });

    await deleteUser(id);
    await recordAuditLog(req.admin.id, "user.delete", id, { email: target.email }, req.ip);

    res.json({
      success: true,
      message: `User ${target.email} and all associated documents deleted successfully.`,
    });
  } catch (err) {
    console.error("[Admin Delete User Error]", err.message);
    res.status(500).json({ error: "Unable to delete user." });
  }
});

// List Documents for Admin Inspection
router.get("/documents", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().slice(0, 100);
    const storageMode = ["online", "temporary"].includes(req.query.storage_mode)
      ? req.query.storage_mode
      : null;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);

    const documents = await getAllDocumentsAdmin({ search, storage_mode: storageMode, limit });
    res.json({ documents });
  } catch (err) {
    console.error("[Admin Documents Error]", err.message);
    res.status(500).json({ error: "Unable to load document records." });
  }
});

// Force Delete a Document (Admin Deletion from Database and Storage)
router.delete("/documents/:id", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid document ID." });
  }

  try {
    const doc = await findDocumentById(id);
    if (!doc) return res.status(404).json({ error: "Document not found." });

    // 1. Delete from Backblaze B2 if configured
    if (isB2Configured() && doc.storage_key) {
      try {
        await deleteFromB2({ key: doc.storage_key });
      } catch (b2Err) {
        console.warn(`[Admin Delete B2 Warning] ${doc.storage_key}:`, b2Err.message);
      }
    }

    // 2. Delete local upload file if exists
    if (doc.storage_key) {
      const filePath = path.join(UPLOADS_DIR, doc.storage_key);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (_) {}
      }
    }

    // 3. Delete from Database
    await forceDeleteDocument(id);
    await recordAuditLog(
      req.admin.id,
      "document.delete",
      doc.owner_id || null,
      { documentId: id, name: doc.original_name },
      req.ip
    );

    res.json({
      success: true,
      message: `Document "${doc.original_name}" has been permanently deleted.`,
    });
  } catch (err) {
    console.error("[Admin Delete Document Error]", err.message);
    res.status(500).json({ error: "Unable to delete document." });
  }
});

// Manually Trigger Purge of Expired / Temporary Documents
router.post("/documents/purge-expired", async (req, res) => {
  try {
    let count = 0;
    const purgeFn = req.app.get("purgeExpiredDocuments");
    if (typeof purgeFn === "function") {
      count = await purgeFn();
    }
    await recordAuditLog(req.admin.id, "documents.purge_expired", null, { purgedCount: count }, req.ip);

    res.json({
      success: true,
      purgedCount: count,
      message: `Auto-purge completed: ${count} expired document(s) removed.`,
    });
  } catch (err) {
    console.error("[Admin Purge Expired Error]", err.message);
    res.status(500).json({ error: "Unable to purge expired documents." });
  }
});

// List Audit Logs
router.get("/audit-logs", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const logs = await getAuditLogs(limit);
    res.json({ logs });
  } catch (err) {
    console.error("[Admin Audit Logs Error]", err.message);
    res.status(500).json({ error: "Unable to load audit logs." });
  }
});

// Clear Audit History
router.delete("/audit-logs", async (req, res) => {
  try {
    await clearAuditLogs();
    await recordAuditLog(req.admin.id, "audit.cleared", null, {}, req.ip);
    res.json({ success: true, message: "Audit logs have been reset." });
  } catch (err) {
    console.error("[Admin Clear Audit Error]", err.message);
    res.status(500).json({ error: "Unable to clear audit logs." });
  }
});

// Export Audit Logs (CSV / JSON)
router.get("/audit-logs/export", async (req, res) => {
  try {
    const logs = await getAuditLogs(1000);
    const format = req.query.format === "json" ? "json" : "csv";

    if (format === "json") {
      res.setHeader("Content-Disposition", 'attachment; filename="docqevrilo-audit-logs.json"');
      res.setHeader("Content-Type", "application/json");
      return res.send(JSON.stringify(logs, null, 2));
    }

    // CSV format
    const headers = ["ID", "Admin ID", "Action", "Target User ID", "IP Address", "Details", "Timestamp"];
    const rows = logs.map((l) => [
      l.id,
      l.admin_id,
      `"${(l.action || "").replace(/"/g, '""')}"`,
      l.target_user_id || "",
      l.ip_address || "",
      `"${JSON.stringify(l.details || {}).replace(/"/g, '""')}"`,
      `"${l.created_at || ""}"`,
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    res.setHeader("Content-Disposition", 'attachment; filename="docqevrilo-audit-logs.csv"');
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.send(csvContent);
  } catch (err) {
    console.error("[Admin Export Audit Error]", err.message);
    res.status(500).json({ error: "Unable to export audit logs." });
  }
});

// ---------------------------------------------------------------------------
// Email Communication & Broadcast Routes
// ---------------------------------------------------------------------------

function getAiConfig(customApiKey) {
  const customKey = (customApiKey || "").trim();
  const groqKey = (process.env.GROQ_API_KEY || "").trim();
  const xaiKey = (process.env.XAI_API_KEY || process.env.GROK_API_KEY || process.env.GROK_KEY || "").trim();

  const keyToUse = customKey || groqKey || xaiKey;
  if (!keyToUse) return null;

  // If key starts with gsk_ or GROQ_API_KEY is configured, route to Groq Cloud endpoint
  const isGroq = keyToUse.startsWith("gsk_") || Boolean(groqKey && !customKey && !xaiKey);

  if (isGroq) {
    return {
      provider: "groq",
      name: "Groq AI",
      apiKey: keyToUse,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      models: Array.from(new Set([
        process.env.GROQ_MODEL,
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
        "qwen/qwen3.8-27b",
        "mixtral-8x7b-32768",
        "gemma2-9b-it",
      ].filter(Boolean))),
      supportJsonFormat: true,
    };
  }

  return {
    provider: "xai",
    name: "xAI Grok",
    apiKey: keyToUse,
    endpoint: "https://api.x.ai/v1/chat/completions",
    models: ["grok-2-latest", "grok-beta"],
    supportJsonFormat: false,
  };
}

// Check Email API Configuration Status
router.get("/email/status", async (_req, res) => {
  try {
    const configured = isEmailConfigured();
    const aiConfig = getAiConfig();
    res.json({
      configured,
      grokConfigured: Boolean(aiConfig),
      provider: "Brevo Transactional API",
      aiProvider: aiConfig?.name || "Groq AI",
      senderEmail: process.env.BREVO_SENDER_EMAIL || null,
      senderName: process.env.BREVO_SENDER_NAME || "DocQevrilo",
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to read email status." });
  }
});

// Generate Email with Groq AI
router.post("/email/generate-ai", async (req, res) => {
  try {
    const {
      prompt,
      tone = "announcement",
      targetAudience = "All users",
      customApiKey
    } = req.body;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        error: "Please enter an email instruction."
      });
    }

    const aiConfig = getAiConfig(customApiKey);

    if (!aiConfig) {
      return res.status(400).json({
        error: "GROQ_API_KEY is missing from backend environment.",
        needsKey: true
      });
    }

    const validTones = [
      "announcement",
      "security",
      "maintenance",
      "urgent"
    ];

    const selectedTone = validTones.includes(
      String(tone).toLowerCase()
    ) ? String(tone).toLowerCase() : "announcement";

    const cleanPrompt = String(prompt).trim().slice(0, 3000);

    const systemPrompt = `
You are DocQevrilo's professional email communication AI.

Your job is to transform short instructions into complete,
high-quality, professional administrative emails.

IMPORTANT RULES:

1. NEVER copy the user's instruction directly into the email.
2. Understand what the user wants to communicate.
3. Expand short instructions into complete, meaningful
   and natural email content.
4. A short instruction must produce a complete email,
   not a one-line message.
5. Generate an appropriate professional subject.
6. Start with a suitable greeting.
7. Include a meaningful introduction.
8. Explain the intended message clearly.
9. Include a professional closing and DocQevrilo team signature.
10. Use paragraphs with proper spacing.
11. Adapt the writing style to the selected category.
12. Do not invent features, dates, security incidents,
    maintenance schedules or completed activities.
13. If information is missing, use neutral wording
    instead of making assumptions.
14. Never include the instruction itself as a sentence
    unless it is genuinely intended as quoted content.

EMAIL CATEGORY STYLES:

ANNOUNCEMENT:
Friendly, welcoming, informative and professional.

SECURITY:
Serious, clear, security-focused and trustworthy.
Never invent security incidents.

MAINTENANCE:
Informative and transparent.
Never invent maintenance dates or downtime.

URGENT:
Direct, concise and action-oriented.
Never invent emergencies.

DOCQEVRILO BRAND:
DocQevrilo is a secure document storage and sharing platform.

OUTPUT REQUIREMENTS:

Return ONLY valid JSON.
No Markdown.
No explanations.
No code fences.

Required JSON structure:

{
  "subject": "Professional email subject",
  "message": "Complete email body with paragraphs",
  "category": "${selectedTone}"
}
`;

    const userPrompt = `
Create a complete professional email using these details.

USER'S INTENTION:
${cleanPrompt}

EMAIL CATEGORY:
${selectedTone}

TARGET AUDIENCE:
${String(targetAudience).slice(0, 100)}

Remember:
Interpret the intention and write a complete email.
Do not simply repeat the instruction.
`;

    let generatedContent = null;
    let successfulModel = null;
    let lastError = null;

    for (const model of aiConfig.models) {
      try {
        const requestBody = {
          model,
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: userPrompt
            }
          ],
          temperature: 0.65,
          max_tokens: 1200
        };

        if (
          aiConfig.supportJsonFormat &&
          (model.includes("llama-3") || model.includes("gpt") || model.includes("qwen"))
        ) {
          requestBody.response_format = {
            type: "json_object"
          };
        }

        const response = await fetch(aiConfig.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${aiConfig.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(requestBody)
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          lastError =
            data.error?.message ||
            `AI provider returned HTTP ${response.status}`;

          console.warn(`[Email AI] ${model}: ${lastError}`);
          continue;
        }

        const content =
          data.choices?.[0]?.message?.content?.trim();

        if (content) {
          generatedContent = content;
          successfulModel = model;
          break;
        }

      } catch (error) {
        lastError = error.message;
        console.warn(`[Email AI] ${model}:`, error.message);
      }
    }

    // Never pretend that an offline fallback is AI-generated content.
    if (!generatedContent) {
      return res.status(502).json({
        success: false,
        error: "AI email generation failed. Please check your Groq API key and model availability.",
        details: lastError
      });
    }

    let parsed;

    try {
      let cleaned = generatedContent
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");

      if (start !== -1 && end > start) {
        cleaned = cleaned.slice(start, end + 1);
      }

      parsed = JSON.parse(cleaned);

    } catch (error) {
      console.warn("[Email AI JSON Strict Error]", error.message);

      // Resilient regex extractor if unescaped quotes or line breaks were in JSON
      const subjectMatch = generatedContent.match(/"subject"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
      const messageMatch =
        generatedContent.match(/"message"\s*:\s*"([\s\S]*?)"\s*,\s*"category"/i) ||
        generatedContent.match(/"message"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
      const categoryMatch = generatedContent.match(/"category"\s*:\s*"([^"\\]*)"/i);

      if (subjectMatch && messageMatch) {
        parsed = {
          subject: subjectMatch[1].replace(/\\"/g, '"'),
          message: messageMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
          category: categoryMatch ? categoryMatch[1] : selectedTone
        };
      } else {
        return res.status(502).json({
          success: false,
          error: "AI returned an invalid email format. Please try again."
        });
      }
    }

    const subject = String(parsed.subject || parsed.title || "").trim();
    const message = String(
      parsed.message || parsed.body || parsed.content || ""
    ).trim();

    if (!subject || !message || message.length < 80) {
      return res.status(502).json({
        success: false,
        error: "AI generated incomplete email content. Please try again."
      });
    }

    // Prevent the exact instruction from being returned as the email.
    if (message.toLowerCase() === cleanPrompt.toLowerCase()) {
      return res.status(502).json({
        success: false,
        error: "AI repeated the instruction instead of generating an email."
      });
    }

    const finalCategory = validTones.includes(parsed.category)
      ? parsed.category
      : selectedTone;

    try {
      await recordAuditLog(
        req.admin?.id || 1,
        "email.ai_generate",
        null,
        {
          prompt: cleanPrompt.slice(0, 100),
          model: successfulModel,
          category: finalCategory
        },
        req.ip
      );
    } catch (error) {
      console.warn("[Email AI Audit]", error.message);
    }

    return res.json({
      success: true,
      subject,
      message,
      category: finalCategory,
      model: successfulModel,
      provider: aiConfig.name
    });

  } catch (error) {
    console.error("[Email AI Error]", error.message);

    return res.status(500).json({
      success: false,
      error: "Failed to generate email. Please try again."
    });
  }
});

// Dispatch Test Email to Administrator
router.post("/email/test", async (req, res) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(400).json({
        error: "Brevo email service is not configured. Configure BREVO_API_KEY & BREVO_SENDER_EMAIL in backend environment.",
      });
    }

    const subject = req.body.subject || "Admin Test Notification";
    const message = req.body.message || "This is a test notification confirming that the DocQevrilo Brevo email engine is operating successfully.";
    const category = req.body.category || "announcement";

    const adminEmail = req.admin?.email || process.env.ADMIN_EMAIL || process.env.BREVO_SENDER_EMAIL;
    if (!adminEmail) {
      return res.status(400).json({ error: "No administrator recipient email available to receive test email." });
    }

    await sendAdminCustomEmail(adminEmail, subject, message, {
      category,
      recipientName: req.admin?.full_name || req.admin?.email?.split("@")[0] || "Administrator",
    });

    await recordAuditLog(req.admin?.id || 1, "email.test", null, { recipient: adminEmail }, req.ip);

    res.json({
      success: true,
      message: `Test email successfully dispatched to ${adminEmail}.`,
    });
  } catch (err) {
    console.error("[Admin Test Email Error]", err.message);
    const isIpBlocked =
      /unauthorized ip/i.test(err.message) ||
      /ip.*not.*authorized/i.test(err.message) ||
      (err.details && /ip/i.test(JSON.stringify(err.details)));

    const errorMessage = isIpBlocked
      ? "Brevo IP authorization needed: add your server IP in https://app.brevo.com/security/authorised_ips"
      : (err.message || "Failed to dispatch test email.");

    res.status(400).json({ error: errorMessage });
  }
});

// Send Email to Selected User(s) or All Users
router.post("/email/send", async (req, res) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(400).json({
        error: "Brevo email service is not configured. Configure BREVO_API_KEY & BREVO_SENDER_EMAIL in backend environment.",
      });
    }

    const {
      recipientType = "all",
      userIds,
      selectedUserId,
      userId,
      subject,
      message,
      category = "announcement",
    } = req.body;

    if (!subject || !subject.trim()) {
      return res.status(400).json({ error: "Email subject is required." });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Email message content is required." });
    }

    let targetUsers = [];

    if (recipientType === "selected") {
      const candidateIds = [];
      if (Array.isArray(userIds)) candidateIds.push(...userIds);
      if (selectedUserId) candidateIds.push(selectedUserId);
      if (userId) candidateIds.push(userId);

      const normalizedIds = Array.from(new Set(candidateIds.map((id) => String(id).trim()))).filter(Boolean);

      if (normalizedIds.length === 0) {
        return res.status(400).json({ error: "Please select at least one recipient user." });
      }

      const allUsers = await getAllUsersAdmin({ limit: 1000 });
      const idSet = new Set(normalizedIds);
      targetUsers = allUsers.filter((u) => idSet.has(String(u.id)));
    } else if (recipientType === "active") {
      targetUsers = await getAllUsersAdmin({ status: "active", limit: 1000 });
    } else if (recipientType === "suspended") {
      targetUsers = await getAllUsersAdmin({ status: "suspended", limit: 1000 });
    } else {
      targetUsers = await getAllUsersAdmin({ limit: 1000 });
    }

    const validRecipients = targetUsers.filter((u) => u.email && u.email.includes("@"));

    if (validRecipients.length === 0) {
      return res.status(400).json({ error: "No valid user email addresses found for the selected criteria." });
    }

    let sentCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const user of validRecipients) {
      try {
        await sendAdminCustomEmail(user.email, subject.trim(), message.trim(), {
          category,
          recipientName: user.full_name || user.email.split("@")[0] || "Valued User",
        });
        sentCount++;
      } catch (err) {
        failedCount++;
        const isIpBlocked =
          /unauthorized ip/i.test(err.message) ||
          /ip.*not.*authorized/i.test(err.message) ||
          (err.details && /ip/i.test(JSON.stringify(err.details)));

        const errDetail = isIpBlocked
          ? "Brevo IP authorization needed: add your server IP in https://app.brevo.com/security/authorised_ips"
          : err.message;

        errors.push({ email: user.email, error: errDetail });
      }
    }

    await recordAuditLog(
      req.admin?.id || 1,
      "email.broadcast",
      null,
      { recipientType, total: validRecipients.length, sentCount, failedCount, subject: subject.trim() },
      req.ip
    );

    if (sentCount === 0 && failedCount > 0) {
      return res.status(400).json({
        error: errors[0]?.error || "Failed to deliver emails via Brevo.",
        failedCount,
        errors: errors.slice(0, 5),
      });
    }

    res.json({
      success: true,
      totalRecipients: validRecipients.length,
      sentCount,
      failedCount,
      errors: errors.slice(0, 5),
      message: `Email successfully delivered to ${sentCount} user(s)${failedCount > 0 ? ` (${failedCount} failed)` : ""}.`,
    });
  } catch (err) {
    console.error("[Admin Send Email Error]", err.message);
    res.status(500).json({ error: err.message || "Failed to dispatch emails." });
  }
});

// ---------------------------------------------------------------------------
// Platform Announcement Banner Routes
// ---------------------------------------------------------------------------
let platformAnnouncement = {
  active: false,
  message: "",
  type: "info", // "info" | "warning" | "success" | "urgent"
  updatedAt: new Date().toISOString(),
  updatedBy: "Admin",
};

router.get("/announcement", (_req, res) => {
  res.json({
    success: true,
    active: platformAnnouncement.active,
    message: platformAnnouncement.message,
    type: platformAnnouncement.type,
    announcement: platformAnnouncement,
  });
});

router.post("/announcement", async (req, res) => {
  const { active, message, type } = req.body;
  platformAnnouncement = {
    active: Boolean(active),
    message: String(message || "").trim().slice(0, 300),
    type: ["info", "warning", "critical", "urgent"].includes(type) ? type : "info",
    updatedAt: new Date().toISOString(),
    updatedBy: req.admin?.email || "Admin",
  };

  await recordAuditLog(
    req.admin?.id || 1,
    "announcement.update",
    null,
    { active: platformAnnouncement.active, type: platformAnnouncement.type },
    req.ip
  );

  res.json({
    success: true,
    active: platformAnnouncement.active,
    message: platformAnnouncement.message,
    type: platformAnnouncement.type,
    announcement: platformAnnouncement,
  });
});

// ---------------------------------------------------------------------------
// Live System Latency Diagnostics Ping
// ---------------------------------------------------------------------------
router.get("/diagnostics/ping", async (_req, res) => {
  const result = {
    database: { connected: false, latencyMs: 0 },
    storage: { connected: false, latencyMs: 0 },
    email: { configured: isEmailConfigured(), provider: "Brevo API" },
  };

  const dbStart = Date.now();
  try {
    const dbStatus = getDbStatus();
    result.database.connected = dbStatus.isTiDBConnected;
    result.database.mode = dbStatus.dbMode;
    result.database.latencyMs = Date.now() - dbStart;
  } catch (_) {
    result.database.latencyMs = Date.now() - dbStart;
  }

  const b2Start = Date.now();
  try {
    const b2 = await testB2Connection();
    result.storage.connected = b2.connected;
    result.storage.latencyMs = Date.now() - b2Start;
  } catch (_) {
    result.storage.latencyMs = Date.now() - b2Start;
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// Web Application Firewall (WAF) Admin Telemetry & Management
// ---------------------------------------------------------------------------
const { getFirewallMetrics, unbanIp, manualBanIp } = require("./firewall");

router.get("/firewall", (_req, res) => {
  try {
    const metrics = getFirewallMetrics();
    res.json({
      success: true,
      firewall: metrics,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve firewall telemetry." });
  }
});

router.post("/firewall/unban", async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ error: "IP address is required." });
    }
    const unbanned = unbanIp(ip);
    await recordAuditLog(
      req.admin.id,
      "FIREWALL_IP_UNBANNED",
      null,
      { ip, unbanned },
      req.ip
    );
    res.json({ success: true, message: `IP ${ip} was removed from firewall jail.`, unbanned });
  } catch (error) {
    res.status(500).json({ error: "Failed to unban IP." });
  }
});

router.post("/firewall/ban", async (req, res) => {
  try {
    const { ip, reason, durationMinutes } = req.body;
    if (!ip) {
      return res.status(400).json({ error: "IP address is required." });
    }
    const incidentId = manualBanIp(ip, reason || "Manual administrative ban", Number(durationMinutes) || 60);
    await recordAuditLog(
      req.admin.id,
      "FIREWALL_IP_BANNED",
      null,
      { ip, reason, durationMinutes, incidentId },
      req.ip
    );
    res.json({ success: true, message: `IP ${ip} has been jailed.`, incidentId });
  } catch (error) {
    res.status(500).json({ error: "Failed to ban IP." });
  }
});

module.exports = {
  router,
  bootstrapAdmin,
  getPlatformAnnouncement: () => platformAnnouncement,
};
