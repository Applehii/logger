import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createReadStream } from 'fs';

import config from './src/config.js';
import { LogTailer } from './src/log-tailer.js';
import { isNoise } from './src/log-parser.js';
import { fetchCatchup } from './src/sling-client.js';
import { MetricsCollector } from './src/metrics.js';
import db from './src/db.js';
import apiRoutes from './src/routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// API routes
app.use('/api', apiRoutes);

// Config endpoints
app.get('/api/config', (req, res) => {
  res.json(config.raw);
});

app.post('/api/config', async (req, res) => {
  try {
    config.updateConfig(req.body);
    await restartTailers();
    res.json({ success: true, message: 'Configuration updated and tailers restarted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', aemLogDir: config.aem.logDir });
});

// ── Metrics collector ─────────────────────────────────────────
const metrics = new MetricsCollector();

app.get('/api/metrics', (req, res) => {
  res.json(metrics.getStats());
});

// ── Bookmarks API ─────────────────────────────────────────────
app.get('/api/bookmarks', (req, res) => {
  res.json(db.bookmarks.getAll());
});

app.post('/api/bookmarks', (req, res) => {
  const { entry, note } = req.body;
  if (!entry) return res.status(400).json({ error: 'entry is required' });
  const id = db.bookmarks.add(entry, note || '');
  res.json({ id, success: true });
});

app.delete('/api/bookmarks/:id', (req, res) => {
  const ok = db.bookmarks.delete(parseInt(req.params.id, 10));
  res.json({ success: ok });
});

app.patch('/api/bookmarks/:id', (req, res) => {
  const { note } = req.body;
  const ok = db.bookmarks.updateNote(parseInt(req.params.id, 10), note || '');
  res.json({ success: ok });
});

// ── WebSocket clients ─────────────────────────────────────────
const clients = new Set();

// ── Log buffer (ring buffer for new clients) ──────────────────
const logBuffer = [];
const MAX_BUFFER = config.maxLogBuffer;

function bufferEntry(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) {
    logBuffer.splice(0, logBuffer.length - MAX_BUFFER);
  }
}

// ── Client filter state ───────────────────────────────────────
const clientFilters = new Map();

function matchesFilter(entry, filter) {
  if (!filter) return true;
  if (filter.levels?.length > 0 && !filter.levels.includes(entry.level)) return false;
  if (filter.modules?.length > 0 && !filter.modules.includes(entry.module)) return false;
  if (filter.keyword) {
    const kw = filter.keyword.toLowerCase();
    const text = (entry.message + ' ' + entry.className + ' ' + (entry.stackTrace || []).join(' ')).toLowerCase();
    if (!text.includes(kw)) return false;
  }
  if (filter.noiseFilter && isNoise(entry)) return false;
  return true;
}

// ── WebSocket handling ────────────────────────────────────────
wss.on('connection', async (ws) => {
  clients.add(ws);
  clientFilters.set(ws, { noiseFilter: config.noiseFilter });
  console.log(`[ws] Client connected (${clients.size} total)`);

  ws.send(JSON.stringify({
    type: 'status',
    connected: true,
    sources: Object.keys(config.logFiles),
    aemHost: config.aem.host,
  }));

  const filter = clientFilters.get(ws);
  for (const entry of logBuffer) {
    if (matchesFilter(entry, filter)) {
      ws.send(JSON.stringify({ type: 'log', entry }));
    }
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'filter') {
        clientFilters.set(ws, { ...clientFilters.get(ws), ...msg });
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => {
    clients.delete(ws);
    clientFilters.delete(ws);
    console.log(`[ws] Client disconnected (${clients.size} total)`);
  });
});

// ── Log entry handler ─────────────────────────────────────────
let entryId = 0;
function onLogEntry(entry) {
  entry.id = ++entryId;
  
  // Chỉ đưa vào bộ đệm UI nếu không phải là log ẩn
  if (!entry.hidden) {
    bufferEntry(entry);
  }

  // Luôn đẩy vào metrics nếu là từ nguồn request.log
  if (entry.source === 'request') {
    metrics.pushLine(entry.raw || '');
  }

  // Chỉ gửi qua WebSocket cho UI nếu không phải là log ẩn
  if (!entry.hidden) {
    for (const ws of clients) {
      if (ws.readyState !== 1) continue;
      const filter = clientFilters.get(ws);
      if (matchesFilter(entry, filter)) {
        ws.send(JSON.stringify({ type: 'log', entry }));
      }
    }
  }
}

// ── Start tailers ─────────────────────────────────────────────
let tailers = [];

export function stopTailers() {
  console.log(`[tailers] Stopping ${tailers.length} tailers...`);
  for (const t of tailers) t.stop();
  tailers = [];
}

export function startTailers() {
  const files = config.logFiles;
  console.log(`[tailers] Starting ${Object.keys(files).length} tailers...`);
  for (const [source, filePath] of Object.entries(files)) {
    const tailer = new LogTailer(filePath, source, onLogEntry);
    if (tailer.start()) tailers.push(tailer);
  }
}

export async function restartTailers() {
  stopTailers();
  // Clear buffer if path changed? Maybe not, keep history but start fresh
  startTailers();
}

// ── Initial catchup ───────────────────────────────────────────
async function loadCatchup() {
  try {
    const errorLogPath = config.logFiles.error;
    if (!errorLogPath || !existsSync(errorLogPath)) return;
    
    // We need to pass the path relative to AEM root or absolute
    // fetchCatchup uses AEM API usually, but here it seems to use local?
    // Let's assume fetchCatchup is okay for now or just skip if path is complex
    const entries = await fetchCatchup('/logs/error.log', 200);
    for (const entry of entries) {
      entry.id = ++entryId;
      bufferEntry(entry);
    }
    console.log(`[startup] Loaded ${entries.length} catchup entries`);
  } catch (err) {
    console.warn(`[startup] Catchup failed: ${err.message}`);
  }
}

// ── Stats endpoint ────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const stats = {
    totalEntries: logBuffer.length,
    errors: logBuffer.filter(e => e.level === 'ERROR').length,
    warnings: logBuffer.filter(e => e.level === 'WARN').length,
    clients: clients.size,
    modules: {},
    tailers: tailers.length,
  };
  for (const entry of logBuffer) {
    stats.modules[entry.module] = (stats.modules[entry.module] || 0) + 1;
  }
  res.json(stats);
});

// ── Startup ───────────────────────────────────────────────────
await loadCatchup();
startTailers();

server.listen(config.server.port, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         AEM Log Monitor v1.0.0               ║
║──────────────────────────────────────────────║
║  UI:       http://localhost:${config.server.port}              ║
║  AEM:      ${config.aem.host.padEnd(33)}║
║  Tailers:  ${tailers.length} active                          ║
║  DB:       data/aem-log-monitor.db           ║
╚══════════════════════════════════════════════╝
`);
});

process.on('SIGINT', () => {
  console.log('\n[shutdown] Stopping...');
  for (const t of tailers) t.stop();
  db.close();
  server.close();
  process.exit(0);
});
