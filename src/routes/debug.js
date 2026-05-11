import { Router } from 'express';
import { debugPage, isSteelAvailable } from '../browser-agent.js';

const router = Router();

router.get('/status', async (req, res) => {
  const steel = await isSteelAvailable();
  res.json({
    available: true,
    engine: steel ? 'Steel Browser (Docker)' : 'Puppeteer (local Chromium)',
    steelConnected: steel,
  });
});

router.post('/page', async (req, res) => {
  const { url, waitMs, fullPage, instruction } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const result = await debugPage(url, { waitMs, fullPage, instruction });
  res.json(result);
});

export default router;
