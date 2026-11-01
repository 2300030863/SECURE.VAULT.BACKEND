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

module.exports = { router, bootstrapAdmin };
