/**
 * Log Tailer
 *
 * Watches AEM log files and emits parsed entries via callback.
 * Uses a custom polling mechanism for robust Windows support.
 */

import fs from 'fs';
import { LogAggregator } from './log-parser.js';

export class LogTailer {
  constructor(filePath, source, onEntry) {
    this.filePath = filePath;
    this.source = source;
    this.onEntry = onEntry;
    this.aggregator = new LogAggregator((entry) => {
      entry.source = this.source;
      this.onEntry(entry);
    }, source);
    
    this.intervalId = null;
    this.lastSize = 0;
    this.buffer = '';
  }

  start() {
    if (!fs.existsSync(this.filePath)) {
      console.warn(`[tailer] File not found: ${this.filePath}`);
      return false;
    }

    try {
      // Get initial file size so we only read new lines
      const stats = fs.statSync(this.filePath);
      this.lastSize = stats.size;
      
      console.log(`[tailer] Watching ${this.source}: ${this.filePath} (Initial size: ${this.lastSize})`);

      // Poll every 500ms
      this.intervalId = setInterval(() => this.poll(), 500);
      return true;
    } catch (err) {
      console.error(`[tailer] Failed to start ${this.source}:`, err.message);
      return false;
    }
  }

  poll() {
    try {
      // Check if file still exists
      if (!fs.existsSync(this.filePath)) return;

      const stats = fs.statSync(this.filePath);
      
      if (stats.size < this.lastSize) {
        // File was likely rotated/truncated
        console.log(`[tailer:${this.source}] File truncated, resetting...`);
        this.lastSize = 0;
        this.buffer = '';
      }

      if (stats.size > this.lastSize) {
        const bytesToRead = stats.size - this.lastSize;
        const buffer = Buffer.alloc(bytesToRead);
        
        // Open file, read the new chunk, close it immediately
        // 'r' mode is safe on Windows even when others are writing
        const fd = fs.openSync(this.filePath, 'r');
        fs.readSync(fd, buffer, 0, bytesToRead, this.lastSize);
        fs.closeSync(fd);

        this.lastSize = stats.size;
        
        // Process the new data
        this.processData(buffer.toString('utf-8'));
      }
    } catch (err) {
      // Ignore common rotation errors
      if (err.code !== 'ENOENT' && err.code !== 'EPERM') {
        console.error(`[tailer:${this.source}] Polling error:`, err.message);
      }
    }
  }

  processData(data) {
    this.buffer += data;
    let newlineIndex;
    
    // Extract complete lines
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      // Handle both \n and \r\n
      let line = this.buffer.substring(0, newlineIndex);
      if (line.endsWith('\r')) {
        line = line.substring(0, line.length - 1);
      }
      
      this.buffer = this.buffer.substring(newlineIndex + 1);
      
      // Log debug ra terminal để biết là có nhận được data hay không
      console.log(`[tailer:${this.source}] New line received (${line.length} chars)`);
      this.aggregator.push(line);
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.aggregator.flush();
    }
  }
}
