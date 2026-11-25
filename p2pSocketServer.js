/**
 * DocQevrilo – Ephemeral Socket.IO WebRTC Signaling & Session Coordinator
 *
 * Security & Privacy Guarantees:
 * - ZERO file storage (no disk, no TiDB, no Backblaze B2).
 * - ZERO unlock secrets, salts, or AES keys ever sent to or stored on the backend.
 * - Authoritative server-side expiration, recipient limits, one-time access, and manual revocation.
 * - Strict state machine & per-socket role/membership authorization.
 * - Rate limiting & anti-enumeration generic error messages.
 */

const { Server } = require("socket.io");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const ALLOWED_STATES = new Set([
  "CREATED",
  "WAITING_FOR_RECIPIENT",
  "RECIPIENT_CONNECTED",
  "WAITING_FOR_APPROVAL",
  "APPROVED",
  "TRANSFERRING",
  "PAUSED",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
]);

const TERMINAL_STATES = new Set(["EXPIRED", "CANCELLED"]);

// Allowed state transitions
const STATE_TRANSITIONS = {
  CREATED: new Set(["WAITING_FOR_RECIPIENT", "EXPIRED", "CANCELLED", "FAILED"]),
  WAITING_FOR_RECIPIENT: new Set([
    "RECIPIENT_CONNECTED",
    "WAITING_FOR_APPROVAL",
    "EXPIRED",
    "CANCELLED",
    "FAILED",
  ]),
  RECIPIENT_CONNECTED: new Set([
    "WAITING_FOR_APPROVAL",
    "APPROVED",
    "WAITING_FOR_RECIPIENT",
    "EXPIRED",
    "CANCELLED",
    "FAILED",
  ]),
  WAITING_FOR_APPROVAL: new Set([
    "APPROVED",
    "WAITING_FOR_RECIPIENT",
    "RECIPIENT_CONNECTED",
    "EXPIRED",
    "CANCELLED",
    "FAILED",
  ]),
  APPROVED: new Set([
    "TRANSFERRING",
    "PAUSED",
    "COMPLETED",
    "WAITING_FOR_RECIPIENT",
    "EXPIRED",
    "CANCELLED",
    "FAILED",
  ]),
  TRANSFERRING: new Set([
    "PAUSED",
    "COMPLETED",
    "APPROVED",
    "WAITING_FOR_RECIPIENT",
    "EXPIRED",
    "CANCELLED",
    "FAILED",
  ]),
  PAUSED: new Set([
    "TRANSFERRING",
    "WAITING_FOR_RECIPIENT",
    "EXPIRED",
    "CANCELLED",
    "FAILED",
  ]),
  COMPLETED: new Set([
    "WAITING_FOR_RECIPIENT",
    "RECIPIENT_CONNECTED",
    "WAITING_FOR_APPROVAL",
    "APPROVED",
    "TRANSFERRING",
    "EXPIRED",
    "CANCELLED",
  ]),
  FAILED: new Set(["WAITING_FOR_RECIPIENT", "EXPIRED", "CANCELLED"]),
  EXPIRED: new Set([]),
  CANCELLED: new Set([]),
};

// Duration bounds: 1 minute to 24 hours
const MIN_DURATION_SEC = 60;
const MAX_DURATION_SEC = 24 * 60 * 60;
const ALLOWED_MAX_RECIPIENTS = new Set([1, 2, 5, 10]);

// Rate limiters per IP (in-memory sliding window)
const ipAttempts = new Map(); // ip -> { count, windowStart }
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_JOIN_ATTEMPTS_PER_WINDOW = 40;

function checkIpRateLimit(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  let rec = ipAttempts.get(key);
  if (!rec || now - rec.windowStart > RATE_WINDOW_MS) {
    rec = { count: 1, windowStart: now };
    ipAttempts.set(key, rec);
    return true;
  }
  rec.count += 1;
  return rec.count <= MAX_JOIN_ATTEMPTS_PER_WINDOW;
}

function isValidTransferId(transferId) {
  return (
    typeof transferId === "string" &&
    /^[A-Za-z0-9_-]{12,64}$/.test(transferId.trim())
  );
}

/**
 * Generates ICE server list (public STUN + optional TURN via env vars).
 * Supports coturn HMAC-SHA1 ephemeral credentials if TURN_SECRET is configured.
 */
function getIceServersConfig() {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const turnUrl = process.env.TURN_URL;
  const turnSecret = process.env.TURN_SECRET;
  const turnUser = process.env.TURN_USERNAME;
  const turnPass = process.env.TURN_PASSWORD;

  if (turnUrl) {
    if (turnSecret) {
      const ttl = 900; // 15 minutes
      const unixExpiry = Math.floor(Date.now() / 1000) + ttl;
      const username = `${unixExpiry}:docqevrilo_p2p`;
      const hmac = crypto.createHmac("sha1", turnSecret);
      hmac.update(username);
      const credential = hmac.digest("base64");
      iceServers.push({
        urls: turnUrl.split(",").map((u) => u.trim()).filter(Boolean),
        username,
        credential,
      });
    } else if (turnUser && turnPass) {
      iceServers.push({
        urls: turnUrl.split(",").map((u) => u.trim()).filter(Boolean),
        username: turnUser,
        credential: turnPass,
      });
    }
  }

  return iceServers;
}

function initP2PSocketServer(httpServer, { corsOriginCheck, jwtSecret }) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: corsOriginCheck || true,
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 512 * 1024, // 512KB max signaling payload (SDP/ICE only, never files)
    pingTimeout: 20000,
    pingInterval: 10000,
  });

  // Strictly ephemeral in-memory session store
  const sessions = new Map(); // transferId -> Session

  function transitionState(session, nextState) {
    if (!ALLOWED_STATES.has(nextState)) return false;
    if (session.status === nextState) return true;
    const allowed = STATE_TRANSITIONS[session.status];
    if (!allowed || !allowed.has(nextState)) {
      return false;
    }
    session.status = nextState;
    return true;
  }

  function destroySession(transferId, reason = "EXPIRED") {
    const session = sessions.get(transferId);
    if (!session) return;

    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    // Clear all recipient references & room state
    session.recipients.clear();
    sessions.delete(transferId);
  }

  function expireSession(transferId) {
    const session = sessions.get(transferId);
    if (!session) return;
    if (TERMINAL_STATES.has(session.status)) {
      destroySession(transferId);
      return;
    }

    session.status = "EXPIRED";
    const room = `p2p:${transferId}`;

    io.to(room).emit("p2p:expired", {
      transferId,
      status: "EXPIRED",
      message: "This sharing session has expired. All active transfers have been terminated.",
      expiredAt: Date.now(),
    });

    io.to(room).emit("p2p:session-ended", {
      transferId,
      reason: "EXPIRED",
    });

    // Force sockets to leave the temporary room
    io.in(room).socketsLeave(room);
    destroySession(transferId, "EXPIRED");
  }

  function cancelSession(transferId) {
    const session = sessions.get(transferId);
    if (!session) return;

    session.status = "CANCELLED";
    const room = `p2p:${transferId}`;

    io.to(room).emit("p2p:sharing-stopped", {
      transferId,
      status: "CANCELLED",
      message: "Sender stopped sharing. Active transfers have been terminated.",
      stoppedAt: Date.now(),
    });

    io.to(room).emit("p2p:session-ended", {
      transferId,
      reason: "CANCELLED",
    });

    io.in(room).socketsLeave(room);
    destroySession(transferId, "CANCELLED");
  }

  function isSessionExpired(session) {
    if (!session) return true;
    if (Date.now() >= session.expiresAt) {
      expireSession(session.transferId);
      return true;
    }
    return false;
  }

  function buildPublicRecipientsSummary(session) {
    const list = [];
    for (const r of session.recipients.values()) {
      list.push({
        recipientId: r.recipientId,
        status: r.status,
        approved: r.approved,
        joinedAt: r.joinedAt,
        progress: r.progress || 0,
      });
    }
    return list;
  }

  // Optional JWT authentication in Socket.IO handshake
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token && typeof token === "string" && jwtSecret) {
      try {
        const decoded = jwt.verify(token, jwtSecret);
        socket.user = {
          id: decoded.id,
          email: decoded.email,
          name: decoded.name || decoded.full_name,
        };
      } catch (_) {
        socket.user = null;
      }
    } else {
      socket.user = null;
    }
    socket.clientIp =
      socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      socket.handshake.address ||
      "unknown";
    next();
  });

  // Periodic authoritative expiration & time-sync sweep (every 5 seconds)
  const timeSyncInterval = setInterval(() => {
    const now = Date.now();
    for (const [transferId, session] of sessions.entries()) {
      if (now >= session.expiresAt) {
        expireSession(transferId);
      } else {
        io.to(`p2p:${transferId}`).emit("p2p:time-update", {
          transferId,
          remainingSeconds: Math.max(0, Math.ceil((session.expiresAt - now) / 1000)),
          expiresAt: session.expiresAt,
          serverTime: now,
        });
      }
    }
    // Prune stale rate-limit records
    for (const [ip, rec] of ipAttempts.entries()) {
      if (now - rec.windowStart > RATE_WINDOW_MS) {
        ipAttempts.delete(ip);
      }
    }
  }, 5000);

  if (timeSyncInterval.unref) timeSyncInterval.unref();

  io.on("connection", (socket) => {
    // -----------------------------------------------------------------------
    // 1. SENDER: Create Ephemeral Secure Session
    // -----------------------------------------------------------------------
    socket.on("p2p:create-session", (payload = {}, ack) => {
      try {
        if (!checkIpRateLimit(socket.clientIp)) {
          const err = { code: "RATE_LIMITED", message: "Too many requests. Please wait a moment." };
          socket.emit("p2p:error", err);
          return ack?.({ ok: false, error: err.message });
        }

        const {
          transferId,
          durationSeconds = 900,
          maxRecipients = 1,
          oneTimeAccess = false,
          fileCount = 1,
          totalSize = 0,
        } = payload;

        if (!isValidTransferId(transferId)) {
          const err = { code: "INVALID_TRANSFER_ID", message: "Invalid transfer ID format." };
          socket.emit("p2p:error", err);
          return ack?.({ ok: false, error: err.message });
        }

        if (sessions.has(transferId)) {
          const err = { code: "DUPLICATE_ID", message: "Transfer ID already exists. Please regenerate." };
          socket.emit("p2p:error", err);
          return ack?.({ ok: false, error: err.message });
        }

        const parsedDuration = Math.min(
          Math.max(parseInt(durationSeconds, 10) || 900, MIN_DURATION_SEC),
          MAX_DURATION_SEC
        );
        const parsedMaxRecipients = ALLOWED_MAX_RECIPIENTS.has(Number(maxRecipients))
          ? Number(maxRecipients)
          : 1;

        const createdAt = Date.now();
        const expiresAt = createdAt + parsedDuration * 1000;

        const session = {
          transferId,
          senderSocketId: socket.id,
          senderUserId: socket.user?.id || null,
          createdAt,
          expiresAt,
          durationSeconds: parsedDuration,
          maxRecipients: parsedMaxRecipients,
          oneTimeAccess: Boolean(oneTimeAccess),
          oneTimeConsumed: false,
          completedCount: 0,
          fileCount: Math.max(1, parseInt(fileCount, 10) || 1),
          totalSize: Math.max(0, Number(totalSize) || 0),
          status: "CREATED",
          recipients: new Map(), // recipientId -> { recipientId, socketId, status, approved, joinedAt, progress }
          socketToRecipient: new Map(), // socketId -> recipientId
          cleanupTimer: setTimeout(() => expireSession(transferId), parsedDuration * 1000 + 50),
        };

        if (session.cleanupTimer.unref) session.cleanupTimer.unref();

        transitionState(session, "WAITING_FOR_RECIPIENT");
        sessions.set(transferId, session);
        socket.join(`p2p:${transferId}`);
        socket.p2pRole = "sender";
        socket.p2pTransferId = transferId;

        const responseData = {
          transferId,
          status: session.status,
          createdAt,
          expiresAt,
          durationSeconds: parsedDuration,
          remainingSeconds: parsedDuration,
          maxRecipients: parsedMaxRecipients,
          oneTimeAccess: session.oneTimeAccess,
          iceServers: getIceServersConfig(),
        };

        socket.emit("p2p:session-created", responseData);
        return ack?.({ ok: true, ...responseData });
      } catch (err) {
        socket.emit("p2p:error", { code: "SERVER_ERROR", message: "Unable to create session." });
        return ack?.({ ok: false, error: "Unable to create session." });
      }
    });

    // -----------------------------------------------------------------------
    // 2. RECEIVER: Join Session & Request Access
    // -----------------------------------------------------------------------
    socket.on("p2p:join-session", (payload = {}, ack) => {
      try {
        if (!checkIpRateLimit(socket.clientIp)) {
          const msg = "Too many connection attempts. Please wait a few minutes.";
          socket.emit("p2p:error", { code: "RATE_LIMITED", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        const transferId = typeof payload.transferId === "string" ? payload.transferId.trim() : "";
        if (!isValidTransferId(transferId)) {
          const msg = "Invalid or expired transfer ID.";
          socket.emit("p2p:error", { code: "INVALID_SESSION", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        const session = sessions.get(transferId);
        if (!session) {
          const msg = "Invalid or expired transfer ID.";
          socket.emit("p2p:error", { code: "INVALID_SESSION", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        if (isSessionExpired(session)) {
          const msg = "This sharing session has expired.";
          socket.emit("p2p:error", { code: "EXPIRED", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        if (session.status === "CANCELLED") {
          const msg = "Sender has stopped sharing this session.";
          socket.emit("p2p:error", { code: "CANCELLED", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        if (session.oneTimeAccess && session.oneTimeConsumed) {
          const msg = "One-time access for this transfer has already been used.";
          socket.emit("p2p:error", { code: "ONE_TIME_CONSUMED", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        // Prevent sender from joining own session as recipient on same socket
        if (socket.id === session.senderSocketId) {
          const msg = "Cannot join your own session as a recipient on the same connection.";
          socket.emit("p2p:error", { code: "INVALID_ROLE", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        // Check active recipient limits (atomic in single-threaded Node event loop)
        const activeRecipientsCount = session.recipients.size;
        if (activeRecipientsCount >= session.maxRecipients) {
          const msg = "Recipient limit reached for this session.";
          socket.emit("p2p:error", { code: "RECIPIENT_LIMIT_REACHED", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        // If one-time access is enabled, also block new joins while an approved/transferring recipient is active
        if (session.oneTimeAccess && activeRecipientsCount >= 1) {
          const msg = "One-time access session already has an active recipient.";
          socket.emit("p2p:error", { code: "RECIPIENT_LIMIT_REACHED", message: msg });
          return ack?.({ ok: false, error: msg });
        }

        const recipientId = `rcp_${crypto.randomBytes(8).toString("hex")}`;
        const recipient = {
          recipientId,
          socketId: socket.id,
          userId: socket.user?.id || null,
          status: "WAITING_FOR_APPROVAL",
          approved: false,
          joinedAt: Date.now(),
          progress: 0,
        };

        session.recipients.set(recipientId, recipient);
        session.socketToRecipient.set(socket.id, recipientId);
        socket.join(`p2p:${transferId}`);
        socket.p2pRole = "recipient";
        socket.p2pTransferId = transferId;
        socket.p2pRecipientId = recipientId;

        if (session.status === "WAITING_FOR_RECIPIENT") {
          transitionState(session, "WAITING_FOR_APPROVAL");
        }

        const remainingSeconds = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000));

        // Notify sender
        io.to(session.senderSocketId).emit("p2p:recipient-joined", {
          transferId,
          recipientId,
          status: session.status,
          recipientCount: session.recipients.size,
          maxRecipients: session.maxRecipients,
          recipients: buildPublicRecipientsSummary(session),
        });

        io.to(session.senderSocketId).emit("p2p:access-requested", {
          transferId,
          recipientId,
          joinedAt: recipient.joinedAt,
        });

        const joinResponse = {
          transferId,
          recipientId,
          status: session.status,
          expiresAt: session.expiresAt,
          remainingSeconds,
          fileCount: session.fileCount,
          totalSize: session.totalSize,
          oneTimeAccess: session.oneTimeAccess,
          iceServers: getIceServersConfig(),
        };

        return ack?.({ ok: true, ...joinResponse });
      } catch (err) {
        socket.emit("p2p:error", { code: "SERVER_ERROR", message: "Unable to join session." });
        return ack?.({ ok: false, error: "Unable to join session." });
      }
    });

    // Receiver explicit access request event (idempotent notification)
    socket.on("p2p:request-access", (payload = {}) => {
      const transferId = payload.transferId || socket.p2pTransferId;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) return;

      const recipientId = session.socketToRecipient.get(socket.id);
      if (!recipientId) return;

      io.to(session.senderSocketId).emit("p2p:access-requested", {
        transferId,
        recipientId,
        requestedAt: Date.now(),
      });
    });

    // -----------------------------------------------------------------------
    // 3. SENDER: Approve or Reject Recipient
    // -----------------------------------------------------------------------
    socket.on("p2p:approve-recipient", (payload = {}, ack) => {
      const { transferId, recipientId } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) {
        return ack?.({ ok: false, error: "Session not found or expired." });
      }
      if (socket.id !== session.senderSocketId) {
        return ack?.({ ok: false, error: "Unauthorized." });
      }
      if (session.oneTimeAccess && session.oneTimeConsumed) {
        return ack?.({ ok: false, error: "One-time access already consumed." });
      }

      const recipient = session.recipients.get(recipientId);
      if (!recipient) {
        return ack?.({ ok: false, error: "Recipient disconnected or not found." });
      }

      recipient.approved = true;
      recipient.status = "APPROVED";
      transitionState(session, "APPROVED");

      io.to(recipient.socketId).emit("p2p:access-approved", {
        transferId,
        recipientId,
        status: "APPROVED",
        expiresAt: session.expiresAt,
        remainingSeconds: Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)),
      });

      io.to(session.senderSocketId).emit("p2p:access-approved", {
        transferId,
        recipientId,
        status: "APPROVED",
        recipients: buildPublicRecipientsSummary(session),
      });

      return ack?.({ ok: true });
    });

    socket.on("p2p:reject-recipient", (payload = {}, ack) => {
      const { transferId, recipientId, reason } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) {
        return ack?.({ ok: false, error: "Session not found or expired." });
      }
      if (socket.id !== session.senderSocketId) {
        return ack?.({ ok: false, error: "Unauthorized." });
      }

      const recipient = session.recipients.get(recipientId);
      if (!recipient) {
        return ack?.({ ok: false, error: "Recipient not found." });
      }

      io.to(recipient.socketId).emit("p2p:access-rejected", {
        transferId,
        recipientId,
        message: reason || "Sender rejected your access request.",
      });

      const recSocket = io.sockets.sockets.get(recipient.socketId);
      if (recSocket) {
        recSocket.leave(`p2p:${transferId}`);
        recSocket.p2pTransferId = null;
        recSocket.p2pRecipientId = null;
      }

      session.socketToRecipient.delete(recipient.socketId);
      session.recipients.delete(recipientId);

      if (session.recipients.size === 0) {
        transitionState(session, "WAITING_FOR_RECIPIENT");
      }

      io.to(session.senderSocketId).emit("p2p:recipient-joined", {
        transferId,
        recipientCount: session.recipients.size,
        maxRecipients: session.maxRecipients,
        recipients: buildPublicRecipientsSummary(session),
      });

      return ack?.({ ok: true });
    });

    // -----------------------------------------------------------------------
    // 4. WebRTC Signaling (SDP Offer, Answer, ICE Candidates)
    // Strictly requires approved recipient & active unexpired session.
    // -----------------------------------------------------------------------
    socket.on("p2p:webrtc-offer", (payload = {}) => {
      const { transferId, recipientId, sdp } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) return;
      if (socket.id !== session.senderSocketId) return;

      const recipient = session.recipients.get(recipientId);
      if (!recipient || !recipient.approved) return;

      io.to(recipient.socketId).emit("p2p:webrtc-offer", {
        transferId,
        recipientId,
        sdp,
      });
    });

    socket.on("p2p:webrtc-answer", (payload = {}) => {
      const { transferId, sdp } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) return;

      const recipientId = session.socketToRecipient.get(socket.id);
      const recipient = recipientId ? session.recipients.get(recipientId) : null;
      if (!recipient || !recipient.approved) return;

      io.to(session.senderSocketId).emit("p2p:webrtc-answer", {
        transferId,
        recipientId,
        sdp,
      });
    });

    socket.on("p2p:webrtc-ice-candidate", (payload = {}) => {
      const { transferId, recipientId, candidate } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) return;

      if (socket.id === session.senderSocketId) {
        const recipient = session.recipients.get(recipientId);
        if (!recipient || !recipient.approved) return;
        io.to(recipient.socketId).emit("p2p:webrtc-ice-candidate", {
          transferId,
          recipientId,
          candidate,
        });
      } else {
        const senderRecId = session.socketToRecipient.get(socket.id);
        const recipient = senderRecId ? session.recipients.get(senderRecId) : null;
        if (!recipient || !recipient.approved) return;
        io.to(session.senderSocketId).emit("p2p:webrtc-ice-candidate", {
          transferId,
          recipientId: senderRecId,
          candidate,
        });
      }
    });

    // -----------------------------------------------------------------------
    // 5. Transfer Lifecycle: Start, Progress, Pause, Resume, Complete
    // -----------------------------------------------------------------------
    socket.on("p2p:transfer-started", (payload = {}) => {
      const { transferId, recipientId } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) return;
      if (socket.id !== session.senderSocketId) return;

      const recipient = session.recipients.get(recipientId);
      if (!recipient || !recipient.approved) return;

      recipient.status = "TRANSFERRING";
      transitionState(session, "TRANSFERRING");

      io.to(recipient.socketId).emit("p2p:transfer-started", { transferId, recipientId });
    });

    socket.on("p2p:transfer-progress", (payload = {}) => {
      const { transferId, recipientId, percentage, bytesTransferred, totalBytes } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) return;
      if (socket.id !== session.senderSocketId) return;

      const recipient = session.recipients.get(recipientId);
      if (!recipient || !recipient.approved) return;

      recipient.progress = Math.min(100, Math.max(0, Number(percentage) || 0));
      io.to(recipient.socketId).emit("p2p:transfer-progress", {
        transferId,
        recipientId,
        percentage: recipient.progress,
        bytesTransferred,
        totalBytes,
      });
    });

    socket.on("p2p:pause-transfer", (payload = {}, ack) => {
      const { transferId, recipientId } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) {
        return ack?.({ ok: false, error: "Session not found or expired." });
      }
      if (socket.id !== session.senderSocketId) {
        return ack?.({ ok: false, error: "Unauthorized." });
      }

      transitionState(session, "PAUSED");
      if (recipientId && session.recipients.has(recipientId)) {
        const r = session.recipients.get(recipientId);
        r.status = "PAUSED";
        io.to(r.socketId).emit("p2p:transfer-paused", { transferId, recipientId });
      } else {
        for (const r of session.recipients.values()) {
          if (r.approved) {
            r.status = "PAUSED";
            io.to(r.socketId).emit("p2p:transfer-paused", { transferId, recipientId: r.recipientId });
          }
        }
      }
      io.to(session.senderSocketId).emit("p2p:transfer-paused", {
        transferId,
        status: session.status,
        recipients: buildPublicRecipientsSummary(session),
      });
      return ack?.({ ok: true });
    });

    socket.on("p2p:resume-transfer", (payload = {}, ack) => {
      const { transferId, recipientId } = payload;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) {
        return ack?.({ ok: false, error: "Session not found or expired." });
      }
      if (socket.id !== session.senderSocketId) {
        return ack?.({ ok: false, error: "Unauthorized." });
      }

      transitionState(session, "TRANSFERRING");
      if (recipientId && session.recipients.has(recipientId)) {
        const r = session.recipients.get(recipientId);
        r.status = "TRANSFERRING";
        io.to(r.socketId).emit("p2p:transfer-resumed", { transferId, recipientId });
      } else {
        for (const r of session.recipients.values()) {
          if (r.approved) {
            r.status = "TRANSFERRING";
            io.to(r.socketId).emit("p2p:transfer-resumed", { transferId, recipientId: r.recipientId });
          }
        }
      }
      io.to(session.senderSocketId).emit("p2p:transfer-resumed", {
        transferId,
        status: session.status,
        recipients: buildPublicRecipientsSummary(session),
      });
      return ack?.({ ok: true });
    });

    socket.on("p2p:transfer-completed", (payload = {}, ack) => {
      const transferId = payload.transferId || socket.p2pTransferId;
      const session = sessions.get(transferId);
      if (!session || isSessionExpired(session)) {
        return ack?.({ ok: false, error: "Session not found or expired." });
      }

      let recipientId = payload.recipientId;
      if (socket.id !== session.senderSocketId) {
        recipientId = session.socketToRecipient.get(socket.id);
      }
      const recipient = recipientId ? session.recipients.get(recipientId) : null;
      if (!recipient || !recipient.approved) {
        return ack?.({ ok: false, error: "Unauthorized." });
      }

      if (recipient.status !== "COMPLETED") {
        recipient.status = "COMPLETED";
        recipient.progress = 100;
        session.completedCount += 1;

        // Atomic one-time access enforcement
        if (session.oneTimeAccess) {
          session.oneTimeConsumed = true;
        }
      }

      transitionState(session, "COMPLETED");

      io.to(session.senderSocketId).emit("p2p:transfer-completed", {
        transferId,
        recipientId,
        completedCount: session.completedCount,
        oneTimeConsumed: session.oneTimeConsumed,
        recipients: buildPublicRecipientsSummary(session),
      });

      io.to(recipient.socketId).emit("p2p:transfer-completed", {
        transferId,
        recipientId,
      });

      return ack?.({ ok: true, oneTimeConsumed: session.oneTimeConsumed });
    });

    // -----------------------------------------------------------------------
    // 6. SENDER: Manual Stop Sharing (Immediate Revocation)
    // -----------------------------------------------------------------------
    socket.on("p2p:stop-sharing", (payload = {}, ack) => {
      const transferId = payload.transferId || socket.p2pTransferId;
      const session = sessions.get(transferId);
      if (!session) {
        return ack?.({ ok: true });
      }
      if (socket.id !== session.senderSocketId) {
        return ack?.({ ok: false, error: "Unauthorized." });
      }

      cancelSession(transferId);
      return ack?.({ ok: true });
    });

    // -----------------------------------------------------------------------
    // 7. RECEIVER: Leave Session & Disconnect Cleanup
    // -----------------------------------------------------------------------
    function handleRecipientLeave(leavingSocket) {
      const transferId = leavingSocket.p2pTransferId;
      if (!transferId) return;
      const session = sessions.get(transferId);
      if (!session) return;

      const recipientId = session.socketToRecipient.get(leavingSocket.id);
      if (!recipientId) return;

      session.socketToRecipient.delete(leavingSocket.id);
      session.recipients.delete(recipientId);
      leavingSocket.leave(`p2p:${transferId}`);
      leavingSocket.p2pTransferId = null;
      leavingSocket.p2pRecipientId = null;

      if (session.recipients.size === 0 && !TERMINAL_STATES.has(session.status)) {
        transitionState(session, "WAITING_FOR_RECIPIENT");
      }

      io.to(session.senderSocketId).emit("p2p:recipient-joined", {
        transferId,
        leftRecipientId: recipientId,
        recipientCount: session.recipients.size,
        maxRecipients: session.maxRecipients,
        status: session.status,
        recipients: buildPublicRecipientsSummary(session),
      });
    }

    socket.on("p2p:leave-session", () => {
      handleRecipientLeave(socket);
    });

    socket.on("disconnect", () => {
      const transferId = socket.p2pTransferId;
      if (!transferId) return;
      const session = sessions.get(transferId);
      if (!session) return;

      if (socket.id === session.senderSocketId) {
        // Sender disconnected -> terminate sharing immediately so no zombie room remains
        cancelSession(transferId);
      } else {
        handleRecipientLeave(socket);
      }
    });
  });

  // Expose internal state helpers for testing / health checks
  io.p2pGetActiveSessionCount = () => sessions.size;
  io.p2pHasSession = (id) => sessions.has(id);
  io.p2pGetSessionDebug = (id) => {
    const s = sessions.get(id);
    if (!s) return null;
    return {
      transferId: s.transferId,
      status: s.status,
      expiresAt: s.expiresAt,
      maxRecipients: s.maxRecipients,
      recipientCount: s.recipients.size,
      oneTimeAccess: s.oneTimeAccess,
      oneTimeConsumed: s.oneTimeConsumed,
    };
  };

  return io;
}

module.exports = {
  initP2PSocketServer,
  getIceServersConfig,
  isValidTransferId,
};
