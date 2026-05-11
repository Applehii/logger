/**
 * Sling Log Client
 *
 * Fetches log lines from AEM's Sling tailer endpoint for initial catchup.
 * GET /system/console/slinglog/tailer.txt?name=/logs/error.log&tail=200
 */

import config from './config.js';
import { LogAggregator } from './log-parser.js';

export async function fetchCatchup(logName = '/logs/error.log', lines = 200) {
  const url = `${config.aem.host}/system/console/slinglog/tailer.txt?name=${encodeURIComponent(logName)}&tail=${lines}`;
  const auth = Buffer.from(`${config.aem.user}:${config.aem.pass}`).toString('base64');

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[sling-client] HTTP ${res.status} from ${url}`);
      return [];
    }

    const text = await res.text();
    const rawLines = text.split('\n').filter(l => l.trim());

    // Parse through aggregator
    const entries = [];
    const agg = new LogAggregator((entry) => {
      entry.source = 'error';
      entries.push(entry);
    });

    for (const line of rawLines) {
      agg.push(line);
    }
    agg.flush();

    console.log(`[sling-client] Fetched ${entries.length} entries for catchup`);
    return entries;
  } catch (err) {
    console.warn(`[sling-client] Catchup failed: ${err.message}`);
    return [];
  }
}
