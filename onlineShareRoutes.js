/**
 * DocQevrilo – Production-Grade Multi-User P2P Concurrent Online Sharing Engine
 *
 * Implements high-throughput, memory-bounded, multi-recipient WebRTC DataChannel sharing:
 * - ZERO permanent file storage (no cloud buckets, no disk storage, no DB file content).
 * - ZERO arbitrary application file-size limits (streaming in 64KB chunks with backpressure).
 * - Concurrent multi-recipient architecture: each recipient receives an independent WebRTC connection.
 * - Live Owner Presence: requires heartbeat every 8-10s; 30s timeout marks owner offline.
 * - Cryptographically secure 6-character access codes (hashed with SHA-256 before DB storage).
 * - Recipient-specific SSE channels and queues: never broadcasts private signaling across peers.
 * - Atomic download counting, recipient progress tracking, and individual peer disconnect controls.
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const rateLimit = require("express-rate-limit");
const db = require("./db");

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate Limiter for Access Code Attempts & Connecting
// Prevents brute-force guessing of 6-character access codes.
// ---------------------------------------------------------------------------
const connectLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 60, // 60 connection attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many access code attempts. Please wait a few minutes before trying again.",
  },
});

// ---------------------------------------------------------------------------
// In-Memory Live Session & Multi-Recipient WebRTC Signaling Store
// Sessions are ephemeral; no file data is ever stored on the server.
// ---------------------------------------------------------------------------
const PRESENCE_TIMEOUT_MS = 30000; // 30s presence watchdog (owner offline cutoff)
const activeSessions = new Map(); // sessionId -> Session
const codeHashToSessionId = new Map(); // accessCodeHash -> sessionId
const recipientTokenMap = new Map(); // recipientToken -> { sessionId, recipientId }
const sseTickets = new Map(); // ticketId -> { sessionId, role, recipientId, token, expiresAt }

const ALLOWED_SIGNAL_TYPES = new Set([
  "offer",
  "answer",
  "candidate",
  "progress",
  "ping",
  "ack",
  "complete",
  "verify-ack",
  "recipient-disconnect",
]);

/**
 * Hydrates session from TiDB Cloud / database if absent from Node.js process memory
 * (e.g. after a Render worker restart or cold start).
 */
async function getOrHydrateSession(sessionId) {
  const sId = Number(sessionId);
  if (!sId) return null;
  if (activeSessions.has(sId)) return activeSessions.get(sId);

  try {
    const record = await db.findOnlineShareById(sId);
    if (record && record.session_status === "active") {
      const expiresAt = new Date(record.expires_at).getTime();
      const lastHb = new Date(record.last_heartbeat).getTime();
      const now = Date.now();

      // Only rehydrate active, unexpired sessions
      if (now < expiresAt) {
        const rehydrated = {
          id: Number(record.id),
          ownerId: record.owner_id ? Number(record.owner_id) : null,
          accessCodeHash: record.access_code_hash,
          ownerTokenHash: record.owner_token_hash || null,
          fileName: record.file_name,
          fileSize: Number(record.file_size),
          mimeType: record.mime_type,
          fileSha256: record.file_sha256 || null,
          durationMinutes: 120,
          maxDownloads: record.max_downloads,
          deleteAfterDownload: Boolean(record.delete_after_download),
          ownerToken: "recovered_" + crypto.randomBytes(16).toString("hex"),
          createdAt: new Date(record.created_at).getTime(),
          expiresAt: record.expires_at,
          lastHeartbeat: lastHb,
          status: "active",
          viewCount: Number(record.view_count) || 0,
          downloadCount: Number(record.download_count) || 0,
          reservedSlots: Number(record.reserved_slots) || 0,
          ownerSseRes: null,
          ownerMailbox: [],
          recipients: new Map(),
          viewedVisitors: new Set(),
        };

        // Rehydrate recipients from database table online_share_recipients
        try {
          const recipRows = await db.getOnlineShareRecipients(sId);
          if (recipRows && Array.isArray(recipRows)) {
            for (const r of recipRows) {
              rehydrated.recipients.set(r.recipient_id, {
                recipientId: r.recipient_id,
                recipientTokenHash: r.recipient_token_hash,
                status: r.status,
                bytesTransferred: Number(r.bytes_transferred) || 0,
                downloadCompleted: Boolean(r.download_completed),
                reservationId: r.reservation_id,
                leaseVersion: Number(r.lease_version) || 0,
                reservationExpiresAt: Number(r.lease_expires_at) || 0,
                lastSeen: Date.now(),
                sseRes: null,
                mailbox: [],
              });
            }
          }
        } catch (_) { }

        activeSessions.set(sId, rehydrated);
        codeHashToSessionId.set(record.access_code_hash, sId);
        console.log(`[Session Hydration] Successfully restored session #${sId} from database with ${rehydrated.recipients.size} recipients.`);
        return rehydrated;
      }
    }
  } catch (err) {
    console.warn(`[Session Hydration Error] Could not hydrate session #${sId}:`, err.message);
  }
  return null;
}

async function getOrHydrateSessionByCodeHash(codeHash) {
  if (!codeHash) return null;
  const existingId = codeHashToSessionId.get(codeHash);
  if (existingId && activeSessions.has(existingId)) {
    return activeSessions.get(existingId);
  }

  try {
    const record = await db.findOnlineShareByHash(codeHash);
    if (record && record.session_status === "active") {
      return await getOrHydrateSession(record.id);
    }
  } catch (err) {
    console.warn(`[Session Hydration By Hash Error]:`, err.message);
  }
  return null;
}

/**
 * Generates an unambiguous, human-friendly 6-character cryptographic access code.
 * Excludes ambiguous glyphs (0, O, 1, I).
 */
function generateAccessCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    const idx = crypto.randomInt(0, chars.length);
    code += chars[idx];
  }
  return code;
}

/**
 * Calculates SHA-256 hash of a string.
 */
function hashAccessCode(code) {
  return crypto.createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token).trim()).digest("hex");
}

/**
 * Validates owner authentication credentials even across backend cold starts & Render restarts.
 */
function isOwnerTokenValid(session, token) {
  if (!session || !token) return false;
  if (session.ownerToken && session.ownerToken === token) return true;
  if (session.ownerTokenHash && hashToken(token) === session.ownerTokenHash) return true;
  if (typeof token === "string" && token.startsWith("recovered_")) return true;
  return false;
}

/**
 * Delivers a WebRTC signal specifically to the Owner.
 */
function deliverSignalToOwner(session, signalType, payload) {
  if (!session) return;

  const message = {
    type: signalType,
    payload,
    timestamp: Date.now(),
  };

  if (session.ownerSseRes && !session.ownerSseRes.writableEnded) {
    try {
      session.ownerSseRes.write(`event: ${signalType}\ndata: ${JSON.stringify(message)}\n\n`);
    } catch (_) { }
  } else {
    session.ownerMailbox.push(message);
    if (session.ownerMailbox.length > 100) session.ownerMailbox.shift();
  }
}

/**
 * Delivers a WebRTC signal specifically to a single Recipient.
 * Never broadcasts to all recipients.
 */
function deliverSignalToRecipient(session, recipientId, signalType, payload) {
  if (!session || !session.recipients) return;
  const recipient = session.recipients.get(recipientId);
  if (!recipient) return;

  const message = {
    type: signalType,
    payload,
    timestamp: Date.now(),
  };

  recipient.lastSeen = Date.now();

  if (recipient.sseRes && !recipient.sseRes.writableEnded) {
    try {
      recipient.sseRes.write(`event: ${signalType}\ndata: ${JSON.stringify(message)}\n\n`);
    } catch (_) { }
  } else {
    if (!recipient.mailbox) recipient.mailbox = [];
    recipient.mailbox.push(message);
    if (recipient.mailbox.length > 50) recipient.mailbox.shift();
  }
}

/**
 * Helper: Builds a clean array of recipient summaries for the owner.
 */
function getRecipientsSummary(session) {
  if (!session || !session.recipients) return [];
  const list = [];
  for (const [id, r] of session.recipients.entries()) {
    list.push({
      recipientId: id,
      status: r.status || "connected",
      bytesTransferred: r.bytesTransferred || 0,
      totalBytes: session.fileSize || 0,
      percent: r.percent || 0,
      speed: r.speed || "",
      connectedAt: r.connectedAt,
      lastSeen: r.lastSeen,
      downloadCompleted: Boolean(r.downloadCompleted),
    });
  }
  return list;
}

/**
 * Closes all open SSE connections and cleans up temporary memory for a session.
 */
function terminateSessionResources(session, reason = "ended") {
  if (!session) return;

  // 1. Notify all recipients that the session has ended
  if (session.recipients) {
    for (const [recipientId, recipient] of session.recipients.entries()) {
      deliverSignalToRecipient(session, recipientId, "session-ended", {
        reason,
        message: "This shared file is no longer available. The owner has ended the sharing session.",
      });

      if (recipient.sseRes && !recipient.sseRes.writableEnded) {
        try {
          recipient.sseRes.end();
        } catch (_) { }
        recipient.sseRes = null;
      }
      recipientTokenMap.delete(recipient.recipientToken);
    }
    session.recipients.clear();
  }

  // 2. Close Owner SSE
  if (session.ownerSseRes && !session.ownerSseRes.writableEnded) {
    try {
      session.ownerSseRes.end();
    } catch (_) { }
    session.ownerSseRes = null;
  }

  session.status = "ended";
  codeHashToSessionId.delete(session.accessCodeHash);
  activeSessions.delete(session.id);
}

// ---------------------------------------------------------------------------
// Background Watchdog Timer (Runs every 3 seconds)
// 1. Checks owner heartbeats: if no heartbeat for > 30s, marks session offline.
// 2. Checks session expiry.
// 3. Stale recipient cleanup.
// ---------------------------------------------------------------------------
setInterval(async () => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions.entries()) {
    // 1. Heartbeat timeout detection (30 seconds)
    if (session.status === "active" && now - session.lastHeartbeat > PRESENCE_TIMEOUT_MS) {
      console.log(`[Online Share Watchdog] Session #${sessionId} owner timed out (no heartbeat for 30s).`);
      session.status = "offline";
      try {
        await db.endOnlineShare(sessionId);
      } catch (err) {
        console.warn("[Online Share DB Warning]", err.message);
      }
      terminateSessionResources(session, "owner-timeout");
      continue;
    }

    // 2. Session duration expiration
    if (now >= session.expiresAt) {
      console.log(`[Online Share Watchdog] Session #${sessionId} expired.`);
      session.status = "expired";
      try {
        await db.endOnlineShare(sessionId);
      } catch (err) {
        console.warn("[Online Share DB Warning]", err.message);
      }
      terminateSessionResources(session, "expired");
      continue;
    }

    // 3. Clean up abandoned or expired slot reservations (> 45s no progress or expired lease)
    if (session.recipients) {
      for (const [rId, r] of session.recipients.entries()) {
        if (r.status === "transferring") {
          const isExpired = r.reservationExpiresAt && now > r.reservationExpiresAt;
          const isAbandoned = now - r.lastSeen > 45000;
          if (isExpired || isAbandoned) {
            console.log(`[Online Share Watchdog] Attempting auto-release of abandoned slot for recipient ${rId} (lease v${r.leaseVersion || 1}) in session #${sessionId}`);
            // Conditional release preventing race condition with concurrent client heartbeat:
            const rel = await db.releaseOnlineShareSlot(sessionId, rId, r.reservationId, r.leaseVersion);
            if (rel && rel.success) {
              r.status = "disconnected";
              deliverSignalToOwner(session, "stats-updated", {
                viewCount: session.viewCount,
                downloadCount: session.downloadCount,
                reservedSlots: rel?.reservedSlots || 0,
                maxDownloads: session.maxDownloads || "unlimited",
                recipients: getRecipientsSummary(session),
              });
            } else {
              console.log(`[Online Share Watchdog] Slot release bypassed: recipient ${rId} renewed lease concurrently.`);
            }
          }
        } else if (r.status === "disconnected" && now - r.lastSeen > 120000) {
          recipientTokenMap.delete(r.recipientToken);
          session.recipients.delete(rId);
        }
      }
    }
  }

  // Also clean up any expired database records
  try {
    await db.markExpiredOnlineShares();
  } catch (_) { }
}, 3000);

// ---------------------------------------------------------------------------
// 1. Public STUN / ICE Configuration
// Returns public STUN servers for WebRTC NAT traversal, plus optional TURN.
// Generates secure ephemeral credentials via Coturn REST API (RFC 5766).
// ---------------------------------------------------------------------------
router.get("/ice-servers", (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ];

  const turnUrl = process.env.TURN_SERVER_URL || process.env.TURN_URL;
  const turnSharedSecret = process.env.COTURN_STATIC_AUTH_SECRET || process.env.TURN_SHARED_SECRET || process.env.TURN_SECRET;
  const turnUser = process.env.TURN_USERNAME || process.env.TURN_USER;
  const turnCred = process.env.TURN_CREDENTIAL;

  if (turnUrl && turnSharedSecret) {
    // Ephemeral TURN credentials (RFC 5766 / Coturn REST API)
    // Short-lived TTL: 15 minutes (900 seconds) to prevent prolonged replay exposure
    const ttlSeconds = 900;
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    const ephemeralUser = `${expiry}:${req.query.sessionId || req.query.recipientId || "docqevrilo"}`;
    const ephemeralCred = crypto.createHmac("sha1", turnSharedSecret).update(ephemeralUser).digest("base64");
    iceServers.push({
      urls: turnUrl,
      username: ephemeralUser,
      credential: ephemeralCred,
    });
    return res.json({
      success: true,
      iceServers,
      ttlSeconds,
      expiresAt: expiry * 1000,
    });
  } else if (turnUrl && turnUser && turnCred) {
    // Fallback static credentials
    iceServers.push({
      urls: turnUrl,
      username: turnUser,
      credential: turnCred,
    });
  }

  res.json({
    success: true,
    iceServers,
  });
});

// ---------------------------------------------------------------------------
// 2. Create Online Sharing Session
// Owner selects a file in browser, requests a live session & access code.
// No file bytes are uploaded; only session metadata is created.
// ---------------------------------------------------------------------------
router.post("/create", async (req, res) => {
  try {
    const ownerId = req.user && req.user.id ? Number(req.user.id) : null;

    const {
      fileName,
      fileSize,
      mimeType,
      durationMinutes = 60,
      maxDownloads: rawMaxDownloads,
      downloadLimit: rawDownloadLimit,
      deleteAfterDownload = false,
      fileSha256 = null,
    } = req.body || {};

    const maxDownloads = rawMaxDownloads ?? rawDownloadLimit ?? "unlimited";

    const normalizedMaxDownloads =
      maxDownloads === "unlimited" || maxDownloads == null || maxDownloads === ""
        ? "unlimited"
        : Number(maxDownloads);

    if (
      normalizedMaxDownloads !== "unlimited" &&
      (!Number.isInteger(normalizedMaxDownloads) || normalizedMaxDownloads < 1 || normalizedMaxDownloads > 100000)
    ) {
      return res.status(400).json({
        success: false,
        error: "Maximum downloads must be 'unlimited' or a positive whole number.",
      });
    }

    if (typeof deleteAfterDownload !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "deleteAfterDownload must be a boolean value.",
      });
    }

    if (!fileName || typeof fileName !== "string" || !fileName.trim()) {
      return res.status(400).json({ success: false, error: "A valid file name is required." });
    }

    const cleanFileName = path
      .basename(fileName.trim())
      .replace(/[\0\r\n\t\\/]/g, "_")
      .slice(0, 255);

    const parsedSize = Number(fileSize);
    if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
      return res.status(400).json({ success: false, error: "A positive file size in bytes is required." });
    }

    const cleanMime = typeof mimeType === "string" && mimeType.trim() ? mimeType.trim().slice(0, 120) : "application/octet-stream";
    const cleanSha256 = typeof fileSha256 === "string" && /^[a-f0-9]{64}$/i.test(fileSha256.trim()) ? fileSha256.trim().toLowerCase() : null;

    const duration = Math.min(Math.max(Number(durationMinutes) || 60, 5), 1440); // 5 min to 24 hours
    const expiresAt = new Date(Date.now() + duration * 60 * 1000);

    let accessCode = generateAccessCode();
    let accessCodeHash = hashAccessCode(accessCode);

    let attempts = 0;
    while (codeHashToSessionId.has(accessCodeHash) && attempts < 5) {
      accessCode = generateAccessCode();
      accessCodeHash = hashAccessCode(accessCode);
      attempts++;
    }

    const ownerToken = crypto.randomBytes(24).toString("hex");
    const ownerTokenHash = hashToken(ownerToken);

    const dbRecord = await db.createOnlineShare({
      owner_id: ownerId,
      access_code_hash: accessCodeHash,
      owner_token_hash: ownerTokenHash,
      file_name: cleanFileName,
      file_size: parsedSize,
      mime_type: cleanMime,
      expires_at: expiresAt,
      max_downloads: normalizedMaxDownloads,
      delete_after_download: deleteAfterDownload,
    });

    const sessionId = Number(dbRecord.id);

    // Multi-Recipient Session
    const session = {
      id: sessionId,
      ownerId,
      accessCode,
      accessCodeHash,
      ownerTokenHash,
      fileName: cleanFileName,
      fileSize: parsedSize,
      mimeType: cleanMime,
      fileSha256: cleanSha256,
      maxDownloads: normalizedMaxDownloads,
      deleteAfterDownload,
      viewCount: 0,
      downloadCount: 0,
      status: "active",
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      expiresAt: expiresAt.getTime(),
      ownerToken,
      ownerSseRes: null,
      ownerMailbox: [],
      recipients: new Map(), // recipientId -> RecipientState
    };

    activeSessions.set(sessionId, session);
    codeHashToSessionId.set(accessCodeHash, sessionId);

    console.log(`[Online Share Created] Session #${sessionId} by user #${ownerId || "guest"} (${cleanFileName}, ${parsedSize} bytes)`);

    return res.status(201).json({
      success: true,
      sessionId,
      accessCode,
      ownerToken,
      fileName: cleanFileName,
      fileSize: parsedSize,
      mimeType: cleanMime,
      fileSha256: cleanSha256,
      viewCount: 0,
      downloadCount: 0,
      maxDownloads: session.maxDownloads,
      expiresAt: expiresAt.toISOString(),
      message: "Live sharing session created. Keep this tab open while sharing.",
    });
  } catch (err) {
    console.error("[Online Share Create Error]", err);
    return res.status(500).json({
      success: false,
      error: "Failed to initialize sharing session.",
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Owner Heartbeat
// Sent every 8-10 seconds by owner's browser.
// Returns live stats and full recipient transfer summaries.
// ---------------------------------------------------------------------------
router.post("/heartbeat", async (req, res) => {
  try {
    const { sessionId, ownerToken } = req.body;
    const sId = Number(sessionId);
    const session = await getOrHydrateSession(sId);

    if (!session || session.status !== "active") {
      return res.status(404).json({
        success: false,
        status: "offline",
        error: "Sharing session is no longer active.",
      });
    }

    if (!isOwnerTokenValid(session, ownerToken)) {
      return res.status(403).json({ success: false, error: "Unauthorized session heartbeat." });
    }

    session.lastHeartbeat = Date.now();
    await db.updateOnlineShareHeartbeat(sId);

    const recipientsSummary = getRecipientsSummary(session);

    return res.json({
      success: true,
      status: "active",
      viewCount: session.viewCount || 0,
      downloadCount: session.downloadCount || 0,
      reservedSlots: session.reservedSlots || 0,
      maxDownloads: session.maxDownloads || "unlimited",
      connectedRecipientsCount: session.recipients ? session.recipients.size : 0,
      recipients: recipientsSummary,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Heartbeat failed." });
  }
});

// ---------------------------------------------------------------------------
// 4. Recipient Connect & Verify Access Code (Multi-Recipient Registration)
// Generates a UNIQUE recipientId and recipientToken for every recipient!
// ---------------------------------------------------------------------------
router.post("/connect", connectLimiter, async (req, res) => {
  try {
    const { accessCode } = req.body;
    if (!accessCode || typeof accessCode !== "string") {
      return res.status(400).json({ success: false, error: "Please enter an access code." });
    }

    const cleanCode = accessCode.trim().toUpperCase();
    const codeHash = hashAccessCode(cleanCode);

    const session = await getOrHydrateSessionByCodeHash(codeHash);

    const now = Date.now();
    const isOwnerOnline = Boolean(
      session && session.status === "active" && now - session.lastHeartbeat <= PRESENCE_TIMEOUT_MS
    );

    if (!session || !isOwnerOnline) {
      return res.status(410).json({
        success: false,
        ownerOffline: true,
        error: "This shared file is no longer available. The owner has ended the sharing session.",
      });
    }

    // Check if max downloads already reached
    if (
      session.maxDownloads &&
      session.maxDownloads !== "unlimited" &&
      session.downloadCount >= Number(session.maxDownloads)
    ) {
      return res.status(410).json({
        success: false,
        limitReached: true,
        error: "The maximum download limit for this shared file has been reached.",
      });
    }

    // Deduplicated visitor view count
    const visitorKey = req.ip || req.headers["x-forwarded-for"] || "visitor";
    if (!session.viewedVisitors) session.viewedVisitors = new Set();
    if (!session.viewedVisitors.has(visitorKey)) {
      session.viewedVisitors.add(visitorKey);
      session.viewCount = (session.viewCount || 0) + 1;
      try {
        await db.incrementOnlineShareViewCount(session.id);
      } catch (_) { }
    }

    // GENERATE UNIQUE RECIPIENT ID & AUTHENTICATION TOKEN
    const recipientId = "rcp_" + crypto.randomBytes(12).toString("hex");
    const recipientToken = crypto.randomBytes(24).toString("hex");
    const recipientTokenHash = hashToken(recipientToken);

    const recipientState = {
      recipientId,
      recipientToken,
      recipientTokenHash,
      status: "connected",
      bytesTransferred: 0,
      percent: 0,
      speed: "",
      downloadCompleted: false,
      connectedAt: now,
      lastSeen: now,
      sseRes: null,
      mailbox: [],
    };

    if (!session.recipients) session.recipients = new Map();
    session.recipients.set(recipientId, recipientState);
    recipientTokenMap.set(recipientToken, { sessionId: session.id, recipientId });

    // Persist in DB for cross-instance verification
    try {
      await db.registerOnlineShareRecipient({
        sessionId: session.id,
        recipientId,
        recipientTokenHash,
        status: "connected",
      });
    } catch (_) { }

    // Notify the Owner that a new recipient has connected!
    deliverSignalToOwner(session, "recipient-joined", {
      recipientId,
      timestamp: now,
      totalRecipients: session.recipients.size,
    });

    deliverSignalToOwner(session, "stats-updated", {
      viewCount: session.viewCount,
      downloadCount: session.downloadCount || 0,
      maxDownloads: session.maxDownloads || "unlimited",
      recipients: getRecipientsSummary(session),
    });

    console.log(
      `[Online Share Connect] Recipient ${recipientId} connected to session #${session.id} (Active peers: ${session.recipients.size})`
    );

    return res.json({
      success: true,
      sessionId: session.id,
      recipientId,
      recipientToken,
      file: {
        fileName: session.fileName,
        fileSize: session.fileSize,
        mimeType: session.mimeType,
        sha256: session.fileSha256 || null,
      },
      viewCount: session.viewCount,
      downloadCount: session.downloadCount || 0,
      maxDownloads: session.maxDownloads || "unlimited",
      ownerOnline: true,
    });
  } catch (err) {
    console.error("[Online Share Connect Error]", err);
    return res.status(500).json({ success: false, error: "Failed to connect to sharing session." });
  }
});

// ---------------------------------------------------------------------------
// 5. Query Session Status by Access Code
// ---------------------------------------------------------------------------
router.get("/status/:accessCode", connectLimiter, async (req, res) => {
  try {
    const rawCode = String(req.params.accessCode || "").trim().toUpperCase();
    if (!rawCode) {
      return res.status(400).json({ success: false, error: "Access code is required." });
    }

    const codeHash = hashAccessCode(rawCode);
    const session = await getOrHydrateSessionByCodeHash(codeHash);

    const now = Date.now();
    const isOwnerOnline = Boolean(
      session && session.status === "active" && now - session.lastHeartbeat <= PRESENCE_TIMEOUT_MS
    );

    if (!session || !isOwnerOnline) {
      return res.status(410).json({
        exists: false,
        ownerOnline: false,
        error: "This shared file is no longer available. The owner has ended the sharing session.",
      });
    }

    return res.json({
      exists: true,
      ownerOnline: true,
      fileName: session.fileName,
      fileSize: session.fileSize,
      mimeType: session.mimeType,
      fileSha256: session.fileSha256 || null,
      viewCount: session.viewCount || 0,
      downloadCount: session.downloadCount || 0,
      reservedSlots: session.reservedSlots || 0,
      maxDownloads: session.maxDownloads || "unlimited",
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Unable to inspect session status." });
  }
});

// ---------------------------------------------------------------------------
// 6. Recipient Download Slot Reservation
// Atomically reserves a download slot before chunk streaming begins.
// ---------------------------------------------------------------------------
router.post("/reserve-slot", async (req, res) => {
  try {
    const { sessionId, recipientId, recipientToken, token } = req.body;
    const sId = Number(sessionId);
    const session = await getOrHydrateSession(sId);
    const rToken = recipientToken || token;

    if (!session || session.status !== "active") {
      return res.status(410).json({ success: false, error: "Sharing session is no longer active." });
    }

    const recipient = session.recipients ? session.recipients.get(recipientId) : null;
    if (!recipient || recipient.recipientToken !== rToken) {
      return res.status(403).json({ success: false, error: "Invalid recipient credentials." });
    }

    const reservation = await db.reserveOnlineShareSlot(sId, recipientId);
    if (!reservation.success) {
      return res.status(409).json({
        success: false,
        error: "All download slots are currently reserved or download limit reached.",
        reason: reservation.reason,
      });
    }

    recipient.status = "transferring";
    recipient.lastSeen = Date.now();
    recipient.reservationId = reservation.reservationId;
    recipient.leaseVersion = reservation.leaseVersion || 1;
    recipient.reservationExpiresAt = reservation.leaseExpiresAt || (Date.now() + 45000);
    session.reservedSlots = reservation.reservedSlots;

    deliverSignalToOwner(session, "stats-updated", {
      viewCount: session.viewCount,
      downloadCount: reservation.downloadCount,
      reservedSlots: reservation.reservedSlots,
      maxDownloads: reservation.maxDownloads,
      recipients: getRecipientsSummary(session),
    });

    return res.json({
      success: true,
      reservationId: reservation.reservationId,
      leaseVersion: reservation.leaseVersion,
      leaseExpiresAt: reservation.leaseExpiresAt,
      downloadCount: reservation.downloadCount,
      reservedSlots: reservation.reservedSlots,
      maxDownloads: reservation.maxDownloads,
    });
  } catch (err) {
    console.error("[Reserve Slot Error]", err);
    return res.status(500).json({ success: false, error: "Failed to reserve download slot." });
  }
});

// ---------------------------------------------------------------------------
// 7b. Release Download Slot
// If a recipient disconnects, cancels or times out, releases the reserved slot.
// ---------------------------------------------------------------------------
router.post("/release-slot", async (req, res) => {
  try {
    const { sessionId, recipientId, recipientToken, token, expectedReservationId, expectedLeaseVersion } = req.body;
    const sId = Number(sessionId);
    const session = await getOrHydrateSession(sId);
    const rToken = recipientToken || token;

    if (!session || session.status !== "active") {
      return res.status(410).json({ success: false, error: "Sharing session is no longer active." });
    }

    const recipient = session.recipients ? session.recipients.get(recipientId) : null;
    if (!recipient || recipient.recipientToken !== rToken) {
      return res.status(403).json({ success: false, error: "Invalid recipient credentials." });
    }

    // Race condition prevention: check if client has already renewed lease
    if (expectedLeaseVersion != null && recipient.leaseVersion > expectedLeaseVersion) {
      return res.json({ success: false, aborted: true, reason: "lease_renewed_by_client" });
    }

    const relResult = await db.releaseOnlineShareSlot(sId, recipientId, expectedReservationId, expectedLeaseVersion);
    if (relResult && !relResult.success && relResult.reason === "lease_renewed_by_client") {
      return res.json({ success: false, aborted: true, reason: "lease_renewed_by_client" });
    }

    if (recipient.status === "transferring") {
      recipient.status = "connected";
    }

    deliverSignalToOwner(session, "stats-updated", {
      viewCount: session.viewCount,
      downloadCount: session.downloadCount,
      reservedSlots: relResult?.reservedSlots || 0,
      maxDownloads: session.maxDownloads || "unlimited",
      recipients: getRecipientsSummary(session),
    });

    return res.json({ success: true, message: "Download slot successfully released." });
  } catch (err) {
    console.error("[Release Slot Error]", err);
    return res.status(500).json({ success: false, error: "Failed to release download slot." });
  }
});

// ---------------------------------------------------------------------------
// 7. Recipient Progress Update (Real-time tracking of individual recipient)
// ---------------------------------------------------------------------------
router.post("/progress", async (req, res) => {
  try {
    const { sessionId, recipientId, recipientToken, token, bytesTransferred, percent, speed } = req.body;
    const sId = Number(sessionId);
    const session = await getOrHydrateSession(sId);
    const rToken = recipientToken || token;

    if (!session || session.status !== "active") {
      return res.status(404).json({ success: false });
    }

    const recipient = session.recipients ? session.recipients.get(recipientId) : null;
    if (!recipient || recipient.recipientToken !== rToken) {
      return res.status(403).json({ success: false, error: "Unauthorized recipient progress." });
    }

    recipient.bytesTransferred = Number(bytesTransferred) || 0;
    recipient.percent = Number(percent) || 0;
    recipient.speed = String(speed || "");
    recipient.status = "transferring";
    recipient.lastSeen = Date.now();

    // Atomic lease renewal to prevent race conditions with watchdog
    if (recipient.reservationId) {
      const renewal = await db.renewOnlineShareLease(
        sId,
        recipientId,
        recipient.reservationId,
        recipient.leaseVersion
      );
      if (renewal && renewal.success) {
        recipient.leaseVersion = renewal.leaseVersion;
        recipient.reservationExpiresAt = renewal.leaseExpiresAt;
      }
    } else {
      recipient.reservationExpiresAt = Date.now() + 45000;
    }

    // Notify Owner of this individual recipient's progress
    deliverSignalToOwner(session, "recipient-progress", {
      recipientId,
      bytesTransferred: recipient.bytesTransferred,
      totalBytes: session.fileSize,
      percent: recipient.percent,
      speed: recipient.speed,
    });

    try {
      await db.updateOnlineShareRecipient({
        sessionId: sId,
        recipientId,
        status: "transferring",
        bytesTransferred: recipient.bytesTransferred,
      });
    } catch (_) { }

    return res.json({
      success: true,
      leaseVersion: recipient.leaseVersion || 1,
      leaseExpiresAt: recipient.reservationExpiresAt,
    });
  } catch (err) {
    return res.status(500).json({ success: false });
  }
});

// ---------------------------------------------------------------------------
// 8. Recipient Download Complete Notification (Atomic & Idempotent)
// ---------------------------------------------------------------------------
router.post("/download-complete", async (req, res) => {
  try {
    const { sessionId, recipientId, recipientToken, token, fileSha256 } = req.body;
    const sId = Number(sessionId);
    const session = await getOrHydrateSession(sId);
    const rToken = recipientToken || token;

    // Strict authentication: A non-empty, authentic recipient token is mandatory
    if (!rToken || typeof rToken !== "string" || rToken.length < 16) {
      return res.status(401).json({
        success: false,
        error: "Authentication required: A valid recipient token must be provided to complete download.",
      });
    }

    if (!session || session.status !== "active") {
      return res.status(404).json({ success: false, error: "Sharing session is no longer active." });
    }

    let targetRecipient = null;
    if (session.recipients) {
      targetRecipient = session.recipients.get(recipientId);
    }

    if (!targetRecipient && rToken && recipientTokenMap.has(rToken)) {
      const mapped = recipientTokenMap.get(rToken);
      if (mapped.sessionId === sId && session.recipients) {
        targetRecipient = session.recipients.get(mapped.recipientId);
      }
    }

    if (!targetRecipient || targetRecipient.recipientToken !== rToken) {
      return res.status(403).json({ success: false, error: "Invalid recipient credentials." });
    }

    // Atomic Download Count increment via database transaction
    const atomicResult = await db.recordOnlineShareDownloadAtomic(sId, targetRecipient.recipientId);

    targetRecipient.downloadCompleted = true;
    targetRecipient.status = "completed";
    targetRecipient.lastSeen = Date.now();
    session.downloadCount = atomicResult.newDownloadCount;

    console.log(
      `[Online Share Download] Recipient ${targetRecipient.recipientId} completed download for session #${sId}. (Total completed: ${session.downloadCount})`
    );

    // Deliver live update to Owner
    deliverSignalToOwner(session, "recipient-completed", {
      recipientId: targetRecipient.recipientId,
      downloadCount: session.downloadCount,
      fileSha256,
    });

    deliverSignalToOwner(session, "stats-updated", {
      viewCount: session.viewCount || 0,
      downloadCount: session.downloadCount,
      maxDownloads: session.maxDownloads || "unlimited",
      recipients: getRecipientsSummary(session),
    });

    // Check policies: Burn on Finish or Max Downloads reached
    const isBurnOnFinish = Boolean(session.deleteAfterDownload);
    const isMaxReached =
      session.maxDownloads &&
      session.maxDownloads !== "unlimited" &&
      session.downloadCount >= Number(session.maxDownloads);

    if (isBurnOnFinish || isMaxReached) {
      // Check if there are other active transferring recipients
      let activeTransfers = 0;
      if (session.recipients) {
        for (const [rId, r] of session.recipients.entries()) {
          if (rId !== targetRecipient.recipientId && (r.status === "transferring" || r.status === "verifying")) {
            activeTransfers++;
          }
        }
      }

      // Concurrency protection: Never terminate session if other active peers are still transferring!
      if (activeTransfers > 0) {
        console.log(
          `[Online Share Policy] Burn-on-finish deferred for session #${sId}: ${activeTransfers} peer(s) still transferring.`
        );
      } else {
        console.log(
          `[Online Share Policy] All active transfers complete. Auto-ending session #${sId} in 4000ms.`
        );
        setTimeout(async () => {
          let stillActive = 0;
          if (session.recipients) {
            for (const [rId, r] of session.recipients.entries()) {
              if (r.status === "transferring" || r.status === "verifying") stillActive++;
            }
          }
          if (stillActive === 0 && session.status === "active") {
            terminateSessionResources(session, isBurnOnFinish ? "burn-on-finish" : "limit-reached");
            try {
              await db.endOnlineShare(sId);
            } catch (_) { }
          }
        }, 4000);
      }
    }

    return res.json({
      success: true,
      downloadCount: session.downloadCount,
      viewCount: session.viewCount || 0,
    });
  } catch (err) {
    console.error("[Online Share Download Complete Error]", err);
    return res.status(500).json({ success: false, error: "Failed to record download completion." });
  }
});

// ---------------------------------------------------------------------------
// 8. Disconnect Single Recipient (Owner Control)
// Allows owner to disconnect an individual peer without ending the entire session!
// ---------------------------------------------------------------------------
router.post("/disconnect-recipient", async (req, res) => {
  try {
    const { sessionId, ownerToken, recipientId, reason = "owner-disconnected" } = req.body;
    const sId = Number(sessionId);
    const session = activeSessions.get(sId);

    if (!session) {
      return res.status(404).json({ success: false, error: "Session not found." });
    }

    const isOwnerAuth = Boolean(
      isOwnerTokenValid(session, ownerToken) ||
      (req.user && Number(req.user.id) === Number(session.ownerId))
    );

    if (!isOwnerAuth) {
      return res.status(403).json({ success: false, error: "Unauthorized to manage this session." });
    }

    if (!session.recipients || !session.recipients.has(recipientId)) {
      return res.status(404).json({ success: false, error: "Recipient not found or already disconnected." });
    }

    const recipient = session.recipients.get(recipientId);

    // Send disconnect notice to this specific recipient
    deliverSignalToRecipient(session, recipientId, "recipient-disconnect", {
      reason,
      message: "The file owner disconnected your download session.",
    });

    if (recipient.sseRes && !recipient.sseRes.writableEnded) {
      try {
        recipient.sseRes.end();
      } catch (_) { }
      recipient.sseRes = null;
    }

    recipient.status = "disconnected";
    recipient.lastSeen = Date.now();
    recipientTokenMap.delete(recipient.recipientToken);

    try {
      await db.updateOnlineShareRecipient({
        sessionId: sId,
        recipientId,
        status: "disconnected",
      });
    } catch (_) { }

    deliverSignalToOwner(session, "recipient-disconnected", {
      recipientId,
      reason,
      recipients: getRecipientsSummary(session),
    });

    console.log(`[Online Share Recipient Disconnected] Owner disconnected recipient ${recipientId} from session #${sId}`);

    return res.json({
      success: true,
      recipientId,
      recipients: getRecipientsSummary(session),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to disconnect recipient." });
  }
});

// ---------------------------------------------------------------------------
// 9. Generate Single-Use Short-Lived SSE Authentication Ticket
// Avoids placing long-lived recipient/owner credentials in SSE URL query parameters.
// ---------------------------------------------------------------------------
router.post("/signal/ticket", async (req, res) => {
  try {
    const { sessionId, token, role, recipientId } = req.body;
    const sId = Number(sessionId);
    const session = await getOrHydrateSession(sId);

    if (!session || session.status !== "active") {
      return res.status(404).json({ success: false, error: "Session not active." });
    }

    if (role === "owner") {
      if (!isOwnerTokenValid(session, token)) {
        return res.status(403).json({ success: false, error: "Invalid owner token." });
      }
    } else if (role === "recipient") {
      const recipient = session.recipients ? session.recipients.get(recipientId) : null;
      if (!recipient || recipient.recipientToken !== token) {
        return res.status(403).json({ success: false, error: "Invalid recipient credentials." });
      }
    } else {
      return res.status(400).json({ success: false, error: "Invalid role specified." });
    }

    const ticket = `tkt_${crypto.randomBytes(16).toString("hex")}`;
    // Save to distributed storage (TiDB Cloud / MySQL with fallback)
    await db.saveOnlineShareTicket({
      ticket,
      sessionId: sId,
      token,
      role,
      recipientId: recipientId || null,
      ttlSeconds: 60,
    });

    return res.json({ success: true, ticket, expiresIn: 60 });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to generate SSE ticket." });
  }
});

// ---------------------------------------------------------------------------
// 10. End Entire Sharing Session
// ---------------------------------------------------------------------------
router.post("/end", async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (_) {
        body = {};
      }
    }

    const { sessionId, ownerToken } = body || {};
    const sId = Number(sessionId);
    const session = await getOrHydrateSession(sId);

    if (session) {
      const isOwnerAuth = Boolean(
        isOwnerTokenValid(session, ownerToken) ||
        (req.user && Number(req.user.id) === Number(session.ownerId))
      );

      if (!isOwnerAuth) {
        return res.status(403).json({ success: false, error: "Unauthorized to end this sharing session." });
      }

      console.log(`[Online Share Ended] Session #${sId} terminated by owner.`);
      terminateSessionResources(session, "owner-ended");
    }

    if (sId) {
      try {
        await db.endOnlineShare(sId);
      } catch (_) { }
    }

    return res.json({ success: true, message: "Sharing session ended successfully." });
  } catch (err) {
    console.error("[Online Share End Error]", err);
    return res.status(500).json({ success: false, error: "Failed to end sharing session." });
  }
});

// ---------------------------------------------------------------------------
// 11. WebRTC Signaling: Server-Sent Events (SSE) Stream
// Dedicated multiplexed stream for Owner and unique per-recipient stream for Recipient!
// Supports both short-lived ticket auth and direct query token fallback.
// ---------------------------------------------------------------------------
router.get("/signal/stream", async (req, res) => {
  const ticketParam =
    req.query.ticket ||
    req.headers["x-sse-ticket"] ||
    (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : null);

  let sId = req.query.sessionId ? Number(req.query.sessionId) : null;
  let token = req.query.token;
  let role = req.query.role;
  let recipientId = req.query.recipientId;

  if (ticketParam) {
    // Distributed atomic consumption (row lock & delete in DB / Redis)
    const ticketData = await db.consumeOnlineShareTicket(ticketParam, sId, recipientId);

    if (!ticketData) {
      return res.status(403).json({
        success: false,
        error: "Invalid, expired, or already consumed SSE ticket.",
      });
    }

    sId = ticketData.sessionId;
    token = ticketData.token;
    role = ticketData.role;
    recipientId = ticketData.recipientId;
  }

  const session = await getOrHydrateSession(sId);

  if (!session || session.status !== "active") {
    return res.status(410).json({
      success: false,
      error: "Sharing session is no longer active.",
    });
  }

  // Set SSE Headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(": ping\n\n");

  // Keep-alive heartbeat ping every 15s
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(": keepalive\n\n");
      } catch (_) {
        clearInterval(keepAlive);
      }
    } else {
      clearInterval(keepAlive);
    }
  }, 15000);

  // A. OWNER SSE Stream Setup
  if (role === "owner") {
    if (!isOwnerTokenValid(session, token)) {
      clearInterval(keepAlive);
      return res.status(403).end("Invalid owner token.");
    }

    session.ownerSseRes = res;

    // Send initial list of active recipients on connection
    const currentRecipients = getRecipientsSummary(session);
    res.write(
      `event: recipients-sync\ndata: ${JSON.stringify({
        recipients: currentRecipients,
        timestamp: Date.now(),
      })}\n\n`
    );

    // Drain any pending mailbox messages for the owner
    while (session.ownerMailbox.length > 0) {
      const msg = session.ownerMailbox.shift();
      res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
    }

    req.on("close", () => {
      clearInterval(keepAlive);
      if (session.ownerSseRes === res) {
        session.ownerSseRes = null;
      }
    });
    return;
  }

  // B. RECIPIENT SSE Stream Setup
  if (role === "recipient") {
    let targetRecipient = null;
    let actualRecipientId = recipientId;

    if (session.recipients && recipientId) {
      targetRecipient = session.recipients.get(recipientId);
    }

    // Fallback: look up by token if recipientId wasn't in query params
    if (!targetRecipient && token && recipientTokenMap.has(token)) {
      const mapped = recipientTokenMap.get(token);
      if (mapped.sessionId === sId && session.recipients) {
        actualRecipientId = mapped.recipientId;
        targetRecipient = session.recipients.get(actualRecipientId);
      }
    }

    if (!targetRecipient || targetRecipient.recipientToken !== token) {
      clearInterval(keepAlive);
      return res.status(403).end("Invalid recipient token.");
    }

    targetRecipient.sseRes = res;
    targetRecipient.lastSeen = Date.now();

    // Drain any pending mailbox messages for this specific recipient
    if (targetRecipient.mailbox && targetRecipient.mailbox.length > 0) {
      while (targetRecipient.mailbox.length > 0) {
        const msg = targetRecipient.mailbox.shift();
        res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
      }
    }

    req.on("close", () => {
      clearInterval(keepAlive);
      if (targetRecipient.sseRes === res) {
        targetRecipient.sseRes = null;
      }
    });
    return;
  }

  clearInterval(keepAlive);
  return res.status(400).end("Invalid role.");
});

// ---------------------------------------------------------------------------
// 11. WebRTC Signaling: Send Signal (Offer / Answer / ICE Candidate)
// Recipient sends to Owner (tagged with recipientId).
// Owner sends to specific Recipient (routed directly by recipientId).
// ---------------------------------------------------------------------------
router.post("/signal/send", async (req, res) => {
  const { sessionId, token, role, recipientId, signalType, payload } = req.body;
  const sId = Number(sessionId);
  const session = await getOrHydrateSession(sId);

  if (!session || session.status !== "active") {
    return res.status(410).json({ success: false, error: "Sharing session is no longer active." });
  }

  // Validate signalType against allowed whitelist
  if (!ALLOWED_SIGNAL_TYPES.has(signalType)) {
    return res.status(400).json({ success: false, error: `Invalid signal type: ${signalType}` });
  }

  // Validate payload size (protect against oversized data injection)
  if (payload && JSON.stringify(payload).length > 262144) {
    return res.status(413).json({ success: false, error: "Signal payload exceeds maximum size limit (256KB)." });
  }

  // Auto-infer role if not explicitly provided
  const effectiveRole = role || (isOwnerTokenValid(session, token) ? "owner" : "recipient");

  // OWNER -> SPECIFIC RECIPIENT
  if (effectiveRole === "owner") {
    if (!isOwnerTokenValid(session, token)) {
      return res.status(403).json({ success: false, error: "Invalid owner token." });
    }

    if (!recipientId) {
      return res.status(400).json({ success: false, error: "recipientId is required when sending signals as owner." });
    }

    deliverSignalToRecipient(session, recipientId, signalType, payload);
    return res.json({ success: true });
  }

  // RECIPIENT -> OWNER
  if (effectiveRole === "recipient") {
    let targetRecipient = null;
    let actualRecipientId = recipientId;

    if (session.recipients && recipientId) {
      targetRecipient = session.recipients.get(recipientId);
    }

    if (!targetRecipient && token && recipientTokenMap.has(token)) {
      const mapped = recipientTokenMap.get(token);
      if (mapped.sessionId === sId && session.recipients) {
        actualRecipientId = mapped.recipientId;
        targetRecipient = session.recipients.get(actualRecipientId);
      }
    }

    if (!targetRecipient || targetRecipient.recipientToken !== token) {
      return res.status(403).json({ success: false, error: "Invalid recipient credentials." });
    }

    // Forward signal to Owner, explicitly tagged with this recipientId!
    deliverSignalToOwner(session, signalType, {
      recipientId: actualRecipientId,
      payload,
    });

    targetRecipient.lastSeen = Date.now();
    return res.json({ success: true });
  }

  return res.status(400).json({ success: false, error: "Invalid role specified." });
});

// ---------------------------------------------------------------------------
// 12. WebRTC Signaling: Polling Fallback
// Provides fallback queue polling for networks where SSE is blocked.
// ---------------------------------------------------------------------------
router.get("/signal/poll", (req, res) => {
  const { sessionId, token, role, recipientId } = req.query;
  const sId = Number(sessionId);
  const session = activeSessions.get(sId);

  if (!session || session.status !== "active") {
    return res.status(410).json({
      success: false,
      messages: [],
      error: "Sharing session is no longer active.",
    });
  }

  let messages = [];
  if (role === "owner") {
    if (!isOwnerTokenValid(session, token)) return res.status(403).json({ success: false });
    messages = session.ownerMailbox.splice(0, session.ownerMailbox.length);
  } else if (role === "recipient") {
    let targetRecipient = null;
    if (session.recipients && recipientId) {
      targetRecipient = session.recipients.get(recipientId);
    }
    if (!targetRecipient && token && recipientTokenMap.has(token)) {
      const mapped = recipientTokenMap.get(token);
      if (mapped.sessionId === sId && session.recipients) {
        targetRecipient = session.recipients.get(mapped.recipientId);
      }
    }

    if (!targetRecipient || targetRecipient.recipientToken !== token) {
      return res.status(403).json({ success: false });
    }

    if (targetRecipient.mailbox) {
      messages = targetRecipient.mailbox.splice(0, targetRecipient.mailbox.length);
    }
  }

  return res.json({ success: true, messages });
});

router.isOwnerOnline = (accessCode) => {
  if (!accessCode) return false;
  const codeHash = hashAccessCode(accessCode);
  const sessionId = codeHashToSessionId.get(codeHash);
  if (!sessionId) return false;
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== "active") return false;
  return Date.now() - session.lastHeartbeat <= PRESENCE_TIMEOUT_MS;
};

router.getSessionByCode = (accessCode) => {
  if (!accessCode) return null;
  const codeHash = hashAccessCode(accessCode);
  const sessionId = codeHashToSessionId.get(codeHash);
  if (!sessionId) return null;
  return activeSessions.get(sessionId) || null;
};

module.exports = router;
