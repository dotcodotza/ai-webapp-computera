import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { PDFDocument, rgb } from 'pdf-lib';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const multerModule = require('multer');
const multer = multerModule.default || multerModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MEMORY_DIR = path.join(__dirname, 'memory');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Safe filesystem roots
const rawRoots = process.env.ALLOWED_FS_ROOTS 
  ? process.env.ALLOWED_FS_ROOTS.split(';') 
  : [__dirname, process.env.USERPROFILE || 'C:\\Users\\SBTI Gaming 11', path.resolve(__dirname, '..')];

const ALLOWED_FS_ROOTS = rawRoots.filter(Boolean).map(r => path.resolve(r).toLowerCase());

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Ensure directories exist
fs.ensureDirSync(MEMORY_DIR);
fs.ensureDirSync(UPLOADS_DIR);

// Multer for file uploads
const upload = multer({ dest: UPLOADS_DIR });

// Normalize path & check if allowed
function isPathAllowed(filepath) {
  try {
    const resolved = path.resolve(filepath).toLowerCase();
    return ALLOWED_FS_ROOTS.some(root => resolved.startsWith(root) || root.startsWith(resolved));
  } catch {
    return false;
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Extract plain text from supported document types
async function extractDocumentText(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (ext === '.pdf') {
    const dataBuffer = await fs.readFile(filepath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } else if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filepath });
    return result.value;
  } else if (ext === '.rtf') {
    const content = await fs.readFile(filepath, 'utf-8');
    return content.replace(/\\[a-z0-9*]+\s?/gi, ' ').replace(/[{}]/g, '').trim();
  } else if (['.txt', '.md', '.js', '.json', '.html', '.css', '.py', '.ts', '.tsx', '.jsx', '.c', '.cpp', '.h', '.hpp', '.java', '.go', '.rs', '.rb', '.php', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.csv', '.tsv', '.sh', '.bat', '.ps1', '.sql', '.graphql', '.proto', '.dockerfile', '.env', '.gitignore', '.license', '.readme'].includes(ext)) {
    return await fs.readFile(filepath, 'utf-8');
  } else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'].includes(ext)) {
    const stat = await fs.stat(filepath);
    return `[Image file: ${path.basename(filepath)} (${formatFileSize(stat.size)}) - visual content, text extraction not available without OCR]`;
  } else if (['.zip', '.tar', '.gz', '.rar', '.7z'].includes(ext)) {
    const stat = await fs.stat(filepath);
    return `[Archive file: ${path.basename(filepath)} (${formatFileSize(stat.size)}) - archive contents not extracted]`;
  } else if (['.mp3', '.wav', '.mp4', '.avi', '.mov', '.mkv'].includes(ext)) {
    const stat = await fs.stat(filepath);
    return `[Media file: ${path.basename(filepath)} (${formatFileSize(stat.size)}) - media content, text extraction not available]`;
  }
  throw new Error(`Unsupported document extension: ${ext}`);
}

// -------------------------------------------------------------
// Tool definitions for Ollama
// -------------------------------------------------------------
const FS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List all files and subdirectories in a directory path.',
      parameters: {
        type: 'object',
        properties: {
          dirpath: { type: 'string', description: 'Directory path to list. Leave empty or use "." for the current project root.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the text content of a file from the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path of the file to read (relative or absolute).' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite text content to a file on the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path of the file to write to.' },
          content: { type: 'string', description: 'The text content to write into the file.' }
        },
        required: ['filepath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_document_text',
      description: 'Extract plain text content from a document (PDF, TXT, MD, JSON, code files) for LLM context.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path of the document to extract text from.' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_pdf',
      description: 'Append text to a PDF page using pdf-lib.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path of the PDF file to edit.' },
          text: { type: 'string', description: 'Text to append to the PDF page.' },
          pageNumber: { type: 'integer', description: '1-based page number to edit (default 1).', default: 1 }
        },
        required: ['filepath', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upload_file',
      description: 'Register an uploaded file path in the uploads directory.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Name of the uploaded file.' }
        },
        required: ['filename']
      }
    }
  }
];

// Helper to execute filesystem tools
async function executeTool(name, args) {
  if (name === 'list_directory') {
    const target = args.dirpath && args.dirpath !== '.' ? path.resolve(args.dirpath) : __dirname;
    if (!isPathAllowed(target)) return { error: `Access denied to path: ${target}` };
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `Directory not found: ${target}` };
    const entries = await fs.readdir(target, { withFileTypes: true });
    const items = entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
    return { dirpath: target, items };
  }

  if (name === 'read_file') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target)) return { error: `Access denied to path: ${target}` };
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `File not found: ${target}` };
    const stat = await fs.stat(target);
    if (stat.size > 2 * 1024 * 1024) return { error: 'File too large to read into chat (max 2MB)' };
    const content = await fs.readFile(target, 'utf-8');
    return { filepath: target, content };
  }

  if (name === 'write_file') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target)) return { error: `Access denied to path: ${target}` };
    await fs.outputFile(target, args.content || '');
    return { success: true, filepath: target, bytesWritten: (args.content || '').length };
  }

  if (name === 'read_document_text') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target)) return { error: `Access denied to path: ${target}` };
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `File not found: ${target}` };
    try {
      const text = await extractDocumentText(target);
      return { filepath: target, text, size: text.length };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (name === 'edit_pdf') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target)) return { error: `Access denied to path: ${target}` };
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `File not found: ${target}` };
    try {
      const existingPdfBytes = await fs.readFile(target);
      const pdfDoc = await PDFDocument.load(existingPdfBytes);
      const pages = pdfDoc.getPages();
      const pageIndex = Math.max(0, Math.min((args.pageNumber || 1) - 1, pages.length - 1));
      const targetPage = pages[pageIndex];
      targetPage.drawText(args.text, {
        x: 50,
        y: targetPage.getHeight() - 100,
        size: 12,
        color: rgb(0, 0, 0),
      });
      const modifiedPdfBytes = await pdfDoc.save();
      await fs.writeFile(target, modifiedPdfBytes);
      return { success: true, filepath: target, message: 'PDF modified successfully', pageEdited: pageIndex + 1 };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (name === 'upload_file') {
    const target = path.join(UPLOADS_DIR, args.filename);
    return { success: true, filepath: target, message: 'File ready for use' };
  }

  return { error: `Unknown tool: ${name}` };
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// Health check
app.get('/api/health', async (req, res) => {
  let ollamaStatus = 'offline';
  try {
    const check = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (check.ok) ollamaStatus = 'online';
  } catch { ollamaStatus = 'unreachable'; }
  res.json({ status: 'ok', ollama: OLLAMA_URL, ollamaStatus, workspace: __dirname, platform: process.platform });
});

// List Ollama models
app.get('/api/models', async (req, res) => {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to retrieve models from Ollama' });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}: ${err.message}`, models: [] });
  }
});

// Workspace info
app.get('/api/filesystem/workspace', (req, res) => {
  res.json({ cwd: __dirname, home: process.env.USERPROFILE || 'C:\\Users\\SBTI Gaming 11', allowedRoots: ALLOWED_FS_ROOTS });
});

// Read file
app.post('/api/filesystem/read', async (req, res) => {
  try {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    const exists = await fs.pathExists(target);
    if (!exists) return res.status(404).json({ error: 'File not found' });
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Specified path is a directory, not a file' });
    const content = await fs.readFile(target, 'utf-8');
    res.json({ filepath: target, name: path.basename(target), content, size: stat.size, mtime: stat.mtime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Write file
app.post('/api/filesystem/write', async (req, res) => {
  try {
    const { filepath, content } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    await fs.outputFile(target, content !== undefined ? content : '');
    const stat = await fs.stat(target);
    res.json({ success: true, filepath: target, size: stat.size, mtime: stat.mtime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete file or directory
app.post('/api/filesystem/delete', async (req, res) => {
  try {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    if (target === __dirname) return res.status(400).json({ error: 'Cannot delete project root' });
    await fs.remove(target);
    res.json({ success: true, filepath: target });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create directory
app.post('/api/filesystem/mkdir', async (req, res) => {
  try {
    const { dirpath } = req.body;
    if (!dirpath) return res.status(400).json({ error: 'dirpath required' });
    const target = path.resolve(__dirname, dirpath);
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    await fs.ensureDir(target);
    res.json({ success: true, dirpath: target });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List files in directory
app.post('/api/filesystem/list', async (req, res) => {
  try {
    const { dirpath } = req.body;
    const target = dirpath ? path.resolve(__dirname, dirpath) : __dirname;
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    const exists = await fs.pathExists(target);
    if (!exists) return res.status(404).json({ error: 'Directory not found' });
    const entries = await fs.readdir(target, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (e) => {
        const itemPath = path.join(target, e.name);
        let size = 0, mtime = null;
        try { const s = await fs.stat(itemPath); size = s.size; mtime = s.mtime; } catch {}
        return { name: e.name, path: itemPath, isDirectory: e.isDirectory(), size, mtime, extension: path.extname(e.name).toLowerCase() };
      })
    );
    files.sort((a, b) => { if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1; return a.name.localeCompare(b.name); });
    res.json({ dirpath: target, parent: path.dirname(target) !== target ? path.dirname(target) : null, files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Document text extraction
app.post('/api/document/read-text', async (req, res) => {
  try {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    const exists = await fs.pathExists(target);
    if (!exists) return res.status(404).json({ error: 'File not found' });
    const text = await extractDocumentText(target);
    res.json({ success: true, filepath: target, name: path.basename(target), text, size: text.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve raw document for viewing (PDF.js, iframe, etc.)
app.get('/api/document/view', async (req, res) => {
  try {
    const filepath = req.query.path;
    if (!filepath) return res.status(400).json({ error: 'path query required' });
    const target = path.resolve(filepath);
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    if (!(await fs.pathExists(target))) return res.status(404).send('File not found');
    const ext = path.extname(target).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(target);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get PDF raw bytes for PDF.js rendering
app.get('/api/document/pdf-bytes', async (req, res) => {
  try {
    const filepath = req.query.path;
    if (!filepath) return res.status(400).json({ error: 'path query required' });
    const target = path.resolve(filepath);
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    if (!(await fs.pathExists(target))) return res.status(404).send('File not found');
    const ext = path.extname(target).toLowerCase();
    if (ext !== '.pdf') return res.status(400).json({ error: 'Not a PDF file' });
    const bytes = await fs.readFile(target);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(bytes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload file
app.post('/api/document/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const target = path.resolve(req.file.path);
    if (!isPathAllowed(target)) {
      await fs.remove(target);
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ success: true, filepath: target, filename: req.file.filename, originalname: req.file.originalname, size: req.file.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit PDF
app.post('/api/document/edit-pdf', async (req, res) => {
  try {
    const { filepath, text, pageNumber = 1 } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    if (!text) return res.status(400).json({ error: 'text required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target)) return res.status(403).json({ error: 'Access denied' });
    const exists = await fs.pathExists(target);
    if (!exists) return res.status(404).json({ error: 'File not found' });
    const existingPdfBytes = await fs.readFile(target);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    const pages = pdfDoc.getPages();
    const pageIndex = Math.max(0, Math.min(pageNumber - 1, pages.length - 1));
    const targetPage = pages[pageIndex];
    targetPage.drawText(text, { x: 50, y: targetPage.getHeight() - 100, size: 12, color: rgb(0, 0, 0) });
    const modifiedPdfBytes = await pdfDoc.save();
    await fs.writeFile(target, modifiedPdfBytes);
    res.json({ success: true, filepath: target, message: 'PDF modified successfully', pageEdited: pageIndex + 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save memory
app.post('/api/memory/save', async (req, res) => {
  try {
    const { key, data } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    const sanitizedKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const memoryFile = path.join(MEMORY_DIR, `${sanitizedKey}.json`);
    await fs.writeJson(memoryFile, { key, data, updatedAt: new Date().toISOString() }, { spaces: 2 });
    res.json({ success: true, key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Load memory
app.get('/api/memory/load/:key', async (req, res) => {
  try {
    const sanitizedKey = req.params.key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const memoryFile = path.join(MEMORY_DIR, `${sanitizedKey}.json`);
    const exists = await fs.pathExists(memoryFile);
    if (!exists) return res.status(404).json({ error: 'Memory not found', key: req.params.key });
    const data = await fs.readJson(memoryFile);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete memory
app.delete('/api/memory/delete/:key', async (req, res) => {
  try {
    const sanitizedKey = req.params.key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const memoryFile = path.join(MEMORY_DIR, `${sanitizedKey}.json`);
    await fs.remove(memoryFile);
    res.json({ success: true, key: req.params.key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List all memories
app.get('/api/memory/list', async (req, res) => {
  try {
    const files = await fs.readdir(MEMORY_DIR);
    const memories = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        try { memories.push(await fs.readJson(path.join(MEMORY_DIR, f))); } catch {}
      }
    }
    memories.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    res.json({ memories });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Chat with Ollama (Streaming, Agent tool-calling, document-aware)
app.post('/api/chat', async (req, res) => {
  try {
    let { messages, system, model = 'qwen2.5-coder:1.5b', stream = true, enableTools = false, activeDocumentPath } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

    const defaultSystem = `You are a helpful, intelligent coding and computer assistant with direct filesystem awareness running locally on Windows.
Current project workspace root directory: ${__dirname}
You have access to inspect and manage files in the workspace.

CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. NEVER hallucinate or invent details about any file. Only state what is explicitly present in the file content provided in the chat context.
2. If you have not read a file, say you have not read it. Do not guess its purpose, contents, or author.
3. When analyzing an attached file, quote its actual content. Do not fabricate details not present in the file.
4. If a file is empty or minimal, say so. Do not expand it into a full system or project.
5. Be accurate, helpful, and concise. Format code blocks with language identifiers.
6. When answering code or file questions, ground every claim in the actual file content visible to you.`;

    let effectiveSystem = system ? `${defaultSystem}\n\n${system}` : defaultSystem;

    // Inject active document context
    if (activeDocumentPath && await fs.pathExists(activeDocumentPath)) {
      try {
        const docText = await extractDocumentText(activeDocumentPath);
        effectiveSystem += `\n\n[Active Document Content (${path.basename(activeDocumentPath)})]:\n${docText.slice(0, 8000)}`;
      } catch (e) { console.warn('Could not extract active document text:', e.message); }
    }

    const requestPayload = { model, messages, system: effectiveSystem, stream, options: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.15, presence_penalty: 0.1, frequency_penalty: 0.1, seed: -1 } };
    if (req.body.options && typeof req.body.options === 'object') requestPayload.options = { ...requestPayload.options, ...req.body.options };
    if (enableTools && !stream) requestPayload.tools = FS_TOOLS;

    const ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestPayload)
    });

    if (!ollamaResponse.ok) {
      const errText = await ollamaResponse.text();
      return res.status(ollamaResponse.status).json({ error: `Ollama error (${ollamaResponse.status}): ${errText}` });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      for await (const chunk of ollamaResponse.body) res.write(chunk);
      res.end();
    } else {
      const data = await ollamaResponse.json();
      if (data.message && data.message.tool_calls && data.message.tool_calls.length > 0) {
        const toolCalls = data.message.tool_calls;
        const toolResults = [];
        for (const tc of toolCalls) {
          const name = tc.function.name;
          const args = tc.function.arguments || {};
          const result = await executeTool(name, args);
          toolResults.push({ tool_call_id: tc.id || name, role: 'tool', content: JSON.stringify(result) });
        }
        const followUpMessages = [...messages, data.message, ...toolResults];
        const followUpResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: followUpMessages, system: effectiveSystem, stream: false })
        });
        if (followUpResponse.ok) {
          const finalData = await followUpResponse.json();
          return res.json({ ...finalData, executedTools: toolCalls.map((tc, idx) => ({ tool: tc.function.name, args: tc.function.arguments, result: JSON.parse(toolResults[idx].content) })) });
        }
      }
      res.json(data);
    }
  } catch (err) { console.error('Chat error:', err); res.status(500).json({ error: err.message }); }
});

// Tool execution endpoint
app.post('/api/tools/execute', async (req, res) => {
  try {
    const { name, args } = req.body;
    if (!name) return res.status(400).json({ error: 'tool name required' });
    const result = await executeTool(name, args || {});
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web app running on http://localhost:${PORT}`);
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`Workspace root: ${__dirname}`);
  console.log(`Uploads dir: ${UPLOADS_DIR}`);
});
