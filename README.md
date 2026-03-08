# 🦙 local-llama

A lightweight, private, and powerful web interface for your local Ollama models. Chat with your favorite AI models, analyze PDF documents with OCR support, and ground responses with real-time web search—all from a clean, responsive UI.

---

## 🚀 Features

### 🧠 Core Chat Experience
- **Full Model Support**: Seamlessly switch between any models pulled to your local Ollama instance.
- **Real-time Streaming**: Experience token-by-token response generation for a fluid chat experience.
- **Markdown Rendering**: Beautifully rendered responses including code blocks (with syntax highlighting), lists, tables, and links.
- **Thread Management**: Organize conversations into multiple threads with the ability to rename and delete.
- **Local Persistence**: All chat history and document context are stored in your browser's `localStorage` for privacy and speed.

### 📄 Document Intelligence (RAG-lite)
- **PDF Context**: Attach multiple PDF files to any thread. The application extracts text and injects it as context for the model.
- **OCR Fallback**: Built-in OCR support using `Tesseract.js`. If a PDF is scanned or image-heavy, the system automatically falls back to OCR to ensure the AI "sees" the content.
- **Smart Truncation**: Automatically manages large documents to fit within model context limits while preserving relevant information.

### 🌐 Web-Search Grounding
- **Brave Search Integration**: Toggle "Web Search" to provide the model with up-to-date information from the internet.
- **Intent Detection**: The system intelligently decides when to search based on your prompt (e.g., asking for "latest news" or "current weather").
- **Source Citation**: Encourages the model to cite sources and URLs from the retrieved search results.

---

## 🛠️ Tech Stack

- **Backend**: Node.js (Standard Library)
- **Frontend**: Vanilla JavaScript, CSS3, HTML5
- **AI Core**: [Ollama](https://ollama.com/)
- **Document Processing**: `pdf-parse`, `tesseract.js`
- **Web Search**: Brave Search API

---

## 📋 Prerequisites

1. **Node.js**: Version 18.x or higher (Tested on Node 22+).
2. **Ollama**: Installed and running locally.
3. **Models**: At least one model pulled.
   ```bash
   ollama pull llama3.2
   ```

---

## ⚙️ Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd ollama-client
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment**:
   Copy `.env.example` to `.env` and adjust settings:
   ```powershell
   # Windows (PowerShell)
   Copy-Item .env.example .env
   
   # Linux/macOS
   cp .env.example .env
   ```

4. **Start the application**:
   ```bash
   npm start
   ```
   *For Windows users, you can also use `start.bat` for a quick launch.*

5. **Access the UI**:
   Open `http://localhost:3000` in your browser.

---

## 🔧 Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | The port the web server listens on. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | The URL where your Ollama instance is running. |
| `OCR_ENABLED` | `true` | Enable/Disable OCR fallback for PDF documents. |
| `OCR_LANG` | `eng` | Language code for OCR (downloads data on first run). |
| `OCR_MAX_PAGES` | `3` | Maximum number of pages to process via OCR per document. |
| `OCR_MIN_TEXT_CHARS` | `80` | Minimum text length before OCR fallback is triggered. |
| `OCR_IMAGE_SCALE` | `2` | Image scaling factor for OCR (higher = better quality, slower). |
| `BRAVE_SEARCH_ENABLED`| `false` | Enable/Disable web search capabilities. |
| `BRAVE_SEARCH_API_KEY`| `(none)` | Your Brave Search API Key (Required for web search). |
| `BRAVE_SEARCH_MAX_RESULTS` | `5` | Number of search results to retrieve. |
| `BRAVE_SEARCH_COUNTRY` | `US` | Country code for search results. |

---

## 💡 Usage Tips

- **System Context**: Use PDFs for specialized knowledge. The app handles the extraction so the model can answer questions about your private files.
- **Web Search**: Great for current events or technical documentation released after your model's training cutoff.
- **Storage**: If you hit a storage warning, try deleting older threads or removing large PDF attachments.

---

## 🛡️ Privacy & Security

- **Data Ownership**: Your chat history stays in your browser.
- **Local AI**: All AI processing happens on your machine via Ollama.
- **Search Privacy**: When web search is enabled, only specific queries are sent to Brave Search; your full conversation history is never shared.

---

## 📄 License

This project is open-source. Please check the license terms if a LICENSE file is present.
