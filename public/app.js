const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const promptEl = document.getElementById("prompt");
const sendBtnEl = document.getElementById("send-btn");
const modelEl = document.getElementById("model");
const attachBtnEl = document.getElementById("attach-btn");
const pdfFileEl = document.getElementById("pdf-file");
const attachedFilesEl = document.getElementById("attached-files");
const newChatBtnEl = document.getElementById("new-chat-btn");
const threadsListEl = document.getElementById("threads-list");

const STORAGE_KEY = "localllama_threads_v1";
const MAX_PDF_CONTEXT_CHARS = 12_000;
const MAX_TOTAL_PDF_CONTEXT_CHARS = 30_000;
const MAX_STORED_PDF_TEXT_CHARS = 120_000;

let threads = [];
let activeThreadId = null;
let isSending = false;
let isPdfLoading = false;
let storageWarningShown = false;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineMarkdown(value) {
  const inlineCodeTokens = [];
  let output = value.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `__INLINE_CODE_${inlineCodeTokens.length}__`;
    inlineCodeTokens.push(`<code>${code}</code>`);
    return token;
  });

  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, text, url) => {
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${text}</a>`;
  });
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  inlineCodeTokens.forEach((html, index) => {
    output = output.replace(`__INLINE_CODE_${index}__`, html);
  });

  return output;
}

function renderMarkdownToSafeHtml(markdownText) {
  const codeBlockTokens = [];
  let text = escapeHtml(markdownText || "").replace(/\r\n/g, "\n");

  text = text.replace(/```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const token = `__CODE_BLOCK_${codeBlockTokens.length}__`;
    const className = lang ? ` class="language-${lang}"` : "";
    codeBlockTokens.push(`<pre><code${className}>${code}</code></pre>`);
    return token;
  });

  const lines = text.split("\n");
  const htmlParts = [];
  let inList = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const listMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (listMatch) {
      if (!inList) {
        inList = true;
        htmlParts.push("<ul>");
      }
      htmlParts.push(`<li>${formatInlineMarkdown(listMatch[1])}</li>`);
      continue;
    }

    if (inList) {
      inList = false;
      htmlParts.push("</ul>");
    }

    if (!trimmed) {
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (/^__CODE_BLOCK_\d+__$/.test(trimmed)) {
      htmlParts.push(trimmed);
      continue;
    }

    htmlParts.push(`<p>${formatInlineMarkdown(trimmed)}</p>`);
  }

  if (inList) {
    htmlParts.push("</ul>");
  }

  let html = htmlParts.join("\n");
  codeBlockTokens.forEach((blockHtml, index) => {
    html = html.replace(`__CODE_BLOCK_${index}__`, blockHtml);
  });

  return html || "<p></p>";
}

function setMessageContent(messageEl, role, text) {
  if (role === "assistant") {
    messageEl.dataset.rawText = text;
    messageEl.innerHTML = renderMarkdownToSafeHtml(text);
  } else {
    messageEl.textContent = text;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function createThread() {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [],
    pdfContexts: []
  };
}

function getActiveThread() {
  return threads.find((thread) => thread.id === activeThreadId) || null;
}

function getThreadById(threadId) {
  return threads.find((thread) => thread.id === threadId) || null;
}

function moveThreadToTop(threadId) {
  const idx = threads.findIndex((thread) => thread.id === threadId);
  if (idx <= 0) return;
  const [thread] = threads.splice(idx, 1);
  threads.unshift(thread);
}

function formatThreadTime(iso) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function saveThreadState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeThreadId,
        threads
      })
    );
    storageWarningShown = false;
    return true;
  } catch {
    if (!storageWarningShown) {
      storageWarningShown = true;
      addMessage("system", "Could not persist chats to localStorage (likely storage quota reached).");
    }
    return false;
  }
}

function normalizeThread(rawThread) {
  if (!rawThread || typeof rawThread !== "object") return null;
  if (typeof rawThread.id !== "string") return null;

  const history = Array.isArray(rawThread.history)
    ? rawThread.history
        .filter((message) => message && typeof message.role === "string" && typeof message.content === "string")
        .map((message) => ({ role: message.role, content: message.content }))
    : [];

  const pdfContexts = Array.isArray(rawThread.pdfContexts)
    ? rawThread.pdfContexts
        .filter(
          (ctx) =>
            ctx &&
            typeof ctx.id === "string" &&
            typeof ctx.filename === "string" &&
            typeof ctx.text === "string"
        )
        .map((ctx) => ({
          id: ctx.id,
          filename: ctx.filename,
          pages: ctx.pages ?? null,
          text: ctx.text
        }))
    : [];

  return {
    id: rawThread.id,
    title: typeof rawThread.title === "string" ? rawThread.title : "New chat",
    createdAt: typeof rawThread.createdAt === "string" ? rawThread.createdAt : nowIso(),
    updatedAt: typeof rawThread.updatedAt === "string" ? rawThread.updatedAt : nowIso(),
    history,
    pdfContexts
  };
}

function loadThreadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.threads)) {
      return false;
    }

    const loadedThreads = parsed.threads.map(normalizeThread).filter(Boolean);
    if (loadedThreads.length === 0) {
      return false;
    }

    threads = loadedThreads;
    activeThreadId = typeof parsed.activeThreadId === "string" ? parsed.activeThreadId : threads[0].id;
    if (!threads.some((thread) => thread.id === activeThreadId)) {
      activeThreadId = threads[0].id;
    }

    moveThreadToTop(activeThreadId);
    return true;
  } catch {
    return false;
  }
}

function touchThread(thread) {
  thread.updatedAt = nowIso();
}

function addMessage(role, text) {
  const messageEl = document.createElement("article");
  messageEl.className = `message ${role}`;
  setMessageContent(messageEl, role, text);
  messagesEl.appendChild(messageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return messageEl;
}

function appendMessageContent(messageEl, content) {
  if (messageEl.classList.contains("assistant")) {
    const nextText = (messageEl.dataset.rawText || "") + content;
    setMessageContent(messageEl, "assistant", nextText);
  } else {
    messageEl.textContent += content;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessages() {
  messagesEl.innerHTML = "";
  const thread = getActiveThread();
  if (!thread) return;

  if (thread.history.length === 0) {
    addMessage("system", "New chat ready. Type a prompt or attach PDFs for context.");
    return;
  }

  thread.history.forEach((message) => {
    addMessage(message.role, message.content);
  });
}

function renderAttachedFiles() {
  attachedFilesEl.innerHTML = "";
  const thread = getActiveThread();
  if (!thread) return;

  thread.pdfContexts.forEach((item) => {
    const chipEl = document.createElement("div");
    chipEl.className = "attached-chip";
    chipEl.innerHTML = `
      <span>${item.filename} (${item.pages ?? "?"}p)</span>
      <button type="button" data-id="${item.id}" aria-label="Remove ${item.filename}">x</button>
    `;
    attachedFilesEl.appendChild(chipEl);
  });

  const canEditAttachments = !(isSending || isPdfLoading);
  attachedFilesEl.querySelectorAll("button").forEach((btn) => {
    btn.disabled = !canEditAttachments;
  });
}

function createThreadActionButton(action, threadId, className, title, svgPath) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.action = action;
  button.dataset.threadId = threadId;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${svgPath}"/></svg>`;
  return button;
}

function renderThreadsList() {
  threadsListEl.innerHTML = "";
  const disabled = isSending || isPdfLoading;

  threads.forEach((thread) => {
    const itemEl = document.createElement("article");
    itemEl.className = `thread-item ${thread.id === activeThreadId ? "active" : ""}`;

    const rowEl = document.createElement("div");
    rowEl.className = "thread-item-row";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "thread-open-btn";
    openBtn.disabled = disabled;
    openBtn.dataset.action = "open";
    openBtn.dataset.threadId = thread.id;

    const titleEl = document.createElement("span");
    titleEl.className = "thread-item-title";
    titleEl.textContent = thread.title || "New chat";
    openBtn.appendChild(titleEl);

    const actionsEl = document.createElement("div");
    actionsEl.className = "thread-item-actions";

    const renameBtn = createThreadActionButton(
      "rename",
      thread.id,
      "thread-mini-btn",
      "Rename chat",
      "M3 17.25V21h3.75L17.8 9.95l-3.75-3.75L3 17.25zm14.71-9.04a1 1 0 0 0 0-1.41l-1.51-1.51a1 1 0 0 0-1.41 0l-1.17 1.17 3.75 3.75 1.34-1.99z"
    );
    renameBtn.disabled = disabled;

    const deleteBtn = createThreadActionButton(
      "delete",
      thread.id,
      "thread-mini-btn delete",
      "Delete chat",
      "M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM7 9h2v9H7V9z"
    );
    deleteBtn.disabled = disabled;

    actionsEl.appendChild(renameBtn);
    actionsEl.appendChild(deleteBtn);
    rowEl.appendChild(openBtn);
    rowEl.appendChild(actionsEl);

    const metaEl = document.createElement("span");
    metaEl.className = "thread-item-meta";
    metaEl.textContent = `${thread.history.length} msg | ${formatThreadTime(thread.updatedAt)}`;

    itemEl.appendChild(rowEl);
    itemEl.appendChild(metaEl);
    threadsListEl.appendChild(itemEl);
  });
}

function updateUiState() {
  const hasActiveThread = Boolean(getActiveThread());
  const disabled = isSending || isPdfLoading || !hasActiveThread;
  sendBtnEl.disabled = disabled;
  promptEl.disabled = isSending || !hasActiveThread;
  modelEl.disabled = isSending;
  attachBtnEl.disabled = disabled;
  newChatBtnEl.disabled = isSending || isPdfLoading;
  sendBtnEl.textContent = isSending ? "Sending..." : "Send";

  renderThreadsList();
  renderAttachedFiles();
}

function setSendingState(nextValue) {
  isSending = nextValue;
  updateUiState();
}

function setPdfLoadingState(nextValue) {
  isPdfLoading = nextValue;
  updateUiState();
}

function setActiveThread(threadId) {
  if (!threads.some((thread) => thread.id === threadId)) return;
  activeThreadId = threadId;
  moveThreadToTop(threadId);
  saveThreadState();
  renderThreadsList();
  renderMessages();
  renderAttachedFiles();
}

function createAndActivateNewThread() {
  const thread = createThread();
  threads.unshift(thread);
  activeThreadId = thread.id;
  saveThreadState();
  renderThreadsList();
  renderMessages();
  renderAttachedFiles();
  promptEl.focus();
}

function renameThreadById(threadId) {
  const thread = getThreadById(threadId);
  if (!thread) return;

  const nextTitle = window.prompt("Rename chat", thread.title || "New chat");
  if (nextTitle === null) return;

  const cleaned = nextTitle.trim().replace(/\s+/g, " ");
  if (!cleaned) return;

  thread.title = cleaned.length > 80 ? `${cleaned.slice(0, 80)}...` : cleaned;
  touchThread(thread);
  moveThreadToTop(thread.id);
  saveThreadState();
  renderThreadsList();
}

function deleteThreadById(threadId) {
  const thread = getThreadById(threadId);
  if (!thread) return;

  const confirmed = window.confirm(`Delete chat "${thread.title || "New chat"}"?`);
  if (!confirmed) return;

  const wasActive = thread.id === activeThreadId;
  threads = threads.filter((item) => item.id !== thread.id);

  if (threads.length === 0) {
    createAndActivateNewThread();
    return;
  }

  if (wasActive) {
    activeThreadId = threads[0].id;
    renderMessages();
    renderAttachedFiles();
  }

  saveThreadState();
  renderThreadsList();
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function buildChatMessages(thread) {
  if (!thread.pdfContexts.length) {
    return thread.history;
  }

  const contextMessages = [
    {
      role: "system",
      content:
        "Use the attached PDF text as context for this thread. If context does not contain the answer, say so clearly."
    }
  ];

  let remainingChars = MAX_TOTAL_PDF_CONTEXT_CHARS;
  let truncatedCount = 0;

  for (const ctx of thread.pdfContexts) {
    if (remainingChars <= 0) {
      truncatedCount += 1;
      continue;
    }

    const availableChars = Math.min(MAX_PDF_CONTEXT_CHARS, remainingChars);
    const textForModel = ctx.text.slice(0, availableChars);
    const isTruncated = ctx.text.length > availableChars;
    if (isTruncated) {
      truncatedCount += 1;
    }
    remainingChars -= textForModel.length;

    contextMessages.push({
      role: "system",
      content: [
        `PDF filename: ${ctx.filename}`,
        `Pages: ${ctx.pages ?? "unknown"}`,
        isTruncated ? `Text was truncated to ${availableChars} characters.` : "Full extracted text included.",
        "",
        textForModel
      ].join("\n")
    });
  }

  if (truncatedCount > 0) {
    contextMessages.push({
      role: "system",
      content: `${truncatedCount} attached document(s) were partially or fully truncated due to context limits.`
    });
  }

  return [...contextMessages, ...thread.history];
}

async function consumeSseStream(response, onEvent) {
  if (!response.body) {
    throw new Error("Missing response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex !== -1) {
      const block = buffer.slice(0, boundaryIndex).trim();
      buffer = buffer.slice(boundaryIndex + 2);
      if (block) {
        const dataLines = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());

        if (dataLines.length > 0) {
          const payload = JSON.parse(dataLines.join("\n"));
          onEvent(payload);
        }
      }
      boundaryIndex = buffer.indexOf("\n\n");
    }
  }
}

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    const data = await res.json();

    const models = data.models || [];
    if (!models.length) {
      addMessage("system", "No local models found. Run `ollama pull <model>` first.");
      return;
    }

    models.forEach((entry, index) => {
      const option = document.createElement("option");
      option.value = entry.model;
      option.textContent = entry.name || entry.model;
      if (index === 0) {
        option.selected = true;
      }
      modelEl.appendChild(option);
    });
  } catch (error) {
    addMessage("system", `Could not load models: ${error.message}`);
  }
}

async function attachPdf(file) {
  if (!file) return;
  const thread = getActiveThread();
  if (!thread) return;

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    addMessage("system", "Only .pdf files are supported.");
    return;
  }

  setPdfLoadingState(true);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const dataBase64 = toBase64(arrayBuffer);
    const res = await fetch("/api/pdf/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/pdf",
        dataBase64
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not extract text from PDF.");
    }

    const rawText = data.text || "";
    const trimmedText = rawText.slice(0, MAX_STORED_PDF_TEXT_CHARS);
    const storageTrimmed = rawText.length > MAX_STORED_PDF_TEXT_CHARS;

    thread.pdfContexts.push({
      id: crypto.randomUUID(),
      filename: data.filename || file.name,
      pages: data.pages,
      text: trimmedText
    });
    touchThread(thread);
    moveThreadToTop(thread.id);
    saveThreadState();
    renderThreadsList();
    renderAttachedFiles();

    const attached = thread.pdfContexts[thread.pdfContexts.length - 1];
    const contextTruncated = attached.text.length > MAX_PDF_CONTEXT_CHARS;
    const extractionInfo =
      data.extractionMethod === "ocr"
        ? " OCR fallback was used."
        : data.extractionMethod === "mixed"
          ? " OCR fallback supplemented extracted text."
          : "";
    addMessage(
      "system",
      `Attached "${attached.filename}" (${attached.pages ?? "?"} pages). ${
        contextTruncated ? "Text may be truncated at prompt time." : "Text context is ready."
      }${extractionInfo}${storageTrimmed ? " Stored text was truncated to keep local history size manageable." : ""}`
    );
  } catch (error) {
    addMessage("system", `PDF attach error: ${error.message}`);
  } finally {
    setPdfLoadingState(false);
    pdfFileEl.value = "";
  }
}

function removePdfContext(id) {
  const thread = getActiveThread();
  if (!thread) return;

  const index = thread.pdfContexts.findIndex((doc) => doc.id === id);
  if (index === -1) return;

  const [removed] = thread.pdfContexts.splice(index, 1);
  touchThread(thread);
  saveThreadState();
  renderThreadsList();
  renderAttachedFiles();
  addMessage("system", `Removed "${removed.filename}" from thread context.`);
}

function maybeUpdateThreadTitle(thread, userText) {
  if (thread.title !== "New chat") return;
  const normalized = userText.trim().replace(/\s+/g, " ");
  if (!normalized) return;
  thread.title = normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

async function sendChatMessage(userText) {
  const thread = getActiveThread();
  const model = modelEl.value;
  if (!thread) return;

  if (!model) {
    addMessage("system", "Select a model before sending a message.");
    return;
  }

  maybeUpdateThreadTitle(thread, userText);
  thread.history.push({ role: "user", content: userText });
  touchThread(thread);
  moveThreadToTop(thread.id);
  saveThreadState();
  renderThreadsList();
  addMessage("user", userText);

  setSendingState(true);
  const assistantEl = addMessage("assistant", "");
  let reply = "";

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: buildChatMessages(thread)
      })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Chat request failed");
    }

    await consumeSseStream(res, (event) => {
      if (event.type === "token" && event.content) {
        reply += event.content;
        appendMessageContent(assistantEl, event.content);
      } else if (event.type === "error") {
        throw new Error(event.error || "Chat stream failed");
      }
    });

    if (!reply.trim()) {
      reply = "(No response content)";
      setMessageContent(assistantEl, "assistant", reply);
    }

    thread.history.push({ role: "assistant", content: reply });
    touchThread(thread);
    moveThreadToTop(thread.id);
    saveThreadState();
    renderThreadsList();
  } catch (error) {
    if (reply.trim()) {
      thread.history.push({ role: "assistant", content: reply });
      touchThread(thread);
      saveThreadState();
      renderThreadsList();
      addMessage("system", `Stream interrupted: ${error.message}`);
    } else {
      assistantEl.remove();
      addMessage("system", `Error: ${error.message}`);
    }
  } finally {
    setSendingState(false);
  }
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;

  promptEl.value = "";
  await sendChatMessage(text);
  promptEl.focus();
});

pdfFileEl.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await attachPdf(file);
});

attachBtnEl.addEventListener("click", () => {
  if (!attachBtnEl.disabled) {
    pdfFileEl.click();
  }
});

attachedFilesEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  removePdfContext(target.dataset.id);
});

newChatBtnEl.addEventListener("click", () => {
  if (newChatBtnEl.disabled) return;
  createAndActivateNewThread();
  updateUiState();
});

threadsListEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const actionBtn = target.closest("button[data-action]");
  if (!actionBtn || actionBtn.disabled) return;

  const threadId = actionBtn.dataset.threadId;
  const action = actionBtn.dataset.action;
  if (!threadId || !action) return;

  if (action === "open") {
    setActiveThread(threadId);
  } else if (action === "rename") {
    renameThreadById(threadId);
  } else if (action === "delete") {
    deleteThreadById(threadId);
  }

  updateUiState();
});

if (!loadThreadState()) {
  createAndActivateNewThread();
}

renderThreadsList();
renderMessages();
renderAttachedFiles();
updateUiState();
loadModels();
