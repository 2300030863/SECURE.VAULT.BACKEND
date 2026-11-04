/**
 * DocQevrilo AI Assistant Service
 * Powered by Groq Cloud API
 * Provides robust document text extraction (PDF, DOCX, PPTX, TXT),
 * chunked AI summarization, context-aware Q&A with citations,
 * and customizable exam/study quizzes.
 */

const pdfParse = require("pdf-parse");
const AdmZip = require("adm-zip");
const mammoth = require("mammoth");
let XLSX = null;
try {
  XLSX = require("xlsx");
} catch (_) {}
require("dotenv").config();

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const CANDIDATE_MODELS = Array.from(
  new Set([
    process.env.GROQ_MODEL,
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "qwen/qwen3.8-27b",
    "llama3-70b-8192",
    "llama3-8b-8192",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
  ].filter(Boolean))
);
const ACTIVE_MODEL = CANDIDATE_MODELS[0] || "llama-3.3-70b-versatile";
let lastSuccessfulModel = ACTIVE_MODEL;

// In-memory caches for extracted text, summaries, and generated quizzes
const textCache = new Map(); // docId -> { fullText: string, chunks: Array, totalPages: number }
const summaryCache = new Map(); // `${docId}_${mode}` -> summaryResult
const quizCache = new Map(); // `${docId}_${topic}_${difficulty}_${count}` -> quizResult

/**
 * Get Groq API Key from environment
 */
function getGroqApiKey() {
  return process.env.GROQ_API_KEY || null;
}

/**
 * Safely chunk text into sections of at most maxChunkChars (~4,000 characters),
 * splitting oversized paragraphs and preserving all content.
 */
function chunkTextBySections(text, maxChunkChars = 4000) {
  const chunks = [];
  if (!text || typeof text !== "string") return chunks;

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  let currentChunk = "";
  let chunkIndex = 1;

  function saveChunk(content) {
    if (!content || !content.trim()) return;
    chunks.push({
      pageNum: chunkIndex,
      label: `Section ${chunkIndex}`,
      text: content.trim(),
    });
    chunkIndex++;
  }

  for (const para of paragraphs) {
    // Split paragraphs that exceed the limit
    if (para.length > maxChunkChars) {
      if (currentChunk.trim()) {
        saveChunk(currentChunk);
        currentChunk = "";
      }
      for (let i = 0; i < para.length; i += maxChunkChars) {
        saveChunk(para.slice(i, i + maxChunkChars));
      }
      continue;
    }

    const candidate = currentChunk ? `${currentChunk}\n\n${para}` : para;
    if (candidate.length > maxChunkChars && currentChunk.trim()) {
      saveChunk(currentChunk);
      currentChunk = para;
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk.trim()) {
    saveChunk(currentChunk);
  }

  return chunks;
}

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
  try {
    pdfData = await pdfParse(pdfBuffer);
  } catch (err) {
    console.error(`[PDF Parse Failed: ${filename}]`, err.message);
    throw new Error(
      `Unable to parse PDF "${filename}": ${err.message}. ` +
      `Please ensure the PDF is not corrupted or password-protected.`
    );
  }

  const rawText = (pdfData && pdfData.text) ? pdfData.text : "";
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

  const totalPages = pdfData.numpages || 1;
  const chunks = [];

  // Split into page chunks using Form Feed (\f) or standard "Page X" patterns
  const pageStrings = cleanText.split(/\f|\n(?=Page\s+\d+)/i);

  if (pageStrings.length > 1) {
    pageStrings.forEach((pText, idx) => {
      const trimmed = pText.trim();
      if (trimmed) {
        if (trimmed.length > 4000) {
          const subChunks = chunkTextBySections(trimmed, 4000);
          subChunks.forEach((sc, sIdx) => {
            chunks.push({
              pageNum: chunks.length + 1,
              label: `Page ${idx + 1} (Part ${sIdx + 1})`,
              text: sc.text,
            });
          });
        } else {
          chunks.push({
            pageNum: chunks.length + 1,
            label: `Page ${idx + 1}`,
            text: trimmed,
          });
        }
      }
    });
  } else {
    // If no page break indicators exist, chunk by paragraph/sections of at most 4,000 chars
    const sectionChunks = chunkTextBySections(cleanText, 4000);
    sectionChunks.forEach((sc, idx) => {
      chunks.push({
        pageNum: idx + 1,
        label: sectionChunks.length > 1 ? `Section ${idx + 1}` : `Page 1`,
        text: sc.text,
      });
    });
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
    // Fallback: inspect word/document.xml inside docx archive
    try {
      const zip = new AdmZip(docxBuffer);
      const docXml = zip.getEntry("word/document.xml");
      if (docXml) {
        const rawXml = docXml.getData().toString("utf8");
        text = rawXml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    } catch (_) { }
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
    const slideEntries = zip.getEntries()
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
function extractExcelText(buffer, filename = "spreadsheet.xlsx") {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { fullText: "", chunks: [] };
  }

  try {
    if (!XLSX) {
      XLSX = require("xlsx");
    }
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const chunks = [];
    let fullText = "";

    workbook.SheetNames.forEach((sheetName, idx) => {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv && csv.trim()) {
        const sheetText = `### Sheet: ${sheetName}\n${csv.trim()}`;
        fullText += (fullText ? "\n\n" : "") + sheetText;
        chunks.push({
          pageNum: idx + 1,
          label: `${filename} - Sheet: ${sheetName}`,
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

    return { fullText: fullText.trim(), chunks };
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
 * Analyze an image buffer using Groq Vision API (llama-3.2-11b-vision-preview / llama-3.2-90b-vision-preview)
 * Extracts OCR text, diagrams, labels, and scene descriptions.
 * Falls back to structured visual metadata when offline or on API timeout.
 */
async function analyzeImageBuffer(imageBuffer, filename = "image.png", mimeType = "image/jpeg") {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return { fullText: "", chunks: [] };
  }

  let determinedMime = mimeType;
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".png")) determinedMime = "image/png";
  else if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) determinedMime = "image/jpeg";
  else if (lowerName.endsWith(".webp")) determinedMime = "image/webp";
  else if (lowerName.endsWith(".gif")) determinedMime = "image/gif";
  else if (lowerName.endsWith(".bmp")) determinedMime = "image/bmp";
  else if (lowerName.endsWith(".svg")) determinedMime = "image/svg+xml";

  const apiKey = getGroqApiKey();
  let extractedText = "";

  if (apiKey) {
    const visionModels = [
      "llama-3.2-11b-vision-preview",
      "llama-3.2-90b-vision-preview",
    ];

    try {
      const base64Data = imageBuffer.toString("base64");
      const dataUri = `data:${determinedMime};base64,${base64Data}`;

      for (const model of visionModels) {
        try {
          const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Analyze this image "${filename}" thoroughly for academic study and document analysis:
1. Extract ALL visible text, labels, numbers, tables, code, diagrams, headings, and annotations verbatim.
2. If the image depicts diagrams, charts, UI screenshots, schematics, or photos, describe all components, relationships, workflows, and key takeaways in detail.
3. Structure your response clearly with headings:
   - Extracted Text & Content
   - Visual Structure & Diagrams
   - Key Insights & Observations`,
                    },
                    {
                      type: "image_url",
                      image_url: {
                        url: dataUri,
                      },
                    },
                  ],
                },
              ],
              temperature: 0.15,
              max_tokens: 2500,
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const content = data.choices?.[0]?.message?.content?.trim();
            if (content) {
              extractedText = content;
              lastSuccessfulModel = model;
              console.log(`[Groq Vision] Successfully extracted image content from "${filename}" using ${model}.`);
              break;
            }
          } else {
            const errData = await response.json().catch(() => ({}));
            console.warn(`[Groq Vision Warning on ${model}]:`, errData.error?.message || response.statusText);
          }
        } catch (subErr) {
          console.warn(`[Groq Vision Network Warning on ${model}]:`, subErr.message);
        }
      }
    } catch (encErr) {
      console.warn(`[Groq Vision Encoding Warning for ${filename}]:`, encErr.message);
    }
  }

  // Graceful fallback representation if Groq Vision is unavailable, rate-limited, or offline
  if (!extractedText.trim()) {
    const sizeKb = (imageBuffer.length / 1024).toFixed(1);
    extractedText = `[Image Analysis: ${filename}]\nFormat: ${determinedMime}\nFile Size: ${sizeKb} KB\nStatus: Visual media document preserved in secure DocQevrilo Vault.\nNote: Image visual asset indexed and ready for viewing and inspection.`;
  }

  const textChunks = chunkTextBySections(extractedText, 3500);
  const chunks = textChunks.map((tc, idx) => ({
    pageNum: idx + 1,
    label: textChunks.length > 1 ? `${filename} (Image Part ${idx + 1})` : `${filename} (Image)`,
    text: tc.text,
  }));

  return { fullText: extractedText, chunks };
}

/**
 * Transcribe an audio buffer using Groq Whisper API (whisper-large-v3-turbo / whisper-large-v3)
 * Splits transcription into time-stamped sections and chunks.
 * Falls back to structured audio metadata when offline or on API timeout.
 */
async function transcribeAudioBuffer(audioBuffer, filename = "recording.mp3", mimeType = "audio/mpeg") {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return { fullText: "", chunks: [] };
  }

  let determinedMime = mimeType;
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".mp3")) determinedMime = "audio/mpeg";
  else if (lowerName.endsWith(".wav")) determinedMime = "audio/wav";
  else if (lowerName.endsWith(".m4a")) determinedMime = "audio/m4a";
  else if (lowerName.endsWith(".ogg")) determinedMime = "audio/ogg";
  else if (lowerName.endsWith(".flac")) determinedMime = "audio/flac";
  else if (lowerName.endsWith(".aac")) determinedMime = "audio/aac";
  else if (lowerName.endsWith(".webm")) determinedMime = "audio/webm";

  const apiKey = getGroqApiKey();
  let transcriptText = "";
  const chunks = [];

  if (apiKey) {
    const whisperModels = [
      "whisper-large-v3-turbo",
      "whisper-large-v3",
    ];

    for (const model of whisperModels) {
      try {
        const formData = new FormData();
        const blob = new Blob([audioBuffer], { type: determinedMime });
        formData.append("file", blob, filename);
        formData.append("model", model);
        formData.append("response_format", "verbose_json");

        const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
        });

        if (response.ok) {
          const data = await response.json();
          if (data.segments && Array.isArray(data.segments) && data.segments.length > 0) {
            const formattedSegments = data.segments.map((seg) => {
              const startMin = Math.floor(seg.start / 60);
              const startSec = Math.floor(seg.start % 60);
              const timestamp = `[${String(startMin).padStart(2, "0")}:${String(startSec).padStart(2, "0")}]`;
              return `${timestamp} ${seg.text.trim()}`;
            });
            transcriptText = formattedSegments.join("\n");
            console.log(`[Groq Whisper] Successfully transcribed audio "${filename}" with timestamps using ${model}.`);
            break;
          } else if (data.text && data.text.trim()) {
            transcriptText = data.text.trim();
            console.log(`[Groq Whisper] Successfully transcribed audio "${filename}" using ${model}.`);
            break;
          }
        } else {
          const errData = await response.json().catch(() => ({}));
          console.warn(`[Groq Whisper Warning on ${model}]:`, errData.error?.message || response.statusText);
        }
      } catch (err) {
        console.warn(`[Groq Whisper Network Warning on ${model}]:`, err.message);
      }
    }
  }

  // Graceful fallback representation if Whisper is unavailable, rate-limited, or offline
  if (!transcriptText.trim()) {
    const sizeKb = (audioBuffer.length / 1024).toFixed(1);
    transcriptText = `[Audio Recording: ${filename}]\nFormat: ${determinedMime}\nFile Size: ${sizeKb} KB\nStatus: Spoken audio track stored securely in DocQevrilo Vault.\nNote: Audio asset preserved for streaming and review.`;
  }

  const textChunks = chunkTextBySections(transcriptText, 3500);
  textChunks.forEach((tc, idx) => {
    chunks.push({
      pageNum: idx + 1,
      label: textChunks.length > 1 ? `${filename} (Track Part ${idx + 1})` : `${filename} (Audio Transcript)`,
      text: tc.text,
    });
  });

  return { fullText: transcriptText, chunks };
}

/**
 * Extract clean, chunked text from any document, image, audio, or ZIP archive
 * Recursively inspects nested ZIP files, executes Groq Vision on images,
 * Groq Whisper on audio, and sheet parsing on Excel files.
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
          // Nested ZIP archive! Recursively unpack and process all files inside
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
          const xlsRes = extractExcelText(entryData, cleanName);
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
          const imgRes = await analyzeImageBuffer(entryData, cleanName);
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
          const audioRes = await transcribeAudioBuffer(entryData, cleanName);
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
          // Unknown or binary file entry
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
      const xlsRes = extractExcelText(buffer, originalName);
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
      const imgRes = await analyzeImageBuffer(buffer, originalName, mimeType);
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
      const audioRes = await transcribeAudioBuffer(buffer, originalName, mimeType);
      fullText = audioRes.fullText;
      chunks.push(...audioRes.chunks);
    } else {
      // Plain text, code, or RTF
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

  return { fullText: fullText.trim(), chunks };
}

/**
 * Low-level chat completion via Groq Cloud API with automatic TPM limit compliance,
 * intelligent payload reduction, and graceful model fallback.
 */
async function callGroqChat({ messages, temperature = 0.25, maxTokens = 750, responseFormat = null, retryCount = 0 }) {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not configured in backend/.env. Please add your Groq API key to activate DocQevrilo AI."
    );
  }

  const safeMaxTokens = Math.min(Math.max(parseInt(maxTokens, 10) || 1200, 100), 4096);

  let lastError = null;
  for (const model of CANDIDATE_MODELS) {
    try {
      const payload = {
        model,
        messages,
        temperature,
        max_tokens: safeMaxTokens,
      };

      if (responseFormat) {
        payload.response_format = responseFormat;
      }

      const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (response.ok && data.choices?.[0]) {
        const choice = data.choices[0];
        const content = choice.message?.content?.trim();
        if (content) {
          lastSuccessfulModel = model;
          return content;
        }
        // Fallback for reasoning models if content was empty
        if (choice.message?.reasoning) {
          const reasoning = choice.message.reasoning.trim();
          if (reasoning) {
            lastSuccessfulModel = model;
            return reasoning;
          }
        }
      }

      const errMsg = data.error?.message || `Groq API Error on ${model} (${response.status})`;
      lastError = new Error(errMsg);

      // If HTTP 429 rate limit encountered, wait for TPM recovery and retry
      if (response.status === 429 && retryCount === 0) {
        console.warn(`[Groq AI 429 Rate Limit] Waiting 2.5s for rate limit recovery on ${model}...`);
        await new Promise((r) => setTimeout(r, 2500));
        return await callGroqChat({
          messages,
          temperature,
          maxTokens: safeMaxTokens,
          responseFormat,
          retryCount: retryCount + 1,
        });
      }

      // If TPM or message size limit error detected, dynamically shrink text and retry once
      const isSizeError =
        response.status === 413 ||
        (response.status === 400 &&
          (errMsg.includes("Request too large") ||
            errMsg.includes("tokens per minute") ||
            errMsg.includes("TPM") ||
            errMsg.includes("message size") ||
            errMsg.includes("reduce your message size")));

      if (isSizeError && retryCount === 0) {
        console.warn(`[Groq AI Auto-Truncation] TPM limit approached on ${model}. Shrinking message context and retrying...`);
        const reducedMessages = messages.map((m) => {
          if (m.role === "user" && typeof m.content === "string") {
            return {
              ...m,
              content: m.content.length > 4500 ? m.content.slice(0, 4500) + "\n\n[Content trimmed to fit TPM limits]" : m.content,
            };
          }
          return m;
        });
        return await callGroqChat({
          messages: reducedMessages,
          temperature,
          maxTokens: Math.min(safeMaxTokens, 500),
          responseFormat,
          retryCount: retryCount + 1,
        });
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("All available Groq AI models failed. Please try again.");
}

/**
 * 1. AI Document Summarizer
 * Generates:
 * - Executive Summary
 * - Key Concepts & Definitions
 * - Section-by-Section Revision Notes
 * - Examples & Applications
 * - Important Questions & Self-Assessment
 * - Quick-Revision Takeaways
 */
async function generateSummary(docId, documentText, docName, mode = "detailed", refresh = false) {
  const cacheKey = `${docId}_${mode}`;
  if (!refresh && summaryCache.has(cacheKey)) {
    return summaryCache.get(cacheKey);
  }

  // Split the document into thorough sections (~2,500 characters each)
  const sectionChunks = chunkTextBySections(documentText, 2500);
  console.log(`[AI Summarizer] Document "${docName}" (${documentText.length} chars) divided into ${sectionChunks.length} sections.`);

  let structuredSummary = "";

  if (sectionChunks.length === 1) {
    // Single-section document: extract ALL concepts, terms, idioms with max completeness
    const singlePrompt = `Document: "${docName}"
Study Format: ${mode}

Extracted Document Content:
"""
${documentText}
"""

CRITICAL COMPLETENESS MANDATE:
1. Extract and list EVERY distinct item, definition, idiom, formula, term, and fact found in this text.
2. If there are multiple items, idioms, or terms (e.g. 5, 10, 20, 40), list and explain ALL of them without skipping or omitting any.
3. DO NOT abbreviate, truncate, or summarize lists by mentioning only a few examples. Include all items.
4. Preserve the exact terms, original idiom, clear definitions, and illustrative examples.

Please produce the comprehensive study guide with these sections:
# Comprehensive Study Guide: ${docName}

## 📌 Executive Summary
Provide an authoritative overview of the document's purpose, background, and core themes.

## 🔑 Complete Catalog of Key Concepts, Definitions & Idioms
List and explain EVERY SINGLE term, concept, or idiom in full:
- **[Term / Idiom / Concept]**: Meaning / Definition.
  - *Context / Usage / Example*: (provide illustrative sentence or example)

## 📖 In-Depth Detailed Notes
Systematic breakdown of the document's topics, structure, and lessons.

## 💡 Examples & Practical Applications
Concrete scenarios, sentences, or use cases mentioned.

## ❓ High-Yield Self-Assessment Questions
5 rigorous questions directly assessing mastery of the document.

## ⚡ Quick-Revision Key Takeaways
Key summary points for rapid revision.`;

    structuredSummary = await callGroqChat({
      messages: [
        {
          role: "system",
          content:
            "You are an exhaustive academic study assistant. " +
            "Completeness is strictly mandatory. Never omit, truncate, or summarize distinct list items, idioms, or definitions."
        },
        { role: "user", content: singlePrompt },
      ],
      temperature: 0.1,
      maxTokens: 3500,
    });
  } else {
    // Multi-section document: process EVERY chunk sequentially to guarantee full document coverage
    const chunkSummaries = [];
    console.log(`[AI Long Document] Processing all ${sectionChunks.length} sections for "${docName}"...`);

    for (let i = 0; i < sectionChunks.length; i++) {
      const chunk = sectionChunks[i];
      console.log(`[AI Full Summary] Summarizing section ${i + 1}/${sectionChunks.length} for "${docName}"...`);

      const chunkPrompt = `
Document: "${docName}"
Section: ${i + 1} of ${sectionChunks.length}

Analyze the following document section carefully and extract exhaustive study notes.

CRITICAL COMPLETENESS RULES:
1. Cover EVERY distinct item, idiom, definition, example, rule, and fact in this section.
2. If this section has 5, 10, or 20 idioms or terms, list and explain ALL of them.
3. Do NOT summarize lists by mentioning only a few examples. Never use "etc." or skip items.
4. Preserve the exact terms, original idiom, clear definitions, and illustrative examples.
5. Maintain the document's original order.

DOCUMENT SECTION CONTENT:
"""
${chunk.text}
"""

Return thorough, complete, and well-formatted study notes for this section.
`;

      const result = await callGroqChat({
        messages: [
          {
            role: "system",
            content:
              "You are an exhaustive academic document extractor. " +
              "Completeness is strictly mandatory. Never omit or skip distinct items, idioms, or definitions."
          },
          { role: "user", content: chunkPrompt },
        ],
        temperature: 0.1,
        maxTokens: 2000,
      });

      chunkSummaries.push(`## Section ${i + 1} Notes (${chunk.label || `Part ${i + 1}`})\n${result}`);

      // Delay between requests to respect Groq rate limits
      if (i < sectionChunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    structuredSummary = `
# Comprehensive Full-Document Study Guide: ${docName}

## 📌 Executive Summary
This comprehensive study guide covers all ${sectionChunks.length} processed sections of "${docName}".
Every concept, definition, idiom, fact, and example extracted across the entire document is cataloged below without omissions.

${chunkSummaries.join("\n\n")}

## ⚡ Quick-Revision Takeaways
- Complete coverage achieved across all ${sectionChunks.length} sections of the document.
- Review each section's comprehensive catalog above for exam, interview, and study revision.
`;
  }

  const output = {
    summary: structuredSummary,
    model: lastSuccessfulModel || ACTIVE_MODEL,
    generatedAt: new Date().toISOString(),
  };

  summaryCache.set(cacheKey, output);
  return output;
}

/**
 * 2. Ask AI - Context-Aware Q&A with Citations
 */
async function answerQuestion(docId, documentText, chunks, question, history = []) {
  // Rank and select the most relevant chunks based on keyword matching
  let selectedText = "";
  if (Array.isArray(chunks) && chunks.length > 0) {
    const qWords = question.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    // Score each chunk by keyword overlap
    const scored = chunks.map((c) => {
      const textLower = (c.text || "").toLowerCase();
      let score = 0;
      for (const w of qWords) {
        if (textLower.includes(w)) score += 1;
      }
      return { chunk: c, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const topChunks = scored.slice(0, 5).map((s) => s.chunk);

    selectedText = topChunks
      .map((c) => `[Source: ${c.label}]\n${(c.text || "").slice(0, 1500)}`)
      .join("\n\n---\n\n");
  }

  if (!selectedText) {
    selectedText = (documentText || "").slice(0, 8000);
  }

  const systemPrompt = `You are DocQevrilo AI, an expert document tutor.
You have access to the document excerpt below with Source markers like [Source: Page 1] or [Source: Slide 2].

Guidelines:
1. Answer the question accurately and concisely based strictly on the provided document text.
2. ALWAYS cite the exact source in bold: **[Page X]** or **[Slide Y]** or **[Section Z]** for every fact mentioned.
3. If the answer cannot be found in the provided document excerpt, clearly and politely state: "This information is not mentioned in the uploaded document." Do NOT invent or hallucinate answers.`;

  const conversation = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Reference Document Excerpt:\n"""\n${selectedText}\n"""`,
    },
    {
      role: "assistant",
      content: "I have read and indexed the document excerpt. I am ready to answer your questions with citations.",
    },
  ];

  if (Array.isArray(history) && history.length > 0) {
    const recent = history.slice(-4);
    for (const msg of recent) {
      if (msg.role && msg.content) {
        conversation.push({ role: msg.role, content: String(msg.content).slice(0, 400) });
      }
    }
  }

  conversation.push({ role: "user", content: question });

  const answer = await callGroqChat({
    messages: conversation,
    temperature: 0.25,
    maxTokens: 600,
  });

  return {
    answer,
    model: lastSuccessfulModel || ACTIVE_MODEL,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Helper: Safely parse and recover JSON quiz questions from AI text output
 */
function parseQuizJson(rawText) {
  if (!rawText || typeof rawText !== "string") return [];

  const trimmed = rawText.trim();

  // 1. Direct parse attempt
  try {
    const direct = JSON.parse(trimmed);
    if (Array.isArray(direct)) return direct;
    if (Array.isArray(direct.questions)) return direct.questions;
    if (Array.isArray(direct.quiz)) return direct.quiz;
  } catch (_) {}

  // 2. Strip standard markdown code blocks
  const withoutFences = trimmed
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/\s*```$/m, "")
    .trim();

  try {
    const parsed = JSON.parse(withoutFences);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.questions)) return parsed.questions;
    if (Array.isArray(parsed.quiz)) return parsed.quiz;
  } catch (_) {}

  // 3. Extract array between first [ and last ]
  const firstBracket = rawText.indexOf("[");
  const lastBracket = rawText.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const arrayStr = rawText.slice(firstBracket, lastBracket + 1);
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }

  // 4. Extract object between first { and last } (e.g. { "questions": [...] })
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const objStr = rawText.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(objStr);
      if (Array.isArray(parsed.questions)) return parsed.questions;
      if (Array.isArray(parsed.quiz)) return parsed.quiz;
    } catch (_) {}
  }

  // 5. Recovery parser: if JSON was cut off mid-stream, close the last complete question object
  if (firstBracket !== -1) {
    const candidate = rawText.slice(firstBracket);
    const lastCompleteObj = candidate.lastIndexOf("}");
    if (lastCompleteObj !== -1) {
      try {
        const repaired = candidate.slice(0, lastCompleteObj + 1) + "]";
        const parsed = JSON.parse(repaired);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch (_) {}
    }
  }

  return [];
}

/**
 * 3. AI Study Quiz Generator
 * Generates customizable MCQs with options, correct answer index, explanations, and cited sections
 */
async function generateQuiz(docId, documentText, { topic = "All Topics", difficulty = "medium", questionCount = 5, refresh = false }) {
  const count = Math.min(Math.max(parseInt(questionCount, 10) || 5, 3), 10);
  const cacheKey = `${docId}_${topic}_${difficulty}_${count}`;

  if (!refresh && quizCache.has(cacheKey)) {
    return quizCache.get(cacheKey);
  }

  const systemPrompt = `You are an expert exam creator for DocQevrilo.
Generate exactly ${count} multiple-choice questions (MCQs) testing understanding of the provided document.

Target Topic: "${topic}"
Difficulty Level: "${difficulty}"

CRITICAL REQUIREMENTS:
1. Return ONLY a valid JSON array of objects without Markdown code fences, text prefix, or conversational commentary.
2. Each question object MUST have:
   - "id": number (1 to ${count})
   - "question": string
   - "options": array of exactly 4 strings
   - "correctIndex": number (0, 1, 2, or 3)
   - "explanation": string
   - "citation": string

Example Format:
[
  {
    "id": 1,
    "question": "What does the idiom 'bite the bullet' mean?",
    "options": ["To eat something hard", "To face a difficult situation with courage", "To start a conflict", "To hurry up"],
    "correctIndex": 1,
    "explanation": "Biting the bullet means enduring a painful or difficult situation bravely.",
    "citation": "Section 1"
  }
]`;

  let quizContext = documentText || "";
  if (quizContext.length > 7000) {
    // Sample evenly across all sections of the document so the quiz tests the entire document
    const sectionChunks = chunkTextBySections(quizContext, 2000);
    const sampled = [];
    const step = Math.max(1, Math.floor(sectionChunks.length / Math.min(count, sectionChunks.length)));
    for (let i = 0; i < sectionChunks.length && sampled.length < count; i += step) {
      sampled.push(`[Section ${i + 1} Excerpt]:\n${sectionChunks[i].text.slice(0, 1200)}`);
    }
    quizContext = sampled.join("\n\n");
  }

  const userPrompt = `Document Content:
"""
${quizContext}
"""

Generate ${count} ${difficulty} MCQs in JSON format testing across the provided content. Return ONLY the JSON array.`;

  // Scale token limit appropriately: 10 questions need ~2,500-3,000 tokens to avoid mid-JSON truncation
  const quizMaxTokens = Math.min(Math.max(count * 350, 2000), 4000);

  const rawJson = await callGroqChat({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: quizMaxTokens,
  });

  const questions = parseQuizJson(rawJson);

  if (!Array.isArray(questions) || questions.length === 0) {
    console.error("[Quiz JSON Parse Failed] Raw output:", rawJson ? rawJson.slice(0, 300) : "empty");
    throw new Error("Failed to parse quiz response into structured format. Please retry.");
  }

  // Clean and validate each question item
  const validQuestions = questions.map((q, idx) => ({
    id: q.id || idx + 1,
    question: q.question || `Question ${idx + 1}`,
    options: Array.isArray(q.options) && q.options.length >= 4 ? q.options.slice(0, 4) : ["Option A", "Option B", "Option C", "Option D"],
    correctIndex: typeof q.correctIndex === "number" && q.correctIndex >= 0 && q.correctIndex <= 3 ? q.correctIndex : 0,
    explanation: q.explanation || "No explanation provided.",
    citation: q.citation || `Section ${idx + 1}`,
  }));

  const result = {
    topic,
    difficulty,
    questionCount: validQuestions.length,
    questions: validQuestions,
    model: lastSuccessfulModel || ACTIVE_MODEL,
    generatedAt: new Date().toISOString(),
  };

  quizCache.set(cacheKey, result);
  return result;
}

module.exports = {
  extractDocumentText,
  generateSummary,
  answerQuestion,
  generateQuiz,
  getGroqApiKey,
  textCache,
  summaryCache,
  quizCache,
};
