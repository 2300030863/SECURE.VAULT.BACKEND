/**
 * DocQevrilo AI Assistant Service
 * Powered by Google Gemini API (@google/genai SDK)
 *
 * Provides robust document text extraction (PDF, DOCX, PPTX, XLSX, TXT, nested ZIP archives),
 * Gemini Vision OCR on images, Gemini Audio understanding,
 * chunked 11-section summarization, context-grounded Q&A with citations,
 * and customizable exam/study quizzes.
 */

const pdfParse = require("pdf-parse");
const AdmZip = require("adm-zip");
const mammoth = require("mammoth");
const { extractSpreadsheetText } = require("./spreadsheetHelper");
require("dotenv").config();

const {
  callGemini,
  generateSummary,
  answerQuestion,
  generateQuiz,
  getGeminiApiKey,
  getGeminiStatus,
  getCandidateModels,
  analyzeImageWithGemini,
  transcribeAudioWithGemini,
  chunkTextBySections,
  parseStructuredSections,
  parseBulletPoints,
  deduplicateBullets,
  sampleExactCount,
  wrapUntrustedDocument,
  textCache,
  summaryCache,
  quizCache,
} = require("./geminiService");

/**
 * Extract clean, validated text from a PDF buffer with page-level chunking
 * @param {Buffer} pdfBuffer - Raw PDF buffer
 * @param {string} filename - Filename for contextual error reporting
 * @returns {Promise<{ fullText: string, chunks: Array<{ pageNum: number, label: string, text: string }>, totalPages: number }>}
 */
async function extractPdfText(pdfBuffer, filename = "document.pdf") {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error(`Invalid or empty PDF buffer for "${filename}".`);
  }

  let pdfData;
  let pageIndex = 0;
  const pageMap = [];

  const pdfOptions = {
    pagerender: function (pageData) {
      pageIndex++;
      const curPage = pageIndex;
      return pageData
        .getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
        .then(function (textContent) {
          let lastY, text = "";
          for (const item of textContent.items) {
            if (lastY === item.transform[5] || !lastY) {
              text += item.str;
            } else {
              text += "\n" + item.str;
            }
            lastY = item.transform[5];
          }
          const cleanP = text.trim();
          if (cleanP) {
            pageMap.push({ pageNum: curPage, text: cleanP });
          }
          return `\n\n--- [Page ${curPage}] ---\n` + text;
        })
        .catch(function () {
          return "";
        });
    },
  };

  try {
    pdfData = await pdfParse(pdfBuffer, pdfOptions);
  } catch (err) {
    // Retry without custom pagerender if special parser hook failed
    try {
      pdfData = await pdfParse(pdfBuffer);
    } catch (fallbackErr) {
      console.error(`[PDF Parse Failed: ${filename}]`, fallbackErr.message);
      throw new Error(
        `Unable to parse PDF "${filename}": ${fallbackErr.message}. ` +
          `Please ensure the PDF is not corrupted or password-protected.`
      );
    }
  }

  const rawText = pdfData && pdfData.text ? pdfData.text : "";
  const cleanText = rawText
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  // Validate that actual human-readable text was extracted
  const nonWhitespaceCount = cleanText.replace(/\s+/g, "").length;
  if (nonWhitespaceCount < 30) {
    throw new Error(
      `No readable text found in "${filename}" (${nonWhitespaceCount} characters). ` +
        `This PDF may be scanned, image-based, or contain only non-extractable vectors. ` +
        `Please provide a document containing selectable text.`
    );
  }

  // Guard against raw PDF object / stream definitions slipping through
  if (cleanText.includes("%PDF-") || (cleanText.includes("/FlateDecode") && cleanText.includes("/Length"))) {
    throw new Error(
      `Internal PDF syntax was detected instead of readable text for "${filename}". ` +
        `Uncompressed text could not be extracted.`
    );
  }

  const totalPages = pdfData.numpages || pageMap.length || 1;
  const chunks = [];

  if (pageMap.length > 0) {
    // High-fidelity page map from PDF engine
    pageMap.forEach((p) => {
      if (p.text.length > 3500) {
        const subChunks = chunkTextBySections(p.text, 3500);
        subChunks.forEach((sc, sIdx) => {
          chunks.push({
            pageNum: p.pageNum,
            label: `Page ${p.pageNum} (Part ${sIdx + 1})`,
            text: sc.text,
          });
        });
      } else {
        chunks.push({
          pageNum: p.pageNum,
          label: `Page ${p.pageNum}`,
          text: p.text,
        });
      }
    });
  } else {
    // Fallback: split into page chunks using Form Feed (\f) or standard "Page X" patterns
    const pageStrings = cleanText.split(/\f|\n(?=Page\s+\d+)/i);

    if (pageStrings.length > 1) {
      pageStrings.forEach((pText, idx) => {
        const trimmed = pText.trim();
        if (trimmed) {
          if (trimmed.length > 3500) {
            const subChunks = chunkTextBySections(trimmed, 3500);
            subChunks.forEach((sc, sIdx) => {
              chunks.push({
                pageNum: idx + 1,
                label: `Page ${idx + 1} (Part ${sIdx + 1})`,
                text: sc.text,
              });
            });
          } else {
            chunks.push({
              pageNum: idx + 1,
              label: `Page ${idx + 1}`,
              text: trimmed,
            });
          }
        }
      });
    } else {
      const sectionChunks = chunkTextBySections(cleanText, 3500);
      sectionChunks.forEach((sc, idx) => {
        chunks.push({
          pageNum: idx + 1,
          label: sectionChunks.length > 1 ? `Section ${idx + 1}` : `Page 1`,
          text: sc.text,
        });
      });
    }
  }

  return { fullText: cleanText, chunks, totalPages };
}

/**
 * Extract clean text from a DOCX Word document buffer
 * @param {Buffer} docxBuffer - Raw DOCX buffer
 * @param {string} filename - Filename for logging
 */
async function extractDocxText(docxBuffer, filename = "document.docx") {
  if (!docxBuffer || !Buffer.isBuffer(docxBuffer) || docxBuffer.length === 0) {
    throw new Error(`Invalid or empty DOCX buffer for "${filename}".`);
  }

  let text = "";
  try {
    const res = await mammoth.extractRawText({ buffer: docxBuffer });
    text = (res.value || "").trim();
  } catch (err) {
    console.warn(`[Mammoth Extract Warning: ${filename}]`, err.message);
    try {
      const zip = new AdmZip(docxBuffer);
      const docXml = zip.getEntry("word/document.xml");
      if (docXml) {
        const rawXml = docXml.getData().toString("utf8");
        text = rawXml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    } catch (_) {}
  }

  const nonWhitespace = text.replace(/\s+/g, "").length;
  if (nonWhitespace < 20) {
    throw new Error(`No readable text found in Word document "${filename}".`);
  }

  const chunks = chunkTextBySections(text, 4000);
  return { fullText: text, chunks, totalPages: chunks.length };
}

/**
 * Extract clean text from a PowerPoint PPTX buffer
 * @param {Buffer} pptxBuffer - Raw PPTX buffer
 * @param {string} filename - Filename for logging
 */
async function extractPptxText(pptxBuffer, filename = "presentation.pptx") {
  if (!pptxBuffer || !Buffer.isBuffer(pptxBuffer) || pptxBuffer.length === 0) {
    throw new Error(`Invalid or empty PPTX buffer for "${filename}".`);
  }

  try {
    const zip = new AdmZip(pptxBuffer);
    const slideEntries = zip
      .getEntries()
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/\d+/)?.[0] || "0", 10);
        const numB = parseInt(b.entryName.match(/\d+/)?.[0] || "0", 10);
        return numA - numB;
      });

    if (slideEntries.length === 0) {
      throw new Error(`No slide content found in PowerPoint presentation "${filename}".`);
    }

    const chunks = [];
    let fullText = "";

    for (let i = 0; i < slideEntries.length; i++) {
      const entry = slideEntries[i];
      const xml = entry.getData().toString("utf8");
      const matches = xml.match(/<a:t[^>]*>(.*?)<\/a:t>/gi) || [];
      const slideText = matches
        .map((m) => m.replace(/<[^>]+>/g, "").trim())
        .filter(Boolean)
        .join(" ");

      if (slideText) {
        const label = `Slide ${i + 1}`;
        chunks.push({ pageNum: i + 1, label, text: slideText });
        fullText += `\n\n--- ${label} ---\n${slideText}`;
      }
    }

    const clean = fullText.trim();
    if (!clean || clean.replace(/\s+/g, "").length < 20) {
      throw new Error(`No readable text found in PowerPoint "${filename}". Slides may contain only images.`);
    }

    return { fullText: clean, chunks, totalPages: slideEntries.length };
  } catch (err) {
    throw new Error(`Failed to extract text from PPTX "${filename}": ${err.message}`);
  }
}

/**
 * Extract clean text and tabular sheets from Excel files (.xlsx, .xls)
 * @param {Buffer} buffer - Excel file buffer
 * @param {string} filename - Filename for display and metadata
 */
async function extractExcelText(buffer, filename = "spreadsheet.xlsx") {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { fullText: "", chunks: [] };
  }

  try {
    return await extractSpreadsheetText(buffer, filename);
  } catch (err) {
    console.warn(`[Excel Extraction Warning for ${filename}]:`, err.message);
    const fallbackText = `[Spreadsheet Document: ${filename}]\nFile Size: ${(buffer.length / 1024).toFixed(1)} KB\nNote: Excel data workbook stored in DocQevrilo Vault.`;
    return {
      fullText: fallbackText,
      chunks: [{ pageNum: 1, label: `${filename} (Excel)`, text: fallbackText }],
    };
  }
}

/**
 * Extract clean, chunked text from any document, image, audio, or ZIP archive.
 * Recursively inspects nested ZIP files, executes Gemini Vision on images,
 * Gemini audio understanding, and sheet parsing on Excel files.
 *
 * @param {Buffer} buffer - File buffer
 * @param {string} originalName - Original filename
 * @param {string} mimeType - MIME type
 * @returns {Promise<{ fullText: string, chunks: Array<{ pageNum: number, label: string, text: string }> }>}
 */
async function extractDocumentText(buffer, originalName = "", mimeType = "") {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Cannot extract text from an empty document buffer.");
  }

  const lowerName = (originalName || "").toLowerCase();
  const isOfficeDoc =
    lowerName.endsWith(".docx") ||
    lowerName.endsWith(".doc") ||
    lowerName.endsWith(".pptx") ||
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".xls") ||
    mimeType.includes("word") ||
    mimeType.includes("presentation") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel");

  const isZip =
    !isOfficeDoc &&
    (lowerName.endsWith(".zip") ||
      mimeType.includes("zip") ||
      (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b));

  let fullText = "";
  const chunks = [];
  const errors = [];

  if (isZip) {
    let zip;
    try {
      zip = new AdmZip(buffer);
    } catch (zipErr) {
      throw new Error(`Failed to read storage archive: ${zipErr.message}`);
    }

    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length === 0) {
      throw new Error("The uploaded archive contains no files.");
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const cleanName = entry.entryName.replace(/^(\d+_)+/, "");
      const entryLower = cleanName.toLowerCase();
      const entryData = entry.getData();

      try {
        const isEntryOffice =
          entryLower.endsWith(".docx") ||
          entryLower.endsWith(".doc") ||
          entryLower.endsWith(".pptx") ||
          entryLower.endsWith(".xlsx") ||
          entryLower.endsWith(".xls");

        const isEntryZip =
          !isEntryOffice &&
          (entryLower.endsWith(".zip") ||
            (entryData.length >= 4 && entryData[0] === 0x50 && entryData[1] === 0x4b));

        if (isEntryZip) {
          const zipRes = await extractDocumentText(entryData, cleanName, "application/zip");
          if (zipRes.chunks && zipRes.chunks.length > 0) {
            chunks.push(...zipRes.chunks);
          }
          if (zipRes.fullText && zipRes.fullText.trim()) {
            fullText += `\n\n--- Archive: ${cleanName} ---\n${zipRes.fullText}`;
          }
        } else if (entryLower.endsWith(".pdf")) {
          const pdfRes = await extractPdfText(entryData, cleanName);
          chunks.push(...pdfRes.chunks);
          fullText += `\n\n--- File: ${cleanName} ---\n${pdfRes.fullText}`;
        } else if (entryLower.endsWith(".docx") || entryLower.endsWith(".doc")) {
          const docxRes = await extractDocxText(entryData, cleanName);
          chunks.push(...docxRes.chunks);
          fullText += `\n\n--- File: ${cleanName} ---\n${docxRes.fullText}`;
        } else if (entryLower.endsWith(".pptx")) {
          const pptxRes = await extractPptxText(entryData, cleanName);
          chunks.push(...pptxRes.chunks);
          fullText += `\n\n--- File: ${cleanName} ---\n${pptxRes.fullText}`;
        } else if (entryLower.endsWith(".xlsx") || entryLower.endsWith(".xls")) {
          const xlsRes = await extractExcelText(entryData, cleanName);
          chunks.push(...xlsRes.chunks);
          fullText += `\n\n--- Spreadsheet: ${cleanName} ---\n${xlsRes.fullText}`;
        } else if (
          entryLower.endsWith(".png") ||
          entryLower.endsWith(".jpg") ||
          entryLower.endsWith(".jpeg") ||
          entryLower.endsWith(".webp") ||
          entryLower.endsWith(".gif") ||
          entryLower.endsWith(".bmp") ||
          entryLower.endsWith(".svg") ||
          entryLower.endsWith(".tiff")
        ) {
          const imgRes = await analyzeImageWithGemini(entryData, cleanName);
          chunks.push(...imgRes.chunks);
          fullText += `\n\n--- Image: ${cleanName} ---\n${imgRes.fullText}`;
        } else if (
          entryLower.endsWith(".mp3") ||
          entryLower.endsWith(".wav") ||
          entryLower.endsWith(".m4a") ||
          entryLower.endsWith(".ogg") ||
          entryLower.endsWith(".flac") ||
          entryLower.endsWith(".aac") ||
          entryLower.endsWith(".webm") ||
          entryLower.endsWith(".wma")
        ) {
          const audioRes = await transcribeAudioWithGemini(entryData, cleanName);
          chunks.push(...audioRes.chunks);
          fullText += `\n\n--- Audio: ${cleanName} ---\n${audioRes.fullText}`;
        } else if (
          entryLower.endsWith(".txt") ||
          entryLower.endsWith(".md") ||
          entryLower.endsWith(".json") ||
          entryLower.endsWith(".csv") ||
          entryLower.endsWith(".tsv") ||
          entryLower.endsWith(".log") ||
          entryLower.endsWith(".js") ||
          entryLower.endsWith(".ts") ||
          entryLower.endsWith(".jsx") ||
          entryLower.endsWith(".tsx") ||
          entryLower.endsWith(".py") ||
          entryLower.endsWith(".java") ||
          entryLower.endsWith(".c") ||
          entryLower.endsWith(".cpp") ||
          entryLower.endsWith(".h") ||
          entryLower.endsWith(".cs") ||
          entryLower.endsWith(".go") ||
          entryLower.endsWith(".rs") ||
          entryLower.endsWith(".sql") ||
          entryLower.endsWith(".html") ||
          entryLower.endsWith(".css") ||
          entryLower.endsWith(".yaml") ||
          entryLower.endsWith(".yml") ||
          entryLower.endsWith(".xml") ||
          entryLower.endsWith(".rtf") ||
          entryLower.endsWith(".sh") ||
          entryLower.endsWith(".bat")
        ) {
          let text = entryData.toString("utf8");
          if (entryLower.endsWith(".rtf")) {
            text = text
              .replace(/\\(rtf1|ansi|deff0|fonttbl|colortbl|stylesheet|info|listtable|listoverridetable)[^{]*\{[\s\S]*?\}/gi, "")
              .replace(/[{}\\]/g, " ")
              .replace(/\\[a-z0-9]+\s?/gi, " ")
              .replace(/\s+/g, " ")
              .trim();
          } else {
            text = text.trim();
          }

          if (text) {
            const fileChunks = chunkTextBySections(text, 4000);
            fileChunks.forEach((fc) => {
              chunks.push({
                pageNum: chunks.length + 1,
                label: fileChunks.length > 1 ? `${cleanName} (${fc.label})` : cleanName,
                text: fc.text,
              });
            });
            fullText += `\n\n--- File: ${cleanName} ---\n${text}`;
          }
        } else {
          const sizeKb = (entryData.length / 1024).toFixed(1);
          const metaText = `[File Asset: ${cleanName} - Size: ${sizeKb} KB - Stored in Vault]`;
          chunks.push({
            pageNum: chunks.length + 1,
            label: cleanName,
            text: metaText,
          });
          fullText += `\n\n--- File: ${cleanName} ---\n${metaText}`;
        }
      } catch (err) {
        console.warn(`[Extraction Warning for ${cleanName}]:`, err.message);
        errors.push(`${cleanName}: ${err.message}`);
      }
    }

    if (!fullText.trim()) {
      const errorDetails = errors.length > 0 ? ` Details: ${errors.join("; ")}` : "";
      fullText = `[Archive: ${originalName}]\nContains ${entries.length} items preserved in DocQevrilo Vault.${errorDetails}`;
      chunks.push({
        pageNum: 1,
        label: `${originalName} (Archive)`,
        text: fullText,
      });
    }
  } else {
    // Single non-zip buffer
    const lowerName = originalName.toLowerCase();
    if (lowerName.endsWith(".pdf") || mimeType.includes("pdf")) {
      const pdfRes = await extractPdfText(buffer, originalName);
      fullText = pdfRes.fullText;
      chunks.push(...pdfRes.chunks);
    } else if (lowerName.endsWith(".docx") || lowerName.endsWith(".doc") || mimeType.includes("word")) {
      const docxRes = await extractDocxText(buffer, originalName);
      fullText = docxRes.fullText;
      chunks.push(...docxRes.chunks);
    } else if (lowerName.endsWith(".pptx") || mimeType.includes("presentation")) {
      const pptxRes = await extractPptxText(buffer, originalName);
      fullText = pptxRes.fullText;
      chunks.push(...pptxRes.chunks);
    } else if (
      lowerName.endsWith(".xlsx") ||
      lowerName.endsWith(".xls") ||
      mimeType.includes("spreadsheet") ||
      mimeType.includes("excel")
    ) {
      const xlsRes = await extractExcelText(buffer, originalName);
      fullText = xlsRes.fullText;
      chunks.push(...xlsRes.chunks);
    } else if (
      lowerName.endsWith(".png") ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg") ||
      lowerName.endsWith(".webp") ||
      lowerName.endsWith(".gif") ||
      lowerName.endsWith(".bmp") ||
      lowerName.endsWith(".svg") ||
      mimeType.startsWith("image/")
    ) {
      const imgRes = await analyzeImageWithGemini(buffer, originalName, mimeType);
      fullText = imgRes.fullText;
      chunks.push(...imgRes.chunks);
    } else if (
      lowerName.endsWith(".mp3") ||
      lowerName.endsWith(".wav") ||
      lowerName.endsWith(".m4a") ||
      lowerName.endsWith(".ogg") ||
      lowerName.endsWith(".flac") ||
      lowerName.endsWith(".aac") ||
      lowerName.endsWith(".webm") ||
      lowerName.endsWith(".wma") ||
      mimeType.startsWith("audio/")
    ) {
      const audioRes = await transcribeAudioWithGemini(buffer, originalName, mimeType);
      fullText = audioRes.fullText;
      chunks.push(...audioRes.chunks);
    } else {
      let text = buffer.toString("utf8");
      if (lowerName.endsWith(".rtf")) {
        text = text
          .replace(/\\(rtf1|ansi|deff0|fonttbl|colortbl|stylesheet|info|listtable|listoverridetable)[^{]*\{[\s\S]*?\}/gi, "")
          .replace(/[{}\\]/g, " ")
          .replace(/\\[a-z0-9]+\s?/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        text = text.trim();
      }

      if (text.length >= 10) {
        fullText = text;
        const textChunks = chunkTextBySections(text, 4000);
        chunks.push(...textChunks);
      } else {
        const sizeKb = (buffer.length / 1024).toFixed(1);
        fullText = `[Document: ${originalName} - Size: ${sizeKb} KB - Stored in Vault]`;
        chunks.push({ pageNum: 1, label: originalName, text: fullText });
      }
    }
  }

  if (!fullText.trim()) {
    fullText = `[Vault Document: ${originalName}]\nDocument stored securely in DocQevrilo Vault.`;
    chunks.push({
      pageNum: 1,
      label: originalName,
      text: fullText,
    });
  }

  const totalPages = Math.max(1, chunks.length, ...chunks.map((c) => c.pageNum || 1));
  return { fullText: fullText.trim(), chunks, totalPages };
}

module.exports = {
  extractDocumentText,
  extractPdfText,
  extractDocxText,
  extractPptxText,
  extractExcelText,
  generateSummary,
  answerQuestion,
  generateQuiz,
  getGeminiApiKey,
  getGeminiStatus,
  getCandidateModels,
  callGemini,
  analyzeImageWithGemini,
  transcribeAudioWithGemini,
  chunkTextBySections,
  parseStructuredSections,
  parseBulletPoints,
  deduplicateBullets,
  sampleExactCount,
  wrapUntrustedDocument,
  textCache,
  summaryCache,
  quizCache,
};
