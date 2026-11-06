import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MEMORY_DIR = path.join(__dirname, 'memory');

// Safe filesystem roots
const rawRoots = process.env.ALLOWED_FS_ROOTS 
  ? process.env.ALLOWED_FS_ROOTS.split(';') 
  : [__dirname, process.env.USERPROFILE || 'C:\\Users\\SBTI Gaming 11', path.resolve(__dirname, '..')];

const ALLOWED_FS_ROOTS = rawRoots.filter(Boolean).map(r => path.resolve(r).toLowerCase());

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure memory directory exists
fs.ensureDirSync(MEMORY_DIR);

// Normalize path & check if allowed
function isPathAllowed(filepath) {
  try {
    const resolved = path.resolve(filepath).toLowerCase();
    return ALLOWED_FS_ROOTS.some(root => resolved.startsWith(root) || root.startsWith(resolved));
  } catch {
    return false;
  }
}

// Tool definitions for Ollama
const FS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List all files and subdirectories in a directory path. Returns an array of items with name and whether each is a directory.',
      parameters: {
        type: 'object',
        properties: {
          dirpath: {
            type: 'string',
            description: 'Directory path to list. Leave empty or use "." for the current project root.'
          }
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
          filepath: {
            type: 'string',
            description: 'Path of the file to read (relative or absolute).'
          }
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
          filepath: {
            type: 'string',
            description: 'Path of the file to write to.'
          },
          content: {
            type: 'string',
            description: 'The text content to write into the file.'
          }
        },
        required: ['filepath', 'content']
      }
    }
  }
];

// Helper to execute filesystem tools
async function executeTool(name, args) {
  if (name === 'list_directory') {
    const target = args.dirpath && args.dirpath !== '.' ? path.resolve(args.dirpath) : __dirname;
    if (!isPathAllowed(target)) {
      return { error: `Access denied to path: ${target}` };
    }
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `Directory not found: ${target}` };
    const entries = await fs.readdir(target, { withFileTypes: true });
    const items = entries.map(e => ({
      name: e.name,
      isDirectory: e.isDirectory()
    }));
    return { dirpath: target, items };
  }

  if (name === 'read_file') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target)) {
      return { error: `Access denied to path: ${target}` };
    }
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `File not found: ${target}` };
    const stat = await fs.stat(target);
    if (stat.size > 2 * 1024 * 1024) {
      return { error: 'File too large to read into chat (max 2MB)' };
    }
    const content = await fs.readFile(target, 'utf-8');
    return { filepath: target, content };
  }

  if (name === 'write_file') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target)) {
      return { error: `Access denied to path: ${target}` };
    }
    await fs.outputFile(target, args.content || '');
    return { success: true, filepath: target, bytesWritten: (args.content || '').length };
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
  } catch {
    ollamaStatus = 'unreachable';
  }
  res.json({
    status: 'ok',
    ollama: OLLAMA_URL,
    ollamaStatus,
    workspace: __dirname,
    platform: process.platform
  });
});

// List Ollama models
app.get('/api/models', async (req, res) => {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Failed to retrieve models from Ollama' });
    }
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}: ${err.message}`, models: [] });
  }
});

// Workspace info
app.get('/api/filesystem/workspace', (req, res) => {
  res.json({
    cwd: __dirname,
    home: process.env.USERPROFILE || 'C:\\Users\\SBTI Gaming 11',
    allowedRoots: ALLOWED_FS_ROOTS
  });
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
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Specified path is a directory, not a file' });
    }
    const content = await fs.readFile(target, 'utf-8');
    res.json({
      filepath: target,
      name: path.basename(target),
      content,
      size: stat.size,
      mtime: stat.mtime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
        let size = 0;
        let mtime = null;
        try {
          const s = await fs.stat(itemPath);
          size = s.size;
          mtime = s.mtime;
        } catch {}
        return {
          name: e.name,
          path: itemPath,
          isDirectory: e.isDirectory(),
          size,
          mtime,
          extension: path.extname(e.name).toLowerCase()
        };
      })
    );

    // Sort folders first, then alphabetical
    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    res.json({
      dirpath: target,
      parent: path.dirname(target) !== target ? path.dirname(target) : null,
      files
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete memory
app.delete('/api/memory/delete/:key', async (req, res) => {
  try {
    const sanitizedKey = req.params.key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const memoryFile = path.join(MEMORY_DIR, `${sanitizedKey}.json`);
    await fs.remove(memoryFile);
    res.json({ success: true, key: req.params.key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all memories
app.get('/api/memory/list', async (req, res) => {
  try {
    const files = await fs.readdir(MEMORY_DIR);
    const memories = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          const item = await fs.readJson(path.join(MEMORY_DIR, f));
          memories.push(item);
        } catch {}
      }
    }
    memories.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    res.json({ memories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat with Ollama (Supports Streaming, Agent tool-calling, and custom System Prompt)
app.post('/api/chat', async (req, res) => {
  try {
    let { 
      messages, 
      system, 
      model = 'llama3.2:1b', 
      stream = true,
      enableTools = false
    } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const defaultSystem = `You are a helpful, intelligent coding and computer assistant with direct filesystem awareness running locally on Windows.
Current project workspace root directory: ${__dirname}
You have access to inspect and manage files in the workspace.
When answering code or file questions, be accurate, helpful, and concise. Format code blocks with language identifiers.`;

    const effectiveSystem = system ? `${defaultSystem}\n\n${system}` : defaultSystem;

    // Check if client requested tool calling agent mode
    const requestPayload = {
      model,
      messages,
      system: effectiveSystem,
      stream
    };

    if (enableTools && !stream) {
      requestPayload.tools = FS_TOOLS;
    }

    // Call Ollama
    const ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload)
    });

    if (!ollamaResponse.ok) {
      const errText = await ollamaResponse.text();
      return res.status(ollamaResponse.status).json({ error: `Ollama error (${ollamaResponse.status}): ${errText}` });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      for await (const chunk of ollamaResponse.body) {
        res.write(chunk);
      }
      res.end();
    } else {
      const data = await ollamaResponse.json();

      // Check if model returned tool calls in non-streaming mode
      if (data.message && data.message.tool_calls && data.message.tool_calls.length > 0) {
        const toolCalls = data.message.tool_calls;
        const toolResults = [];

        for (const tc of toolCalls) {
          const name = tc.function.name;
          const args = tc.function.arguments || {};
          const result = await executeTool(name, args);
          toolResults.push({
            tool_call_id: tc.id || name,
            role: 'tool',
            content: JSON.stringify(result)
          });
        }

        // Send tool results back to model to get final conversational response
        const followUpMessages = [
          ...messages,
          data.message,
          ...toolResults
        ];

        const followUpResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: followUpMessages,
            system: effectiveSystem,
            stream: false
          })
        });

        if (followUpResponse.ok) {
          const finalData = await followUpResponse.json();
          return res.json({
            ...finalData,
            executedTools: toolCalls.map((tc, idx) => ({
              tool: tc.function.name,
              args: tc.function.arguments,
              result: JSON.parse(toolResults[idx].content)
            }))
          });
        }
      }

      res.json(data);
    }
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Tool execution endpoint for direct frontend tool calls or agent loop
app.post('/api/tools/execute', async (req, res) => {
  try {
    const { name, args } = req.body;
    if (!name) return res.status(400).json({ error: 'tool name required' });
    const result = await executeTool(name, args || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const server = createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web app running on http://localhost:${PORT}`);
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`Workspace root: ${__dirname}`);
});