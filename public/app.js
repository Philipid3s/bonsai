const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const promptEl = document.getElementById("prompt");
const sendBtnEl = document.getElementById("send-btn");
const modelEl = document.getElementById("model");
const vectorInstanceEl = document.getElementById("vector-instance");
const vectorLibraryBtnEl = document.getElementById("vector-library-btn");
const webSearchBtnEl = document.getElementById("web-search-btn");
const vectorSearchBtnEl = document.getElementById("vector-search-btn");
const attachBtnEl = document.getElementById("attach-btn");
const libraryBtnEl = document.getElementById("library-btn");
const pdfFileEl = document.getElementById("pdf-file");
const libraryFileEl = document.getElementById("library-file");
const attachedFilesEl = document.getElementById("attached-files");
const newChatBtnEl = document.getElementById("new-chat-btn");
const threadsListEl = document.getElementById("threads-list");
const confirmModalEl = document.getElementById("confirm-modal");
const confirmModalDescriptionEl = document.getElementById("confirm-modal-description");
const confirmCancelBtnEl = document.getElementById("confirm-cancel-btn");
const confirmDeleteBtnEl = document.getElementById("confirm-delete-btn");
const vectorLibraryModalEl = document.getElementById("vector-library-modal");
const vectorLibraryCloseBtnEl = document.getElementById("vector-library-close-btn");
const vectorLibraryTestBtnEl = document.getElementById("vector-library-test-btn");
const vectorLibraryStatusEl = document.getElementById("vector-library-status");
const vectorLibraryTestResultEl = document.getElementById("vector-library-test-result");
const vectorLibraryStatsEl = document.getElementById("vector-library-stats");
const vectorLibraryDocsEl = document.getElementById("vector-library-docs");

const STORAGE_KEY = "bonsai_threads_v1";
const WEB_SEARCH_TOGGLE_KEY = "bonsai_web_search_enabled";
const VECTOR_SEARCH_TOGGLE_KEY = "bonsai_vector_search_enabled";
const MODEL_SELECTION_KEY = "bonsai_selected_model";
const VECTOR_INSTANCE_SELECTION_KEY = "bonsai_selected_vector_instance";
const LEGACY_STORAGE_KEY = "localllama_threads_v1";
const LEGACY_WEB_SEARCH_TOGGLE_KEY = "localllama_web_search_enabled";
const LEGACY_MODEL_SELECTION_KEY = "localllama_selected_model";
const MAX_PDF_TEXT_WARNING_CHARS = 12_000;
const MAX_STORED_PDF_TEXT_CHARS = 120_000;

let threads = [];
let activeThreadId = null;
let isSending = false;
let isPdfLoading = false;
let storageWarningShown = false;
let webSearchEnabled = false;
let vectorSearchEnabled = false;
let renamingThreadId = null;
let pendingDeleteThreadId = null;
let vectorInstances = [];
let isVectorLibraryLoading = false;
let isVectorConnectionTesting = false;

// Global Markdown configuration
if (typeof marked !== "undefined") {
  const mh = window.markedHighlight;
  if (mh && typeof hljs !== "undefined") {
    marked.use(mh.markedHighlight({
      emptyLangClass: 'hljs',
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language }).value;
      }
    }));
  }
  marked.setOptions({
    breaks: true,
    gfm: true
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdownToSafeHtml(markdownText) {
  const safeMarkdown = escapeHtml(markdownText);
  if (typeof marked === "undefined") {
    return `<p>${safeMarkdown}</p>`;
  }

  try {
    return marked.parse(safeMarkdown);
  } catch (e) {
    console.error("Markdown parse error:", e);
    return `<p>${safeMarkdown}</p>`;
  }
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

function readLocalStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function migrateLegacyStorageKey(nextKey, legacyKey) {
  const currentValue = readLocalStorage(nextKey);
  if (currentValue !== null) {
    return currentValue;
  }

  const legacyValue = readLocalStorage(legacyKey);
  if (legacyValue === null) {
    return null;
  }

  try {
    localStorage.setItem(nextKey, legacyValue);
    localStorage.removeItem(legacyKey);
  } catch {
    return legacyValue;
  }

  return legacyValue;
}

function loadWebSearchPreference() {
  return migrateLegacyStorageKey(WEB_SEARCH_TOGGLE_KEY, LEGACY_WEB_SEARCH_TOGGLE_KEY) === "true";
}

function saveWebSearchPreference(enabled) {
  try {
    localStorage.setItem(WEB_SEARCH_TOGGLE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore localStorage failures for this preference.
  }
}

function loadVectorSearchPreference() {
  return readLocalStorage(VECTOR_SEARCH_TOGGLE_KEY) === "true";
}

function saveVectorSearchPreference(enabled) {
  try {
    localStorage.setItem(VECTOR_SEARCH_TOGGLE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore localStorage failures for this preference.
  }
}

function loadSelectedModelPreference() {
  return migrateLegacyStorageKey(MODEL_SELECTION_KEY, LEGACY_MODEL_SELECTION_KEY) || "";
}

function saveSelectedModelPreference(model) {
  try {
    localStorage.setItem(MODEL_SELECTION_KEY, String(model || ""));
  } catch {
    // Ignore localStorage failures for this preference.
  }
}

function loadSelectedVectorInstancePreference() {
  return readLocalStorage(VECTOR_INSTANCE_SELECTION_KEY) || "";
}

function saveSelectedVectorInstancePreference(instanceId) {
  try {
    localStorage.setItem(VECTOR_INSTANCE_SELECTION_KEY, String(instanceId || ""));
  } catch {
    // Ignore localStorage failures for this preference.
  }
}

function applyWebSearchUiState() {
  webSearchBtnEl.classList.toggle("active", webSearchEnabled);
  webSearchBtnEl.setAttribute("aria-pressed", webSearchEnabled ? "true" : "false");
}

function applyVectorSearchUiState() {
  vectorSearchBtnEl.classList.toggle("active", vectorSearchEnabled);
  vectorSearchBtnEl.setAttribute("aria-pressed", vectorSearchEnabled ? "true" : "false");
}

function getSelectedVectorInstanceId() {
  return vectorInstanceEl.value || vectorInstances[0]?.id || "";
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
          text: ctx.text,
          extractionMethod: typeof ctx.extractionMethod === "string" ? ctx.extractionMethod : "text",
          ingestedAt: typeof ctx.ingestedAt === "string" ? ctx.ingestedAt : null,
          chunkCount: Number.isFinite(ctx.chunkCount) ? ctx.chunkCount : null
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
    const raw = migrateLegacyStorageKey(STORAGE_KEY, LEGACY_STORAGE_KEY);
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
    addMessage("system", "New chat ready. Attach a PDF for session context or add a PDF to the knowledge base.");
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

    const labelEl = document.createElement("span");
    labelEl.className = "attached-chip-title";
    labelEl.textContent = `${item.filename} (${item.pages ?? "?"}p)`;

    const statusEl = document.createElement("span");
    statusEl.className = "attached-chip-status pending";
    statusEl.textContent = "Current chat";

    const actionsEl = document.createElement("div");
    actionsEl.className = "attached-chip-actions";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.dataset.id = item.id;
    removeBtn.dataset.action = "remove";
    removeBtn.className = "attached-chip-btn";
    removeBtn.setAttribute("aria-label", `Remove ${item.filename}`);
    removeBtn.textContent = "Remove";

    actionsEl.appendChild(removeBtn);
    chipEl.appendChild(labelEl);
    chipEl.appendChild(statusEl);
    chipEl.appendChild(actionsEl);
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

function normalizeThreadTitle(value) {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}...` : cleaned;
}

function isThreadInteractionDisabled() {
  return isSending || isPdfLoading;
}

function startRenamingThread(threadId) {
  if (isThreadInteractionDisabled()) return;
  if (!getThreadById(threadId)) return;
  renamingThreadId = threadId;
  pendingDeleteThreadId = null;
  renderThreadsList();
  queueMicrotask(() => {
    const inputEl = threadsListEl.querySelector(`[data-rename-input="${threadId}"]`);
    if (!(inputEl instanceof HTMLInputElement)) return;
    inputEl.focus();
    inputEl.select();
  });
}

function cancelThreadRename() {
  if (renamingThreadId === null) return;
  renamingThreadId = null;
  renderThreadsList();
}

function commitThreadRename(threadId, nextValue) {
  const thread = getThreadById(threadId);
  if (!thread) {
    renamingThreadId = null;
    renderThreadsList();
    return;
  }

  const nextTitle = normalizeThreadTitle(nextValue);
  if (!nextTitle) {
    cancelThreadRename();
    return;
  }

  thread.title = nextTitle;
  touchThread(thread);
  moveThreadToTop(thread.id);
  renamingThreadId = null;
  saveThreadState();
  renderThreadsList();
}

function openDeleteModal(threadId) {
  const thread = getThreadById(threadId);
  if (!thread || isThreadInteractionDisabled()) return;
  pendingDeleteThreadId = threadId;
  renamingThreadId = null;
  confirmModalDescriptionEl.textContent = `Delete chat "${thread.title || "New chat"}"? This cannot be undone.`;
  confirmModalEl.classList.remove("hidden");
  confirmModalEl.setAttribute("aria-hidden", "false");
  updateUiState();
  confirmDeleteBtnEl.focus();
}

function closeDeleteModal() {
  if (pendingDeleteThreadId === null) return;
  pendingDeleteThreadId = null;
  confirmModalEl.classList.add("hidden");
  confirmModalEl.setAttribute("aria-hidden", "true");
  updateUiState();
}

function renderThreadsList() {
  threadsListEl.innerHTML = "";
  const disabled = isThreadInteractionDisabled() || pendingDeleteThreadId !== null;

  threads.forEach((thread) => {
    const itemEl = document.createElement("article");
    itemEl.className = `thread-item ${thread.id === activeThreadId ? "active" : ""}`;

    const rowEl = document.createElement("div");
    rowEl.className = "thread-item-row";

    const isRenaming = renamingThreadId === thread.id;
    let openBtn = null;

    if (isRenaming) {
      const editorWrapEl = document.createElement("form");
      editorWrapEl.className = "thread-title-editor";
      editorWrapEl.dataset.threadRenameForm = thread.id;

      const inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "thread-title-input";
      inputEl.name = "thread-title";
      inputEl.value = thread.title || "New chat";
      inputEl.maxLength = 120;
      inputEl.disabled = disabled;
      inputEl.dataset.renameInput = thread.id;
      inputEl.setAttribute("aria-label", "Rename chat");
      editorWrapEl.appendChild(inputEl);
      rowEl.appendChild(editorWrapEl);
    } else {
      openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "thread-open-btn";
      openBtn.disabled = disabled;
      openBtn.dataset.action = "open";
      openBtn.dataset.threadId = thread.id;

      const titleEl = document.createElement("span");
      titleEl.className = "thread-item-title";
      titleEl.textContent = thread.title || "New chat";
      openBtn.appendChild(titleEl);
      rowEl.appendChild(openBtn);
    }

    const actionsEl = document.createElement("div");
    actionsEl.className = "thread-item-actions";

    if (isRenaming) {
      const saveBtn = createThreadActionButton(
        "rename-save",
        thread.id,
        "thread-mini-btn confirm",
        "Save title",
        "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"
      );
      saveBtn.disabled = disabled;

      const cancelBtn = createThreadActionButton(
        "rename-cancel",
        thread.id,
        "thread-mini-btn",
        "Cancel rename",
        "M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.71 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29l6.3 6.3 6.29-6.3z"
      );
      cancelBtn.disabled = disabled;

      actionsEl.appendChild(saveBtn);
      actionsEl.appendChild(cancelBtn);
    } else {
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
    }

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
  const modalOpen = pendingDeleteThreadId !== null;
  const libraryModalOpen = !vectorLibraryModalEl.classList.contains("hidden");
  const disabled = isSending || isPdfLoading || !hasActiveThread || modalOpen;
  sendBtnEl.disabled = disabled;
  promptEl.disabled = isSending || !hasActiveThread || modalOpen || libraryModalOpen;
  modelEl.disabled = isSending || modalOpen || libraryModalOpen;
  vectorInstanceEl.disabled = isSending || isPdfLoading || modalOpen || libraryModalOpen || vectorInstances.length === 0;
  vectorLibraryBtnEl.disabled = isSending || isPdfLoading || modalOpen || vectorInstances.length === 0 || isVectorLibraryLoading;
  vectorLibraryTestBtnEl.disabled = isSending || isPdfLoading || modalOpen || isVectorLibraryLoading || isVectorConnectionTesting;
  webSearchBtnEl.disabled = isSending || modalOpen || libraryModalOpen;
  vectorSearchBtnEl.disabled = isSending || modalOpen || libraryModalOpen || vectorInstances.length === 0;
  attachBtnEl.disabled = disabled || libraryModalOpen;
  libraryBtnEl.disabled = isSending || isPdfLoading || modalOpen || libraryModalOpen || vectorInstances.length === 0;
  newChatBtnEl.disabled = isSending || isPdfLoading || modalOpen || libraryModalOpen;
  sendBtnEl.textContent = isSending ? "Sending..." : "Send";
  confirmCancelBtnEl.disabled = isSending || isPdfLoading;
  confirmDeleteBtnEl.disabled = isSending || isPdfLoading;
  applyWebSearchUiState();
  applyVectorSearchUiState();

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
  renamingThreadId = null;
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

function deleteThreadById(threadId) {
  const thread = getThreadById(threadId);
  if (!thread) return;

  const wasActive = thread.id === activeThreadId;
  threads = threads.filter((item) => item.id !== thread.id);
  pendingDeleteThreadId = null;

  if (threads.length === 0) {
    createAndActivateNewThread();
    confirmModalEl.classList.add("hidden");
    confirmModalEl.setAttribute("aria-hidden", "true");
    return;
  }

  if (wasActive) {
    activeThreadId = threads[0].id;
    renderMessages();
    renderAttachedFiles();
  }

  saveThreadState();
  confirmModalEl.classList.add("hidden");
  confirmModalEl.setAttribute("aria-hidden", "true");
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
        "Use the attached PDF text as session-only context for this chat. If the attachment does not contain the answer, say so clearly."
    }
  ];

  let remainingChars = 30_000;
  let truncatedCount = 0;

  for (const ctx of thread.pdfContexts) {
    if (remainingChars <= 0) {
      truncatedCount += 1;
      continue;
    }

    const availableChars = Math.min(12_000, remainingChars);
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
      content: `${truncatedCount} attached PDF document(s) were partially or fully truncated due to session context limits.`
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

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function renderVectorLibraryOverview(data) {
  const instance = data.instance || {};
  const stats = data.stats || {};
  const documents = Array.isArray(data.documents) ? data.documents : [];

  vectorLibraryStatusEl.textContent = `${instance.name || "Knowledge Base"} · ${instance.type || "Vector DB"} · ${
    instance.ssl ? "https" : "http"
  }://${instance.host || "localhost"}:${instance.port ?? "?"} · ${instance.collection || "collection"}`;

  vectorLibraryStatsEl.innerHTML = `
    <article class="library-stat-card">
      <span class="library-stat-label">Documents</span>
      <strong class="library-stat-value">${formatCount(stats.documentCount)}</strong>
    </article>
    <article class="library-stat-card">
      <span class="library-stat-label">Chunks</span>
      <strong class="library-stat-value">${formatCount(stats.chunkCount)}</strong>
    </article>
    <article class="library-stat-card">
      <span class="library-stat-label">Characters</span>
      <strong class="library-stat-value">${formatCount(stats.totalChars)}</strong>
    </article>
  `;

  if (!documents.length) {
    vectorLibraryDocsEl.innerHTML = `<div class="library-empty">No indexed documents found in this knowledge base.</div>`;
    return;
  }

  vectorLibraryDocsEl.innerHTML = documents.map((doc) => `
    <article class="library-doc-item">
      <div class="library-doc-main">
        <strong class="library-doc-title">${escapeHtml(doc.filename)}</strong>
        <span class="library-doc-meta">ID: ${escapeHtml(doc.documentId)}</span>
      </div>
      <div class="library-doc-side">
        <div class="library-doc-metrics">
          <span>${doc.pages == null ? "?" : formatCount(doc.pages)}p</span>
          <span>${formatCount(doc.chunkCount)} chunks</span>
          <span>${formatCount(doc.totalChars)} chars</span>
        </div>
        <button
          type="button"
          class="attached-chip-btn library-delete-btn"
          data-action="delete-library-doc"
          data-document-id="${escapeHtml(doc.documentId)}"
          data-filename="${escapeHtml(doc.filename)}"
        >
          Delete
        </button>
      </div>
    </article>
  `).join("");
}

function renderVectorConnectionTestResult(data) {
  const instance = data.instance || {};
  const heartbeat = data.checks?.heartbeat || {};
  const collection = data.checks?.collection || {};

  vectorLibraryTestResultEl.classList.remove("hidden", "ok", "error");
  vectorLibraryTestResultEl.classList.add(data.ok ? "ok" : "error");
  vectorLibraryTestResultEl.innerHTML = `
    <strong>Connection test: ${data.ok ? "OK" : "Failed"}</strong>
    <div>Type: ${escapeHtml(instance.type || "Vector")}</div>
    <div>Host: ${escapeHtml(instance.host || "localhost")}</div>
    <div>Port: ${escapeHtml(String(instance.port ?? "?"))}</div>
    <div>Collection: ${escapeHtml(instance.collection || "collection")}</div>
    <div>Heartbeat: ${escapeHtml(heartbeat.detail || "Not checked")}</div>
    <div>Collection access: ${escapeHtml(collection.detail || "Not checked")}</div>
  `;
}

async function openVectorLibraryModal() {
  if (!vectorInstances.length) return;

  vectorLibraryModalEl.classList.remove("hidden");
  vectorLibraryModalEl.setAttribute("aria-hidden", "false");
  vectorLibraryStatusEl.textContent = "Loading knowledge base details...";
  vectorLibraryTestResultEl.classList.add("hidden");
  vectorLibraryTestResultEl.innerHTML = "";
  vectorLibraryStatsEl.innerHTML = "";
  vectorLibraryDocsEl.innerHTML = "";
  isVectorLibraryLoading = true;
  updateUiState();

  try {
    const instanceId = getSelectedVectorInstanceId();
    const res = await fetch(`/api/vector/library?instanceId=${encodeURIComponent(instanceId)}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not load knowledge base browser.");
    }
    renderVectorLibraryOverview(data);
  } catch (error) {
    vectorLibraryStatusEl.textContent = `Could not load knowledge base details: ${error.message}`;
    vectorLibraryStatsEl.innerHTML = "";
    vectorLibraryDocsEl.innerHTML = `<div class="library-empty">No data available.</div>`;
  } finally {
    isVectorLibraryLoading = false;
    updateUiState();
  }
}

function closeVectorLibraryModal() {
  vectorLibraryModalEl.classList.add("hidden");
  vectorLibraryModalEl.setAttribute("aria-hidden", "true");
  updateUiState();
}

async function deleteVectorLibraryDocument(documentId, filename) {
  if (!documentId) return;

  isVectorLibraryLoading = true;
  vectorLibraryStatusEl.textContent = `Deleting "${filename || documentId}" from the knowledge base...`;
  updateUiState();

  try {
    const res = await fetch("/api/vector/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectorInstanceId: getSelectedVectorInstanceId(),
        documentId
      })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not delete document from knowledge base.");
    }

    addMessage("system", `Deleted "${filename || documentId}" from knowledge base "${data.vectorInstanceName}".`);
    await openVectorLibraryModal();
  } catch (error) {
    vectorLibraryStatusEl.textContent = `Delete failed: ${error.message}`;
    addMessage("system", `Knowledge base delete error: ${error.message}`);
  } finally {
    isVectorLibraryLoading = false;
    updateUiState();
  }
}

async function runVectorConnectionTest() {
  if (!vectorInstances.length) return;

  isVectorConnectionTesting = true;
  vectorLibraryTestBtnEl.textContent = "Testing...";
  vectorLibraryTestResultEl.classList.remove("hidden", "ok", "error");
  vectorLibraryTestResultEl.innerHTML = "Running connection test...";
  updateUiState();

  try {
    const instanceId = getSelectedVectorInstanceId();
    const res = await fetch(`/api/vector/test?instanceId=${encodeURIComponent(instanceId)}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Connection test failed.");
    }
    renderVectorConnectionTestResult(data);
  } catch (error) {
    vectorLibraryTestResultEl.classList.remove("hidden", "ok");
    vectorLibraryTestResultEl.classList.add("error");
    vectorLibraryTestResultEl.textContent = `Connection test failed: ${error.message}`;
  } finally {
    isVectorConnectionTesting = false;
    vectorLibraryTestBtnEl.textContent = "Connection test";
    updateUiState();
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

    const preferredModel = loadSelectedModelPreference();
    let selectedModel = "";

    models.forEach((entry, index) => {
      const option = document.createElement("option");
      option.value = entry.model;
      option.textContent = entry.name || entry.model;
      if ((preferredModel && entry.model === preferredModel) || (!preferredModel && index === 0)) {
        option.selected = true;
        selectedModel = entry.model;
      }
      modelEl.appendChild(option);
    });

    if (!selectedModel && models[0]?.model) {
      modelEl.value = models[0].model;
      selectedModel = models[0].model;
    }

    if (selectedModel) {
      saveSelectedModelPreference(selectedModel);
    }
  } catch (error) {
    addMessage("system", `Could not load models: ${error.message}`);
  }
}

async function loadVectorInstances() {
  try {
    const res = await fetch("/api/vector/instances");
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not load knowledge base instances.");
    }

    vectorInstances = Array.isArray(data.instances) ? data.instances : [];
    vectorInstanceEl.innerHTML = "";

    if (!vectorInstances.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No knowledge base";
      vectorInstanceEl.appendChild(option);
      vectorInstanceEl.disabled = true;
      return;
    }

    const preferredInstanceId = loadSelectedVectorInstancePreference();
    const defaultInstanceId = data.defaultInstanceId || vectorInstances[0].id;
    const selectedInstanceId = vectorInstances.some((item) => item.id === preferredInstanceId)
      ? preferredInstanceId
      : defaultInstanceId;

    vectorInstances.forEach((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.name;
      option.selected = entry.id === selectedInstanceId;
      vectorInstanceEl.appendChild(option);
    });

    vectorInstanceEl.value = selectedInstanceId;
    saveSelectedVectorInstancePreference(selectedInstanceId);
    vectorInstanceEl.disabled = false;
    updateUiState();
  } catch (error) {
    vectorInstances = [];
    vectorInstanceEl.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Restart app";
    vectorInstanceEl.appendChild(option);
    vectorInstanceEl.disabled = true;
    addMessage(
      "system",
      `Could not load knowledge base instances: ${error.message}. If you just updated the app, restart the Node server so /api/vector/instances is available.`
    );
    updateUiState();
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
    const data = await extractPdfFile(file);

    const rawText = data.text || "";
    const trimmedText = rawText.slice(0, MAX_STORED_PDF_TEXT_CHARS);
    const storageTrimmed = rawText.length > MAX_STORED_PDF_TEXT_CHARS;

    thread.pdfContexts.push({
      id: crypto.randomUUID(),
      filename: data.filename || file.name,
      pages: data.pages,
      text: trimmedText,
      extractionMethod: data.extractionMethod || "text",
      ingestedAt: null,
      chunkCount: null
    });
    touchThread(thread);
    moveThreadToTop(thread.id);
    saveThreadState();
    renderThreadsList();
    renderAttachedFiles();

    const attached = thread.pdfContexts[thread.pdfContexts.length - 1];
    const contextTruncated = attached.text.length > MAX_PDF_TEXT_WARNING_CHARS;
    const extractionInfo =
      data.extractionMethod === "ocr"
        ? " OCR fallback was used."
        : data.extractionMethod === "mixed"
          ? " OCR fallback supplemented extracted text."
          : "";
    addMessage(
      "system",
      `Attached "${attached.filename}" (${attached.pages ?? "?"} pages) to the current chat.${extractionInfo}${
        storageTrimmed ? " Stored text was truncated to keep local history size manageable." : ""
      }${contextTruncated ? " Very large PDFs may be truncated during chat context injection." : ""}`
    );
  } catch (error) {
    addMessage("system", `PDF attach error: ${error.message}`);
  } finally {
    setPdfLoadingState(false);
    pdfFileEl.value = "";
  }
}

async function removePdfContext(id) {
  const thread = getActiveThread();
  if (!thread) return;

  const index = thread.pdfContexts.findIndex((doc) => doc.id === id);
  if (index === -1) return;

  const [removed] = thread.pdfContexts.splice(index, 1);
  touchThread(thread);
  saveThreadState();
  renderThreadsList();
  renderAttachedFiles();
  addMessage("system", `Removed "${removed.filename}" from this chat.`);
}

function maybeUpdateThreadTitle(thread, userText) {
  if (thread.title !== "New chat") return;
  const normalized = userText.trim().replace(/\s+/g, " ");
  if (!normalized) return;
  thread.title = normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

async function extractPdfFile(file) {
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
  return data;
}

async function addPdfToLibrary(file) {
  if (!file) return;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    addMessage("system", "Only .pdf files are supported.");
    return;
  }

  setPdfLoadingState(true);

  try {
    const extracted = await extractPdfFile(file);
    const rawText = extracted.text || "";
    const res = await fetch("/api/rag/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectorInstanceId: getSelectedVectorInstanceId(),
        filename: extracted.filename || file.name,
        pages: extracted.pages,
        text: rawText
      })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not index document.");
    }

    const extractionInfo =
      extracted.extractionMethod === "ocr"
        ? " OCR fallback was used."
        : extracted.extractionMethod === "mixed"
          ? " OCR fallback supplemented extracted text."
          : "";
    addMessage(
      "system",
      `Added "${data.filename}" to knowledge base "${data.vectorInstanceName}"${data.chunkCount ? ` (${data.chunkCount} chunks)` : ""}.${extractionInfo}`
    );
  } catch (error) {
    addMessage("system", `Knowledge base add error: ${error.message}`);
  } finally {
    setPdfLoadingState(false);
    libraryFileEl.value = "";
  }
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
        messages: buildChatMessages(thread),
        webSearchEnabled: webSearchEnabled,
        webSearchQuery: userText,
        vectorSearchEnabled: vectorSearchEnabled,
        vectorInstanceId: getSelectedVectorInstanceId()
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

promptEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  if (sendBtnEl.disabled) return;
  formEl.requestSubmit();
});

pdfFileEl.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await attachPdf(file);
});

libraryFileEl.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await addPdfToLibrary(file);
});

attachBtnEl.addEventListener("click", () => {
  if (!attachBtnEl.disabled) {
    pdfFileEl.click();
  }
});

libraryBtnEl.addEventListener("click", () => {
  if (!libraryBtnEl.disabled) {
    libraryFileEl.click();
  }
});

vectorLibraryBtnEl.addEventListener("click", () => {
  if (!vectorLibraryBtnEl.disabled) {
    openVectorLibraryModal();
  }
});

vectorLibraryTestBtnEl.addEventListener("click", () => {
  if (!vectorLibraryTestBtnEl.disabled) {
    runVectorConnectionTest();
  }
});

attachedFilesEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (target.dataset.action === "remove") {
    removePdfContext(target.dataset.id);
  }
});

threadsListEl.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const threadId = form.dataset.threadRenameForm;
  if (!threadId) return;
  event.preventDefault();
  const inputEl = form.querySelector("input[name='thread-title']");
  if (!(inputEl instanceof HTMLInputElement)) return;
  commitThreadRename(threadId, inputEl.value);
  updateUiState();
});

threadsListEl.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches("[data-rename-input]")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelThreadRename();
    updateUiState();
  }
});

threadsListEl.addEventListener("focusout", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches("[data-rename-input]")) return;
  const relatedTarget = event.relatedTarget;
  if (relatedTarget instanceof Element && relatedTarget.closest(".thread-item-actions")) {
    return;
  }
  commitThreadRename(target.dataset.renameInput, target.value);
  updateUiState();
});

newChatBtnEl.addEventListener("click", () => {
  if (newChatBtnEl.disabled) return;
  createAndActivateNewThread();
  updateUiState();
});

webSearchBtnEl.addEventListener("click", () => {
  if (webSearchBtnEl.disabled) return;
  webSearchEnabled = !webSearchEnabled;
  saveWebSearchPreference(webSearchEnabled);
  applyWebSearchUiState();
});

vectorSearchBtnEl.addEventListener("click", () => {
  if (vectorSearchBtnEl.disabled) return;
  vectorSearchEnabled = !vectorSearchEnabled;
  saveVectorSearchPreference(vectorSearchEnabled);
  applyVectorSearchUiState();
});

modelEl.addEventListener("change", () => {
  saveSelectedModelPreference(modelEl.value);
});

vectorInstanceEl.addEventListener("change", () => {
  saveSelectedVectorInstancePreference(vectorInstanceEl.value);
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
    startRenamingThread(threadId);
  } else if (action === "rename-save") {
    const inputEl = threadsListEl.querySelector(`[data-rename-input="${threadId}"]`);
    if (inputEl instanceof HTMLInputElement) {
      commitThreadRename(threadId, inputEl.value);
    }
  } else if (action === "rename-cancel") {
    cancelThreadRename();
  } else if (action === "delete") {
    openDeleteModal(threadId);
  }

  updateUiState();
});

confirmModalEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-close-modal='true']")) {
    closeDeleteModal();
  }
});

confirmCancelBtnEl.addEventListener("click", () => {
  closeDeleteModal();
});

confirmDeleteBtnEl.addEventListener("click", () => {
  if (pendingDeleteThreadId) {
    deleteThreadById(pendingDeleteThreadId);
    updateUiState();
  }
});

vectorLibraryModalEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-close-library-modal='true']")) {
    closeVectorLibraryModal();
  }
});

vectorLibraryCloseBtnEl.addEventListener("click", () => {
  closeVectorLibraryModal();
});

vectorLibraryDocsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (target.dataset.action === "delete-library-doc") {
    deleteVectorLibraryDocument(target.dataset.documentId, target.dataset.filename);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pendingDeleteThreadId !== null) {
    closeDeleteModal();
    return;
  }
  if (event.key === "Escape" && !vectorLibraryModalEl.classList.contains("hidden")) {
    closeVectorLibraryModal();
  }
});

if (!loadThreadState()) {
  createAndActivateNewThread();
}

webSearchEnabled = loadWebSearchPreference();
vectorSearchEnabled = loadVectorSearchPreference();
applyWebSearchUiState();
applyVectorSearchUiState();

renderThreadsList();
renderMessages();
renderAttachedFiles();
updateUiState();
loadModels();
loadVectorInstances();
