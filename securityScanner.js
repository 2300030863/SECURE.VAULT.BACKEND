/**
 * DocQevrilo Layer 7 – Malware, Magic-Byte & Polyglot Upload Scanner
 *
 * Inspects uploaded files before archiving or uploading to Backblaze B2:
 * - Detects disguised Windows PE/MZ executables, Linux ELF binaries, Mach-O binaries
 * - Detects EICAR standard anti-malware test signature
 * - Rejects server-side script polyglots (e.g. <?php inside non-code uploads)
 */

const fs = require("fs");
const path = require("path");

const EICAR_SIGNATURE = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

// Extensions where text/source code snippets are legitimately expected
const CODE_OR_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".css",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".c", ".cpp", ".h", ".sql", ".yaml", ".yml",
]);

function scanBufferForMalware(buf, originalName = "") {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { safe: true };
  }

  const ext = path.extname(originalName).toLowerCase();

  // 1. EICAR standard antivirus test signature
  const headText = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf8");
  if (headText.includes(EICAR_SIGNATURE)) {
    return { safe: false, threat: "EICAR-Test-Signature", reason: "Malware test signature detected in uploaded file." };
  }

  // 2. Windows PE / DOS Executable (MZ header + PE/DOS stub)
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    return { safe: false, threat: "Disguised-PE-Executable", reason: "Executable binary (PE/MZ) headers are not permitted." };
  }

  // 3. Linux ELF Executable (\x7fELF)
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    return { safe: false, threat: "Disguised-ELF-Binary", reason: "Executable binary (ELF) headers are not permitted." };
  }

  // 4. Mach-O Binary (macOS/iOS executable)
  if (
    buf.length >= 4 &&
    ((buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && (buf[3] === 0xce || buf[3] === 0xcf)) ||
      (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe))
  ) {
    return { safe: false, threat: "Disguised-MachO-Binary", reason: "Executable binary (Mach-O) headers are not permitted." };
  }

  // 5. Server-side PHP/JSP script injection inside non-code documents/images
  if (!CODE_OR_TEXT_EXTENSIONS.has(ext)) {
    if (/<\?php\b/i.test(headText) || /<%\s*@(page|import)/i.test(headText)) {
      return { safe: false, threat: "Polyglot-Server-Script", reason: "Embedded server-side script tags are not permitted in document/media uploads." };
    }
  }

  return { safe: true };
}

function scanFileForMalware(filePath, originalName = "") {
  const fd = fs.openSync(filePath, "r");
  try {
    const sample = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    return scanBufferForMalware(sample.subarray(0, bytesRead), originalName);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  EICAR_SIGNATURE,
  scanBufferForMalware,
  scanFileForMalware,
};
