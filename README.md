# Ollama Client (Local Web Chat)

A minimal web app that lets you chat with a locally hosted Ollama server at `http://localhost:11434`.

## Features

- Chat with local Ollama models
- Attach one or more PDFs using the paperclip button in the message composer
- PDF text is extracted on the server and added as thread context for the model

## Requirements

- Node.js 18+ (tested on Node 24)
- Ollama running locally
- At least one pulled model, for example:

```bash
ollama pull llama3.2
```

## Run

```bash
npm start
```

Open `http://localhost:3000` in your browser.

## PDF notes

- Raw PDF files are not directly understood by text-only models like `qwen3:8b`.
- This app extracts text from the PDF first, then sends the extracted text to the model.
- Current size limit is ~10MB per PDF.
- Context sent per request is capped at 30,000 characters total (up to 12,000 chars per attached PDF).

## Optional environment variables

- `PORT` (default `3000`)
- `OLLAMA_BASE_URL` (default `http://localhost:11434`)

Example:

```bash
OLLAMA_BASE_URL=http://localhost:11434 PORT=4000 npm start
```
