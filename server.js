const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { PDFParse } = require("pdf-parse");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_JSON_BYTES = 1_000_000;
const MAX_PDF_JSON_BYTES = 15_000_000;
const MAX_PDF_BYTES = 10_000_000;

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
    try {
      extracted = await parser.getText();
    } finally {
      await parser.destroy();
    }
    const text = (extracted.text || "").replace(/\r\n/g, "\n").trim();
    if (!text) {
      sendJson(res, 422, { error: "No extractable text found in this PDF." });
      return;
    }

    sendJson(res, 200, {
      filename: filename || "document.pdf",
      pages: extracted.total || null,
      text
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to process PDF." });
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
});
