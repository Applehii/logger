/**
 * Browser Debug Agent
 *
 * Uses Steel Browser (Docker) + Puppeteer for page debugging.
 * Falls back to local Puppeteer if Steel is unavailable.
 *
 * Captures: console logs, JS errors, network requests, screenshots, DOM.
 */

import puppeteer from 'puppeteer';
import config from './config.js';
import { planBrowserActions } from './ai-analyzer.js';

const STEEL_URL = process.env.STEEL_URL || 'http://localhost:3000';

/**
 * Check if Steel Browser is running.
 */
export async function isSteelAvailable() {
  try {
    const res = await fetch(`${STEEL_URL}/v1/sessions`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Create a Steel session (with fingerprint skip for Mac ARM).
 */
async function createSteelSession() {
  const res = await fetch(`${STEEL_URL}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipFingerprintInjection: true }),
  });
  if (!res.ok) throw new Error(`Steel session failed: HTTP ${res.status}`);
  return await res.json();
}

async function releaseSteelSession(sessionId) {
  try {
    await fetch(`${STEEL_URL}/v1/sessions/${sessionId}`, { method: 'DELETE' });
  } catch { /* ignore */ }
}

/**
 * Connect browser — Steel if available, otherwise local Puppeteer.
 */
async function connectBrowser() {
  const steelAvailable = await isSteelAvailable();

  if (steelAvailable) {
    const session = await createSteelSession();
    const wsUrl = `ws://localhost:3000?sessionId=${session.id}`;
    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
    return { browser, sessionId: session.id, engine: 'Steel Browser' };
  }

  // Fallback to local Puppeteer
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  return { browser, sessionId: null, engine: 'Puppeteer (local)' };
}

/**
 * Debug an AEM page.
 */
export async function debugPage(url, options = {}) {
  const {
    waitMs = 3000,
    fullPage = true,
    auth = { user: config.aem.user, pass: config.aem.pass },
    instruction = null,
  } = options;

  let browser, sessionId, engine;
  try {
    ({ browser, sessionId, engine } = await connectBrowser());

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Basic auth for AEM
    if (auth.user && auth.pass) {
      await page.setExtraHTTPHeaders({
        Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'),
      });
    }

    // Capture console logs
    const consoleLogs = [];
    page.on('console', msg => {
      consoleLogs.push({ type: msg.type(), text: msg.text(), timestamp: Date.now() });
    });

    // Capture JS errors
    const jsErrors = [];
    page.on('pageerror', err => {
      jsErrors.push({ message: err.message, stack: err.stack, timestamp: Date.now() });
    });

    // Capture network requests
    const networkRequests = [];
    const failedRequests = [];

    page.on('response', res => {
      const entry = {
        url: res.url(),
        status: res.status(),
        method: res.request().method(),
        resourceType: res.request().resourceType(),
        timestamp: Date.now(),
      };
      networkRequests.push(entry);
      if (res.status() >= 400) failedRequests.push(entry);
    });

    page.on('requestfailed', req => {
      failedRequests.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        error: req.failure()?.errorText || 'unknown',
        timestamp: Date.now(),
      });
    });

    // If using Steel, rewrite localhost → host.docker.internal
    const navUrl = sessionId ? url.replace('localhost:', 'host.docker.internal:') : url;

    await page.goto(navUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    // --- AI Agent Loop ---
    if (instruction) {
      console.log(`[agent] Instruction received: "${instruction}"`);
      
      // Wait for at least one input to be visible (AEM/Vue might be slow)
      try {
        await page.waitForSelector('input', { timeout: 10000 });
      } catch (e) {
        console.warn('[agent] No input fields appeared within 10s');
      }

      // Extract interactive elements with more context
      const elements = await page.evaluate(() => {
        const interactive = [];
        const selectors = 'input, button, a, select, textarea';
        document.querySelectorAll(selectors).forEach(el => {
          // Check visibility
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || el.offsetWidth === 0) return;

          // Find associated label text
          let labelText = '';
          if (el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label) labelText = label.innerText;
          }
          if (!labelText && el.closest('label')) {
            labelText = el.closest('label').innerText;
          }

          interactive.push({
            tag: el.tagName.toLowerCase(),
            id: el.id,
            name: el.name,
            placeholder: el.placeholder,
            label: labelText.trim(),
            text: el.innerText?.substring(0, 50).trim(),
            type: el.type,
            role: el.getAttribute('role')
          });
        });
        return interactive;
      });

      console.log(`[agent] Extracted ${elements.length} interactive elements. Planning...`);
      // Log elements for debugging
      if (elements.length > 0) console.log(`[agent] Elements found: ${elements.map(e => e.tag + (e.id ? '#'+e.id : '') + (e.label ? '('+e.label+')' : '')).join(', ')}`);
      
      const actionsPlan = await planBrowserActions(elements, instruction);
      console.log(`[agent] Plan generated with ${actionsPlan.length} actions.`);

      for (const action of actionsPlan) {
        try {
          if (action.action === 'type' && action.selector) {
            console.log(`[agent] Typing "${action.value}" into ${action.selector}`);
            await page.waitForSelector(action.selector, { timeout: 5000 });
            await page.focus(action.selector);
            await page.type(action.selector, action.value, { delay: 50 });
          } else if (action.action === 'click' && action.selector) {
            console.log(`[agent] Clicking ${action.selector}`);
            await page.waitForSelector(action.selector, { timeout: 5000 });
            await page.click(action.selector);
          } else if (action.action === 'wait') {
            await new Promise(r => setTimeout(r, action.ms || 2000));
          }
        } catch (err) {
          console.warn(`[agent] Action failed: ${action.action} on ${action.selector} - ${err.message}`);
          consoleLogs.push({ type: 'warning', text: `AI Agent action failed: ${err.message}`, timestamp: Date.now() });
        }
      }
      
      // Final wait for state update
      await new Promise(r => setTimeout(r, 2000));
    } else {
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Screenshot
    const screenshotBuffer = await page.screenshot({ fullPage, type: 'png' });
    const screenshot = screenshotBuffer.toString('base64');

    // Page info
    const pageTitle = await page.title();
    const pageContent = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '');

    // DOM summary
    const domSummary = await page.evaluate(() => {
      const counts = {};
      document.querySelectorAll('*').forEach(el => {
        counts[el.tagName] = (counts[el.tagName] || 0) + 1;
      });
      return {
        totalElements: Object.values(counts).reduce((a, b) => a + b, 0),
        tagCounts: Object.fromEntries(
          Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15)
        ),
      };
    });

    // Cleanup
    if (sessionId) {
      await browser.disconnect();
      await releaseSteelSession(sessionId);
    } else {
      await browser.close();
    }
    browser = null;

    return {
      url,
      engine,
      screenshot,
      pageTitle,
      pageContent,
      consoleLogs,
      jsErrors,
      networkRequests: networkRequests.slice(-50),
      failedRequests,
      domSummary,
      stats: {
        totalRequests: networkRequests.length,
        failedCount: failedRequests.length,
        consoleErrors: consoleLogs.filter(l => l.type === 'error').length,
        jsErrorCount: jsErrors.length,
      },
      capturedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { error: `Browser debug failed: ${err.message}` };
  } finally {
    if (browser) {
      if (sessionId) {
        await browser.disconnect().catch(() => {});
        await releaseSteelSession(sessionId);
      } else {
        await browser.close().catch(() => {});
      }
    }
  }
}
