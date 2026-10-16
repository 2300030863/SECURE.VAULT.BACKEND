const crypto = require("crypto");

// Letters omitting easily confused characters (I, O)
const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const lowercase = "abcdefghijkmnopqrstuvwxyz";
const numbers = "23456789";
// Special characters: @, $, ! (omits '#' to prevent browser URL fragment truncations)
const special = "@$!";

function pick(chars) {
  return chars[crypto.randomInt(chars.length)];
}

/**
 * Generates an access code matching the format:
 * [Letter][Digit][Letter][Digit][Digit][Special][Digit][Lower][Lower][Digit]
 * Example: A1B95@3he5, K7M24#8ra6, P4X81$6tu9, R2D63!5ka7
 */
function generateCode() {
  const left =
    pick(letters) +
    pick(numbers) +
    pick(letters) +
    pick(numbers) +
    pick(numbers);

  const right =
    pick(numbers) +
    pick(lowercase) +
    pick(lowercase) +
    pick(numbers);

  return left + pick(special) + right;
}

/**
 * Validates the syntax of an access code against the pattern
 */
function isValidCodeFormat(code) {
  if (!code || typeof code !== "string") return false;
  const trimmed = code.trim();
  // Format: 5 alphanumeric (starts with letter), 1 special (@#$!), 4 alphanumeric (ends with digit)
  const pattern = /^[A-Z][0-9][A-Z][0-9]{2}[@#$!][0-9][a-z]{2}[0-9]$/;
  return pattern.test(trimmed);
}

function hashCode(code) {
  const secret = process.env.CODE_HASH_SECRET || process.env.JWT_SECRET || "secure-vault-hmac-secret-2026";
  return crypto.createHmac("sha256", secret).update(code.trim()).digest("hex");
}

function legacyHashCode(code) {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

module.exports = { generateCode, hashCode, legacyHashCode, isValidCodeFormat };
