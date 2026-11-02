/**
 * DocQevrilo DeepShield Web Application Firewall (WAF) & Runtime Security Engine
 *
 * Real-time protective perimeter for DocQevrilo:
 * - SQL Injection (SQLi) detection & neutralization
 * - Cross-Site Scripting (XSS) payload blocking
 * - Path Traversal & Local/Remote File Inclusion (LFI/RFI) defense
 * - Remote Code Execution (RCE) / Command Injection filtering
 * - Malicious exploit scanner & reconnaissance probe dropping (.env, wp-login, git, etc.)
 * - Known malicious bot & automated vulnerability scanner blacklisting
 * - Automated IP Reputation & Adaptive Auto-Ban (Jail) mechanism
 * - Real-time security telemetry & attack incident auditing
 */

const crypto = require("crypto");

// Configuration parameters
const MAX_VIOLATIONS_BEFORE_BAN = 3;
const VIOLATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const AUTO_BAN_DURATION_MS = 45 * 60 * 1000; // 45 minutes
const MAX_INSPECT_DEPTH = 5;
const MAX_RECENT_EVENTS = 100;

// Threat Telemetry State
const telemetry = {
  startTime: Date.now(),
  totalRequestsInspected: 0,
  totalAttacksBlocked: 0,
  blockedByType: {
    sqli: 0,
    xss: 0,
    pathTraversal: 0,
    commandInjection: 0,
    exploitProbe: 0,
    badBot: 0,
    bannedIp: 0,
    malformedInput: 0,
  },
  recentSecurityEvents: [],
};

// In-memory IP tracking stores
// ipViolations: Map<ip, { count: number, firstSeen: number, lastSeen: number, lastReason: string }>
const ipViolations = new Map();

// bannedIps: Map<ip, { bannedAt: number, expiresAt: number, reason: string, incidentId: string }>
const bannedIps = new Map();

// Whitelist for internal/health endpoints and legitimate static paths
const PATH_WHITELIST = new Set([
  "/api/health",
  "/health",
  "/favicon.ico",
  "/robots.txt",
  "/api/firewall/status",
]);

// 1. Exploit Scanners & Malicious Path Probes
const EXPLOIT_PATH_PATTERNS = [
  /^\/\.env(\.|$|\/)/i,
  /^\/\.git(\.|$|\/)/i,
  /^\/\.svn(\.|$|\/)/i,
  /^\/\.aws(\.|$|\/)/i,
  /^\/\.well-known\/(?!acme-challenge)/i,
  /\/(wp-config|wp-login|xmlrpc|wp-admin|wp-content)\b/i,
  /\/(phpmyadmin|pma|myadmin|adminer)\b/i,
  /\/(actuator|actuator\/health|swagger-ui|api-docs)\b/i,
  /\/(web\.config|server-status|server-info)\b/i,
  /\/(etc\/(passwd|shadow|hosts))\b/i,
  /\/(cgi-bin|solr|autodiscover)\b/i,
  /\/vendor\/phpunit\b/i,
];

// 2. Malicious Scanner & Bad Bot User-Agents
const BAD_BOT_PATTERN = /\b(sqlmap|nikto|nmap|masscan|dirbuster|gobuster|wpscan|nuclei|havij|burpcollaborator|acunetix|nessus|openvas|arachni|zgrab|morfeus|shodan|censys)\b/i;

// 3. Path Traversal & LFI/RFI Signatures
const PATH_TRAVERSAL_PATTERN = /(\.\.[\/\\]|%2e%2e[\/\\]|%252e%252e[\/\\]|\.\.%2f|\.\.%5c|\/etc\/(passwd|shadow)|c:\\windows\\(system32|win\.ini)|boot\.ini|php:\/\/|data:\/\/text|file:\/\/\/)/i;

// 4. SQL Injection Patterns
// Formulated to capture SQL syntax structures without falsely matching regular sentence prose
const SQLI_PATTERNS = [
  /\bunion(\s+all)?\s+select\b/i,
  /\bselect\s+[\s\S]+?\s+from\s+[\w\.]+/i,
  /\binsert\s+into\s+[\w\.]+\s*\(?/i,
  /\bdelete\s+from\s+[\w\.]+/i,
  /\bdrop\s+(table|database|procedure|trigger|view)\b/i,
  /\balter\s+table\s+[\w\.]+/i,
  /\bexec(\s+xp_|\s+sp_)\w+/i,
  /;\s*shutdown\b/i,
  /\b(sleep\s*\(\s*\d+\s*\)|benchmark\s*\(\s*\d+\s*,|waitfor\s+delay\b)/i,
  /\b(load_file|into\s+(out|dump)file)\s*\(/i,
  /(?:'\s*(?:or|and)\s*'\s*=\s*')|(?:\b(?:or|and)\b\s+(['"]?\w+['"]?)\s*=\s*\1)/i,
  /(?:'|\b)(?:or|and)\b\s+1\s*=\s*1\b/i,
];

// 5. Cross-Site Scripting (XSS) Patterns
const XSS_PATTERNS = [
  /<\s*script\b[\s\S]*?>/i,
  /<\s*\/\s*script\s*>/i,
  /(javascript|vbscript|livescript)\s*:/i,
  /data\s*:\s*text\/html/i,
  /<\s*(img|iframe|svg|body|input|audio|video|details|object|embed|link)\b[^>]+(onerror|onload|onclick|onmouseover|onfocus|onblur)\s*=/i,
  /\b(document\.cookie|document\.domain|window\.location\s*=|eval\s*\(|new\s+Function\s*\()/i,
];

// 6. Remote Code Execution (RCE) / Command Injection Patterns
const RCE_PATTERNS = [
  /(\||;|\&\&)\s*(cat\s+\/etc|rm\s+-rf|wget\s+https?:|curl\s+https?:|nc\s+-e|bash\s+-i|sh\s+-i|powershell\s+-enc)/i,
  /\$\(\s*(whoami|id|uname|cat\s+\/etc|curl\s+)/i,
  /`\s*(whoami|id|uname)\s*`/i,
];

/**
 * Extracts the real client IP address safely considering reverse proxies
 */
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const firstIp = forwarded.split(",")[0].trim();
    if (firstIp) return firstIp;
  }
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || req.ip || "127.0.0.1";
}

/**
 * Checks if an IP is currently banned/jailed
 */
function isIpBanned(ip) {
  const record = bannedIps.get(ip);
  if (!record) return false;

  if (Date.now() > record.expiresAt) {
    bannedIps.delete(ip);
    return false;
  }
  return true;
}

/**
 * Adds an attack event to the in-memory audit log
 */
function logSecurityEvent(type, ip, req, reason, payloadSample = "") {
  telemetry.totalAttacksBlocked++;
  if (telemetry.blockedByType[type] !== undefined) {
    telemetry.blockedByType[type]++;
  }

  const incidentId = `SEC-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const event = {
    incidentId,
    timestamp: new Date().toISOString(),
    type,
    ip,
    method: req.method,
    path: req.originalUrl || req.url,
    userAgent: (req.headers["user-agent"] || "").slice(0, 140),
    reason,
    payloadSnippet: String(payloadSample || "").slice(0, 120),
  };

  telemetry.recentSecurityEvents.unshift(event);
  if (telemetry.recentSecurityEvents.length > MAX_RECENT_EVENTS) {
    telemetry.recentSecurityEvents.pop();
  }

  console.warn(
    `[DocQevrilo WAF Blocked] [${incidentId}] Type=${type} IP=${ip} Path=${event.path} Reason=${reason}`
  );

  return incidentId;
}

/**
 * Records an IP violation strike and auto-bans if threshold exceeded
 */
function recordViolation(ip, type, reason, req, immediateBan = false) {
  const incidentId = logSecurityEvent(type, ip, req, reason);

  if (immediateBan) {
    bannedIps.set(ip, {
      bannedAt: Date.now(),
      expiresAt: Date.now() + AUTO_BAN_DURATION_MS,
      reason: `Immediate Auto-Ban: ${reason}`,
      incidentId,
    });
    return incidentId;
  }

  const now = Date.now();
  const current = ipViolations.get(ip) || {
    count: 0,
    firstSeen: now,
    lastSeen: now,
    lastReason: reason,
  };

  // Reset window if expired
  if (now - current.firstSeen > VIOLATION_WINDOW_MS) {
    current.count = 1;
    current.firstSeen = now;
  } else {
    current.count++;
  }

  current.lastSeen = now;
  current.lastReason = reason;
  ipViolations.set(ip, current);

  if (current.count >= MAX_VIOLATIONS_BEFORE_BAN) {
    bannedIps.set(ip, {
      bannedAt: now,
      expiresAt: now + AUTO_BAN_DURATION_MS,
      reason: `Multiple violations (${current.count} strikes): ${reason}`,
      incidentId,
    });
    ipViolations.delete(ip);
  }

  return incidentId;
}

/**
 * Deep inspection of strings and objects for attack signatures
 */
function inspectValue(val, depth = 0) {
  if (val === null || val === undefined) return null;
  if (depth > MAX_INSPECT_DEPTH) return null;

  if (typeof val === "string") {
    // 1. Path Traversal
    if (PATH_TRAVERSAL_PATTERN.test(val)) {
      return { type: "pathTraversal", reason: "Directory traversal / LFI payload detected" };
    }

    // 2. Command Injection
    for (const pat of RCE_PATTERNS) {
      if (pat.test(val)) {
        return { type: "commandInjection", reason: "OS command injection signature detected" };
      }
    }

    // 3. SQL Injection
    for (const pat of SQLI_PATTERNS) {
      if (pat.test(val)) {
        return { type: "sqli", reason: "SQL injection payload detected" };
      }
    }

    // 4. Cross-Site Scripting (XSS)
    for (const pat of XSS_PATTERNS) {
      if (pat.test(val)) {
        return { type: "xss", reason: "Cross-site scripting (XSS) payload detected" };
      }
    }

    return null;
  }

  if (typeof val === "object") {
    if (Array.isArray(val)) {
      for (const item of val) {
        const hit = inspectValue(item, depth + 1);
        if (hit) return hit;
      }
    } else {
      for (const key of Object.keys(val)) {
        // Inspect key name itself
        const keyHit = inspectValue(key, depth + 1);
        if (keyHit) return keyHit;

        // Inspect value
        const valHit = inspectValue(val[key], depth + 1);
        if (valHit) return valHit;
      }
    }
  }

  return null;
}

/**
 * Express Middleware: DocQevrilo DeepShield WAF
 */
function firewallMiddleware(req, res, next) {
  telemetry.totalRequestsInspected++;
  const clientIp = getClientIp(req);
  const rawPath = req.originalUrl || req.url || "/";

  // Check path whitelist and authenticated administration routes
  if (PATH_WHITELIST.has(req.path) || req.path.startsWith("/api/admin")) {
    return next();
  }

  // 1. Check if IP is already in Jail / Auto-Banned
  if (isIpBanned(clientIp)) {
    const banInfo = bannedIps.get(clientIp);
    telemetry.blockedByType.bannedIp++;
    return res.status(403).json({
      error: "Access Denied by DocQevrilo Web Application Firewall",
      code: "WAF_IP_BANNED",
      reason: banInfo?.reason || "Your IP address is temporarily blocked due to security violations",
      incidentId: banInfo?.incidentId,
      expiresInMinutes: Math.max(1, Math.round((banInfo.expiresAt - Date.now()) / 60000)),
    });
  }

  // 2. Exploit Probe & Sensitive File Reconnaissance Detection (Instant Ban)
  for (const pat of EXPLOIT_PATH_PATTERNS) {
    if (pat.test(rawPath)) {
      const incidentId = recordViolation(
        clientIp,
        "exploitProbe",
        `Probe targeting sensitive path: ${rawPath}`,
        req,
        true // Immediate ban
      );
      return res.status(403).json({
        error: "Access Denied by DocQevrilo Web Application Firewall",
        code: "WAF_EXPLOIT_PROBE_BLOCKED",
        reason: "Access to administrative or configuration paths is strictly prohibited",
        incidentId,
      });
    }
  }

  // 3. Malicious Scanner & Bad Bot Detection
  const userAgent = req.headers["user-agent"] || "";
  if (BAD_BOT_PATTERN.test(userAgent)) {
    const incidentId = recordViolation(
      clientIp,
      "badBot",
      `Automated security scanner detected in User-Agent: ${userAgent}`,
      req,
      true // Immediate ban
    );
    return res.status(403).json({
      error: "Access Denied by DocQevrilo Web Application Firewall",
      code: "WAF_SCANNER_BLOCKED",
      reason: "Automated vulnerability scanning is strictly prohibited",
      incidentId,
    });
  }

  // 4. URL & Query String Deep Inspection
  const urlDecoded = decodeURIComponent(rawPath);
  const urlHit = inspectValue(urlDecoded);
  if (urlHit) {
    const incidentId = recordViolation(
      clientIp,
      urlHit.type,
      `${urlHit.reason} in URL: ${rawPath}`,
      req,
      false
    );
    return res.status(403).json({
      error: "Access Denied by DocQevrilo Web Application Firewall",
      code: "WAF_MALICIOUS_INPUT_BLOCKED",
      reason: "Suspicious payload detected in request URL",
      incidentId,
    });
  }

  // 5. Query Parameters Inspection
  if (req.query && Object.keys(req.query).length > 0) {
    const queryHit = inspectValue(req.query);
    if (queryHit) {
      const incidentId = recordViolation(
        clientIp,
        queryHit.type,
        `${queryHit.reason} in query string`,
        req,
        false
      );
      return res.status(403).json({
        error: "Access Denied by DocQevrilo Web Application Firewall",
        code: "WAF_QUERY_BLOCKED",
        reason: "Malicious query parameters detected",
        incidentId,
      });
    }
  }

  // 6. Request Body Inspection (for parsed JSON/URL-encoded bodies)
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    // Avoid false positives on valid password fields during signup/login
    // We inspect other fields while avoiding hashing raw passwords
    const bodyCopy = { ...req.body };
    if (bodyCopy.password) delete bodyCopy.password;
    if (bodyCopy.newPassword) delete bodyCopy.newPassword;
    if (bodyCopy.confirmPassword) delete bodyCopy.confirmPassword;

    const bodyHit = inspectValue(bodyCopy);
    if (bodyHit) {
      const incidentId = recordViolation(
        clientIp,
        bodyHit.type,
        `${bodyHit.reason} in request body`,
        req,
        false
      );
      return res.status(403).json({
        error: "Access Denied by DocQevrilo Web Application Firewall",
        code: "WAF_BODY_BLOCKED",
        reason: "Malicious payload detected in request body",
        incidentId,
      });
    }
  }

  // Request passed all firewall filters
  next();
}

/**
 * Returns telemetry and operational metrics for the admin console
 */
function getFirewallMetrics() {
  const activeBans = [];
  const now = Date.now();
  for (const [ip, info] of bannedIps.entries()) {
    if (now < info.expiresAt) {
      activeBans.push({
        ip,
        reason: info.reason,
        incidentId: info.incidentId,
        bannedAt: new Date(info.bannedAt).toISOString(),
        expiresAt: new Date(info.expiresAt).toISOString(),
        remainingMinutes: Math.max(1, Math.round((info.expiresAt - now) / 60000)),
      });
    } else {
      bannedIps.delete(ip);
    }
  }

  return {
    engine: "DocQevrilo DeepShield WAF v2.4",
    status: "ENFORCING",
    uptimeSeconds: Math.floor((Date.now() - telemetry.startTime) / 1000),
    totalRequestsInspected: telemetry.totalRequestsInspected,
    totalAttacksBlocked: telemetry.totalAttacksBlocked,
    blockedByType: { ...telemetry.blockedByType },
    activeBansCount: activeBans.length,
    activeBans,
    recentEvents: telemetry.recentSecurityEvents.slice(0, 30),
  };
}

/**
 * Allows administrators to manually unban an IP
 */
function unbanIp(ip) {
  if (!ip) return false;
  const existed = bannedIps.has(ip);
  bannedIps.delete(ip);
  ipViolations.delete(ip);
  return existed;
}

/**
 * Allows administrators to manually ban a malicious IP
 */
function manualBanIp(ip, reason = "Manual administrative ban", durationMinutes = 60) {
  if (!ip) return false;
  const incidentId = `MANUAL-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  bannedIps.set(ip, {
    bannedAt: Date.now(),
    expiresAt: Date.now() + durationMinutes * 60 * 1000,
    reason,
    incidentId,
  });
  return incidentId;
}

module.exports = {
  firewallMiddleware,
  getFirewallMetrics,
  unbanIp,
  manualBanIp,
  getClientIp,
};

