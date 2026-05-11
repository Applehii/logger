/**
 * AEM Log Parser
 *
 * Parses AEM error.log format:
 *   DD.MM.YYYY HH:MM:SS.mmm *LEVEL* [Thread] Package.Class Message
 *
 * Handles multi-line entries (stack traces).
 */

// Timestamp pattern that starts a new log entry
const ENTRY_RE = /^(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}\.\d{3}) \*(\w+)\* \[([^\]]+)\] (.+)/;

// Module detection from class/package name
const MODULE_RULES = [
  { pattern: /^com\.aem\.vue\.core\./, module: 'core' },
  { pattern: /sightly|htl|scripting\.java/, module: 'ui.apps' },
  { pattern: /granite\.ui|dialog|coral|foundation/, module: 'ui.apps' },
  { pattern: /installer\.factory|configadmin|osgi\.cm/, module: 'ui.config' },
  { pattern: /dispatcher|rewriter|mapping/, module: 'dispatcher' },
  { pattern: /distribution|replication/, module: 'replication' },
  { pattern: /jackrabbit|oak\.jcr|oak\.query/, module: 'repository' },
  { pattern: /webpack|node|npm|frontend/, module: 'ui.frontend' },
];

export function detectModule(text) {
  for (const rule of MODULE_RULES) {
    if (rule.pattern.test(text)) return rule.module;
  }
  return 'aem-internal';
}

export function parseLogLine(line) {
  const match = line.match(ENTRY_RE);
  if (!match) return null;

  const [, timestamp, level, thread, rest] = match;

  // Cải tiến: Tìm kiếm package name com.aem.vue.core trong toàn bộ chuỗi rest
  // Nếu thấy thì ưu tiên lấy nó làm className để detect module chính xác
  const aemVueMatch = rest.match(/(com\.aem\.vue\.core\.\S+)/);
  
  let className, message;
  if (aemVueMatch) {
    className = aemVueMatch[1];
    message = rest;
  } else {
    // Logic cũ: split ở dấu cách đầu tiên
    const classMatch = rest.match(/^(\S+)\s+(.*)/s);
    className = classMatch ? classMatch[1] : rest;
    message = classMatch ? classMatch[2] : '';
  }

  return {
    timestamp,
    level,
    thread,
    className,
    message,
    module: detectModule(className),
    stackTrace: null,
    raw: line,
  };
}

export function isStackTraceLine(line) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('at ') ||
    trimmed.startsWith('Caused by:') ||
    trimmed.startsWith('... ') ||
    /^\w+[\w.]*Exception/.test(trimmed) ||
    /^\w+[\w.]*Error/.test(trimmed)
  );
}

// Request log pattern: 11/May/2026:09:00:30 +0700 [123] <- 403 text/plain 8ms
const REQUEST_OUT_RE = /^(\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}) \[(\d+)\] <- (\d{3}) (\S+) (\d+)ms/;
// Request in pattern: 11/May/2026:09:00:30 +0700 [123] -> POST /path HTTP/1.1
const REQUEST_IN_RE = /^(\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}) \[(\d+)\] -> (\w+) (\S+) (\S+)/;

export function parseRequestLine(line) {
  const outMatch = line.match(REQUEST_OUT_RE);
  if (outMatch) {
    const [, timestamp, id, status, type, duration] = outMatch;
    const statusCode = parseInt(status, 10);
    
    // Chỉ quan tâm đến các lỗi HTTP >= 400
    if (statusCode >= 400) {
      return {
        timestamp,
        level: statusCode >= 500 ? 'ERROR' : 'WARN',
        thread: `request-${id}`,
        className: 'http-status',
        message: `HTTP ${statusCode} Response (${duration}ms) - Type: ${type}`,
        module: 'aem-internal',
        stackTrace: null,
        raw: line,
      };
    }
  }

  const inMatch = line.match(REQUEST_IN_RE);
  if (inMatch) {
    const [, timestamp, id, method, path] = inMatch;
    // Lưu lại thông tin request để có thể map với response sau này nếu cần
    // Hiện tại chỉ trả về null để không làm loãng log INFO
  }

  return null;
}

/**
 * Multi-line log aggregator.
 * Buffers lines and emits complete entries (with stack traces grouped).
 */
export class LogAggregator {
  constructor(onEntry, source = 'error') {
    this.onEntry = onEntry;
    this.source = source;
    this.current = null;
    this.flushTimer = null;
  }

  push(line) {
    // Clear existing timer
    if (this.flushTimer) clearTimeout(this.flushTimer);

    if (this.source === 'request') {
      const parsed = parseRequestLine(line);
      if (parsed) {
        this.onEntry(parsed);
      } else {
        this.onEntry({ raw: line, hidden: true });
      }
      return;
    }

    const parsed = parseLogLine(line);
    if (parsed) {
      this.flush();
      this.current = parsed;
    } else if (this.current && isStackTraceLine(line)) {
      if (!this.current.stackTrace) this.current.stackTrace = [];
      this.current.stackTrace.push(line);
    } else if (this.current) {
      this.current.message += '\n' + line;
    }

    // Set a timer to flush if no more lines come in (e.g. end of a multi-line log)
    this.flushTimer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    if (this.current) {
      this.onEntry(this.current);
      this.current = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// Default noise patterns for AEM
export const DEFAULT_NOISE_PATTERNS = [
  /SynchronizedClocksHealthCheck/,
  /ServiceEvent (UN)?REGISTERING/,
  /livefyre/i,
  /PeriodicAutoTaggingJob.*Ignoring/,
  /BackupCleaner.*successfully removed/,
  /AccessTokenCleanupTask.*Removed 0 token/,
  /ScheduleRepeatTranslationProject/,
  /SegmentNotFoundExceptionListener/,
  /LoginAdminWhitelist.*deprecated/,
  /ScheduledReporter/,
  /Exception was suppressed/,
  /MDA\w*ReporterReport/,
  /metrics.*RRD4J/i,
  /com\.codahale\.metrics/,
];

export function isNoise(entry, patterns = DEFAULT_NOISE_PATTERNS) {
  const text = entry.raw || entry.message || '';
  return patterns.some(p => p.test(text));
}
