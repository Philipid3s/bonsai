const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { PDFParse } = require("pdf-parse");
const { createWorker } = require("tesseract.js");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_JSON_BYTES = 1_000_000;
const MAX_PDF_JSON_BYTES = 15_000_000;
const MAX_PDF_BYTES = 10_000_000;

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

async function handleChatStream(req, res) {
  try {
    const body = await readJsonBody(req);
    const { model, messages } = body;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, { error: "model and messages[] are required." });
      return;
    }

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
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
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}

async function handleChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const { model, messages } = body;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, { error: "model and messages[] are required." });
      return;
    }

    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
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
    sendJson(res, 500, { error: error.message || "Internal server error" });
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
});
