const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

let pool = null;
let isTiDBConnected = false;
let dbMode = "uninitialized";

// Local storage fallback data path for offline/development testing
const LOCAL_DB_FILE = path.join(__dirname, "local_documents.json");
const LOCAL_USERS_FILE = path.join(__dirname, "local_users.json");

function loadLocalDocs() {
  try {
    if (fs.existsSync(LOCAL_DB_FILE)) {
      const data = fs.readFileSync(LOCAL_DB_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Error reading local db fallback:", err.message);
  }
  return [];
}

function saveLocalDocs(docs) {
  try {
    fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(docs, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving local db fallback:", err.message);
  }
}

function loadLocalUsers() {
  try {
    if (fs.existsSync(LOCAL_USERS_FILE)) {
      const data = fs.readFileSync(LOCAL_USERS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Error reading local users fallback:", err.message);
  }
  return [];
}

function saveLocalUsers(users) {
  try {
    fs.writeFileSync(LOCAL_USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving local users fallback:", err.message);
  }
}

async function initDatabase() {
  const host = process.env.TIDB_HOST;
  const user = process.env.TIDB_USER;
  const password = process.env.TIDB_PASSWORD;
  const database = process.env.TIDB_DATABASE || "test";
  const port = parseInt(process.env.TIDB_PORT || "4000", 10);
  const caCertPath = process.env.TIDB_CA_PATH;

  if (host && user) {
    try {
      console.log(`[TiDB] Connecting to TiDB Cloud cluster at ${host}:${port}...`);
      
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
        connectionLimit: 10,
        queueLimit: 0,
      });

      // Test connection
      const connection = await pool.getConnection();
      console.log(`[TiDB] Successfully connected to TiDB Cloud (${database})!`);
      connection.release();

      // Ensure users table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          full_name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log("[TiDB] Table 'users' verified/ready.");

      // Ensure documents table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          owner_id BIGINT NULL,
          original_name VARCHAR(255) NOT NULL,
          mime_type VARCHAR(100) DEFAULT 'application/octet-stream',
          storage_key VARCHAR(500) NOT NULL,
          access_code_hash CHAR(64) NOT NULL UNIQUE,
          file_size BIGINT NOT NULL,
          expires_at DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_owner (owner_id),
          INDEX idx_code_hash (access_code_hash)
        );
      `);

      // Ensure owner_id, access_code, view_count, download_count, file_count, storage_mode, max_downloads, active_downloads, delete_after_download exist
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN owner_id BIGINT NULL;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN access_code VARCHAR(50) NULL;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN view_count INT DEFAULT 0;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN download_count INT DEFAULT 0;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN file_count INT NOT NULL DEFAULT 1;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN storage_mode VARCHAR(32) NOT NULL DEFAULT 'online';`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN max_downloads INT NULL DEFAULT NULL;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN active_downloads INT NOT NULL DEFAULT 0;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD COLUMN delete_after_download TINYINT(1) NOT NULL DEFAULT 0;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD INDEX idx_expires (expires_at);`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE documents ADD INDEX idx_storage_mode (storage_mode);`);
      } catch (_) {}

      console.log("[TiDB] Table 'documents' verified/ready with Online Sharing schema.");

      // Ensure password_reset_tokens table exists for Forgot / Reset Password feature
      await pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          token_hash CHAR(64) NOT NULL UNIQUE,
          expires_at DATETIME NOT NULL,
          used_at DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_reset_user (user_id),
          INDEX idx_reset_expiry (expires_at)
        );
      `);
      try {
        await pool.query(`ALTER TABLE password_reset_tokens ADD COLUMN otp_code VARCHAR(10) NULL;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE password_reset_tokens ADD COLUMN email VARCHAR(255) NULL;`);
      } catch (_) {}
      try {
        await pool.query(`ALTER TABLE password_reset_tokens ADD INDEX idx_reset_otp (email, otp_code);`);
      } catch (_) {}
      console.log("[TiDB] Table 'password_reset_tokens' verified/ready.");

      isTiDBConnected = true;
      dbMode = "tidb_cloud";
      return;
    } catch (err) {
      console.warn(`[TiDB Connection Warning] Could not connect to TiDB Cloud: ${err.message}`);
      console.warn("[TiDB] Falling back to local development database mode.");
      pool = null;
      isTiDBConnected = false;
      dbMode = "local_fallback";
    }
  } else {
    console.log("[TiDB] TIDB_HOST and TIDB_USER not specified in .env.");
    console.log("[TiDB] Operating in local development database mode.");
    isTiDBConnected = false;
    dbMode = "local_dev";
  }

  // Ensure local db files exist
  if (!fs.existsSync(LOCAL_DB_FILE)) saveLocalDocs([]);
  if (!fs.existsSync(LOCAL_USERS_FILE)) saveLocalUsers([]);
}

// User Operations
async function findUserByEmail(email) {
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, password_hash, created_at FROM users WHERE email = ? LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    return rows[0] || null;
  } else {
    const users = loadLocalUsers();
    return users.find((u) => u.email === email.toLowerCase().trim()) || null;
  }
}

async function findUserById(id) {
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, created_at FROM users WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  } else {
    const users = loadLocalUsers();
    const user = users.find((u) => u.id === Number(id));
    if (!user) return null;
    const { password_hash, ...safeUser } = user;
    return safeUser;
  }
}

async function createUser({ full_name, email, password_hash }) {
  const normalizedEmail = email.toLowerCase().trim();
  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)`,
      [full_name.trim(), normalizedEmail, password_hash]
    );
    return {
      id: result.insertId,
      full_name: full_name.trim(),
      email: normalizedEmail,
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
      created_at: new Date().toISOString(),
    };
    users.push(newUser);
    saveLocalUsers(users);
    const { password_hash: _, ...safeUser } = newUser;
    return safeUser;
  }
}

// Document Operations
async function saveDocument({
  owner_id = null,
  original_name,
  mime_type,
  storage_key,
  access_code_hash,
  access_code = null,
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
        access_code,
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
      access_code,
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
      access_code,
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
      `SELECT id, owner_id, original_name, mime_type, storage_key, access_code_hash, access_code,
              file_size, expires_at, created_at,
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
    return rows[0] || null;
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.access_code_hash === access_code_hash);
    if (!doc) return null;
    return {
      ...doc,
      view_count: doc.view_count || 0,
      download_count: doc.download_count || 0,
      file_count: doc.file_count || 1,
      storage_mode: doc.storage_mode || "online",
      max_downloads: doc.max_downloads !== undefined ? doc.max_downloads : null,
      active_downloads: doc.active_downloads || 0,
      delete_after_download: doc.delete_after_download ? 1 : 0,
    };
  }
}

// Atomically reserves a download slot while validating limits and expiration
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
    if (doc.max_downloads !== null && doc.max_downloads !== undefined && (currentDownloads + currentActive) >= doc.max_downloads) {
      return false;
    }
    if (doc.delete_after_download && currentDownloads > 0) return false;
    doc.active_downloads = currentActive + 1;
    saveLocalDocs(docs);
    return true;
  }
}

// Releases an active download reservation upon transfer error or cancellation
async function releaseDownloadReservation(id) {
  if (!id) return;
  if (isTiDBConnected && pool) {
    try {
      await pool.query(
        `UPDATE documents SET active_downloads = GREATEST(active_downloads - 1, 0) WHERE id = ?`,
        [id]
      );
    } catch (e) {
      console.warn("[TiDB Release Download Reservation Warning]", e.message);
    }
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.id === Number(id));
    if (doc) {
      doc.active_downloads = Math.max(0, (doc.active_downloads || 1) - 1);
      saveLocalDocs(docs);
    }
  }
}

// Finalizes a successfully completed download
async function finalizeDownload(id) {
  if (!id) return;
  if (isTiDBConnected && pool) {
    try {
      await pool.query(
        `UPDATE documents
         SET download_count = download_count + 1,
             active_downloads = GREATEST(active_downloads - 1, 0)
         WHERE id = ?`,
        [id]
      );
    } catch (e) {
      console.warn("[TiDB Finalize Download Warning]", e.message);
    }
  } else {
    const docs = loadLocalDocs();
    const doc = docs.find((d) => d.id === Number(id));
    if (doc) {
      doc.download_count = (doc.download_count || 0) + 1;
      doc.active_downloads = Math.max(0, (doc.active_downloads || 1) - 1);
      saveLocalDocs(docs);
    }
  }
}

// Query all documents that should be purged (with active_downloads = 0)
async function findCleanableDocuments() {
  const now = new Date();
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, owner_id, storage_key, original_name, access_code, expires_at,
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
    return docs.filter((d) => {
      if ((d.active_downloads || 0) > 0) return false;
      const isExpired = d.expires_at && new Date(d.expires_at) <= now;
      const isLimitReached = d.max_downloads != null && d.max_downloads > 0 && (d.download_count || 0) >= d.max_downloads;
      const isDeleteAfter = d.delete_after_download && (d.download_count || 0) >= 1;
      return isExpired || isLimitReached || isDeleteAfter;
    });
  }
}

// List user documents with enriched status for Online Sharing
async function listUserDocuments(owner_id, limit = 50) {
  const now = new Date();
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
      [owner_id, limit]
    );
    return rows.map((doc) => enrichDocumentStatus(doc, now));
  } else {
    let docs = loadLocalDocs();
    docs = docs.filter((d) => d.owner_id === Number(owner_id));
    return docs.slice(0, limit).map((d) => enrichDocumentStatus(d, now));
  }
}

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
    status,
    is_expired: isExpired,
    is_limit_reached: isLimitReached,
    is_downloaded_and_pending_delete: isDownloadedAndPendingDelete,
  };
}

async function listRecentDocuments(limit = 10, owner_id = null) {
  if (owner_id) {
    return await listUserDocuments(owner_id, limit);
  }
  const now = new Date();
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
       WHERE (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC
       LIMIT ?`,
      [now, limit]
    );
    return rows.map((d) => enrichDocumentStatus(d, now));
  } else {
    let docs = loadLocalDocs();
    docs = docs.filter((d) => !d.expires_at || new Date(d.expires_at) > now);
    return docs.slice(0, limit).map((d) => enrichDocumentStatus(d, now));
  }
}

async function findExpiredDocuments() {
  return await findCleanableDocuments();
}

async function deleteExpiredDocumentRecords(ids) {
  if (!ids || ids.length === 0) return 0;
  if (isTiDBConnected && pool) {
    const [result] = await pool.query(
      `DELETE FROM documents WHERE id IN (?)`,
      [ids]
    );
    return result.affectedRows;
  } else {
    let docs = loadLocalDocs();
    const initialLen = docs.length;
    const idSet = new Set(ids.map(Number));
    docs = docs.filter((d) => !idSet.has(Number(d.id)));
    saveLocalDocs(docs);
    return initialLen - docs.length;
  }
}

async function findDocumentById(id) {
  if (isTiDBConnected && pool) {
    const [rows] = await pool.query(
      `SELECT id, owner_id, original_name, mime_type, storage_key, access_code_hash, access_code,
              file_size, expires_at, created_at,
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
  return await finalizeDownload(id);
}

async function updateDocument(id, owner_id, { original_name, expires_at, file_size }) {
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
    saveLocalDocs(docs);
    return docs[index];
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
    docs = docs.filter((d) => !(d.id === Number(id) && d.owner_id === Number(owner_id) && (d.active_downloads || 0) === 0));
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
  if (!pool) {
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

module.exports = {
  initDatabase,
  getPool,
  execute,
  query,
  getConnection,
  findUserByEmail,
  findUserById,
  createUser,
  saveDocument,
  findDocumentByHash,
  findDocumentById,
  updateDocument,
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

