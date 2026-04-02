# bonsAI - local ollama client

A lightweight, private, and powerful web interface for your local Ollama models. Chat with your favorite AI models, analyze PDF documents with OCR support, and ground responses with real-time web search from a clean, responsive UI.

---

## Features

### Core Chat Experience
- **Full Model Support**: Seamlessly switch between any models pulled to your local Ollama instance.
- **Real-time Streaming**: Experience token-by-token response generation for a fluid chat experience.
- **Markdown Rendering**: Beautifully rendered responses including code blocks (with syntax highlighting), lists, tables, and links.
- **Thread Management**: Organize conversations into multiple threads with the ability to rename and delete.
- **Local Persistence**: All chat history and document context are stored in your browser's `localStorage` for privacy and speed.

### Document Intelligence
- **Session PDFs**: Attach a PDF to the active chat and use it as temporary thread-only context.
- **Knowledge Library**: Add a PDF permanently to the selected Chroma-backed knowledge base, then query it from any future chat.
- **OCR Fallback**: Built-in OCR support using `Tesseract.js`. If a PDF is scanned or image-heavy, the system automatically falls back to OCR so the AI can read the content.
- **Knowledge-Base Retrieval**: Toggle `KB` to force retrieval from the selected vector instance during chat.

### Web-Search Grounding
- **Brave Search Integration**: Toggle "Web Search" to provide the model with up-to-date information from the internet.
- **Intent Detection**: The system intelligently decides when to search based on your prompt, such as requests for the latest news or current weather.
- **Source Citation**: Encourages the model to cite sources and URLs from the retrieved search results.

---

## Tech Stack

- **Backend**: Node.js (Standard Library)
- **Frontend**: Vanilla JavaScript, CSS3, HTML5
- **AI Core**: [Ollama](https://ollama.com/)
- **Vector Store**: [Chroma](https://www.trychroma.com/)
- **Document Processing**: `pdf-parse`, `tesseract.js`
- **Web Search**: Brave Search API

---

## Prerequisites

1. **Node.js**: Version 18.x or higher (tested on Node 22+).
2. **Ollama**: Installed and running locally.
3. **Models**: At least one chat model and one embedding model pulled.
   ```bash
   ollama pull qwen2.5
   ollama pull nomic-embed-text
   ```
4. **Chroma**: A local Chroma server running. On Windows x64, Docker is the most reliable option:
   ```bash
   docker run --name bonsai-chroma -p 8000:8000 -v ./chroma-data:/data chromadb/chroma
   ```

---

## Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd bonsai-local-ollama-client
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment**:
   Copy `.env.example` to `.env` and adjust settings:
   ```powershell
   Copy-Item .env.example .env
   ```

   ```bash
   cp .env.example .env
   ```

4. **Start the application**:
   ```bash
   npm start
   ```
   For Windows, you can also use `start.bat`, which checks Chroma first and will try Python or Docker launchers automatically.

5. **Access the UI**:
   Open `http://localhost:<PORT>` in your browser. If you keep the sample `.env`, that will be `http://localhost:3000`.

---

## Deployment Steps

### Local Ollama Setup

Pull one chat model and one embedding model:

```powershell
ollama pull qwen2.5
ollama pull nomic-embed-text
```

Verify the models are available:

```powershell
ollama list
```

### Local Chroma Setup With Docker

The most reliable Windows x64 path is Docker. Start Chroma with:

```powershell
docker run --name bonsai-chroma -p 8000:8000 -v "${PWD}\chroma-data:/data" chromadb/chroma
```

Test that Chroma is reachable:

```powershell
Invoke-WebRequest http://127.0.0.1:8000/api/v2/heartbeat
```

If you want to stop and restart the same container later:

```powershell
docker stop bonsai-chroma
docker start bonsai-chroma
```

If you need to remove and recreate it:

```powershell
docker rm -f bonsai-chroma
docker run --name bonsai-chroma -p 8000:8000 -v "${PWD}\chroma-data:/data" chromadb/chroma
```

### Windows Shortcut

On Windows, [start.bat](D:\Projects\ollama-client\start.bat) will:

- check whether Chroma responds on the configured host/port
- try to start Chroma via Python or Docker when needed
- start the Node app
- open the browser

Typical usage:

```powershell
.\start.bat
```

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | The port the web server listens on. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | The URL where your Ollama instance is running. |
| `OCR_ENABLED` | `true` | Enable or disable OCR fallback for PDF documents. |
| `OCR_LANG` | `eng` | Language code for OCR downloads on first run. |
| `OCR_MAX_PAGES` | `3` | Maximum number of pages to process via OCR per document. |
| `OCR_MIN_TEXT_CHARS` | `80` | Minimum text length before OCR fallback is triggered. |
| `OCR_IMAGE_SCALE` | `2` | Image scaling factor for OCR; higher is better quality and slower. |
| `BRAVE_SEARCH_ENABLED` | `false` | Enable or disable web search capabilities. |
| `BRAVE_SEARCH_API_KEY` | `(none)` | Brave Search API key required for web search. |
| `BRAVE_SEARCH_MAX_RESULTS` | `5` | Number of search results to retrieve. |
| `BRAVE_SEARCH_COUNTRY` | `US` | Country code for search results. |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model used to generate document and query vectors for the knowledge base. |
| `OLLAMA_EMBED_MODEL` | `(fallback alias)` | Backward-compatible alias for `OLLAMA_EMBEDDING_MODEL`. |
| `DEFAULT_VECTOR_INSTANCE_ID` | `default` | Default knowledge-base instance shown in the selector. |
| `CHROMA_HOST` | `127.0.0.1` | Hostname for the local Chroma server. |
| `CHROMA_PORT` | `8000` | Port for the local Chroma server. |
| `CHROMA_SSL` | `false` | Whether to connect to Chroma over HTTPS. |
| `CHROMA_COLLECTION` | `bonsai_documents` | Collection name used for indexed documents. |
| `VECTOR_DB_INSTANCES` | `(empty)` | Optional JSON array of named vector instances for the header selector. If omitted, the single `CHROMA_*` config becomes the default instance. |
| `RAG_CHUNK_SIZE` | `1200` | Approximate chunk size, in characters, for PDF text splitting. |
| `RAG_CHUNK_OVERLAP` | `180` | Character overlap between adjacent chunks. |
| `RAG_RETRIEVAL_LIMIT` | `4` | Number of retrieved chunks added to each chat request. |
| `EMBED_BATCH_SIZE` | `16` | Number of chunks embedded per Ollama batch request. |

---

## Usage Tips

- **Session PDF**: Click `PDF` to attach a document only to the current chat thread.
- **Permanent Knowledge Base**: Click `Library` to ingest a PDF into the selected knowledge base. That data stays in Chroma until you remove/reset it outside the app.
- **Delete from KB**: Open `Browse` next to the knowledge base selector to inspect indexed files, run a connection test, or delete a document from the selected knowledge base.
- **KB Search**: Toggle `KB` on when you want the model to retrieve from the selected knowledge base for the current prompt.

### Multiple Vector Instances

You can expose multiple Chroma-backed knowledge bases in the header selector with `VECTOR_DB_INSTANCES`:

```json
[
  {
    "id": "contracts",
    "name": "Contracts KB",
    "host": "127.0.0.1",
    "port": 8000,
    "ssl": false,
    "collection": "contracts_docs"
  },
  {
    "id": "hr",
    "name": "HR KB",
    "host": "127.0.0.1",
    "port": 8000,
    "ssl": false,
    "collection": "hr_docs"
  }
]
```
- **Web Search**: Useful for current events or technical documentation released after your model's training cutoff.
- **Storage**: If you hit a storage warning, try deleting older threads or removing large PDF attachments.

---

## Privacy & Security

- **Data Ownership**: Your chat history stays in your browser.
- **Local AI**: All AI processing happens on your machine via Ollama.
- **Search Privacy**: When web search is enabled, only specific queries are sent to Brave Search; your full conversation history is never shared.

---

## License

This project is open source. Check the license terms if a `LICENSE` file is present.
