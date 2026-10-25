const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const archiverPkg = require("archiver");
const AdmZip = require("adm-zip");
function createZipArchive(options = { zlib: { level: 0 } }) {
  if (typeof archiverPkg === "function") {
    return archiverPkg("zip", options);
  }
  if (archiverPkg.ZipArchive) {
    return new archiverPkg.ZipArchive(options);
  }
  if (archiverPkg.create) {
    return archiverPkg.create("zip", options);
  }
  throw new Error("Cannot initialize ZIP archiver");
}
const { finished, pipeline } = require("stream/promises");
require("dotenv").config();

const { generateCode, hashCode, legacyHashCode, isValidCodeFormat } = require("./codeGenerator");
const authRoutes = require("./authRoutes");
const {
  initDatabase,
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
  getDbStatus
} = require("./db");
const {
  isB2Configured,
  isB2Connected,
  testB2Connection,
  uploadToB2,
  getFromB2,
  deleteFromB2,
  existsInB2,
  getPresignedDownloadUrl,
  B2_BUCKET,
} = require("./b2");

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "secure_vault_super_secret_jwt_key_2026";

// Trust reverse proxies (Northflank Ingress, Vercel, Cloudflare, etc.)
app.set("trust proxy", 1);

// Security headers allowing cross-origin embeds from Vercel frontend
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    frameguard: false
  })
);

// CORS configuration with explicit Vercel support & credential reflection
const allowedOrigins = [
  "https://secure-vault-delta-virid.vercel.app",
  process.env.FRONTEND_URL,
  process.env.FRONTEND_ORIGIN,
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:5174",
].filter(Boolean).map(o => o.trim().replace(/\/+$/, ""));

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      const cleanOrigin = origin.trim().replace(/\/+$/, "");
      if (
        allowedOrigins.includes(cleanOrigin) ||
        /\.vercel\.app$/.test(new URL(origin).hostname)
      ) {
        return callback(null, true);
      }
      return callback(null, true); // Fallback: allow all origins with credentials for cloud PaaS
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"]
  })
);

app.use(express.json());

// Ensure private uploads & archives directories exist
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
const ARCHIVES_DIR = path.join(UPLOADS_DIR, "archives");
if (!fs.existsSync(ARCHIVES_DIR)) {
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
}

// Temporary directory for staged uploads before archiving into ZIP
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), "secure-vault-uploads");
if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
  fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
}

const MAX_FILES = 20;
const MAX_FILE_SIZE = 250 * 1024 * 1024; // 250 MB per file
const MAX_TOTAL_SIZE = 1024 * 1024 * 1024; // 1 GB per upload

// Multer diskStorage using temporary directory
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, TEMP_UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, crypto.randomUUID());
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  }
});

function safeArchiveName(originalName, index) {
  const cleaned = path
    .basename(originalName.replace(/\\/g, "/"))
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/^\.+$/, "file")
    .slice(0, 180) || "file";

  return `${String(index + 1).padStart(2, "0")}_${cleaned}`;
}

// Rate limiters
const accessLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many access attempts. Please wait a minute before trying again."
  }
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Upload limit reached. Please wait a few minutes before uploading again."
  }
});

// JWT Middleware
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (_) {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
};

const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "You must be signed in to upload documents. Please create an account or sign in.",
      requireAuth: true
    });
  }
  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      error: "Session expired. Please sign in again.",
      requireAuth: true
    });
  }
};

// Helper to parse expiry duration string or ISO date
function calculateExpiresAt(expiryOption) {
  if (!expiryOption || expiryOption === "never") {
    return null;
  }
  const now = new Date();
  const match =
    typeof expiryOption === "string" &&
    expiryOption
      .trim()
      .match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months)$/i);

  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith("mo")) {
      ms = val * 30 * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith("w")) {
      ms = val * 7 * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith("d")) {
      ms = val * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith("h")) {
      ms = val * 60 * 60 * 1000;
    } else if (unit.startsWith("m")) {
      ms = val * 60 * 1000;
    }
    return new Date(now.getTime() + ms);
  } else if (!isNaN(Date.parse(expiryOption))) {
    return new Date(expiryOption);
  } else {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000); // default 24h
  }
}

// Middleware allowing either multipart/form-data (single or multiple files) or JSON
const handleUploadOrText = (req, res, next) => {
  if (req.is("multipart/form-data")) {
    upload.any()(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB per file.`
          });
        }
        if (err.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({
            error: `Too many files. Maximum ${MAX_FILES} files allowed per upload.`
          });
        }
        return res.status(400).json({ error: err.message || "File upload error" });
      }
      next();
    });
  } else {
    next();
  }
};

// --- ROOT & HEALTH ENDPOINTS (For Northflank, Cloud PaaS, & Monitoring) ---

// Root endpoint: returns active server info and links
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "SECURE VAULT API",
    version: "1.0.0",
    frontend: process.env.FRONTEND_URL || "https://secure-vault-delta-virid.vercel.app",
    health: "/api/health",
    statusEndpoint: "/api/status"
  });
});

// Health check endpoints for Northflank probes (supports /health and /api/health)
app.get(["/health", "/api/health"], (req, res) => {
  res.json({ status: "ok" });
});

// Health & TiDB Connection & Backblaze B2 Storage Status
app.get("/api/status", (req, res) => {
  const dbStatus = getDbStatus();
  const b2Status = {
    isConfigured: isB2Configured(),
    isConnected: isB2Connected(),
    bucket: B2_BUCKET,
    endpoint: process.env.B2_ENDPOINT || null,
    region: process.env.B2_REGION || null,
  };
  res.json({
    status: "online",
    service: "SECURE VAULT API",
    time: new Date().toISOString(),
    database: dbStatus,
    storage: b2Status,
  });
});

// --- AUTHENTICATION (TiDB Cloud) ---

// Mount Forgot Password & Reset Password Router
app.use("/api/auth", authRoutes);

// 1. Register User
app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName || typeof fullName !== "string" || fullName.trim().length < 2) {
      return res.status(400).json({ error: "Full name must be at least 2 characters." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long." });
    }

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const newUser = await createUser({
      full_name: fullName,
      email,
      password_hash
    });

    res.status(201).json({
      success: true,
      message: "Account created successfully. You can now sign in.",
      user: { id: newUser.id, name: newUser.full_name, email: newUser.email }
    });
  } catch (err) {
    console.error("[Auth Register Error]", err);
    res.status(500).json({ error: "Unable to complete registration. Please try again." });
  }
});

// 2. Login User
app.post("/api/auth/login", accessLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      // Do not reveal whether user exists
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.full_name },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email
      }
    });
  } catch (err) {
    console.error("[Auth Login Error]", err);
    res.status(500).json({ error: "Unable to sign in. Please try again." });
  }
});

// 3. Current User
app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve user profile." });
  }
});

// 4. Logout
app.post("/api/auth/logout", (req, res) => {
  res.json({ success: true, message: "Logged out successfully." });
});

// --- DOCUMENT OPERATIONS ---

// 1. Upload Document(s) - Automatically zipped into a single archive stored in Backblaze B2 & TiDB Cloud
app.post("/api/documents/upload", uploadLimiter, requireAuth, handleUploadOrText, async (req, res) => {
  const files = req.files || (req.file ? [req.file] : []);
  const rawText = req.body && typeof req.body.text === "string" ? req.body.text : null;
  const hasText = rawText !== null && rawText.trim().length > 0;

  if (files.length === 0 && !hasText) {
    return res.status(400).json({ error: "Please select at least one file or enter text content to upload." });
  }

  let workDir = null;
  let storageKey = null;
  let uploadedToB2 = false;
  let databaseSaved = false;

  try {
    const totalSize = files.reduce((total, file) => total + (file.size || 0), 0);
    if (totalSize > MAX_TOTAL_SIZE) {
      return res.status(413).json({ error: "The total upload size cannot exceed 1 GB." });
    }

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "secure-vault-zip-"));
    const zipPath = path.join(workDir, "documents.zip");
    const archive = createZipArchive({ zlib: { level: 0 } });
    const output = fs.createWriteStream(zipPath);
    const outputDone = finished(output);

    archive.on("error", (error) => {
      output.destroy(error);
    });

    archive.pipe(output);

    let archiveName = "";
    let fileCount = 0;
    const customName = (req.body.name || req.body.title || req.body.document_name || "").trim();

    if (files.length > 0) {
      fileCount = files.length;
      files.forEach((file, index) => {
        archive.file(file.path, {
          name: safeArchiveName(file.originalname, index),
        });
      });

      if (customName) {
        const cleanBase = path.basename(customName, path.extname(customName)).replace(/[/\\?%*:|"<>]/g, "_");
        archiveName = `${cleanBase || "archive"}.zip`;
      } else if (files.length === 1) {
        const base = path.basename(files[0].originalname, path.extname(files[0].originalname));
        archiveName = `${base}.zip`;
      } else {
        const docIdShort = crypto.randomBytes(4).toString("hex");
        archiveName = `secure-vault-${files.length}files-${docIdShort}.zip`;
      }
    } else if (hasText) {
      fileCount = 1;
      let title = customName || (req.body.title || "").trim();
      if (!title) {
        title = "Secure_Note.txt";
      } else if (!path.extname(title)) {
        title = `${title}.txt`;
      }
      archive.append(rawText, { name: path.basename(title) });
      const base = path.basename(title, path.extname(title));
      archiveName = `${base}.zip`;
    }

    await archive.finalize();
    await outputDone;

    const zipStats = fs.statSync(zipPath);
    const documentId = crypto.randomUUID();
    storageKey = `archives/${documentId}.zip`;

    // Save copy in local uploads directory as reliable disk fallback
    const localArchivePath = path.join(UPLOADS_DIR, storageKey);
    const localArchiveDir = path.dirname(localArchivePath);
    if (!fs.existsSync(localArchiveDir)) {
      fs.mkdirSync(localArchiveDir, { recursive: true });
    }
    fs.copyFileSync(zipPath, localArchivePath);

    // Upload ZIP to private Backblaze B2
    if (isB2Configured()) {
      try {
        await uploadToB2({
          key: storageKey,
          body: fs.createReadStream(zipPath),
          contentType: "application/zip",
          contentLength: zipStats.size,
        });
        uploadedToB2 = true;
        console.log(`[Backblaze B2] Stored ZIP archive '${storageKey}' (${zipStats.size} bytes)`);
      } catch (b2Err) {
        console.warn("[Backblaze B2 ZIP Upload Warning]", b2Err.message);
      }
    }

    const storageMode = (req.body.storage_mode || "online").toLowerCase();
    if (!["online", "temporary", "long_term"].includes(storageMode)) {
      return res.status(400).json({ error: "Invalid storage mode specified." });
    }

    let maxDownloads = null;
    if (
      req.body.max_downloads !== undefined &&
      req.body.max_downloads !== "unlimited" &&
      req.body.max_downloads !== "" &&
      req.body.max_downloads !== null
    ) {
      const parsedMax = parseInt(req.body.max_downloads, 10);
      if (!isNaN(parsedMax) && parsedMax > 0) {
        maxDownloads = parsedMax;
      }
    }

    const deleteAfterDownload =
      req.body.delete_after_download === true ||
      req.body.delete_after_download === "true" ||
      req.body.delete_after_download === 1 ||
      req.body.delete_after_download === "1";

    const expiryOption = req.body.expiry || "24h";
    const expiresAt = calculateExpiresAt(expiryOption);
    const ownerId = req.user ? req.user.id : null;

    let accessCode = "";
    let codeHash = "";
    let savedDoc = null;
    let attempts = 0;

    while (attempts < 5) {
      accessCode = generateCode();
      codeHash = hashCode(accessCode);

      try {
        savedDoc = await saveDocument({
          owner_id: ownerId,
          original_name: archiveName,
          mime_type: "application/zip",
          storage_key: storageKey,
          access_code_hash: codeHash,
          access_code: accessCode,
          file_size: zipStats.size,
          expires_at: expiresAt,
          file_count: fileCount,
          storage_mode: storageMode,
          max_downloads: maxDownloads,
          delete_after_download: deleteAfterDownload ? 1 : 0,
        });
        databaseSaved = true;
        break;
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
          attempts++;
          continue;
        }
        if (uploadedToB2) {
          await deleteFromB2({ key: storageKey });
        }
        throw err;
      }
    }

    if (!savedDoc) {
      if (uploadedToB2) {
        await deleteFromB2({ key: storageKey });
      }
      return res.status(500).json({ error: "Failed to allocate a unique access code. Please retry." });
    }

    res.status(201).json({
      success: true,
      message: "Files zipped and stored for online sharing.",
      access_code: accessCode,
      accessCode: accessCode,
      document: {
        id: savedDoc.id,
        owner_id: ownerId,
        original_name: archiveName,
        fileName: archiveName,
        mime_type: "application/zip",
        file_size: zipStats.size,
        zipSize: zipStats.size,
        originalSize: totalSize,
        file_count: fileCount,
        fileCount: fileCount,
        storage_mode: savedDoc.storage_mode,
        max_downloads: savedDoc.max_downloads,
        delete_after_download: Boolean(savedDoc.delete_after_download),
        download_count: 0,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        created_at: savedDoc.created_at,
        is_zip: true,
        storage_engine: uploadedToB2 ? "backblaze_b2" : "local_storage"
      }
    });
  } catch (err) {
    if (uploadedToB2 && !databaseSaved && storageKey) {
      try {
        await deleteFromB2({ key: storageKey });
      } catch (_) {}
    }
    console.error("Upload archive error:", err);
    res.status(500).json({ error: err.message || "Server error while processing upload." });
  } finally {
    // Delete individual temporary uploads and the temporary workDir ZIP
    files.forEach((f) => {
      if (f.path && fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path); } catch (_) {}
      }
    });
    if (workDir && fs.existsSync(workDir)) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

// Save Direct Text (Requires Authentication)
app.post("/api/documents/text", uploadLimiter, requireAuth, async (req, res) => {
  try {
    const { text, title, expiry } = req.body;
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text content cannot be empty." });
    }

    let fileName = (title || "").trim();
    if (!fileName) {
      fileName = "Secure_Note.txt";
    } else if (!path.extname(fileName)) {
      fileName = `${fileName}.txt`;
    }
    const originalName = path.basename(fileName);
    const mimeType = "text/plain; charset=utf-8";
    const fileSize = Buffer.byteLength(text, "utf8");

    const randomKey = crypto.randomBytes(20).toString("hex") + ".txt";
    const filePath = path.join(UPLOADS_DIR, randomKey);
    fs.writeFileSync(filePath, text, "utf8");

    let uploadedToB2 = false;
    if (isB2Configured()) {
      try {
        await uploadToB2({
          key: randomKey,
          body: Buffer.from(text, "utf8"),
          contentType: mimeType,
          contentLength: fileSize,
        });
        uploadedToB2 = true;
        console.log(`[Backblaze B2] Stored secret note as '${randomKey}'`);
      } catch (b2Err) {
        console.warn("[Backblaze B2 Text Warning]", b2Err.message);
      }
    }

    const expiresAt = calculateExpiresAt(expiry || "24h");
    const ownerId = req.user ? req.user.id : null;

    let accessCode = "";
    let codeHash = "";
    let savedDoc = null;
    let attempts = 0;

    const storageMode = (req.body.storage_mode || "online").toLowerCase();
    let maxDownloads = null;
    if (
      req.body.max_downloads !== undefined &&
      req.body.max_downloads !== "unlimited" &&
      req.body.max_downloads !== "" &&
      req.body.max_downloads !== null
    ) {
      const parsedMax = parseInt(req.body.max_downloads, 10);
      if (!isNaN(parsedMax) && parsedMax > 0) {
        maxDownloads = parsedMax;
      }
    }
    const deleteAfterDownload =
      req.body.delete_after_download === true ||
      req.body.delete_after_download === "true" ||
      req.body.delete_after_download === 1 ||
      req.body.delete_after_download === "1";

    while (attempts < 5) {
      accessCode = generateCode();
      codeHash = hashCode(accessCode);

      try {
        savedDoc = await saveDocument({
          owner_id: ownerId,
          original_name: originalName,
          mime_type: mimeType,
          storage_key: randomKey,
          access_code_hash: codeHash,
          access_code: accessCode,
          file_size: fileSize,
          expires_at: expiresAt,
          storage_mode: storageMode,
          max_downloads: maxDownloads,
          delete_after_download: deleteAfterDownload ? 1 : 0
        });
        break;
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
          attempts++;
          continue;
        }
        if (uploadedToB2) {
          await deleteFromB2({ key: randomKey });
        }
        throw err;
      }
    }

    if (!savedDoc) {
      if (uploadedToB2) {
        await deleteFromB2({ key: randomKey });
      }
      return res.status(500).json({ error: "Failed to allocate a unique access code. Please retry." });
    }

    res.status(201).json({
      success: true,
      access_code: accessCode,
      document: {
        id: savedDoc.id,
        owner_id: ownerId,
        original_name: originalName,
        mime_type: mimeType,
        file_size: fileSize,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        created_at: savedDoc.created_at,
        is_text: true,
        storage_engine: uploadedToB2 ? "backblaze_b2" : "local_storage"
      }
    });
  } catch (err) {
    console.error("Text save error:", err);
    res.status(500).json({ error: "Server error while saving secret text." });
  }
});

// Helper for comprehensive MIME type resolution
function getMimeType(filename, defaultMime = "application/octet-stream") {
  if (!filename) return defaultMime;
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".zip": "application/zip",
  };
  return mimeMap[ext] || defaultMime;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatBytesServer(bytes) {
  if (!bytes || bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// Render responsive HTML viewer for multi-file archives
// Render responsive HTML viewer for multi-file archives
function renderArchiveViewerHtml(doc, entries, codeParam) {
  const fileItemsHtml = entries
    .map((e) => {
      const cleanName = e.entryName.replace(/^(\d+_)+/, "");
      const ext = path.extname(cleanName).toLowerCase();
      let icon = "📄";
      if ([".pdf"].includes(ext)) icon = "📕";
      else if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) icon = "🖼️";
      else if ([".txt", ".md", ".json", ".log", ".csv", ".js", ".ts", ".html"].includes(ext)) icon = "📝";
      else if ([".mp3", ".wav", ".ogg"].includes(ext)) icon = "🎵";
      else if ([".mp4", ".webm"].includes(ext)) icon = "🎬";
      else if ([".zip", ".tar", ".gz"].includes(ext)) icon = "📦";

      const sizeStr = formatBytesServer(e.header ? e.header.size : 0);
      const viewFileUrl = `/api/documents/download/${codeParam}?action=view&file=${encodeURIComponent(e.entryName)}`;
      const downloadFileUrl = `/api/documents/download/${codeParam}?action=download&file=${encodeURIComponent(e.entryName)}`;

      return `
        <div class="file-item">
          <div class="file-info">
            <span class="file-icon">${icon}</span>
            <div class="file-details">
              <div class="file-name" title="${escapeHtml(cleanName)}">${escapeHtml(cleanName)}</div>
              <div class="file-size">${sizeStr}</div>
            </div>
          </div>
          <div class="file-actions">
            <a href="${viewFileUrl}" target="_blank" rel="noopener noreferrer" class="btn-view">
              👁️ View
            </a>
            <a href="${downloadFileUrl}" class="btn-dl">
              ⬇️ Download
            </a>
          </div>
        </div>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(doc.original_name)} — DocQevrilo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #09090B;
      color: #FAFAFA;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 12px;
    }
    @media (min-width: 640px) {
      body { padding: 24px 16px; }
    }
    .container {
      width: 100%;
      max-width: 760px;
      background: #18181B;
      border: 1px solid #27272A;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    @media (min-width: 640px) {
      .container { padding: 24px; border-radius: 18px; }
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid #27272A;
      padding-bottom: 14px;
      margin-bottom: 16px;
    }
    .title-box {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .title-box span {
      font-size: 24px;
      line-height: 1;
      flex-shrink: 0;
    }
    .title-details {
      min-width: 0;
      flex: 1;
      overflow: hidden;
    }
    .title-details h1 {
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .title-details p {
      font-size: 11px;
      color: #A1A1AA;
      margin-top: 2px;
    }
    .badge {
      background: rgba(225, 29, 46, 0.15);
      color: #E11D2E;
      border: 1px solid rgba(225, 29, 46, 0.3);
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }
    .file-item {
      background: #121215;
      border: 1px solid #27272A;
      border-radius: 10px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
      flex-wrap: wrap;
      transition: border-color 0.15s;
    }
    .file-item:hover {
      border-color: #3F3F46;
    }
    .file-info {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 140px;
      flex: 1 1 160px;
      overflow: hidden;
    }
    .file-icon {
      font-size: 20px;
      line-height: 1;
      flex-shrink: 0;
    }
    .file-details {
      min-width: 0;
      flex: 1;
      overflow: hidden;
    }
    .file-name {
      font-weight: 600;
      color: #fff;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }
    .file-size {
      font-size: 11px;
      color: #A1A1AA;
      margin-top: 2px;
    }
    .file-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      margin-left: auto;
    }
    .btn-view {
      background: #18181B;
      color: #FAFAFA;
      border: 1px solid #3F3F46;
      padding: 6px 12px;
      border-radius: 7px;
      text-decoration: none;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .btn-view:hover { background: #27272A; }
    .btn-dl {
      background: #E11D2E;
      color: #fff;
      border: none;
      padding: 6px 12px;
      border-radius: 7px;
      text-decoration: none;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .btn-dl:hover { background: #FF2E44; }
    .dl-all {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      background: #27272A;
      color: #fff;
      padding: 10px 16px;
      border-radius: 9px;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      margin-top: 12px;
      border: 1px solid #3F3F46;
      transition: background 0.2s;
    }
    .dl-all:hover { background: #3F3F46; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title-box">
        <span>🗄️</span>
        <div class="title-details">
          <h1 title="${escapeHtml(doc.original_name)}">${escapeHtml(doc.original_name)}</h1>
          <p>${entries.length} ${entries.length === 1 ? 'file' : 'files'} in archive · Secure Stream</p>
        </div>
      </div>
      <span class="badge">DocQevrilo</span>
    </div>

    <div>
      ${fileItemsHtml}
    </div>

    <a href="/api/documents/download/${codeParam}?action=download" class="dl-all">
      📦 Download Entire Archive as .ZIP
    </a>
  </div>
</body>
</html>`;
}

// Fetch document buffer from disk or Backblaze B2
async function getDocumentBuffer(storageKey) {
  const filePath = path.join(UPLOADS_DIR, storageKey);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }
  if (isB2Configured()) {
    try {
      const b2Object = await getFromB2({ key: storageKey });
      if (b2Object && b2Object.Body) {
        const chunks = [];
        for await (const chunk of b2Object.Body) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        return Buffer.concat(chunks);
      }
    } catch (b2Err) {
      console.warn("[Backblaze B2 Read Warning]", b2Err.message);
    }
  }
  throw new Error("Physical storage archive is missing.");
}

// Helper function for concurrency-safe streaming with reservation & download tracking
async function streamDocumentToResponse(doc, req, res) {
  const isViewAction = req.query.action === "view" || req.path.includes("/view");

  // Check expiration
  if (doc.expires_at && new Date() > new Date(doc.expires_at)) {
    purgeExpiredDocuments().catch(() => {});
    return res.status(410).json({ error: "This archive has expired and is no longer available." });
  }

  // If download action, check download limits & reserve download atomically
  if (!isViewAction) {
    const reserved = await reserveDownload(doc.id);
    if (!reserved) {
      if (doc.delete_after_download && (doc.download_count || 0) >= 1) {
        return res.status(410).json({
          error: "This archive was configured to delete after its first download and is no longer available."
        });
      }
      if (doc.max_downloads != null && (doc.download_count || 0) >= doc.max_downloads) {
        return res.status(410).json({
          error: `Maximum download limit (${doc.max_downloads} ${doc.max_downloads === 1 ? 'download' : 'downloads'}) has been reached for this archive.`
        });
      }
      return res.status(429).json({
        error: "Maximum simultaneous download capacity reached for this document. Please retry shortly."
      });
    }
  }

  let downloadCompleted = false;

  const cleanupOnClose = () => {
    if (!isViewAction && !downloadCompleted) {
      releaseDownloadReservation(doc.id).catch(() => {});
    }
  };
  res.on("close", cleanupOnClose);

  try {
    const buffer = await getDocumentBuffer(doc.storage_key);

    const isZip =
      (doc.storage_key && doc.storage_key.endsWith(".zip")) ||
      (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b);

    if (isZip) {
      let zip;
      try {
        zip = new AdmZip(buffer);
      } catch (zipErr) {
        console.warn("[AdmZip Parse Warning]", zipErr.message);
      }

      const entries = zip ? zip.getEntries().filter((e) => !e.isDirectory) : [];

      // 1. User wants to view or download a specific file from the archive
      const requestedFile = req.query.file;
      if (requestedFile && entries.length > 0) {
        const targetEntry = entries.find(
          (e) =>
            e.entryName === requestedFile ||
            e.entryName.replace(/^(\d+_)+/, "") === requestedFile
        );
        if (targetEntry) {
          const cleanName = targetEntry.entryName.replace(/^(\d+_)+/, "");
          const mimeType = getMimeType(cleanName);
          const data = targetEntry.getData();
          const disposition = isViewAction ? "inline" : "attachment";

          res.setHeader("Content-Type", mimeType);
          res.setHeader(
            "Content-Disposition",
            `${disposition}; filename="${cleanName}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`
          );
          res.setHeader("Content-Length", String(data.length));
          res.setHeader("X-Content-Type-Options", "nosniff");

          if (!isViewAction) {
            downloadCompleted = true;
            res.removeListener("close", cleanupOnClose);
            await finalizeDownload(doc.id);
            if (doc.delete_after_download) {
              setImmediate(() => { purgeExpiredDocuments().catch(() => {}); });
            }
          } else {
            await incrementViewCount(doc.id);
          }
          return res.send(data);
        }
      }

      // 2. Single-file archive (e.g. uploaded single PDF, image, text note, etc.)
      if (entries.length === 1) {
        const entry = entries[0];
        const cleanName = entry.entryName.replace(/^(\d+_)+/, "");
        const mimeType = getMimeType(cleanName, doc.mime_type || "application/octet-stream");
        const data = entry.getData();

        if (isViewAction) {
          // Serve uncompressed data with its actual MIME type for native browser rendering
          res.setHeader("Content-Type", mimeType);
          res.setHeader(
            "Content-Disposition",
            `inline; filename="${cleanName}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`
          );
          res.setHeader("Content-Length", String(data.length));
          res.setHeader("X-Content-Type-Options", "nosniff");
          await incrementViewCount(doc.id);
          return res.send(data);
        } else {
          // Download action
          downloadCompleted = true;
          res.removeListener("close", cleanupOnClose);
          await finalizeDownload(doc.id);
          if (doc.delete_after_download) {
            setImmediate(() => { purgeExpiredDocuments().catch(() => {}); });
          }

          // If raw ZIP was not explicitly requested, download the real uncompressed file
          if (req.query.format !== "zip") {
            res.setHeader("Content-Type", mimeType);
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="${cleanName}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`
            );
            res.setHeader("Content-Length", String(data.length));
            return res.send(data);
          }
        }
      }

      // 3. Multi-file archive view: Render interactive file browser page
      if (entries.length > 1 && isViewAction) {
        await incrementViewCount(doc.id);
        const codeParam = encodeURIComponent(req.params.access_code || req.query.code || "");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(renderArchiveViewerHtml(doc, entries, codeParam));
      }
    }

    // Default streaming for raw storage or full archive download
    const dispositionType = isViewAction ? "inline" : "attachment";
    const safeFilename = path.basename(doc.original_name).replace(/["\r\n]/g, "_");
    const mimeType = isViewAction
      ? getMimeType(doc.original_name, doc.mime_type || "application/octet-stream")
      : doc.mime_type || "application/octet-stream";

    res.setHeader("Content-Type", mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${dispositionType}; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );
    res.setHeader("Content-Length", String(buffer.length));

    if (!isViewAction) {
      downloadCompleted = true;
      res.removeListener("close", cleanupOnClose);
      await finalizeDownload(doc.id);
      if (doc.delete_after_download) {
        setImmediate(() => { purgeExpiredDocuments().catch(() => {}); });
      }
    } else {
      await incrementViewCount(doc.id);
    }

    return res.send(buffer);
  } catch (err) {
    if (!isViewAction && !downloadCompleted) {
      await releaseDownloadReservation(doc.id).catch(() => {});
    }
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    console.error("Stream error:", err);
    res.status(500).json({ error: "Server error during file transfer: " + err.message });
  }
}

// Validate Access Code & Retrieve Document Info
app.post("/api/documents/access", accessLimiter, async (req, res) => {
  try {
    const { access_code } = req.body;

    if (!access_code || typeof access_code !== "string") {
      return res.status(400).json({ error: "Please enter an access code." });
    }

    const trimmedCode = access_code.trim();

    // Try HMAC hash first, then legacy SHA-256 hash
    let doc = await findDocumentByHash(hashCode(trimmedCode));
    if (!doc) {
      doc = await findDocumentByHash(legacyHashCode(trimmedCode));
    }
    if (!doc && /^[a-f0-9]{64}$/i.test(trimmedCode)) {
      doc = await findDocumentByHash(trimmedCode);
    }

    if (!doc) {
      return res.status(404).json({
        error: "Document not found. Please check your access code."
      });
    }

    // Check expiration
    if (doc.expires_at && new Date() > new Date(doc.expires_at)) {
      purgeExpiredDocuments().catch(() => {});
      return res.status(410).json({
        error: "This document has expired and was automatically deleted."
      });
    }

    // Check delete_after_download
    if (doc.delete_after_download && (doc.download_count || 0) >= 1) {
      return res.status(410).json({
        error: "This archive was configured to delete after its first download and is no longer available."
      });
    }

    // Check max_downloads limit
    if (doc.max_downloads != null && (doc.download_count || 0) >= doc.max_downloads) {
      return res.status(410).json({
        error: `Maximum download limit (${doc.max_downloads} downloads) has been reached for this archive.`
      });
    }

    let isText = false;
    let textPreview = null;
    let singleFileName = doc.original_name;
    let singleFileMime = doc.mime_type;
    let fileCount = doc.file_count || 1;

    try {
      const buffer = await getDocumentBuffer(doc.storage_key);
      const isZip =
        (doc.storage_key && doc.storage_key.endsWith(".zip")) ||
        (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b);

      if (isZip) {
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries().filter((e) => !e.isDirectory);
        fileCount = entries.length;
        if (entries.length === 1) {
          const entry = entries[0];
          singleFileName = entry.entryName.replace(/^(\d+_)+/, "");
          singleFileMime = getMimeType(singleFileName);
          if (
            singleFileName.toLowerCase().endsWith(".txt") ||
            (singleFileMime && singleFileMime.includes("text/"))
          ) {
            isText = true;
            textPreview = entry.getData().toString("utf8");
          }
        }
      } else {
        const isTxtExt = path.extname(doc.original_name).toLowerCase() === ".txt";
        const isTextMime = doc.mime_type && doc.mime_type.includes("text/plain");
        if (isTxtExt || isTextMime) {
          isText = true;
          textPreview = buffer.toString("utf8");
        }
      }
    } catch (readErr) {
      console.warn("[Access Buffer Inspection Warning]", readErr.message);
    }

    // Track view count
    await incrementViewCount(doc.id);

    const encodedCode = encodeURIComponent(trimmedCode);

    res.json({
      success: true,
      document: {
        id: doc.id,
        original_name: singleFileName,
        archive_name: doc.original_name,
        mime_type: singleFileMime,
        file_size: doc.file_size,
        file_count: fileCount,
        storage_mode: doc.storage_mode || "online",
        max_downloads: doc.max_downloads,
        download_count: doc.download_count || 0,
        active_downloads: doc.active_downloads || 0,
        delete_after_download: Boolean(doc.delete_after_download),
        expires_at: doc.expires_at,
        created_at: doc.created_at,
        view_count: (doc.view_count || 0) + 1,
        is_text: isText,
        text_content: textPreview,
        enteredCode: trimmedCode,
        download_url: `/api/documents/download/${encodedCode}?action=download`,
        view_url: `/api/documents/view/${encodedCode}`
      }
    });
  } catch (err) {
    console.error("Access error:", err);
    res.status(500).json({ error: "Server error while validating access code." });
  }
});

// Common handler for document download and in-browser view
async function handleDownloadOrView(req, res) {
  try {
    let rawCode = req.params.access_code;
    if (!rawCode || rawCode === "undefined" || rawCode === "null") {
      rawCode = req.query.code;
    }

    if (!rawCode || typeof rawCode !== "string") {
      return res.status(400).json({ error: "Access code is required." });
    }

    const trimmed = rawCode.trim();
    let doc = null;

    if (isValidCodeFormat(trimmed)) {
      doc = await findDocumentByHash(hashCode(trimmed));
      if (!doc) {
        doc = await findDocumentByHash(legacyHashCode(trimmed));
      }
    } else if (/^[a-f0-9]{64}$/i.test(trimmed)) {
      doc = await findDocumentByHash(trimmed);
    }

    // Check if rawCode is actually a numeric document ID
    if (!doc && /^\d+$/.test(trimmed)) {
      const byId = await findDocumentById(trimmed);
      if (byId) {
        let authorized = false;
        if (req.user && byId.owner_id && Number(req.user.id) === Number(byId.owner_id)) {
          authorized = true;
        } else if (req.query.code) {
          const qc = req.query.code.trim();
          if (hashCode(qc) === byId.access_code_hash || legacyHashCode(qc) === byId.access_code_hash) {
            authorized = true;
          }
        } else if (!byId.access_code_hash) {
          authorized = true;
        }
        if (authorized) {
          doc = byId;
        }
      }
    }

    // Fallback search if regex check didn't match
    if (!doc) {
      doc = await findDocumentByHash(hashCode(trimmed));
      if (!doc) {
        doc = await findDocumentByHash(legacyHashCode(trimmed));
      }
    }

    // Check query param code if still not found
    if (!doc && req.query.code) {
      const qTrimmed = req.query.code.trim();
      doc = await findDocumentByHash(hashCode(qTrimmed));
      if (!doc) {
        doc = await findDocumentByHash(legacyHashCode(qTrimmed));
      }
    }

    if (!doc) {
      return res.status(404).json({ error: "Document not found. Please check your access code." });
    }

    await streamDocumentToResponse(doc, req, res);
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    console.error("Download/View error:", err);
    res.status(500).json({ error: "Server error during file download/view." });
  }
}

// Routes for both download and view
app.get("/api/documents/download/:access_code", optionalAuth, handleDownloadOrView);
app.get("/api/documents/download", optionalAuth, handleDownloadOrView);
app.get("/api/documents/view/:access_code", optionalAuth, handleDownloadOrView);
app.get("/api/documents/view", optionalAuth, handleDownloadOrView);

// Dedicated owner direct download and view routes (no access code required for owner)
app.get("/api/documents/owner/:id/view", requireAuth, async (req, res) => {
  try {
    const doc = await findDocumentById(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: "Document not found." });
    }
    if (doc.owner_id && Number(doc.owner_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Unauthorized access to document." });
    }
    req.query.action = "view";
    await streamDocumentToResponse(doc, req, res);
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    console.error("Owner view error:", err);
    res.status(500).json({ error: "Server error during file view." });
  }
});

app.get("/api/documents/owner/:id/download", requireAuth, async (req, res) => {
  try {
    const doc = await findDocumentById(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: "Document not found." });
    }
    if (doc.owner_id && Number(doc.owner_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Unauthorized access to document." });
    }
    req.query.action = "download";
    await streamDocumentToResponse(doc, req, res);
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    console.error("Owner download error:", err);
    res.status(500).json({ error: "Server error during file download." });
  }
});

// Direct Retrieve Endpoint via POST (Matching Step 9 of Architecture Guide)
app.post("/api/documents/retrieve", accessLimiter, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== "string" || !isValidCodeFormat(code.trim())) {
      return res.status(404).json({ message: "Document not found or expired." });
    }

    const trimmed = code.trim();
    let doc = await findDocumentByHash(hashCode(trimmed));
    if (!doc) {
      doc = await findDocumentByHash(legacyHashCode(trimmed));
    }

    if (!doc) {
      return res.status(404).json({ message: "Document not found or expired." });
    }

    await streamDocumentToResponse(doc, req, res);
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    console.error("Retrieve error:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// Edit / Update Document (Requires Authentication)
app.put("/api/documents/:id", requireAuth, async (req, res) => {
  try {
    const docId = req.params.id;
    const doc = await findDocumentById(docId);
    if (!doc) {
      return res.status(404).json({ error: "Document not found." });
    }
    if (doc.owner_id && Number(doc.owner_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You do not have permission to edit this document." });
    }

    const { name, title, expiry, text, storage_mode, max_downloads, delete_after_download } = req.body;
    let newName = (name || title || "").trim();
    if (newName) {
      const originalExt = path.extname(doc.original_name);
      if (originalExt && !path.extname(newName)) {
        newName = `${newName}${originalExt}`;
      }
    } else {
      newName = doc.original_name;
    }

    let newExpiresAt = doc.expires_at;
    if (expiry !== undefined) {
      newExpiresAt = calculateExpiresAt(expiry);
    }

    let newFileSize = doc.file_size;
    const isTextDoc = (doc.mime_type && doc.mime_type.includes("text")) || doc.original_name.endsWith(".txt");
    if (isTextDoc && typeof text === "string") {
      newFileSize = Buffer.byteLength(text, "utf8");
      const filePath = path.join(UPLOADS_DIR, doc.storage_key);
      try {
        fs.writeFileSync(filePath, text, "utf8");
      } catch (fsErr) {
        console.warn("[Local File Update Warning]", fsErr.message);
      }
      if (isB2Configured()) {
        try {
          await uploadToB2({
            key: doc.storage_key,
            body: Buffer.from(text, "utf8"),
            contentType: doc.mime_type || "text/plain; charset=utf-8",
            contentLength: newFileSize,
          });
        } catch (b2Err) {
          console.warn("[B2 File Update Warning]", b2Err.message);
        }
      }
    }

    const updated = await updateDocument(doc.id, req.user.id, {
      original_name: newName,
      expires_at: newExpiresAt,
      file_size: newFileSize,
      storage_mode: storage_mode,
      max_downloads: max_downloads,
      delete_after_download: delete_after_download,
    });

    res.json({
      success: true,
      message: "Document updated successfully.",
      document: updated,
    });
  } catch (err) {
    console.error("Update document error:", err);
    res.status(500).json({ error: "Failed to update document." });
  }
});

// Delete Document (Requires Authentication)
app.delete("/api/documents/:id", requireAuth, async (req, res) => {
  try {
    const docId = req.params.id;
    const doc = await findDocumentById(docId);
    if (!doc) {
      return res.status(404).json({ error: "Document not found." });
    }
    if (doc.owner_id && Number(doc.owner_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You do not have permission to delete this document." });
    }

    if (doc.active_downloads > 0) {
      return res.status(409).json({
        error: "Document currently has an active download in progress. Please retry in a few moments."
      });
    }

    // Delete from Backblaze B2
    if (isB2Configured()) {
      try {
        await deleteFromB2({ key: doc.storage_key });
      } catch (b2Err) {
        if (b2Err.name !== "NoSuchKey" && b2Err.$metadata?.httpStatusCode !== 404) {
          console.warn("[B2 Delete Warning]", b2Err.message);
        }
      }
    }

    // Delete local storage file if exists
    const filePath = path.join(UPLOADS_DIR, doc.storage_key);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (fsErr) {
        console.warn("[Local File Delete Warning]", fsErr.message);
      }
    }

    // Delete from TiDB Cloud
    await deleteDocument(doc.id, req.user.id);

    res.json({
      success: true,
      message: "Document deleted successfully.",
      id: doc.id,
    });
  } catch (err) {
    console.error("Delete document error:", err);
    res.status(500).json({ error: "Failed to delete document." });
  }
});

// Automatic Cleanup: Purge expired documents from TiDB Cloud, Backblaze B2, and disk
let isPurging = false;
async function purgeExpiredDocuments() {
  if (isPurging) return 0;
  isPurging = true;
  try {
    const cleanableDocs = await findCleanableDocuments();
    if (!cleanableDocs || cleanableDocs.length === 0) return 0;

    console.log(`[Auto-Purge] Found ${cleanableDocs.length} cleanable document(s). Processing...`);

    for (const doc of cleanableDocs) {
      // 1. Delete physical file from Backblaze B2
      if (isB2Configured() && doc.storage_key) {
        try {
          await deleteFromB2({ key: doc.storage_key });
          console.log(`[Auto-Purge] Deleted B2 object: ${doc.storage_key}`);
        } catch (b2Err) {
          if (b2Err.name !== "NoSuchKey" && b2Err.$metadata?.httpStatusCode !== 404) {
            console.warn(`[Auto-Purge B2 Warning] ${doc.storage_key}:`, b2Err.message);
          }
        }
      }

      // 2. Delete local storage file if present
      if (doc.storage_key) {
        const filePath = path.join(UPLOADS_DIR, doc.storage_key);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (_) {}
        }
      }
    }

    // 3. Purge records from database
    const expiredIds = cleanableDocs.map((d) => d.id);
    await deleteExpiredDocumentRecords(expiredIds);
    console.log(`[Auto-Purge] Successfully deleted ${expiredIds.length} document record(s) from database.`);
    return expiredIds.length;
  } catch (err) {
    console.error("[Auto-Purge Error]", err);
    return 0;
  } finally {
    isPurging = false;
  }
}

// GET /api/documents/mine - List the authenticated user's documents and Online Sharing status
app.get("/api/documents/mine", requireAuth, async (req, res) => {
  try {
    await purgeExpiredDocuments();
    const docs = await listUserDocuments(req.user.id, 50);
    const enrichedDocs = docs.map((doc) => {
      const codeParam = doc.access_code ? encodeURIComponent(doc.access_code) : "";
      return {
        ...doc,
        view_url: doc.access_code
          ? `/api/documents/view/${codeParam}`
          : `/api/documents/owner/${doc.id}/view`,
        download_url: doc.access_code
          ? `/api/documents/download/${codeParam}?action=download`
          : `/api/documents/owner/${doc.id}/download`,
        owner_view_url: `/api/documents/owner/${doc.id}/view`,
        owner_download_url: `/api/documents/owner/${doc.id}/download`
      };
    });
    res.json({
      success: true,
      documents: enrichedDocs
    });
  } catch (err) {
    console.error("List mine error:", err);
    res.status(500).json({ error: "Failed to list user documents." });
  }
});

// GET /api/documents/status/:id - Return safe document status without exposing credentials
app.get("/api/documents/status/:id", requireAuth, async (req, res) => {
  try {
    const doc = await findDocumentById(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: "Document not found." });
    }
    if (doc.owner_id && Number(doc.owner_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Unauthorized access to document status." });
    }

    res.json({
      success: true,
      document: {
        id: doc.id,
        fileName: doc.original_name,
        fileCount: doc.file_count,
        fileSize: doc.file_size,
        storageMode: doc.storage_mode,
        downloadCount: doc.download_count,
        maxDownloads: doc.max_downloads,
        activeDownloads: doc.active_downloads,
        deleteAfterDownload: Boolean(doc.delete_after_download),
        expiresAt: doc.expires_at,
        createdAt: doc.created_at,
        status: doc.status,
      }
    });
  } catch (err) {
    console.error("Status error:", err);
    res.status(500).json({ error: "Failed to retrieve document status." });
  }
});

// Recent Documents list (Strictly private to the authenticated owner)
app.get("/api/documents/recent", optionalAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.json({
        success: true,
        documents: []
      });
    }

    // Automatically purge expired documents first
    await purgeExpiredDocuments();

    const docs = await listUserDocuments(req.user.id, 50);
    res.json({
      success: true,
      documents: docs
    });
  } catch (err) {
    console.error("List error:", err);
    res.status(500).json({ error: "Failed to list recent documents." });
  }
});

// Serve frontend static build if present (for single-server / VPS / PaaS deployment)
const FRONTEND_DIST = path.join(__dirname, "../frontend/dist");
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    res.sendFile(path.join(FRONTEND_DIST, "index.html"));
  });
}

// 404 handler for unmatched API routes or unhandled requests
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Start Server & Connect TiDB Cloud & Backblaze B2
async function startServer() {
  await initDatabase();
  await testB2Connection();

  // Run initial auto-purge of any expired documents
  await purgeExpiredDocuments();

  // Continuously auto-purge expired documents every 30 seconds
  setInterval(async () => {
    try {
      await purgeExpiredDocuments();
    } catch (e) {
      console.error("[Auto-Purge Cron Error]", e.message);
    }
  }, 30 * 1000);

  app.listen(PORT, HOST, () => {
    console.log(`[Secure Vault Backend] Running on http://${HOST}:${PORT}`);
  });
}

startServer();
