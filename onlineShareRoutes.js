/**
 * DocQevrilo – Live Online Temporary File Sharing Engine
 *
 * Implements ephemeral browser-to-browser file streaming over WebRTC DataChannels:
 * - ZERO permanent file storage (no cloud buckets, no disk storage, no DB file content).
 * - ZERO arbitrary application file-size limits (streaming in 64KB chunks with backpressure).
 * - Live Owner Presence: requires heartbeat every 10s; 30s timeout marks owner offline.
 * - Cryptographically secure 6-character access codes (hashed with SHA-256 before DB storage).
 * - Real-time WebRTC signaling coordination via Server-Sent Events (SSE) and HTTP fallback.
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
  max: 30, // 30 connection attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many access code attempts. Please wait a few minutes before trying again.",
  },
});

// ---------------------------------------------------------------------------
// In-Memory Live Session & WebRTC Signaling Store
// Sessions are ephemeral; no file data is ever stored here.
// ---------------------------------------------------------------------------
const PRESENCE_TIMEOUT_MS = 15000; // 15s presence watchdog (owner offline cutoff)
const activeSessions = new Map(); // sessionId -> Session
const codeHashToSessionId = new Map(); // accessCodeHash -> sessionId

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

/**
 * Delivers a WebRTC signal (offer/answer/candidate/status) to a peer
 * using their open Server-Sent Events (SSE) connection, with queue fallback.
 */
function deliverSignal(session, targetRole, signalType, payload) {
  if (!session) return;

  const message = {
    type: signalType,
    payload,
    timestamp: Date.now(),
  };

  if (targetRole === "owner") {
    if (session.ownerSseRes && !session.ownerSseRes.writableEnded) {
      try {
        session.ownerSseRes.write(`event: ${signalType}\ndata: ${JSON.stringify(message)}\n\n`);
      } catch (_) {}
    } else {
      session.ownerMailbox.push(message);
      if (session.ownerMailbox.length > 50) session.ownerMailbox.shift();
    }
  } else if (targetRole === "recipient") {
    if (session.recipientSseRes && !session.recipientSseRes.writableEnded) {
      try {
        session.recipientSseRes.write(`event: ${signalType}\ndata: ${JSON.stringify(message)}\n\n`);
      } catch (_) {}
    } else {
      session.recipientMailbox.push(message);
      if (session.recipientMailbox.length > 50) session.recipientMailbox.shift();
    }
  }
}

/**
 * Closes all open SSE connections and cleans up temporary memory for a session.
 */
function terminateSessionResources(session, reason = "ended") {
  if (!session) return;

  deliverSignal(session, "recipient", "session-ended", {
    reason,
    message: "This shared file is no longer available. The owner has ended the sharing session.",
  });

  if (session.ownerSseRes && !session.ownerSseRes.writableEnded) {
    try {
      session.ownerSseRes.end();
    } catch (_) {}
    session.ownerSseRes = null;
  }

  if (session.recipientSseRes && !session.recipientSseRes.writableEnded) {
    try {
      session.recipientSseRes.end();
    } catch (_) {}
    session.recipientSseRes = null;
  }

  session.status = "ended";
  codeHashToSessionId.delete(session.accessCodeHash);
  activeSessions.delete(session.id);
}

// ---------------------------------------------------------------------------
// Background Watchdog Timer (Runs every 5 seconds)
// 1. Checks owner heartbeats: if no heartbeat for > 30s, marks session offline.
// 2. Checks session expiry.
// 3. Independent server verification of presence.
// ---------------------------------------------------------------------------
setInterval(async () => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions.entries()) {
    // 1. Heartbeat timeout detection (30 seconds)
    if (session.status === "active" && now - session.lastHeartbeat > PRESENCE_TIMEOUT_MS) {
      console.log(`[Online Share Watchdog] Session #${sessionId} owner timed out (no heartbeat for 15s).`);
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
    }
  }

  // Also clean up any expired database records
  try {
    await db.markExpiredOnlineShares();
  } catch (_) {}
}, 3000);

// ---------------------------------------------------------------------------
// 1. Public STUN / ICE Configuration
// Returns public STUN servers for WebRTC NAT traversal.
// ---------------------------------------------------------------------------
router.get("/ice-servers", (_req, res) => {
  res.json({
    success: true,
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ],
  });
});

// ---------------------------------------------------------------------------
// 2. Create Online Sharing Session
// Owner selects a file in browser, requests a live session & access code.
// No file bytes are uploaded; only session metadata is created.
// ---------------------------------------------------------------------------
router.post("/create", async (req, res) => {
  try {
    // 1. Identify user (supports authenticated accounts and guest live sharing)
    const ownerId = req.user && req.user.id ? Number(req.user.id) : null;

    const { fileName, fileSize, mimeType, durationMinutes = 60 } = req.body;

    // 2. Input validation & sanitization
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

    const duration = Math.min(Math.max(Number(durationMinutes) || 60, 5), 1440); // 5 min to 24 hours
    const expiresAt = new Date(Date.now() + duration * 60 * 1000);

    // 3. Generate Cryptographic Access Code & Owner Secret
    let accessCode = generateAccessCode();
    let accessCodeHash = hashAccessCode(accessCode);

    // Ensure collision resistance
    let attempts = 0;
    while (codeHashToSessionId.has(accessCodeHash) && attempts < 5) {
      accessCode = generateAccessCode();
      accessCodeHash = hashAccessCode(accessCode);
      attempts++;
    }

    const ownerToken = crypto.randomBytes(24).toString("hex");

    // 4. Save metadata in TiDB Cloud / Database (NEVER storing file contents)
    const dbRecord = await db.createOnlineShare({
      owner_id: ownerId,
      access_code_hash: accessCodeHash,
      file_name: cleanFileName,
      file_size: parsedSize,
      mime_type: cleanMime,
      expires_at: expiresAt,
    });

    const sessionId = Number(dbRecord.id);

    // 5. Initialize In-Memory Session
    const session = {
      id: sessionId,
      ownerId: ownerId,
      accessCode,
      accessCodeHash,
      fileName: cleanFileName,
      fileSize: parsedSize,
      mimeType: cleanMime,
      status: "active",
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      expiresAt: expiresAt.getTime(),
      ownerToken,
      recipientToken: null,
      ownerSseRes: null,
      recipientSseRes: null,
      ownerMailbox: [],
      recipientMailbox: [],
    };

    activeSessions.set(sessionId, session);
    codeHashToSessionId.set(accessCodeHash, sessionId);

    console.log(`[Online Share Created] Session #${sessionId} by user #${ownerId || "guest"} (${cleanFileName}, ${parsedSize} bytes)`);

    // Return the generated access code to the owner
    // Note: The database hash is NEVER exposed to the client
    return res.status(201).json({
      success: true,
      sessionId,
      accessCode,
      ownerToken,
      fileName: cleanFileName,
      fileSize: parsedSize,
      mimeType: cleanMime,
      expiresAt: expiresAt.toISOString(),
      message: "Live sharing session created. Keep this tab open while sharing.",
    });
  } catch (err) {
    console.error("[Online Share Create Error]", err);
    return res.status(500).json({ success: false, error: "Failed to initialize sharing session." });
  }
});

// ---------------------------------------------------------------------------
// 3. Owner Heartbeat
// Sent every 10 seconds by owner's browser.
// ---------------------------------------------------------------------------
router.post("/heartbeat", async (req, res) => {
  try {
    const { sessionId, ownerToken } = req.body;
    const sId = Number(sessionId);
    const session = activeSessions.get(sId);

    if (!session || session.status !== "active") {
      return res.status(404).json({
        success: false,
        status: "offline",
        error: "Sharing session is no longer active.",
      });
    }

    if (session.ownerToken !== ownerToken) {
      return res.status(403).json({ success: false, error: "Unauthorized session heartbeat." });
    }

    session.lastHeartbeat = Date.now();
    await db.updateOnlineShareHeartbeat(sId);

    return res.json({
      success: true,
      status: "active",
      recipientConnected: Boolean(session.recipientToken),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Heartbeat failed." });
  }
});

// ---------------------------------------------------------------------------
// 4. Recipient Connect & Verify Access Code
// Recipient enters code -> verifies owner is currently online.
// If owner is offline or session ended, returns clear offline message.
// ---------------------------------------------------------------------------
router.post("/connect", connectLimiter, async (req, res) => {
  try {
    const { accessCode } = req.body;
    if (!accessCode || typeof accessCode !== "string") {
      return res.status(400).json({ success: false, error: "Please enter an access code." });
    }

    const cleanCode = accessCode.trim().toUpperCase();
    const codeHash = hashAccessCode(cleanCode);

    const sessionId = codeHashToSessionId.get(codeHash);
    const session = sessionId ? activeSessions.get(sessionId) : null;

    // Verify presence: session must exist in memory, be 'active', and have heartbeat within last 30s
    const now = Date.now();
    const isOwnerOnline = Boolean(session && session.status === "active" && now - session.lastHeartbeat <= PRESENCE_TIMEOUT_MS);

    if (!session || !isOwnerOnline) {
      return res.status(410).json({
        success: false,
        ownerOffline: true,
        error: "This shared file is no longer available. The owner has ended the sharing session.",
      });
    }

    // Generate unique token for this recipient
    const recipientToken = crypto.randomBytes(24).toString("hex");
    session.recipientToken = recipientToken;

    // Notify the owner that a recipient is connecting
    deliverSignal(session, "owner", "recipient-connected", {
      recipientToken,
      timestamp: Date.now(),
    });

    console.log(`[Online Share Connect] Recipient connected to session #${session.id}`);

    return res.json({
      success: true,
      sessionId: session.id,
      recipientToken,
      file: {
        fileName: session.fileName,
        fileSize: session.fileSize,
        mimeType: session.mimeType,
      },
      ownerOnline: true,
    });
  } catch (err) {
    console.error("[Online Share Connect Error]", err);
    return res.status(500).json({ success: false, error: "Failed to connect to sharing session." });
  }
});

// ---------------------------------------------------------------------------
// 5. Query Session Status by Access Code
// Used by recipient UI to preview file info before downloading.
// ---------------------------------------------------------------------------
router.get("/status/:accessCode", connectLimiter, async (req, res) => {
  try {
    const rawCode = String(req.params.accessCode || "").trim().toUpperCase();
    if (!rawCode) {
      return res.status(400).json({ success: false, error: "Access code is required." });
    }

    const codeHash = hashAccessCode(rawCode);
    const sessionId = codeHashToSessionId.get(codeHash);
    const session = sessionId ? activeSessions.get(sessionId) : null;

    const now = Date.now();
    const isOwnerOnline = Boolean(session && session.status === "active" && now - session.lastHeartbeat <= PRESENCE_TIMEOUT_MS);

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
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Unable to inspect session status." });
  }
});

// ---------------------------------------------------------------------------
// 6. End Sharing Session
// Handles explicit button click or navigator.sendBeacon() when tab closes.
// ---------------------------------------------------------------------------
router.post("/end", async (req, res) => {
  try {
    let body = req.body;
    // Handle navigator.sendBeacon string payload if sent as text/plain
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (_) {
        body = {};
      }
    }

    const { sessionId, ownerToken } = body || {};
    const sId = Number(sessionId);
    const session = activeSessions.get(sId);

    if (session) {
      // Authorization check: only owner with secret ownerToken or owner's JWT can end session
      const isOwnerAuth = Boolean(
        (ownerToken && session.ownerToken === ownerToken) ||
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
      } catch (_) {}
    }

    return res.json({ success: true, message: "Sharing session ended successfully." });
  } catch (err) {
    console.error("[Online Share End Error]", err);
    return res.status(500).json({ success: false, error: "Failed to end sharing session." });
  }
});

// ---------------------------------------------------------------------------
// 7. WebRTC Signaling: Server-Sent Events (SSE) Stream
// Provides 0ms latency real-time signaling delivery for WebRTC offer/answer/ICE.
// ---------------------------------------------------------------------------
router.get("/signal/stream", (req, res) => {
  const { sessionId, token, role } = req.query;
  const sId = Number(sessionId);
  const session = activeSessions.get(sId);

  if (!session || session.status !== "active") {
    return res.status(410).json({
      success: false,
      error: "Sharing session is no longer active.",
    });
  }

  // Token validation
  if (role === "owner" && session.ownerToken !== token) {
    return res.status(403).json({ success: false, error: "Invalid owner token." });
  }
  if (role === "recipient" && session.recipientToken !== token) {
    return res.status(403).json({ success: false, error: "Invalid recipient token." });
  }

  // Establish SSE stream
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  // Send initial ping comment to confirm connection
  res.write(": ping\n\n");

  if (role === "owner") {
    session.ownerSseRes = res;
    // Drain any pending messages from mailbox
    while (session.ownerMailbox.length > 0) {
      const msg = session.ownerMailbox.shift();
      res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
    }
  } else if (role === "recipient") {
    session.recipientSseRes = res;
    // Drain any pending messages from mailbox
    while (session.recipientMailbox.length > 0) {
      const msg = session.recipientMailbox.shift();
      res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
    }
  }

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

  req.on("close", () => {
    clearInterval(keepAlive);
    if (role === "owner" && session.ownerSseRes === res) {
      session.ownerSseRes = null;
    } else if (role === "recipient" && session.recipientSseRes === res) {
      session.recipientSseRes = null;
    }
  });
});

// ---------------------------------------------------------------------------
// 8. WebRTC Signaling: Send Signal (Offer / Answer / ICE Candidate)
// ---------------------------------------------------------------------------
router.post("/signal/send", (req, res) => {
  const { sessionId, token, role, signalType, payload } = req.body;
  const sId = Number(sessionId);
  const session = activeSessions.get(sId);

  if (!session || session.status !== "active") {
    return res.status(410).json({ success: false, error: "Sharing session is no longer active." });
  }

  if (role === "owner") {
    if (session.ownerToken !== token) {
      return res.status(403).json({ success: false, error: "Invalid owner token." });
    }
    // Route from owner to recipient
    deliverSignal(session, "recipient", signalType, payload);
    return res.json({ success: true });
  }

  if (role === "recipient") {
    if (session.recipientToken !== token) {
      return res.status(403).json({ success: false, error: "Invalid recipient token." });
    }
    // Route from recipient to owner
    deliverSignal(session, "owner", signalType, payload);
    return res.json({ success: true });
  }

  return res.status(400).json({ success: false, error: "Invalid role specified." });
});

// ---------------------------------------------------------------------------
// 9. WebRTC Signaling: Polling Fallback
// Provides fallback queue polling for networks where SSE is blocked.
// ---------------------------------------------------------------------------
router.get("/signal/poll", (req, res) => {
  const { sessionId, token, role } = req.query;
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
    if (session.ownerToken !== token) return res.status(403).json({ success: false });
    messages = session.ownerMailbox.splice(0, session.ownerMailbox.length);
  } else if (role === "recipient") {
    if (session.recipientToken !== token) return res.status(403).json({ success: false });
    messages = session.recipientMailbox.splice(0, session.recipientMailbox.length);
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
  return (Date.now() - session.lastHeartbeat) <= PRESENCE_TIMEOUT_MS;
};

router.getSessionByCode = (accessCode) => {
  if (!accessCode) return null;
  const codeHash = hashAccessCode(accessCode);
  const sessionId = codeHashToSessionId.get(codeHash);
  if (!sessionId) return null;
  return activeSessions.get(sessionId) || null;
};

module.exports = router;
