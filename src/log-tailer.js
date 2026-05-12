/**
 * Log Tailer
 *
 * Watches AEM log files and emits parsed entries via callback.
 * Uses PowerShell on Windows for robust tailing, and custom polling on other platforms.
 */

import fs from 'fs';
import { spawn } from 'child_process';
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
    
    this.child = null;
    this.intervalId = null;
    this.lastSize = 0;
    this.buffer = '';
  }

  start() {
    if (!fs.existsSync(this.filePath)) {
      console.warn(`[tailer] File not found: ${this.filePath}`);
      return false;
    }

    if (process.platform === 'win32') {
      return this.startWindowsTailer();
    } else {
      return this.startPollingTailer();
    }
  }

  /**
   * Windows-specific tailing using PowerShell Get-Content -Wait
   * This is the most reliable way to bypass Java file locks on Windows.
   */
  startWindowsTailer() {
    try {
      console.log(`[tailer] Windows detected. Starting PowerShell tailer for ${this.source}...`);
      
      // PowerShell command: Get-Content -Path '...' -Wait -Tail 0
      // -Wait: keep the file open and wait for new content
      // -Tail 0: don't read existing content
      const psCommand = `Get-Content -Path "${this.filePath}" -Wait -Tail 0 -Encoding UTF8`;
      
      this.child = spawn('powershell.exe', ['-Command', psCommand]);

      this.child.stdout.on('data', (data) => {
        const text = data.toString('utf-8');
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            console.log(`[tailer:${this.source}] New line via PS (${line.length} chars)`);
            this.aggregator.push(line);
          }
        }
      });

      this.child.stderr.on('data', (data) => {
        console.error(`[tailer:${this.source}] PS Error:`, data.toString());
      });

      this.child.on('close', (code) => {
        console.log(`[tailer:${this.source}] PS process exited with code ${code}`);
      });

      console.log(`[tailer] Watching ${this.source} with PowerShell: ${this.filePath}`);
      return true;
    } catch (err) {
      console.error(`[tailer] Failed to start Windows tailer:`, err.message);
      return this.startPollingTailer(); // Fallback
    }
  }

  /**
   * Generic polling tailer (fallback/Unix)
   */
  startPollingTailer() {
    try {
      const stats = fs.statSync(this.filePath);
      this.lastSize = stats.size;
      console.log(`[tailer] Watching ${this.source}: ${this.filePath} (Polling mode, initial size: ${this.lastSize})`);
      this.intervalId = setInterval(() => this.poll(), 500);
      return true;
    } catch (err) {
      console.error(`[tailer] Failed to start polling tailer:`, err.message);
      return false;
    }
  }

  poll() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stats = fs.statSync(this.filePath);
      
      if (stats.size < this.lastSize) {
        this.lastSize = 0;
        this.buffer = '';
      }

      if (stats.size > this.lastSize) {
        const bytesToRead = stats.size - this.lastSize;
        const buffer = Buffer.alloc(bytesToRead);
        const fd = fs.openSync(this.filePath, 'r');
        fs.readSync(fd, buffer, 0, bytesToRead, this.lastSize);
        fs.closeSync(fd);
        this.lastSize = stats.size;
        this.processData(buffer.toString('utf-8'));
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EPERM') {
        console.error(`[tailer:${this.source}] Polling error:`, err.message);
      }
    }
  }

  processData(data) {
    this.buffer += data;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.substring(0, newlineIndex);
      if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
      this.buffer = this.buffer.substring(newlineIndex + 1);
      console.log(`[tailer:${this.source}] New line received (${line.length} chars)`);
      this.aggregator.push(line);
    }
  }

  stop() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.aggregator.flush();
  }
}
