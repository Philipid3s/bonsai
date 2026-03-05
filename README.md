# Local-Llama

`Local-Llama` is a minimal web app that lets you chat with a locally hosted Ollama server at `http://localhost:11434`.

## Features

- Chat with local Ollama models
- Streaming token-by-token responses from Ollama
- Assistant responses rendered as Markdown (headings, lists, code blocks, links)
- New chat button and per-thread conversation history
- Thread history and PDF context persistence in browser `localStorage`
- Per-thread rename/delete actions in the chat list
- Attach one or more PDFs using the paperclip button in the message composer
- PDF text is extracted on the server and added as thread context for the model
- OCR fallback for scanned/image PDFs when normal text extraction is too short

## Requirements

- Node.js 18+ (tested on Node 24)
- Ollama running locally
- At least one pulled model, for example:

```bash
ollama pull llama3.2
```

## Run

```powershell
Copy-Item .env.example .env
```

```bash
npm start
```

Open `http://localhost:<PORT>` in your browser (default `3000`).

## PDF notes

- Raw PDF files are not directly understood by text-only models like `qwen3:8b`.
- This app extracts text from the PDF first, then sends the extracted text to the model.
- If extracted text is below a threshold, OCR fallback runs on the first PDF pages.
- First OCR run may download language data for `OCR_LANG` (for example `eng`).
- Current size limit is ~10MB per PDF.
- Context sent per request is capped at 30,000 characters total (up to 12,000 chars per attached PDF).

## Thread history scope

- Thread history is saved in browser `localStorage` only.
- Histories are not shared between different users/devices/browsers.

## Optional environment variables

- `PORT` (default `3000`)
- `OLLAMA_BASE_URL` (default `http://localhost:11434`)
- `OCR_ENABLED` (default `true`)
- `OCR_LANG` (default `eng`)
- `OCR_MAX_PAGES` (default `3`)
- `OCR_MIN_TEXT_CHARS` (default `80`)
- `OCR_IMAGE_SCALE` (default `2`)

Example:

```bash
OLLAMA_BASE_URL=http://localhost:11434 PORT=4000 npm start
```
