const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const promptEl = document.getElementById("prompt");
const sendBtnEl = document.getElementById("send-btn");
const modelEl = document.getElementById("model");
const attachBtnEl = document.getElementById("attach-btn");
const pdfFileEl = document.getElementById("pdf-file");
const attachedFilesEl = document.getElementById("attached-files");

const history = [];
const pdfContexts = [];
const MAX_PDF_CONTEXT_CHARS = 12_000;
const MAX_TOTAL_PDF_CONTEXT_CHARS = 30_000;
let isSending = false;
let isPdfLoading = false;

function addMessage(role, text) {
  const messageEl = document.createElement("article");
  messageEl.className = `message ${role}`;
  messageEl.textContent = text;
  messagesEl.appendChild(messageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAttachedFiles() {
  attachedFilesEl.innerHTML = "";
  for (const item of pdfContexts) {
    const chipEl = document.createElement("div");
    chipEl.className = "attached-chip";
    chipEl.innerHTML = `
      <span>${item.filename} (${item.pages ?? "?"}p)</span>
      <button type="button" data-id="${item.id}" aria-label="Remove ${item.filename}">x</button>
    `;
    attachedFilesEl.appendChild(chipEl);
  }

  const canEditAttachments = !(isSending || isPdfLoading);
  attachedFilesEl.querySelectorAll("button").forEach((btn) => {
    btn.disabled = !canEditAttachments;
  });
}

function updateUiState() {
  sendBtnEl.disabled = isSending || isPdfLoading;
  promptEl.disabled = isSending;
  modelEl.disabled = isSending;
  attachBtnEl.disabled = isSending || isPdfLoading;
  sendBtnEl.textContent = isSending ? "Sending..." : "Send";
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

function buildChatMessages() {
  if (!pdfContexts.length) {
    return history;
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

  for (const ctx of pdfContexts) {
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

  return [...contextMessages, ...history];
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

    addMessage("system", "Connected. Start chatting with your selected model.");
  } catch (error) {
    addMessage("system", `Could not load models: ${error.message}`);
  }
}

async function attachPdf(file) {
  if (!file) return;

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

    pdfContexts.push({
      id: crypto.randomUUID(),
      filename: data.filename || file.name,
      pages: data.pages,
      text: data.text || ""
    });
    renderAttachedFiles();

    const attached = pdfContexts[pdfContexts.length - 1];
    const truncated = attached.text.length > MAX_PDF_CONTEXT_CHARS;
    addMessage(
      "system",
      `Attached "${attached.filename}" to this thread (${attached.pages ?? "?"} pages). ${
        truncated ? `Text may be truncated for context limits.` : "Text context is ready."
      }`
    );
  } catch (error) {
    addMessage("system", `PDF attach error: ${error.message}`);
  } finally {
    setPdfLoadingState(false);
    pdfFileEl.value = "";
  }
}

function removePdfContext(id) {
  const index = pdfContexts.findIndex((doc) => doc.id === id);
  if (index === -1) return;
  const [removed] = pdfContexts.splice(index, 1);
  renderAttachedFiles();
  addMessage("system", `Removed "${removed.filename}" from thread context.`);
}

async function sendChatMessage(userText) {
  const model = modelEl.value;
  if (!model) {
    addMessage("system", "Select a model before sending a message.");
    return;
  }

  history.push({ role: "user", content: userText });
  addMessage("user", userText);

  setSendingState(true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: buildChatMessages()
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Chat request failed");
    }

    const reply = data.message?.content || "(No response content)";
    history.push({ role: "assistant", content: reply });
    addMessage("assistant", reply);
  } catch (error) {
    addMessage("system", `Error: ${error.message}`);
    history.pop();
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

updateUiState();
loadModels();
