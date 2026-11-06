# Computera AI ⚡

A modern, full-featured **filesystem-aware local AI chatbot** powered by **Express.js** and **Ollama**. Computera AI lets you interact with local language models (such as `llama3.2:1b`) with full context and control over your project workspace.

![UI Overview](public/index.html)

---

## ✨ Features

- **💬 Real-Time Streaming Chat:** Instant token-by-token streaming responses with live markdown rendering and syntax-highlighted code blocks.
- **📂 Live Filesystem Explorer:**
  - Browse workspace files and directories with breadcrumb navigation.
  - Inspect file metadata (sizes, modification dates, extensions).
  - Create new files directly from the UI.
- **👁️ File Viewer & Editor Modal:**
  - View any file in a clean monospace editor with line numbers.
  - Edit and save changes directly to disk via the backend API.
- **📎 Direct Context Attachment:**
  - **Attach File:** Select any workspace file to inject its content directly into the prompt.
  - **Project Files:** Injects directory structure into the context with a single click.
  - **Ask AI About This File:** Instant prompt generation for file analysis, code review, or refactoring.
- **🧠 Persistent Memory:**
  - Save, load, and manage persistent memory notes across chat sessions.
  - Inject saved notes directly into chat context.
- **⚡ Slash Commands:**
  - `/read <file>` or `/cat <file>`: Read and attach a file.
  - `/ls [dir]`: List directory contents.
  - `/models`: List available Ollama models.
  - `/clear`: Clear active chat messages.
  - `/help`: Display available commands.
- **🛡️ Secure Filesystem Access:** Validated filesystem paths to keep operations within safe workspace roots.

---

## 🛠️ Tech Stack

- **Backend:** Node.js (ES Modules), Express.js, `fs-extra`, `cors`
- **Frontend:** Vanilla JS, HTML5, Modern CSS (Dark Theme)
- **Libraries (CDN):** Marked.js (Markdown), Highlight.js (Syntax Highlighting)
- **Local LLM Engine:** [Ollama](https://ollama.com/) (e.g. `llama3.2:1b`)

---

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Ollama](https://ollama.com/) installed and running

Ensure you have a model pulled in Ollama:
```bash
ollama pull llama3.2:1b
```

### 2. Installation

Clone the repository and install dependencies:
```bash
git clone https://github.com/Skywalkingzulu1/ai-webapp-computera.git
cd ai-webapp-computera
npm install
```

### 3. Start Ollama & the Server

Start Ollama (if not already running as a service):
```bash
ollama serve
```

Start the Computera AI server:
```bash
npm start
```

### 4. Access the Application

Open your browser and navigate to:
- **Local:** [http://localhost:3000](http://localhost:3000)

---

## ⚙️ Configuration

Environment variables (optional):
- `PORT`: Server port (default: `3000`)
- `OLLAMA_URL`: URL to your Ollama instance (default: `http://localhost:11434`)
- `ALLOWED_FS_ROOTS`: Semicolon-separated paths allowed for filesystem operations.

---

## 📄 License

MIT License. Created by [Skywalkingzulu](https://github.com/Skywalkingzulu1).
