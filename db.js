const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

let pool = null;
let isTiDBConnected = false;
let dbMode = "uninitialized";

// Local storage fallback paths (strictly for local development / testing)
const LOCAL_DB_FILE = path.join(__dirname, "local_documents.json");
const LOCAL_USERS_FILE = path.join(__dirname, "local_users.json");

// ---------------------------------------------------------------------------
// Local JSON Fallback Helpers (Development Only)
// ---------------------------------------------------------------------------
function loadLocalDocs() {
  try {
    if (fs.existsSync(LOCAL_DB_FILE)) {
      const data = fs.readFileSync(LOCAL_DB_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("[Local DB Fallback] Error reading documents file:", err.message);
  }
  return [];
}

function saveLocalDocs(docs) {
  try {
    fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(docs, null, 2), "utf8");
  } catch (err) {
    console.error("[Local DB Fallback] Error writing documents file:", err.message);
  }
}

function loadLocalUsers() {
  try {
    if (fs.existsSync(LOCAL_USERS_FILE)) {
      const data = fs.readFileSync(LOCAL_USERS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("[Local DB Fallback] Error reading users file:", err.message);
  }
  return [];
}

function saveLocalUsers(users) {
  try {
    fs.writeFileSync(LOCAL_USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (err) {
    console.error("[Local DB Fallback] Error writing users file:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Safe Additive Schema Migration Helpers
// Handles idempotency by inspecting specific MySQL error codes (1060, 1061)
// rather than blindly swallowing real database or network errors.
// ---------------------------------------------------------------------------
async function safeAddColumn(targetPool, tableName, columnName, columnDefinition) {
  try {
    await targetPool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
    console.log(`[TiDB Migration] Added column '${columnName}' to '${tableName}'.`);
    return true;
  } catch (err) {
    // 1060 = ER_DUP_FIELDNAME (column already exists)
    if (err.errno === 1060 || err.code === "ER_DUP_FIELDNAME") {
      return false;
    }
    console.error(`[TiDB Migration Error] Failed adding column '${columnName}' to '${tableName}':`, err.message);
    throw err;
  }
}

async function safeAddIndex(targetPool, tableName, indexName, indexDefinition) {
  try {
    await targetPool.query(`ALTER TABLE ${tableName} ADD INDEX ${indexName} ${indexDefinition};`);
    console.log(`[TiDB Migration] Added index '${indexName}' to '${tableName}'.`);
    return true;
  } catch (err) {
    // 1061 = ER_DUP_KEYNAME (index already exists)
    if (err.errno === 1061 || err.code === "ER_DUP_KEYNAME") {
      return false;
    }
    console.error(`[TiDB Migration Error] Failed adding index '${indexName}' to '${tableName}':`, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Database Initialization
// ---------------------------------------------------------------------------
async function initDatabase() {
  const isProduction = process.env.NODE_ENV === "production";
  const host = process.env.TIDB_HOST;
  const user = process.env.TIDB_USER;
  const password = process.env.TIDB_PASSWORD;
  const database = process.env.TIDB_DATABASE || "test";
  const port = parseInt(process.env.TIDB_PORT || "4000", 10);
  const caCertPath = process.env.TIDB_CA_PATH;

  if (isProduction && (!host || !user || !password)) {
    const errorMsg =
      "[TiDB Fatal] Missing required TiDB credentials (TIDB_HOST, TIDB_USER, TIDB_PASSWORD) in production environment. " +
      "Refusing to fall back to volatile local JSON storage on Render.";
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  if (host && user) {
    try {
      console.log(`[TiDB] Connecting to TiDB Cloud cluster at ${host}:${port} (${database})...`);

      const sslConfig = {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      };

      if (caCertPath && fs.existsSync(caCertPath)) {
        sslConfig.ca = fs.readFileSync(caCertPath);
      }

      pool = mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        ssl: sslConfig,
        waitForConnections: true,
        connectionLimit: parseInt(process.env.TIDB_CONNECTION_LIMIT || "10", 10),
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        connectTimeout: 15000,
      });

      pool.on("error", (err) => {
        console.error("[TiDB Pool Error]", err.message);
      });

      // Verify connection
      const connection = await pool.getConnection();
      console.log(`[TiDB] Successfully connected to TiDB Cloud cluster (${database})!`);
      connection.release();

      // 1. Users Table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          full_name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          occupation VARCHAR(100) NULL,
          security_pin_hash VARCHAR(255) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await safeAddColumn(pool, "users", "occupation", "VARCHAR(100) NULL");
      await safeAddColumn(pool, "users", "security_pin_hash", "VARCHAR(255) NULL");

      // 2. Documents Table (Metadata for Backblaze B2 objects)
      // Plain-text access codes are NEVER stored here; only access_code_hash is used for lookups.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          owner_id BIGINT NULL,
          original_name VARCHAR(255) NOT NULL,
          mime_type VARCHAR(100) DEFAULT 'application/octet-stream',
          storage_key VARCHAR(500) NOT NULL,
          access_code_hash CHAR(64) NOT NULL UNIQUE,
          access_code VARCHAR(50) NULL,
          file_size BIGINT NOT NULL,
          file_count INT NOT NULL DEFAULT 1,
          storage_mode VARCHAR(32) NOT NULL DEFAULT 'online',
          view_count INT DEFAULT 0,
          download_count INT DEFAULT 0,
          max_downloads INT NULL DEFAULT NULL,
          active_downloads INT NOT NULL DEFAULT 0,
          delete_after_download TINYINT(1) NOT NULL DEFAULT 0,
          expires_at DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_owner (owner_id),
          INDEX idx_code_hash (access_code_hash),
          INDEX idx_expires (expires_at),
          INDEX idx_storage_mode (storage_mode)
        );
      `);

      // Additive column migrations for pre-existing tables
      await safeAddColumn(pool, "documents", "owner_id", "BIGINT NULL");
      await safeAddColumn(pool, "documents", "access_code", "VARCHAR(50) NULL");
      await safeAddColumn(pool, "documents", "view_count", "INT DEFAULT 0");
      await safeAddColumn(pool, "documents", "download_count", "INT DEFAULT 0");
      await safeAddColumn(pool, "documents", "file_count", "INT NOT NULL DEFAULT 1");
      await safeAddColumn(pool, "documents", "storage_mode", "VARCHAR(32) NOT NULL DEFAULT 'online'");
      await safeAddColumn(pool, "documents", "max_downloads", "INT NULL DEFAULT NULL");
      await safeAddColumn(pool, "documents", "active_downloads", "INT NOT NULL DEFAULT 0");
      await safeAddColumn(pool, "documents", "delete_after_download", "TINYINT(1) NOT NULL DEFAULT 0");
      await safeAddIndex(pool, "documents", "idx_expires", "(expires_at)");
      await safeAddIndex(pool, "documents", "idx_storage_mode", "(storage_mode)");

      // 3. Password Reset Tokens Table (with attempt tracking & token hash)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          email VARCHAR(255) NULL,
          token_hash CHAR(64) NOT NULL UNIQUE,
          otp_code VARCHAR(10) NULL,
          attempt_count INT NOT NULL DEFAULT 0,
          expires_at DATETIME NOT NULL,
          used_at DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_reset_user (user_id),
          INDEX idx_reset_expiry (expires_at),
          INDEX idx_reset_otp (email, otp_code),
          INDEX idx_reset_token_hash (token_hash)
        );
      `);

      await safeAddColumn(pool, "password_reset_tokens", "otp_code", "VARCHAR(10) NULL");
      await safeAddColumn(pool, "password_reset_tokens", "email", "VARCHAR(255) NULL");
      await safeAddColumn(pool, "password_reset_tokens", "attempt_count", "INT NOT NULL DEFAULT 0");
      await safeAddIndex(pool, "password_reset_tokens", "idx_reset_otp", "(email, otp_code)");
      await safeAddIndex(pool, "password_reset_tokens", "idx_reset_token_hash", "(token_hash)");

      isTiDBConnected = true;
      dbMode = "tidb_cloud";
      console.log("[TiDB] Schema migrations completed and verified.");
      return;
    } catch (err) {
      if (isProduction) {
        console.error("[TiDB Fatal] Connection to TiDB Cloud failed in production mode:", err);
        pool = null;
        isTiDBConnected = false;
        dbMode = "failed";
        throw err;
      }
      console.warn(`[TiDB Warning] Could not connect to TiDB Cloud: ${err.message}`);
      console.warn("[TiDB] Development mode: falling back to local file storage.");
      pool = null;
      isTiDBConnected = false;
      dbMode = "local_fallback";
    }
  } else {
    if (isProduction) {
      throw new Error("[TiDB Fatal] Production mode requires TIDB_HOST and TIDB_USER to be set.");
    }
    console.log("[TiDB] Operating in local development database mode (JSON fallback).");
    isTiDBConnected = false;
    dbMode = "local_dev";
  }

  // Ensure local files exist for development
  if (!fs.existsSync(LOCAL_DB_FILE)) saveLocalDocs([]);
  if (!fs.existsSync(LOCAL_USERS_FILE)) saveLocalUsers([]);
}

// ---------------------------------------------------------------------------
// User Operations
// ---------------------------------------------------------------------------
async function findUserByEmail(email) {
  const normalizedEmail = email.toLowerCase().trim();
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, password_hash, occupation, security_pin_hash, created_at FROM users WHERE LOWER(email) = ? LIMIT 1`,
      [normalizedEmail]
    );
    return rows[0] || null;
  } else {
    const users = loadLocalUsers();
    return users.find((u) => u.email === normalizedEmail) || null;
  }
}

async function findUserById(id) {
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, occupation, (security_pin_hash IS NOT NULL) AS has_security_pin, created_at FROM users WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!rows[0]) return null;
    return {
      ...rows[0],
      has_security_pin: Boolean(rows[0].has_security_pin),
    };
  } else {
    const users = loadLocalUsers();
    const user = users.find((u) => u.id === Number(id));
    if (!user) return null;
    const { password_hash, security_pin_hash, ...safeUser } = user;
    return {
      ...safeUser,
      has_security_pin: Boolean(security_pin_hash),
    };
  }
}

async function findUserWithSecretsById(id) {
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, password_hash, occupation, security_pin_hash, created_at FROM users WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  } else {
    const users = loadLocalUsers();
    return users.find((u) => u.id === Number(id)) || null;
  }
}

async function createUser({ full_name, email, password_hash, occupation = null, security_pin_hash = null }) {
  const normalizedEmail = email.toLowerCase().trim();
  const cleanOccupation = occupation && typeof occupation === "string" ? occupation.trim() : null;
  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, occupation, security_pin_hash) VALUES (?, ?, ?, ?, ?)`,
      [full_name.trim(), normalizedEmail, password_hash, cleanOccupation, security_pin_hash]
    );
    return {
      id: result.insertId,
      full_name: full_name.trim(),
      email: normalizedEmail,
      occupation: cleanOccupation,
      has_security_pin: Boolean(security_pin_hash),
      created_at: new Date().toISOString(),
    };
  } else {
    const users = loadLocalUsers();
    if (users.some((u) => u.email === normalizedEmail)) {
      const err = new Error("Email already registered");
      err.code = "ER_DUP_ENTRY";
      throw err;
    }
    const newUser = {
      id: users.length ? Math.max(...users.map((u) => u.id || 0)) + 1 : 1,
      full_name: full_name.trim(),
      email: normalizedEmail,
      password_hash,
      occupation: cleanOccupation,
      security_pin_hash,
      created_at: new Date().toISOString(),
    };
    users.push(newUser);
    saveLocalUsers(users);
    const { password_hash: _, security_pin_hash: __, ...safeUser } = newUser;
    return {
      ...safeUser,
      has_security_pin: Boolean(security_pin_hash),
    };
  }
}

async function updateUserProfile(id, { full_name, occupation, security_pin_hash }) {
  const updates = [];
  const params = [];
  if (full_name && typeof full_name === "string" && full_name.trim()) {
    updates.push("full_name = ?");
    params.push(full_name.trim());
  }
  if (occupation !== undefined) {
    updates.push("occupation = ?");
    params.push(occupation && typeof occupation === "string" ? occupation.trim() : null);
  }
  if (security_pin_hash) {
    updates.push("security_pin_hash = ?");
    params.push(security_pin_hash);
  }
  if (updates.length > 0) {
    params.push(id);
    if (isTiDBConnected && pool) {
      await pool.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);
    } else {
      let users = loadLocalUsers();
      users = users.map((u) => {
        if (u.id === Number(id)) {
          return {
            ...u,
            ...(full_name ? { full_name: full_name.trim() } : {}),
            ...(occupation !== undefined ? { occupation: occupation ? occupation.trim() : null } : {}),
            ...(security_pin_hash ? { security_pin_hash } : {}),
          };
        }
        return u;
      });
      saveLocalUsers(users);
    }
  }
  return await findUserById(id);
}

// ---------------------------------------------------------------------------
// Document Status Enrichment
// ---------------------------------------------------------------------------
function enrichDocumentStatus(doc, now = new Date()) {
  const isExpired = Boolean(doc.expires_at && new Date(doc.expires_at) <= now);
  const isLimitReached = Boolean(
    doc.max_downloads != null && doc.max_downloads > 0 && (doc.download_count || 0) >= doc.max_downloads
  );
  const isDownloadedAndPendingDelete = Boolean(
    doc.delete_after_download && (doc.download_count || 0) >= 1
  );

  let status = "active";
  if (isExpired) {
    status = "expired";
  } else if (isLimitReached) {
    status = "limit_reached";
  } else if (isDownloadedAndPendingDelete) {
    status = "deleted_after_download";
  }

  return {
    ...doc,
    access_code: doc.access_code || null,
    status,
    is_expired: isExpired,
    is_limit_reached: isLimitReached,
    is_downloaded_and_pending_delete: isDownloadedAndPendingDelete,
  };
}

// ---------------------------------------------------------------------------
// Document Operations
// ---------------------------------------------------------------------------

/**
 * Saves a document's metadata to the database.
 * Notice: Plaintext access codes are not persisted to the database.
 * The access_code column is explicitly set to NULL, and verification is done
 * purely using access_code_hash.
 */
async function saveDocument({
  owner_id = null,
  original_name,
  mime_type,
  storage_key,
  access_code_hash,
  access_code = null, // Ignored for DB persistence to prevent plain-text storage leaks
  file_size,
  expires_at,
  file_count = 1,
  storage_mode = "online",
  max_downloads = null,
  delete_after_download = 0,
}) {
  const normStorageMode = storage_mode || "online";
  const normMaxDownloads = max_downloads && Number(max_downloads) > 0 ? Number(max_downloads) : null;
  const normDeleteAfterDownload = delete_after_download ? 1 : 0;

  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `INSERT INTO documents
        (owner_id, original_name, mime_type, storage_key, access_code_hash, access_code,
         file_size, expires_at, file_count, storage_mode, max_downloads, active_downloads, delete_after_download)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        owner_id,
        original_name,
        mime_type || "application/zip",
        storage_key,
        access_code_hash,
        access_code || null,
        file_size,
        expires_at || null,
        file_count || 1,
        normStorageMode,
        normMaxDownloads,
        normDeleteAfterDownload,
      ]
    );

    return {
      id: result.insertId,
      owner_id,
      original_name,
      mime_type,
      storage_key,
      access_code_hash,
      access_code: access_code || null,
      file_size,
      file_count: file_count || 1,
      storage_mode: normStorageMode,
      max_downloads: normMaxDownloads,
      active_downloads: 0,
      delete_after_download: normDeleteAfterDownload,
      download_count: 0,
      expires_at,
      created_at: new Date().toISOString(),
    };
  } else {
    const docs = loadLocalDocs();
    if (docs.some((d) => d.access_code_hash === access_code_hash)) {
      const err = new Error("Duplicate access code hash");
      err.code = "ER_DUP_ENTRY";
      throw err;
    }
    const newDoc = {
      id: docs.length ? Math.max(...docs.map((d) => d.id || 0)) + 1 : 1,
      owner_id: owner_id ? Number(owner_id) : null,
      original_name,
      mime_type: mime_type || "application/zip",
      storage_key,
      access_code_hash,
      access_code: access_code || null,
      file_size,
      file_count: file_count || 1,
      storage_mode: normStorageMode,
      max_downloads: normMaxDownloads,
      active_downloads: 0,
      delete_after_download: normDeleteAfterDownload,
      download_count: 0,
      view_count: 0,
      expires_at: expires_at ? new Date(expires_at).toISOString() : null,
      created_at: new Date().toISOString(),
    };
    docs.unshift(newDoc);
    saveLocalDocs(docs);
    return newDoc;
  }
}

async function findDocumentByHash(access_code_hash) {
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, owner_id, original_name, mime_type, storage_key, access_code_hash,
              NULL AS access_code, file_size, expires_at, created_at,
              COALESCE(view_count, 0) AS view_count,
              COALESCE(download_count, 0) AS download_count,
              COALESCE(file_count, 1) AS file_count,
              COALESCE(storage_mode, 'online') AS storage_mode,
              max_downloads,
              COALESCE(active_downloads, 0) AS active_downloads,
              COALESCE(delete_after_download, 0) AS delete_after_download
       FROM documents
       WHERE access_code_hash = ?
       LIMIT 1`,
      [access_code_hash]
    );
    return rows[0] ? enrichDocumentStatus(rows[0]) : null;
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.access_code_hash === access_code_hash);
    if (!doc) return null;
    return enrichDocumentStatus({
      ...doc,
      view_count: doc.view_count || 0,
      download_count: doc.download_count || 0,
      file_count: doc.file_count || 1,
      storage_mode: doc.storage_mode || "online",
      max_downloads: doc.max_downloads !== undefined ? doc.max_downloads : null,
      active_downloads: doc.active_downloads || 0,
      delete_after_download: doc.delete_after_download ? 1 : 0,
    });
  }
}

async function findDocumentById(id) {
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, owner_id, original_name, mime_type, storage_key, access_code_hash,
              access_code, file_size, expires_at, created_at,
              COALESCE(view_count, 0) AS view_count,
              COALESCE(download_count, 0) AS download_count,
              COALESCE(file_count, 1) AS file_count,
              COALESCE(storage_mode, 'online') AS storage_mode,
              max_downloads,
              COALESCE(active_downloads, 0) AS active_downloads,
              COALESCE(delete_after_download, 0) AS delete_after_download
       FROM documents
       WHERE id = ?
       LIMIT 1`,
      [id]
    );
    return rows[0] ? enrichDocumentStatus(rows[0]) : null;
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.id === Number(id));
    if (!doc) return null;
    return enrichDocumentStatus({
      ...doc,
      view_count: doc.view_count || 0,
      download_count: doc.download_count || 0,
      file_count: doc.file_count || 1,
      storage_mode: doc.storage_mode || "online",
      max_downloads: doc.max_downloads !== undefined ? doc.max_downloads : null,
      active_downloads: doc.active_downloads || 0,
      delete_after_download: doc.delete_after_download ? 1 : 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Atomic Download Protection & Reservation
// ---------------------------------------------------------------------------

/**
 * Atomically reserves a download slot for document `id`.
 * Validates expiration, active concurrent slots, and max_downloads.
 * Returns true if a slot was successfully reserved; false otherwise.
 */
async function reserveDownload(id) {
  const now = new Date();
  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `UPDATE documents
       SET active_downloads = active_downloads + 1
       WHERE id = ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND (max_downloads IS NULL OR (download_count + active_downloads) < max_downloads)
         AND (delete_after_download = 0 OR download_count = 0)`,
      [id, now]
    );
    return result.affectedRows > 0;
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.id === Number(id));
    if (!doc) return false;
    if (doc.expires_at && new Date(doc.expires_at) <= now) return false;
    const currentActive = doc.active_downloads || 0;
    const currentDownloads = doc.download_count || 0;
    if (
      doc.max_downloads !== null &&
      doc.max_downloads !== undefined &&
      currentDownloads + currentActive >= doc.max_downloads
    ) {
      return false;
    }
    if (doc.delete_after_download && currentDownloads > 0) return false;
    doc.active_downloads = currentActive + 1;
    saveLocalDocs(docs);
    return true;
  }
}

/**
 * Releases an active download slot if a download fails, times out, or is cancelled.
 */
async function releaseDownloadReservation(id) {
  if (!id) return false;
  if (isTiDBConnected && pool) {
    try {
      const [result] = await pool.query(
        `UPDATE documents SET active_downloads = GREATEST(active_downloads - 1, 0) WHERE id = ? AND active_downloads > 0`,
        [id]
      );
      return result.affectedRows > 0;
    } catch (e) {
      console.warn("[TiDB Release Download Reservation Warning]", e.message);
      return false;
    }
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.id === Number(id));
    if (doc && (doc.active_downloads || 0) > 0) {
      doc.active_downloads = Math.max(0, doc.active_downloads - 1);
      saveLocalDocs(docs);
      return true;
    }
    return false;
  }
}

/**
 * Finalizes a successfully completed download.
 * Atomically decrements active_downloads and increments download_count.
 * Throws an explicit error if no active reservation was present to finalize.
 */
async function finalizeDownload(id) {
  if (!id) {
    throw new Error("Document ID is required to finalize download.");
  }

  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `UPDATE documents
       SET download_count = download_count + 1,
           active_downloads = GREATEST(active_downloads - 1, 0)
       WHERE id = ? AND active_downloads > 0`,
      [id]
    );

    if (result.affectedRows === 0) {
      throw new Error(`[Download Finalize Error] No active reservation found to finalize for document ${id}.`);
    }
    return true;
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.id === Number(id));
    if (!doc || (doc.active_downloads || 0) <= 0) {
      throw new Error(`[Download Finalize Error] No active reservation found to finalize for document ${id}.`);
    }
    doc.download_count = (doc.download_count || 0) + 1;
    doc.active_downloads = Math.max(0, doc.active_downloads - 1);
    saveLocalDocs(docs);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Expiration, Cleanup & Backblaze B2 Coordination
//
// DESIGN CONTRACT:
// 1. findCleanableDocuments() identifies eligible documents (active_downloads = 0).
// 2. The worker / caller must delete the physical objects from Backblaze B2 first.
// 3. deleteExpiredDocumentRecords() is called ONLY AFTER B2 deletion succeeds or
//    is reliably queued, avoiding orphaned objects in B2.
// ---------------------------------------------------------------------------

async function findCleanableDocuments() {
  const now = new Date();
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, owner_id, storage_key, original_name, NULL AS access_code, expires_at,
              storage_mode, download_count, max_downloads, delete_after_download
       FROM documents
       WHERE active_downloads = 0
         AND (
           (expires_at IS NOT NULL AND expires_at <= ?)
           OR (max_downloads IS NOT NULL AND max_downloads > 0 AND download_count >= max_downloads)
           OR (delete_after_download = 1 AND download_count >= 1)
         )`,
      [now]
    );
    return rows;
  } else {
    const docs = loadLocalDocs();
    return docs
      .filter((d) => {
        if ((d.active_downloads || 0) > 0) return false;
        const isExpired = d.expires_at && new Date(d.expires_at) <= now;
        const isLimitReached = d.max_downloads != null && d.max_downloads > 0 && (d.download_count || 0) >= d.max_downloads;
        const isDeleteAfter = d.delete_after_download && (d.download_count || 0) >= 1;
        return isExpired || isLimitReached || isDeleteAfter;
      })
      .map((d) => ({
        ...d,
        access_code: null,
      }));
  }
}

async function findExpiredDocuments() {
  return await findCleanableDocuments();
}

async function deleteExpiredDocumentRecords(ids) {
  if (!ids || ids.length === 0) return 0;
  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `DELETE FROM documents WHERE id IN (?) AND active_downloads = 0`,
      [ids]
    );
    return result.affectedRows;
  } else {
    let docs = loadLocalDocs();
    const initialLen = docs.length;
    const idSet = new Set(ids.map(Number));
    docs = docs.filter((d) => !(idSet.has(Number(d.id)) && (d.active_downloads || 0) === 0));
    saveLocalDocs(docs);
    return initialLen - docs.length;
  }
}

// ---------------------------------------------------------------------------
// Document Querying & User Listings
// ---------------------------------------------------------------------------
async function listUserDocuments(owner_id, limit = 50) {
  const now = new Date();
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));

  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, owner_id, original_name, mime_type, access_code, file_size, expires_at, created_at,
              COALESCE(view_count, 0) AS view_count,
              COALESCE(download_count, 0) AS download_count,
              COALESCE(file_count, 1) AS file_count,
              COALESCE(storage_mode, 'online') AS storage_mode,
              max_downloads,
              COALESCE(active_downloads, 0) AS active_downloads,
              COALESCE(delete_after_download, 0) AS delete_after_download
       FROM documents
       WHERE owner_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [owner_id, safeLimit]
    );
    return rows.map((doc) => enrichDocumentStatus(doc, now));
  } else {
    let docs = loadLocalDocs();
    docs = docs.filter((d) => d.owner_id === Number(owner_id));
    return docs.slice(0, safeLimit).map((d) => enrichDocumentStatus(d, now));
  }
}

async function listRecentDocuments(limit = 10, owner_id = null) {
  if (owner_id) {
    return await listUserDocuments(owner_id, limit);
  }
  const now = new Date();
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));

  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, owner_id, original_name, mime_type, NULL AS access_code, file_size, expires_at, created_at,
              COALESCE(view_count, 0) AS view_count,
              COALESCE(download_count, 0) AS download_count,
              COALESCE(file_count, 1) AS file_count,
              COALESCE(storage_mode, 'online') AS storage_mode,
              max_downloads,
              COALESCE(active_downloads, 0) AS active_downloads,
              COALESCE(delete_after_download, 0) AS delete_after_download
       FROM documents
       WHERE (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC
       LIMIT ?`,
      [now, safeLimit]
    );
    return rows.map((d) => enrichDocumentStatus(d, now));
  } else {
    let docs = loadLocalDocs();
    docs = docs.filter((d) => !d.expires_at || new Date(d.expires_at) > now);
    return docs.slice(0, safeLimit).map((d) => enrichDocumentStatus(d, now));
  }
}

async function incrementViewCount(id) {
  if (!id) return;
  if (isTiDBConnected && pool) {
    try {
      await pool.query(
        `UPDATE documents SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?`,
        [id]
      );
    } catch (e) {
      console.warn("[TiDB Increment View Warning]", e.message);
    }
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.id === Number(id));
    if (doc) {
      doc.view_count = (doc.view_count || 0) + 1;
      saveLocalDocs(docs);
    }
  }
}

async function incrementDownloadCount(id) {
  if (!id) return false;
  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `UPDATE documents SET download_count = download_count + 1 WHERE id = ?`,
      [id]
    );
    return result.affectedRows > 0;
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.id === Number(id));
    if (doc) {
      doc.download_count = (doc.download_count || 0) + 1;
      saveLocalDocs(docs);
      return true;
    }
    return false;
  }
}

async function updateDocument(
  id,
  owner_id,
  { original_name, expires_at, file_size, storage_mode, max_downloads, delete_after_download }
) {
  if (isTiDBConnected && pool) {
    const fields = [];
    const params = [];
    if (original_name !== undefined) {
      fields.push("original_name = ?");
      params.push(original_name);
    }
    if (expires_at !== undefined) {
      fields.push("expires_at = ?");
      params.push(expires_at);
    }
    if (file_size !== undefined) {
      fields.push("file_size = ?");
      params.push(file_size);
    }
    if (storage_mode !== undefined) {
      fields.push("storage_mode = ?");
      params.push(storage_mode);
    }
    if (max_downloads !== undefined) {
      fields.push("max_downloads = ?");
      const normMax =
        max_downloads === "unlimited" || max_downloads === "" || max_downloads === null
          ? null
          : Number(max_downloads);
      params.push(normMax);
    }
    if (delete_after_download !== undefined) {
      fields.push("delete_after_download = ?");
      params.push(delete_after_download ? 1 : 0);
    }
    if (fields.length === 0) return await findDocumentById(id);

    params.push(id);
    params.push(owner_id);

    await pool.query(
      `UPDATE documents SET ${fields.join(", ")} WHERE id = ? AND owner_id = ?`,
      params
    );
    return await findDocumentById(id);
  } else {
    const docs = loadLocalDocs();
    const index = docs.findIndex((d) => d.id === Number(id) && d.owner_id === Number(owner_id));
    if (index === -1) return null;
    if (original_name !== undefined) docs[index].original_name = original_name;
    if (expires_at !== undefined) docs[index].expires_at = expires_at ? new Date(expires_at).toISOString() : null;
    if (file_size !== undefined) docs[index].file_size = file_size;
    if (storage_mode !== undefined) docs[index].storage_mode = storage_mode;
    if (max_downloads !== undefined) {
      docs[index].max_downloads =
        max_downloads === "unlimited" || max_downloads === "" || max_downloads === null
          ? null
          : Number(max_downloads);
    }
    if (delete_after_download !== undefined) docs[index].delete_after_download = delete_after_download ? 1 : 0;
    saveLocalDocs(docs);
    return enrichDocumentStatus(docs[index]);
  }
}

async function deleteDocument(id, owner_id) {
  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `DELETE FROM documents WHERE id = ? AND owner_id = ? AND active_downloads = 0`,
      [id, owner_id]
    );
    return result.affectedRows > 0;
  } else {
    let docs = loadLocalDocs();
    const initialLen = docs.length;
    docs = docs.filter(
      (d) => !(d.id === Number(id) && d.owner_id === Number(owner_id) && (d.active_downloads || 0) === 0)
    );
    saveLocalDocs(docs);
    return docs.length < initialLen;
  }
}

function getDbStatus() {
  return {
    isTiDBConnected,
    dbMode,
    host: process.env.TIDB_HOST || null,
    database: process.env.TIDB_DATABASE || null,
  };
}

async function getPool() {
  if (!pool && !isTiDBConnected) {
    await initDatabase();
  }
  return pool;
}

async function execute(...args) {
  const p = await getPool();
  if (p) return p.execute(...args);
  throw new Error("TiDB Cloud database pool is not available");
}

async function query(...args) {
  const p = await getPool();
  if (p) return p.query(...args);
  throw new Error("TiDB Cloud database pool is not available");
}

async function getConnection() {
  const p = await getPool();
  if (p) return p.getConnection();
  throw new Error("TiDB Cloud database pool is not available");
}

async function updateDocumentAccessCode(id, newCode, newHash) {
  if (isTiDBConnected && pool) {
    await pool.query(
      `UPDATE documents SET access_code = ?, access_code_hash = ? WHERE id = ?`,
      [newCode, newHash, id]
    );
  } else {
    let docs = loadLocalDocs();
    docs = docs.map((d) => (Number(d.id) === Number(id) ? { ...d, access_code: newCode, access_code_hash: newHash } : d));
    saveLocalDocs(docs);
  }
}

module.exports = {
  initDatabase,
  getPool,
  execute,
  query,
  getConnection,
  findUserByEmail,
  findUserById,
  findUserWithSecretsById,
  createUser,
  updateUserProfile,
  saveDocument,
  findDocumentByHash,
  findDocumentById,
  updateDocument,
  updateDocumentAccessCode,
  deleteDocument,
  listRecentDocuments,
  listUserDocuments,
  findExpiredDocuments,
  findCleanableDocuments,
  deleteExpiredDocumentRecords,
  incrementViewCount,
  incrementDownloadCount,
  reserveDownload,
  releaseDownloadReservation,
  finalizeDownload,
  getDbStatus,
};
