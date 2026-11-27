/**
 * DocQevrilo Hardened Spreadsheet Parser & Safe HTML/CSV Exporter (ExcelJS)
 *
 * Replaces vulnerable `xlsx` 0.18.5 with `exceljs` and enforces:
 * - Maximum buffer size (15 MB)
 * - Maximum sheet count (20), row count (2,000 per sheet), column count (100 per row)
 * - Formula injection neutralization (=, +, -, @, \t, \r prefixed with ')
 * - Strict HTML entity escaping in generated preview tables (prevents XSS)
 */

const ExcelJS = require("exceljs");

const MAX_SPREADSHEET_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 2000;
const MAX_COLS_PER_ROW = 100;

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeFormulaCell(val) {
  const s = String(val ?? "");
  if (!s) return "";
  if (/^[=+\-@\t\r]/.test(s)) {
    return `'${s}`;
  }
  return s;
}

function formatCellValue(cellValue) {
  if (cellValue == null) return "";
  if (typeof cellValue === "object") {
    if (cellValue.result !== undefined) return String(cellValue.result ?? "");
    if (cellValue.text !== undefined) return String(cellValue.text ?? "");
    if (Array.isArray(cellValue.richText)) {
      return cellValue.richText.map((r) => r.text || "").join("");
    }
    if (cellValue instanceof Date) return cellValue.toISOString();
    return String(cellValue);
  }
  return String(cellValue);
}

function validateXlsxZipHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error("Invalid or empty spreadsheet file.");
  }
  if (buffer.length > MAX_SPREADSHEET_BYTES) {
    throw new Error(`Spreadsheet exceeds maximum allowed parsing size (${MAX_SPREADSHEET_BYTES / (1024 * 1024)} MB).`);
  }
  // OOXML (.xlsx) files are ZIP archives starting with PK\x03\x04
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new Error("Unsupported legacy binary or malformed spreadsheet format. Please use .xlsx or .csv.");
  }
}

async function parseWorkbookSafe(buffer) {
  validateXlsxZipHeader(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets || workbook.worksheets.length === 0) {
    throw new Error("Workbook contains no worksheets.");
  }
  return workbook;
}

async function extractSpreadsheetText(buffer, filename = "spreadsheet.xlsx") {
  const workbook = await parseWorkbookSafe(buffer);
  const chunks = [];
  let fullText = "";

  const sheets = workbook.worksheets.slice(0, MAX_SHEETS);
  sheets.forEach((worksheet, idx) => {
    const lines = [];
    const rowLimit = Math.min(worksheet.rowCount || 0, MAX_ROWS_PER_SHEET);
    for (let r = 1; r <= rowLimit; r += 1) {
      const row = worksheet.getRow(r);
      const colLimit = Math.min(row.cellCount || 0, MAX_COLS_PER_ROW);
      const cells = [];
      let hasContent = false;
      for (let c = 1; c <= colLimit; c += 1) {
        const rawVal = formatCellValue(row.getCell(c).value);
        const safeVal = sanitizeFormulaCell(rawVal).replace(/"/g, '""');
        if (safeVal.trim()) hasContent = true;
        cells.push(`"${safeVal}"`);
      }
      if (hasContent) lines.push(cells.join(","));
    }

    const csv = lines.join("\n");
    if (csv.trim()) {
      const sheetText = `### Sheet: ${worksheet.name}\n${csv.trim()}`;
      fullText += (fullText ? "\n\n" : "") + sheetText;
      chunks.push({
        pageNum: idx + 1,
        label: `${filename} - Sheet: ${worksheet.name}`,
        text: sheetText,
      });
    }
  });

  if (!fullText.trim()) {
    fullText = `[Spreadsheet: ${filename}]\nContains worksheets with no tabular rows.`;
    chunks.push({
      pageNum: 1,
      label: `${filename} (Spreadsheet)`,
      text: fullText,
    });
  }

  return { fullText, chunks };
}

async function renderSpreadsheetHtmlTable(buffer) {
  const workbook = await parseWorkbookSafe(buffer);
  const worksheet = workbook.worksheets[0];
  const rowLimit = Math.min(worksheet.rowCount || 0, MAX_ROWS_PER_SHEET);
  let maxCols = 0;
  for (let r = 1; r <= rowLimit; r += 1) {
    maxCols = Math.max(maxCols, Math.min(worksheet.getRow(r).cellCount || 0, MAX_COLS_PER_ROW));
  }
  if (maxCols === 0) maxCols = 1;

  const rowsHtml = [];
  for (let r = 1; r <= rowLimit; r += 1) {
    const row = worksheet.getRow(r);
    const tds = [];
    for (let c = 1; c <= maxCols; c += 1) {
      const val = sanitizeFormulaCell(formatCellValue(row.getCell(c).value));
      tds.push(r === 1 ? `<th>${escapeHtml(val)}</th>` : `<td>${escapeHtml(val)}</td>`);
    }
    rowsHtml.push(`<tr>${tds.join("")}</tr>`);
  }

  return `<table>${rowsHtml.join("")}</table>`;
}

module.exports = {
  MAX_SPREADSHEET_BYTES,
  MAX_SHEETS,
  MAX_ROWS_PER_SHEET,
  MAX_COLS_PER_ROW,
  sanitizeFormulaCell,
  escapeHtml,
  parseWorkbookSafe,
  extractSpreadsheetText,
  renderSpreadsheetHtmlTable,
};
