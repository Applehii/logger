/**
 * SQLite Database
 *
 * Stores bookmarks and cached AI analyses.
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../data/aem-log-monitor.db');

// Ensure data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT,
    timestamp TEXT,
    level TEXT,
    module TEXT,
    className TEXT,
    message TEXT,
    stackTrace TEXT,
    raw TEXT,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    error_hash TEXT UNIQUE,
    analysis TEXT,
    source_context TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Bookmarks
const insertBookmark = db.prepare(`
  INSERT INTO bookmarks (entry_id, timestamp, level, module, className, message, stackTrace, raw, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getAllBookmarks = db.prepare(`SELECT * FROM bookmarks ORDER BY created_at DESC`);
const getBookmark = db.prepare(`SELECT * FROM bookmarks WHERE id = ?`);
const deleteBookmark = db.prepare(`DELETE FROM bookmarks WHERE id = ?`);
const updateBookmarkNote = db.prepare(`UPDATE bookmarks SET note = ? WHERE id = ?`);

// AI Cache
const getAiCache = db.prepare(`SELECT * FROM ai_cache WHERE error_hash = ?`);
const insertAiCache = db.prepare(`
  INSERT OR REPLACE INTO ai_cache (error_hash, analysis, source_context, tokens_in, tokens_out)
  VALUES (?, ?, ?, ?, ?)
`);

export default {
  bookmarks: {
    add(entry, note = '') {
      const result = insertBookmark.run(
        String(entry.id || ''),
        entry.timestamp || '',
        entry.level || '',
        entry.module || '',
        entry.className || '',
        entry.message || '',
        JSON.stringify(entry.stackTrace || []),
        entry.raw || '',
        note
      );
      return result.lastInsertRowid;
    },
    getAll() {
      return getAllBookmarks.all().map(row => ({
        ...row,
        stackTrace: JSON.parse(row.stackTrace || '[]'),
      }));
    },
    get(id) {
      const row = getBookmark.get(id);
      if (!row) return null;
      return { ...row, stackTrace: JSON.parse(row.stackTrace || '[]') };
    },
    delete(id) {
      return deleteBookmark.run(id).changes > 0;
    },
    updateNote(id, note) {
      return updateBookmarkNote.run(note, id).changes > 0;
    },
  },
  aiCache: {
    get(hash) {
      const row = getAiCache.get(hash);
      if (!row) return null;
      return {
        ...row,
        sourceContext: row.source_context ? JSON.parse(row.source_context) : null,
      };
    },
    set(hash, analysis, sourceContext, tokensIn, tokensOut) {
      insertAiCache.run(
        hash,
        analysis,
        sourceContext ? JSON.stringify(sourceContext) : null,
        tokensIn || 0,
        tokensOut || 0
      );
    },
  },
  close() { db.close(); },
};
