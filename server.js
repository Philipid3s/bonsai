const http = require("node:http");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { ChromaClient } = require("chromadb");
const { PDFParse } = require("pdf-parse");
const { createWorker } = require("tesseract.js");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const PUBLIC_DIR = path.join(__dirname, "public");
const NODE_MODULES_DIR = path.join(__dirname, "node_modules");
const MAX_JSON_BYTES = 1_000_000;
const MAX_PDF_JSON_BYTES = 15_000_000;
const MAX_PDF_BYTES = 10_000_000;
const OLLAMA_EMBED_MODEL =
  process.env.OLLAMA_EMBEDDING_MODEL ||
  process.env.OLLAMA_EMBED_MODEL ||
  "nomic-embed-text";
const RAG_CHUNK_SIZE = readIntEnv("RAG_CHUNK_SIZE", 1200, 200);
const RAG_CHUNK_OVERLAP = readIntEnv("RAG_CHUNK_OVERLAP", 180, 0);
const RAG_RETRIEVAL_LIMIT = readIntEnv("RAG_RETRIEVAL_LIMIT", 4, 1);
const EMBED_BATCH_SIZE = readIntEnv("EMBED_BATCH_SIZE", 16, 1);
const DEFAULT_VECTOR_INSTANCE_ID = process.env.DEFAULT_VECTOR_INSTANCE_ID || "default";
const vectorClients = new Map();
const vectorCollectionPromises = new Map();

function readBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function readIntEnv(name, defaultValue, minValue = 1) {
  const raw = Number.parseInt(process.env[name] || "", 10);
  if (Number.isNaN(raw)) return defaultValue;
  return Math.max(minValue, raw);
}

const OCR_ENABLED = readBoolEnv("OCR_ENABLED", true);
const OCR_LANG = process.env.OCR_LANG || "eng";
const OCR_MAX_PAGES = readIntEnv("OCR_MAX_PAGES", 3, 1);
const OCR_MIN_TEXT_CHARS = readIntEnv("OCR_MIN_TEXT_CHARS", 80, 0);
const OCR_IMAGE_SCALE = Number.parseFloat(process.env.OCR_IMAGE_SCALE || "2");
const SAFE_OCR_IMAGE_SCALE = Number.isFinite(OCR_IMAGE_SCALE) && OCR_IMAGE_SCALE > 0 ? OCR_IMAGE_SCALE : 2;
const BRAVE_SEARCH_ENABLED = readBoolEnv("BRAVE_SEARCH_ENABLED", false);
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || "";
const BRAVE_SEARCH_MAX_RESULTS = readIntEnv("BRAVE_SEARCH_MAX_RESULTS", 5, 1);
const BRAVE_SEARCH_COUNTRY = (process.env.BRAVE_SEARCH_COUNTRY || "US").toUpperCase();
let ocrWorkerPromise = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker(OCR_LANG);
  }
  return ocrWorkerPromise;
}

async function runPdfOcr(parser, totalPages) {
  const screenshot = await parser.getScreenshot({
    first: Math.min(OCR_MAX_PAGES, totalPages || OCR_MAX_PAGES),
    scale: SAFE_OCR_IMAGE_SCALE,
    imageDataUrl: false,
    imageBuffer: true
  });

  const worker = await getOcrWorker();
  const parts = [];
  for (const page of screenshot.pages || []) {
    const imageBuffer = Buffer.from(page.data || []);
    if (imageBuffer.length === 0) continue;
    const result = await worker.recognize(imageBuffer);
    const pageText = (result.data?.text || "").trim();
    if (pageText) {
      parts.push(pageText);
    }
  }
  return parts.join("\n\n").trim();
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseVectorInstancesFromEnv() {
  const raw = process.env.VECTOR_DB_INSTANCES;
  if (!raw || !raw.trim()) {
    return [{
      id: DEFAULT_VECTOR_INSTANCE_ID,
      name: "Vector:Chroma:1",
      host: process.env.CHROMA_HOST || "127.0.0.1",
      port: readIntEnv("CHROMA_PORT", 8000, 1),
      ssl: readBoolEnv("CHROMA_SSL", false),
      tenant: process.env.CHROMA_TENANT || undefined,
      database: process.env.CHROMA_DATABASE || undefined,
      collection: process.env.CHROMA_COLLECTION || "bonsai_documents"
    }];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid VECTOR_DB_INSTANCES JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("VECTOR_DB_INSTANCES must be a non-empty JSON array.");
  }

  return parsed.map((item, index) => {
    const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `vector-${index + 1}`;
    const host = typeof item?.host === "string" && item.host.trim() ? item.host.trim() : "127.0.0.1";
    const collection = typeof item?.collection === "string" && item.collection.trim()
      ? item.collection.trim()
      : "bonsai_documents";
    const defaultName = `Vector:Chroma:${index + 1}`;
    return {
      id,
      name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : defaultName,
      host,
      port: Number.isFinite(Number(item?.port)) ? Math.max(1, Number(item.port)) : 8000,
      ssl: typeof item?.ssl === "boolean" ? item.ssl : false,
      tenant: typeof item?.tenant === "string" && item.tenant.trim() ? item.tenant.trim() : undefined,
      database: typeof item?.database === "string" && item.database.trim() ? item.database.trim() : undefined,
      collection
    };
  });
}

const VECTOR_INSTANCES = parseVectorInstancesFromEnv();
const VECTOR_INSTANCES_BY_ID = new Map(VECTOR_INSTANCES.map((item) => [item.id, item]));
const DEFAULT_VECTOR_INSTANCE = VECTOR_INSTANCES_BY_ID.get(DEFAULT_VECTOR_INSTANCE_ID) || VECTOR_INSTANCES[0];

function listVectorInstances() {
  return VECTOR_INSTANCES.map((item) => ({
    id: item.id,
    name: item.name,
    host: item.host,
    port: item.port,
    ssl: item.ssl,
    collection: item.collection,
    isDefault: item.id === DEFAULT_VECTOR_INSTANCE.id
  }));
}

function getVectorInstanceConfig(instanceId) {
  if (typeof instanceId === "string" && VECTOR_INSTANCES_BY_ID.has(instanceId)) {
    return VECTOR_INSTANCES_BY_ID.get(instanceId);
  }
  return DEFAULT_VECTOR_INSTANCE;
}

function getChromaClient(instanceId) {
  const config = getVectorInstanceConfig(instanceId);
  if (!vectorClients.has(config.id)) {
    vectorClients.set(config.id, new ChromaClient({
      host: config.host,
      port: config.port,
      ssl: config.ssl,
      tenant: config.tenant,
      database: config.database
    }));
  }
  return vectorClients.get(config.id);
}

async function getOrCreateRagCollection(instanceId) {
  const config = getVectorInstanceConfig(instanceId);
  if (!vectorCollectionPromises.has(config.id)) {
    const promise = getChromaClient(config.id).getOrCreateCollection({
      name: config.collection,
      embeddingFunction: null
    }).catch((error) => {
      vectorCollectionPromises.delete(config.id);
      throw error;
    });
    vectorCollectionPromises.set(config.id, promise);
  }
  return vectorCollectionPromises.get(config.id);
}

async function getExistingRagCollection(instanceId) {
  const config = getVectorInstanceConfig(instanceId);
  try {
    return await getChromaClient(config.id).getCollection({
      name: config.collection,
      embeddingFunction: null
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (/not found|does not exist|404/i.test(message)) {
      return null;
    }
    throw error;
  }
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function splitTextIntoChunks(text, chunkSize = RAG_CHUNK_SIZE, overlap = RAG_CHUNK_OVERLAP) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const safeOverlap = Math.max(0, Math.min(overlap, chunkSize - 1));
  const step = Math.max(1, chunkSize - safeOverlap);
  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chunkSize);
    if (end < normalized.length) {
      const lastParagraphBreak = normalized.lastIndexOf("\n\n", end);
      const lastSentenceBreak = Math.max(
        normalized.lastIndexOf(". ", end),
        normalized.lastIndexOf("? ", end),
        normalized.lastIndexOf("! ", end)
      );
      const lastSpace = normalized.lastIndexOf(" ", end);
      const candidateBreak = Math.max(lastParagraphBreak, lastSentenceBreak, lastSpace);
      if (candidateBreak > start + Math.floor(chunkSize * 0.6)) {
        end = candidateBreak;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }
    start = Math.max(start + 1, end - safeOverlap);
  }

  return chunks;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

async function embedTextsWithOllama(texts) {
  const cleanTexts = texts.map((value) => normalizeWhitespace(value)).filter(Boolean);
  if (cleanTexts.length === 0) return [];

  const { response, payload } = await fetchJson(`${OLLAMA_BASE_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_EMBED_MODEL,
      input: cleanTexts
    })
  });

  if (response.ok && Array.isArray(payload.embeddings)) {
    return payload.embeddings;
  }

  const fallbackEmbeddings = [];
  for (const input of cleanTexts) {
    const fallback = await fetchJson(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_EMBED_MODEL,
        prompt: input
      })
    });

    if (!fallback.response.ok || !Array.isArray(fallback.payload.embedding)) {
      const details =
        fallback.payload?.error ||
        payload?.error ||
        payload?.raw ||
        "Failed to generate embeddings with Ollama.";
      throw createHttpError(502, String(details));
    }

    fallbackEmbeddings.push(fallback.payload.embedding);
  }

  return fallbackEmbeddings;
}

async function embedTexts(texts) {
  const vectors = [];
  for (let index = 0; index < texts.length; index += EMBED_BATCH_SIZE) {
    const batch = texts.slice(index, index + EMBED_BATCH_SIZE);
    const batchVectors = await embedTextsWithOllama(batch);
    vectors.push(...batchVectors);
  }
  return vectors;
}

async function ingestDocumentIntoRag({ instanceId, documentId, filename, pages, text }) {
  const cleanText = normalizeWhitespace(text);
  const finalDocumentId = typeof documentId === "string" && documentId.trim() ? documentId.trim() : randomUUID();
  if (!filename || !cleanText) {
    throw createHttpError(400, "filename and text are required.");
  }

  const chunks = splitTextIntoChunks(cleanText);
  if (chunks.length === 0) {
    throw createHttpError(422, "No usable text chunks were produced for ingestion.");
  }

  const collection = await getOrCreateRagCollection(instanceId);
  const embeddings = await embedTexts(chunks);
  const chunkCount = chunks.length;
  const ids = chunks.map((_, index) => `${finalDocumentId}:${index + 1}`);
  const metadatas = chunks.map((chunk, index) => ({
    libraryDocumentId: finalDocumentId,
    filename,
    pages: typeof pages === "number" ? pages : -1,
    chunkIndex: index + 1,
    chunkCount,
    charCount: chunk.length
  }));

  try {
    await collection.delete({
      where: { libraryDocumentId: finalDocumentId }
    });
  } catch {
    // Ignore delete misses on first ingest.
  }

  await collection.upsert({
    ids,
    documents: chunks,
    embeddings,
    metadatas
  });

  return { chunkCount, documentId: finalDocumentId };
}

async function deleteDocumentFromRag(instanceId, documentId) {
  if (!documentId || typeof documentId !== "string") {
    throw createHttpError(400, "documentId is required.");
  }

  const collection = await getExistingRagCollection(instanceId);
  if (!collection) {
    return { deleted: 0 };
  }

  const result = await collection.delete({
    where: { libraryDocumentId: documentId }
  });
  return { deleted: Number(result?.deleted || 0) };
}

function buildRagContextMessage(query, rows, instanceName) {
  const lines = [
    `Knowledge base: ${instanceName}`,
    "Answer using the retrieved knowledge-base excerpts below when they are relevant.",
    "If the excerpts do not support the answer, say that the indexed knowledge base does not contain it.",
    "When you use an excerpt, cite it inline using the source label exactly as provided.",
    `User query: ${query}`,
    "",
    "Retrieved excerpts:"
  ];

  rows.forEach((row, index) => {
    const filename = row.metadata?.filename || "document";
    const chunkIndex = row.metadata?.chunkIndex || index + 1;
    const distance = typeof row.distance === "number" ? row.distance.toFixed(4) : "n/a";
    const sourceLabel = `[source: ${filename} chunk ${chunkIndex}]`;
    lines.push(`${index + 1}. ${sourceLabel} similarity=${distance}`);
    lines.push(row.document || "");
    lines.push("");
  });

  return lines.join("\n").trim();
}

function summarizeLibraryRows(rows) {
  const docs = new Map();
  let totalChars = 0;

  for (const row of rows) {
    const metadata = row.metadata || {};
    const documentId = metadata.libraryDocumentId;
    if (!documentId) continue;

    const charCount = Number(metadata.charCount) || 0;
    totalChars += charCount;

    if (!docs.has(documentId)) {
      docs.set(documentId, {
        documentId,
        filename: metadata.filename || "document.pdf",
        pages: Number(metadata.pages) >= 0 ? Number(metadata.pages) : null,
        chunkCount: 0,
        totalChars: 0
      });
    }

    const doc = docs.get(documentId);
    doc.chunkCount += 1;
    doc.totalChars += charCount;
  }

  const documents = [...docs.values()].sort((a, b) => a.filename.localeCompare(b.filename));
  return {
    documents,
    stats: {
      documentCount: documents.length,
      chunkCount: rows.length,
      totalChars
    }
  };
}

async function getVectorLibraryOverview(instanceId) {
  const instance = getVectorInstanceConfig(instanceId);
  const collection = await getExistingRagCollection(instance.id);
  if (!collection) {
    return {
      instance: {
        id: instance.id,
        name: instance.name,
        host: instance.host,
        port: instance.port,
        ssl: instance.ssl,
        collection: instance.collection,
        type: "Chroma"
      },
      stats: {
        documentCount: 0,
        chunkCount: 0,
        totalChars: 0
      },
      documents: []
    };
  }
  const collectionCount = await collection.count();

  if (collectionCount === 0) {
    return {
      instance: {
        id: instance.id,
        name: instance.name,
        host: instance.host,
        port: instance.port,
        ssl: instance.ssl,
        collection: instance.collection,
        type: "Chroma"
      },
      stats: {
        documentCount: 0,
        chunkCount: 0,
        totalChars: 0
      },
      documents: []
    };
  }

  const result = await collection.get({
    limit: collectionCount,
    include: ["metadatas"]
  });
  const rows = result.rows().filter((row) => row.metadata?.libraryDocumentId);
  const summary = summarizeLibraryRows(rows);

  return {
    instance: {
      id: instance.id,
      name: instance.name,
      host: instance.host,
      port: instance.port,
      ssl: instance.ssl,
      collection: instance.collection,
      type: "Chroma"
    },
    stats: summary.stats,
    documents: summary.documents
  };
}

async function testVectorInstance(instanceId) {
  const instance = getVectorInstanceConfig(instanceId);
  const client = getChromaClient(instance.id);

  const summary = {
    ok: false,
    instance: {
      id: instance.id,
      name: instance.name,
      type: "Chroma",
      host: instance.host,
      port: instance.port,
      ssl: instance.ssl,
      collection: instance.collection
    },
    checks: {
      heartbeat: { ok: false, detail: "" },
      collection: { ok: false, detail: "" }
    }
  };

  try {
    const heartbeat = await client.heartbeat();
    summary.checks.heartbeat = {
      ok: true,
      detail: `Heartbeat OK (${heartbeat})`
    };
  } catch (error) {
    summary.checks.heartbeat = {
      ok: false,
      detail: error.message || "Heartbeat failed."
    };
    return summary;
  }

  try {
    const collection = await getExistingRagCollection(instance.id);
    if (!collection) {
      summary.checks.collection = {
        ok: true,
        detail: `Collection "${instance.collection}" does not exist yet (will be created on first ingest)`
      };
      summary.ok = true;
      return summary;
    }
    const count = await collection.count();
    summary.checks.collection = {
      ok: true,
      detail: `Collection "${instance.collection}" reachable (${count} chunk records)`
    };
    summary.ok = true;
  } catch (error) {
    summary.checks.collection = {
      ok: false,
      detail: error.message || "Collection access failed."
    };
  }

  return summary;
}

async function maybeAugmentMessagesWithDocumentContext(messages, vectorSearchEnabled, vectorInstanceId) {
  if (!vectorSearchEnabled) {
    return messages;
  }

  const query = getLatestUserMessage(messages);
  if (!query) {
    return messages;
  }

  const instance = getVectorInstanceConfig(vectorInstanceId);
  const queryEmbeddings = await embedTexts([query]);
  const collection = await getExistingRagCollection(instance.id);
  if (!collection) {
    return [
      {
        role: "system",
        content: `Knowledge base "${instance.name}" is empty. Say clearly that no indexed documents are available yet.`
      },
      ...messages
    ];
  }
  const result = await collection.query({
    queryEmbeddings,
    nResults: RAG_RETRIEVAL_LIMIT,
    include: ["documents", "metadatas", "distances"]
  });

  const rows = result.rows()[0]?.filter((row) => row.document) || [];
  if (rows.length === 0) {
    return [
      {
        role: "system",
        content:
          `Knowledge base "${instance.name}" returned no matching excerpts for the current question. Say clearly if the answer is not in the indexed material.`
      },
      ...messages
    ];
  }

  return [
    {
      role: "system",
      content: buildRagContextMessage(query, rows, instance.name)
    },
    ...messages
  ];
}

function normalizeQueryForIntent(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldRunWebSearch(query) {
  const normalized = normalizeQueryForIntent(query);
  if (!normalized) return false;

  const smallTalkPatterns = [
    /^(hi|hello|hey|yo)\b/,
    /^how are you\b/,
    /^what s up\b/,
    /^(thanks|thank you)\b/,
    /^(good morning|good afternoon|good evening|good night)\b/,
    /^who are you\b/,
    /^what can you do\b/
  ];
  if (smallTalkPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const explicitWebPatterns = [
    /\b(search the web|web search|look up|find online|browse)\b/,
    /\b(source|sources|reference|references|citation|cite)\b/
  ];
  if (explicitWebPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const freshDataPatterns = [
    /\b(latest|current|today|yesterday|this week|recent)\b/,
    /\b(news|headline|breaking)\b/,
    /\b(weather|forecast|temperature)\b/,
    /\b(price|stock|market cap|exchange rate|score|standings|schedule)\b/,
    /\b(version|release date|release notes|changelog|updated)\b/,
    /\b(president|prime minister|ceo)\b/
  ];
  return freshDataPatterns.some((pattern) => pattern.test(normalized));
}

function getLatestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}

async function fetchBraveWebResults(query) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(BRAVE_SEARCH_MAX_RESULTS));
  url.searchParams.set("country", BRAVE_SEARCH_COUNTRY);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": BRAVE_SEARCH_API_KEY
    }
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const details = payload.error || payload.message || payload.raw || "Brave Search request failed.";
    throw createHttpError(response.status, String(details));
  }

  const results = Array.isArray(payload.web?.results) ? payload.web.results : [];
  return results
    .slice(0, BRAVE_SEARCH_MAX_RESULTS)
    .map((item) => ({
      title: item?.title || "Untitled",
      url: item?.url || "",
      description: item?.description || ""
    }))
    .filter((item) => item.url);
}

function buildWebSearchContextMessage(query, results) {
  if (results.length === 0) {
    return [
      `Web search query: ${query}`,
      "No web results were returned. Do not invent sources.",
      "If answer confidence is low, say that web results were unavailable."
    ].join("\n");
  }

  const lines = [
    `Web search query: ${query}`,
    "Use these web search snippets as supporting evidence and cite URLs you used:"
  ];

  for (const [index, item] of results.entries()) {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`URL: ${item.url}`);
    lines.push(`Snippet: ${item.description || "(no snippet)"}`);
  }

  lines.push("If the answer is not covered by these results, say so clearly.");
  return lines.join("\n");
}

async function maybeAugmentMessagesWithWebSearch(messages, webSearchEnabled, webSearchQuery) {
  if (!webSearchEnabled) return messages;

  const query = typeof webSearchQuery === "string" && webSearchQuery.trim()
    ? webSearchQuery.trim()
    : getLatestUserMessage(messages);

  if (!query) {
    throw createHttpError(400, "Web search enabled but no query text was found.");
  }

  if (!shouldRunWebSearch(query)) {
    return messages;
  }

  if (!BRAVE_SEARCH_ENABLED) {
    throw createHttpError(400, "Web search is disabled. Set BRAVE_SEARCH_ENABLED=true in .env.");
  }
  if (!BRAVE_SEARCH_API_KEY) {
    throw createHttpError(400, "Missing BRAVE_SEARCH_API_KEY for Brave web search.");
  }

  const results = await fetchBraveWebResults(query);
  const contextMessage = buildWebSearchContextMessage(query, results);
  return [{ role: "system", content: contextMessage }, ...messages];
}

function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handlePdfExtract(req, res) {
  try {
    const body = await readJsonBody(req, MAX_PDF_JSON_BYTES);
    const { filename, mimeType, dataBase64 } = body;

    if (!dataBase64 || typeof dataBase64 !== "string") {
      sendJson(res, 400, { error: "dataBase64 is required." });
      return;
    }

    if (mimeType && mimeType !== "application/pdf") {
      sendJson(res, 400, { error: "Only PDF files are supported." });
      return;
    }

    const fileBuffer = Buffer.from(dataBase64, "base64");
    if (fileBuffer.length > MAX_PDF_BYTES) {
      sendJson(res, 413, {
        error: `PDF is too large. Max supported size is ${Math.floor(MAX_PDF_BYTES / 1_000_000)}MB.`
      });
      return;
    }

    const parser = new PDFParse({ data: fileBuffer });
    let extracted;
    let text = "";
    let extractionMethod = "text";
    try {
      extracted = await parser.getText();
      text = (extracted.text || "").replace(/\r\n/g, "\n").trim();

      const shouldTryOcr = OCR_ENABLED && text.length < OCR_MIN_TEXT_CHARS;
      if (shouldTryOcr) {
        try {
          const ocrText = await runPdfOcr(parser, extracted.total || null);
          if (ocrText) {
            if (text) {
              text = `${text}\n\n${ocrText}`.trim();
              extractionMethod = "mixed";
            } else {
              text = ocrText;
              extractionMethod = "ocr";
            }
          }
        } catch (ocrError) {
          if (!text) {
            throw new Error(`OCR fallback failed: ${ocrError.message || "unknown OCR error"}`);
          }
        }
      }
    } finally {
      await parser.destroy();
    }

    if (!text) {
      sendJson(res, 422, { error: "No extractable text found in this PDF." });
      return;
    }

    sendJson(res, 200, {
      filename: filename || "document.pdf",
      pages: extracted.total || null,
      extractionMethod,
      text
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to process PDF." });
  }
}

async function handleVectorInstances(_req, res) {
  try {
    sendJson(res, 200, {
      defaultInstanceId: DEFAULT_VECTOR_INSTANCE.id,
      instances: listVectorInstances()
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to load vector instances." });
  }
}

async function handleVectorLibrary(req, res, parsedUrl) {
  try {
    const instanceId = parsedUrl.searchParams.get("instanceId");
    const payload = await getVectorLibraryOverview(instanceId);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to load knowledge base overview." });
  }
}

async function handleVectorTest(req, res, parsedUrl) {
  try {
    const instanceId = parsedUrl.searchParams.get("instanceId");
    const payload = await testVectorInstance(instanceId);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to test knowledge base connection." });
  }
}

async function handleRagIngest(req, res) {
  try {
    const body = await readJsonBody(req, MAX_PDF_JSON_BYTES);
    const { vectorInstanceId, documentId, filename, pages, text } = body;
    const instance = getVectorInstanceConfig(vectorInstanceId);
    const result = await ingestDocumentIntoRag({ instanceId: instance.id, documentId, filename, pages, text });
    sendJson(res, 200, {
      documentId: result.documentId,
      filename,
      pages: typeof pages === "number" ? pages : null,
      chunkCount: result.chunkCount,
      embeddingModel: OLLAMA_EMBED_MODEL,
      vectorInstanceId: instance.id,
      vectorInstanceName: instance.name,
      collection: instance.collection
    });
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to ingest document." });
  }
}

async function handleVectorDelete(req, res) {
  try {
    const body = await readJsonBody(req);
    const instance = getVectorInstanceConfig(body.vectorInstanceId);
    const result = await deleteDocumentFromRag(instance.id, body.documentId);
    sendJson(res, 200, {
      ok: true,
      deleted: result.deleted,
      vectorInstanceId: instance.id,
      vectorInstanceName: instance.name
    });
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to delete document from knowledge base." });
  }
}

async function handleChatStream(req, res) {
  try {
    const body = await readJsonBody(req);
    const { model, messages, webSearchEnabled, webSearchQuery, vectorSearchEnabled, vectorInstanceId } = body;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, { error: "model and messages[] are required." });
      return;
    }

    let finalMessages = await maybeAugmentMessagesWithDocumentContext(
      messages,
      Boolean(vectorSearchEnabled),
      vectorInstanceId
    );
    finalMessages = await maybeAugmentMessagesWithWebSearch(
      finalMessages,
      Boolean(webSearchEnabled),
      webSearchQuery
    );

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: finalMessages,
        stream: true
      }),
      signal: abortController.signal
    });

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
      sendJson(res, ollamaRes.status, {
        error: payload.error || "Ollama stream request failed",
        details: payload
      });
      return;
    }

    if (!ollamaRes.body) {
      sendJson(res, 500, { error: "Ollama stream did not return a response body." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(": stream-open\n\n");

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (parsed.error) {
          sendSse(res, { type: "error", error: parsed.error });
          res.end();
          return;
        }

        if (parsed.message?.content) {
          sendSse(res, { type: "token", content: parsed.message.content });
        }

        if (parsed.done) {
          sendSse(res, {
            type: "done",
            done_reason: parsed.done_reason || null
          });
        }
      }
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.message?.content) {
          sendSse(res, { type: "token", content: parsed.message.content });
        }
        if (parsed.done) {
          sendSse(res, {
            type: "done",
            done_reason: parsed.done_reason || null
          });
        }
      } catch {
        // Ignore partial trailing chunk.
      }
    }

    res.end();
  } catch (error) {
    if (res.headersSent) {
      try {
        sendSse(res, { type: "error", error: error.message || "Stream failed" });
      } catch {
        // Ignore write errors if connection already closed.
      }
      res.end();
      return;
    }
    sendJson(res, Number(error.status) || 500, { error: error.message || "Internal server error" });
  }
}

async function handleChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const { model, messages, webSearchEnabled, webSearchQuery, vectorSearchEnabled, vectorInstanceId } = body;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, { error: "model and messages[] are required." });
      return;
    }

    let finalMessages = await maybeAugmentMessagesWithDocumentContext(
      messages,
      Boolean(vectorSearchEnabled),
      vectorInstanceId
    );
    finalMessages = await maybeAugmentMessagesWithWebSearch(
      finalMessages,
      Boolean(webSearchEnabled),
      webSearchQuery
    );

    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: finalMessages,
        stream: false
      })
    });

    const text = await ollamaRes.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!ollamaRes.ok) {
      sendJson(res, ollamaRes.status, {
        error: payload.error || "Ollama request failed",
        details: payload
      });
      return;
    }

    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Internal server error" });
  }
}

async function handleModels(_req, res) {
  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    const text = await ollamaRes.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!ollamaRes.ok) {
      sendJson(res, ollamaRes.status, {
        error: payload.error || "Could not load models",
        details: payload
      });
      return;
    }

    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}

function serveStatic(req, res, parsedUrl) {
  const requestedPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && parsedUrl.pathname === "/api/models") {
    await handleModels(req, res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/vector/instances") {
    await handleVectorInstances(req, res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/vector/library") {
    await handleVectorLibrary(req, res, parsedUrl);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/vector/test") {
    await handleVectorTest(req, res, parsedUrl);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/chat/stream") {
    await handleChatStream(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/pdf/extract") {
    await handlePdfExtract(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/rag/ingest") {
    await handleRagIngest(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/vector/delete") {
    await handleVectorDelete(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, parsedUrl);
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Proxying Ollama to ${OLLAMA_BASE_URL}`);
  console.log(
    `OCR fallback: ${OCR_ENABLED ? `enabled (lang=${OCR_LANG}, maxPages=${OCR_MAX_PAGES})` : "disabled"}`
  );
  console.log(
    `Brave web search: ${
      BRAVE_SEARCH_ENABLED
        ? `enabled (country=${BRAVE_SEARCH_COUNTRY}, maxResults=${BRAVE_SEARCH_MAX_RESULTS})`
        : "disabled"
    }`
  );
  console.log(`RAG embeddings: model=${OLLAMA_EMBED_MODEL}`);
  console.log(`Vector instances: ${VECTOR_INSTANCES.map((item) => `${item.name}(${item.id})`).join(", ")}`);
});
