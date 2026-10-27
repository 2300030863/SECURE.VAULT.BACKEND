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
require("dotenv").config();

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const CANDIDATE_MODELS = Array.from(
  new Set([
    process.env.GROQ_MODEL,
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
  ].filter(Boolean))
);
const ACTIVE_MODEL = CANDIDATE_MODELS[0] || "openai/gpt-oss-20b";
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
 * Extract clean, chunked text from a document or ZIP archive
 * @param {Buffer} buffer - File buffer
 * @param {string} originalName - Original filename
 * @param {string} mimeType - MIME type
 * @returns {Promise<{ fullText: string, chunks: Array<{ pageNum: number, label: string, text: string }> }>}
 */
async function extractDocumentText(buffer, originalName = "", mimeType = "") {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Cannot extract text from an empty document buffer.");
  }

  const isZip =
    originalName.toLowerCase().endsWith(".zip") ||
    (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b);

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
      const lowerName = cleanName.toLowerCase();
      const entryData = entry.getData();

      try {
        if (lowerName.endsWith(".pdf")) {
          const pdfRes = await extractPdfText(entryData, cleanName);
          chunks.push(...pdfRes.chunks);
          fullText += `\n\n--- File: ${cleanName} ---\n${pdfRes.fullText}`;
        } else if (lowerName.endsWith(".docx") || lowerName.endsWith(".doc")) {
          const docxRes = await extractDocxText(entryData, cleanName);
          chunks.push(...docxRes.chunks);
          fullText += `\n\n--- File: ${cleanName} ---\n${docxRes.fullText}`;
        } else if (lowerName.endsWith(".pptx")) {
          const pptxRes = await extractPptxText(entryData, cleanName);
          chunks.push(...pptxRes.chunks);
          fullText += `\n\n--- File: ${cleanName} ---\n${pptxRes.fullText}`;
        } else if (
          lowerName.endsWith(".txt") ||
          lowerName.endsWith(".md") ||
          lowerName.endsWith(".json") ||
          lowerName.endsWith(".csv") ||
          lowerName.endsWith(".log") ||
          lowerName.endsWith(".js") ||
          lowerName.endsWith(".ts") ||
          lowerName.endsWith(".py") ||
          lowerName.endsWith(".java") ||
          lowerName.endsWith(".c") ||
          lowerName.endsWith(".cpp") ||
          lowerName.endsWith(".sql")
        ) {
          const text = entryData.toString("utf8").trim();
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
        }
      } catch (err) {
        console.warn(`[Extraction Warning for ${cleanName}]:`, err.message);
        errors.push(`${cleanName}: ${err.message}`);
      }
    }

    if (!fullText.trim()) {
      const errorDetails = errors.length > 0 ? ` Details: ${errors.join("; ")}` : "";
      throw new Error(
        `No readable text could be extracted from archive "${originalName}".${errorDetails} ` +
        `Please ensure your document contains selectable text.`
      );
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
    } else {
      // Plain text or code
      const text = buffer.toString("utf8").trim();
      const nonWhitespace = text.replace(/\s+/g, "").length;
      if (nonWhitespace < 20) {
        throw new Error(`The document "${originalName}" does not contain sufficient readable text.`);
      }
      fullText = text;
      const textChunks = chunkTextBySections(text, 4000);
      chunks.push(...textChunks);
    }
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
