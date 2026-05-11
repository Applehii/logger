/**
 * Metrics
 *
 * Parse request.log for performance metrics.
 * Format:
 *   DD/Mon/YYYY:HH:MM:SS +TZOFF [reqId] -> METHOD /path HTTP/1.1
 *   DD/Mon/YYYY:HH:MM:SS +TZOFF [reqId] <- STATUS content-type DURATIONms
 */

const REQUEST_RE = /^(\S+ \S+|\S+:\d{2}:\d{2}:\d{2} [+-]\d{4}) \[(\d+)\] -> (\w+) (\S+)/;
const RESPONSE_RE = /^(\S+ \S+|\S+:\d{2}:\d{2}:\d{2} [+-]\d{4}) \[(\d+)\] <- (\d+) \S+ (\d+)ms/;

export class MetricsCollector {
  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
    this.requests = new Map(); // reqId → { method, path, startTime }
    this.completed = [];       // completed request/response pairs
  }

  pushLine(line) {
    const reqMatch = line.match(REQUEST_RE);
    if (reqMatch) {
      const [, timestamp, reqId, method, path] = reqMatch;
      this.requests.set(reqId, { timestamp, method, path });
      return;
    }

    const resMatch = line.match(RESPONSE_RE);
    if (resMatch) {
      const [, timestamp, reqId, status, duration] = resMatch;
      const req = this.requests.get(reqId);
      if (req) {
        this.completed.push({
          reqId,
          method: req.method,
          path: req.path,
          status: parseInt(status, 10),
          duration: parseInt(duration, 10),
          timestamp: req.timestamp,
        });
        this.requests.delete(reqId);

        if (this.completed.length > this.maxEntries) {
          this.completed.splice(0, this.completed.length - this.maxEntries);
        }
      }
    }
  }

  getStats() {
    if (this.completed.length === 0) {
      return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, slowRequests: [], statusBreakdown: {}, topPaths: [] };
    }

    const durations = this.completed.map(r => r.duration).sort((a, b) => a - b);
    const count = durations.length;

    const avg = Math.round(durations.reduce((a, b) => a + b, 0) / count);
    const p50 = durations[Math.floor(count * 0.5)];
    const p95 = durations[Math.floor(count * 0.95)];
    const p99 = durations[Math.floor(count * 0.99)];

    // Slow requests (>1s)
    const slowRequests = this.completed
      .filter(r => r.duration > 1000)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 20)
      .map(r => ({
        method: r.method,
        path: r.path,
        status: r.status,
        duration: r.duration,
        timestamp: r.timestamp,
      }));

    // Status breakdown
    const statusBreakdown = {};
    for (const r of this.completed) {
      const group = `${Math.floor(r.status / 100)}xx`;
      statusBreakdown[group] = (statusBreakdown[group] || 0) + 1;
    }

    // Top paths by avg duration
    const pathStats = {};
    for (const r of this.completed) {
      // Normalize paths: remove JCR content paths specifics
      const normalized = r.path.replace(/\/[a-f0-9-]{36}/g, '/{id}').replace(/\.\d+\./, '.*.');
      if (!pathStats[normalized]) pathStats[normalized] = { total: 0, count: 0 };
      pathStats[normalized].total += r.duration;
      pathStats[normalized].count++;
    }

    const topPaths = Object.entries(pathStats)
      .map(([path, s]) => ({ path, avg: Math.round(s.total / s.count), count: s.count }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 15);

    return { count, avg, p50, p95, p99, slowRequests, statusBreakdown, topPaths };
  }
}
