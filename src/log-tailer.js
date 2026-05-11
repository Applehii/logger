/**
 * Log Tailer
 *
 * Watches AEM log files and emits parsed entries via callback.
 * Uses the 'tail' npm package (fs.watch-based, event-driven).
 */

import { Tail } from 'tail';
import { existsSync } from 'fs';
import { LogAggregator } from './log-parser.js';

export class LogTailer {
  constructor(filePath, source, onEntry) {
    this.filePath = filePath;
    this.source = source;
    this.onEntry = onEntry;
    this.tail = null;
    this.aggregator = new LogAggregator((entry) => {
      entry.source = this.source;
      this.onEntry(entry);
    }, source);
  }

  start() {
    if (!existsSync(this.filePath)) {
      console.warn(`[tailer] File not found: ${this.filePath}`);
      return false;
    }

    try {
      this.tail = new Tail(this.filePath, {
        follow: true,
        fromBeginning: false,
        flushAtEOF: true,
        useWatchFile: true,  // More reliable on macOS
        fsWatchOptions: { interval: 500 },
      });

      this.tail.on('line', (line) => {
        this.aggregator.push(line);
      });

      this.tail.on('error', (err) => {
        console.error(`[tailer:${this.source}] Error:`, err.message);
      });

      console.log(`[tailer] Watching ${this.source}: ${this.filePath}`);
      return true;
    } catch (err) {
      console.error(`[tailer] Failed to start ${this.source}:`, err.message);
      return false;
    }
  }

  stop() {
    if (this.tail) {
      this.tail.unwatch();
      this.aggregator.flush();
      this.tail = null;
    }
  }
}
