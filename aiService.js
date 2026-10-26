/**
 * DocQevrilo AI Assistant Service
 * Powered by Groq Cloud API (Llama 3.3 70B Versatile / Llama 3.1 8B Instant)
 * Provides document text extraction, AI summarization, context-aware Q&A with citations,
 * and customizable exam/study quizzes.
 */

const { default: pdfParse } = require("pdf-parse");
const AdmZip = require("adm-zip");
require("dotenv").config();

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const CANDIDATE_MODELS = Array.from(
  new Set([
    process.env.GROQ_MODEL,
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
  ].filter(Boolean))
);
const ACTIVE_MODEL = CANDIDATE_MODELS[0] || "qwen/qwen3.8-27b";
let lastSuccessfulModel = ACTIVE_MODEL;


// Cache for extracted text, summaries, and generated quizzes
const textCache = new Map(); // docId -> { text: string, pages: Array, extractedAt: number }
const summaryCache = new Map(); // `${docId}_${mode}` -> summaryResult
const quizCache = new Map(); // `${docId}_${topic}_${difficulty}_${count}` -> quizResult

/**
 * Get Groq API Key from environment
 */
function getGroqApiKey() {
  return process.env.GROQ_API_KEY || null;
}

/**
 * Extract clean, chunked text from a document buffer based on file extension / MIME type
 * @param {Buffer} buffer - Raw file or ZIP buffer
 * @param {string} originalName - Document filename
 * @param {string} mimeType - Document MIME type
 * @returns {Promise<{ fullText: string, chunks: Array<{ pageNum: number, label: string, text: string }> }>}
 */
async function extractDocumentText(buffer, originalName = "", mimeType = "") {
  const isZip =
    originalName.toLowerCase().endsWith(".zip") ||
    (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b);

  let fullText = "";
  const chunks = [];

  if (isZip) {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries().filter((e) => !e.isDirectory);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const cleanName = entry.entryName.replace(/^(\d+_)+/, "");
        const lowerName = cleanName.toLowerCase();
        const entryData = entry.getData();

        if (lowerName.endsWith(".pdf")) {
          const pdfResult = await extractPdfText(entryData, cleanName);
          chunks.push(...pdfResult.chunks);
          fullText += `\n\n--- File: ${cleanName} ---\n${pdfResult.fullText}`;
        } else if (
          lowerName.endsWith(".txt") ||
          lowerName.endsWith(".md") ||
          lowerName.endsWith(".json") ||
          lowerName.endsWith(".csv") ||
          lowerName.endsWith(".js") ||
          lowerName.endsWith(".py") ||
          lowerName.endsWith(".java") ||
          lowerName.endsWith(".c") ||
          lowerName.endsWith(".cpp")
        ) {
          const text = entryData.toString("utf8");
          chunks.push({
            pageNum: i + 1,
            label: cleanName,
            text,
          });
          fullText += `\n\n--- File: ${cleanName} ---\n${text}`;
        }
      }
    } catch (err) {
      console.warn("[AI Text Extract ZIP Warning]", err.message);
    }
  } else if (originalName.toLowerCase().endsWith(".pdf") || mimeType.includes("pdf")) {
    const pdfResult = await extractPdfText(buffer, originalName);
    chunks.push(...pdfResult.chunks);
    fullText = pdfResult.fullText;
  } else {
    // Plain text / Markdown / Source code
    const rawText = buffer.toString("utf8");
    fullText = rawText;
    // Chunk into ~1500-character section blocks
    const paragraphs = rawText.split(/\n\s*\n/);
    let currentChunk = "";
    let chunkIndex = 1;

    for (const para of paragraphs) {
      if ((currentChunk + "\n" + para).length > 2000 && currentChunk.trim()) {
        chunks.push({
          pageNum: chunkIndex,
          label: `Section ${chunkIndex}`,
          text: currentChunk.trim(),
        });
        chunkIndex++;
        currentChunk = para;
      } else {
        currentChunk += (currentChunk ? "\n\n" : "") + para;
      }
    }
    if (currentChunk.trim()) {
      chunks.push({
        pageNum: chunkIndex,
        label: `Section ${chunkIndex}`,
        text: currentChunk.trim(),
      });
    }
  }

  // Cap full text to ~100k characters for safe context processing
  if (fullText.length > 120000) {
    fullText = fullText.slice(0, 120000) + "\n\n[Document truncated for optimal AI processing]";
  }

  return { fullText: fullText.trim(), chunks };
}

/**
 * Extract text from PDF buffer with page number labeling
 */
async function extractPdfText(pdfBuffer, filename = "document.pdf") {
  try {
    const pdfData = await pdfParse(pdfBuffer);
    const fullText = pdfData.text || "";
    const totalPages = pdfData.numpages || 1;

    // Approximate page chunks if exact page markers are not separated
    const chunks = [];
    const pageStrings = fullText.split(/\f|\n(?=Page\s+\d+)/i);

    if (pageStrings.length > 1) {
      pageStrings.forEach((pText, idx) => {
        if (pText.trim()) {
          chunks.push({
            pageNum: idx + 1,
            label: `Page ${idx + 1}`,
            text: pText.trim(),
          });
        }
      });
    } else {
      // Chunk evenly across estimated pages
      const approxLen = Math.max(1000, Math.ceil(fullText.length / Math.max(1, totalPages)));
      for (let i = 0; i < totalPages; i++) {
        const slice = fullText.slice(i * approxLen, (i + 1) * approxLen).trim();
        if (slice) {
          chunks.push({
            pageNum: i + 1,
            label: `Page ${i + 1}`,
            text: slice,
          });
        }
      }
    }

    return { fullText, chunks, totalPages };
  } catch (err) {
    console.warn("[PDF Parse Error]", err.message);
    const rawFallback = pdfBuffer.toString("utf8").replace(/[^\x20-\x7E\n\t]/g, " ");
    return { fullText: rawFallback, chunks: [{ pageNum: 1, label: "Document", text: rawFallback }] };
  }
}

/**
 * Low-level chat completion via Groq Cloud API with automatic TPM limit compliance,
 * intelligent payload reduction, and graceful model fallback.
 */
async function callGroqChat({ messages, temperature = 0.3, maxTokens = 650, responseFormat = null, retryCount = 0 }) {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not configured in backend/.env. Please add your Groq API key to activate DocQevrilo AI."
    );
  }

  // Ensure maxTokens stays within Groq free-tier OTPM limits (<= 750 tokens)
  const safeMaxTokens = Math.min(Math.max(parseInt(maxTokens, 10) || 600, 100), 750);

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

      // If TPM or message size limit error detected, dynamically shrink text and retry once
      const isSizeError =
        response.status === 413 ||
        (response.status === 400 &&
          (errMsg.includes("Request too large") ||
            errMsg.includes("tokens per minute") ||
            errMsg.includes("TPM") ||
            errMsg.includes("message size") ||
            errMsg.includes("reduce your message size") ||
            errMsg.includes("rate limit")));

      if (isSizeError && retryCount === 0) {
        console.warn(`[Groq AI Auto-Truncation] TPM limit approached. Shrinking message context and retrying...`);
        const reducedMessages = messages.map((m) => {
          if (m.role === "user" && typeof m.content === "string") {
            return {
              ...m,
              content: m.content.length > 5000 ? m.content.slice(0, 5000) + "\n\n[Content trimmed to fit TPM limits]" : m.content,
            };
          }
          return m;
        });
        return await callGroqChat({
          messages: reducedMessages,
          temperature,
          maxTokens: Math.min(safeMaxTokens, 450),
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
 * Generates Executive Summary, Core Key Concepts, and High-Yield Revision Notes
 */
async function generateSummary(docId, documentText, docName, mode = "detailed") {
  const cacheKey = `${docId}_${mode}`;
  if (summaryCache.has(cacheKey)) {
    return summaryCache.get(cacheKey);
  }

  const systemPrompt = `You are DocQevrilo AI, an expert academic and technical study assistant.
Your task is to analyze the document text and provide a high-yield, beautifully structured summary.

Structure your response with clear Markdown headings:
## 📌 Executive Summary
A concise overview explaining the core purpose and key points in 1-2 paragraphs.

## 🔑 Key Concepts & Definitions
- **Concept Name**: Clear definition and significance.
(Highlight 3-5 crucial concepts)

## 📋 High-Yield Revision Notes
- Important takeaways, principles, or critical workflows.

## 💡 Practical Takeaways
Brief bullet points summarizing practical applications.

Be concise, accurate, and easy to read. Base all insights strictly on the provided document text.`;

  // Maximum safe character slice to stay comfortably below 8,000 TPM
  const maxChars = mode === "quick" ? 6000 : 9000;
  const safeText = (documentText || "").slice(0, maxChars);

  const userPrompt = `Document Name: "${docName}"
Format Mode: ${mode}

Document Content:
"""
${safeText}
"""

Please generate the structured summary.`;

  const maxTokens = mode === "quick" ? 400 : mode === "exam" ? 600 : 650;

  const result = await callGroqChat({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.25,
    maxTokens,
  });

  const output = {
    summary: result,
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
  // Build indexed context with section/page markers for citation, strictly capped to ~8000 chars
  const selectedChunks = (Array.isArray(chunks) && chunks.length > 0) ? chunks.slice(0, 6) : [];
  let contextSections = selectedChunks
    .map((c) => `[Source: ${c.label}]\n${(c.text || "").slice(0, 1200)}`)
    .join("\n\n---\n\n");

  if (!contextSections && documentText) {
    contextSections = documentText.slice(0, 8000);
  } else if (contextSections.length > 8000) {
    contextSections = contextSections.slice(0, 8000);
  }

  const systemPrompt = `You are DocQevrilo AI, an expert document assistant for students and professionals.
You have access to the document excerpt below with Source tags like [Source: Page 1] or [Source: Section 2].

Guidelines:
1. Answer the question accurately and concisely based on the text.
2. Whenever referencing a fact, definition, or explanation, ALWAYS cite the source in bold: **[Page X]** or **[Section Y]**.
3. If the question cannot be answered from the document, politely state that it's not mentioned.`;

  const conversation = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Here is the reference document content:\n"""\n${contextSections}\n"""`,
    },
    {
      role: "assistant",
      content: "I have read and analyzed your document. What would you like to know or clarify?",
    },
  ];

  // Append recent conversational history (up to last 4 messages to save tokens)
  if (Array.isArray(history) && history.length > 0) {
    const recentHistory = history.slice(-4);
    for (const msg of recentHistory) {
      if (msg.role && msg.content) {
        conversation.push({ role: msg.role, content: String(msg.content).slice(0, 500) });
      }
    }
  }

  conversation.push({ role: "user", content: question });

  const answer = await callGroqChat({
    messages: conversation,
    temperature: 0.3,
    maxTokens: 550,
  });

  return {
    answer,
    model: lastSuccessfulModel || ACTIVE_MODEL,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 3. AI Study Quiz Generator
 * Generates customizable MCQs with options, correct answer index, explanations, and cited sections
 */
async function generateQuiz(docId, documentText, { topic = "All Topics", difficulty = "medium", questionCount = 5 }) {
  const count = Math.min(Math.max(parseInt(questionCount, 10) || 5, 3), 10);
  const cacheKey = `${docId}_${topic}_${difficulty}_${count}`;

  if (quizCache.has(cacheKey)) {
    return quizCache.get(cacheKey);
  }

  const systemPrompt = `You are an expert exam creator for DocQevrilo.
Generate exactly ${count} multiple-choice questions (MCQs) testing understanding of the provided document.

Target Topic: "${topic}"
Difficulty Level: "${difficulty}"

Requirements:
1. Return ONLY a valid JSON array of objects without Markdown formatting or prose.
2. Each question object MUST have:
   - "id": number (1 to ${count})
   - "question": string
   - "options": array of exactly 4 strings
   - "correctIndex": number (0, 1, 2, or 3)
   - "explanation": string
   - "citation": string

Schema:
[{"id":1,"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"...","citation":"..."}]`;

  const userPrompt = `Document Content:
"""
${(documentText || "").slice(0, 8500)}
"""

Generate ${count} ${difficulty} MCQs in JSON format.`;

  const rawJson = await callGroqChat({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    maxTokens: 700,
  });

  let questions = [];
  try {
    const cleanJson = rawJson.replace(/```json/gi, "").replace(/```/g, "").trim();
    questions = JSON.parse(cleanJson);
  } catch (err) {
    console.error("[Quiz JSON Parse Error]", err.message, "Raw:", rawJson.slice(0, 200));
    throw new Error("Failed to parse quiz response into structured format. Please retry.");
  }

  const result = {
    topic,
    difficulty,
    questionCount: questions.length,
    questions,
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
};
